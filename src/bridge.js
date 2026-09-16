'use strict';
/* Page-world bridge for Media Sniper.
 * Injected via content-script <script> injection (web_accessible_resources),
 * runs in the MAIN world.
 *
 * Deliberately does NOT wrap window.fetch or XMLHttpRequest: it reads the
 * page's own resource timing instead, which names every request the page made
 * (cross-origin included) without changing any page global. That is how a
 * manifest a player keeps out of the DOM is discovered here - the job the
 * reference implementation gives a per-site adapter.
 *
 *  - detection of http(s) media is fully covered by the background
 *    webRequest.onResponseStarted listener (same coverage, zero page risk);
 *  - a fetch wrapper becomes the blamed frame for the page's own failing
 *    fire-and-forget fetches ("Uncaught (in promise) TypeError: Failed to
 *    fetch, src/bridge.js" on sites like sbisec.co.jp), because the network
 *    error's stack points at whoever called fetch.
 *
 * What this bridge still owns (things webRequest cannot see):
 *  - <video>/<audio>/<source> scanning (incl. blob: sources)
 *  - bounded page metadata (Open Graph + Schema.org JSON-LD)
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
  var MAX_MEDIA_ELEMENTS = 128;
  var emitted = 0;
  var scanPageUrl = String(location.href || '');
  var metadataSeen = Object.create(null);
  var metadataSeenCount = 0;

  var L = window.MediaSniperLogic || {
    classifyUrl: function () { return { kind: null, ext: null }; },
    kindFromContentType: function () { return null; },
    itemKey: function (url) { return String(url || ''); },
  };
  var PM = window.MediaSniperPageMetadata || null;

  function resetPageState() {
    emitted = 0;
    metadataSeen = Object.create(null);
    metadataSeenCount = 0;
  }

  function resolveSafeUrl(raw) {
    try {
      if (PM && typeof PM.safeUrl === 'function') return PM.safeUrl(String(raw || ''), location.href);
      var value = String(raw || '').trim();
      if (!value || value.length > 4096) return null;
      var u = new URL(value, location.href);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.href.length <= 4096 ? u.href : null;
      if (u.protocol === 'blob:') {
        var inner = new URL(String(u.href).slice('blob:'.length));
        if (inner.protocol !== 'http:' && inner.protocol !== 'https:') return null;
        return u.href.length <= 4096 ? u.href : null;
      }
      return null;
    } catch (_) { return null; }
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

  function readAttr(el, name) {
    try {
      if (el && typeof el.getAttribute === 'function') return String(el.getAttribute(name) || '');
      return el && el[name] != null ? String(el[name]) : '';
    } catch (_) { return ''; }
  }

  function keyFor(url, kind) {
    try {
      var k = typeof L.itemKey === 'function' ? L.itemKey(url) : url;
      return String(k || url) + '\u0000' + String(kind || '');
    } catch (_) { return String(url || '') + '\u0000' + String(kind || ''); }
  }

  function looksMedia(url, contentType) {
    if (!url || typeof url !== 'string') return false;
    var abs = resolveSafeUrl(url);
    if (!abs) return false;
    var kind = L.kindFromContentType(contentType || null, abs);
    if (!kind) return false;
    // playlists are owned by the background webRequest path: it validates
    // the text, expands master playlists into per-resolution variants and
    // rejects subtitle playlists. A raw m3u8 from here would show up as one
    // opaque "HLS" entry (the mystery-file complaint).
    if (kind === 'hls' || kind === 'dash' || kind === 'ts') return false;
    return kind === 'video' || kind === 'audio';
  }

  function elementHint(el) {
    var current = el;
    for (var depth = 0; current && depth < 8; depth++, current = current.parentElement) {
      var tag = String(current.tagName || '').toLowerCase();
      if (tag === 'video') return 'video';
      if (tag === 'audio') return 'audio';
    }
    return null;
  }

  function elementKind(el, url, contentType) {
    var inferred = null;
    try { inferred = L.kindFromContentType(contentType || null, url); } catch (_) {}
    if (inferred === 'hls' || inferred === 'dash' || inferred === 'ts') return null;
    if (inferred === 'video' || inferred === 'audio') return inferred;
    return elementHint(el);
  }

  function metadataTitleFor(url, kind, titleMap) {
    if (!titleMap) return '';
    return titleMap[keyFor(url, kind)] || titleMap[keyFor(url, '')] || '';
  }

  function scanVideoEls(force, pageTitle, titleMap) {
    var observed = [];
    try {
      var here = String(location.href || '');
      if (here !== scanPageUrl) {
        scanPageUrl = here;
        resetPageState();
      }
      var els = document.querySelectorAll('video, audio, source');
      for (var i = 0; i < els.length && i < MAX_MEDIA_ELEMENTS; i++) {
        var el = els[i];
        var src = '';
        try { src = el.currentSrc || ''; } catch (_) {}
        if (!src) src = readAttr(el, 'src');
        if (!src) {
          try { src = el.src || ''; } catch (_) { src = ''; }
        }
        if (!src) continue;
        var abs = resolveSafeUrl(src);
        if (!abs) continue;
        var contentType = readAttr(el, 'type');
        var kind = elementKind(el, abs, contentType);
        if (!kind) {
          // Existing blob handling has no MIME to classify. The media element
          // itself is the concrete source, so its tag supplies the kind.
          if (abs.indexOf('blob:') === 0) kind = elementHint(el) || 'video';
          else continue;
        }
        var title = metadataTitleFor(abs, kind, titleMap) || pageTitle || readAttr(el, 'title') || readAttr(el, 'aria-label');
        var signature = abs + '\u0000' + kind + '\u0000' + title;
        var changed = el.__msEmittedSrc !== abs || el.__msEmittedSignature !== signature;
        if (force || changed) {
          el.__msEmittedSrc = abs;
          el.__msEmittedSignature = signature;
          var duration = 0;
          try { duration = Number(el.duration) || 0; } catch (_) {}
          if (!duration && el.parentElement) {
            try { duration = Number(el.parentElement.duration) || 0; } catch (_) {}
          }
          var payload = {
            url: abs, kind: kind, contentType: contentType || null, size: 0,
            via: 'element', duration: duration || 0,
          };
          if (title) payload.title = title;
          try {
            if (PM && typeof PM.vimeoIdentityForElement === 'function') {
              var vimeoId = PM.vimeoIdentityForElement(el, location.href);
              if (vimeoId) payload.vimeoId = vimeoId;
            }
          } catch (_) {}
          emit(payload);
        }
        observed.push({ url: abs, kind: kind, key: keyFor(abs, kind) });
      }
    } catch (e) { /* swallow */ }
    return observed;
  }

  function rememberMetadataTitle(map, record) {
    if (!record || !record.url || !record.title) return;
    var key = keyFor(record.url, record.kind);
    var old = map[key];
    if (!old || String(record.title).length > String(old).length) map[key] = String(record.title).slice(0, 500);
    var urlKey = keyFor(record.url, '');
    if (!map[urlKey] || String(record.title).length > String(map[urlKey]).length) map[urlKey] = String(record.title).slice(0, 500);
  }

  function emitMetadata(record) {
    if (!record || !record.url || (record.kind !== 'video' && record.kind !== 'audio')) return;
    var abs = resolveSafeUrl(record.url);
    if (!abs) return;
    // Recheck concrete metadata at the emission boundary. A metadata record
    // with only an embed/player URL is a hint, not a downloadable item.
    if (!looksMedia(abs, record.contentType) && !((record.contentType || '').toLowerCase().indexOf('video/') === 0 || (record.contentType || '').toLowerCase().indexOf('audio/') === 0)) return;
    var title = record.title ? String(record.title).slice(0, 500) : '';
    var source = record.metadataSource ? String(record.metadataSource).slice(0, 20) : 'metadata';
    var dedupe = keyFor(abs, record.kind) + '\u0000' + source + '\u0000' + title;
    if (metadataSeen[dedupe]) return;
    if (metadataSeenCount >= MAX_EMIT_PER_PAGE) return;
    metadataSeen[dedupe] = true;
    metadataSeenCount++;
    var payload = {
      url: abs, kind: record.kind, contentType: record.contentType || null,
      size: 0, via: 'metadata', metadataSource: source,
    };
    if (title) payload.title = title;
    if (record.duration) payload.duration = Number(record.duration) || 0;
    emit(payload);
  }

  // ---- page resource timing -------------------------------------------------
  // Players that feed a MediaSource never put the manifest in the DOM, and the
  // extension cannot see requests to hosts the user has not granted. The page's
  // own resource timing has both: it lists every subresource URL, cross-origin
  // included, and reading it touches nothing.
  var seenResources = Object.create(null);
  var RESOURCE_REPORT_MAX = 12;

  function mediaFromResourceUrl(url) {
    var raw = String(url || '');
    if (!/^https?:/i.test(raw)) return null;
    // A page fetches hundreds of segments; only the manifest (or a whole file)
    // is worth reporting. .ts/.m4s already classify as segments, but audio
    // chunks (.aac) would otherwise look like media.
    try { if (typeof L.isSegmentUrl === 'function' && L.isSegmentUrl(raw)) return null; } catch (_) { /* ignore */ }
    if (/\.mpd(?:$|[?#])/i.test(raw)) return 'dash';
    if (/\.m3u8(?:$|[?#])/i.test(raw)) return 'hls';
    var classified = null;
    try { classified = L.classifyUrl(raw); } catch (_) { classified = null; }
    if (classified && (classified.kind === 'video' || classified.kind === 'audio')) return classified.kind;
    return null;
  }

  function reportResourceUrl(url, pageTitle) {
    if (Object.keys(seenResources).length >= RESOURCE_REPORT_MAX) return;
    if (seenResources[url]) return;
    var kind = mediaFromResourceUrl(url);
    if (!kind) return;
    seenResources[url] = true;
    emit({
      source: MARKER,
      type: 'media',
      url: url,
      kind: kind,
      via: 'page-data',
      pageUrl: location.href,
      title: pageTitle || document.title || null,
    });
  }

  function scanResourceTiming() {
    var entries = null;
    try {
      if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') return;
      entries = performance.getEntriesByType('resource');
    } catch (_) { return; }
    for (var i = 0; i < (entries || []).length; i++) {
      try { reportResourceUrl(entries[i].name, null); } catch (_) { /* ignore */ }
    }
  }

  function watchResourceTiming() {
    try {
      if (typeof PerformanceObserver !== 'function') return;
      var observer = new PerformanceObserver(function (list) {
        var items = list.getEntries ? list.getEntries() : [];
        for (var i = 0; i < items.length; i++) {
          try { reportResourceUrl(items[i].name, null); } catch (_) { /* ignore */ }
        }
      });
      // buffered: entries recorded before the observer existed still arrive.
      observer.observe({ type: 'resource', buffered: true });
    } catch (_) { /* older engine: the interval scan still runs */ }
  }

  function scanPageMetadata(force) {
    if (!PM || typeof PM.collect !== 'function') {
      scanVideoEls(force, '', null);
      return;
    }
    var data;
    try { data = PM.collect(document, location.href) || {}; } catch (_) { data = {}; }
    var pageTitle = data.pageTitle ? String(data.pageTitle).slice(0, 500) : '';
    var titleMap = Object.create(null);
    var all = (data.candidates || []).concat(data.hints || []);
    for (var i = 0; i < all.length; i++) rememberMetadataTitle(titleMap, all[i]);
    var observed = scanVideoEls(force, pageTitle, titleMap);
    var observedKeys = Object.create(null);
    for (var j = 0; j < observed.length; j++) observedKeys[observed[j].key] = true;
    var candidates = data.candidates || [];
    for (var k = 0; k < candidates.length; k++) {
      var record = candidates[k];
      if (!record || record.via === 'element' || record.metadataSource === 'element') continue;
      if (observedKeys[keyFor(record.url, record.kind)]) continue;
      emitMetadata(record);
    }
  }

  try {
    // Do not wait two seconds for the first pass after injection/navigation.
    scanPageMetadata(false);
    scanResourceTiming();
    watchResourceTiming();
    setTimeout(scanResourceTiming, 1500);
    var iv = setInterval(function () { scanPageMetadata(false); scanResourceTiming(); }, 2000);
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
      // Explicit/manual scans must re-report the current source even if the
      // same element was already seen. This makes Clear -> Rescan work and
      // refreshes reused elements after SPA navigation.
      if (d.type === 'scan') scanPageMetadata(true);
    } catch (e) { /* ignore */ }
  });
})();
