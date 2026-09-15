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
    sendResponse({ error: String(err && err.message || err) });
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
  if (current) { sendResponse({ error: '別のffmpegジョブが実行中です' }); return; }
  const jobId = msg.jobId || msg.url;
  // Reserve synchronously BEFORE any await: the guard above is the only thing
  // keeping two wasm instances out of this document, and the wasm boot +
  // ffmpeg run are long awaits — a late-arriving job must see us as busy.
  current = { libav: null, jobId: jobId, chunks: null, abortRequested: false };
  activeHeaders = msg.headers || {};
  lastDone = null;
  const chunks = [];
  let libav = null;
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
      sendResponse({ error: 'recording stopped before ffmpeg startup completed' });
      return;
    }

    const OUT = 'out.' + (msg.ext || 'mp4');
    await libav.mkwriterdev(OUT);
    if (current.abortRequested) {
      sendResponse({ error: 'recording stopped during ffmpeg writer setup' });
      return;
    }
    libav.onwrite = function (name, pos, data) {
      chunks.push({ pos: pos, data: new Uint8Array(data) });
    };

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
    if (msg.live) {
      // fragmented MP4: the file stays playable when recording is interrupted
      args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof');
    }
    args.push(OUT);

    // progress: ffmpeg's own counters, forwarded as plain messages
    current.timer = setInterval(async function () {
      if (!current || current.libav !== libav) return;
      try {
        const ms = await libav.ffmpeg_get_out_time_ms();
        const bytes = await libav.ffmpeg_get_total_size_bytes();
        current.seconds = Math.floor(ms / 1000);
        current.bytes = bytes || 0;
        chrome.runtime.sendMessage({
          type: 'ms-offscreen-progress',
          jobId: jobId, seconds: current.seconds, bytes: current.bytes,
        });
      } catch (e) { /* instance torn down */ }
    }, 1000);

    let rc = 0;
    activeFetchContext = installFetchContext(msg);
    try {
      rc = await libav.ffmpeg(args);
    } catch (e) {
      rc = -1;
    }

    clearInterval(current.timer);
    const aborted = !!(libav.abortController && libav.abortController.signal.aborted);

    if (rc !== 0 && !msg.live) {
      sendResponse({ error: 'ffmpeg failed (rc=' + rc + ')' });
      return;
    }

    // assemble written chunks positionally (frag output may rewrite offsets)
    let total = 0;
    for (const c of chunks) total = Math.max(total, c.pos + c.data.length);
    const buf = new Uint8Array(total);
    for (const c of chunks) buf.set(c.data, c.pos);

    if (total === 0) {
      sendResponse({ error: 'ffmpeg produced no output' + (rc ? ' (rc=' + rc + ')' : '') });
      return;
    }
    const mime = (msg.ext === 'aac') ? 'audio/aac' : 'video/mp4';
    const blobUrl = URL.createObjectURL(new Blob([buf], { type: mime }));
    lastDone = { jobId: jobId, url: blobUrl, size: total, ext: msg.ext || 'mp4', partial: !!(rc !== 0 && (aborted || msg.live)) };
    sendResponse({ url: blobUrl, size: total, partial: lastDone.partial });
  } catch (e) {
    sendResponse({ error: String(e && e.message || e) });
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
  if (!current.libav) { sendResponse({ ok: true }); return; }
  try {
    if (current.libav.abortController) current.libav.abortController.abort();
  } catch (e) { /* ignore */ }
  try { current.libav.ffmpeg_interrupt(); } catch (e) { /* ignore */ }
  sendResponse({ ok: true });
}

// ---------------------------------------------------------------------------
// Legacy/fallback paths (no ffmpeg needed)
// ---------------------------------------------------------------------------
async function fetchBuf(url, headers) {
  const res = await fetch(url, { credentials: 'include', headers: headers || {} });
  if (!res.ok) throw new Error('http ' + res.status);
  return res.arrayBuffer();
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
        const res = await fetch(entry.url, { credentials: 'include', headers: headers || {} });
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
  if (current) { sendResponse({ error: '別のffmpegジョブが実行中です' }); return; }
  const video = msg.video || null;
  const audio = msg.audio || null;
  if (!video && !audio) { sendResponse({ error: 'DASHトラックがありません' }); return; }
  // Reserve before the long segment-fetch awaits (same reason as runFfmpegJob)
  const jobId = msg.playlistUrl || 'dash';
  current = { libav: null, jobId: jobId, chunks: null };
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
      sendResponse({ error: 'ffmpeg出力に失敗しました (rc=' + rc + ')' });
      return;
    }

    let total = 0;
    for (const c of chunks) total = Math.max(total, c.pos + c.data.length);
    if (total === 0) {
      sendResponse({ error: 'ffmpeg出力が空です' + (rc ? ' (rc=' + rc + ')' : '') });
      return;
    }
    const buf = new Uint8Array(total);
    for (const c of chunks) buf.set(c.data, c.pos);
    sendResponse({ url: URL.createObjectURL(new Blob([buf], { type: 'video/mp4' })), size: total });
  } catch (e) {
    sendResponse({ error: String(e && e.message || e) });
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

// ---------------------------------------------------------------------------
// Local-file mux: two blob URLs (already fetched with the page session) ->
// memfs -> ffmpeg -c copy. Same architecture as the DASH mux (which is
// proven: jsfetch never enters the picture, so no deadlock).
// ---------------------------------------------------------------------------
async function handleMuxLocal(msg, sendResponse) {
  if (current) { sendResponse({ error: '別のffmpegジョブが実行中です' }); return; }
  if (!msg.videoUrl || !msg.audioUrl) { sendResponse({ error: '映像と音声のURLが必要です' }); return; }
  // Reserve before awaits (same busy-guard discipline as the other runners)
  const jobId = msg.jobId || 'mux-local';
  current = { libav: null, jobId: jobId, chunks: null };
  let libav = null;
  try {
    const vBuf = new Uint8Array(await (await fetch(msg.videoUrl)).arrayBuffer());
    const aBuf = new Uint8Array(await (await fetch(msg.audioUrl)).arrayBuffer());

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

    await libav.writeFile('/v.mp4', vBuf);
    await libav.writeFile('/a.m4a', aBuf);
    const rc = await libav.ffmpeg(['-y', '-nostdin', '-i', '/v.mp4', '-i', '/a.m4a', '-c', 'copy', '-map', '0:v:0', '-map', '1:a:0?', '-avoid_negative_ts', 'make_zero', '-f', 'mp4', 'out.mp4']);

    if (rc !== 0) {
      sendResponse({ error: 'muxに失敗しました (rc=' + rc + ')' });
      return;
    }

    let total = 0;
    for (const c of chunks) total = Math.max(total, c.pos + c.data.length);
    if (total === 0) {
      sendResponse({ error: 'mux出力が空です' + (rc ? ' (rc=' + rc + ')' : '') });
      return;
    }
    const buf = new Uint8Array(total);
    for (const c of chunks) buf.set(c.data, c.pos);
    sendResponse({ url: URL.createObjectURL(new Blob([buf], { type: 'video/mp4' })), size: total });
  } catch (e) {
    sendResponse({ error: String(e && e.message || e) });
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
        done: lastDone,
      });
      return false;
    default:
      return false;
  }
});