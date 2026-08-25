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
  constructor(name) { this.name = name; this.bytes = []; this.closed = false; }
  async createWritable() {
    const self = this;
    return {
      async write(chunk) {
        const arr = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        for (const b of arr) self.bytes.push(b);
      },
      async close() { self.closed = true; },
      async abort() { self.bytes = []; self.closed = true; },
    };
  }
  async getFile() { return new FakeFile(this.bytes); }
}

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
const revoked = [];
const progress = [];
const responses = new Map();

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
  },
};
const context = vm.createContext({
  console,
  chrome: fakeChrome,
  navigator: { storage: { async getDirectory() { return root; } } },
  URL: {
    createObjectURL(file) { return 'blob:opfs/' + (nextUrl++) + '?size=' + file.size; },
    revokeObjectURL(url) { revoked.push(url); },
  },
  fetch: async function (url) {
    if (!responses.has(url)) throw new Error('no fixture ' + url);
    return responses.get(url)();
  },
  setTimeout,
  clearTimeout,
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
  eq(policy.ownedTempCount(), 0, 'temporary DASH track files released after mux response');

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

  report('offscreen-streaming');
})().catch(function (e) {
  console.error(e);
  process.exitCode = 1;
});
