/* Offscreen security/reliability policy.
 *
 * This is a safety rail, not a substitute for fully streaming large-media I/O.
 * It bounds obvious single-buffer/blob work, gives Blob URLs finite ownership,
 * and prevents tab/content-script senders from invoking privileged offscreen
 * fetch/mux commands directly.
 */
'use strict';

(function () {
  const MiB = 1024 * 1024;
  const MAX_OUTPUT_BYTES = 768 * MiB;
  const MAX_SINGLE_RESPONSE_BYTES = 512 * MiB;
  const BLOB_URL_TTL_MS = 30 * 60 * 1000;

  const NativeBlob = globalThis.Blob;
  const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
  const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const ownedUrls = new Map();

  function partSize(part) {
    if (part == null) return 0;
    if (typeof part === 'string') return new TextEncoder().encode(part).byteLength;
    // A File is a disk-backed handle, not resident bytes: OPFS artifacts are
    // counted by the storage quota, never by this in-memory budget.
    if (typeof File !== 'undefined' && part instanceof File) return 0;
    if (NativeBlob && part instanceof NativeBlob) return part.size;
    if (part instanceof ArrayBuffer) return part.byteLength;
    if (ArrayBuffer.isView(part)) return part.byteLength;
    return 0;
  }

  function isDiskBacked(blob) {
    return typeof File !== 'undefined' && blob instanceof File;
  }

  function isTrustedOffscreenSender(sender, extensionId) {
    // Service-worker/extension-document senders carry our extension id and no
    // tab. Content scripts carry sender.tab and are never allowed to call the
    // privileged offscreen fetch/ffmpeg entry points directly.
    return !!sender && sender.id === extensionId && !sender.tab;
  }

  class BoundedBlob extends NativeBlob {
    constructor(parts, options) {
      let total = 0;
      for (const part of (parts || [])) {
        total += partSize(part);
        if (total > MAX_OUTPUT_BYTES) {
          throw new RangeError(
            'media output exceeds in-memory safety limit (' +
            Math.round(MAX_OUTPUT_BYTES / MiB) + ' MiB): disk-backed streaming is unavailable for this job'
          );
        }
      }
      super(parts, options);
    }
  }

  function forgetUrl(url) {
    const timer = ownedUrls.get(url);
    if (timer) clearTimeout(timer);
    ownedUrls.delete(url);
  }

  function revokeOwnedUrl(url) {
    if (!ownedUrls.has(url)) return false;
    try { URL.revokeObjectURL(url); } catch (_) { forgetUrl(url); }
    return true;
  }

  URL.createObjectURL = function (blob) {
    // Disk-backed artifacts (OPFS Files handed to Downloads after streaming a
    // large ffmpeg job) never live in the JS heap, so the in-memory budget does
    // not apply; the browser storage quota governs them instead.
    if (!isDiskBacked(blob) && blob && typeof blob.size === 'number' && blob.size > MAX_OUTPUT_BYTES) {
      throw new RangeError('media output exceeds in-memory safety limit');
    }
    const url = nativeCreateObjectURL(blob);
    const timer = setTimeout(function () {
      // Release through the *current* revoke path, not the native function:
      // later layers hang their own cleanup off URL.revokeObjectURL (the OPFS
      // artifact sink deletes its temporary file there), so revoking natively
      // here left multi-gigabyte artifacts on disk until the document died.
      try { URL.revokeObjectURL(url); } catch (_) { /* already gone */ }
      ownedUrls.delete(url);
    }, BLOB_URL_TTL_MS);
    ownedUrls.set(url, timer);
    return url;
  };

  URL.revokeObjectURL = function (url) {
    forgetUrl(url);
    return nativeRevokeObjectURL(url);
  };

  globalThis.Blob = BoundedBlob;

  globalThis.fetch = async function () {
    const response = await nativeFetch.apply(null, arguments);
    try {
      const raw = response.headers && response.headers.get && response.headers.get('content-length');
      const n = raw == null ? 0 : Number(raw);
      if (Number.isFinite(n) && n > MAX_SINGLE_RESPONSE_BYTES) {
        try { if (response.body) await response.body.cancel(); } catch (_) { /* ignore */ }
        throw new RangeError(
          'single media response exceeds in-memory safety limit (' +
          Math.round(MAX_SINGLE_RESPONSE_BYTES / MiB) + ' MiB)'
        );
      }
    } catch (e) {
      if (e instanceof RangeError) throw e;
    }
    return response;
  };

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage &&
      typeof chrome.runtime.onMessage.addListener === 'function') {
    const rawAddListener = chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage);

    // Explicit ownership release from the service worker. The TTL remains a
    // fallback for crashes/restarts that happen before this message is sent.
    rawAddListener(function (msg, sender, sendResponse) {
      if (!msg || msg.type !== 'ms-offscreen-revoke-url') return false;
      if (!isTrustedOffscreenSender(sender, chrome.runtime.id)) {
        try { sendResponse({ error: 'rejected by offscreen security policy' }); } catch (_) { /* ignore */ }
        return false;
      }
      const released = typeof msg.url === 'string' ? revokeOwnedUrl(msg.url) : false;
      try { sendResponse({ ok: true, released: released }); } catch (_) { /* ignore */ }
      return false;
    });

    chrome.runtime.onMessage.addListener = function (listener) {
      return rawAddListener(function (msg, sender, sendResponse) {
        if (msg && typeof msg.type === 'string' && /^ms-offscreen-/.test(msg.type) &&
            !isTrustedOffscreenSender(sender, chrome.runtime.id)) {
          try { sendResponse({ error: 'rejected by offscreen security policy' }); } catch (_) { /* ignore */ }
          return false;
        }
        let guardedResponse = sendResponse;
        if (msg && msg.type === 'ms-offscreen-ffmpeg-status') {
          // offscreen.js keeps lastDone for SW-restart recovery. If lifecycle
          // cleanup already revoked that URL (or TTL did), never expose a stale
          // recovery result to a newly started service worker.
          guardedResponse = function (response) {
            let safe = response;
            if (response && response.done && response.done.url && !ownedUrls.has(response.done.url)) {
              safe = Object.assign({}, response, { done: null });
            }
            return sendResponse(safe);
          };
        }
        return listener(msg, sender, guardedResponse);
      });
    };
  }

  if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('pagehide', function () {
      for (const url of Array.from(ownedUrls.keys())) {
        try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
      }
    });
  }

  globalThis.MediaSniperMemoryPolicy = {
    MAX_OUTPUT_BYTES,
    MAX_SINGLE_RESPONSE_BYTES,
    BLOB_URL_TTL_MS,
    ownedUrlCount: function () { return ownedUrls.size; },
    ownsUrl: function (url) { return ownedUrls.has(url); },
    revokeOwnedUrl,
    isTrustedOffscreenSender,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      MAX_OUTPUT_BYTES,
      MAX_SINGLE_RESPONSE_BYTES,
      BLOB_URL_TTL_MS,
      partSize,
      isTrustedOffscreenSender,
    };
  }
})();
