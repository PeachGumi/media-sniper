/* Offscreen document: the only context that has URL.createObjectURL — and,
 * since v0.7, the ffmpeg engine (libav.js, the same approach VDH uses).
 *
 * Why ffmpeg here: VDH's "it just works" comes from embedding an ffmpeg WASM
 * build and feeding it the browser session through a jsfetch protocol. That
 * gives native handling of everything a hand-rolled combiner misses:
 *   - AES-128 encrypted HLS (keys fetched through the same session)
 *   - fMP4 (EXT-X-MAP), BYTERANGE segments
 *   - TS -> MP4 remux (output is a real .mp4, not a .ts blob)
 *   - DASH (mpd) downloads
 *   - live recording (fragmented MP4 stays valid when interrupted)
 *
 * Bytes NEVER cross chrome.runtime.sendMessage (on Brave 151 an ArrayBuffer
 * sent through extension messaging arrives as a plain {} — the old
 * "[object Object]" empty-file bug). Only URLs, headers and counters move.
 */
'use strict';

import LibAVFactory from './libav/libav-6.5.7.1-h264-aac-mp3.wasm.mjs';

// ---------------------------------------------------------------------------
// Hooks libav's jsfetch protocol expects (VDH installs the same set in its
// download worker via nr()). jsfetch calls FetchWithRetry for every request —
// that is our injection point for captured Authorization/Referer headers.
// ---------------------------------------------------------------------------
let activeHeaders = {}; // {name: value} for the currently running ffmpeg job
const nativeFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
let activeFetchContext = null;
// Network activity of the running job. ffmpeg's jsfetch protocol routes every
// segment request through FetchWithRetry, so these counters tell the popup
// that a job is fetching even while it has not written output yet.
const fetchStats = { count: 0, bytes: 0 };
// A live recording that stops on its own with less than this is a failed
// conversion, not a recording the user chose to end.
const MIN_RECORDING_BYTES = 64 * 1024;
// Set while a job is being stopped: jsfetch requests stop retrying and every
// open response is cancelled (see interruptFfmpeg).
let fetchAborted = false;

function resetFetchStats() {
  fetchStats.count = 0;
  fetchStats.bytes = 0;
  fetchAborted = false;
}

function sendOffscreenProgress(state) {
  try {
    chrome.runtime.sendMessage({
      type: 'ms-offscreen-progress',
      jobId: state.jobId,
      seconds: state.seconds || 0,
      bytes: state.bytes || 0,
      fetches: state.fetches || 0,
      fetchedBytes: state.fetchedBytes || 0,
    });
  } catch (e) { /* service worker asleep: progress is cosmetic */ }
}

function requestOrigin(input) {
  try {
    const raw = typeof input === 'string' ? input : (input && input.url);
    const u = new URL(String(raw || ''));
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.origin : null;
  } catch (e) { return null; }
}

function headerEntries(headers) {
  if (!headers) return [];
  if (Array.isArray(headers)) return headers.map(function (h) { return [String(h.name || ''), String(h.value || '')]; });
  if (typeof Headers !== 'undefined' && headers instanceof Headers) return Array.from(headers.entries());
  return Object.keys(headers).map(function (name) { return [name, String(headers[name])]; });
}

function isSensitiveReplayHeader(name) {
  const lower = String(name || '').toLowerCase();
  return lower === 'referer' || lower === 'origin';
}

function contextHeaderEntries(headers, url, context) {
  const targetOrigin = requestOrigin(url);
  const allowedResource = !!targetOrigin && context.resourceOrigins.has(targetOrigin);
  const crossOrigin = !targetOrigin || targetOrigin !== context.headerOrigin;
  const out = [];
  for (const [name, value] of headerEntries(headers)) {
    const lower = String(name).toLowerCase();
    if (context.headerNames.has(lower) && (!allowedResource || (crossOrigin && isSensitiveReplayHeader(lower)))) continue;
    out.push([name, value]);
  }
  return out;
}

function contextHeadersFor(url, context) {
  if (!context) return [];
  return contextHeaderEntries(context.headers, url, context);
}

function installFetchContext(msg) {
  const roots = [msg && msg.url, msg && msg.audioUrl];
  const origins = Array.isArray(msg && msg.allowedOrigins) ? msg.allowedOrigins.slice() : [];
  const resourceOrigins = new Set();
  roots.concat(origins).forEach(function (value) {
    const origin = requestOrigin(value);
    if (origin) resourceOrigins.add(origin);
  });
  const headerOrigin = requestOrigin(msg && msg.headerOrigin) || requestOrigin(msg && msg.url) || requestOrigin(msg && msg.audioUrl);
  const headerNames = new Set(headerEntries(msg && msg.headers).map(function (entry) { return entry[0].toLowerCase(); }));
  return {
    headers: msg && msg.headers || {},
    headerNames: headerNames,
    headerOrigin: headerOrigin,
    resourceOrigins: resourceOrigins,
  };
}

