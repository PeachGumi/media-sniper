'use strict';
const fs = require('fs');
const vm = require('vm');
const { eq, ok, report } = require('./harness.js');

const source = fs.readFileSync(require.resolve('../src/offscreen.js'), 'utf8')
  .replace("import LibAVFactory from './libav/libav-6.5.7.1-h264-aac-mp3.wasm.mjs';", "const LibAVFactory = globalThis.__LibAVFactory;");
let listener = null;
let exited = 0;
let fetchProbe = false;
const fetchCalls = [];
const factoryCalls = [];
const keepaliveMessages = [];
let keepaliveDisconnects = 0;
let delayFactory = false;
let resolveFactory = null;
let delayWriter = false;
let resolveWriter = null;
let ffmpegCalls = 0;
let offscreenGlobal = null;
const libav = {
  onwrite: null,
  abortController: { signal: { aborted: false } },
  async mkwriterdev() {
    if (delayWriter) return new Promise(function (resolve) { resolveWriter = resolve; });
  },
  async ffmpeg() {
    ffmpegCalls++;
    if (fetchProbe) {
      const response = await offscreenGlobal.fetch('https://page.example/segment.ts');
      if (!response || !response.ok) throw new Error('nested fetch failed');
      this.onwrite('out.mp4', 0, new Uint8Array([4, 5, 6]));
      return 0;
    }
    this.onwrite('out.mp4', 0, new Uint8Array([1, 2, 3]));
    return 7;
  },
  async ffmpeg_get_out_time_ms() { return 0; },
  async ffmpeg_get_total_size_bytes() { return 3; },
  ffmpeg_interrupt() {},
  exit() { exited++; },
};
const fakeChrome = {
  runtime: {
    getURL(path) { return 'chrome-extension://test/' + path; },
    onMessage: { addListener(fn) { listener = fn; } },
    sendMessage() { return Promise.resolve(); },
    connect() {
      return {
        postMessage(message) { keepaliveMessages.push(message); },
        disconnect() { keepaliveDisconnects++; },
      };
    },
  },
};
const URLCtor = URL;
URLCtor.createObjectURL = function (blob) { return 'blob:test/' + blob.size; };
const context = vm.createContext({
  console,
  chrome: fakeChrome,
  __LibAVFactory: function (options) {
    factoryCalls.push(options || {});
    if (delayFactory) return new Promise(function (resolve) { resolveFactory = resolve; });
    return Promise.resolve(libav);
  },
  fetch: function (url, options) {
    fetchCalls.push({ url: url, options: options || {} });
    return Promise.resolve({ ok: true });
  },
  URL: URLCtor,
  Blob,
  Uint8Array,
  ArrayBuffer,
  Promise,
  setInterval() { return 1; },
  clearInterval() {},
  setTimeout,
  clearTimeout,
  globalThis: null,
});
context.globalThis = context;
offscreenGlobal = context;
vm.runInContext(source, context, { filename: 'offscreen.js' });
ok(typeof listener === 'function', 'offscreen message listener installed');

