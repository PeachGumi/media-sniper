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
  const TEMP_PREFIX = 'media-sniper-';

  const nativeAddListener = chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage);
  const policyRevokeObjectURL = URL.revokeObjectURL.bind(URL);
  const filesByUrl = new Map();
  let seq = 0;

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
    const response = await fetch(url, { credentials: 'include', headers: headers || {} });
    return streamResponseInto(writable, response, budget, state);
  }

  async function fileUrl(temp, mime, typed) {
    const file = await temp.handle.getFile();
    if (file.size > MAX_DISK_ASSEMBLY_BYTES) {
      await removeTemp(temp.name);
      throw new RangeError('media exceeds supported assembly limit');
    }
    // Two distinct consumers need two distinct URL kinds:
    // - chrome.downloads CANNOT save a blob: URL whose backing is an OPFS
    //   file (or a Blob wrapping one): the transfer dies instantly with
    //   USER_CANCELED ("check your internet connection" in the popup).
    //   Final user-facing artifacts therefore must be plain in-memory Blobs,
    //   typed so the saved filename keeps the right extension (an untyped
    //   body gets sniffed — ADTS/AAC's ID3 header reads as text/plain and
    //   silently renamed the file to .txt). Size is already capped by the
    //   assembly budget, matching the legacy full-buffer peak.
    // - DASH mux inputs are fetched back in-page by the ffmpeg wasm runtime,
    //   never downloaded, so they keep the zero-copy OPFS File URL.
    if (typed) {
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

  async function buildTrack(track, headers, playlistUrl, progress) {
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
        await appendUrl(writable, url, headers, MAX_DISK_ASSEMBLY_BYTES, state);
        progress.done++;
        try {
          chrome.runtime.sendMessage({
            type: 'ms-hls-progress',
            playlistUrl,
            done: progress.done,
            total: progress.total,
          });
        } catch (_) {}
      }
      await writable.close();
      writable = null;
      return fileUrl(temp, track && track.type === 'audio' ? 'audio/mp4' : 'video/mp4');
    } catch (e) {
      try { if (writable) await writable.abort(); } catch (_) {}
      await removeTemp(temp.name);
      throw e;
    }
  }

  async function buildDash(msg, originalListener, sender, sendResponse) {
    const videoCount = msg.video ? (msg.video.segments || []).length + (msg.video.initUrl ? 1 : 0) : 0;
    const audioCount = msg.audio ? (msg.audio.segments || []).length + (msg.audio.initUrl ? 1 : 0) : 0;
    const progress = { done: 0, total: videoCount + audioCount };
    let video = null;
    let audio = null;
    try {
      // Tracks are built one at a time so segment download memory stays near a
      // single network chunk rather than N concurrent full segments.
      if (msg.video) video = await buildTrack(msg.video, msg.headers, msg.playlistUrl, progress);
      if (msg.audio) audio = await buildTrack(msg.audio, msg.headers, msg.playlistUrl, progress);

      if (video && audio) {
        if (video.size + audio.size > MAX_MUX_INPUT_BYTES) {
          throw new RangeError(
            'DASH mux input exceeds supported in-memory mux limit (' +
            Math.round(MAX_MUX_INPUT_BYTES / MiB) + ' MiB combined)'
          );
        }
        // Reuse the existing ffmpeg stream-copy mux implementation. Inputs are
        // now disk-backed File URLs rather than arrays of segment buffers.
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

  // offscreen.js registers one listener after this script. Wrap that listener
  // and route disk-assemblable operations here; every other message keeps the
  // original implementation unchanged.
  chrome.runtime.onMessage.addListener = function (listener) {
    return nativeAddListener(function (msg, sender, sendResponse) {
      if (!hasOpfs() || !msg || typeof msg.type !== 'string') {
        return listener(msg, sender, sendResponse);
      }

      if (msg.type === 'ms-offscreen-fetch-blob') {
        buildRemote(msg).then(sendResponse).catch(function (e) {
          sendResponse({ error: String(e && e.message || e) });
        });
        return true;
      }

      if (msg.type === 'ms-offscreen-hls-build') {
        buildConcat(msg).then(sendResponse).catch(function (e) {
          sendResponse({ error: String(e && e.message || e) });
        });
        return true;
      }

      if (msg.type === 'ms-offscreen-dash-build') {
        buildDash(msg, listener, sender, sendResponse);
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
  };

  if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('pagehide', function () {
      for (const url of Array.from(filesByUrl.keys())) {
        try { URL.revokeObjectURL(url); } catch (_) {}
      }
    });
  }
})();
