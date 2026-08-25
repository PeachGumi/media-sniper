/* Navigation refresh policy.
 *
 * Loaded after background.js in the same classic-script service-worker realm.
 * Page metadata is the trusted, sender-bound signal that the top-level content
 * script has moved to a new document/SPA route. When that happens, stale media
 * from the previous page must not remain attached to the tab.
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
    return true;
  }

  const api = { parseUrl, routeHash, shouldResetPage, installRuntime };
  globalThis.MediaSniperNavigationRefresh = api;
  installRuntime();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
