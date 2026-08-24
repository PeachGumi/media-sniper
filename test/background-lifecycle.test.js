'use strict';
const fs = require('fs');
const vm = require('vm');
const { eq, ok, report } = require('./harness.js');

const policy = require('../src/background-lifecycle.js');

{
  const now = 1_000_000;
  const queue = [{ id: 'active', status: 'started' }];
  for (let i = 0; i < 150; i++) queue.push({ id: 'q' + i, status: 'complete', _terminalAt: now - i });
  policy.pruneQueue(queue, now);
  eq(queue.length, 101, 'queue keeps active entry plus bounded terminal history');
  ok(queue.some((q) => q.id === 'active'), 'active queue entry preserved');
  ok(queue.some((q) => q.id === 'q0'), 'newest terminal queue entry preserved');
  ok(!queue.some((q) => q.id === 'q149'), 'old terminal queue overflow removed');

  queue.push({ id: 'expired', status: 'failed', _terminalAt: now - policy.QUEUE_TERMINAL_TTL_MS - 1 });
  policy.pruneQueue(queue, now);
  ok(!queue.some((q) => q.id === 'expired'), 'expired terminal queue entry removed');
}

{
  const now = 2_000_000;
  const jobs = new Map([['active', { status: 'recording' }]]);
  for (let i = 0; i < 130; i++) jobs.set('j' + i, { status: 'failed', _terminalAt: now - i });
  policy.pruneJobs(jobs, now);
  eq(jobs.size, 101, 'job map keeps active job plus bounded terminal history');
  ok(jobs.has('active'), 'active job preserved');
  ok(!jobs.has('j129'), 'old job overflow removed');

  jobs.set('expired', { status: 'complete', _terminalAt: now - policy.JOB_TERMINAL_TTL_MS - 1 });
  policy.pruneJobs(jobs, now);
  ok(!jobs.has('expired'), 'expired terminal job removed');
}

{
  const now = 3_000_000;
  const headers = new Map([['fresh', [1]], ['old', [2]], ['orphanTimestampTarget', [3]]]);
  const times = new Map([
    ['fresh', now - 100],
    ['old', now - policy.CAPTURED_HEADERS_TTL_MS - 1],
    ['missing', now - 100],
  ]);
  policy.pruneCapturedHeaders(headers, times, now);
  ok(headers.has('fresh'), 'fresh captured headers preserved');
  ok(!headers.has('old'), 'expired captured headers removed');
  ok(!times.has('missing'), 'timestamp without header is removed');
}

const extId = 'abcdefghijklmnopabcdefghijklmnop';
eq(policy.isOwnedExtensionBlob('blob:chrome-extension://' + extId + '/abc', extId), true, 'extension blob ownership detected');
eq(policy.isOwnedExtensionBlob('blob:https://example.test/abc', extId), false, 'page blob not claimed by extension');

