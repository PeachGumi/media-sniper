'use strict';
const fs = require('fs');
const vm = require('vm');
const { eq, ok, report } = require('./harness.js');

class FakeFile {
  constructor(bytes, type) {
    this._bytes = Uint8Array.from(bytes || []);
    this.size = this._bytes.byteLength;
    this.type = type || '';
  }
  async arrayBuffer() {
    return this._bytes.buffer.slice(this._bytes.byteOffset, this._bytes.byteOffset + this._bytes.byteLength);
  }
}

class FakeHandle {
  constructor(name) { this.name = name; this.bytes = []; this.closed = false; this.writes = []; this.size = 0; }
  async createWritable() {
    const self = this;
    return {
      async write(chunk) {
        if (stallWrites) return new Promise(function () { /* file system never drains */ });
        if (chunk && chunk.type === 'write') {
          self.writes.push({ position: chunk.position, data: Uint8Array.from(chunk.data) });
          const end = Number(chunk.position) + chunk.data.byteLength;
          self.size = Math.max(self.size, end);
          if (sparseWrites) return;
          for (let i = self.bytes.length; i < end; i++) self.bytes.push(0);
          for (let i = 0; i < chunk.data.byteLength; i++) self.bytes[chunk.position + i] = chunk.data[i];
          return;
        }
        const arr = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        for (const b of arr) self.bytes.push(b);
        self.size = Math.max(self.size, self.bytes.length);
      },
      async close() { self.closed = true; },
      async abort() { self.bytes = []; self.size = 0; self.closed = true; },
    };
  }
  async getFile() {
    const file = new FakeFile(this.bytes);
    if (this.size > file.size) file.size = this.size;
    return file;
  }
}

// A "big" artifact is only counted, never materialized: sparse mode keeps the
// fake browser process from allocating the equivalent of the real file.
let sparseWrites = false;
// A stalled file system: writes never settle, so the sink's queue grows.
let stallWrites = false;

const files = new Map();
const removed = [];
const root = {
  async getFileHandle(name) {
    const h = new FakeHandle(name);
    files.set(name, h);
    return h;
  },
  async removeEntry(name) { removed.push(name); files.delete(name); },
};

let rawListener = null;
let nextUrl = 1;
const createdObjects = [];
const revoked = [];
const progress = [];
const responses = new Map();
const keepaliveMessages = [];
let keepaliveDisconnects = 0;

function makeResponse(bytes, declared) {
  const data = Uint8Array.from(bytes);
  let offset = 0;
  return {
    ok: true,
    status: 200,
    headers: { get(name) { return name.toLowerCase() === 'content-length' ? String(declared == null ? data.length : declared) : null; } },
    body: {
      getReader() {
        return {
          async read() {
            if (offset >= data.length) return { done: true };
            const end = Math.min(data.length, offset + 2);
            const value = data.slice(offset, end);
            offset = end;
            return { done: false, value };
          },
          async cancel() { offset = data.length; },
          releaseLock() {},
        };
      },
      async cancel() { offset = data.length; },
    },
    async arrayBuffer() { return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength); },
  };
}

const fakeChrome = {
  runtime: {
    onMessage: { addListener(fn) { rawListener = fn; } },
    sendMessage(msg) { progress.push(msg); return Promise.resolve(); },
    connect() {
      return {
        postMessage(message) { keepaliveMessages.push(message); },
        disconnect() { keepaliveDisconnects++; },
      };
    },
  },
};
const context = vm.createContext({
  console,
  chrome: fakeChrome,
  navigator: { storage: { async getDirectory() { return root; } } },
  URL: {
    createObjectURL(file) {
      createdObjects.push(file);
      return 'blob:opfs/' + (nextUrl++) + '?size=' + file.size;
    },
    revokeObjectURL(url) { revoked.push(url); },
  },
  fetch: async function (url) {
    if (!responses.has(url)) throw new Error('no fixture ' + url);
    return responses.get(url)();
  },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Map,
  Date,
  Number,
  Math,
  Uint8Array,
  ArrayBuffer,
  Blob,
  RangeError,
  Error,
  globalThis: null,
  addEventListener() {},
});
context.globalThis = context;

