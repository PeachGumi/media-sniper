'use strict';
/* Page-world bridge for Media Sniper.
 * Injected via content-script <script> injection (web_accessible_resources),
 * runs in the MAIN world so it can wrap window.fetch and XMLHttpRequest.
 * Communicates with the isolated content script via window.postMessage.
 *
 * Contract:
 *  - emits { source: 'media-sniper-bridge', type: 'media', payload: {...} }
 *    payload: { url, kind, contentType, size, via, pageUrl }
 *  - original fetch/XHR responses are returned unchanged
 *  - parse failures are swallowed; the page never breaks
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

  function hostOfUrl(u) {
    try {
      var x = new URL(u);
      return (x.protocol === 'http:' || x.protocol === 'https:') ? x.hostname : null;
    } catch (e) { return null; }
  }

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
    return !!kind;
  }

  function emitMedia(url, contentType, size, via) {
    try {
      var abs = new URL(url, location.href).href;
      if (!looksMedia(abs, contentType)) return;
      var kind = L.kindFromContentType(contentType || null, abs);
      // skip bare TS segments unless they are clearly media (avoid false positives
      // on application-level .ts usage is handled server-side by segment grouping)
      emit({ url: abs, kind: kind, contentType: contentType || null, size: size || 0, via: via });
    } catch (e) { /* swallow */ }
  }

  function ctOfResponse(res) {
    try {
      var h = res && res.headers;
      if (h && typeof h.get === 'function') return h.get('content-type');
    } catch (e) { /* ignore */ }
    return null;
  }

  // ---- fetch wrapping ------------------------------------------------------
  var nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      var url = '';
      try {
        if (typeof input === 'string') url = input;
        else if (input instanceof Request) url = input.url;
        else if (input && input.url) url = input.url;
      } catch (e) { /* ignore */ }
      var p = nativeFetch.apply(this, arguments);
      try {
        // Observe on a side-chain that handles BOTH outcomes. A failing request
        // (network error / abort / blocked tracker) must never surface as an
        // unhandled rejection from this wrapper. The original promise `p` is
        // returned untouched, so the page's own handling is unaffected.
        Promise.resolve(p).then(function (res) {
          try {
            if (res && res.ok && url) {
              var ct = ctOfResponse(res);
              var len = 0;
              try { len = parseInt(res.headers.get('content-length'), 10) || 0; } catch (e2) { /* ignore */ }
              emitMedia(url, ct, len, 'fetch');
            }
          } catch (e) { /* swallow */ }
        }, function () { /* request failed/aborted: nothing to observe */ });
      } catch (e) { /* swallow */ }
      return p;
    };
  }

  // ---- XHR wrapping ----------------------------------------------------------
  var NativeXHR = window.XMLHttpRequest;
  if (typeof NativeXHR === 'function') {
    var origOpen = NativeXHR.prototype.open;
    var origSend = NativeXHR.prototype.send;
    NativeXHR.prototype.open = function (method, url) {
      try { this.__msUrl = url; } catch (e) { /* ignore */ }
      return origOpen.apply(this, arguments);
    };
    NativeXHR.prototype.send = function () {
      var xhr = this;
      try {
        xhr.addEventListener('load', function () {
          try {
            var url = xhr.__msUrl;
            if (!url) return;
            var status = xhr.status;
            if (status >= 200 && status < 300) {
              var ct = null;
              try { ct = xhr.getResponseHeader('content-type'); } catch (e2) { /* ignore */ }
              emitMedia(url, ct, 0, 'xhr');
            }
          } catch (e) { /* swallow */ }
        });
      } catch (e) { /* swallow */ }
      return origSend.apply(this, arguments);
    };
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

  // ---- HLS pipeline (page world: keeps logged-in cookies) -------------------
  function fetchText(url) {
    return window.fetch(url, { credentials: 'include' }).then(function (res) {
      if (!res.ok) throw new Error('http ' + res.status);
      return res.text();
    });
  }

  function withToken(url, token) {
    if (!token) return url;
    try {
      var u = new URL(url);
      if (!u.search) return url + '?' + token;
    } catch (e) { /* ignore */ }
    return url;
  }

  function fetchSegments(segments, initUrl, onProgress) {
    var parts = [];
    var totalBytes = 0;
    var idx = 0;
    var CONC = 6;

    function loadOne(entry) {
      return window.fetch(entry.url, { credentials: 'include' }).then(function (res) {
        if (!res.ok) throw new Error('segment http ' + res.status + ' ' + entry.url);
        return res.arrayBuffer();
      }).then(function (buf) {
        totalBytes += buf.byteLength;
        return { i: entry.i, buf: buf };
      });
    }

    var queue = [];
    if (initUrl) queue.push({ i: -1, url: initUrl });
    for (var s = 0; s < segments.length; s++) queue.push({ i: s, url: segments[s].url });

    var results = [];
    var failed = null;

    function worker() {
      var next = queue.shift();
      if (!next || failed) return Promise.resolve();
      return loadOne(next).then(function (r) {
        results.push(r);
        idx++;
        try { onProgress(idx, queue.length + results.length); } catch (e) { /* ignore */ }
        return worker();
      }, function (err) {
        failed = err;
      });
    }

    var workers = [];
    for (var w = 0; w < CONC; w++) workers.push(worker());
    return Promise.all(workers).then(function () {
      if (failed) throw failed;
      results.sort(function (a, b) { return a.i - b.i; });
      var ordered = results.map(function (r) { return r.buf; });
      var blob = new Blob(ordered, { type: 'video/mp2t' });
      return { blob: blob, bytes: totalBytes };
    });
  }

  function handleHlsFetch(d) {
    var playlistUrl = d.url;
    fetchText(playlistUrl).then(function (text) {
      var parsed = L.parseM3u8(text, playlistUrl);
      if (parsed.type === 'master') {
        var best = L.pickBestVariant(parsed.variants);
        if (!best) throw new Error('no variants in master playlist');
        return fetchText(withToken(best.url, best.token)).then(function (t2) {
          return { parsed: L.parseM3u8(t2, best.url), variant: best };
        });
      }
      return { parsed: parsed, variant: null };
    }).then(function (r) {
      var p = r.parsed;
      if (p.type !== 'media') throw new Error('not a media playlist');
      if (p.encrypted) throw new Error('encrypted HLS (AES-128) not supported yet - use yt-dlp');
      if (!p.segments.length) throw new Error('playlist has no segments');
      return fetchSegments(p.segments, p.initUrl, function (done, total) {
        window.postMessage({ source: MARKER, type: 'hls-progress', url: playlistUrl, done: done, total: total }, '*');
      }).then(function (r2) {
        var blobUrl = URL.createObjectURL(r2.blob);
        window.postMessage({
          source: MARKER, type: 'hls-ready', ok: true,
          url: playlistUrl, blobUrl: blobUrl, size: r2.bytes,
          resolution: r.variant ? r.variant.resolution : null,
          live: p.live, fmp4: !!p.initUrl,
        }, '*');
      });
    }).catch(function (err) {
      window.postMessage({ source: MARKER, type: 'hls-ready', ok: false, url: playlistUrl, error: String(err && err.message || err) }, '*');
    });
  }

  window.addEventListener('message', function (ev) {
    try {
      var d = ev && ev.data;
      if (!d || d.source !== 'media-sniper-content') return;
      if (d.type === 'hls-fetch' && d.url) handleHlsFetch(d);
      else if (d.type === 'scan') scanVideoEls();
    } catch (e) { /* ignore */ }
  });
})();
