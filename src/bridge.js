'use strict';
/* Page-world bridge for Media Sniper.
 * Injected via content-script <script> injection (web_accessible_resources),
 * runs in the MAIN world.
 *
 * Deliberately does NOT wrap window.fetch or XMLHttpRequest:
 *  - detection of http(s) media is fully covered by the background
 *    webRequest.onResponseStarted listener (same coverage, zero page risk);
 *  - a fetch wrapper becomes the blamed frame for the page's own failing
 *    fire-and-forget fetches ("Uncaught (in promise) TypeError: Failed to
 *    fetch, src/bridge.js" on sites like sbisec.co.jp), because the network
 *    error's stack points at whoever called fetch.
 *
 * What this bridge still owns (things webRequest cannot see):
 *  - <video>/<audio> element scanning (incl. blob: sources)
 *  - URL.createObjectURL tracking (blob URL -> byte size)
 *
 * Communicates with the isolated content script via window.postMessage.
 */
(function () {
  'use strict';
  if (window.__mediaSniperBridgeInstalled) return;
  window.__mediaSniperBridgeInstalled = true;

  var MARKER = 'media-sniper-bridge';
  var MAX_EMIT_PER_PAGE = 500;
  var emitted = 0;

  var L = window.MediaSniperLogic || {
    classifyUrl: function () { return { kind: null, ext: null }; },
    kindFromContentType: function () { return null; },
  };

  function emit(payload) {
    if (emitted >= MAX_EMIT_PER_PAGE) return;
    emitted++;
    try {
      payload.source = MARKER;
      payload.type = 'media';
      payload.pageUrl = location.href;
      window.postMessage(payload, '*');
    } catch (e) { /* never break the page */ }
  }

  function looksMedia(url, contentType) {
    if (!url || typeof url !== 'string') return false;
    if (url.indexOf('data:') === 0 || url.indexOf('chrome-extension:') === 0) return false;
    var kind = L.kindFromContentType(contentType || null, url);
    if (!kind) return false;
    // playlists are owned by the background webRequest path: it validates
    // the text, expands master playlists into per-resolution variants and
    // rejects subtitle playlists. A raw m3u8 from here would show up as one
    // opaque "HLS" entry (the mystery-file complaint).
    if (kind === 'hls' || kind === 'dash') return false;
    return true;
  }

  function emitMedia(url, contentType, size, via) {
    try {
      var abs = new URL(url, location.href).href;
      if (!looksMedia(abs, contentType)) return;
      var kind = L.kindFromContentType(contentType || null, abs);
      emit({ url: abs, kind: kind, contentType: contentType || null, size: size || 0, via: via });
    } catch (e) { /* swallow */ }
  }

  // ---- video element scanning (blob: sources & src attributes) --------------
  function scanVideoEls() {
    try {
      var els = document.querySelectorAll('video, video source, audio');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var src = el.currentSrc || el.src;
        if (src && src.indexOf('blob:') === 0 && !el.__msEmitted) {
          el.__msEmitted = true;
          var dur = el.duration || 0;
          emit({ url: src, kind: 'video', contentType: null, size: 0, via: 'element', duration: dur || 0 });
        } else if (src && looksMedia(src, null) && !el.__msEmitted) {
          el.__msEmitted = true;
          emitMedia(src, null, 0, 'element');
        }
      }
    } catch (e) { /* swallow */ }
  }

  try {
    var iv = setInterval(scanVideoEls, 2000);
    setTimeout(function () { clearInterval(iv); }, 5 * 60 * 1000);
  } catch (e) { /* ignore */ }

  // ---- createObjectURL tracking (blob URL -> byte size) ---------------------
  var nativeCreate = URL.createObjectURL;
  if (typeof nativeCreate === 'function') {
    var blobSizes = {};
    URL.createObjectURL = function (blob) {
      var u = nativeCreate.apply(this, arguments);
      try { if (blob && blob.size) blobSizes[u] = blob.size; } catch (e) { /* ignore */ }
      return u;
    };
    window.addEventListener('message', function (ev) {
      try {
        var d = ev && ev.data;
        if (d && d.source === 'media-sniper-content' && d.type === 'blob-size') {
          var sz = blobSizes[d.url];
          if (sz != null) {
            window.postMessage({ source: MARKER, type: 'blob-size', url: d.url, size: sz }, '*');
          }
        }
      } catch (e) { /* ignore */ }
    });
  }

  // ---- commands from the content script --------------------------------------
  window.addEventListener('message', function (ev) {
    try {
      var d = ev && ev.data;
      if (!d || d.source !== 'media-sniper-content') return;
      if (d.type === 'scan') scanVideoEls();
    } catch (e) { /* ignore */ }
  });
})();
