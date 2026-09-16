/* Media Sniper - content script (isolated world).
 * Injects the page-world bridge, relays bridge -> background, and
 * executes HLS pipeline requests from the background.
 */
'use strict';

(function () {
  // popup injection and persistent dynamic content scripts can overlap on the
  // same document. One relay/navigation watcher per frame is enough.
  if (globalThis.__mediaSniperContentInstalled) return;
  globalThis.__mediaSniperContentInstalled = true;

  const MARKER = 'media-sniper-bridge';
  const CONTENT_MARK = 'media-sniper-content';
  let topFrame = false;
  try { topFrame = window === window.top; } catch (_) { topFrame = false; }

  function injectBridge() {
    try {
      // inject logic first, then metadata adapter, then bridge (async=false keeps order)
      const files = ['src/logic.js', 'src/page-metadata.js', 'src/bridge.js'];
      for (const f of files) {
        const s = document.createElement('script');
        s.src = chrome.runtime.getURL(f);
        s.async = false;
        s.onload = function () { s.remove(); };
        (document.head || document.documentElement).appendChild(s);
      }
    } catch (e) { /* CSP blocked; detection degrades to background-only */ }
  }
  injectBridge();

  function isYoutubePage() {
    try { return /^(www\.|m\.|music\.)?youtube\.com$/.test(location.hostname); }
    catch (_) { return false; }
  }

  function requestYoutubeFormats() {
    if (!isYoutubePage()) return;
    try { window.postMessage({ source: CONTENT_MARK, type: 'yt-request' }, '*'); } catch (_) {}
  }

  function requestDomScan() {
    try { window.postMessage({ source: CONTENT_MARK, type: 'scan' }, '*'); } catch (_) {}
    requestYoutubeFormats();
  }

  // ---- YouTube adapter handshake --------------------------------------------
  // On youtube.com the MAIN-world adapter may have posted formats before our
  // message listener was ready; ask it to re-send. Repeat briefly to cover
  // late initial-player-response delivery.
  if (topFrame && isYoutubePage()) {
    let count = 0;
    const iv = setInterval(function () {
      requestYoutubeFormats();
      if (++count >= 30) clearInterval(iv);
    }, 2000);
    requestYoutubeFormats();
  }

  // ---- page metadata + SPA navigation ---------------------------------------
  // ---- thumbnails ----------------------------------------------------------
  // The reference implementation shows a thumbnail per media entry. This is the
  // clean-room equivalent: prefer a frame from the element that is actually
  // playing the item, fall back to its poster, then to the page's own social
  // image. Anything that cannot be shown (tainted canvas, no element, blocked
  // fetch) returns null and the popup keeps the type badge alone.
  const THUMB_W = 160;
  const THUMB_H = 90;
  const MAX_IMAGE_BYTES = 512 * 1024;

  function mediaElements() {
    try {
      return Array.prototype.slice.call(document.querySelectorAll('video, audio'));
    } catch (_) { return []; }
  }

  function elementUrls(el) {
    const urls = [];
    if (el.currentSrc) urls.push(el.currentSrc);
    if (el.src) urls.push(el.src);
    try {
      Array.prototype.forEach.call(el.querySelectorAll('source'), function (s) {
        if (s.src) urls.push(s.src);
      });
    } catch (_) { /* ignore */ }
    return urls;
  }

  function sameMedia(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    try {
      const ua = new URL(a, location.href);
      const ub = new URL(b, location.href);
      if (ua.origin !== ub.origin) return false;
      if (ua.pathname === ub.pathname) return true;
      // HLS/DASH items keep a manifest name while the element plays a variant.
      const an = ua.pathname.split('/').pop() || '';
      const bn = ub.pathname.split('/').pop() || '';
      return !!an && an === bn;
    } catch (_) { return false; }
  }

  function pickElement(url) {
    const list = mediaElements();
    if (!list.length) return null;
    for (const el of list) {
      for (const candidate of elementUrls(el)) if (sameMedia(candidate, url)) return el;
    }
    // No URL match: the page's main player is still the best guess for an HLS
    // or DASH manifest (the element holds a MediaSource blob URL).
    let best = null;
    for (const el of list) {
      const area = (el.videoWidth || 0) * (el.videoHeight || 0);
      const playing = el.paused === false || el.currentTime > 0 ? 1 : 0;
      const score = [playing, area, el.duration || 0].join(':');
      if (!best || score > best.score) best = { el: el, score: score };
    }
    return best ? best.el : null;
  }

  function frameFrom(el) {
    if (!el || !el.videoWidth || !el.videoHeight) return null;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = THUMB_W;
      canvas.height = THUMB_H;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const scale = Math.max(THUMB_W / el.videoWidth, THUMB_H / el.videoHeight);
      const w = el.videoWidth * scale;
      const h = el.videoHeight * scale;
      ctx.drawImage(el, (THUMB_W - w) / 2, (THUMB_H - h) / 2, w, h);
      // A cross-origin frame without CORS taints the canvas; toDataURL throws
      // SecurityError, which is exactly the "cannot show" case.
      return canvas.toDataURL('image/jpeg', 0.55);
    } catch (_) { return null; }
  }

  function metaImageUrl() {
    const selectors = [
      'meta[property="og:image:secure_url"]', 'meta[property="og:image"]',
      'meta[name="twitter:image"]', 'meta[name="twitter:image:src"]',
    ];
    for (const selector of selectors) {
      let node = null;
      try { node = document.querySelector(selector); } catch (_) { node = null; }
      const content = node && node.content ? String(node.content) : '';
      if (content) {
        try { return new URL(content, location.href).href; } catch (_) { return content; }
      }
    }
    return null;
  }

  function toDataUrl(url) {
    // Read the bytes through the page session (cookies included) and inline
    // them, so the popup is not blocked by hotlink protection or a Referer
    // policy. Oversized images stay as absolute URLs.
    return fetch(url, { credentials: 'include' }).then(function (res) {
      if (!res.ok) return null;
      const declared = Number(res.headers && res.headers.get ? res.headers.get('content-length') : NaN);
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return null;
      return res.blob();
    }).then(function (blob) {
      if (!blob || !blob.size || blob.size > MAX_IMAGE_BYTES) return null;
      return new Promise(function (resolve) {
        const reader = new FileReader();
        reader.onload = function () { resolve(typeof reader.result === 'string' ? reader.result : null); };
        reader.onerror = function () { resolve(null); };
        reader.readAsDataURL(blob);
      });
    }).catch(function () { return null; });
  }

  function thumbnailFor(url) {
    const el = pickElement(url);
    const frame = frameFrom(el);
    if (frame) return Promise.resolve({ thumb: frame, source: 'frame' });
    const poster = el && el.poster ? el.poster : null;
    const pageImage = metaImageUrl();
    const candidate = poster || pageImage;
    if (!candidate) return Promise.resolve(null);
    const source = poster ? 'poster' : 'page';
    return toDataUrl(candidate).then(function (data) {
      if (data) return { thumb: data, source: source };
      // Still useful: the popup can load the URL itself.
      return { thumb: candidate, source: source + '-url' };
    });
  }

  function sendMeta(after) {
    if (!topFrame) {
      if (after) after();
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: 'ms-page-meta', title: document.title, url: location.href }, function () {
        void chrome.runtime.lastError;
        if (after) after();
      });
    } catch (e) { if (after) after(); }
  }

  function sendNavigation(after) {
    if (!topFrame) {
      if (after) after();
      return;
    }
    try {
      // MessageSender.url can remain the original document URL after
      // history.pushState(). The background accepts this explicit URL only
      // after verifying that it has the same origin as MessageSender.
      chrome.runtime.sendMessage({ type: 'ms-navigation', title: document.title, url: location.href }, function () {
        void chrome.runtime.lastError;
        if (after) after();
      });
    } catch (e) { if (after) after(); }
  }

  if (topFrame) {
    let lastHref = String(location.href || '');
    sendMeta();

    function checkNavigation() {
      let next = '';
      try { next = String(location.href || ''); } catch (_) { return; }
      if (!next || next === lastHref) return;
      lastHref = next;
      // The background updates page identity (and clears stale items) before
      // the forced DOM scan can report media for the new SPA route.
      sendNavigation(requestDomScan);
    }

    window.addEventListener('popstate', checkNavigation, true);
    window.addEventListener('hashchange', checkNavigation, true);
    // pushState/replaceState do not reliably emit a DOM event to an isolated
    // content world. A lightweight href check covers those SPA transitions.
    setInterval(checkNavigation, 500);

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        checkNavigation();
        sendMeta();
      }
    });
  }

  const pending = [];
  let flushTimer = null;

  function flush() {
    flushTimer = null;
    if (!pending.length) return;
    const reported = pending.splice(0);
    try {
      chrome.runtime.sendMessage({ type: 'ms-report', items: reported }, function () {
        void chrome.runtime.lastError;
      });
    } catch (e) { /* ignore */ }
  }

  function queueReport(raw) {
    pending.push(raw);
    if (!flushTimer) flushTimer = setTimeout(flush, 400);
  }

  // ---- bridge -> background relay ------------------------------------------
  window.addEventListener('message', function (ev) {
    const d = ev.data;
    if (!d) return;
    if (d.source === 'media-sniper-yt' && d.type === 'yt-formats') {
      // YouTube adapter (page world) extracted the real downloadable formats
      (d.items || []).forEach(function (it) { queueReport(it); });
      return;
    }
    if (d.source !== MARKER) return;
    if (d.type === 'media') {
      queueReport({
        url: d.url, kind: d.kind, contentType: d.contentType,
        size: d.size, via: d.via, pageUrl: d.pageUrl, duration: d.duration,
        title: d.title, metadataSource: d.metadataSource, vimeoId: d.vimeoId,
      });
    } else if (d.type === 'blob-size') {
      // size arrived for a blob URL we already reported: update item
      queueReport({ url: d.url, kind: 'video', size: d.size, via: 'blob-size', pageUrl: location.href });
    }
  });

  // ---- background -> page ----------------------------------------------------
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg) return false;
    if (msg.type === 'ms-blob-size-query') {
      window.postMessage({ source: CONTENT_MARK, type: 'blob-size', url: msg.url }, '*');
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'ms-scan') {
      requestDomScan();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'ms-thumbnail') {
      thumbnailFor(msg.url).then(function (result) { sendResponse(result || {}); }, function () { sendResponse({}); });
      return true; // async response
    }
    return false;
  });
})();
