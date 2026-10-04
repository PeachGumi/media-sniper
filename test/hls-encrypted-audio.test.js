'use strict';
const fs = require('fs');
const vm = require('vm');
const { eq, ok, report } = require('./harness.js');
const source = fs.readFileSync(require.resolve('../src/offscreen.js'), 'utf8')
  .replace("import LibAVFactory from './libav/libav-6.5.7.1-h264-aac-mp3.wasm.mjs';", 'const LibAVFactory = globalThis.__LibAVFactory;');

function makeEnv(options) {
  options = options || {};
  let listener;
  const calls = [], writes = [], sinks = [], revoked = [], statuses = [];
  let factories = 0, disconnected = 0;
  const devices = new Set();
  const libav = {
    async mkwriterdev(name) { devices.add(name); },
    async unlink(name) { devices.delete(name); },
    async writeFile(name, bytes) { writes.push({ name, text: new TextDecoder().decode(bytes) }); },
    mkblockreaderdev(name) {
      if (devices.has(name)) throw new Error('reader device already exists: ' + name);
      devices.add(name);
    },
    ff_block_reader_dev_send() {},
    async ffmpeg(args) {
      calls.push(Array.from(args));
      listener({ type: 'ms-offscreen-ffmpeg-status' }, {}, function (s) { statuses.push(s); });
      const output = args[args.length - 1];
      if (output === 'hls-a.m4a') {
        if (options.abortAudio) listener({ type: 'ms-offscreen-ffmpeg-abort', jobId: 'encrypted-audio' }, {}, function () {});
        if (options.audioFailure) return -1094995529;
        if (options.disk !== false) this.onwrite(output, 0, new Uint8Array([1, 2, 3, 4]));
      } else {
        if (options.videoFailure) return -1;
        this.onwrite(output, 0, new Uint8Array([5, 6, 7, 8]));
      }
      return 0;
    },
    exit() {},
  };
  class TestURL extends URL {}
  TestURL.createObjectURL = function () { return 'blob:memory/final'; };
  TestURL.revokeObjectURL = function (url) { revoked.push(url); };
  const context = vm.createContext({
    console, URL: TestURL, Blob, Uint8Array, ArrayBuffer, TextEncoder, Promise,
    setInterval() { return 1; }, clearInterval() {}, setTimeout, clearTimeout,
    fetch: async function () { throw new Error('test should not fetch raw ciphertext'); },
    chrome: { runtime: {
      getURL(path) { return 'chrome-extension://test/' + path; },
      onMessage: { addListener(fn) { listener = fn; } },
      sendMessage() { return Promise.resolve(); },
      connect() { return { postMessage() {}, disconnect() { disconnected++; } }; },
    } },
    __LibAVFactory: async function () { factories++; return libav; },
  });
  if (options.disk !== false) context.MediaSniperStreamingPolicy = {
    async createOutputSink(ext) {
      const sink = { ext, size: 0, aborted: false, finished: false };
      sinks.push(sink);
      return {
        write(name, position, data) { sink.size = Math.max(sink.size, position + data.byteLength); },
        bytes() { return sink.size; },
        async finish() { sink.finished = true; return { url: 'blob:disk/' + ext, size: sink.size }; },
        async abort() { sink.aborted = true; },
      };
    },
    async fileForUrl() { return { size: 4 }; },
    async readFileRange() { return new Uint8Array(4); },
  };
  vm.runInContext(source, context, { filename: 'offscreen.js' });
  return {
    calls, writes, sinks, revoked, statuses,
    factories() { return factories; }, disconnected() { return disconnected; },
    status() {
      let status;
      listener({ type: 'ms-offscreen-ffmpeg-status' }, {}, function (s) { status = s; });
      return status;
    },
    run() {
      return new Promise(function (resolve) {
        listener({
          type: 'ms-offscreen-ffmpeg-run', jobId: 'encrypted-audio',
          url: 'https://cdn.example/video.m3u8', audioUrl: 'https://cdn.example/audio.m3u8',
          playlistText: '#EXTM3U\n#EXTINF:2,\njsfetch:https://cdn.example/video.ts\n#EXT-X-ENDLIST\n',
          audioPlaylistText: '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="jsfetch:https://cdn.example/key.bin"\n#EXTINF:2,\njsfetch:https://cdn.example/audio.ts\n#EXT-X-ENDLIST\n',
          ext: 'mp4', live: false, headers: {},
        }, {}, resolve);
      });
    },
  };
}

