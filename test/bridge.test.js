'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { eq, ok, report } = require('./harness.js');

const logicSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'logic.js'), 'utf8');
const bridgeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'bridge.js'), 'utf8');

// ---- fake page environment --------------------------------------------------
const posted = [];
const intervalCbs = [];

const videoEl = { currentSrc: 'blob:https://page.example.com/uuid-1', src: '', duration: 12.5 };
const srcEl = { currentSrc: '', src: 'https://cdn.example.com/vid/movie.mp4' };
const elements = [videoEl, srcEl];

function makeContext() {
  const ctx = {
    posted,
    intervalCbs,
    elements,
    console,
    URL,
    Promise,
    setTimeout: function (fn, ms) { return { fn, ms }; },
    setInterval: function (fn, ms) { intervalCbs.push(fn); return intervalCbs.length; },
    clearInterval: function () {},
  };
  ctx.location = { href: 'https://page.example.com/watch/42' };
  ctx.document = {
    querySelectorAll: function () { return elements; },
  };
  const messageHandlers = [];
  ctx.window = ctx; // window === global in page scripts
  ctx.addEventListener = function (type, fn) { if (type === 'message') messageHandlers.push(fn); };
  ctx.postMessage = function (data) { posted.push(data); };
  ctx.__messageHandlers = messageHandlers;

  // fake fetch: the bridge must NOT touch window.fetch at all anymore
  let fetchCalls = 0;
  ctx.fetch = function () { fetchCalls++; return Promise.resolve({ ok: true }); };
  ctx.__fetchCalls = function () { return fetchCalls; };

  // fake URL.createObjectURL
  const blobSizes = {};
  ctx.__blobRegistry = blobSizes;
  const RealURL = URL;
  RealURL.createObjectURL = function (blob) { return 'blob:https://page.example.com/gen-' + (blob.tag || 'x'); };

  return ctx;
}

