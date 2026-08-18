/* Media Sniper - content script (isolated world).
 * Injects the page-world bridge, relays bridge -> background, and
 * executes HLS pipeline requests from the background.
 */
'use strict';

(function () {
  const MARKER = 'media-sniper-bridge';
  const CONTENT_MARK = 'media-sniper-content';

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

  // ---- YouTube adapter handshake --------------------------------------------
  // On youtube.com the MAIN-world adapter may have posted formats before our
  // message listener was ready; ask it to re-send. Repeat briefly to cover
  // late initial-player-response delivery.
  (function () {
    let host = '';
    try { host = location.hostname; } catch (e) { /* ignore */ }
    if (!/^(www\.|m\.|music\.)?youtube\.com$/.test(host)) return;
    let count = 0;
    const iv = setInterval(function () {
      try { window.postMessage({ source: 'media-sniper-content', type: 'yt-request' }, '*'); } catch (e) { /* ignore */ }
      if (++count >= 30) clearInterval(iv);
    }, 2000);
    try { window.postMessage({ source: 'media-sniper-content', type: 'yt-request' }, '*'); } catch (e) { /* ignore */ }
  })();

  // ---- page metadata (title for naming) -------------------------------------
  function sendMeta() {
    try {
      chrome.runtime.sendMessage({ type: 'ms-page-meta', title: document.title, url: location.href }, function () {
        void chrome.runtime.lastError;
      });
    } catch (e) { /* ignore */ }
  }
  sendMeta();
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) sendMeta();
  });

  const pending = [];
  let flushTimer = null;

  function flush() {
    flushTimer = null;
    if (!pending.length) return;
    const items = pending.splice(0);
    try {
      chrome.runtime.sendMessage({ type: 'ms-report', items: items }, function () {
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
      window.postMessage({ source: CONTENT_MARK, type: 'scan' }, '*');
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
})();
