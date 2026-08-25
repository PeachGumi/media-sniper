/* Navigation refresh policy.
 *
 * Loaded after background.js in the same classic-script service-worker realm.
 * Normal document metadata continues through the hardened ms-page-meta path.
 * SPA route changes use a separate, narrowly validated signal because Chrome's
 * MessageSender.url can remain the original document URL after pushState().
 */
'use strict';

(function () {
  function parseUrl(raw) {
    try {
      const u = new URL(String(raw || ''));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u;
    } catch (_) { return null; }
  }

  function routeHash(hash) {
    const h = String(hash || '');
    return /^#!?\//.test(h) || /^#\?/.test(h);
  }

  function shouldResetPage(previousUrl, nextUrl) {
    const a = parseUrl(previousUrl);
    const b = parseUrl(nextUrl);
    if (!a || !b) return false;
    if (a.origin !== b.origin || a.pathname !== b.pathname || a.search !== b.search) return true;
    // Preserve media for ordinary in-page anchors (#chapter-2), but treat
    // hash-router transitions (#/watch/2, #!/route, #?view=...) as navigation.
    if (a.hash !== b.hash && (routeHash(a.hash) || routeHash(b.hash))) return true;
    return false;
  }

  function sameOriginNavigationUrl(claimedUrl, senderUrl) {
    const claimed = parseUrl(claimedUrl);
    const sender = parseUrl(senderUrl);
    if (!claimed || !sender || claimed.origin !== sender.origin) return null;
    return claimed.href;
  }

  function installRuntime() {
    if (typeof state === 'undefined' || !state.pageMeta || !state.itemsByTab) return false;
    if (state.pageMeta.__mediaSniperNavigationWrapped) return true;

    const rawSet = state.pageMeta.set.bind(state.pageMeta);
    state.pageMeta.set = function (tabId, meta) {
      const previous = state.pageMeta.get(tabId);
      let previousUrl = previous && previous.url;
      if (!previousUrl) {
        const existing = state.itemsByTab.get(tabId) || [];
        const withPage = existing.find(function (item) { return item && item.pageUrl; });
        previousUrl = withPage && withPage.pageUrl;
      }
      const nextUrl = meta && meta.url;
      const reset = shouldResetPage(previousUrl, nextUrl);
      const result = rawSet(tabId, meta);
      if (reset) {
        state.itemsByTab.delete(tabId);
        try { if (typeof persistItems === 'function') persistItems(); } catch (_) {}
        try { if (typeof updateBadge === 'function') updateBadge(tabId); } catch (_) {}
      }
      return result;
    };
    Object.defineProperty(state.pageMeta, '__mediaSniperNavigationWrapped', {
      value: true,
      enumerable: false,
      configurable: false,
    });

    // Do not loosen the general content-message security boundary. This one
    // signal is accepted only from our own top-frame content script, and only
    // when its claimed SPA URL stays within MessageSender's authenticated
    // origin. A page cannot use it to claim another site's URL.
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        if (!msg || msg.type !== 'ms-navigation') return false;
        const ownId = chrome.runtime.id;
        const senderUrl = String((sender && (sender.url || sender.documentUrl)) || (sender && sender.tab && sender.tab.url) || '');
        const nextUrl = sameOriginNavigationUrl(msg.url, senderUrl);
        const topFrame = !sender || sender.frameId == null || sender.frameId === 0;
        if (!sender || sender.id !== ownId || !sender.tab || !topFrame || !nextUrl) {
          try { sendResponse({ ok: false, error: 'navigation sender rejected' }); } catch (_) {}
          return false;
        }
        state.pageMeta.set(sender.tab.id, {
          title: String(msg.title || '').slice(0, 500) || null,
          url: nextUrl,
        });
        try { sendResponse({ ok: true }); } catch (_) {}
        return false;
      });
    }
    return true;
  }

  const api = { parseUrl, routeHash, shouldResetPage, sameOriginNavigationUrl, installRuntime };
  globalThis.MediaSniperNavigationRefresh = api;
  installRuntime();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