async function run() {
  const ctx = makeContext();
  vm.createContext(ctx);
  vm.runInContext(logicSrc, ctx);

  // guard: page fetch errors must be impossible to attribute to the bridge —
  // the bridge never wraps fetch anymore
  const beforeWrap = ctx.fetch;
  vm.runInContext(bridgeSrc, ctx);
  eq(ctx.fetch, beforeWrap, 'bridge does NOT wrap window.fetch (no sbisec-style blame)');

  ok(ctx.__mediaSniperBridgeInstalled === true, 'bridge installed flag');

  // 1. first pass is immediate; periodic passes dedupe unchanged sources.
  const scan = intervalCbs[0];
  ok(typeof scan === 'function', 'scan interval registered');
  const blobEmit = posted.find(function (p) { return p.via === 'element' && p.url.indexOf('uuid-1') >= 0; });
  ok(!!blobEmit, 'blob video emitted immediately');
  eq(blobEmit && blobEmit.kind, 'video', 'blob kind=video');
  eq(blobEmit && blobEmit.source, 'media-sniper-bridge', 'marker present');
  eq(blobEmit && blobEmit.pageUrl, 'https://page.example.com/watch/42', 'pageUrl stamped');
  const directEmit = posted.find(function (p) { return p.via === 'element' && p.url.indexOf('movie.mp4') >= 0; });
  ok(!!directEmit, 'direct src emitted immediately');
  eq(directEmit && directEmit.kind, 'video', 'direct src kind=video');
  const countAfterFirstScan = posted.length;
  scan();
  eq(posted.length, countAfterFirstScan, 'periodic scan dedupes unchanged source');

  // 2. source changes on a reused media element are detected automatically.
  srcEl.src = 'https://cdn.example.com/vid/reused-element.mp4';
  scan();
  ok(posted.some(function (p) { return p.url.indexOf('reused-element.mp4') >= 0; }), 'reused element with changed src is emitted');

  // 3. explicit scan force-reports current sources. This is required after
  // Clear and lets a manual rescan rebuild the list even when DOM is unchanged.
  const beforeForced = posted.filter(function (p) { return p.url && p.url.indexOf('reused-element.mp4') >= 0; }).length;
  ctx.__messageHandlers.forEach(function (fn) {
    fn({ data: { source: 'media-sniper-content', type: 'scan' } });
  });
  const afterForced = posted.filter(function (p) { return p.url && p.url.indexOf('reused-element.mp4') >= 0; }).length;
  eq(afterForced, beforeForced + 1, 'explicit scan re-emits unchanged current source');

  // 4. explicit scan also picks up elements added since the last pass.
  const newEl = { currentSrc: 'https://cdn.example.com/vid/other.webm', src: '' };
  elements.push(newEl);
  ctx.__messageHandlers.forEach(function (fn) {
    fn({ data: { source: 'media-sniper-content', type: 'scan' } });
  });
  const rescanEmit = posted.find(function (p) { return p.url && p.url.indexOf('other.webm') >= 0; });
  ok(!!rescanEmit, 'scan command picks up new element');

  // 5. playlists are never emitted from the bridge even if a video element
  // points at one (webRequest owns validation + variant expansion)
  const hlsEl = { currentSrc: 'https://cdn.example.com/live/master.m3u8', src: '' };
  elements.push(hlsEl);
  scan();
  ok(!posted.some(function (p) { return p.url && p.url.indexOf('.m3u8') >= 0; }), 'm3u8 NOT emitted by bridge');

  // 6. createObjectURL tracking answers blob-size queries
  const fakeBlob = { size: 9999, tag: 'q' };
  const blobUrl = ctx.URL.createObjectURL(fakeBlob);
  ctx.__messageHandlers.forEach(function (fn) {
    fn({ data: { source: 'media-sniper-content', type: 'blob-size', url: blobUrl } });
  });
  const sizeMsg = posted.find(function (p) { return p.type === 'blob-size'; });
  ok(!!sizeMsg, 'blob-size answered');
  eq(sizeMsg && sizeMsg.size, 9999, 'blob size correct');

  // 7. unrelated page messages are ignored
  const beforeLen = posted.length;
  ctx.__messageHandlers.forEach(function (fn) {
    fn({ data: { source: 'some-other-extension', type: 'scan' } });
    fn({ data: null });
    fn({ data: 'just a string' });
  });
  eq(posted.length, beforeLen, 'foreign messages ignored');

  // ---- page resource timing -------------------------------------------------
  // A player that feeds a MediaSource never shows the manifest in the DOM, and
  // requests to hosts the user has not granted are invisible to webRequest. The
  // page's own resource timing has both, which is what replaces a per-site
  // adapter here. A fresh context is built so the entries exist at injection.
  const rtPosted = [];
  const rtCtx = {
    posted: rtPosted,
    elements: [],
    console,
    URL,
    Promise,
    document: { querySelectorAll: function () { return []; }, title: 'RT page' },
    location: { href: 'https://page.example.com/watch/9' },
    performance: {
      getEntriesByType: function (type) {
        if (type !== 'resource') return [];
        return [
          { name: 'https://media.example.net/stream/master.m3u8?token=abc' },
          { name: 'https://media.example.net/stream/seg0.ts' },
          { name: 'https://media.example.net/audio/chunk_1_0_a.aac' },
          { name: 'https://media.example.net/movie.mp4' },
          { name: 'https://page.example.com/app.js' },
          { name: 'blob:https://page.example.com/uuid-9' },
          { name: 'https://media.example.net/manifest.mpd' },
        ];
      },
    },
    setTimeout: function (fn) { if (typeof fn === 'function') fn(); return 1; },
    setInterval: function () { return 1; },
    clearInterval: function () {},
    addEventListener: function () {},
    postMessage: function (data) { rtPosted.push(data); },
  };
  rtCtx.window = rtCtx;
  rtCtx.globalThis = rtCtx;
  vm.createContext(rtCtx);
  vm.runInContext(logicSrc, rtCtx);
  vm.runInContext(bridgeSrc, rtCtx);
  const rtMedia = rtPosted.filter(function (m) { return m && m.type === 'media'; });
  eq(rtMedia.length, 3, 'resource timing reports manifest and whole-file media only');
  eq(rtMedia.some(function (m) { return m.url.indexOf('master.m3u8') >= 0 && m.kind === 'hls' && m.via === 'page-data'; }), true,
    'an HLS manifest found in resource timing is reported as page data');
  eq(rtMedia.some(function (m) { return m.url.indexOf('manifest.mpd') >= 0 && m.kind === 'dash'; }), true,
    'a DASH manifest found in resource timing is reported as page data');
  eq(rtMedia.some(function (m) { return m.url.indexOf('movie.mp4') >= 0 && m.kind === 'video'; }), true,
    'a whole media file found in resource timing is reported');
  eq(rtMedia.some(function (m) { return /\.ts$|\.aac$/.test(m.url); }), false,
    'segments never become items');
  eq(rtMedia.some(function (m) { return m.url.indexOf('blob:') === 0; }), false,
    'blob handles are not items');

  report('bridge');
}

run().catch(function (e) {
  console.error(e);
  process.exit(1);
});
