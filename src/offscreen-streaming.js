/* Disk-backed media assembly for the offscreen document.
 *
 * The legacy offscreen implementation historically collected every HLS/DASH
 * segment in ArrayBuffers before creating the final Blob. That makes peak RAM
 * scale with the full media size (and often with multiple copies of it).
 *
 * This layer is loaded before offscreen.js and intercepts only operations that
 * can be assembled without transcoding:
 *   - remote fallback -> temporary OPFS file
 *   - plain HLS/ADTS concat -> temporary OPFS file
 *   - DASH init+segment concat -> temporary OPFS track files
 *
 * When DASH needs video+audio muxing we hand the two disk-backed File URLs to
 * the existing local ffmpeg mux path. This does not make ffmpeg itself fully
 * streaming, but removes the segment-array/join copies and enforces a strict
 * combined mux-input budget before the memory-heavy stage begins.
 */
'use strict';

(function () {
  const MiB = 1024 * 1024;
  const MAX_DISK_ASSEMBLY_BYTES = 768 * MiB;
  const MAX_MUX_INPUT_BYTES = 384 * MiB;
  // Attaching a MIME type to a disk-backed artifact costs a full heap copy.
  // Above this the artifact is handed to Downloads as the OPFS File itself.
  const MAX_TYPED_BLOB_BYTES = 256 * MiB;
  // Queued-but-unwritten bytes for the ffmpeg output sink. The file system
  // drains every queued write in order, so this only trips when it cannot keep
  // up with the muxer (exhausted quota, stalled disk); failing loudly there is
  // better than quietly queueing the whole artifact in the renderer's heap.
  const MAX_PENDING_WRITE_BYTES = 512 * MiB;
  // Contiguous muxer writes are merged up to this size before being handed to
  // the file system: one round trip per 8 MiB instead of one per muxer chunk.
  const FLUSH_BYTES = 8 * MiB;
  const TEMP_PREFIX = 'media-sniper-';

  const nativeAddListener = chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage);
  const policyRevokeObjectURL = URL.revokeObjectURL.bind(URL);
  const filesByUrl = new Map();
  let seq = 0;

  function beginMediaJobKeepalive() {
    let port = null;
    let timer = null;
    let released = false;
    try {
      port = chrome.runtime.connect({ name: 'ms-media-job' });
      const heartbeat = function () {
        try { port.postMessage({ type: 'heartbeat' }); } catch (_) {}
      };
      heartbeat();
      timer = setInterval(heartbeat, 20000);
    } catch (_) {}
    return function () {
      if (released) return;
      released = true;
      if (timer != null) clearInterval(timer);
      try { if (port) port.disconnect(); } catch (_) {}
    };
  }

  function respondWithKeepalive(work, sendResponse) {
    const release = beginMediaJobKeepalive();
    Promise.resolve().then(work).then(sendResponse).catch(function (e) {
      sendResponse({ error: String(e && e.message || e) });
    }).finally(release);
  }

  function hasOpfs() {
    return !!(globalThis.navigator && navigator.storage && typeof navigator.storage.getDirectory === 'function');
  }

  function safeExt(ext) {
    return String(ext || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'bin';
  }

  function tempName(ext) {
    seq = (seq + 1) % 1000000;
    return TEMP_PREFIX + Date.now() + '-' + seq + '.' + safeExt(ext);
  }

  async function rootDir() {
    if (!hasOpfs()) throw new Error('OPFS is unavailable in this browser');
    return navigator.storage.getDirectory();
  }

  async function removeTemp(name) {
    try {
      const root = await rootDir();
      await root.removeEntry(name);
    } catch (_) { /* already deleted / storage unavailable */ }
  }

  // A temporary artifact can be handed to ffmpeg as a *device input* instead of
  // being read back into a MEMFS buffer: ffmpeg then reads the disk file through
  // libav's block reader, so track size stops being a memory budget.
  async function fileForUrl(url) {
    const name = filesByUrl.get(url);
    if (!name) return null;
    try {
      const root = await rootDir();
      const handle = await root.getFileHandle(name);
      return await handle.getFile();
    } catch (_) {
      return null;
    }
  }

  async function readFileRange(file, position, length) {
    const start = Math.max(0, Number(position) || 0);
    const size = Number(file.size) || 0;
    if (start >= size) return new Uint8Array(0);
    const end = Math.min(size, start + Math.max(1, Number(length) || 1));
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  }

  async function createTemp(ext) {
    const root = await rootDir();
    const name = tempName(ext);
    const handle = await root.getFileHandle(name, { create: true });
    return { root, name, handle };
  }

  async function streamResponseInto(writable, response, budget, state) {
    if (!response.ok) throw new Error('http ' + response.status);
    const declared = Number(response.headers && response.headers.get && response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > 0 && state.bytes + declared > budget) {
      try { if (response.body) await response.body.cancel(); } catch (_) {}
      throw new RangeError('media exceeds supported assembly limit (' + Math.round(budget / MiB) + ' MiB)');
    }

    if (!response.body || typeof response.body.getReader !== 'function') {
      const buf = new Uint8Array(await response.arrayBuffer());
      if (state.bytes + buf.byteLength > budget) {
        throw new RangeError('media exceeds supported assembly limit (' + Math.round(budget / MiB) + ' MiB)');
      }
      await writable.write(buf);
      state.bytes += buf.byteLength;
      return;
    }

    const reader = response.body.getReader();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        const chunk = part.value;
        if (!chunk || !chunk.byteLength) continue;
        if (state.bytes + chunk.byteLength > budget) {
          try { await reader.cancel(); } catch (_) {}
          throw new RangeError('media exceeds supported assembly limit (' + Math.round(budget / MiB) + ' MiB)');
        }
        await writable.write(chunk);
        state.bytes += chunk.byteLength;
      }
    } finally {
      try { reader.releaseLock(); } catch (_) {}
    }
  }

  async function appendUrl(writable, url, headers, budget, state) {
    let response;
    try {
      response = await fetch(url, { credentials: 'include', headers: headers || {} });
    } catch (err) {
      // Same reasoning as the worker's fetch: an ungranted host must be named.
      const api = globalThis.MediaSniperHostAccess;
      if (api && typeof api.describeFetchFailure === 'function') {
        try { await api.describeFetchFailure(url, err); } catch (_) { /* best effort */ }
      }
      throw err;
    }
    return streamResponseInto(writable, response, budget, state);
  }

  async function fileUrl(temp, mime, typed) {
    const file = await temp.handle.getFile();
    if (file.size > MAX_DISK_ASSEMBLY_BYTES) {
      await removeTemp(temp.name);
      throw new RangeError('media exceeds supported assembly limit');
    }
    // Two distinct consumers need two distinct URL kinds:
    // - Downloads artifacts: an OPFS-backed File URL is streamed straight from
    //   disk by chrome.downloads.download (verified in real Brave with a
    //   900 MiB file: state=complete, exact bytes, ~1.5 s). Small artifacts are
    //   additionally wrapped in a typed in-memory Blob so the saved filename
    //   keeps the intended extension (an untyped body can be sniffed — ADTS's
    //   ID3 header reads as text/plain and silently renamed a file to .txt).
    // - DASH mux inputs are read back in-page by the ffmpeg wasm runtime, never
    //   downloaded, so they keep the zero-copy OPFS File URL.
    //
    // Typing costs a full heap copy of the artifact, so it is applied only up
    // to MAX_TYPED_BLOB_BYTES. Bigger assemblies stay disk-backed: reading
    // hundreds of megabytes back into the heap to attach a MIME type is what
    // the ffmpeg output sink exists to avoid.
    if (typed && file.size <= MAX_TYPED_BLOB_BYTES) {
      const mime_ = mime || 'application/octet-stream';
      const data = new Uint8Array(await file.arrayBuffer());
      const url = URL.createObjectURL(new Blob([data], { type: mime_ }));
      filesByUrl.set(url, temp.name);
      return { url, size: file.size, mime: mime_ };
    }
    const url = URL.createObjectURL(file);
    filesByUrl.set(url, temp.name);
    return { url, size: file.size, mime: mime || file.type || 'application/octet-stream' };
  }

  async function buildRemote(msg) {
    const temp = await createTemp((msg.mime || '').includes('audio') ? 'audio' : 'media');
    let writable;
    try {
      writable = await temp.handle.createWritable();
      const state = { bytes: 0 };
      await appendUrl(writable, msg.url, msg.headers, MAX_DISK_ASSEMBLY_BYTES, state);
      await writable.close();
      writable = null;
      // final user-facing artifact: typed in-memory Blob (downloadable)
      return fileUrl(temp, msg.mime, true);
    } catch (e) {
      try { if (writable) await writable.abort(); } catch (_) {}
      await removeTemp(temp.name);
      throw e;
    }
  }

  async function buildConcat(msg) {
    const urls = [];
    if (msg.initUrl) urls.push(msg.initUrl);
    for (const u of (msg.segments || [])) urls.push(u);
    if (!urls.length) throw new Error('nothing to fetch');

    const temp = await createTemp(msg.ext || ((msg.mime || '').includes('aac') ? 'aac' : 'media'));
    let writable;
    let done = 0;
    try {
      writable = await temp.handle.createWritable();
      const state = { bytes: 0 };
      for (const url of urls) {
        await appendUrl(writable, url, msg.headers, MAX_DISK_ASSEMBLY_BYTES, state);
        done++;
        try {
          chrome.runtime.sendMessage({
            type: 'ms-hls-progress',
            playlistUrl: msg.playlistUrl,
            done,
            total: urls.length,
            bytes: state.bytes,
          });
        } catch (_) {}
      }
      await writable.close();
      writable = null;
      // final user-facing artifact: typed in-memory Blob (downloadable)
      return fileUrl(temp, msg.mime || 'application/octet-stream', true);
    } catch (e) {
      try { if (writable) await writable.abort(); } catch (_) {}
      await removeTemp(temp.name);
      throw e;
    }
  }

  async function buildTrack(track, headers, playlistUrl, progress, typed) {
    const urls = [];
    if (track && track.initUrl) urls.push(track.initUrl);
    for (const u of ((track && track.segments) || [])) urls.push(u);
    if (!urls.length) return null;

    const ext = track && track.type === 'audio' ? 'm4a' : 'mp4';
    const temp = await createTemp(ext);
    let writable;
    try {
      writable = await temp.handle.createWritable();
      const state = { bytes: 0 };
      for (const url of urls) {
        const before = state.bytes;
        await appendUrl(writable, url, headers, MAX_DISK_ASSEMBLY_BYTES, state);
        progress.bytes += state.bytes - before;
        progress.done++;
        try {
          chrome.runtime.sendMessage({
            type: 'ms-hls-progress',
            playlistUrl,
            done: progress.done,
            total: progress.total,
            bytes: progress.bytes,
          });
        } catch (_) {}
      }
      await writable.close();
      writable = null;
      return fileUrl(temp, track && track.type === 'audio' ? 'audio/mp4' : 'video/mp4', typed);
    } catch (e) {
      try { if (writable) await writable.abort(); } catch (_) {}
      await removeTemp(temp.name);
      throw e;
    }
  }

  async function buildDash(msg, originalListener, sender, sendResponse) {
    const videoCount = msg.video ? (msg.video.segments || []).length + (msg.video.initUrl ? 1 : 0) : 0;
    const audioCount = msg.audio ? (msg.audio.segments || []).length + (msg.audio.initUrl ? 1 : 0) : 0;
    const progress = { done: 0, total: videoCount + audioCount, bytes: 0 };
    let video = null;
    let audio = null;
    const singleTrack = !!msg.video !== !!msg.audio;
    try {
      // Tracks are built one at a time so segment download memory stays near a
      // single network chunk rather than N concurrent full segments.
      if (msg.video) video = await buildTrack(msg.video, msg.headers, msg.playlistUrl, progress, singleTrack);
      if (msg.audio) audio = await buildTrack(msg.audio, msg.headers, msg.playlistUrl, progress, singleTrack);

      if (video && audio) {
        // Reuse the existing ffmpeg stream-copy mux implementation. Inputs are
        // disk-backed File URLs rather than arrays of segment buffers, and the
        // mux reads them through libav's block reader device, so combined input
        // size is a storage question instead of a memory budget.
        return originalListener({
          type: 'ms-offscreen-mux-local',
          jobId: msg.playlistUrl || 'dash',
          videoUrl: video.url,
          audioUrl: audio.url,
          ext: 'mp4',
        }, sender, function (result) {
          try { URL.revokeObjectURL(video.url); } catch (_) {}
          try { URL.revokeObjectURL(audio.url); } catch (_) {}
          sendResponse(result);
        });
      }

      const only = video || audio;
      if (!only) throw new Error('DASH track has no segments');
      sendResponse({ url: only.url, size: only.size });
      return true;
    } catch (e) {
      if (video) try { URL.revokeObjectURL(video.url); } catch (_) {}
      if (audio) try { URL.revokeObjectURL(audio.url); } catch (_) {}
      sendResponse({ error: String(e && e.message || e) });
      return true;
    }
  }

  URL.revokeObjectURL = function (url) {
    const name = filesByUrl.get(url);
    filesByUrl.delete(url);
    const result = policyRevokeObjectURL(url);
    if (name) removeTemp(name);
    return result;
  };

  // -------------------------------------------------------------------------
  // ffmpeg output sink: stream muxer writes straight into an OPFS file.
  //
  // The legacy path collected every muxer write in an array and assembled the
  // artifact with `new Uint8Array(total)` + Blob, so peak memory scaled with
  // the finished file — that is what produced
  // "media output exceeds in-memory safety limit (768 MiB)" on large items
  // after minutes of successful conversion.
  //
  // ffmpeg's writer device reports every write as (name, position, bytes), so
  // the same writes can be handed to the file system as they are produced.
  // Heap use is bounded by the queued-write budget (writes drain in order, so a
  // healthy file system keeps the queue near one chunk; a stalled one trips the
  // budget and fails the job instead of hoarding the artifact in memory).
  // The artifact never has to be materialized, and the resulting File URL is a
  // disk-backed object that
  // chrome.downloads.download streams without reading it back into the heap
  // (verified in real Brave with a 900 MiB OPFS file).
  // -------------------------------------------------------------------------
  async function createOutputSink(ext, pendingBudget) {
    if (!hasOpfs()) return null;
    const temp = await createTemp(ext);
    const writable = await temp.handle.createWritable();
    const maxPendingBytes = Number(pendingBudget) > 0 ? Number(pendingBudget) : MAX_PENDING_WRITE_BYTES;
    const state = { highest: 0, writes: 0, pending: 0, maxPending: 0, pendingBytes: 0, error: null, closed: false };
    let chain = Promise.resolve();
    let aborted = false;
    let batch = null; // { at, bytes, parts } - contiguous writes not yet handed over

    // Each write() to a FileSystemWritableFileStream is a round trip to the
    // browser process. The muxer emits far smaller chunks than that cadence can
    // absorb (a 1.2 GB remux outpaced a per-chunk queue badly enough to backlog
    // hundreds of megabytes), so contiguous writes are merged and handed over
    // as one write per FLUSH_BYTES. Absolute offsets make the merge safe: the
    // mp4 muxer rewrites its header with a non-contiguous offset, which simply
    // flushes the current batch first.
    function flushBatch() {
      if (!batch) return chain;
      const current = batch;
      batch = null;
      const merged = new Uint8Array(current.bytes);
      let offset = 0;
      for (const part of current.parts) {
        merged.set(part, offset);
        offset += part.byteLength;
      }
      chain = chain.then(function () {
        return writable.write({ type: 'write', position: current.at, data: merged });
      }).catch(function (err) {
        if (!state.error) state.error = err;
      }).then(function () {
        state.pendingBytes -= merged.byteLength;
      });
      return chain;
    }

    async function abort() {
      if (aborted) return true;
      aborted = true;
      state.closed = true;
      batch = null;
      try { await writable.abort(); } catch (_) { /* stream already gone */ }
      await removeTemp(temp.name);
      return true;
    }

    return {
      name: temp.name,
      write: function (name, position, data) {
        if (state.closed || state.error) return;
        const at = Number(position);
        if (!Number.isFinite(at) || at < 0) {
          // Guessing an offset here would silently corrupt the artifact.
          if (!state.error) state.error = new RangeError('media writer received an invalid output offset');
          return;
        }
        // Detach from the emscripten heap: libav reuses that memory as soon as
        // the callback returns, and the file-system write is asynchronous.
        const copy = new Uint8Array(data);
        state.pendingBytes += copy.byteLength;
        if (state.pendingBytes > maxPendingBytes) {
          if (!state.error) {
            state.error = new RangeError(
              'disk writer cannot keep up with the muxer (queued writes exceed ' +
              Math.round(maxPendingBytes / MiB) + ' MiB)'
            );
          }
          return;
        }
        if (at + copy.byteLength > state.highest) state.highest = at + copy.byteLength;
        state.writes++;
        if (batch && batch.at + batch.bytes === at && batch.bytes + copy.byteLength <= FLUSH_BYTES) {
          batch.parts.push(copy);
          batch.bytes += copy.byteLength;
          return;
        }
        flushBatch();
        batch = { at: at, bytes: copy.byteLength, parts: [copy] };
        if (batch.bytes >= FLUSH_BYTES) flushBatch();
      },
      bytes: function () { return state.highest; },
      writes: function () { return state.writes; },
      maxPending: function () {
        const queued = batch ? batch.bytes : 0;
        return state.maxPending = Math.max(state.maxPending, state.pendingBytes - queued, 0);
      },
      pendingBytes: function () { return state.pendingBytes; },
      finish: async function () {
        // A capped or failed sink must not wait for a queue that the file system
        // is no longer draining: report the failure instead of hanging the job.
        if (state.error) {
          const pendingError = state.error;
          await abort();
          throw pendingError;
        }
        flushBatch();
        await chain;
        if (state.error) {
          const err = state.error;
          await abort();
          throw err;
        }
        state.closed = true;
        await writable.close();
        const file = await temp.handle.getFile();
        const url = URL.createObjectURL(file);
        filesByUrl.set(url, temp.name);
        return { url: url, file: file, size: file.size, name: temp.name };
      },
      abort: abort,
    };
  }

  // offscreen.js registers one listener after this script. Wrap that listener
  // and route disk-assemblable operations here; every other message keeps the
  // original implementation unchanged.
  chrome.runtime.onMessage.addListener = function (listener) {
    return nativeAddListener(function (msg, sender, sendResponse) {
      if (!hasOpfs() || !msg || typeof msg.type !== 'string') {
        return listener(msg, sender, sendResponse);
      }

      if (msg.type === 'ms-offscreen-fetch-blob') {
        respondWithKeepalive(function () { return buildRemote(msg); }, sendResponse);
        return true;
      }

      if (msg.type === 'ms-offscreen-hls-build') {
        respondWithKeepalive(function () { return buildConcat(msg); }, sendResponse);
        return true;
      }

      if (msg.type === 'ms-offscreen-dash-build') {
        const release = beginMediaJobKeepalive();
        buildDash(msg, listener, sender, function (response) {
          release();
          sendResponse(response);
        });
        return true;
      }

      return listener(msg, sender, sendResponse);
    });
  };

  globalThis.MediaSniperStreamingPolicy = {
    MAX_DISK_ASSEMBLY_BYTES,
    MAX_MUX_INPUT_BYTES,
    hasOpfs,
    ownedTempCount: function () { return filesByUrl.size; },
    streamResponseInto,
    createOutputSink,
    fileForUrl,
    readFileRange,
  };

  if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('pagehide', function () {
      for (const url of Array.from(filesByUrl.keys())) {
        try { URL.revokeObjectURL(url); } catch (_) {}
      }
    });
  }
})();
