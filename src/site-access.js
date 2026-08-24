/* Persistent host-access manager.
 *
 * The extension starts without permanent site access. Opening the action grants
 * activeTab temporarily; popup/site-access-ui.js injects detection into that tab.
 * Users can additionally grant one origin or all HTTP(S) origins. Persistent
 * grants are mirrored into dynamic content-script registrations so blob/media
 * detection starts at document_start on those sites without requiring a popup.
 */
'use strict';

(function () {
  const GENERIC_ID = 'media-sniper-sites';
  const YOUTUBE_ID = 'media-sniper-youtube';
  const ALL_HTTP = 'http://*/*';
  const ALL_HTTPS = 'https://*/*';

  function usableOriginPattern(raw) {
    try {
      if (raw === ALL_HTTP || raw === ALL_HTTPS) return raw;
      const u = new URL(raw.replace(/\*$/, ''));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.protocol + '//' + u.host + '/*';
    } catch (_) {
      const m = String(raw || '').match(/^(https?):\/\/([^/]+)\/\*$/);
      return m ? m[1] + '://' + m[2] + '/*' : null;
    }
  }

  function uniquePatterns(origins) {
    const out = [];
    const seen = new Set();
    for (const raw of origins || []) {
      const p = usableOriginPattern(raw);
      if (p && !seen.has(p)) { seen.add(p); out.push(p); }
    }
    return out;
  }

  function youtubeCovered(patterns) {
    return patterns.some(function (p) {
      if (p === ALL_HTTP || p === ALL_HTTPS) return true;
      try {
        const h = new URL(p.replace('*', '')).hostname.toLowerCase();
        return h === 'youtube.com' || h.endsWith('.youtube.com');
      } catch (_) { return /youtube\.com/i.test(p); }
    });
  }

  async function unregisterKnown() {
    try {
      const current = await chrome.scripting.getRegisteredContentScripts({ ids: [GENERIC_ID, YOUTUBE_ID] });
      if (current.length) await chrome.scripting.unregisterContentScripts({ ids: current.map(function (x) { return x.id; }) });
    } catch (_) {
      // Chrome versions with no matching registrations can throw depending on
      // implementation; reconciliation is still safe to continue.
      try { await chrome.scripting.unregisterContentScripts({ ids: [GENERIC_ID, YOUTUBE_ID] }); } catch (_) {}
    }
  }

  async function sync() {
    const granted = await chrome.permissions.getAll();
    const patterns = uniquePatterns(granted.origins || []);
    await unregisterKnown();
    if (!patterns.length) return { origins: [] };

    await chrome.scripting.registerContentScripts([{
      id: GENERIC_ID,
      matches: patterns,
      js: ['src/logic.js', 'src/content.js'],
      runAt: 'document_start',
      allFrames: true,
      persistAcrossSessions: true,
    }]);

    if (youtubeCovered(patterns)) {
      await chrome.scripting.registerContentScripts([{
        id: YOUTUBE_ID,
        matches: ['*://*.youtube.com/*'],
        js: ['src/youtube.js'],
        runAt: 'document_start',
        allFrames: false,
        world: 'MAIN',
        persistAcrossSessions: true,
      }]);
    }
    return { origins: patterns };
  }

  chrome.runtime.onInstalled.addListener(function () { sync().catch(function () {}); });
  chrome.runtime.onStartup.addListener(function () { sync().catch(function () {}); });
  chrome.permissions.onAdded.addListener(function () { sync().catch(function () {}); });
  chrome.permissions.onRemoved.addListener(function () { sync().catch(function () {}); });

  // Register synchronously reachable startup work for an already-running SW.
  sync().catch(function () {});

  globalThis.MediaSniperSiteAccess = {
    GENERIC_ID,
    YOUTUBE_ID,
    ALL_HTTP,
    ALL_HTTPS,
    usableOriginPattern,
    uniquePatterns,
    youtubeCovered,
    sync,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { usableOriginPattern, uniquePatterns, youtubeCovered, ALL_HTTP, ALL_HTTPS };
  }
})();
