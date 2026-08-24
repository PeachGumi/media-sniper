/* First-install product disclosure. */
'use strict';

function openInstallDisclosure(details, chromeObj) {
  const c = chromeObj || chrome;
  if (!details || details.reason !== 'install') return false;
  const url = c.runtime.getURL('popup/onboarding.html');
  try {
    const result = c.tabs.create({ url: url });
    if (result && typeof result.catch === 'function') result.catch(function () { /* non-fatal */ });
  } catch (e) { /* non-fatal */ }
  return true;
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(function (details) {
    openInstallDisclosure(details, chrome);
  });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { openInstallDisclosure };
