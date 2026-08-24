'use strict';

const continueBtn = document.getElementById('continue');
const settingsBtn = document.getElementById('settings');

continueBtn.addEventListener('click', function () {
  chrome.storage.local.set({ disclosureSeenVersion: chrome.runtime.getManifest().version }).finally(function () {
    window.close();
  });
});

settingsBtn.addEventListener('click', function () {
  chrome.runtime.openOptionsPage();
});
