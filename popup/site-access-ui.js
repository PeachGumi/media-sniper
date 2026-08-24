'use strict';

(function () {
  const ALL = ['http://*/*', 'https://*/*'];
  let activeTab = null;

  function t(key, subs) {
    return globalThis.MediaSniperI18n ? MediaSniperI18n.t(key, subs) : (chrome.i18n.getMessage(key, subs) || key);
  }

  function status(text, isErr) {
    const el = document.getElementById('accessStatus');
    if (!el) return;
    el.textContent = text || '';
    el.className = isErr ? 'err' : '';
  }

  function httpUrl(url) {
    try {
      const u = new URL(url || '');
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u : null;
    } catch (_) { return null; }
  }

  function originPattern(url) {
    const u = httpUrl(url);
    return u ? u.origin + '/*' : null;
  }

  function isYoutube(url) {
    const u = httpUrl(url);
    return !!u && /^(www\.|m\.|music\.)?youtube\.com$/i.test(u.hostname);
  }

  async function injectTab(tab) {
    if (!tab || tab.id == null || !httpUrl(tab.url)) return false;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['src/logic.js', 'src/content.js'],
      });
      if (isYoutube(tab.url)) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [0] },
          files: ['src/youtube.js'],
          world: 'MAIN',
        });
      }
      return true;
    } catch (_) {
      // Chrome internal pages and frames outside the temporary activeTab grant
      // are intentionally inaccessible. The main frame can still be useful.
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [0] },
          files: ['src/logic.js', 'src/content.js'],
        });
        return true;
      } catch (_) { return false; }
    }
  }

  async function containsAll() {
    return chrome.permissions.contains({ origins: ALL });
  }

  async function containsSite(pattern) {
    return !!pattern && chrome.permissions.contains({ origins: [pattern] });
  }

  async function refresh() {
    const pattern = activeTab && originPattern(activeTab.url);
    const siteBtn = document.getElementById('accessSite');
    const allBtn = document.getElementById('accessAll');
    const clickBtn = document.getElementById('accessClick');
    if (!siteBtn || !allBtn || !clickBtn) return;

    if (!pattern) {
      siteBtn.disabled = true;
      allBtn.disabled = true;
      status(t('accessUnsupported'), true);
      return;
    }

    const all = await containsAll();
    const site = all || await containsSite(pattern);
    siteBtn.disabled = site;
    allBtn.disabled = all;
    clickBtn.disabled = !(await chrome.permissions.getAll()).origins.length;
    status(all ? t('accessModeAll') : (site ? t('accessModeSite') : t('accessModeClick')));
  }

  async function currentTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  }

  async function start() {
    activeTab = await currentTab();
    if (activeTab && httpUrl(activeTab.url)) {
      // Opening the extension action is the user gesture that grants activeTab.
      // Detection therefore works for this tab without persistent site access.
      await injectTab(activeTab);
    }
    await refresh();
  }

  document.getElementById('accessSite').addEventListener('click', async function () {
    const pattern = activeTab && originPattern(activeTab.url);
    if (!pattern) return;
    try {
      const granted = await chrome.permissions.request({ origins: [pattern] });
      if (!granted) { status(t('accessDenied'), true); return; }
      await injectTab(activeTab);
      status(t('accessGrantedSite'));
      await refresh();
    } catch (e) { status(t('accessFailed'), true); }
  });

  document.getElementById('accessAll').addEventListener('click', async function () {
    try {
      const granted = await chrome.permissions.request({ origins: ALL });
      if (!granted) { status(t('accessDenied'), true); return; }
      await injectTab(activeTab);
      status(t('accessGrantedAll'));
      await refresh();
    } catch (e) { status(t('accessFailed'), true); }
  });

  document.getElementById('accessClick').addEventListener('click', async function () {
    try {
      const all = await chrome.permissions.getAll();
      const origins = all.origins || [];
      if (origins.length) await chrome.permissions.remove({ origins });
      status(t('accessCleared'));
      await refresh();
    } catch (e) { status(t('accessFailed'), true); }
  });

  document.addEventListener('DOMContentLoaded', function () { start().catch(function () {}); });
  if (document.readyState !== 'loading') start().catch(function () {});

  globalThis.MediaSniperAccessUI = { originPattern, isYoutube };
})();
