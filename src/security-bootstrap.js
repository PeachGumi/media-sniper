/* Bootstrap helpers that run before security-guard.js.
 *
 * Chrome may attach sender.tab to messages from extension pages opened in a
 * browser tab (for example options_ui with open_in_tab). The trust decision
 * must be based on the sender's extension id + chrome-extension:// origin, not
 * on the presence/absence of sender.tab.
 */
'use strict';

const MediaSniperSecurityBootstrap = (function () {
  function isOwnExtensionPage(sender, extensionId) {
    if (!sender || sender.id !== extensionId) return false;
    const url = String(sender.url || sender.documentUrl || '');
    return url.startsWith('chrome-extension://' + extensionId + '/');
  }

  function normalizeSender(sender, extensionId) {
    if (!isOwnExtensionPage(sender, extensionId) || !sender.tab) return sender;
    const copy = Object.assign({}, sender);
    delete copy.tab;
    return copy;
  }

  function install(chromeObj) {
    const c = chromeObj || chrome;
    const event = c.runtime && c.runtime.onMessage;
    if (!event || typeof event.addListener !== 'function') return;
    const rawAdd = event.addListener.bind(event);
    event.addListener = function (fn) {
      return rawAdd(function (msg, sender, sendResponse) {
        return fn(msg, normalizeSender(sender, c.runtime.id), sendResponse);
      });
    };
  }

  return { isOwnExtensionPage, normalizeSender, install };
})();

globalThis.MediaSniperSecurityBootstrap = MediaSniperSecurityBootstrap;
if (typeof module !== 'undefined' && module.exports) module.exports = MediaSniperSecurityBootstrap;
