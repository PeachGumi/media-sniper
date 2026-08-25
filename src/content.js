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
      // inject logic first, then bridge (async=false keeps order)
      const files = ['src/logic.js', 'src/bridge.js'];
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
    return false;
  });
})();
