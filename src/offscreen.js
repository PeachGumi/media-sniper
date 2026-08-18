/* Offscreen document: creates blob URLs on behalf of the service worker
 * (URL.createObjectURL is not available in MV3 service workers). */
'use strict';

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'ms-offscreen-blob') return false;
  try {
    const blob = new Blob(msg.parts || [], { type: msg.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    sendResponse({ url: url, size: blob.size });
  } catch (e) {
    sendResponse({ error: String(e && e.message || e) });
  }
  return false;
});