if (nativeFetch) {
  globalThis.fetch = function (input, init) {
    // A stopped job must not keep reading. The bundled libav build's jsfetch
    // protocol calls this global fetch directly (it does not route through
    // FetchWithRetry), so refusing here is what makes ffmpeg's next read fail
    // and lets the interrupted recording finish promptly. The refusal is bound
    // to the stopped job: once it ends (current = null in the job's finally),
    // later jobs fetch normally again.
    if (current && current.abortRequested) {
      const stopped = new Error('media job stopped');
      stopped.name = 'AbortError';
      return Promise.reject(stopped);
    }
    const context = activeFetchContext;
    if (!context) return nativeFetch(input, init);
    const options = Object.assign({}, init || {});
    const entries = [];
    if (input && input.headers) entries.push.apply(entries, headerEntries(input.headers));
    if (options.headers) entries.push.apply(entries, headerEntries(options.headers));
    const extra = contextHeadersFor(input, context);
    const merged = {};
    for (const [name, value] of entries.concat(extra)) merged[name] = value;
    const filtered = contextHeaderEntries(merged, input, context);
    const headers = {};
    for (const [name, value] of filtered) headers[name] = value;
    options.headers = headers;
    if (!options.credentials) options.credentials = 'include';
    return nativeFetch(input, options);
  };
}

function combinedAbortSignal(first, second) {
  if (!second) return { signal: first, cleanup: function () {} };
  const ctrl = new AbortController();
  const abort = function () { if (!ctrl.signal.aborted) ctrl.abort(); };
  if (first && first.aborted) abort();
  if (second.aborted) abort();
  if (first && !first.aborted) first.addEventListener('abort', abort);
  if (!second.aborted) second.addEventListener('abort', abort);
  return {
    signal: ctrl.signal,
    cleanup: function () {
      if (first) first.removeEventListener('abort', abort);
      second.removeEventListener('abort', abort);
    },
  };
}

globalThis.FindPngSliceIndex = function (d) {
  // some CDNs prepend junk PNG bytes; VDH skips them (their mt() function)
  const head = [137, 80, 78, 71, 13, 10, 26, 10];
  const tail = [73, 69, 78, 68, 174, 66, 96, 130];
  for (let a = 0; a < head.length; a++) { if (d[a] !== head[a]) return -1; }
  for (let a = 0; a < d.length - tail.length; a++) {
    let ok = true;
    for (let b = 0; b < tail.length; b++) { if (d[a + b] !== tail[b]) { ok = false; break; } }
    if (ok) return a + tail.length;
  }
  return -1;
};

globalThis.DoAbortableSleep = function (ms, signal) {
  let timer;
  return new Promise(function (resolve) {
    function onAbort() { clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve({ aborted: true, timeout_id: timer }); }
    if (signal.aborted) { resolve({ aborted: true }); return; }
    signal.addEventListener('abort', onAbort);
    timer = setTimeout(function () { signal.removeEventListener('abort', onAbort); resolve({ timed_out: true, timeout_id: timer }); }, ms);
  });
};

globalThis.FetchWithRetry = async function (url, headers, attempts, fetchTimeout, retryDelay, bypassCache, signal) {
  // A stopped job must not keep fetching: without this the retry loop would
  // reopen the very requests the interrupt just cancelled.
  if (fetchAborted) return { aborted: true };
  const merged = {};
  for (const k of Object.keys(activeHeaders || {})) merged[k] = activeHeaders[k];
  for (const k of Object.keys(headers || {})) merged[k] = headers[k];
  let lastErr = null;
  for (let a = 0; a < Math.max(1, attempts || 1); a++) {
    const ctrl = new AbortController();
    const combined = combinedAbortSignal(ctrl.signal, signal);
    const timer = setTimeout(function () { ctrl.abort(); }, fetchTimeout || 30000);
    try {
      // credentials:'include': the extension has host permissions, so this
      // also carries site cookies — one step beyond what VDH's jsfetch sends
      const r = await fetch(url, { headers: merged, cache: bypassCache ? 'reload' : 'default', credentials: 'include', signal: combined.signal });
      clearTimeout(timer);
      if (r.ok) {
        fetchStats.count++;
        const declared = Number(r.headers && typeof r.headers.get === 'function' ? r.headers.get('content-length') : NaN);
        if (Number.isFinite(declared) && declared > 0) fetchStats.bytes += declared;
        // Return the LIVE response to jsfetch (exactly what VDH does). The
        // demuxer reads it via body.getReader(); each .read() is a genuine
        // async op that yields to the event loop, which the emscripten fiber
        // scheduler needs to make progress across the demux/mux fibers.
        // (Draining to an in-memory body first made multi-track DASH stall:
        // all reads resolve as microtasks with no yield, starving the
        // trampoline. That drain was only needed to dodge a Node-only undici
        // parser assert, which never fires in the browser.)
        return r;
      }
      if (r.status === 404 || r.status === 416) return { err_status: r.status };
      lastErr = { err_status: r.status };
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') return (signal && signal.aborted) ? { aborted: true } : { timeout: true };
      // "Failed to fetch" for a host the extension may not read is a permission
      // problem, not a network problem: record the pattern so the job can offer
      // the grant instead of showing a dead end.
      const api = globalThis.MediaSniperHostAccess;
      if (api && typeof api.describeFetchFailure === 'function') {
        try { await api.describeFetchFailure(url, e); } catch (_) { /* best effort */ }
      }
      lastErr = e;
    } finally {
      clearTimeout(timer);
      combined.cleanup();
    }
    if (a + 1 < Math.max(1, attempts || 1)) {
      await new Promise(function (res) { setTimeout(res, Math.pow(2, a) * (retryDelay || 250)); });
    }
  }
  return lastErr instanceof Error ? lastErr : (lastErr || new Error('fetch failed'));
};