// Shared classic-script realm integration: lifecycle.js must be able to see and
// wrap background.js-style global lexical state after a separate evaluation.
(async function () {
  const sent = [];
  const context = vm.createContext({
    console,
    Map,
    Set,
    Date,
    Promise,
    Object,
    Array,
    setInterval: function () { return 1; },
    clearInterval: function () {},
  });
  context.globalThis = context;
  context.chrome = {
    runtime: {
      id: extId,
      sendMessage: function (message) {
        sent.push(message);
        if (message && message.type === 'ms-offscreen-ffmpeg-status') {
          return Promise.resolve({ running: false, done: { url: 'blob:chrome-extension://' + extId + '/out' } });
        }
        return Promise.resolve({ ok: true });
      },
    },
    downloads: {
      download: function () { return Promise.resolve(42); },
      onChanged: { addListener: function (fn) { context.__downloadChanged = fn; } },
    },
    tabs: {
      onRemoved: { addListener: function (fn) { context.__tabRemoved = fn; } },
    },
  };

  vm.runInContext(`
    const L = { itemKey: (u) => String(u || '') };
    const state = {
      queue: [], active: new Set(), downloadToItem: new Map(),
      hlsJobs: new Map(), pageMeta: new Map(), itemsByTab: new Map()
    };
    const mediaChains = new Map();
    const capturedReqHeaders = new Map();
    function headersFor(url) { return capturedReqHeaders.get(L.itemKey(url)) || {}; }
    function enrichFromCapture(item) { return item; }
    function pump() { return true; }
    function enqueue(item) {
      const entry = { id: 'q' + state.queue.length, item, status: 'queued' };
      state.queue.push(entry); pump(); return entry;
    }
  `, context);

  const source = fs.readFileSync(require.resolve('../src/background-lifecycle.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'background-lifecycle.js' });
  ok(!!context.MediaSniperLifecycle, 'runtime lifecycle installed in shared script realm');

  const owned = 'blob:chrome-extension://' + extId + '/out';
  const pageBlob = 'blob:https://example.test/page';
  const entry = vm.runInContext(`enqueue({url: ${JSON.stringify(owned)}})`, context);
  eq(entry.ownedBlobUrl, owned, 'enqueue marks extension-owned blob');
  const pageEntry = vm.runInContext(`enqueue({url: ${JSON.stringify(pageBlob)}})`, context);
  eq(pageEntry.ownedBlobUrl, undefined, 'enqueue leaves page-owned blob untouched');

  // Download API ownership: completion must send an explicit offscreen revoke.
  await context.chrome.downloads.download({ url: owned });
  context.__downloadChanged({ id: 42, state: { current: 'complete' } });
  await Promise.resolve();
  ok(sent.some((m) => m && m.type === 'ms-offscreen-revoke-url' && m.url === owned), 'download completion releases owned blob');

  // A revoked lastDone must not be offered back to the service worker.
  const status = await context.chrome.runtime.sendMessage({ type: 'ms-offscreen-ffmpeg-status' });
  eq(status.done, null, 'revoked offscreen recovery result is masked');

  // Mux-only input blobs are temporary and released when mux settles.
  const v = 'blob:chrome-extension://' + extId + '/v';
  const a = 'blob:chrome-extension://' + extId + '/a';
  await context.chrome.runtime.sendMessage({ type: 'ms-offscreen-mux-local', videoUrl: v, audioUrl: a });
  ok(sent.some((m) => m && m.type === 'ms-offscreen-revoke-url' && m.url === v), 'video mux input released');
  ok(sent.some((m) => m && m.type === 'ms-offscreen-revoke-url' && m.url === a), 'audio mux input released');

  // Tab close removes metadata/chains and terminal jobs, but not active work.
  vm.runInContext(`
    state.pageMeta.set(7, {title:'x'});
    mediaChains.set(7, {tabId:7});
    state.hlsJobs.set('done', {tabId:7, status:'complete'});
    state.hlsJobs.set('activeJob', {tabId:7, status:'recording'});
  `, context);
  context.__tabRemoved(7);
  eq(vm.runInContext('state.pageMeta.has(7)', context), false, 'tab metadata removed');
  eq(vm.runInContext('mediaChains.has(7)', context), false, 'tab media chain removed');
  eq(vm.runInContext("state.hlsJobs.has('done')", context), false, 'terminal tab job removed');
  eq(vm.runInContext("state.hlsJobs.has('activeJob')", context), true, 'active tab job allowed to finish');

  // Header timestamps are attached to the existing value shape and clear with delete.
  vm.runInContext("capturedReqHeaders.set('https://media.test/a', [{name:'Authorization',value:'x'}])", context);
  eq(context.MediaSniperLifecycle.capturedTimes.has('https://media.test/a'), true, 'captured header timestamp recorded');
  vm.runInContext("capturedReqHeaders.delete('https://media.test/a')", context);
  eq(context.MediaSniperLifecycle.capturedTimes.has('https://media.test/a'), false, 'captured header timestamp removed with entry');

  report('background-lifecycle');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
