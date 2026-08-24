'use strict';
const fs = require('fs');
const vm = require('vm');
const { eq, ok, report } = require('./harness.js');

class FakeBlob {
  constructor(parts) {
    let total = 0;
    for (const p of (parts || [])) {
      if (p && typeof p.size === 'number') total += p.size;
      else if (p && typeof p.byteLength === 'number') total += p.byteLength;
      else if (typeof p === 'string') total += Buffer.byteLength(p);
    }
    this.size = total;
  }
}

let nextUrl = 1;
const revoked = [];
let pagehide = null;
let cancelled = false;
let responseLength = '10';
let rawRuntimeListener = null;
const fakeChrome = {
  runtime: {
    id: 'extid',
    onMessage: {
      addListener: function (fn) { rawRuntimeListener = fn; },
    },
  },
};
const context = vm.createContext({
  console,
  chrome: fakeChrome,
  Blob: FakeBlob,
  ArrayBuffer,
  Uint8Array,
  TextEncoder,
  RangeError,
  Map,
  URL: {
    createObjectURL: function () { return 'blob:fake/' + (nextUrl++); },
    revokeObjectURL: function (url) { revoked.push(url); },
  },
  fetch: async function () {
    return {
      headers: { get: function (name) { return name === 'content-length' ? responseLength : null; } },
      body: { cancel: async function () { cancelled = true; } },
    };
  },
  setTimeout: function () { return 123; },
  clearTimeout: function () {},
  addEventListener: function (type, fn) { if (type === 'pagehide') pagehide = fn; },
  module: { exports: {} },
  exports: {},
});

const source = fs.readFileSync(require.resolve('../src/offscreen-policy.js'), 'utf8');
vm.runInContext(source, context, { filename: 'offscreen-policy.js' });
const policy = context.MediaSniperMemoryPolicy;
ok(!!policy, 'memory policy installed');
eq(policy.MAX_OUTPUT_BYTES, 768 * 1024 * 1024, 'output limit fixed');
eq(policy.MAX_SINGLE_RESPONSE_BYTES, 512 * 1024 * 1024, 'single response limit fixed');

{
  const huge = new FakeBlob([]);
  huge.size = policy.MAX_OUTPUT_BYTES + 1;
  let threw = false;
  try { new context.Blob([huge]); } catch (e) { threw = e && e.name === 'RangeError'; }
  ok(threw, 'oversize Blob rejected before construction');
}

{
  const small = new context.Blob([new Uint8Array(16)]);
  const url = context.URL.createObjectURL(small);
  eq(policy.ownedUrlCount(), 1, 'created Blob URL is tracked');
  context.URL.revokeObjectURL(url);
  eq(policy.ownedUrlCount(), 0, 'explicit revoke releases ownership');
  eq(revoked.includes(url), true, 'native revoke invoked');
}

// Offscreen commands must come from this extension without a tab (service
// worker/extension document), never directly from a content-script tab.
{
  eq(policy.isTrustedOffscreenSender({ id: 'extid' }, 'extid'), true, 'own worker sender trusted');
  eq(policy.isTrustedOffscreenSender({ id: 'extid', tab: { id: 3 } }, 'extid'), false, 'content-script sender rejected');
  eq(policy.isTrustedOffscreenSender({ id: 'other' }, 'extid'), false, 'other extension rejected');

  let handled = 0;
  context.chrome.runtime.onMessage.addListener(function () { handled++; return false; });
  let rejection = null;
  rawRuntimeListener(
    { type: 'ms-offscreen-fetch-blob', url: 'https://example.test/x' },
    { id: 'extid', tab: { id: 9 } },
    function (r) { rejection = r; }
  );
  eq(handled, 0, 'rejected offscreen command never reaches handler');
  ok(rejection && /rejected/.test(rejection.error), 'rejected offscreen sender receives error');

  rawRuntimeListener(
    { type: 'ms-offscreen-fetch-blob', url: 'https://example.test/x' },
    { id: 'extid' },
    function () {}
  );
  eq(handled, 1, 'trusted worker command reaches offscreen handler');
}

(async function () {
  responseLength = String(policy.MAX_SINGLE_RESPONSE_BYTES + 1);
  let threw = false;
  try { await context.fetch('https://example.test/huge'); } catch (e) { threw = e && e.name === 'RangeError'; }
  ok(threw, 'oversize response rejected from Content-Length');
  eq(cancelled, true, 'oversize response body cancelled');

  responseLength = '100';
  const res = await context.fetch('https://example.test/small');
  ok(!!res, 'normal response preserved');

  const a = context.URL.createObjectURL(new context.Blob([new Uint8Array(1)]));
  const b = context.URL.createObjectURL(new context.Blob([new Uint8Array(1)]));
  eq(policy.ownedUrlCount(), 2, 'pagehide setup owns URLs');
  pagehide();
  eq(policy.ownedUrlCount(), 0, 'pagehide revokes all owned URLs');
  ok(revoked.includes(a) && revoked.includes(b), 'pagehide native revoke called');

  report('offscreen-policy');
})().catch(function (e) {
  console.error(e);
  process.exitCode = 1;
});
