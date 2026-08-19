'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { eq, ok, report } = require('./harness.js');

const logicSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'logic.js'), 'utf8');
const bgSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');

function flush() {
  return new Promise(function (r) { setImmediate(r); });
}

// ---- fake chrome -------------------------------------------------------------
function makeChrome() {
  const storageData = {};
  const listeners = { onDeterminingFilename: [], onChanged: [], onMessage: [], onRemoved: [], onActivated: [], onWebResponseStarted: [], onSendHeaders: [] };
  const downloads = [];
  let downloadSeq = 1;
  const suggestCalls = [];
  const swFetchLog = [];
  const swFetchOpts = [];

  const chrome = {
    storage: {
      session: {
        get: function (k) {
          const out = {};
          (Array.isArray(k) ? k : [k]).forEach(function (key) { if (key in storageData) out[key] = storageData[key]; });
          return Promise.resolve(out);
        },
        set: function (obj) { Object.assign(storageData, obj); return Promise.resolve(); },
      },
    },
    downloads: {
      onDeterminingFilename: (function () {
        const ev = {
          addListener: function (fn) { listeners.onDeterminingFilename.push(fn); },
          removeListener: function (fn) {
            const i = listeners.onDeterminingFilename.indexOf(fn);
            if (i >= 0) listeners.onDeterminingFilename.splice(i, 1);
          },
          hasListener: function (fn) { return listeners.onDeterminingFilename.indexOf(fn) >= 0; },
        };
        return ev;
      })(),
      onChanged: { addListener: function (fn) { listeners.onChanged.push(fn); } },
      download: function (opts, cb) {
        const id = downloadSeq++;
        downloads.push({ id: id, opts: opts, done: false });
        chrome.runtime.lastError = null;
        if (cb) cb(id);
        return Promise.resolve(id);
      },
      __downloads: downloads,
    },
    runtime: {
      lastError: null,
      onMessage: { addListener: function (fn) { listeners.onMessage.push(fn); } },
      sendMessage: function (msg) {
        // emulate the offscreen document: it fetches bytes ITSELF (the real
        // one never receives bytes over messaging — Brave drops them)
        if (msg && msg.type === 'ms-offscreen-fetch-blob') {
          return Promise.resolve()
            .then(function () { return chrome.__ctx.fetch(msg.url, { credentials: 'include', headers: msg.headers || {} }); })
            .then(function (res) {
              if (!res.ok) return { error: 'http ' + res.status };
              return res.arrayBuffer().then(function (buf) {
                return { url: 'blob:fake/combined-' + buf.byteLength, size: buf.byteLength };
              });
            });
        }
        if (msg && msg.type === 'ms-offscreen-hls-build') {
          const all = (msg.initUrl ? [msg.initUrl] : []).concat(msg.segments || []);
          const fetchOne = function (u) {
            return Promise.resolve()
              .then(function () { return chrome.__ctx.fetch(u, { credentials: 'include', headers: msg.headers || {} }); })
              .then(function (res) {
                if (!res.ok) throw new Error('http ' + res.status);
                return res.arrayBuffer();
              });
          };
          return Promise.all(all.map(fetchOne)).then(function (bufs) {
            let total = 0;
            bufs.forEach(function (b) { total += b.byteLength; });
            return { url: 'blob:fake/combined-' + total, size: total };
          }).catch(function (err) { return { error: String(err && err.message || err) }; });
        }
        if (msg && msg.type === 'ms-offscreen-ffmpeg-status') {
          return Promise.resolve({
            running: !!chrome.__ffmpegLiveResolve,
            jobId: chrome.__ffmpegLiveResolve ? (chrome.__ffmpegLiveJobId || null) : null,
            seconds: 3, bytes: 1234, done: chrome.__ffmpegDone || null,
          });
        }
        if (msg && msg.type === 'ms-offscreen-ffmpeg-run') {
          chrome.__ffmpegRuns.push(msg);
          if (msg.live) {
            // emulate a recording: resolves only when ms-offscreen-ffmpeg-abort arrives
            chrome.__ffmpegLiveJobId = msg.jobId;
            return new Promise(function (resolve) { chrome.__ffmpegLiveResolve = resolve; });
          }
          // emulate a VOD remux: real ffmpeg would jsfetch everything itself
          chrome.__ffmpegDone = { jobId: msg.jobId, url: 'blob:fake/ffmpeg-remux', size: 5000, ext: msg.ext, partial: false };
          return Promise.resolve({ url: chrome.__ffmpegDone.url, size: chrome.__ffmpegDone.size, partial: false });
        }
        if (msg && msg.type === 'ms-offscreen-dash-build') {
          chrome.__dashBuilds.push(msg);
          // emulate: fetch every segment of every track through the page fetch
          const tracks = [msg.video, msg.audio].filter(Boolean);
          const urls = [];
          tracks.forEach(function (t) {
            if (t.initUrl) urls.push(t.initUrl);
            (t.segments || []).forEach(function (u) { urls.push(u); });
          });
          const fetchOne = function (u) {
            return Promise.resolve()
              .then(function () { return chrome.__ctx.fetch(u, { credentials: 'include', headers: msg.headers || {} }); })
              .then(function (res) {
                if (!res.ok) throw new Error('http ' + res.status);
                return res.arrayBuffer();
              });
          };
          return Promise.all(urls.map(fetchOne)).then(function (bufs) {
            let total = 0;
            bufs.forEach(function (b) { total += b.byteLength; });
            return { url: 'blob:fake/dash-' + total, size: total };
          }).catch(function (err) { return { error: String(err && err.message || err) }; });
        }
        if (msg && msg.type === 'ms-offscreen-ffmpeg-abort') {
          if (chrome.__ffmpegLiveResolve) {
            const resolve = chrome.__ffmpegLiveResolve;
            chrome.__ffmpegLiveResolve = null;
            resolve({ url: 'blob:fake/ffmpeg-live-partial', size: 3000, partial: true });
            return Promise.resolve({ ok: true });
          }
          return Promise.resolve({ ok: false });
        }
        return Promise.resolve(undefined);
      },
    },
    offscreen: {
      hasDocument: function () { return Promise.resolve(true); },
      createDocument: function () { return Promise.resolve(); },
    },
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
    __suggestCalls: suggestCalls,
    __storageData: storageData,
    __swFetchLog: swFetchLog,
    __swFetchOpts: swFetchOpts,
    __ffmpegRuns: [],
    __dashBuilds: [],
    __ffmpegDone: null,
    __ffmpegLiveResolve: null,
    __ffmpegLiveJobId: null,
  };
  return chrome;
}

