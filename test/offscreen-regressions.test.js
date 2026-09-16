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
let sinkJob = false;
const sinkWrites = [];
let sinkAborted = false;
let muxJob = false;
let liveRun = false;
let liveFfmpegResolve = null;
const jsfetchCancels = [];
const ffmpegArgs = [];
const blockDevices = [];
const blockReads = [];
const writeFiles = [];
let offscreenGlobal = null;
const libav = {
  onwrite: null,
  onblockread: null,
  abortController: { signal: { aborted: false } },
  async mkwriterdev() {
    if (delayWriter) return new Promise(function (resolve) { resolveWriter = resolve; });
  },
  mkblockreaderdev(name, size) { blockDevices.push({ name: name, size: size }); },
  ff_block_reader_dev_send(name, position, data, opts) {
    blockReads.push({ name: name, position: position, bytes: data ? data.byteLength : 0, error: (opts && opts.error) || null });
  },
  async writeFile(name) { writeFiles.push(name); },
  async ffmpeg() {
    ffmpegCalls++;
    ffmpegArgs.push(Array.prototype.slice.call(arguments[0] || []));
    if (liveRun) {
      // a live recording writes and then keeps running until it is stopped
      this.onwrite('out.mp4', 0, new Uint8Array([1, 1, 1, 1]));
      return new Promise(function (resolve) { liveFfmpegResolve = resolve; });
    }
    if (muxJob) {
      // ffmpeg reads its inputs through the block reader device, and libav
      // reports the MEMFS node name (basename), not the path.
      this.onblockread('v.mp4', 1024, 64);
      await new Promise(function (resolve) { setImmediate(resolve); });
      this.onwrite('out.mp4', 0, new Uint8Array([7, 7, 7]));
      return 0;
    }
    if (sinkJob) {
      this.onwrite('out.mp4', 0, new Uint8Array([1, 2, 3, 4]));
      this.onwrite('out.mp4', 1000, new Uint8Array([5, 6]));
      // Fire the running job's progress timer the way the browser would.
      const timer = intervals[intervals.length - 1];
      if (typeof timer === 'function') timer();
      return 0;
    }
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
const sentMessages = [];
const intervals = [];
let objectUrlsCreated = 0;
const fakeChrome = {
  runtime: {
    getURL(path) { return 'chrome-extension://test/' + path; },
    onMessage: { addListener(fn) { listener = fn; } },
    sendMessage(message) { sentMessages.push(message); return Promise.resolve(); },
    connect() {
      return {
        postMessage(message) { keepaliveMessages.push(message); },
        disconnect() { keepaliveDisconnects++; },
      };
    },
  },
};
const URLCtor = URL;
URLCtor.createObjectURL = function (blob) { objectUrlsCreated++; return 'blob:test/' + blob.size; };
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
  setInterval(fn) { intervals.push(fn); return intervals.length; },
  clearInterval() {},
  setTimeout,
  clearTimeout,
  setImmediate,
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

  // ------------------------------------------------------------------
  // Disk-backed output: when the OPFS sink is available, the artifact is
  // written as ffmpeg produces it. Nothing is assembled in memory, and the
  // progress message reports written bytes instead of the (nonexistent)
  // ffmpeg out-time API that used to report 0s/0B for the whole job.
  // ------------------------------------------------------------------
  context.MediaSniperStreamingPolicy = {
    createOutputSink: async function () {
      return {
        name: 'media-sniper-test.mp4',
        write: function (name, position, data) { sinkWrites.push({ position: position, length: data.byteLength }); },
        bytes: function () { return sinkWrites.reduce(function (max, w) { return Math.max(max, w.position + w.length); }, 0); },
        writes: function () { return sinkWrites.length; },
        finish: async function () { return { url: 'blob:opfs/finished.mp4', size: 1002, name: 'media-sniper-test.mp4', file: { size: 1002 } }; },
        abort: async function () { sinkAborted = true; return true; },
      };
    },
    MAX_MUX_INPUT_BYTES: 384 * 1024 * 1024,
    fileForUrl: async function (url) {
      if (url === 'blob:opfs/video') return { size: 5000, name: url };
      if (url === 'blob:opfs/audio') return { size: 4000, name: url };
      return null;
    },
    readFileRange: async function (file, position, length) {
      const size = Number(file.size) || 0;
      const start = Math.max(0, Number(position) || 0);
      const end = Math.min(size, start + Math.max(1, Number(length) || 1));
      return new Uint8Array(Math.max(0, end - start));
    },
  };
  sinkJob = true;
  const urlsBeforeSinkJob = objectUrlsCreated;
  const progressBefore = sentMessages.length;
  const sinkResult = await new Promise(function (resolve) {
    listener({
      type: 'ms-offscreen-ffmpeg-run',
      jobId: 'disk-backed-job',
      url: 'https://cdn.example/big.m3u8',
      ext: 'mp4',
      live: false,
      headers: {},
    }, {}, resolve);
  });
  eq(sinkResult && sinkResult.url, 'blob:opfs/finished.mp4', 'disk-backed output is handed back as the sink URL');
  eq(sinkResult && sinkResult.size, 1002, 'disk-backed output reports the artifact size');
  eq(sinkAborted, false, 'a successful job does not discard its artifact');
  eq(objectUrlsCreated, urlsBeforeSinkJob, 'no in-memory Blob URL is created for the artifact');
  eq(sinkWrites.length, 2, 'both muxer writes reached the sink');
  eq(sinkWrites[0].position + ',' + sinkWrites[1].position, '0,1000', 'muxer offsets are preserved for the file writer');
  const progressAfter = sentMessages.slice(progressBefore).filter(function (m) { return m && m.type === 'ms-offscreen-progress'; });
  eq(progressAfter.length, 1, 'progress is reported while the job runs');
  eq(progressAfter[0] && progressAfter[0].jobId, 'disk-backed-job', 'progress is attributed to the running job');
  eq(progressAfter[0] && progressAfter[0].bytes, 1002, 'progress reports the bytes written to disk, not the removed out-time API');
  eq(progressAfter[0] && progressAfter[0].fetches, 0, 'progress reports the job-scoped fetch counter');

  // Stopping a job that already opened its disk-backed artifact must discard
  // the partial file instead of leaving it in OPFS.
  sinkAborted = false;
  delayWriter = true;
  let stoppedSinkRun = null;
  listener({
    type: 'ms-offscreen-ffmpeg-run',
    jobId: 'disk-backed-stop',
    url: 'https://cdn.example/live.m3u8',
    ext: 'mp4',
    live: true,
    headers: {},
  }, {}, function (response) { stoppedSinkRun = response; });
  for (let i = 0; i < 4; i++) await Promise.resolve();
  let sinkStopAck = null;
  listener({ type: 'ms-offscreen-ffmpeg-abort', jobId: 'disk-backed-stop' }, {}, function (response) {
    sinkStopAck = response;
  });
  ok(sinkStopAck && sinkStopAck.ok, 'Stop during a disk-backed writer setup is acknowledged');
  delayWriter = false;
  resolveWriter();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise(function (resolve) { setImmediate(resolve); });
  ok(stoppedSinkRun && stoppedSinkRun.error, 'stopped disk-backed job reports an error instead of a URL');
  ok(sinkAborted, 'stopped disk-backed job discards its partial artifact');

  // Mux inputs are read from disk through libav's block reader device instead
  // of being copied into MEMFS, so the combined input size is no longer a
  // memory budget.
  muxJob = true;
  const muxResult = await new Promise(function (resolve) {
    listener({
      type: 'ms-offscreen-mux-local',
      jobId: 'disk-inputs',
      videoUrl: 'blob:opfs/video',
      audioUrl: 'blob:opfs/audio',
      ext: 'mp4',
    }, {}, resolve);
  });
  muxJob = false;
  eq(writeFiles.length, 0, 'mux inputs are not copied into MEMFS');
  eq(blockDevices.length, 2, 'both tracks register as block reader devices');
  eq(blockDevices.map(function (d) { return d.name + ':' + d.size; }).join(','), 'v.mp4:5000,a.m4a:4000',
    'devices are registered under bare node names with the real track sizes');
  const muxArgs = ffmpegArgs[ffmpegArgs.length - 1] || [];
  eq(muxArgs.join(' ').indexOf('-i v.mp4 -i a.m4a') >= 0, true,
    'ffmpeg receives the same bare names the devices were registered under');
  ok(blockReads.some(function (r) { return r.name === 'v.mp4' && r.position === 1024 && r.bytes > 0; }),
    'block reader serves the requested range from disk (node name, not path)');
  ok(muxResult && muxResult.url, 'disk-backed mux produces an artifact');

  // Stopping a live recording must actually interrupt the running ffmpeg. This
  // libav build has no ffmpeg_interrupt and no module-level abortController, so
  // the interrupt cancels the jsfetch responses the demuxer is reading from and
  // refuses further requests.
  libav.libavjsJSFetch = {
    fetches: {
      1: {
        reader: { cancel() { jsfetchCancels.push('reader'); } },
        abortController: { abort() { jsfetchCancels.push('signal'); } },
      },
    },
  };
  liveRun = true;
  let liveRunResponse = null;
  listener({
    type: 'ms-offscreen-ffmpeg-run',
    jobId: 'live-interrupt',
    url: 'https://cdn.example/live.m3u8',
    ext: 'mp4',
    live: true,
    adtsFix: true,
    headers: {},
  }, {}, function (response) { liveRunResponse = response; });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  ok(typeof liveFfmpegResolve === 'function', 'live ffmpeg instance is running');
  const liveArgs = ffmpegArgs[ffmpegArgs.length - 1] || [];
  eq(liveArgs.indexOf('-bsf:a') >= 0 && liveArgs[liveArgs.indexOf('-bsf:a') + 1] === 'aac_adtstoasc',
    true, 'TS live recording converts ADTS AAC before muxing into fragmented MP4');
  let interruptAck = null;
  listener({ type: 'ms-offscreen-ffmpeg-abort', jobId: 'live-interrupt' }, {}, function (response) {
    interruptAck = response;
  });
  ok(interruptAck && interruptAck.ok, 'Stop is acknowledged while ffmpeg runs');
  eq(interruptAck && interruptAck.cancelled, 1, 'Stop cancels the open jsfetch response');
  eq(jsfetchCancels.join(','), 'reader,signal', 'both the reader and the fetch signal are cancelled');
  const fetchesBeforeStop = fetchCalls.length;
  const refused = await offscreenGlobal.FetchWithRetry('https://cdn.example/segment.ts', {}, 6, 1000, 10, false, null);
  ok(refused && refused.aborted === true, 'a stopped job refuses further fetches');
  eq(fetchCalls.length, fetchesBeforeStop, 'a stopped job does not retry the cancelled requests');
  // The bundled libav jsfetch protocol calls the global fetch, not
  // FetchWithRetry: the refusal has to live there too, otherwise the demuxer
  // keeps reading segments after Stop.
  let stopRefusal = null;
  try { await offscreenGlobal.fetch('https://cdn.example/segment.ts'); } catch (e) { stopRefusal = e; }
  ok(stopRefusal && stopRefusal.name === 'AbortError', 'a stopped job refuses new jsfetch reads');
  eq(fetchCalls.length, fetchesBeforeStop, 'refused reads never reach the network');
  liveRun = false;
  liveFfmpegResolve(-1);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  ok(liveRunResponse && liveRunResponse.url, 'stopped recording still hands back the partial artifact');
  const fetchAfterStop = await offscreenGlobal.fetch('https://cdn.example/next-job.ts');
  ok(!!fetchAfterStop && fetchCalls.length > fetchesBeforeStop, 'a later job fetches normally again');
  report('offscreen-regressions');
})().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
