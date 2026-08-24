/* Offscreen reliability policy.
 *
 * This is a safety rail, not a substitute for fully streaming large-media I/O.
 * It prevents obviously unsafe single-buffer/blob work from growing without a
 * bound and makes Blob URL ownership finite.
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
    if (NativeBlob && part instanceof NativeBlob) return part.size;
    if (part instanceof ArrayBuffer) return part.byteLength;
    if (ArrayBuffer.isView(part)) return part.byteLength;
    return 0;
  }

  class BoundedBlob extends NativeBlob {
    constructor(parts, options) {
      let total = 0;
      for (const part of (parts || [])) {
        total += partSize(part);
        if (total > MAX_OUTPUT_BYTES) {
          throw new RangeError(
            'media output exceeds in-memory safety limit (' +
            Math.round(MAX_OUTPUT_BYTES / MiB) + ' MiB); use a smaller item or a future streaming build'
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

  URL.createObjectURL = function (blob) {
    if (blob && typeof blob.size === 'number' && blob.size > MAX_OUTPUT_BYTES) {
      throw new RangeError('media output exceeds in-memory safety limit');
    }
    const url = nativeCreateObjectURL(blob);
    const timer = setTimeout(function () {
      try { nativeRevokeObjectURL(url); } catch (_) { /* already gone */ }
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
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { MAX_OUTPUT_BYTES, MAX_SINGLE_RESPONSE_BYTES, BLOB_URL_TTL_MS, partSize };
  }
})();