globalThis.MutateUrl = function (u) { return u; };
globalThis.MAX_FETCH_ATTEMPTS = 6;
globalThis.MAX_READ_ATTEMPTS = 6;

// ---------------------------------------------------------------------------
// ffmpeg job runner
// ---------------------------------------------------------------------------
let current = null; // { libav, jobId, chunks, timer, seconds, bytes }
let lastDone = null; // result of the most recent finished job (SW-restart recovery)

// Emscripten maps ffmpeg's normal stderr stream to console.error by default.
// HLS emits one "Opening ..." line per segment, so Brave records a successful
// download as hundreds of extension errors. Actual failure is determined from
// ffmpeg's return code below; keep routine stdout/stderr out of DevTools.
// A failed offscreen job must say which host was blocked: the fetch that failed
// is what jsfetch reports to libav, so the pattern is recorded where the fetch
// happened and handed to the worker with the error.
function hostAccessFields() {
  const api = globalThis.MediaSniperHostAccess;
  const pending = api && typeof api.takePending === 'function' ? api.takePending() : [];
  return pending.length ? { needsHosts: pending } : {};
}

function resetHostAccessPending() {
  const api = globalThis.MediaSniperHostAccess;
  if (api && typeof api.takePending === 'function') api.takePending();
}

function hostAccessError(message) {
  return Object.assign({ error: message == null ? '' : String(message) }, hostAccessFields());
}

function discardLibavLog() {}

function beginMediaJobKeepalive() {
  let port = null;
  let timer = null;
  let released = false;
  try {
    port = chrome.runtime.connect({ name: 'ms-media-job' });
    const heartbeat = function () {
      try { port.postMessage({ type: 'heartbeat' }); } catch (e) { /* worker may be restarting */ }
    };
    heartbeat();
    timer = setInterval(heartbeat, 20000);
  } catch (e) { /* old browser: the media job can still run */ }
  return function () {
    if (released) return;
    released = true;
    if (timer != null) clearInterval(timer);
    try { if (port) port.disconnect(); } catch (e) { /* already disconnected */ }
  };
}

function respondWithMediaKeepalive(work, sendResponse) {
  const releaseKeepalive = beginMediaJobKeepalive();
  Promise.resolve().then(work).then(sendResponse).catch(function (err) {
    sendResponse(hostAccessError(String(err && err.message || err)));
  }).finally(releaseKeepalive);
}

const keepaliveLeases = new Map();

function acquireKeepaliveLease(leaseId) {
  const id = String(leaseId || '');
  if (!id || id.length > 128) return false;
  if (keepaliveLeases.has(id)) return true;
  if (keepaliveLeases.size >= 32) return false;
  keepaliveLeases.set(id, beginMediaJobKeepalive());
  return true;
}

function releaseKeepaliveLease(leaseId) {
  const id = String(leaseId || '');
  const release = keepaliveLeases.get(id);
  if (!release) return false;
  keepaliveLeases.delete(id);
  release();
  return true;
}

