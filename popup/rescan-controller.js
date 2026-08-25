'use strict';

const MediaSniperRescanController = (function () {
  async function scanWithPolling(options) {
    const before = Number(options.beforeCount) || 0;
    const maxPolls = Math.max(1, Number(options.maxPolls) || 6);
    const intervalMs = Math.max(0, Number(options.intervalMs) || 500);
    const wait = options.wait || function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); };

    await options.sendScan();
    let latest = before;
    for (let i = 0; i < maxPolls; i++) {
      await wait(intervalMs);
      latest = Number(await options.refresh()) || 0;
      if (latest > before) break;
    }
    return latest;
  }

  function installBrowserController() {
    if (typeof document === 'undefined' || typeof chrome === 'undefined') return;
    const btn = document.getElementById('rescan');
    if (!btn || btn.__mediaSniperRescanInstalled) return;
    btn.__mediaSniperRescanInstalled = true;
    let generation = 0;

    function scanMessage() {
      return new Promise(function (resolve, reject) {
        if (typeof tabId === 'undefined' || tabId == null) {
          reject(new Error('No active tab'));
          return;
        }
        chrome.tabs.sendMessage(tabId, { type: 'ms-scan' }, function (resp) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || 'scan failed'));
            return;
          }
          if (!resp || resp.ok === false) {
            reject(new Error((resp && resp.error) || 'scan failed'));
            return;
          }
          resolve(resp);
        });
      });
    }

    function refreshItems() {
      return new Promise(function (resolve, reject) {
        chrome.runtime.sendMessage({ type: 'ms-get-items', tabId: tabId }, function (resp) {
          if (chrome.runtime.lastError || !resp) {
            reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : 'background unavailable'));
            return;
          }
          items = resp.items || [];
          render();
          resolve(items.length);
        });
      });
    }

    btn.addEventListener('click', function (ev) {
      // popup.js still contains the legacy handler; intercept at the target's
      // capture phase so only this deterministic implementation runs.
      ev.stopImmediatePropagation();
      if (typeof tabId === 'undefined' || tabId == null || btn.disabled) return;
      const mine = ++generation;
      const before = items.length;
      btn.disabled = true;
      setStatus(t('scanning'));

      scanWithPolling({ beforeCount: before, sendScan: scanMessage, refresh: refreshItems })
        .then(function () {
          if (mine !== generation) return;
          btn.disabled = false;
          // Count is already rendered next to the title; an empty status line
          // clearly signals that the finite scan has completed.
          setStatus('');
        })
        .catch(function (err) {
          if (mine !== generation) return;
          btn.disabled = false;
          setStatus(t('errorPrefix', [String(err && err.message || err)]), true);
        });
    }, true);
  }

  const api = { scanWithPolling, installBrowserController };
  if (typeof globalThis !== 'undefined') globalThis.MediaSniperRescanController = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  installBrowserController();
  return api;
})();
