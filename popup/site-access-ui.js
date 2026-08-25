'use strict';

(function () {
  const ALL = ['http://*/*', 'https://*/*'];
  let activeTab = null;
  let started = false;

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
    if (!u) return null;
    // Chrome match patterns are host based, not port based. `hostname` also
    // avoids accidentally generating an invalid optional-permission pattern
    // for localhost/dev servers using explicit ports.
    return u.protocol + '//' + u.hostname + '/*';
  }

  function isYoutube(url) {
    const u = httpUrl(url);
    return !!u && /^(www\.|m\.|music\.)?youtube\.com$/i.test(u.hostname);
  }

  async function injectTab(tab) {
    if (!tab || tab.id == null || !httpUrl(tab.url)) return false;
    let injected = false;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['src/logic.js', 'src/content.js'],
      });
      injected = true;
    } catch (_) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [0] },
          files: ['src/logic.js', 'src/content.js'],
        });
        injected = true;
      } catch (_) {}
    }

    if (injected && isYoutube(tab.url)) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [0] },
          files: ['src/youtube.js'],
          world: 'MAIN',
        });
      } catch (_) {}
    }
    return injected;
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

    const all = await containsAll();
    const permissions = await chrome.permissions.getAll();
    const origins = permissions.origins || [];

    // Site-specific access needs an HTTP(S) tab, but global opt-in/revocation
    // does not. Keeping those controls available also lets users remove an
    // existing broad grant while they happen to be viewing chrome://, about:,
    // or another unsupported page.
    if (!pattern) {
      siteBtn.disabled = true;
      allBtn.disabled = all;
      clickBtn.disabled = !origins.length;
      status(all ? t('accessModeAll') : t('accessUnsupported'), !all);
      return;
    }

    const site = all || await containsSite(pattern);
    siteBtn.disabled = site;
    allBtn.disabled = all;
    clickBtn.disabled = !origins.length;
    status(all ? t('accessModeAll') : (site ? t('accessModeSite') : t('accessModeClick')));
  }

  async function currentTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  }

  function notifyReady(injected) {
    try {
      document.dispatchEvent(new CustomEvent('media-sniper-access-ready', {
        detail: { injected: !!injected, tabId: activeTab && activeTab.id },
      }));
    } catch (_) {}
  }

  async function start() {
    if (started) return;
    started = true;
    activeTab = await currentTab();
    let injected = false;
    if (activeTab && httpUrl(activeTab.url)) injected = await injectTab(activeTab);
    await refresh();
    notifyReady(injected);
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
      notifyReady(true);
    } catch (e) { status(t('accessFailed'), true); }
  });

  document.getElementById('accessAll').addEventListener('click', async function () {
    try {
      const granted = await chrome.permissions.request({ origins: ALL });
      if (!granted) { status(t('accessDenied'), true); return; }
      const injected = await injectTab(activeTab);
      status(t('accessGrantedAll'));
      await refresh();
      notifyReady(injected);
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

  globalThis.MediaSniperAccessUI = { originPattern, isYoutube, injectTab };
})();