const source = fs.readFileSync(require.resolve('../src/offscreen-streaming.js'), 'utf8');
vm.runInContext(source, context, { filename: 'offscreen-streaming.js' });
const policy = context.MediaSniperStreamingPolicy;
ok(!!policy, 'streaming policy installed');
eq(policy.MAX_DISK_ASSEMBLY_BYTES, 768 * 1024 * 1024, 'disk assembly cap fixed');
eq(policy.MAX_MUX_INPUT_BYTES, 384 * 1024 * 1024, 'mux memory budget fixed');
eq(policy.hasOpfs(), true, 'OPFS detected');

let originalCalls = [];
context.chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  originalCalls.push(msg);
  if (msg.type === 'ms-offscreen-mux-local') {
    sendResponse({ url: 'blob:mux/output', size: 99 });
    return true;
  }
  sendResponse({ passthrough: true });
  return false;
});
ok(typeof rawListener === 'function', 'legacy listener wrapped');

function dispatch(msg) {
  return new Promise((resolve) => {
    let settled = false;
    const ret = rawListener(msg, { id: 'extid' }, function (r) {
      settled = true;
      resolve({ ret, response: r });
    });
    if (ret !== true && !settled) resolve({ ret, response: null });
  });
}

(async function () {
  responses.set('https://x/one', () => makeResponse([1, 2, 3]));
  responses.set('https://x/two', () => makeResponse([4, 5]));
  const hls = await dispatch({
    type: 'ms-offscreen-hls-build',
    playlistUrl: 'https://x/master.m3u8',
    segments: ['https://x/one', 'https://x/two'],
    mime: 'audio/aac',
  });
  ok(hls.response && /^blob:opfs\//.test(hls.response.url), 'HLS concat returns disk-backed File URL');
  eq(hls.response.size, 5, 'HLS concat size');
  eq(originalCalls.length, 0, 'streamable HLS bypasses legacy full-buffer handler');
  eq(progress.filter((m) => m.type === 'ms-hls-progress').length, 2, 'HLS progress emitted per segment');
  eq(progress.filter((m) => m.type === 'ms-hls-progress').slice(-1)[0].bytes, 5, 'HLS progress reports bytes fetched so far');
  ok(keepaliveMessages.length > 0, 'OPFS HLS keeps the service worker alive while the popup is closed');
  await new Promise(function (resolve) { setImmediate(resolve); });
  eq(keepaliveDisconnects, 1, 'OPFS HLS releases its keepalive after completion');
  eq(policy.ownedTempCount(), 1, 'OPFS temp owned by returned URL');
  context.URL.revokeObjectURL(hls.response.url);
  eq(policy.ownedTempCount(), 0, 'revoke drops OPFS ownership');
  ok(revoked.includes(hls.response.url), 'underlying Blob URL revoked');

  responses.set('https://x/v-init', () => makeResponse([10]));
  responses.set('https://x/v-1', () => makeResponse([11, 12]));
  responses.set('https://x/a-init', () => makeResponse([20]));
  responses.set('https://x/a-1', () => makeResponse([21]));
  const dash = await dispatch({
    type: 'ms-offscreen-dash-build',
    playlistUrl: 'https://x/main.mpd',
    video: { type: 'video', initUrl: 'https://x/v-init', segments: ['https://x/v-1'] },
    audio: { type: 'audio', initUrl: 'https://x/a-init', segments: ['https://x/a-1'] },
    headers: {},
  });
  eq(dash.response.url, 'blob:mux/output', 'DASH hands disk-backed tracks to legacy mux only');
  eq(originalCalls.length, 1, 'only local mux reaches legacy handler');
  eq(originalCalls[0].type, 'ms-offscreen-mux-local', 'synthetic operation is local mux');
  ok(/^blob:opfs\//.test(originalCalls[0].videoUrl), 'video mux input is OPFS File URL');
  ok(/^blob:opfs\//.test(originalCalls[0].audioUrl), 'audio mux input is OPFS File URL');
  eq(progress.filter((m) => m.playlistUrl === 'https://x/main.mpd').slice(-1)[0].bytes, 5, 'DASH progress reports cumulative bytes across both tracks');
  eq(policy.ownedTempCount(), 0, 'temporary DASH track files released after mux response');

  const beforeSingleDashObjects = createdObjects.length;
  const singleDash = await dispatch({
    type: 'ms-offscreen-dash-build',
    playlistUrl: 'https://x/single.mpd',
    video: { type: 'video', initUrl: 'https://x/v-init', segments: ['https://x/v-1'] },
    headers: {},
  });
  const singleDashObjects = createdObjects.slice(beforeSingleDashObjects);
  const singleDashBlob = singleDashObjects.find(function (object) { return object instanceof Blob; });
  ok(!!singleDashBlob, 'single-track DASH returns an in-memory Blob');
  eq(singleDashBlob && singleDashBlob.type, 'video/mp4', 'single-track DASH Blob is typed as video/mp4');

  responses.set('https://x/too-big', () => makeResponse([1], policy.MAX_DISK_ASSEMBLY_BYTES + 1));
  const tooBig = await dispatch({ type: 'ms-offscreen-fetch-blob', url: 'https://x/too-big' });
  ok(tooBig.response && /supported assembly limit/.test(tooBig.response.error), 'known oversize resource fails before buffering');

  // Unknown Content-Length still stops while streaming as soon as the byte
  // budget is exceeded. Use the exported helper with a tiny synthetic budget
  // so the test never allocates a huge fixture.
  const writes = [];
  const writable = { async write(v) { writes.push(v.byteLength); } };
  let streamThrew = false;
  try {
    await policy.streamResponseInto(writable, makeResponse([1, 2, 3, 4], 0), 3, { bytes: 0 });
  } catch (e) {
    streamThrew = e && e.name === 'RangeError';
  }
  ok(streamThrew, 'unknown-size stream stops at runtime byte budget');

  // ---------------------------------------------------------------------
  // ffmpeg output sink: the artifact is written to disk as the muxer produces
  // it, so a large item no longer has to be assembled in memory (the failure
  // behind "media output exceeds in-memory safety limit (768 MiB)").
  // ---------------------------------------------------------------------
  const filesBeforeSink = files.size;
  const tempsBeforeSink = policy.ownedTempCount();
  const blobsBeforeSink = createdObjects.filter(function (o) { return o instanceof Blob }).length;
  const sink = await policy.createOutputSink('mp4');
  ok(!!sink, 'ffmpeg output sink is created from OPFS');
  eq(files.size, filesBeforeSink + 1, 'sink owns exactly one temporary OPFS file');
  ok(/^media-sniper-/.test(sink.name) && /\.mp4$/.test(sink.name), 'temp artifact keeps the requested extension');

  const sinkHandle = files.get(sink.name);
  eq(sink.bytes(), 0, 'sink starts empty');
  sink.write('out.mp4', 0, new Uint8Array([1, 2, 3, 4]));
  sink.write('out.mp4', 4000000, new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]));
  sink.write('out.mp4', 100, new Uint8Array([7, 7]));
  eq(sink.writes(), 3, 'every muxer write is accounted for');
  eq(sink.bytes(), 4000008, 'sink reports the highest written offset, not a chunk sum');
  const finished = await sink.finish();
  eq(sinkHandle.writes.length, 3, 'all queued writes reached the file system stream');
  eq(sinkHandle.writes.map(function (w) { return w.position }).join(','), '0,4000000,100',
    'writes keep their muxer offsets (mp4 rewrites its header in place)');
  eq(sinkHandle.closed, true, 'finishing closes the file system stream');
  eq(finished.size, 4000008, 'finished artifact reports its final size');
  ok(/^blob:opfs\//.test(finished.url), 'finished artifact is handed back as a disk-backed File URL');
  eq(createdObjects.filter(function (o) { return o instanceof Blob }).length, blobsBeforeSink,
    'no in-memory Blob is built for the artifact');
  eq(policy.ownedTempCount(), tempsBeforeSink + 1, 'finished artifact owns its temporary file until the download completes');
  context.URL.revokeObjectURL(finished.url);
  eq(policy.ownedTempCount(), tempsBeforeSink, 'download completion releases the temporary artifact');
  await new Promise(function (resolve) { setImmediate(resolve); });
  ok(removed.indexOf(finished.name) >= 0, 'released artifact file is deleted from OPFS');

  const abortedSink = await policy.createOutputSink('mp4');
  abortedSink.write('out.mp4', 0, new Uint8Array([1, 2]));
  eq(await abortedSink.abort(), true, 'abort acknowledges the thrown-away artifact');
  ok(removed.indexOf(abortedSink.name) >= 0, 'aborted artifact file is deleted from OPFS');
  eq(policy.ownedTempCount(), tempsBeforeSink, 'aborted artifact keeps no ownership');

  // Artifacts far beyond the in-memory guard stream through untouched. Only
  // offsets are tracked, so this asserts the accounting without allocating.
  sparseWrites = true;
  // The 900 MiB artifact is accounted for with tiny chunks, so this sink gets an
  // explicit budget instead of the production queue cap.
  const bigSink = await policy.createOutputSink('mp4', 2048 * 1024 * 1024);
  const chunk = new Uint8Array(1024 * 1024);
  for (let i = 0; i < 900; i++) bigSink.write('out.mp4', i * chunk.byteLength, chunk);
  eq(bigSink.bytes(), 900 * 1024 * 1024, 'sink tracks a 900 MiB artifact');
  ok(bigSink.bytes() > 768 * 1024 * 1024, 'artifact size passes the old in-memory ceiling');
  const bigFinished = await bigSink.finish();
  eq(bigFinished.size, 900 * 1024 * 1024, 'oversized artifact is finalized from disk, not from a Blob');
  sparseWrites = false;
  context.URL.revokeObjectURL(bigFinished.url);

  // A stalled file system must fail the job instead of queueing the artifact in
  // the heap. The budget is injectable so the test can trip it without
  // allocating hundreds of megabytes.
  stallWrites = true;
  const cappedSink = await policy.createOutputSink('mp4', 4096);
  cappedSink.write('out.mp4', 0, new Uint8Array(1024));
  eq(cappedSink.pendingBytes(), 1024, 'queued write bytes are accounted for');
  cappedSink.write('out.mp4', 1024, new Uint8Array(4096));
  ok(cappedSink.pendingBytes() > 4096, 'pending bytes can exceed the budget');
  let capError = null;
  try { await cappedSink.finish(); } catch (e) { capError = e; }
  ok(capError && /cannot keep up/.test(capError.message), 'a stalled writer fails the job instead of hanging');
  ok(removed.indexOf(cappedSink.name) >= 0, 'stalled artifact is discarded from OPFS');
  stallWrites = false;

  // An offset that cannot be trusted must be reported, never guessed.
  const offsetSink = await policy.createOutputSink('mp4');
  offsetSink.write('out.mp4', NaN, new Uint8Array(4));
  eq(offsetSink.bytes(), 0, 'an invalid offset writes nothing');
  let offsetError = null;
  try { await offsetSink.finish(); } catch (e) { offsetError = e; }
  ok(offsetError && /invalid output offset/.test(offsetError.message), 'an invalid muxer offset fails the job');

  // Muxer chunks are merged into one file-system write per contiguous run: one
  // round trip per muxer chunk could not keep up with a real 1.2 GB remux.
  const batchSink = await policy.createOutputSink('mp4');
  const batchHandle = files.get(batchSink.name);
  batchSink.write('out.mp4', 0, new Uint8Array([1, 2]));
  batchSink.write('out.mp4', 2, new Uint8Array([3, 4, 5]));
  eq(batchHandle.writes.length, 0, 'contiguous chunks are merged instead of written one by one');
  batchSink.write('out.mp4', 1000, new Uint8Array([9]));
  await new Promise(function (resolve) { setImmediate(resolve); });
  eq(batchHandle.writes.length, 1, 'a non-contiguous offset flushes the merged run first');
  eq(batchHandle.writes[0].position, 0, 'merged run keeps its start offset');
  eq(Array.from(batchHandle.writes[0].data).join(','), '1,2,3,4,5', 'merged run holds every chunk in order');
  const batchFinished = await batchSink.finish();
  eq(batchHandle.writes.length, 2, 'the tail of the artifact is flushed on finish');
  eq(batchHandle.writes[1].position, 1000, 'flushed tail keeps its offset');
  eq(batchFinished.size, 1001, 'batched artifact reports its final size');
  context.URL.revokeObjectURL(batchFinished.url);

  report('offscreen-streaming');
})().catch(function (e) {
  console.error(e);
  process.exitCode = 1;
});
