'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { eq, ok, report } = require('./harness.js');

const logicSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'logic.js'), 'utf8');
const bgSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');

function flush() {
  return new Promise(function (r) { setImmediate(r); });
}

// ---- fake chrome -------------------------------------------------------------
function makeChrome() {
  const storageData = {};
  const listeners = { onDeterminingFilename: [], onChanged: [], onMessage: [], onRemoved: [], onActivated: [], onWebResponseStarted: [] };
  const downloads = [];
  let downloadSeq = 1;
  const suggestCalls = [];
  const swFetchLog = [];

  const chrome = {
    storage: {
      session: {
        get: function (k) {
          const out = {};
          (Array.isArray(k) ? k : [k]).forEach(function (key) { if (key in storageData) out[key] = storageData[key]; });
          return Promise.resolve(out);
        },
        set: function (obj) { Object.assign(storageData, obj); return Promise.resolve(); },
      },
    },
    downloads: {
      onDeterminingFilename: (function () {
        const ev = {
          addListener: function (fn) { listeners.onDeterminingFilename.push(fn); },
          removeListener: function (fn) {
            const i = listeners.onDeterminingFilename.indexOf(fn);
            if (i >= 0) listeners.onDeterminingFilename.splice(i, 1);
          },
          hasListener: function (fn) { return listeners.onDeterminingFilename.indexOf(fn) >= 0; },
        };
        return ev;
      })(),
      onChanged: { addListener: function (fn) { listeners.onChanged.push(fn); } },
      download: function (opts, cb) {
        const id = downloadSeq++;
        downloads.push({ id: id, opts: opts, done: false });
        chrome.runtime.lastError = null;
        if (cb) cb(id);
        return undefined;
      },
      __downloads: downloads,
    },
    runtime: {
      lastError: null,
      onMessage: { addListener: function (fn) { listeners.onMessage.push(fn); } },
      sendMessage: function (msg) {
        // emulate offscreen document
        if (msg && msg.type === 'ms-offscreen-blob') {
          let size = 0;
          (msg.parts || []).forEach(function (p) { size += p.byteLength; });
          return Promise.resolve({ url: 'blob:fake/combined-' + size, size: size });
        }
        return Promise.resolve(undefined);
      },
    },
    tabs: {
      onRemoved: { addListener: function (fn) { listeners.onRemoved.push(fn); } },
      onActivated: { addListener: function (fn) { listeners.onActivated.push(fn); } },
      query: function (q, cb) { cb([{ id: 1 }]); },
      sendMessage: function () { return Promise.resolve({ ok: true }); },
    },
    action: { setBadgeText: function () {} },
    webRequest: {
      onResponseStarted: { addListener: function (fn) { listeners.onWebResponseStarted.push(fn); } },
    },
    __listeners: listeners,
    __suggestCalls: suggestCalls,
    __storageData: storageData,
    __swFetchLog: swFetchLog,
  };
  return chrome;
}

