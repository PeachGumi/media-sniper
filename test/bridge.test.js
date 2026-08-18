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

class FakeRequest {
  constructor(url) { this.url = url; }
}

function makeContext() {
  const ctx = {
    posted,
    intervalCbs,
    elements,
    console,
    URL,
    Request: FakeRequest,
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

  // fake fetch: records calls, returns canned responses by url
  const fetchLog = [];
  ctx.fetch = function (input) {
    const url = typeof input === 'string' ? input : input.url;
    fetchLog.push(url);
    let ct = 'text/html';
    let okFlag = true;
    if (url.indexOf('.mp4') >= 0) ct = 'video/mp4';
    else if (url.indexOf('.m3u8') >= 0) ct = 'application/x-mpegurl';
    else if (url.indexOf('/page') >= 0) ct = 'text/html';
    else if (url.indexOf('/fail') >= 0) okFlag = false;
    else if (url.indexOf('/abort') >= 0) return Promise.reject(new Error('network error'));
    const headers = {
      get: function (h) {
        if (String(h).toLowerCase() === 'content-type') return ct;
        if (String(h).toLowerCase() === 'content-length') return '12345';
        return null;
      },
    };
    const res = { ok: okFlag, headers, __url: url };
    return Promise.resolve(res);
  };
  ctx.fetchLog = fetchLog;
  ctx.__lastResponse = null;

  // fake XHR
  function FakeXHR() { this.__listeners = {}; this.status = 0; }
  FakeXHR.prototype.addEventListener = function (type, fn) {
    (this.__listeners[type] = this.__listeners[type] || []).push(fn);
  };
  FakeXHR.prototype.open = function (method, url) { this.__url = url; };
  FakeXHR.prototype.send = function () {
    const self = this;
    // simulate async completion
    Promise.resolve().then(function () {
      if (self.__url.indexOf('.mp3') >= 0) {
        self.status = 200;
        self.__ct = 'audio/mpeg';
      } else if (self.__url.indexOf('/missing') >= 0) {
        self.status = 404;
        self.__ct = 'text/html';
      } else {
        self.status = 200;
        self.__ct = 'text/html';
      }
      (self.__listeners['load'] || []).forEach(function (fn) { fn.call(self); });
    });
  };
  FakeXHR.prototype.getResponseHeader = function (h) {
    return String(h).toLowerCase() === 'content-type' ? this.__ct : null;
  };
  ctx.XMLHttpRequest = FakeXHR;

  // fake URL.createObjectURL
  ctx.URL = URL;
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
  vm.runInContext(bridgeSrc, ctx);

  ok(ctx.__mediaSniperBridgeInstalled === true, 'bridge installed flag');

  // 1. fetch of mp4 emits a media message
  const res = await ctx.fetch('https://cdn.example.com/v/movie.mp4');
  await new Promise(function (r) { setImmediate(r); });
  const fetchEmit = posted.find(function (p) { return p.via === 'fetch' && p.url.indexOf('movie.mp4') >= 0; });
  ok(!!fetchEmit, 'fetch mp4 emitted');
  eq(fetchEmit && fetchEmit.kind, 'video', 'fetch mp4 kind=video');
  eq(fetchEmit && fetchEmit.source, 'media-sniper-bridge', 'marker present');
  eq(fetchEmit && fetchEmit.size, 12345, 'content-length captured');
  eq(fetchEmit && fetchEmit.pageUrl, 'https://page.example.com/watch/42', 'pageUrl stamped');

  // 2. fetch of non-media (text/html) emits nothing
  const before = posted.length;
  await ctx.fetch('https://page.example.com/page');
  await new Promise(function (r) { setImmediate(r); });
  eq(posted.length, before, 'html fetch emits nothing');

  // 3. fetch of failing response emits nothing
  await ctx.fetch('https://page.example.com/fail');
  await new Promise(function (r) { setImmediate(r); });
  eq(posted.length, before, 'failed fetch emits nothing');

  // 3b. network-error fetch: the wrapper must NOT leak an unhandled rejection,
  // must still reject the original promise (page's own catch sees it), and
  // must emit nothing. Regression guard for sankei/yahoo tracker aborts.
  const leaks = [];
  const onUnhandled = function (reason) { leaks.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  let callerSawReject = false;
  try {
    await ctx.fetch('https://cdn.example.com/abort');
  } catch (e) { callerSawReject = true; }
  ok(callerSawReject, 'aborted fetch still rejects to the caller');
  await new Promise(function (r) { setImmediate(r); });
  await new Promise(function (r) { setImmediate(r); });
  eq(leaks.length, 0, 'aborted fetch leaks no unhandled rejection');
  process.removeListener('unhandledRejection', onUnhandled);
  eq(posted.length, before, 'aborted fetch emits nothing');

  // 4. m3u8 detected via content-type
  await ctx.fetch('https://cdn.example.com/stream/master.m3u8');
  await new Promise(function (r) { setImmediate(r); });
  const hlsEmit = posted.find(function (p) { return p.via === 'fetch' && p.url.indexOf('.m3u8') >= 0; });
  ok(!!hlsEmit, 'm3u8 emitted');
  eq(hlsEmit && hlsEmit.kind, 'hls', 'm3u8 kind=hls');

  // 5. XHR of mp3 emits audio
  const xhr = new ctx.XMLHttpRequest();
  xhr.open('GET', 'https://cdn.example.com/audio/song.mp3');
  xhr.send();
  await new Promise(function (r) { setImmediate(r); });
  await new Promise(function (r) { setImmediate(r); });
  const xhrEmit = posted.find(function (p) { return p.via === 'xhr'; });
  ok(!!xhrEmit, 'xhr mp3 emitted');
  eq(xhrEmit && xhrEmit.kind, 'audio', 'xhr kind=audio');

  // 6. XHR 404 emits nothing
  const before2 = posted.length;
  const xhr2 = new ctx.XMLHttpRequest();
  xhr2.open('GET', 'https://cdn.example.com/missing.mp4');
  xhr2.send();
  await new Promise(function (r) { setImmediate(r); });
  await new Promise(function (r) { setImmediate(r); });
  eq(posted.length, before2, 'xhr 404 emits nothing');

  // 7. video element scan: blob + direct src, deduped across scans
  const scan = intervalCbs[0];
  ok(typeof scan === 'function', 'scan interval registered');
  scan();
  const blobEmit = posted.find(function (p) { return p.via === 'element' && p.url.indexOf('uuid-1') >= 0; });
  ok(!!blobEmit, 'blob video emitted');
  eq(blobEmit && blobEmit.kind, 'video', 'blob kind=video');
  const directEmit = posted.find(function (p) { return p.via === 'element' && p.url.indexOf('movie.mp4') >= 0; });
  ok(!!directEmit, 'direct src emitted');
  const countAfterFirstScan = posted.length;
  scan();
  eq(posted.length, countAfterFirstScan, 'second scan dedupes');

  // 8. createObjectURL tracking answers blob-size queries
  const fakeBlob = { size: 9999, tag: 'q' };
  const blobUrl = ctx.URL.createObjectURL(fakeBlob);
  ctx.__messageHandlers.forEach(function (fn) {
    fn({ data: { source: 'media-sniper-content', type: 'blob-size', url: blobUrl } });
  });
  const sizeMsg = posted.find(function (p) { return p.type === 'blob-size'; });
  ok(!!sizeMsg, 'blob-size answered');
  eq(sizeMsg && sizeMsg.size, 9999, 'blob size correct');

  report('bridge');
}

run().catch(function (e) {
  console.error(e);
  process.exit(1);
});