(async function () {
  const env = makeEnv();
  const result = await env.run();
  eq(env.calls.length, 2, 'encrypted separate audio is demuxed before the video mux');
  const audio = env.calls[0] || [], mux = env.calls[1] || [];
  ok(audio.includes('hls-a.m3u8') && audio[audio.length - 1] === 'hls-a.m4a', 'first FFmpeg pass turns the audio playlist into a local track');
  ok(audio.includes('-nostdin') && audio.includes('0:a:0'), 'audio pass is noninteractive and requires a real audio stream');
  ok(mux.includes('hls-v.m3u8') && mux.includes('hls-a.m4a'), 'second pass combines network video with local decrypted audio');
  ok(!mux.includes('jsfetch:https://cdn.example/audio.m3u8'), 'two network inputs are never opened together');
  eq(env.factories(), 1, 'both passes share one reserved FFmpeg job');
  ok(env.statuses.length === 2 && env.statuses.every(s => s.running && s.jobId === 'encrypted-audio' && !s.done),
    'recovery sees the same running job until the complete video artifact exists');
  eq(result && result.url, 'blob:disk/mp4', 'only the final video artifact is returned');
  ok(env.sinks.some(s => s.ext === 'm4a' && s.finished), 'decrypted audio stays disk-backed');
  eq(env.revoked.join(','), 'blob:disk/m4a', 'temporary decrypted audio is released after muxing');
  eq(env.disconnected(), 1, 'keepalive covers both passes and closes once');

  const memory = makeEnv({ disk: false });
  const memoryResult = await memory.run();
  eq(memory.calls.length, 2, 'OPFS-unavailable fallback still decrypts before muxing');
  eq(memoryResult && memoryResult.url, 'blob:memory/final', 'MEMFS fallback returns only the final artifact');

  const failedAudio = makeEnv({ audioFailure: true });
  const audioError = await failedAudio.run();
  eq(failedAudio.status().running, false, 'failure response is sent only after releasing the reserved audio job');
  await new Promise(function (resolve) { setImmediate(resolve); });
  eq(failedAudio.calls.length, 1, 'failed audio preparation never opens the video input');
  ok(audioError && audioError.error && audioError.error.includes('audio ffmpeg failed'), 'audio preparation failure is reported as such');
  eq(audioError && audioError.url, undefined, 'audio preparation failure cannot look like a completed video');
  ok(failedAudio.sinks.every(s => s.aborted), 'failed preparation discards both temporary outputs');

  const failedVideo = makeEnv({ videoFailure: true });
  const videoError = await failedVideo.run();
  eq(videoError && videoError.url, undefined, 'failed final mux is not accepted');
  eq(failedVideo.revoked.join(','), 'blob:disk/m4a', 'a failed final mux still releases decrypted audio');

  const stopped = makeEnv({ abortAudio: true });
  const stoppedResult = await stopped.run();
  await new Promise(function (resolve) { setImmediate(resolve); });
  eq(stopped.calls.length, 1, 'Stop during audio preparation prevents the video pass');
  ok(stoppedResult && stoppedResult.error && !stoppedResult.url, 'stopped audio preparation returns no artifact');
  ok(stopped.sinks.every(s => s.aborted), 'Stop discards the temporary audio and video outputs');
  report('hls-encrypted-audio');
})().catch(function (err) { console.error(err); process.exitCode = 1; });