async function runFfmpegJob(msg, sendResponse) {
  if (current) { sendResponse(hostAccessError('別のffmpegジョブが実行中です')); return; }
  const jobId = msg.jobId || msg.url;
  // Reserve synchronously BEFORE any await: the guard above is the only thing
  // keeping two wasm instances out of this document, and the wasm boot +
  // ffmpeg run are long awaits — a late-arriving job must see us as busy.
  current = { libav: null, jobId: jobId, chunks: null, abortRequested: false };
  resetHostAccessPending();
  activeHeaders = msg.headers || {};
  lastDone = null;
  resetFetchStats();
  const chunks = []; // legacy in-memory assembly, used only without OPFS
  let sink = null;
  let libav = null;
  const startedAt = Date.now();
  const releaseKeepalive = beginMediaJobKeepalive();
  try {
    // wasmurl is mandatory: the module otherwise resolves the wasm against
    // self.location.href (the offscreen page = src/), not the script's dir
    libav = await LibAVFactory({
      noworker: true,
      wasmurl: chrome.runtime.getURL('src/libav/libav-6.5.7.1-h264-aac-mp3.wasm.wasm'),
      print: discardLibavLog,
      printErr: discardLibavLog,
    });
    current.libav = libav;
    current.chunks = chunks;
    if (current.abortRequested) {
      sendResponse(hostAccessError('recording stopped before ffmpeg startup completed'));
      return;
    }

    const OUT = 'out.' + (msg.ext || 'mp4');
    // Stream the muxer output straight into an OPFS file when the disk-backed
    // sink is available. The legacy path had to keep every write in memory and
    // assemble the artifact at the end, so peak RAM scaled with the finished
    // file — the 768 MiB guard exists precisely because of that, and large
    // items failed there after minutes of successful conversion.
    const sinkApi = globalThis.MediaSniperStreamingPolicy;
    if (sinkApi && typeof sinkApi.createOutputSink === 'function') {
      try { sink = await sinkApi.createOutputSink(msg.ext || 'mp4'); } catch (e) { sink = null; }
    }
    current.sink = sink;
    await libav.mkwriterdev(OUT);
    if (current.abortRequested) {
      if (sink) await sink.abort();
      sendResponse(hostAccessError('recording stopped during ffmpeg writer setup'));
      return;
    }
    if (sink) {
      libav.onwrite = function (name, position, data) { sink.write(name, position, data); };
    } else {
      libav.onwrite = function (name, position, data) {
        chunks.push({ pos: position, data: new Uint8Array(data) });
      };
    }

    // NOTE: DASH no longer goes through this function — see
    // handleDashBuild below (jsfetch + dash demuxer deadlocks on
    // multi-segment manifests in this libav build).
    // -nostdin is critical: without it ffmpeg's interactive key check reads
    // stdin, and libav.js serves stdin via window.prompt("Input: ") in a
    // document context — which pops a blocking dialog on real browsers
    // (headless returns null instantly, which is why tests never saw it).
    const args = ['-y', '-nostdin'];
    // The HLS demuxer derives nested `crypto+jsfetch:` URLs for AES-128
    // segments. libav.js starts from a jsfetch input and otherwise narrows the
    // protocol whitelist to jsfetch/http/https, which rejects the compiled
    // crypto protocol before decryption begins. Keep the allowlist explicit
    // and limited to protocols the extension actually needs.
    const hlsProtocols = 'file,data,jsfetch,crypto,http,https';
    args.push('-protocol_whitelist', hlsProtocols, '-analyzeduration', '10M', '-f', 'hls', '-i', 'jsfetch:' + msg.url);
    if (msg.audioUrl) {
      // VDH "m3u8_audio_video_two_sources": separate audio rendition
      // playlist. -map 0:v:0 + 1:a:0? = video from the first input, audio
      // from the second (the "?" tolerates a missing audio stream).
      args.push('-protocol_whitelist', hlsProtocols, '-i', 'jsfetch:' + msg.audioUrl);
    }
    args.push('-c', 'copy');
    if (msg.audioUrl) {
      args.push('-map', '0:v:0', '-map', '1:a:0?');
    }
    args.push('-avoid_negative_ts', 'make_zero');
    if (msg.adtsFix) {
      // MPEG-TS carries AAC in ADTS framing; MP4 needs the ASC form. ffmpeg
      // inserts the conversion on its own for a plain MP4 mux, but NOT when the
      // output is fragmented (live recording), where it fails on the first audio
      // packet instead.
      args.push('-bsf:a', 'aac_adtstoasc');
    }
    if (msg.live) {
      // fragmented MP4: the file stays playable when recording is interrupted
      args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof');
    }
    args.push(OUT);

    // Progress: bytes actually written to the artifact, plus the segment
    // fetches ffmpeg's jsfetch protocol performed. The bundled libav build
    // exposes no ffmpeg_get_out_time_ms/ffmpeg_get_total_size_bytes, so the
    // previous timer reported 0s/0B for the whole job.
    current.timer = setInterval(function () {
      if (!current || current.libav !== libav) return;
      current.seconds = msg.live ? Math.floor((Date.now() - startedAt) / 1000) : 0;
      current.bytes = sink ? sink.bytes() : current.bytes || 0;
      current.fetches = fetchStats.count;
      current.fetchedBytes = fetchStats.bytes;
      sendOffscreenProgress(current);
    }, 1000);

    let rc = 0;
    activeFetchContext = installFetchContext(msg);
    try {
      rc = await libav.ffmpeg(args);
    } catch (e) {
      rc = -1;
    }

    clearInterval(current.timer);
    // A stopped job is recognised from our own interrupt flag: this build has no
    // libav.abortController to read (see abortFfmpegJob).
    const interrupted = fetchAborted || !!(current && current.abortRequested);

    if (rc !== 0 && !msg.live) {
      if (sink) await sink.abort();
      sendResponse(hostAccessError('ffmpeg failed (rc=' + rc + ')'));
      return;
    }

    if (sink) {
      const written = sink.bytes();
      if (!written) {
        await sink.abort();
        sendResponse(hostAccessError('ffmpeg produced no output' + (rc ? ' (rc=' + rc + ')' : '')));
        return;
      }
      // A recording that ended without anyone pressing Stop and produced a
      // trivially small artifact did not work: reporting it as a successful
      // recording would hide the ffmpeg error behind a broken file. A stop
      // (interrupted) or a mid-recording input failure keeps its partial file.
      if (msg.live && !interrupted && rc !== 0 && written < MIN_RECORDING_BYTES) {
        await sink.abort();
        sendResponse(hostAccessError('ffmpeg failed (rc=' + rc + ')'));
        return;
      }
      // Wait for the queued file-system writes, close the file and hand the
      // disk-backed File to the caller: nothing is read back into the heap.
      const made = await sink.finish();
      sink = null;
      lastDone = { jobId: jobId, url: made.url, size: made.size, ext: msg.ext || 'mp4', partial: !!(rc !== 0 && (interrupted || msg.live)) };
      sendResponse({ url: made.url, size: made.size, partial: lastDone.partial });
      return;
    }

    // ----- legacy assembly (OPFS unavailable) -----
    // assemble written chunks positionally (frag output may rewrite offsets)
    let total = 0;
    for (const c of chunks) total = Math.max(total, c.pos + c.data.length);
    const buf = new Uint8Array(total);
    for (const c of chunks) buf.set(c.data, c.pos);

    if (total === 0) {
      sendResponse(hostAccessError('ffmpeg produced no output' + (rc ? ' (rc=' + rc + ')' : '')));
      return;
    }
    const mime = (msg.ext === 'aac') ? 'audio/aac' : 'video/mp4';
    const blobUrl = URL.createObjectURL(new Blob([buf], { type: mime }));
    lastDone = { jobId: jobId, url: blobUrl, size: total, ext: msg.ext || 'mp4', partial: !!(rc !== 0 && (interrupted || msg.live)) };
    sendResponse({ url: blobUrl, size: total, partial: lastDone.partial });
  } catch (e) {
    if (sink) { try { await sink.abort(); } catch (err) { /* best effort */ } }
    sendResponse(hostAccessError(String(e && e.message || e)));
  } finally {
    if (current && current.timer) clearInterval(current.timer);
    current = null;
    activeHeaders = {};
    activeFetchContext = null;
    try { if (libav && libav.exit) libav.exit(); } catch (e) { /* ignore */ }
    releaseKeepalive();
  }
}

