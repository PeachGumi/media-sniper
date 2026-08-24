'use strict';

(function () {
  const el = document.getElementById('version');
  if (!el) return;
  try {
    const version = chrome.runtime.getManifest().version;
    el.textContent = version ? 'v' + version : '';
  } catch (e) {
    el.textContent = '';
  }
})();