function makeContext(chrome) {
  const ctx = {
    chrome,
    console,
    URL,
    Promise,
    Date,
    Math,
    Blob,
    ArrayBuffer,
    Uint8Array,
    URL_createObjectURL_count: 0,
    fetch: function (url, opts) {
      chrome.__swFetchLog.push(url);
      chrome.__swFetchOpts.push({ url: url, opts: opts || {} });
      if (url.indexOf('master.m3u8') >= 0) {
        return Promise.resolve({ ok: true, text: function () {
          return Promise.resolve('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nmedia.m3u8\n');
        } });
      }
      if (url.indexOf('media.m3u8') >= 0) {
        return Promise.resolve({ ok: true, text: function () {
          return Promise.resolve('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nseg0.ts\n#EXTINF:2.0,\nseg1.ts\n#EXT-X-ENDLIST\n');
        } });
      }
      if (url.indexOf('subs.m3u8') >= 0) {
        return Promise.resolve({ ok: true, text: function () {
          return Promise.resolve('#EXTM3U\n#EXTINF:10,\nsubs.vtt\n#EXT-X-ENDLIST\n');
        } });
      }
      if (/seg\d+\.ts$/.test(url)) {
        // fake TS segment: 188 bytes
        const buf = new ArrayBuffer(188);
        new Uint8Array(buf).fill(0x47);
        return Promise.resolve({ ok: true, arrayBuffer: function () { return Promise.resolve(buf); } });
      }
      if (/aseg\d+\.ts$/.test(url)) {
        const buf = new ArrayBuffer(188);
        new Uint8Array(buf).fill(0x47);
        return Promise.resolve({ ok: true, arrayBuffer: function () { return Promise.resolve(buf); } });
      }
      if (url.indexOf('auth/playlist.m3u8') >= 0) {
        return Promise.resolve({ ok: true, text: function () {
          return Promise.resolve('#EXTM3U\n#EXTINF:2,\naseg0.ts\n#EXT-X-ENDLIST\n');
        } });
      }
      if (url.indexOf('space.m3u8') >= 0) {
        // X Spaces replay shape: audio-only, .aac ADTS chunks, no EXT-X-MAP
        return Promise.resolve({ ok: true, text: function () {
          return Promise.resolve('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-VERSION:6\n#EXTINF:3.0,\nchunk_1_0_a.aac\n#EXTINF:3.0,\nchunk_2_1_a.aac\n#EXT-X-ENDLIST\n');
        } });
      }
      if (/chunk_\d+_\d+_a\.aac$/.test(url)) {
        // fake ADTS chunk
        const buf = new ArrayBuffer(64);
        new Uint8Array(buf).fill(0x41);
        return Promise.resolve({ ok: true, arrayBuffer: function () { return Promise.resolve(buf); } });
      }
      if (url.indexOf('hotlink.mp4') >= 0) {
        const buf = new ArrayBuffer(64);
        new Uint8Array(buf).fill(0x48);
        return Promise.resolve({ ok: true, arrayBuffer: function () { return Promise.resolve(buf); } });
      }
      return Promise.resolve({ ok: false, text: function () { return Promise.resolve(''); } });
    },
    globalThis: null,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // let the fake chrome.runtime.sendMessage (offscreen emulator) reach the
  // same fake fetch the SW sees — the real offscreen document has its own
  // fetch with host permissions, this mirrors that
  chrome.__ctx = ctx;
  return ctx;
}

async function send(chrome, msg, sender, waitMs) {
  const fn = chrome.__listeners.onMessage[0];
  let response = null;
  let got = false;
  fn(msg, sender || {}, function (r) { response = r; got = true; });
  const deadline = Date.now() + (waitMs || 3000);
  while (!got && Date.now() < deadline) await flush();
  return response;
}

async function run() {
  const chrome = makeChrome();
  const ctx = makeContext(chrome);
  vm.runInContext(logicSrc, ctx);
  vm.runInContext(bgSrc, ctx);

  // --- 1. report + dedupe + get ---------------------------------------------
  let r = await send(chrome, { type: 'ms-report', items: [
    { url: 'https://cdn.example.com/a.mp4', kind: 'video', size: 9000000, contentType: 'video/mp4', pageUrl: 'https://site.example.com/p' },
    { url: 'https://cdn.example.com/a.mp4?tok=1', kind: 'video', size: 0 },
    { url: 'https://cdn.example.com/b.m3u8', kind: 'hls' },
    { url: 'blob:https://site.example.com/u1', kind: 'video' },
    { url: 'https://site.example.com/page.html' },
  ], tabId: 1 });
  eq(r.added, 3, '3 distinct items added (query dup merged, html rejected)');
  r = await send(chrome, { type: 'ms-get-items', tabId: 1 });
  eq(r.items.length, 3, 'get-items returns 3');
  eq(r.items[0].kind, 'video', 'video sorted first');
  eq(r.items[0].size, 9000000, 'richer copy kept');

  // --- 2. normal download: filename routed, completion frees slot -----------
  await send(chrome, { type: 'ms-download', item: { url: 'https://cdn.example.com/a.mp4', kind: 'video' }, tabId: 1 });
  eq(chrome.downloads.__downloads.length, 1, 'one download started');
  eq(chrome.downloads.__downloads[0].opts.filename, 'a.mp4', 'flat filename passed');
  const d1 = chrome.downloads.__downloads[0].id;
  chrome.__listeners.onChanged.forEach(function (fn) { fn({ id: d1, state: { current: 'complete' } }); });
  chrome.downloads.__downloads[0].done = true;
  await flush();
  let qs = await send(chrome, { type: 'ms-queue-status', tabId: 1 });
  eq(qs.queue[0].status, 'complete', 'complete recorded');

  // --- 3. concurrency: 3 active max ------------------------------------------
  for (let i = 0; i < 5; i++) {
    await send(chrome, { type: 'ms-download', item: { url: 'https://cdn.example.com/clip' + i + '.mp4', kind: 'video' }, tabId: 1 });
  }
  const running = chrome.downloads.__downloads.filter(function (d) { return !d.done; });
  eq(running.length, 3, 'concurrency capped at 3');
  // finish one -> next pumps
  chrome.__listeners.onChanged.forEach(function (fn) { fn({ id: running[0].id, state: { current: 'complete' } }); });
  running[0].done = true;
  await flush();
  eq(chrome.downloads.__downloads.length, 5, '4th download pumped after completion');

  // --- 4. interrupted download marked failed ----------------------------------
  const last = chrome.downloads.__downloads[chrome.downloads.__downloads.length - 1];
  chrome.__listeners.onChanged.forEach(function (fn) { fn({ id: last.id, state: { current: 'interrupted' }, error: { current: 'NETWORK_FAILED' } }); });
  last.done = true;
  await flush();
  qs = await send(chrome, { type: 'ms-queue-status', tabId: 1 });
  const failed = qs.queue.filter(function (q) { return q.status === 'failed'; });
  eq(failed.length, 1, 'interrupted -> failed');

  // drain any still-running downloads so the blob test can start immediately
  chrome.downloads.__downloads.forEach(function (d) {
    if (!d.done) {
      d.done = true;
      chrome.__listeners.onChanged.forEach(function (fn) { fn({ id: d.id, state: { current: 'complete' } }); });
    }
  });
  await flush();

  // --- 5. blob download: same filename-option path, no listener machinery ----
  await send(chrome, { type: 'ms-download-blob', url: 'blob:https://site.example.com/blob1', kind: 'video' }, {});
  await flush();
  const blobDl = chrome.downloads.__downloads[chrome.downloads.__downloads.length - 1];
  eq(blobDl.opts.filename, 'video_blob1.mp4', 'blob download carries flat computed filename');
  eq(blobDl.opts.saveAs, false, 'blob download saveAs=false');
  eq(chrome.__listeners.onDeterminingFilename.length, 0, 'no onDeterminingFilename listener ever registered');
  // blob download completes like any other
  chrome.__listeners.onChanged.forEach(function (fn) { fn({ id: blobDl.id, state: { current: 'complete' } }); });
  blobDl.done = true;
  await flush();
  qs = await send(chrome, { type: 'ms-queue-status', tabId: 1 });
  ok(qs.queue.some(function (q) { return q.filename === 'video_blob1.mp4' && q.status === 'complete'; }), 'blob download completed');

  // --- 6. tab removed clears items --------------------------------------------
  chrome.__listeners.onRemoved.forEach(function (fn) { fn(1); });
  r = await send(chrome, { type: 'ms-get-items', tabId: 1 });
  eq(r.items.length, 0, 'items cleared on tab close');

  // --- 7. webRequest detection -------------------------------------------------
  await send(chrome, { type: 'ms-page-meta', title: 'Cool Video Page', url: 'https://site.example.com/watch/9' }, { tab: { id: 7 } });
  const wr = chrome.__listeners.onWebResponseStarted[0];
  ok(typeof wr === 'function', 'webRequest listener registered');

  // mp4 via response headers (size above the 500KB noise threshold)
  wr({
    statusCode: 200, url: 'https://cdn.example.com/movie.mp4', tabId: 7,
    initiator: 'https://site.example.com/', type: 'media',
    responseHeaders: [
      { name: 'Content-Type', value: 'video/mp4' },
      { name: 'Content-Length', value: '5000000' },
    ],
  });
  await flush();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  eq(r.items.length, 1, 'webrequest mp4 detected');
  eq(r.items[0].title, 'Cool Video Page', 'page title attached');
  eq(r.items[0].size, 5000000, 'content-length from headers');

  // tiny media (< 500KB) is filtered as noise (VDH rule)
  wr({
    statusCode: 200, url: 'https://cdn.example.com/ad.mp4', tabId: 7,
    initiator: 'https://site.example.com/', type: 'media',
    responseHeaders: [
      { name: 'Content-Type', value: 'video/mp4' },
      { name: 'Content-Length', value: '120000' },
    ],
  });
  await flush();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  ok(!r.items.some(function (i) { return i.url.indexOf('ad.mp4') >= 0; }), 'tiny media filtered (<500KB)');

  // youtube.com responses are ignored by the generic detector (dedicated site)
  wr({
    statusCode: 200, url: 'https://rr2---sn-youtube.com/videoplayback?itag=18', tabId: 7,
    initiator: 'https://www.youtube.com/', type: 'media',
    responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }],
  });
  await flush();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  ok(!r.items.some(function (i) { return i.url.indexOf('videoplayback') >= 0; }), 'youtube chunk ignored by generic detector');

  // but the youtube adapter's own report (via=youtube) passes through
  r = await send(chrome, { type: 'ms-report', items: [
    { url: 'https://rr2---sn-youtube.com/videoplayback?itag=22', kind: 'video', contentType: 'video/mp4', size: 9000000, via: 'youtube', pageUrl: 'https://www.youtube.com/watch?v=abc', title: 'YT Video [720p]', duration: 300 },
  ], tabId: 7 });
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  const ytItem = r.items.find(function (i) { return i.via === 'youtube'; });
  ok(!!ytItem, 'youtube adapter item accepted');
  eq(ytItem && ytItem.title, 'YT Video [720p]', 'adapter title kept');

  // mp2t content-type is always a segment, never reported
  wr({
    statusCode: 200, url: 'https://cdn.example.com/stream/chunk', tabId: 7,
    initiator: 'https://site.example.com/', type: 'media',
    responseHeaders: [{ name: 'Content-Type', value: 'video/mp2t' }],
  });
  await flush();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  ok(!r.items.some(function (i) { return i.url.indexOf('/chunk') >= 0; }), 'mp2t segment filtered');

  // text/html responses are never media
  wr({
    statusCode: 200, url: 'https://cdn.example.com/thing.mp4', tabId: 7,
    initiator: 'https://site.example.com/', type: 'media',
    responseHeaders: [
      { name: 'Content-Type', value: 'text/html' },
      { name: 'Content-Length', value: '9000000' },
    ],
  });
  await flush();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  ok(!r.items.some(function (i) { return i.url.indexOf('thing.mp4') >= 0; }), 'html response filtered');

  // m3u8 via content-type -> master playlist expanded into per-variant items
  wr({
    statusCode: 200, url: 'https://cdn.example.com/live/master.m3u8', tabId: 7,
    initiator: 'https://site.example.com/', type: 'xmlhttprequest',
    responseHeaders: [{ name: 'content-type', value: 'application/vnd.apple.mpegurl' }],
  });
  await flush();
  await flush();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  const hlsItem = r.items.find(function (i) { return i.kind === 'hls'; });
  ok(!!hlsItem, 'hls variant added');
  // master playlist is NOT shown as one opaque "HLS" entry; the variant's own
  // media playlist URL is surfaced instead (VDH-style variant expansion)
  eq(hlsItem && hlsItem.url, 'https://cdn.example.com/live/media.m3u8', 'variant media playlist surfaced, not master');
  eq(hlsItem && hlsItem.title, 'Cool Video Page', 'hls item titled');
  ok(chrome.__swFetchLog.some(function (u) { return u.indexOf('master.m3u8') >= 0; }), 'SW fetched playlist');

  // subtitle playlist rejected
  wr({
    statusCode: 200, url: 'https://cdn.example.com/subs.m3u8', tabId: 7,
    initiator: 'https://site.example.com/', type: 'xmlhttprequest',
    responseHeaders: [{ name: 'content-type', value: 'application/vnd.apple.mpegurl' }],
  });
  await flush();
  await flush();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  ok(!r.items.some(function (i) { return i.url.indexOf('subs.m3u8') >= 0; }), 'subtitle playlist rejected');

  // segments never reported
  wr({
    statusCode: 200, url: 'https://cdn.example.com/live/seg0.ts', tabId: 7,
    initiator: 'https://site.example.com/', type: 'media',
    responseHeaders: [{ name: 'content-type', value: 'video/mp2t' }],
  });
  await flush();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  ok(!r.items.some(function (i) { return i.url.indexOf('seg0.ts') >= 0; }), 'ts segment filtered');

  // html page not reported
  wr({
    statusCode: 200, url: 'https://site.example.com/page', tabId: 7,
    initiator: 'https://site.example.com/', type: 'main_frame',
    responseHeaders: [{ name: 'content-type', value: 'text/html' }],
  });
  await flush();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  ok(!r.items.some(function (i) { return i.url.indexOf('/page') >= 0; }), 'html page filtered');

  // 404 not reported
  wr({
    statusCode: 404, url: 'https://cdn.example.com/gone.mp4', tabId: 7,
    initiator: 'https://site.example.com/', type: 'media',
    responseHeaders: [{ name: 'content-type', value: 'video/mp4' }],
  });
  await flush();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  ok(!r.items.some(function (i) { return i.url.indexOf('gone.mp4') >= 0; }), '404 filtered');

  // --- 8. HLS pipeline end-to-end (SW-side) ------------------------------------
  // VOD TS playlist now runs through the ffmpeg engine (VDH architecture):
  // SW only parses master/media, ffmpeg does segments + remux itself.
  const hlsResp = await send(chrome, { type: 'ms-hls-download', url: 'https://cdn.example.com/live/master.m3u8', title: 'HLS Test Video', pageUrl: 'https://site.example.com/watch/9' }, { tab: { id: 7 } });
  ok(hlsResp && hlsResp.queued, 'hls job queued a download');
  // SW fetched+parsed the playlists itself
  ok(chrome.__swFetchLog.some(function (u) { return u.indexOf('master.m3u8') >= 0; }), 'master playlist fetched by SW');
  ok(chrome.__swFetchLog.some(function (u) { return u.indexOf('media.m3u8') >= 0; }), 'media playlist fetched by SW');
  // ffmpeg job delegated with the media playlist URL
  const ffRun = chrome.__ffmpegRuns.find(function (r) { return r.url.indexOf('media.m3u8') >= 0; });
  ok(!!ffRun, 'ffmpeg job started on media playlist');
  eq(ffRun && ffRun.ext, 'mp4', 'TS playlist remuxes to mp4');
  ok(ffRun && ffRun.live === false, 'VOD not live');
  // job state
  const hlsStatus = await send(chrome, { type: 'ms-hls-status', url: 'https://cdn.example.com/live/master.m3u8' }, {});
  eq(hlsStatus.status, 'downloading', 'job reached downloading');
  eq(hlsStatus.mode, 'ffmpeg', 'job ran via ffmpeg');
  // queued download is the blob, with title-based filename
  qs = await send(chrome, { type: 'ms-queue-status' });
  const hlsQ = qs.queue.filter(function (q) { return q.filename.indexOf('HLS Test Video') >= 0; });
  eq(hlsQ.length, 1, 'hls output named by title');
  ok(hlsQ[0].filename.endsWith('.mp4'), 'mp4 container after remux');
  // duplicate start while running is rejected (job already downloading -> reruns, but alreadyRunning only for fetching/combining)
  const dup = await send(chrome, { type: 'ms-hls-download', url: 'https://cdn.example.com/live/master.m3u8', title: 'x' }, { tab: { id: 7 } });
  ok(dup, 'duplicate hls request responds');

  // --- 9. AES-128 encrypted HLS: now SUPPORTED (ffmpeg decrypts via jsfetch) ----
  const ctxRef = ctx;
  const origFetch = ctxRef.fetch;
  ctxRef.fetch = function (url) {
    if (url.indexOf('enc.m3u8') >= 0) {
      return Promise.resolve({ ok: true, text: function () {
        return Promise.resolve('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://k/key.bin"\n#EXTINF:2,\nseg0.ts\n#EXT-X-ENDLIST\n');
      } });
    }
    return origFetch(url);
  };
  const encResp = await send(chrome, { type: 'ms-hls-download', url: 'https://cdn.example.com/enc.m3u8', title: 'enc' }, { tab: { id: 7 } });
  ok(encResp && encResp.queued, 'encrypted HLS accepted (ffmpeg path)');
  ok(chrome.__ffmpegRuns.some(function (r) { return r.url.indexOf('enc.m3u8') >= 0; }), 'encrypted playlist handed to ffmpeg');
  ctxRef.fetch = origFetch;

  async function settle() { for (let i = 0; i < 8; i++) await flush(); }

  // --- 10. multi-variant master: each variant becomes its own item -----------
  ctxRef.fetch = function (url, opts) {
    chrome.__swFetchLog.push(url);
    chrome.__swFetchOpts.push({ url: url, opts: opts || {} });
    if (url.indexOf('multi.m3u8') >= 0) {
      return Promise.resolve({ ok: true, text: function () {
        return Promise.resolve('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\nv720.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360\nv360.m3u8\n');
      } });
    }
    return origFetch(url, opts);
  };
  wr({
    statusCode: 200, url: 'https://cdn.example.com/v2/multi.m3u8', tabId: 7,
    initiator: 'https://site.example.com/', type: 'xmlhttprequest',
    responseHeaders: [{ name: 'content-type', value: 'application/vnd.apple.mpegurl' }],
  });
  await settle();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  const v720 = r.items.find(function (i) { return i.url.indexOf('v720.m3u8') >= 0; });
  const v360 = r.items.find(function (i) { return i.url.indexOf('v360.m3u8') >= 0; });
  ok(!!v720 && !!v360, 'multi-variant: both variants surfaced');
  eq(v720 && v720.title, 'Cool Video Page [1280x720]', '720p variant labeled');
  ctxRef.fetch = origFetch;

  // --- 11. sent_headers capture & replay (VDH-style) ---------------------------
  const sh = chrome.__listeners.onSendHeaders[0];
  ok(typeof sh === 'function', 'onSendHeaders listener registered');
  sh({
    url: 'https://cdn.example.com/auth/playlist.m3u8?tok=a',
    initiator: 'https://site.example.com/',
    requestHeaders: [
      { name: 'Authorization', value: 'Bearer tok123' },
      { name: 'Accept', value: '*/*' },
    ],
  });
  ctxRef.fetch = function (url, opts) {
    chrome.__swFetchLog.push(url);
    chrome.__swFetchOpts.push({ url: url, opts: opts || {} });
    if (url.indexOf('auth/playlist.m3u8') >= 0) {
      return Promise.resolve({ ok: true, text: function () {
        return Promise.resolve('#EXTM3U\n#EXTINF:2,\naseg0.ts\n#EXT-X-ENDLIST\n');
      } });
    }
    if (/aseg\d+\.ts$/.test(url)) {
      const buf = new ArrayBuffer(188);
      return Promise.resolve({ ok: true, arrayBuffer: function () { return Promise.resolve(buf); } });
    }
    return origFetch(url, opts);
  };
  const authResp = await send(chrome, { type: 'ms-hls-download', url: 'https://cdn.example.com/auth/playlist.m3u8?tok=a', title: 'Auth Stream' }, { tab: { id: 7 } });
  ok(authResp && authResp.queued, 'auth hls queued');
  const plFetch = chrome.__swFetchOpts.find(function (f) { return f.url.indexOf('auth/playlist.m3u8') >= 0; });
  ok(plFetch && plFetch.opts.headers && plFetch.opts.headers.Authorization === 'Bearer tok123', 'captured Authorization replayed on playlist fetch');
  // segments are now fetched by ffmpeg itself (jsfetch); the captured
  // Authorization must travel in the ffmpeg job message's headers
  const authRun = chrome.__ffmpegRuns.find(function (r) { return r.url.indexOf('auth/playlist.m3u8') >= 0; });
  ok(authRun && authRun.headers && authRun.headers.Authorization === 'Bearer tok123', 'captured Authorization handed to ffmpeg job');
  ctxRef.fetch = origFetch;

  // --- 12. 403 fallback: interrupted download retries via SW fetch --------------
  // drain zombie queue slots left by earlier HLS jobs (their blob downloads
  // were never completed) so the concurrency cap doesn't block this test
  chrome.downloads.__downloads.forEach(function (d) {
    if (!d.done) {
      d.done = true;
      chrome.__listeners.onChanged.forEach(function (fn) { fn({ id: d.id, state: { current: 'complete' } }); });
    }
  });
  await settle();
  ctxRef.fetch = function (url, opts) {
    chrome.__swFetchLog.push(url);
    chrome.__swFetchOpts.push({ url: url, opts: opts || {} });
    if (url.indexOf('hotlink.mp4') >= 0) {
      const buf = new ArrayBuffer(64);
      return Promise.resolve({ ok: true, arrayBuffer: function () { return Promise.resolve(buf); } });
    }
    return origFetch(url, opts);
  };
  await send(chrome, { type: 'ms-download', item: { url: 'https://cdn.example.com/hotlink.mp4', kind: 'video', contentType: 'video/mp4' }, tabId: 7 });
  const hl = chrome.downloads.__downloads[chrome.downloads.__downloads.length - 1];
  eq(hl.opts.filename, 'hotlink.mp4', 'hotlink download filename');
  // the direct chrome.downloads attempt is interrupted with FORBIDDEN
  chrome.__listeners.onChanged.forEach(function (fn) { fn({ id: hl.id, state: { current: 'interrupted' }, error: { current: 'SERVER_FORBIDDEN' } }); });
  await settle();
  const hlBlob = chrome.downloads.__downloads[chrome.downloads.__downloads.length - 1];
  ok(hlBlob !== hl, 'fallback created a second download');
  ok(hlBlob.opts.url.indexOf('blob:') === 0, 'fallback downloads via blob');
  eq(hlBlob.opts.filename, hl.opts.filename, 'fallback keeps the same filename');
  chrome.__listeners.onChanged.forEach(function (fn) { fn({ id: hlBlob.id, state: { current: 'complete' } }); });
  await flush();
  qs = await send(chrome, { type: 'ms-queue-status' });
  ok(qs.queue.some(function (q) { return q.filename === 'hotlink.mp4' && q.status === 'complete'; }), 'fallback download completed');
  ctxRef.fetch = origFetch;

  // --- 13. X/Twitter pattern: Authorization header captured -> direct chrome
  // downloads attempt is SKIPPED entirely (the CDN would return 200 + junk
  // body without the header, i.e. an empty "mp4"), fetch goes straight
  // through the offscreen path with the header -------------------------------
  ctxRef.fetch = function (url, opts) {
    chrome.__swFetchLog.push(url);
    chrome.__swFetchOpts.push({ url: url, opts: opts || {} });
    if (url.indexOf('xvideo.mp4') >= 0) {
      const buf = new ArrayBuffer(5000);
      return Promise.resolve({ ok: true, arrayBuffer: function () { return Promise.resolve(buf); } });
    }
    return origFetch(url, opts);
  };
  sh({
    url: 'https://video.twimg.com/ext_tw_video/xvideo.mp4',
    initiator: 'https://x.com/',
    requestHeaders: [{ name: 'Authorization', value: 'Bearer xtoken' }],
  });
  const beforeDls = chrome.downloads.__downloads.length;
  await send(chrome, { type: 'ms-download', item: { url: 'https://video.twimg.com/ext_tw_video/xvideo.mp4', kind: 'video', contentType: 'video/mp4' }, tabId: 7 });
  await settle();
  const xDl = chrome.downloads.__downloads[chrome.downloads.__downloads.length - 1];
  eq(chrome.downloads.__downloads.length, beforeDls + 1, 'exactly one download for auth URL (no direct attempt)');
  ok(xDl.opts.url.indexOf('blob:') === 0, 'auth URL downloaded via offscreen blob, never direct http');
  eq(xDl.opts.filename, 'xvideo.mp4', 'auth download keeps filename');
  const xFetch = chrome.__swFetchOpts.find(function (f) { return f.url.indexOf('xvideo.mp4') >= 0; });
  ok(xFetch && xFetch.opts.headers && xFetch.opts.headers.Authorization === 'Bearer xtoken', 'Authorization sent on offscreen fetch');
  chrome.__listeners.onChanged.forEach(function (fn) { fn({ id: xDl.id, state: { current: 'complete' } }); });
  await flush();
  ctxRef.fetch = origFetch;

  // --- 14. X Spaces replay: audio-only HLS (.aac ADTS chunks) ---------------
  // detection surfaces one 'hls-audio' item (no master exists for spaces),
  // chunks are never listed individually, save produces a .aac file
  const rsp = chrome.__listeners.onWebResponseStarted[0];
  rsp({
    statusCode: 200, tabId: 7, initiator: 'https://x.com/',
    url: 'https://pscp.example.com/hls/space.m3u8?type=replay',
    responseHeaders: [{ name: 'Content-Type', value: 'application/x-mpegURL' }],
  });
  await settle();
  let got7 = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  const spaceItem = got7.items.find(function (i) { return i.url.indexOf('space.m3u8') >= 0; });
  ok(!!spaceItem, 'space playlist item added');
  eq(spaceItem && spaceItem.kind, 'hls-audio', 'audio-only HLS labeled hls-audio');
  eq(spaceItem && spaceItem.duration, 6, 'space duration parsed');
  ok(!got7.items.some(function (i) { return /\.aac$/.test(i.url.split(/[?#]/)[0]); }), 'aac chunks never listed');
  // chunks are filtered even if reported directly
  const chunkAdd = await send(chrome, { type: 'ms-report', tabId: 7, items: [{ url: 'https://pscp.example.com/hls/chunk_9_9_a.aac', kind: 'audio' }] });
  eq(chunkAdd.added, 0, 'direct chunk report filtered');

  const spaceResp = await send(chrome, { type: 'ms-hls-download', url: 'https://pscp.example.com/hls/space.m3u8?type=replay', title: 'My Space' }, { tab: { id: 7 } });
  ok(spaceResp && spaceResp.queued, 'space hls queued');
  await settle();
  const spaceJob = await send(chrome, { type: 'ms-hls-status', url: 'https://pscp.example.com/hls/space.m3u8?type=replay' });
  eq(spaceJob.status, 'downloading', 'space job downloading');
  eq(spaceJob.done, 2, 'both aac chunks combined');
  const spaceQ = await send(chrome, { type: 'ms-queue-status' });
  const spaceQe = spaceQ.queue.find(function (q) { return q.filename.indexOf('My Space') >= 0; });
  ok(!!spaceQe, 'space download queued');
  ok(spaceQe && spaceQe.filename.endsWith('.aac'), 'space output is .aac, not .ts');
  const spaceBuild = chrome.__swFetchOpts.find(function (f) { return /chunk_1_0_a\.aac$/.test(f.url); });
  ok(!!spaceBuild, 'aac chunks fetched');

  // --- 15. live HLS recording: starts on save, stops via ms-hls-stop ----------
  ctxRef.fetch = function (url, opts) {
    if (url.indexOf('live.m3u8') >= 0) {
      return Promise.resolve({ ok: true, text: function () {
        // no EXT-X-ENDLIST -> live
        return Promise.resolve('#EXTM3U\n#EXTINF:2,\nls0.ts\n#EXTINF:2,\nls1.ts\n');
      } });
    }
    return origFetch(url, opts);
  };
  const liveResp = await send(chrome, { type: 'ms-hls-download', url: 'https://cdn.example.com/live.m3u8', title: 'Live Show' }, { tab: { id: 7 } });
  ok(liveResp && liveResp.recording, 'live recording started (non-blocking response)');
  let liveStatus = await send(chrome, { type: 'ms-hls-status', url: 'https://cdn.example.com/live.m3u8' });
  eq(liveStatus.status, 'recording', 'live job is recording');
  const liveRun = chrome.__ffmpegRuns.find(function (r) { return r.url.indexOf('live.m3u8') >= 0; });
  ok(!!liveRun, 'live playlist handed to ffmpeg');
  ok(liveRun && liveRun.live === true, 'ffmpeg job flagged live');
  // duplicate start while recording is rejected
  const liveDup = await send(chrome, { type: 'ms-hls-download', url: 'https://cdn.example.com/live.m3u8', title: 'x' }, { tab: { id: 7 } });
  ok(liveDup && liveDup.alreadyRunning, 'live duplicate rejected');
  // user presses Stop -> offscreen aborts, blob queued
  const stopResp = await send(chrome, { type: 'ms-hls-stop', url: 'https://cdn.example.com/live.m3u8' });
  ok(stopResp && stopResp.ok, 'stop acknowledged');
  await settle();
  liveStatus = await send(chrome, { type: 'ms-hls-status', url: 'https://cdn.example.com/live.m3u8' });
  eq(liveStatus.status, 'downloading', 'live job downloading after stop');
  const liveQ = await send(chrome, { type: 'ms-queue-status' });
  ok(liveQ.queue.some(function (q) { return q.filename.indexOf('Live Show') >= 0 && q.filename.endsWith('.mp4'); }), 'live recording saved as mp4');
  ctxRef.fetch = origFetch;

  // --- 16. DASH (mpd): track enumeration + fetch-our-own segment build ------
  // real mpd text (SegmentTemplate + SegmentTimeline): the detector must
  // list one item per adaptation set; saving resolves init + media segment
  // URLs and hands them to the offscreen dash builder (never ffmpeg+jsfetch).
  const dashMpdText =
    '<MPD mediaPresentationDuration="PT4.0S"><Period>' +
    '<AdaptationSet contentType="video">' +
    '<Representation id="0" mimeType="video/mp4" codecs="avc1.42c00c" bandwidth="520581" width="320" height="240">' +
    '<SegmentTemplate timescale="15360" startNumber="1" initialization="vinit-$RepresentationID$.m4s" media="vchunk-$RepresentationID$-$Number%05d$.m4s">' +
    '<SegmentTimeline><S t="0" d="46080"/><S d="46080"/></SegmentTimeline>' +
    '</SegmentTemplate></Representation></AdaptationSet>' +
    '<AdaptationSet contentType="audio">' +
    '<Representation id="1" mimeType="audio/mp4" codecs="mp4a.40.2" bandwidth="69000">' +
    '<SegmentTemplate timescale="44100" startNumber="1" initialization="ainit-$RepresentationID$.m4s" media="achunk-$RepresentationID$-$Number%05d$.m4s">' +
    '<SegmentTimeline><S t="0" d="44032"/><S d="44032"/></SegmentTimeline>' +
    '</SegmentTemplate></Representation></AdaptationSet>' +
    '</Period></MPD>';
  ctxRef.fetch = function (url) {
    if (url.indexOf('manifest.mpd') >= 0) {
      return Promise.resolve({
        ok: true,
        text: function () { return Promise.resolve(dashMpdText); },
        arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(100)); },
      });
    }
    if (url.indexOf('.m4s') >= 0) {
      return Promise.resolve({
        ok: true,
        arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(500)); },
      });
    }
    return origFetch(url);
  };
  wr({
    statusCode: 200, url: 'https://cdn.example.com/v3/manifest.mpd?sig=1', tabId: 7,
    initiator: 'https://site.example.com/', type: 'xmlhttprequest',
    responseHeaders: [{ name: 'content-type', value: 'application/dash+xml' }],
  });
  await settle();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  const dashItems = r.items.filter(function (i) { return i.url.indexOf('manifest.mpd') >= 0; });
  eq(dashItems.length, 2, 'dash: one item per track (video + audio)');
  const dashVideo = dashItems.find(function (i) { return i.dashEntry === 0; });
  const dashAudio = dashItems.find(function (i) { return i.dashEntry === 1; });
  ok(!!dashVideo && !!dashAudio, 'dash entries 0 and 1');
  eq(dashVideo && dashVideo.kind, 'dash', 'dash kind');
  eq(dashVideo && dashVideo.dashType, 'video', 'video track type');
  eq(dashAudio && dashAudio.dashType, 'audio', 'audio track type');
  ok(dashVideo && dashVideo.title.indexOf('320x240') >= 0, 'video item labelled with resolution');
  ok(dashAudio && dashAudio.title.indexOf('音声') >= 0, 'audio item labelled 音声');

  // save the video track: segments resolved from the template, audio track
  // muxed in as well (both handed to the offscreen dash builder)
  const dashResp = await send(chrome, { type: 'ms-hls-download', url: 'https://cdn.example.com/v3/manifest.mpd?sig=1', title: 'Dash Video', dashEntry: 0, dashType: 'video' }, { tab: { id: 7 } });
  ok(dashResp && dashResp.queued, 'dash video queued');
  const db0 = chrome.__dashBuilds[0];
  ok(!!db0, 'dash video handed to offscreen dash builder');
  ok(db0 && db0.video, 'video track in build request');
  eq(db0 && db0.video && db0.video.segments.length, 2, 'video: 2 media segments resolved');
  ok(db0 && db0.video && db0.video.initUrl.indexOf('vinit-0.m4s') >= 0, 'video init URL resolved ($RepresentationID$ filled)');
  ok(db0 && db0.video && db0.video.segments[0].indexOf('vchunk-0-00001.m4s') >= 0, 'segment 1 number padded');
  ok(db0 && db0.video && db0.video.segments[1].indexOf('vchunk-0-00002.m4s') >= 0, 'segment 2 number incremented');
  ok(db0 && db0.audio && db0.audio.segments.length === 2, 'audio track muxed into video save');
  ok(db0 && db0.audio && db0.audio.initUrl.indexOf('ainit-1.m4s') >= 0, 'audio init URL resolved');
  ok(!chrome.__ffmpegRuns.some(function (x) { return x.kind === 'dash'; }), 'dash never uses ffmpeg dash demuxer');
  // save the audio track: audio only, m4a out
  const dashAudioResp = await send(chrome, { type: 'ms-hls-download', url: 'https://cdn.example.com/v3/manifest.mpd?sig=1', title: 'Dash Audio', dashEntry: 1, dashType: 'audio' }, { tab: { id: 7 } });
  ok(dashAudioResp && dashAudioResp.queued, 'dash audio queued');
  const db1 = chrome.__dashBuilds[1];
  ok(!!db1, 'dash audio handed to offscreen dash builder');
  ok(db1 && !db1.video, 'audio save has no video track');
  eq(db1 && db1.audio && db1.audio.segments.length, 2, 'audio: 2 media segments resolved');
  // status polling must find the job under its entry-qualified key
  const dashStatus = await send(chrome, { type: 'ms-hls-status', url: 'https://cdn.example.com/v3/manifest.mpd?sig=1', dashEntry: 0 });
  ok(!!dashStatus, 'status resolves for entry-qualified job key');
  const dashQ = await send(chrome, { type: 'ms-queue-status' });
  ok(dashQ.queue.some(function (q) { return q.filename.indexOf('Dash Video') >= 0 && q.filename.endsWith('.mp4'); }), 'dash video saved as mp4');
  ok(dashQ.queue.some(function (q) { return q.filename.indexOf('Dash Audio') >= 0 && q.filename.endsWith('.m4a'); }), 'dash audio saved as m4a');

  // unparseable manifest: detection falls back to a single plain item, but
  // saving fails cleanly (nothing to fetch) instead of hanging
  wr({
    statusCode: 200, url: 'https://cdn.example.com/v3/opaque.mpd', tabId: 7,
    initiator: 'https://site.example.com/', type: 'xmlhttprequest',
    responseHeaders: [{ name: 'content-type', value: 'application/dash+xml' }],
  });
  await settle();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  const opaque = r.items.find(function (i) { return i.url.indexOf('opaque.mpd') >= 0; });
  ok(!!opaque && opaque.dashEntry === -1, 'unparseable mpd -> single fallback item');
  const opaqueResp = await send(chrome, { type: 'ms-hls-download', url: 'https://cdn.example.com/v3/opaque.mpd', title: 'Opaque', dashEntry: -1 }, { tab: { id: 7 } });
  ok(opaqueResp && opaqueResp.error, 'fallback dash fails cleanly with an error');
  eq(chrome.__dashBuilds.length, 2, 'no dash build attempted for unparseable manifest');
  ctxRef.fetch = origFetch;

  report('background');
}

run().catch(function (e) {
  console.error(e);
  process.exit(1);
});