function abortFfmpegJob(msg, sendResponse) {
  if (!current) { sendResponse({ ok: false }); return; }
  if (msg.jobId && current.jobId !== msg.jobId) { sendResponse({ ok: false }); return; }
  current.abortRequested = true;
  fetchAborted = true;
  if (!current.libav) { sendResponse({ ok: true }); return; }
  // This libav build exposes neither ffmpeg_interrupt nor a module-level
  // abortController (the bundle's only AbortControllers belong to jsfetch's own
  // responses), so a running ffmpeg is interrupted where it is observable:
  // every open jsfetch response is cancelled and further requests are refused.
  // The demuxer's next read then fails, ffmpeg exits, and a live recording keeps
  // the fragmented MP4 written so far.
  let cancelled = 0;
  const table = current.libav.libavjsJSFetch && current.libav.libavjsJSFetch.fetches;
  if (table) {
    for (const key of Object.keys(table)) {
      const entry = table[key];
      try { if (entry.reader) entry.reader.cancel(); } catch (e) { /* ignore */ }
      try { if (entry.abortController) entry.abortController.abort(); } catch (e) { /* ignore */ }
      try { delete table[key]; } catch (e) { /* ignore */ }
      cancelled++;
    }
  }
  try {
    if (typeof current.libav.ffmpeg_interrupt === 'function') current.libav.ffmpeg_interrupt();
  } catch (e) { /* not present in this build */ }
  sendResponse({ ok: true, cancelled: cancelled });
}

// ---------------------------------------------------------------------------
// Legacy/fallback paths (no ffmpeg needed)
// ---------------------------------------------------------------------------
async function fetchBuf(url, headers) {
  let res = null;
  try {
    res = await fetch(url, { credentials: 'include', headers: headers || {} });
  } catch (err) {
    // A host the extension may not read is a permission problem, not a network
    // one: record it so the job can offer the grant instead of a dead end (this
    // path feeds the YouTube mux and the ADTS concat).
    await noteFetchFailure(url, err);
    throw err;
  }
  if (!res.ok) throw new Error('http ' + res.status);
  return res.arrayBuffer();
}

// Record a blocked-host failure for the running job. The pattern travels back
// with the job's error response (hostAccessFields), which is the only channel
// the worker has to turn it into a one-click grant.
async function noteFetchFailure(url, err) {
  const api = globalThis.MediaSniperHostAccess;
  if (api && typeof api.describeFetchFailure === 'function') {
    try { await api.describeFetchFailure(url, err); } catch (_) { /* best effort */ }
  }
}

async function handleFetchBlob(msg) {
  const buf = await fetchBuf(msg.url, msg.headers);
  const blob = new Blob([buf], { type: msg.mime || 'application/octet-stream' });
  return { url: URL.createObjectURL(blob), size: blob.size };
}

