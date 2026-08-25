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

  function originPattern(raw) {
    const u = parseUrl(raw);
    return u ? (u.protocol + '//' + u.hostname + '/*') : null;
  }

  function isYoutube(raw) {
    const u = parseUrl(raw);
    return !!u && /^(www\.|m\.|music\.)?youtube\.com$/i.test(u.hostname);
  }

  async function hasPersistentAccess(raw) {
    const p = originPattern(raw);
    if (!p || typeof chrome === 'undefined' || !chrome.permissions || !chrome.permissions.contains) return false;
    try {
      if (await chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] })) return true;
      return await chrome.permissions.contains({ origins: [p] });
    } catch (_) { return false; }
  }

  async function injectAfterNavigation(tabId, rawUrl) {
    const u = parseUrl(rawUrl);
    if (!u || typeof chrome === 'undefined' || !chrome.scripting || !chrome.scripting.executeScript) return false;
    // Persistent grants already have document_start dynamic scripts. Avoid a
    // duplicate injection in that case; this path is primarily for activeTab,
    // which Chrome can retain across same-origin navigation.
    if (await hasPersistentAccess(u.href)) return true;

    try {
      // content.js does not depend on the isolated-world copy of logic.js; it
      // injects logic.js + bridge.js into MAIN itself. Injecting only content.js
      // also avoids redeclaring MediaSniperLogic if another path already ran.
      await chrome.scripting.executeScript({
        target: { tabId: tabId, allFrames: true },
        files: ['src/content.js'],
      });
    } catch (_) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tabId, frameIds: [0] },
          files: ['src/content.js'],
        });
      } catch (_) { return false; }
    }

    if (isYoutube(u.href)) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tabId, frameIds: [0] },
          files: ['src/youtube.js'],
          world: 'MAIN',
        });
      } catch (_) {}
    }
    return true;
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

    // Full document navigation destroys the old content-script context. When
    // Chrome still exposes the new URL to us (persistent host permission, or
    // activeTab retained across a same-origin navigation), clear the previous
    // page immediately and make sure a detector exists in the new document.
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onUpdated) {
      chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
        if (!changeInfo || !changeInfo.url) return;
        const next = parseUrl(changeInfo.url);
        if (!next) return;
        state.pageMeta.set(tabId, {
          title: (tab && tab.title) ? String(tab.title).slice(0, 500) : null,
          url: next.href,
        });
        injectAfterNavigation(tabId, next.href).catch(function () {});
      });
    }
    return true;
  }

  const api = {
    parseUrl,
    routeHash,
    shouldResetPage,
    sameOriginNavigationUrl,
    originPattern,
    isYoutube,
    hasPersistentAccess,
    injectAfterNavigation,
    installRuntime,
  };
  globalThis.MediaSniperNavigationRefresh = api;
  installRuntime();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
