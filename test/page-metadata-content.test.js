'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { eq, ok, report } = require('./harness.js');

const contentSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'content.js'), 'utf8');
const injected = [];
const messages = [];
const windowHandlers = [];
const timers = [];
const chrome = {
  runtime: {
    getURL: function (file) { return 'chrome-extension://extid/' + file; },
    lastError: null,
    sendMessage: function (message, callback) {
      messages.push(message);
      if (callback) callback({ ok: true });
    },
    onMessage: { addListener: function () {} },
  },
};
const document = {
  head: { appendChild: function (script) { injected.push(script.src); } },
  documentElement: { appendChild: function (script) { injected.push(script.src); } },
  createElement: function () { return { async: true, src: '', onload: null, remove: function () {} }; },
  addEventListener: function () {},
};
const ctx = {
  console,
  chrome,
  document,
  location: { href: 'https://site.test/watch/1', hostname: 'site.test' },
  setTimeout: function (fn) { timers.push(fn); return timers.length; },
  setInterval: function () { return 1; },
  clearInterval: function () {},
  window: null,
  globalThis: null,
};
ctx.window = ctx;
ctx.top = ctx;
ctx.globalThis = ctx;
ctx.addEventListener = function (type, fn) { if (type === 'message') windowHandlers.push(fn); };
vm.createContext(ctx);
vm.runInContext(contentSrc, ctx, { filename: 'content.js' });

eq(injected, [
  'chrome-extension://extid/src/logic.js',
  'chrome-extension://extid/src/page-metadata.js',
  'chrome-extension://extid/src/bridge.js',
], 'content injects logic, metadata adapter, then bridge');

const mediaHandler = windowHandlers[0];
ok(typeof mediaHandler === 'function', 'content installs bridge relay');
mediaHandler({ data: {
  source: 'media-sniper-bridge', type: 'media',
  url: 'https://cdn.test/clip.mp4', kind: 'video', contentType: 'video/mp4',
  size: 0, via: 'metadata', title: 'Metadata title', metadataSource: 'og', vimeoId: '123456789',
} });
const flush = timers[timers.length - 1];
ok(typeof flush === 'function', 'content queues bridge reports');
flush();
const reportMessage = messages.find((m) => m.type === 'ms-report');
ok(!!reportMessage, 'content forwards metadata report to background');
eq(reportMessage && reportMessage.items[0], {
  url: 'https://cdn.test/clip.mp4', kind: 'video', contentType: 'video/mp4',
  size: 0, via: 'metadata', pageUrl: undefined, duration: undefined,
  title: 'Metadata title', metadataSource: 'og', vimeoId: '123456789',
}, 'content keeps compact metadata fields');
ok(!reportMessage || reportMessage.items[0].raw === undefined, 'content does not forward raw JSON');

report('page-metadata-content');
