/* First-install product disclosure. */
'use strict';

chrome.runtime.onInstalled.addListener(function (details) {
  if (!details || details.reason !== 'install') return;
  const url = chrome.runtime.getURL('popup/onboarding.html');
  chrome.tabs.create({ url: url }).catch(function () { /* non-fatal */ });
});
