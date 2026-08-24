'use strict';
const { eq, ok, report } = require('./harness.js');
const B = require('../src/security-bootstrap.js');

const extTabSender = {
  id: 'extid',
  url: 'chrome-extension://extid/popup/options.html',
  tab: { id: 42, url: 'chrome-extension://extid/popup/options.html' },
};
const normalized = B.normalizeSender(extTabSender, 'extid');
ok(normalized !== extTabSender, 'trusted extension sender is copied before normalization');
eq(normalized.id, 'extid', 'extension id preserved');
eq(normalized.url, extTabSender.url, 'extension URL preserved');
eq(normalized.tab, undefined, 'sender.tab removed only for own extension page');

const contentSender = {
  id: 'extid',
  url: 'https://site.example/page',
  tab: { id: 7, url: 'https://site.example/page' },
};
eq(B.normalizeSender(contentSender, 'extid'), contentSender, 'content-script sender is not rewritten');

const otherExtension = {
  id: 'other',
  url: 'chrome-extension://other/options.html',
  tab: { id: 8 },
};
eq(B.normalizeSender(otherExtension, 'extid'), otherExtension, 'other extension sender is not rewritten');

// Integration: the installed wrapper feeds normalized own-extension senders
// to subsequently registered listeners while leaving content senders intact.
{
  let registered = null;
  const fakeChrome = {
    runtime: {
      id: 'extid',
      onMessage: {
        addListener: function (fn) { registered = fn; },
      },
    },
  };
  B.install(fakeChrome);
  let seen = null;
  fakeChrome.runtime.onMessage.addListener(function (_msg, sender) { seen = sender; });
  registered({}, extTabSender, function () {});
  eq(seen.tab, undefined, 'installed wrapper normalizes own extension page');
  registered({}, contentSender, function () {});
  eq(seen.tab.id, 7, 'installed wrapper preserves content-script tab');
}

report('security-bootstrap');
