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

const videoEl = { currentSrc: 'blob:https://page.example.com/uuid-1', src: '', duration: 12.5, __msEmitted: false };
const srcEl = { currentSrc: '', src: 'https://cdn.example.com/vid/movie.mp4', __msEmitted: false };
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

  // 1. video element scan: blob + direct src, deduped across scans
  const scan = intervalCbs[0];
  ok(typeof scan === 'function', 'scan interval registered');
  scan();
  const blobEmit = posted.find(function (p) { return p.via === 'element' && p.url.indexOf('uuid-1') >= 0; });
  ok(!!blobEmit, 'blob video emitted');
  eq(blobEmit && blobEmit.kind, 'video', 'blob kind=video');
  eq(blobEmit && blobEmit.source, 'media-sniper-bridge', 'marker present');
  eq(blobEmit && blobEmit.pageUrl, 'https://page.example.com/watch/42', 'pageUrl stamped');
  const directEmit = posted.find(function (p) { return p.via === 'element' && p.url.indexOf('movie.mp4') >= 0; });
  ok(!!directEmit, 'direct src emitted');
  eq(directEmit && directEmit.kind, 'video', 'direct src kind=video');
  const countAfterFirstScan = posted.length;
  scan();
  eq(posted.length, countAfterFirstScan, 'second scan dedupes');

  // 2. scan command via content-script message triggers a rescan
  const newEl = { currentSrc: 'https://cdn.example.com/vid/other.webm', src: '', __msEmitted: false };
  elements.push(newEl);
  ctx.__messageHandlers.forEach(function (fn) {
    fn({ data: { source: 'media-sniper-content', type: 'scan' } });
  });
  const rescanEmit = posted.find(function (p) { return p.url.indexOf('other.webm') >= 0; });
  ok(!!rescanEmit, 'scan command picks up new element');

  // 3. playlists are never emitted from the bridge even if a video element
  //    points at one (webRequest owns validation + variant expansion)
  const hlsEl = { currentSrc: 'https://cdn.example.com/live/master.m3u8', src: '', __msEmitted: false };
  elements.push(hlsEl);
  scan();
  ok(!posted.some(function (p) { return p.url.indexOf('.m3u8') >= 0; }), 'm3u8 NOT emitted by bridge');

  // 4. createObjectURL tracking answers blob-size queries
  const fakeBlob = { size: 9999, tag: 'q' };
  const blobUrl = ctx.URL.createObjectURL(fakeBlob);
  ctx.__messageHandlers.forEach(function (fn) {
    fn({ data: { source: 'media-sniper-content', type: 'blob-size', url: blobUrl } });
  });
  const sizeMsg = posted.find(function (p) { return p.type === 'blob-size'; });
  ok(!!sizeMsg, 'blob-size answered');
  eq(sizeMsg && sizeMsg.size, 9999, 'blob size correct');

  // 5. unrelated page messages are ignored
  const beforeLen = posted.length;
  ctx.__messageHandlers.forEach(function (fn) {
    fn({ data: { source: 'some-other-extension', type: 'scan' } });
    fn({ data: null });
    fn({ data: 'just a string' });
  });
  eq(posted.length, beforeLen, 'foreign messages ignored');

  report('bridge');
}

run().catch(function (e) {
  console.error(e);
  process.exit(1);
});
