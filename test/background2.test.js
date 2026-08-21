'use strict';
/* Background feature tests: settings, blacklist/minsize gates,
 * download-all with skip-existing, HLS chain, YouTube mux routing. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { eq, ok, report } = require('./harness.js');

const logicSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'logic.js'), 'utf8');
const bgSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');

function flush() { return new Promise(function (r) { setImmediate(r); }); }

function makeChrome(opts) {
  opts = opts || {};
  const listeners = { onChanged: [], onMessage: [], onRemoved: [], onActivated: [], onWebResponseStarted: [], onSendHeaders: [] };
  const downloads = [];
  let downloadSeq = 1;
  const localStore = Object.assign({}, opts.localStore || {});
  const existingDownloads = (opts.existingDownloads || []).map(function (targetPath, i) {
    return { id: 9000 + i, state: 'complete', exists: true, filename: targetPath };
  });

  const chrome = {
    storage: {
      session: {
        get: function (k) {
          const out = {};
          (Array.isArray(k) ? k : [k]).forEach(function (key) { if (key in (opts.session || {})) out[key] = opts.session[key]; });
          return Promise.resolve(out);
        },
        set: function (obj) { Object.assign(opts.session || {}, obj); return Promise.resolve(); },
      },
      local: {
        get: function (k) {
          const out = {};
          (Array.isArray(k) ? k : [k]).forEach(function (key) { if (key in localStore) out[key] = localStore[key]; });
          return Promise.resolve(out);
        },
        set: function (obj) { Object.assign(localStore, obj); return Promise.resolve(); },
      },
    },
    downloads: {
      onChanged: { addListener: function (fn) { listeners.onChanged.push(fn); } },
      download: function (o, cb) {
        const id = downloadSeq++;
        downloads.push({ id: id, opts: o, done: false });
        if (cb) cb(id);
        return Promise.resolve(id);
      },
      search: function (q, cb) {
        // real API: callback form OR promise form
        if (typeof cb === 'function') { cb(existingDownloads); return undefined; }
        return Promise.resolve(existingDownloads);
      },
      __downloads: downloads,
    },
    runtime: {
      lastError: null,
      onMessage: { addListener: function (fn) { listeners.onMessage.push(fn); } },
      sendMessage: function (msg) {
        if (msg && msg.type === 'ms-offscreen-fetch-blob') {
          return chrome.__ctx.fetch(msg.url, { headers: msg.headers || {} }).then(function (res) {
            if (!res.ok) return { error: 'http ' + res.status };
            return res.arrayBuffer().then(function (buf) {
              return { url: 'blob:fake/fb-' + buf.byteLength, size: buf.byteLength };
            });
          });
        }
        if (msg && msg.type === 'ms-offscreen-mux-local') {
          chrome.__muxCalls.push(msg);
          return Promise.resolve({ url: 'blob:fake/muxed-' + chrome.__muxCalls.length, size: 4242 });
        }
        if (msg && msg.type === 'ms-offscreen-ffmpeg-run') {
          return Promise.resolve({ url: 'blob:fake/ffmpeg-x', size: 1000 });
        }
        if (msg && msg.type === 'ms-offscreen-ffmpeg-status') { return Promise.resolve({ running: false, done: null }); }
        return Promise.resolve(undefined);
      },
    },
    offscreen: { hasDocument: function () { return Promise.resolve(true); }, createDocument: function () { return Promise.resolve(); } },
    tabs: {
      onRemoved: { addListener: function (fn) { listeners.onRemoved.push(fn); } },
      onActivated: { addListener: function (fn) { listeners.onActivated.push(fn); } },
      query: function (q, cb) { cb([{ id: 1 }]); },
      sendMessage: function () { return Promise.resolve({ ok: true }); },
    },
    action: { setBadgeText: function () {} },
    webRequest: {
      onResponseStarted: { addListener: function (fn) { listeners.onWebResponseStarted.push(fn); } },
      onSendHeaders: { addListener: function (fn) { listeners.onSendHeaders.push(fn); } },
    },
    __listeners: listeners,
    __muxCalls: [],
  };
  return chrome;
}

function makeContext(chrome) {
  const ctx = {
    chrome, console, URL, Promise, Date, Math, Blob, ArrayBuffer, Uint8Array,
    fetch: function (url) {
      if (/\.m3u8$/.test(url)) {
        return Promise.resolve({ ok: true, text: function () {
          return Promise.resolve('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nseg0.ts\n#EXT-X-ENDLIST\n');
        } });
      }
      if (/\.mpd(\?|$)/.test(url)) {
        return Promise.resolve({ ok: true, text: function () {
          return Promise.resolve('<MPD><Period><AdaptationSet><Representation id="1" mimeType="video/mp4" bandwidth="1000" width="640" height="360"><BaseURL>v/init.mp4</BaseURL><SegmentTemplate media="v/seg$Number$.mp4" startNumber="1" duration="4"></SegmentTemplate></Representation></AdaptationSet></Period></MPD>');
        } });
      }
      if (/seg\d+\.ts$/.test(url) || /seg\d+\.mp4$/.test(url) || /init\.mp4$/.test(url)) {
        return Promise.resolve({ ok: true, arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(64)); } });
      }
      if (/videoplayback/.test(url)) {
        return Promise.resolve({ ok: true, arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(128)); } });
      }
      if (/\/media\d*\.mp4$/.test(url) || /audio\.mp4$/.test(url)) {
        return Promise.resolve({ ok: true, arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(128)); } });
      }
      return Promise.resolve({ ok: false, text: function () { return Promise.resolve(''); } });
    },
    globalThis: null,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  chrome.__ctx = ctx;
  return ctx;
}

async function send(chrome, msg, sender) {
  const fn = chrome.__listeners.onMessage[0];
  let response = null;
  let got = false;
  fn(msg, sender || {}, function (r) { response = r; got = true; });
  const deadline = Date.now() + 4000;
  while (!got && Date.now() < deadline) await flush();
  return response;
}

function complete(chrome, downloadId) {
  chrome.__listeners.onChanged.forEach(function (fn) {
    fn({ id: downloadId, state: { current: 'complete' } });
  });
  const d = chrome.downloads.__downloads.find(function (x) { return x.id === downloadId; });
  if (d) d.done = true;
}

async function run() {
  // ---- 1. default settings --------------------------------------------------
  {
    const chrome = makeChrome();
    const ctx = makeContext(chrome);
    vm.runInContext(logicSrc, ctx);
    vm.runInContext(bgSrc, ctx);
    let r = await send(chrome, { type: 'ms-get-settings' });
    eq(r.rootFolder, '', 'default rootFolder empty');
    eq(r.minSizeKb, 500, 'default minSizeKb 500');
    eq(r.blacklist, '', 'default blacklist empty');

    r = await send(chrome, { type: 'ms-set-settings', settings: { rootFolder: 'My Clips', minSizeKb: 2000, blacklist: 'ads.example.com' } });
    eq(r.saved, true, 'set-settings saves');
    eq(r.settings.rootFolder, 'My Clips', 'root round-trip');
    eq(r.settings.minSizeKb, 2000, 'minSize round-trip');
    r = await send(chrome, { type: 'ms-get-settings' });
    eq(r.rootFolder, 'My Clips', 'get reflects saved root');
    eq(r.minSizeKb, 2000, 'get reflects saved minSize');

    // downloads now carry the root folder prefix
    await send(chrome, { type: 'ms-download', item: { url: 'https://cdn.example.com/x.mp4', kind: 'video' }, tabId: 1 });
    eq(chrome.downloads.__downloads[0].opts.filename, 'My Clips/x.mp4', 'enqueue honors rootFolder');

    // sanitize on save
    await send(chrome, { type: 'ms-set-settings', settings: { rootFolder: '../evil' } });
    eq((await send(chrome, { type: 'ms-get-settings' })).rootFolder, '', 'absolute/traversal root sanitized away');
  }

  // ---- 2. stored settings loaded at boot ------------------------------------
  {
    const chrome = makeChrome({ localStore: { rootFolder: 'boot-root', minSizeKb: 900, blacklist: '' } });
    const ctx = makeContext(chrome);
    vm.runInContext(logicSrc, ctx);
    vm.runInContext(bgSrc, ctx);
    const r = await send(chrome, { type: 'ms-get-settings' });
    eq(r.rootFolder, 'boot-root', 'boot loads stored root');
    eq(r.minSizeKb, 900, 'boot loads stored minSize');
    await send(chrome, { type: 'ms-download', item: { url: 'https://cdn.example.com/y.mp4', kind: 'video' }, tabId: 1 });
    eq(chrome.downloads.__downloads[0].opts.filename, 'boot-root/y.mp4', 'boot settings drive filenames');
  }

  // ---- 3. blacklist + minSize gates -----------------------------------------
  {
    const chrome = makeChrome({ localStore: { blacklist: 'ads.example.com, tracker.io', minSizeKb: 1000 } });
    const ctx = makeContext(chrome);
    vm.runInContext(logicSrc, ctx);
    vm.runInContext(bgSrc, ctx);

    let r = await send(chrome, { type: 'ms-report', items: [
      { url: 'https://ads.example.com/pix.mp4', kind: 'video', size: 9000000 },
      { url: 'https://cdn.example.com/ok.mp4', kind: 'video', size: 9000000 },
      { url: 'https://tracker.io/t.mp4', kind: 'video', size: 9000000 },
      { url: 'https://cdn.example.com/tiny.mp4', kind: 'video', size: 300000 },
    ], tabId: 1 });
    eq(r.added, 1, 'blacklisted hosts + undersized filtered at intake');
    r = await send(chrome, { type: 'ms-get-items', tabId: 1 });
    eq(r.items.length, 1, 'only ok.mp4 visible');
    eq(r.items[0].url, 'https://cdn.example.com/ok.mp4', 'correct survivor');

    // webRequest path respects blacklist too
    const wrl = chrome.__listeners.onWebResponseStarted[0];
    wrl({ url: 'https://ads.example.com/wr.mp4', statusCode: 200, tabId: 1, responseHeaders: [{ name: 'content-type', value: 'video/mp4' }, { name: 'content-length', value: String(5 * 1024 * 1024) }] });
    wrl({ url: 'https://cdn.example.com/wr-ok.mp4', statusCode: 200, tabId: 1, responseHeaders: [{ name: 'content-type', value: 'video/mp4' }, { name: 'content-length', value: String(5 * 1024 * 1024) }] });
    await flush();
    const got = (await send(chrome, { type: 'ms-get-items', tabId: 1 })).items;
    ok(!got.some(function (i) { return i.url.indexOf('ads.example.com') >= 0; }), 'webrequest blacklisted dropped');
    ok(got.some(function (i) { return i.url.indexOf('wr-ok.mp4') >= 0; }), 'webrequest clean kept');
  }

  // ---- 4. download-all: direct queue + skip-existing ------------------------
  {
    const chrome = makeChrome({
      existingDownloads: ['/Users/u/Downloads/gone.mp4'],
    });
    const ctx = makeContext(chrome);
    vm.runInContext(logicSrc, ctx);
    vm.runInContext(bgSrc, ctx);
    await send(chrome, { type: 'ms-report', items: [
      { url: 'https://cdn.example.com/gone.mp4', kind: 'video', size: 9000000 },
      { url: 'https://cdn.example.com/new.mp4', kind: 'video', size: 9000000 },
      { url: 'https://cdn.example.com/list.m3u8', kind: 'hls', size: 0 },
    ], tabId: 1 });
    const r = await send(chrome, { type: 'ms-download-all', tabId: 1 });
    eq(r.skipped, 1, 'gone.mp4 skipped: exact suggested name already in history');
    eq(r.queued, 1, 'new.mp4 queued');
    eq(r.deferred, 1, 'hls deferred to chain');
    eq(chrome.downloads.__downloads[0].opts.filename, 'new.mp4', 'only new.mp4 started');

    // now actually skip: existing history has matching relative name
    const chrome2 = makeChrome({
      existingDownloads: ['/Users/u/Downloads/skipme.mp4', '/Users/u/Downloads/other.mkv'],
    });
    const ctx2 = makeContext(chrome2);
    vm.runInContext(logicSrc, ctx2);
    vm.runInContext(bgSrc, ctx2);
    await send(chrome2, { type: 'ms-report', items: [
      { url: 'https://cdn.example.com/skipme.mp4', kind: 'video', size: 9000000, title: 'skipme' },
      { url: 'https://cdn.example.com/zz-take.mp4', kind: 'video', size: 9000000, title: 'skipme' },
    ], tabId: 1 });
    const r2 = await send(chrome2, { type: 'ms-download-all', tabId: 1 });
    eq(r2.skipped, 2, 'both skip: same suggested name already in history');
    eq(r2.queued, 0, 'nothing queued');
    eq(chrome2.downloads.__downloads.length, 0, 'no downloads started');
  }

  // ---- 5. HLS chain: deferred items run one after another -------------------
  {
    const chrome = makeChrome();
    const ctx = makeContext(chrome);
    vm.runInContext(logicSrc, ctx);
    vm.runInContext(bgSrc, ctx);
    await send(chrome, { type: 'ms-report', items: [
      { url: 'https://cdn.example.com/a.m3u8', kind: 'hls', size: 0, title: 'A' },
      { url: 'https://cdn.example.com/b.m3u8', kind: 'hls', size: 0, title: 'B' },
    ], tabId: 1 });
    const r = await send(chrome, { type: 'ms-download-all', tabId: 1 });
    eq(r.deferred, 2, 'both hls deferred');
    await flush();
    eq(chrome.downloads.__downloads.length, 1, 'first hls blob downloading, second still waiting');
    const firstBlob = chrome.downloads.__downloads[0];
    ok(/A/.test(firstBlob.opts.filename), 'first chain item is A');
    complete(chrome, firstBlob.id);
    await flush();
    await flush();
    eq(chrome.downloads.__downloads.length, 2, 'second hls starts after first completes');
    ok(/B/.test(chrome.downloads.__downloads[1].opts.filename), 'second chain item is B');
    const st = await send(chrome, { type: 'ms-hls-status', jobKey: 'chain', tabId: 1 });
    ok(st === null || typeof st === 'object', 'status endpoint still sane');
    complete(chrome, chrome.downloads.__downloads[1].id);
    await flush();
  }

  // ---- 6. YouTube mux routing -------------------------------------------------
  {
    const chrome = makeChrome();
    const ctx = makeContext(chrome);
    vm.runInContext(logicSrc, ctx);
    vm.runInContext(bgSrc, ctx);
    const item = {
      url: 'https://rr3---sn-example.googlevideo.com/videoplayback?id=abc&mime=video%2Fmp4',
      kind: 'video', contentType: 'video/mp4', ext: 'mp4', size: 100000,
      title: 'YT Clip', via: 'youtube', duration: 30,
      audioUrl: 'https://rr3---sn-example.googlevideo.com/videoplayback?id=abc&mime=audio%2Fmp4',
    };
    const bad = await send(chrome, { type: 'ms-yt-mux-download', item: { kind: 'video' }, tabId: 1 });
    ok(bad && bad.error, 'mux rejects item without audioUrl');
    const r = await send(chrome, { type: 'ms-yt-mux-download', item: item, tabId: 1 });
    eq(r.started, true, 'mux job started');
    ok(typeof r.jobKey === 'string' && r.jobKey.indexOf('yt-mux:') === 0, 'jobKey exposed');
    await flush(); await flush(); await flush();
    eq(chrome.__muxCalls.length, 1, 'offscreen mux invoked once');
    eq(chrome.downloads.__downloads.length, 1, 'muxed blob queued for download');
    ok(/YT Clip/.test(chrome.downloads.__downloads[0].opts.filename), 'mux output named from title');
    ok(/\.mp4$/.test(chrome.downloads.__downloads[0].opts.filename), 'mux output is mp4');
    const st = await send(chrome, { type: 'ms-hls-status', jobKey: r.jobKey, tabId: 1 });
    ok(st && (st.status === 'downloading' || st.status === 'combining' || st.status === 'complete'), 'status pollable by jobKey');
  }

  report('background2');
}

run().catch(function (e) { console.error(e); process.exit(1); });
