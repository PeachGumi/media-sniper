'use strict';
const fs = require('fs');
const vm = require('vm');
const { eq, ok, report } = require('./harness.js');

const source = fs.readFileSync(require.resolve('../src/offscreen.js'), 'utf8')
  .replace("import LibAVFactory from './libav/libav-6.5.7.1-h264-aac-mp3.wasm.mjs';", "const LibAVFactory = globalThis.__LibAVFactory;");
let listener = null;
let exited = 0;
const libav = {
  onwrite: null,
  abortController: { signal: { aborted: false } },
  async mkwriterdev() {},
  async ffmpeg() {
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
  },
};
const context = vm.createContext({
  console,
  chrome: fakeChrome,
  __LibAVFactory: function () { return Promise.resolve(libav); },
  URL: { createObjectURL(blob) { return 'blob:test/' + blob.size; } },
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
  eq(result && result.url, undefined, 'non-live ffmpeg failure does not return a download URL');
  eq(exited, 1, 'failed ffmpeg instance is cleaned up');
  report('offscreen-regressions');
})().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