(async function () {
  const result = await new Promise(function (resolve) {
    listener({
      type: 'ms-offscreen-ffmpeg-run',
      jobId: 'non-live-failed',
      url: 'https://cdn.example/playlist.m3u8',
      ext: 'mp4',
      live: false,
      headers: {},
    }, {}, resolve);
  });
  ok(result && result.error, 'non-live ffmpeg failure is reported even when output exists');
  ok(typeof factoryCalls[0].printErr === 'function', 'routine ffmpeg stderr is intercepted instead of becoming extension errors');
  ok(typeof factoryCalls[0].print === 'function', 'routine ffmpeg stdout is intercepted instead of flooding the console');
  ok(keepaliveMessages.length > 0, 'offscreen media work keeps the service worker alive after the popup closes');
  eq(keepaliveDisconnects, 1, 'media-job keepalive closes after ffmpeg finishes');
  eq(result && result.url, undefined, 'non-live ffmpeg failure does not return a download URL');
  eq(exited, 1, 'failed ffmpeg instance is cleaned up');

  fetchProbe = true;
  const nested = await new Promise(function (resolve) {
    listener({
      type: 'ms-offscreen-ffmpeg-run',
      jobId: 'nested-fetch',
      url: 'https://page.example/playlist.m3u8',
      ext: 'mp4',
      live: false,
      headers: {
        Authorization: 'Bearer test-token',
        Referer: 'https://page.example/watch',
        Origin: 'https://page.example',
      },
    }, {}, resolve);
  });
  ok(nested && nested.url, 'fake LibAV nested fetch produces an output');
  eq(fetchCalls.length, 1, 'LibAV nested fetch reached the offscreen fetch context');
  const nestedCall = fetchCalls[0] || { options: {} };
  const nestedHeaders = nestedCall.options.headers || {};
  eq(nestedCall.options.credentials, 'include', 'nested LibAV fetch preserves cookies');
  eq(nestedHeaders.Authorization, 'Bearer test-token', 'nested LibAV fetch receives active headers');
  eq(nestedHeaders.Referer, 'https://page.example/watch', 'same-origin nested fetch keeps Referer');
  eq(nestedHeaders.Origin, 'https://page.example', 'same-origin nested fetch keeps Origin');
  eq(exited, 2, 'nested fetch ffmpeg instance is cleaned up');

  delayFactory = true;
  let earlyStopRun = null;
  listener({
    type: 'ms-offscreen-ffmpeg-run',
    jobId: 'stop-during-startup',
    url: 'https://page.example/live.m3u8',
    ext: 'mp4',
    live: true,
    headers: {},
  }, {}, function (response) { earlyStopRun = response; });
  await Promise.resolve();
  let earlyStop = null;
  listener({ type: 'ms-offscreen-ffmpeg-abort', jobId: 'stop-during-startup' }, {}, function (response) {
    earlyStop = response;
  });
  ok(earlyStop && earlyStop.ok, 'Stop during LibAV startup is acknowledged');
  const callsBeforeStartupStop = ffmpegCalls;
  delayFactory = false;
  resolveFactory(libav);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  ok(earlyStopRun && earlyStopRun.error, 'pending startup Stop terminates the job instead of continuing to record');
  eq(ffmpegCalls, callsBeforeStartupStop, 'ffmpeg is not started after an acknowledged startup Stop');

  delayWriter = true;
  let writerStopRun = null;
  listener({
    type: 'ms-offscreen-ffmpeg-run',
    jobId: 'stop-during-writer-setup',
    url: 'https://page.example/live-writer.m3u8',
    ext: 'mp4',
    live: true,
    headers: {},
  }, {}, function (response) { writerStopRun = response; });
  for (let i = 0; i < 4; i++) await Promise.resolve();
  let writerStop = null;
  listener({ type: 'ms-offscreen-ffmpeg-abort', jobId: 'stop-during-writer-setup' }, {}, function (response) {
    writerStop = response;
  });
  ok(writerStop && writerStop.ok, 'Stop during writer setup is acknowledged');
  const callsBeforeWriterStop = ffmpegCalls;
  delayWriter = false;
  resolveWriter();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  ok(writerStopRun && writerStopRun.error, 'pending writer-setup Stop terminates the job');
  eq(ffmpegCalls, callsBeforeWriterStop, 'ffmpeg is not started after a writer-setup Stop');

  const messagesBeforeLease = keepaliveMessages.length;
  const disconnectsBeforeLease = keepaliveDisconnects;
  let acquired = null;
  listener({ type: 'ms-offscreen-keepalive-acquire', leaseId: 'manifest-job' }, {}, function (response) { acquired = response; });
  ok(acquired && acquired.ok, 'service worker can acquire a pre-offscreen keepalive lease');
  ok(keepaliveMessages.length > messagesBeforeLease, 'acquired lease sends a heartbeat');
  let released = null;
  listener({ type: 'ms-offscreen-keepalive-release', leaseId: 'manifest-job' }, {}, function (response) { released = response; });
  ok(released && released.ok, 'service worker can release its keepalive lease');
  eq(keepaliveDisconnects, disconnectsBeforeLease + 1, 'released lease disconnects its keepalive port');
  report('offscreen-regressions');
})().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