// plain segment concat (X Spaces audio-only ADTS .aac). ffmpeg could do this
// too, but raw ADTS concat is byte-perfect and costs no wasm boot.
async function handleHlsBuild(msg) {
  const CONC = 6;
  const queue = [];
  if (msg.initUrl) queue.push({ i: -1, url: msg.initUrl });
  (msg.segments || []).forEach(function (u, idx) { queue.push({ i: idx, url: u }); });
  const total = queue.length;
  if (!total) throw new Error('nothing to fetch');

  const results = [];
  let done = 0;
  let failed = null;

  async function worker() {
    while (queue.length && !failed) {
      const entry = queue.shift();
      try {
        const buf = await fetchBuf(entry.url, msg.headers);
        results.push({ i: entry.i, buf: buf });
        done++;
        try {
          chrome.runtime.sendMessage({
            type: 'ms-hls-progress', playlistUrl: msg.playlistUrl, done: done, total: total,
          });
        } catch (e) { /* SW asleep: progress is cosmetic */ }
      } catch (err) {
        failed = err;
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(CONC, total); w++) workers.push(worker());
  await Promise.all(workers);
  if (failed) throw failed;

  results.sort(function (a, b) { return a.i - b.i; });
  const blob = new Blob(
    results.map(function (r) { return r.buf; }),
    { type: msg.mime || 'video/mp2t' }
  );
  return { url: URL.createObjectURL(blob), size: blob.size };
}

// ---------------------------------------------------------------------------
// DASH build: fetch init + media segments ourselves (plain fetch with the
// captured headers), concat per track. fMP4 init+segments concatenated is
// already a valid MP4 (verified with ffprobe), so the only step that needs
// ffmpeg is muxing video+audio into one file — and that mux reads two
// LOCAL MEMFS files, never jsfetch, so the dash/jsfetch deadlock cannot
// happen here.
// ---------------------------------------------------------------------------
async function fetchTrack(track, headers, onProgress) {
  const queue = [];
  if (track.initUrl) queue.push({ i: -1, url: track.initUrl });
  track.segments.forEach(function (u, idx) { queue.push({ i: idx, url: u }); });
  const total = queue.length;
  if (!total) throw new Error('track has no segments');
  const CONC = 6;
  const results = [];
  const errors = [];
  let failed = null;

  async function worker() {
    while (queue.length && !failed) {
      const entry = queue.shift();
      try {
        let res = null;
        try {
          res = await fetch(entry.url, { credentials: 'include', headers: headers || {} });
        } catch (fetchErr) {
          await noteFetchFailure(entry.url, fetchErr);
          throw fetchErr;
        }
        if (!res.ok) throw new Error('http ' + res.status);
        results.push({ i: entry.i, buf: await res.arrayBuffer() });
        onProgress();
      } catch (err) {
        failed = err;
        errors.push(entry.url);
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(CONC, total); w++) workers.push(worker());
  await Promise.all(workers);
  if (failed) throw new Error('セグメント取得失敗: ' + failed.message);
  results.sort(function (a, b) { return a.i - b.i; });
  return results.map(function (r) { return r.buf; });
}

async function handleDashBuild(msg, sendResponse) {
  if (current) { sendResponse(hostAccessError('別のffmpegジョブが実行中です')); return; }
  const video = msg.video || null;
  const audio = msg.audio || null;
  if (!video && !audio) { sendResponse(hostAccessError('DASHトラックがありません')); return; }
  // Reserve before the long segment-fetch awaits (same reason as runFfmpegJob)
  const jobId = msg.playlistUrl || 'dash';
  current = { libav: null, jobId: jobId, chunks: null };
  resetHostAccessPending();
  let done = 0;
  const progress = function () {
    done++;
    try {
      chrome.runtime.sendMessage({ type: 'ms-hls-progress', playlistUrl: jobId, done: done, total: 0 });
    } catch (e) { /* SW asleep: cosmetic */ }
  };
  let libav = null;
  try {
    // fetch both tracks concurrently (they are independent)
    const pendV = video ? fetchTrack(video, msg.headers, progress) : null;
    const pendA = audio ? fetchTrack(audio, msg.headers, progress) : null;
    const vParts = pendV ? await pendV : null;
    const aParts = pendA ? await pendA : null;

    // audio-only: concat is the final file — no wasm boot needed.
    // Blob MIME drives the extension Chromium finally writes: video/mp4 and
    // audio/mp4 both get rewritten to .mp4 (verified in real Brave E2E),
    // but audio/x-m4a maps to .m4a, which is what we want.
    if (!video) {
      const blob = new Blob(aParts, { type: 'audio/x-m4a' });
      sendResponse({ url: URL.createObjectURL(blob), size: blob.size });
      return;
    }

    libav = await LibAVFactory({
      noworker: true,
      wasmurl: chrome.runtime.getURL('src/libav/libav-6.5.7.1-h264-aac-mp3.wasm.wasm'),
      print: discardLibavLog,
      printErr: discardLibavLog,
    });
    current.libav = libav;

    const chunks = [];
    await libav.mkwriterdev('out.mp4');
    libav.onwrite = function (name, pos, data) {
      chunks.push({ pos: pos, data: new Uint8Array(data) });
    };

    await libav.writeFile('/v.mp4', joinParts(vParts));
    let rc;
    if (aParts) {
      await libav.writeFile('/a.mp4', joinParts(aParts));
      rc = await libav.ffmpeg(['-y', '-nostdin', '-i', '/v.mp4', '-i', '/a.mp4', '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-f', 'mp4', 'out.mp4']);
    } else {
      rc = await libav.ffmpeg(['-y', '-nostdin', '-i', '/v.mp4', '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-f', 'mp4', 'out.mp4']);
    }

    if (rc !== 0) {
      sendResponse(hostAccessError('ffmpeg出力に失敗しました (rc=' + rc + ')'));
      return;
    }

    let total = 0;
    for (const c of chunks) total = Math.max(total, c.pos + c.data.length);
    if (total === 0) {
      sendResponse(hostAccessError('ffmpeg出力が空です' + (rc ? ' (rc=' + rc + ')' : '')));
      return;
    }
    const buf = new Uint8Array(total);
    for (const c of chunks) buf.set(c.data, c.pos);
    sendResponse({ url: URL.createObjectURL(new Blob([buf], { type: 'video/mp4' })), size: total });
  } catch (e) {
    sendResponse(hostAccessError(String(e && e.message || e)));
  } finally {
    if (current && current.timer) clearInterval(current.timer);
    current = null;
    try { if (libav && libav.exit) libav.exit(); } catch (e) { /* ignore */ }
  }
}

function joinParts(parts) {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(new Uint8Array(p), o); o += p.byteLength; }
  return out;
}

// Disk-backed mux inputs. ffmpeg reads each track through libav's block reader
// device instead of a MEMFS copy, so combined input size stops being a memory
// budget. libav asks for a range through onblockread and expects the bytes back
// through ff_block_reader_dev_send; each answer covers more than the single
// request so ffmpeg re-reads from the device buffer instead of asking again.
const MUX_READAHEAD_BYTES = 1024 * 1024;
const MUX_READAHEAD_MAX_BYTES = 8 * 1024 * 1024;

function installFileInputs(libav, reader, entries) {
  const files = new Map();
  for (const entry of entries) {
    // libav keys its device buffer table by MEMFS node name, and reads report
    // that same name. Registering a path ("/v.mp4") left the buffer table entry
    // unreachable ("v.mp4"), so every read threw EAGAIN and ffmpeg waited
    // forever for a block that could never be sent. Devices are therefore
    // created, read and fed under one bare name.
    files.set(entry.name, entry.file);
  }
  libav.onblockread = function (name, position, length) {
    const file = files.get(String(name).replace(/^\/+/, ''));
    if (!file) return;
    const start = Math.max(0, Number(position) || 0);
    const want = Math.min(Math.max(Number(length) || 0, MUX_READAHEAD_BYTES), MUX_READAHEAD_MAX_BYTES);
    reader(file, start, want).then(function (bytes) {
      try { libav.ff_block_reader_dev_send(name, start, bytes); } catch (e) { /* instance gone */ }
    }).catch(function (err) {
      try { libav.ff_block_reader_dev_send(name, start, null, { error: err }); } catch (e) { /* ignore */ }
    });
  };
  for (const entry of entries) libav.mkblockreaderdev(entry.name, entry.file.size);
}

// ---------------------------------------------------------------------------
// Local-file mux: two blob URLs (already fetched with the page session) ->
// memfs -> ffmpeg -c copy. Same architecture as the DASH mux (which is
// proven: jsfetch never enters the picture, so no deadlock).
// ---------------------------------------------------------------------------
async function handleMuxLocal(msg, sendResponse) {
  if (current) { sendResponse(hostAccessError('別のffmpegジョブが実行中です')); return; }
  if (!msg.videoUrl || !msg.audioUrl) { sendResponse(hostAccessError('映像と音声のURLが必要です')); return; }
  // Reserve before awaits (same busy-guard discipline as the other runners)
  const jobId = msg.jobId || 'mux-local';
  current = { libav: null, jobId: jobId, chunks: null };
  resetFetchStats();
  let libav = null;
  let sink = null;
  const chunks = []; // legacy in-memory assembly, used only without OPFS
  try {
    // Prefer the disk-backed inputs: the tracks are OPFS files already, and
    // ffmpeg can read them through the block reader device, so a mux is not
    // bounded by the combined input size. Reading them into MEMFS stays as the
    // fallback for when a track has no file behind it.
    const policy = globalThis.MediaSniperStreamingPolicy;
    const canUseFiles = policy && typeof policy.fileForUrl === 'function' && typeof policy.readFileRange === 'function';
    let deviceInputs = null;
    if (canUseFiles) {
      const files = await Promise.all([policy.fileForUrl(msg.videoUrl), policy.fileForUrl(msg.audioUrl)]);
      if (files[0] && files[1]) {
        deviceInputs = [
          { name: 'v.mp4', file: files[0] },
          { name: 'a.m4a', file: files[1] },
        ];
      }
    }
    let vBuf = null;
    let aBuf = null;
    if (!deviceInputs) {
      vBuf = new Uint8Array(await (await fetch(msg.videoUrl)).arrayBuffer());
      aBuf = new Uint8Array(await (await fetch(msg.audioUrl)).arrayBuffer());
      const budget = Number(policy && policy.MAX_MUX_INPUT_BYTES) || 384 * 1024 * 1024;
      if (vBuf.byteLength + aBuf.byteLength > budget) {
        sendResponse({
          error: 'mux入力が大きすぎます (メモリ経路では合計 ' +
            Math.round(budget / (1024 * 1024)) + ' MiB まで)',
        });
        return;
      }
    }

    libav = await LibAVFactory({
      noworker: true,
      wasmurl: chrome.runtime.getURL('src/libav/libav-6.5.7.1-h264-aac-mp3.wasm.wasm'),
      print: discardLibavLog,
      printErr: discardLibavLog,
    });
    current.libav = libav;

    // Same disk-backed output as the HLS path: a muxed artifact can be large
    // too, and it used to hit the same 768 MiB in-memory guard.
    const sinkApi = globalThis.MediaSniperStreamingPolicy;
    if (sinkApi && typeof sinkApi.createOutputSink === 'function') {
      try { sink = await sinkApi.createOutputSink(msg.ext || 'mp4'); } catch (e) { sink = null; }
    }
    current.sink = sink;
    await libav.mkwriterdev('out.mp4');
    if (sink) {
      libav.onwrite = function (name, position, data) { sink.write(name, position, data); };
    } else {
      libav.onwrite = function (name, position, data) {
        chunks.push({ pos: position, data: new Uint8Array(data) });
      };
    }

    if (deviceInputs) {
      installFileInputs(libav, policy.readFileRange, deviceInputs);
    } else {
      await libav.writeFile('v.mp4', vBuf);
      await libav.writeFile('a.m4a', aBuf);
    }
    const rc = await libav.ffmpeg(['-y', '-nostdin', '-i', 'v.mp4', '-i', 'a.m4a', '-c', 'copy', '-map', '0:v:0', '-map', '1:a:0?', '-avoid_negative_ts', 'make_zero', '-f', 'mp4', 'out.mp4']);

    if (rc !== 0) {
      if (sink) await sink.abort();
      sendResponse(hostAccessError('muxに失敗しました (rc=' + rc + ')'));
      return;
    }

    if (sink) {
      if (!sink.bytes()) {
        await sink.abort();
        sendResponse(hostAccessError('mux出力が空です' + (rc ? ' (rc=' + rc + ')' : '')));
        return;
      }
      const made = await sink.finish();
      sink = null;
      sendResponse({ url: made.url, size: made.size });
      return;
    }

    let total = 0;
    for (const c of chunks) total = Math.max(total, c.pos + c.data.length);
    if (total === 0) {
      sendResponse(hostAccessError('mux出力が空です' + (rc ? ' (rc=' + rc + ')' : '')));
      return;
    }
    const buf = new Uint8Array(total);
    for (const c of chunks) buf.set(c.data, c.pos);
    sendResponse({ url: URL.createObjectURL(new Blob([buf], { type: 'video/mp4' })), size: total });
  } catch (e) {
    if (sink) { try { await sink.abort(); } catch (err) { /* best effort */ } }
    sendResponse(hostAccessError(String(e && e.message || e)));
  } finally {
    if (current && current.timer) clearInterval(current.timer);
    current = null;
    try { if (libav && libav.exit) libav.exit(); } catch (e) { /* ignore */ }
  }
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== 'string') return false;
  switch (msg.type) {
    case 'ms-offscreen-keepalive-acquire':
      sendResponse({ ok: acquireKeepaliveLease(msg.leaseId) });
      return false;
    case 'ms-offscreen-keepalive-release':
      sendResponse({ ok: true, released: releaseKeepaliveLease(msg.leaseId) });
      return false;
    case 'ms-offscreen-fetch-blob':
      respondWithMediaKeepalive(function () { return handleFetchBlob(msg); }, sendResponse);
      return true;
    case 'ms-offscreen-hls-build':
      respondWithMediaKeepalive(function () { return handleHlsBuild(msg); }, sendResponse);
      return true;
    case 'ms-offscreen-ffmpeg-run':
      runFfmpegJob(msg, sendResponse);
      return true;
    case 'ms-offscreen-mux-local':
      {
        const releaseKeepalive = beginMediaJobKeepalive();
        handleMuxLocal(msg, function (response) {
          releaseKeepalive();
          sendResponse(response);
        });
      }
      return true;
    case 'ms-offscreen-dash-build':
      {
        const releaseKeepalive = beginMediaJobKeepalive();
        handleDashBuild(msg, function (response) {
          releaseKeepalive();
          sendResponse(response);
        });
      }
      return true;
    case 'ms-offscreen-ffmpeg-abort':
      abortFfmpegJob(msg, sendResponse);
      return false;
    case 'ms-offscreen-ffmpeg-status':
      // SW-restart recovery: report a running job or the last finished blob
      sendResponse({
        running: !!current,
        jobId: current ? current.jobId : null,
        seconds: current ? (current.seconds || 0) : 0,
        bytes: current ? (current.bytes || 0) : 0,
        fetches: current ? (current.fetches || 0) : 0,
        fetchedBytes: current ? (current.fetchedBytes || 0) : 0,
        done: lastDone,
      });
      return false;
    default:
      return false;
  }
});