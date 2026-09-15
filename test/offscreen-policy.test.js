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

// OPFS/File handles are disk-backed: the file system quota governs them, not
// the in-memory budget that stops before the renderer runs out of heap.
class FakeFile extends FakeBlob {
  constructor(size) {
    super([]);
    this.size = size;
  }
}

let nextUrl = 1;
const revoked = [];
let pagehide = null;
let cancelled = false;
let responseLength = '10';
const runtimeListeners = [];
const fakeChrome = {
  runtime: {
    id: 'extid',
    onMessage: {
      addListener: function (fn) { runtimeListeners.push(fn); },
    },
  },
};
const context = vm.createContext({
  console,
  chrome: fakeChrome,
  Blob: FakeBlob,
  File: FakeFile,
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
eq(runtimeListeners.length, 1, 'policy installs explicit revoke listener');

{
  const huge = new FakeBlob([]);
  huge.size = policy.MAX_OUTPUT_BYTES + 1;
  let threw = false;
  try { new context.Blob([huge]); } catch (e) { threw = e && e.name === 'RangeError'; }
  ok(threw, 'oversize Blob rejected before construction');
}

// A large ffmpeg artifact is streamed to OPFS and handed to Downloads as a
// File, so the in-memory ceiling must not describe it as an error.
{
  const overCap = new FakeFile(policy.MAX_OUTPUT_BYTES * 3);
  let url = null;
  let threw = false;
  try { url = context.URL.createObjectURL(overCap); } catch (e) { threw = true; }
  ok(!threw && typeof url === 'string', 'disk-backed artifact above the in-memory cap gets a URL');
  eq(policy.ownsUrl(url), true, 'disk-backed artifact URL is tracked for cleanup');
  context.URL.revokeObjectURL(url);

  let blobThrew = false;
  try { new context.Blob([new FakeFile(policy.MAX_OUTPUT_BYTES * 3)]); } catch (e) { blobThrew = e && e.name === 'RangeError'; }
  ok(!blobThrew, 'a File part is not counted as resident heap bytes');

  const resident = new FakeBlob([]);
  resident.size = policy.MAX_OUTPUT_BYTES * 3;
  let inMemoryThrew = false;
  try { new context.Blob([resident]); } catch (e) { inMemoryThrew = e && e.name === 'RangeError'; }
  ok(inMemoryThrew, 'in-memory parts still hit the ceiling');

  let residentUrlThrew = false;
  try { context.URL.createObjectURL(resident); } catch (e) { residentUrlThrew = e && e.name === 'RangeError'; }
  ok(residentUrlThrew, 'in-memory Blob above the ceiling gets no URL');
}

{
  const small = new context.Blob([new Uint8Array(16)]);
  const url = context.URL.createObjectURL(small);
  eq(policy.ownedUrlCount(), 1, 'created Blob URL is tracked');
  context.URL.revokeObjectURL(url);
  eq(policy.ownedUrlCount(), 0, 'explicit local revoke releases ownership');
  eq(revoked.includes(url), true, 'native revoke invoked');
}

// Offscreen commands must come from this extension without a tab (service
// worker/extension document), never directly from a content-script tab.
{
  eq(policy.isTrustedOffscreenSender({ id: 'extid' }, 'extid'), true, 'own worker sender trusted');
  eq(policy.isTrustedOffscreenSender({ id: 'extid', tab: { id: 3 } }, 'extid'), false, 'content-script sender rejected');
  eq(policy.isTrustedOffscreenSender({ id: 'other' }, 'extid'), false, 'other extension rejected');

  let handled = 0;
  context.chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    handled++;
    if (msg && msg.type === 'ms-offscreen-ffmpeg-status') {
      sendResponse({ running: false, done: { url: msg.testUrl } });
    }
    return false;
  });
  const guardedListener = runtimeListeners[runtimeListeners.length - 1];
  let rejection = null;
  guardedListener(
    { type: 'ms-offscreen-fetch-blob', url: 'https://example.test/x' },
    { id: 'extid', tab: { id: 9 } },
    function (r) { rejection = r; }
  );
  eq(handled, 0, 'rejected offscreen command never reaches handler');
  ok(rejection && /rejected/.test(rejection.error), 'rejected offscreen sender receives error');

  guardedListener(
    { type: 'ms-offscreen-fetch-blob', url: 'https://example.test/x' },
    { id: 'extid' },
    function () {}
  );
  eq(handled, 1, 'trusted worker command reaches offscreen handler');

  const owned = context.URL.createObjectURL(new context.Blob([new Uint8Array(4)]));
  let denied = null;
  runtimeListeners[0](
    { type: 'ms-offscreen-revoke-url', url: owned },
    { id: 'extid', tab: { id: 2 } },
    function (r) { denied = r; }
  );
  ok(denied && /rejected/.test(denied.error), 'content script cannot revoke offscreen ownership');
  eq(policy.ownsUrl(owned), true, 'denied revoke leaves URL owned');

  let released = null;
  runtimeListeners[0](
    { type: 'ms-offscreen-revoke-url', url: owned },
    { id: 'extid' },
    function (r) { released = r; }
  );
  ok(released && released.ok && released.released, 'trusted worker explicitly releases offscreen URL');
  eq(policy.ownsUrl(owned), false, 'released URL removed from ownership map');

  let status = null;
  guardedListener(
    { type: 'ms-offscreen-ffmpeg-status', testUrl: owned },
    { id: 'extid' },
    function (r) { status = r; }
  );
  eq(status.done, null, 'revoked lastDone result is masked from SW recovery');
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
