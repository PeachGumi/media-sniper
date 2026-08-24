'use strict';

const continueBtn = document.getElementById('continue');
const settingsBtn = document.getElementById('settings');

continueBtn.addEventListener('click', function () {
  chrome.storage.local.set({ disclosureSeenVersion: chrome.runtime.getManifest().version }).then(function () {
    return chrome.tabs.getCurrent();
  }).then(function (tab) {
    if (tab && tab.id != null) return chrome.tabs.remove(tab.id);
    window.close();
  }).catch(function () {
    window.close();
  });
});

settingsBtn.addEventListener('click', function () {
  chrome.runtime.openOptionsPage();
});