function makeContext(chrome) {
  const ctx = {
    chrome,
    console,
    URL,
    Promise,
    Date,
    Math,
    Blob,
    ArrayBuffer,
    Uint8Array,
    URL_createObjectURL_count: 0,
    fetch: function (url) {
      chrome.__swFetchLog.push(url);
      if (url.indexOf('master.m3u8') >= 0) {
        return Promise.resolve({ ok: true, text: function () {
          return Promise.resolve('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nmedia.m3u8\n');
        } });
      }
      if (url.indexOf('media.m3u8') >= 0) {
        return Promise.resolve({ ok: true, text: function () {
          return Promise.resolve('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nseg0.ts\n#EXTINF:2.0,\nseg1.ts\n#EXT-X-ENDLIST\n');
        } });
      }
      if (url.indexOf('subs.m3u8') >= 0) {
        return Promise.resolve({ ok: true, text: function () {
          return Promise.resolve('#EXTM3U\n#EXTINF:10,\nsubs.vtt\n#EXT-X-ENDLIST\n');
        } });
      }
      if (/seg\d+\.ts$/.test(url)) {
        // fake TS segment: 188 bytes
        const buf = new ArrayBuffer(188);
        new Uint8Array(buf).fill(0x47);
        return Promise.resolve({ ok: true, arrayBuffer: function () { return Promise.resolve(buf); } });
      }
      return Promise.resolve({ ok: false, text: function () { return Promise.resolve(''); } });
    },
    globalThis: null,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  return ctx;
}

async function send(chrome, msg, sender, waitMs) {
  const fn = chrome.__listeners.onMessage[0];
  let response = null;
  let got = false;
  fn(msg, sender || {}, function (r) { response = r; got = true; });
  const deadline = Date.now() + (waitMs || 3000);
  while (!got && Date.now() < deadline) await flush();
  return response;
}

async function run() {
  const chrome = makeChrome();
  const ctx = makeContext(chrome);
  vm.runInContext(logicSrc, ctx);
  vm.runInContext(bgSrc, ctx);

  // --- 1. report + dedupe + get ---------------------------------------------
  let r = await send(chrome, { type: 'ms-report', items: [
    { url: 'https://cdn.example.com/a.mp4', kind: 'video', size: 9000000, contentType: 'video/mp4', pageUrl: 'https://site.example.com/p' },
    { url: 'https://cdn.example.com/a.mp4?tok=1', kind: 'video', size: 0 },
    { url: 'https://cdn.example.com/b.m3u8', kind: 'hls' },
    { url: 'blob:https://site.example.com/u1', kind: 'video' },
    { url: 'https://site.example.com/page.html' },
  ], tabId: 1 });
  eq(r.added, 3, '3 distinct items added (query dup merged, html rejected)');
  r = await send(chrome, { type: 'ms-get-items', tabId: 1 });
  eq(r.items.length, 3, 'get-items returns 3');
  eq(r.items[0].kind, 'video', 'video sorted first');
  eq(r.items[0].size, 9000000, 'richer copy kept');

  // --- 2. normal download: filename routed, completion frees slot -----------
  await send(chrome, { type: 'ms-download', item: { url: 'https://cdn.example.com/a.mp4', kind: 'video' }, tabId: 1 });
  eq(chrome.downloads.__downloads.length, 1, 'one download started');
  eq(chrome.downloads.__downloads[0].opts.filename, 'a.mp4', 'flat filename passed');
  const d1 = chrome.downloads.__downloads[0].id;
  chrome.__listeners.onChanged.forEach(function (fn) { fn({ id: d1, state: { current: 'complete' } }); });
  chrome.downloads.__downloads[0].done = true;
  await flush();
  let qs = await send(chrome, { type: 'ms-queue-status', tabId: 1 });
  eq(qs.queue[0].status, 'complete', 'complete recorded');

  // --- 3. concurrency: 3 active max ------------------------------------------
  for (let i = 0; i < 5; i++) {
    await send(chrome, { type: 'ms-download', item: { url: 'https://cdn.example.com/clip' + i + '.mp4', kind: 'video' }, tabId: 1 });
  }
  const running = chrome.downloads.__downloads.filter(function (d) { return !d.done; });
  eq(running.length, 3, 'concurrency capped at 3');
  // finish one -> next pumps
  chrome.__listeners.onChanged.forEach(function (fn) { fn({ id: running[0].id, state: { current: 'complete' } }); });
  running[0].done = true;
  await flush();
  eq(chrome.downloads.__downloads.length, 5, '4th download pumped after completion');

  // --- 4. interrupted download marked failed ----------------------------------
  const last = chrome.downloads.__downloads[chrome.downloads.__downloads.length - 1];
  chrome.__listeners.onChanged.forEach(function (fn) { fn({ id: last.id, state: { current: 'interrupted' }, error: { current: 'NETWORK_FAILED' } }); });
  last.done = true;
  await flush();
  qs = await send(chrome, { type: 'ms-queue-status', tabId: 1 });
  const failed = qs.queue.filter(function (q) { return q.status === 'failed'; });
  eq(failed.length, 1, 'interrupted -> failed');

  // drain any still-running downloads so the blob test can start immediately
  chrome.downloads.__downloads.forEach(function (d) {
    if (!d.done) {
      d.done = true;
      chrome.__listeners.onChanged.forEach(function (fn) { fn({ id: d.id, state: { current: 'complete' } }); });
    }
  });
  await flush();

  // --- 5. blob download: same filename-option path, no listener machinery ----
  await send(chrome, { type: 'ms-download-blob', url: 'blob:https://site.example.com/blob1', kind: 'video' }, {});
  await flush();
  const blobDl = chrome.downloads.__downloads[chrome.downloads.__downloads.length - 1];
  eq(blobDl.opts.filename, 'video_blob1.mp4', 'blob download carries flat computed filename');
  eq(blobDl.opts.saveAs, false, 'blob download saveAs=false');
  eq(chrome.__listeners.onDeterminingFilename.length, 0, 'no onDeterminingFilename listener ever registered');
  // blob download completes like any other
  chrome.__listeners.onChanged.forEach(function (fn) { fn({ id: blobDl.id, state: { current: 'complete' } }); });
  blobDl.done = true;
  await flush();
  qs = await send(chrome, { type: 'ms-queue-status', tabId: 1 });
  ok(qs.queue.some(function (q) { return q.filename === 'video_blob1.mp4' && q.status === 'complete'; }), 'blob download completed');

  // --- 6. tab removed clears items --------------------------------------------
  chrome.__listeners.onRemoved.forEach(function (fn) { fn(1); });
  r = await send(chrome, { type: 'ms-get-items', tabId: 1 });
  eq(r.items.length, 0, 'items cleared on tab close');

  // --- 7. webRequest detection -------------------------------------------------
  await send(chrome, { type: 'ms-page-meta', title: 'Cool Video Page', url: 'https://site.example.com/watch/9' }, { tab: { id: 7 } });
  const wr = chrome.__listeners.onWebResponseStarted[0];
  ok(typeof wr === 'function', 'webRequest listener registered');

  // mp4 via response headers (size above the 500KB noise threshold)
  wr({
    statusCode: 200, url: 'https://cdn.example.com/movie.mp4', tabId: 7,
    initiator: 'https://site.example.com/', type: 'media',
    responseHeaders: [
      { name: 'Content-Type', value: 'video/mp4' },
      { name: 'Content-Length', value: '5000000' },
    ],
  });
  await flush();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  eq(r.items.length, 1, 'webrequest mp4 detected');
  eq(r.items[0].title, 'Cool Video Page', 'page title attached');
  eq(r.items[0].size, 5000000, 'content-length from headers');

  // tiny media (< 500KB) is filtered as noise (VDH rule)
  wr({
    statusCode: 200, url: 'https://cdn.example.com/ad.mp4', tabId: 7,
    initiator: 'https://site.example.com/', type: 'media',
    responseHeaders: [
      { name: 'Content-Type', value: 'video/mp4' },
      { name: 'Content-Length', value: '120000' },
    ],
  });
  await flush();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  ok(!r.items.some(function (i) { return i.url.indexOf('ad.mp4') >= 0; }), 'tiny media filtered (<500KB)');

  // youtube.com responses are ignored by the generic detector (dedicated site)
  wr({
    statusCode: 200, url: 'https://rr2---sn-youtube.com/videoplayback?itag=18', tabId: 7,
    initiator: 'https://www.youtube.com/', type: 'media',
    responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }],
  });
  await flush();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  ok(!r.items.some(function (i) { return i.url.indexOf('videoplayback') >= 0; }), 'youtube chunk ignored by generic detector');

  // but the youtube adapter's own report (via=youtube) passes through
  r = await send(chrome, { type: 'ms-report', items: [
    { url: 'https://rr2---sn-youtube.com/videoplayback?itag=22', kind: 'video', contentType: 'video/mp4', size: 9000000, via: 'youtube', pageUrl: 'https://www.youtube.com/watch?v=abc', title: 'YT Video [720p]', duration: 300 },
  ], tabId: 7 });
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  const ytItem = r.items.find(function (i) { return i.via === 'youtube'; });
  ok(!!ytItem, 'youtube adapter item accepted');
  eq(ytItem && ytItem.title, 'YT Video [720p]', 'adapter title kept');

  // mp2t content-type is always a segment, never reported
  wr({
    statusCode: 200, url: 'https://cdn.example.com/stream/chunk', tabId: 7,
    initiator: 'https://site.example.com/', type: 'media',
    responseHeaders: [{ name: 'Content-Type', value: 'video/mp2t' }],
  });
  await flush();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  ok(!r.items.some(function (i) { return i.url.indexOf('/chunk') >= 0; }), 'mp2t segment filtered');

  // text/html responses are never media
  wr({
    statusCode: 200, url: 'https://cdn.example.com/thing.mp4', tabId: 7,
    initiator: 'https://site.example.com/', type: 'media',
    responseHeaders: [
      { name: 'Content-Type', value: 'text/html' },
      { name: 'Content-Length', value: '9000000' },
    ],
  });
  await flush();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  ok(!r.items.some(function (i) { return i.url.indexOf('thing.mp4') >= 0; }), 'html response filtered');

  // m3u8 via content-type -> playlist validated via SW fetch
  wr({
    statusCode: 200, url: 'https://cdn.example.com/live/master.m3u8', tabId: 7,
    initiator: 'https://site.example.com/', type: 'xmlhttprequest',
    responseHeaders: [{ name: 'content-type', value: 'application/vnd.apple.mpegurl' }],
  });
  await flush();
  await flush();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  const hlsItem = r.items.find(function (i) { return i.kind === 'hls'; });
  ok(!!hlsItem, 'hls playlist validated and added');
  eq(hlsItem && hlsItem.title, 'Cool Video Page', 'hls item titled');
  ok(chrome.__swFetchLog.some(function (u) { return u.indexOf('master.m3u8') >= 0; }), 'SW fetched playlist');

  // subtitle playlist rejected
  wr({
    statusCode: 200, url: 'https://cdn.example.com/subs.m3u8', tabId: 7,
    initiator: 'https://site.example.com/', type: 'xmlhttprequest',
    responseHeaders: [{ name: 'content-type', value: 'application/vnd.apple.mpegurl' }],
  });
  await flush();
  await flush();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  ok(!r.items.some(function (i) { return i.url.indexOf('subs.m3u8') >= 0; }), 'subtitle playlist rejected');

  // segments never reported
  wr({
    statusCode: 200, url: 'https://cdn.example.com/live/seg0.ts', tabId: 7,
    initiator: 'https://site.example.com/', type: 'media',
    responseHeaders: [{ name: 'content-type', value: 'video/mp2t' }],
  });
  await flush();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  ok(!r.items.some(function (i) { return i.url.indexOf('seg0.ts') >= 0; }), 'ts segment filtered');

  // html page not reported
  wr({
    statusCode: 200, url: 'https://site.example.com/page', tabId: 7,
    initiator: 'https://site.example.com/', type: 'main_frame',
    responseHeaders: [{ name: 'content-type', value: 'text/html' }],
  });
  await flush();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  ok(!r.items.some(function (i) { return i.url.indexOf('/page') >= 0; }), 'html page filtered');

  // 404 not reported
  wr({
    statusCode: 404, url: 'https://cdn.example.com/gone.mp4', tabId: 7,
    initiator: 'https://site.example.com/', type: 'media',
    responseHeaders: [{ name: 'content-type', value: 'video/mp4' }],
  });
  await flush();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  ok(!r.items.some(function (i) { return i.url.indexOf('gone.mp4') >= 0; }), '404 filtered');

  // --- 8. HLS pipeline end-to-end (SW-side) ------------------------------------
  const hlsResp = await send(chrome, { type: 'ms-hls-download', url: 'https://cdn.example.com/live/master.m3u8', title: 'HLS Test Video', pageUrl: 'https://site.example.com/watch/9' }, { tab: { id: 7 } });
  ok(hlsResp && hlsResp.queued, 'hls job queued a download');
  // master fetched, media playlist fetched, segments fetched
  ok(chrome.__swFetchLog.some(function (u) { return u.indexOf('media.m3u8') >= 0; }), 'media playlist fetched');
  ok(chrome.__swFetchLog.some(function (u) { return /seg0\.ts$/.test(u); }), 'seg0 fetched');
  ok(chrome.__swFetchLog.some(function (u) { return /seg1\.ts$/.test(u); }), 'seg1 fetched');
  // job state
  const hlsStatus = await send(chrome, { type: 'ms-hls-status', url: 'https://cdn.example.com/live/master.m3u8' }, {});
  eq(hlsStatus.status, 'downloading', 'job reached downloading');
  eq(hlsStatus.done, 2, 'both segments combined');
  // queued download is the blob, with title-based filename
  qs = await send(chrome, { type: 'ms-queue-status' });
  const hlsQ = qs.queue.filter(function (q) { return q.filename.indexOf('HLS Test Video') >= 0; });
  eq(hlsQ.length, 1, 'hls output named by title');
  ok(hlsQ[0].filename.endsWith('.ts'), 'ts container for non-fmp4');
  // duplicate start while running is rejected (job already downloading -> reruns, but alreadyRunning only for fetching/combining)
  const dup = await send(chrome, { type: 'ms-hls-download', url: 'https://cdn.example.com/live/master.m3u8', title: 'x' }, { tab: { id: 7 } });
  ok(dup, 'duplicate hls request responds');

  // --- 9. encrypted HLS rejected ------------------------------------------------
  const ctxRef = ctx;
  const origFetch = ctxRef.fetch;
  ctxRef.fetch = function (url) {
    if (url.indexOf('enc.m3u8') >= 0) {
      return Promise.resolve({ ok: true, text: function () {
        return Promise.resolve('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://k/key.bin"\n#EXTINF:2,\nseg0.ts\n#EXT-X-ENDLIST\n');
      } });
    }
    return origFetch(url);
  };
  const encResp = await send(chrome, { type: 'ms-hls-download', url: 'https://cdn.example.com/enc.m3u8', title: 'enc' }, { tab: { id: 7 } });
  ok(encResp && encResp.error && encResp.error.indexOf('AES-128') >= 0, 'encrypted HLS rejected with yt-dlp hint');
  ctxRef.fetch = origFetch;

  report('background');
}

run().catch(function (e) {
  console.error(e);
  process.exit(1);
});
