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
function makeChrome(sharedStorage, sharedDownloads) {
  const storageData = sharedStorage || {};
  const listeners = { onDeterminingFilename: [], onChanged: [], onMessage: [], onRemoved: [], onActivated: [], onWebResponseStarted: [], onSendHeaders: [] };
  const downloads = sharedDownloads || [];
  let downloadSeq = downloads.reduce(function (max, item) { return Math.max(max, item.id || 0); }, 0) + 1;
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
      local: {
        get: function () { return Promise.resolve({}); },
        set: function () { return Promise.resolve(); },
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
      search: function (query, cb) {
        const d = downloads.find(function (entry) { return entry.id === query.id; });
        const result = d ? [{
          id: d.id,
          state: d.state || (d.done ? 'complete' : 'in_progress'),
          error: d.error || null,
          bytesReceived: d.receivedBytes || 0,
          totalBytes: d.totalBytes || 0,
        }] : [];
        if (d && d.delaySearch) {
          return new Promise(function (resolve) {
            setTimeout(function () { if (cb) cb(result); resolve(result); }, 5);
          });
        }
        if (cb) cb(result);
        return Promise.resolve(result);
      },
      __downloads: downloads,
    },
    runtime: {
      lastError: null,
      onMessage: { addListener: function (fn) { listeners.onMessage.push(fn); } },
      sendMessage: function (msg) {
        if (msg && msg.type === 'ms-offscreen-revoke-url') {
          chrome.__revokeMessages.push(msg);
          return Promise.resolve({ ok: true, released: true });
        }
        // emulate the offscreen document: it fetches bytes ITSELF (the real
        // one never receives bytes over messaging — Brave drops them)
        if (msg && msg.type === 'ms-offscreen-fetch-blob') {
          return Promise.resolve()
            .then(function () { return chrome.__ctx.fetch(msg.url, { credentials: 'include', headers: msg.headers || {} }); })
            .then(function (res) {
              if (!res.ok) return { error: 'http ' + res.status };
              return res.arrayBuffer().then(function (buf) {
                return { url: 'blob:chrome-extension://testextensionid/combined-' + buf.byteLength, size: buf.byteLength };
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
            return { url: 'blob:chrome-extension://testextensionid/combined-' + total, size: total };
          }).catch(function (err) { return { error: String(err && err.message || err) }; });
        }
        if (msg && msg.type === 'ms-offscreen-ffmpeg-status') {
          return Promise.resolve({
            running: !!chrome.__ffmpegLiveResolve,
            jobId: chrome.__ffmpegLiveResolve ? (chrome.__ffmpegLiveJobId || null) : null,
            seconds: 3, bytes: 1234, done: chrome.__ffmpegDone || null,
          });
        }
        if (msg && (msg.type === 'ms-offscreen-keepalive-acquire' || msg.type === 'ms-offscreen-keepalive-release')) {
          chrome.__leaseMessages.push(msg);
          return Promise.resolve({ ok: true });
        }
        if (msg && msg.type === 'ms-offscreen-ffmpeg-run') {
          chrome.__ffmpegRuns.push(msg);
          if (msg.live) {
            // emulate a recording: resolves only when ms-offscreen-ffmpeg-abort arrives
            chrome.__ffmpegLiveJobId = msg.jobId;
            return new Promise(function (resolve) { chrome.__ffmpegLiveResolve = resolve; });
          }
          if (chrome.__holdFfmpegVod) {
            return new Promise(function (resolve) { chrome.__ffmpegVodResolve = resolve; });
          }
          // emulate a VOD remux: real ffmpeg would jsfetch everything itself
          chrome.__ffmpegDone = { jobId: msg.jobId, url: 'blob:chrome-extension://testextensionid/ffmpeg-remux', size: 5000, ext: msg.ext, partial: false };
          return Promise.resolve({ url: chrome.__ffmpegDone.url, size: chrome.__ffmpegDone.size, partial: false });
        }
        if (msg && msg.type === 'ms-offscreen-mux-local') {
          return Promise.resolve({ url: 'blob:chrome-extension://testextensionid/mux-local', size: 7777 });
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
            return { url: 'blob:chrome-extension://testextensionid/dash-' + total, size: total };
          }).catch(function (err) { return { error: String(err && err.message || err) }; });
        }
        if (msg && msg.type === 'ms-offscreen-ffmpeg-abort') {
          if (chrome.__ffmpegLiveResolve) {
            const resolve = chrome.__ffmpegLiveResolve;
            chrome.__ffmpegLiveResolve = null;
            resolve({ url: 'blob:chrome-extension://testextensionid/ffmpeg-live-partial', size: 3000, partial: true });
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
    __leaseMessages: [],
    __revokeMessages: [],
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
      if (url.indexOf('huge.m3u8') >= 0) {
        return Promise.resolve({ ok: true, text: function () {
          return Promise.resolve('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n' + '#'.repeat(2 * 1024 * 1024));
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
  // Deterministic timers: recovery polling must not hold the test process open.
  ctx.__timers = [];
  ctx.setTimeout = function (fn) { ctx.__timers.push(fn); return ctx.__timers.length; };
  ctx.clearTimeout = function () {};
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

  // A valid-looking HLS response that exceeds the parser input budget must
  // not become a top-level card after the asynchronous validation fetch.
  const responseListener = chrome.__listeners.onWebResponseStarted[0];
  responseListener({
    url: 'https://cdn.example.com/huge.m3u8', statusCode: 200, tabId: 99,
    responseHeaders: [{ name: 'content-type', value: 'application/vnd.apple.mpegurl' }],
  });
  await flush();
  await flush();
  await flush();
  const boundedItems = (await send(chrome, { type: 'ms-get-items', tabId: 99 })).items;
  eq(boundedItems.some(function (item) { return item.url.indexOf('huge.m3u8') >= 0; }), false, 'oversized HLS response is rejected by background');
  await send(chrome, { type: 'ms-clear', tabId: 99 });

  // --- 1. report + dedupe + get ---------------------------------------------
  let r = await send(chrome, { type: 'ms-report', items: [
    { url: 'https://cdn.example.com/a.mp4', kind: 'video', size: 9000000, contentType: 'video/mp4', pageUrl: 'https://site.example.com/p' },
    { url: 'https://cdn.example.com/a.mp4?tok=1', kind: 'video', size: 0 },
    { url: 'https://cdn.example.com/b.m3u8', kind: 'hls' },
    { url: 'blob:https://site.example.com/u1', kind: 'video' },
    { url: 'blob:chrome-extension://' + 'a'.repeat(32) + '/assembled', kind: 'video', ext: 'aac', size: 123 },
    { url: 'https://site.example.com/page.html' },
  ], tabId: 1 });
  eq(r.added, 3, '3 distinct items added (page blob rejected as dead, query dup merged, html rejected)');
  r = await send(chrome, { type: 'ms-get-items', tabId: 1 });
  eq(r.items.length, 3, 'get-items returns 3');
  eq(r.items[0].kind, 'video', 'video sorted first');
  eq(r.items[0].size, 9000000, 'richer copy kept');

  // --- 2. normal download: filename routed, completion frees slot -----------
  await send(chrome, { type: 'ms-download', item: { url: 'https://cdn.example.com/a.mp4', kind: 'video' }, tabId: 1 });
  eq(chrome.downloads.__downloads.length, 1, 'one download started');
  eq(chrome.downloads.__downloads[0].opts.filename, 'a.mp4', 'flat filename passed');
  const d1 = chrome.downloads.__downloads[0].id;
  chrome.downloads.__downloads[0].receivedBytes = 4500000;
  chrome.downloads.__downloads[0].totalBytes = 9000000;
  let qs = await send(chrome, { type: 'ms-queue-status', tabId: 1 });
  eq(qs.queue[0].receivedBytes, 4500000, 'queue status reports browser bytes received');
  eq(qs.queue[0].totalBytes, 9000000, 'queue status reports browser total bytes');
  const activeDirectState = await send(chrome, { type: 'ms-get-items', tabId: 1 });
  ok(activeDirectState.activeDownloads.some(function (download) {
    return download.id === qs.queue[0].id && download.sourceUrl === 'https://cdn.example.com/a.mp4';
  }), 'get-items exposes active direct downloads so a reopened popup can reconnect');
  const jobsFromAnotherTab = await send(chrome, { type: 'ms-get-jobs', tabId: 99 });
  ok(jobsFromAnotherTab.jobs.some(function (job) {
    return job.id === qs.queue[0].id && job.tabId === 1 && job.status === 'started';
  }), 'global jobs are visible after switching to another page tab');
  chrome.__listeners.onChanged.forEach(function (fn) { fn({ id: d1, state: { current: 'complete' } }); });
  chrome.downloads.__downloads[0].done = true;
  await flush();
  qs = await send(chrome, { type: 'ms-queue-status', tabId: 1 });
  eq(qs.queue[0].status, 'complete', 'complete recorded');

  // --- 3. concurrency: 3 active max ------------------------------------------
  for (let i = 0; i < 5; i++) {
    await send(chrome, { type: 'ms-download', item: { url: 'https://cdn.example.com/clip' + i + '.mp4', kind: 'video' }, tabId: 1 });
  }
  const running = chrome.downloads.__downloads.filter(function (d) { return !d.done; });
  eq(running.length, 3, 'concurrency capped at 3');
  const reopenedQueueState = await send(chrome, { type: 'ms-get-items', tabId: 1 });
  ok(reopenedQueueState.activeDownloads.length <= 3, 'popup reconnect exposes only bounded active downloads');
  ok(reopenedQueueState.activeDownloads.every(function (download) { return download.status !== 'queued'; }), 'queued Save All backlog does not create popup polling timers');
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
  await send(chrome, { type: 'ms-download-blob', url: 'blob:chrome-extension://' + 'a'.repeat(32) + '/blob1', kind: 'video' }, {});
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

  // Instagram/Meta's media request is often only an fMP4 byte fragment. Its
  // body starts with moof and is not playable alone; the same signed URL with
  // bytestart/byteend removed returns the complete ftyp/moov MP4.
  wr({
    statusCode: 200,
    url: 'https://scontent.example/o1/video.mp4?sig=a%2Fb&bytestart=927166&byteend=2193211&ccb=17-1',
    tabId: 7, initiator: 'https://www.instagram.com/', type: 'media',
    responseHeaders: [
      { name: 'Content-Type', value: 'video/mp4' },
      { name: 'Content-Length', value: '1266046' },
    ],
  });
  await flush();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  const ig = r.items.find(function (i) { return i.url.indexOf('scontent.example') >= 0; });
  ok(!!ig, 'Instagram byte-range media detected');
  eq(ig.url, 'https://scontent.example/o1/video.mp4?sig=a%2Fb&ccb=17-1', 'Instagram item points at complete MP4 URL');

  // Meta's observed response is only a fragment. The full URL item must use
  // the Content-Range total, or zero when the response gives no total, never
  // the fragment's Content-Length.
  wr({
    statusCode: 200,
    url: 'https://scontent.example/o1/range-total.mp4?sig=range-total&bytestart=100&byteend=199',
    tabId: 7, initiator: 'https://www.instagram.com/', type: 'media',
    responseHeaders: [
      { name: 'Content-Type', value: 'video/mp4' },
      { name: 'Content-Length', value: '600000' },
      { name: 'Content-Range', value: 'bytes 100-199/9000000' },
    ],
  });
  await flush();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  const rangeTotal = r.items.find(function (i) { return i.url.indexOf('range-total.mp4') >= 0; });
  eq(rangeTotal && rangeTotal.size, 9000000, 'Meta full URL uses Content-Range total size');

  wr({
    statusCode: 200,
    url: 'https://scontent.example/o1/range-unknown.mp4?sig=range-unknown&bytestart=200&byteend=299',
    tabId: 7, initiator: 'https://www.instagram.com/', type: 'media',
    responseHeaders: [
      { name: 'Content-Type', value: 'video/mp4' },
      { name: 'Content-Length', value: '600000' },
    ],
  });
  await flush();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  const rangeUnknown = r.items.find(function (i) { return i.url.indexOf('range-unknown.mp4') >= 0; });
  eq(rangeUnknown && rangeUnknown.size, 0, 'Meta full URL uses zero when range total is unknown');

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
    { url: 'https://rr2---sn-youtube.googlevideo.com/videoplayback?itag=22', kind: 'video', contentType: 'video/mp4', size: 9000000, via: 'youtube', pageUrl: 'https://www.youtube.com/watch?v=abc', title: 'YT Video [720p]', duration: 300 },
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

  // m3u8 via content-type -> one logical master item with nested variants
  wr({
    statusCode: 200, url: 'https://cdn.example.com/live/master.m3u8', tabId: 7,
    initiator: 'https://site.example.com/', type: 'xmlhttprequest',
    responseHeaders: [{ name: 'content-type', value: 'application/vnd.apple.mpegurl' }],
  });
  await flush();
  await flush();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  const hlsItem = r.items.find(function (i) { return i.kind === 'hls'; });
  ok(!!hlsItem, 'hls master item added');
  eq(hlsItem && hlsItem.url, 'https://cdn.example.com/live/master.m3u8', 'master URL remains the logical item URL');
  eq(hlsItem && hlsItem.variants.length, 1, 'master keeps its nested variant');
  eq(hlsItem && hlsItem.variants[0].url, 'https://cdn.example.com/live/media.m3u8', 'variant media playlist preserved');
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
  chrome.__holdFfmpegVod = true;
  let hlsResp = null;
  chrome.__listeners.onMessage[0](
    { type: 'ms-hls-download', url: 'https://cdn.example.com/live/master.m3u8', itemKey: 'stable-hls-key', title: 'HLS Test Video', pageUrl: 'https://site.example.com/watch/9' },
    { tab: { id: 7 } },
    function (response) { hlsResp = response; }
  );
  for (let i = 0; i < 12; i++) await flush();
  ok(hlsResp && hlsResp.started, 'HLS start is acknowledged before ffmpeg finishes so closing the popup cannot cancel the job');
  ok(typeof chrome.__ffmpegVodResolve === 'function', 'HLS ffmpeg remains active after the start acknowledgement');
  const activeItemState = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  ok(activeItemState.activeJobs.some(function (job) {
    return job.jobKey === hlsResp.jobKey && job.itemKey === 'stable-hls-key' && job.sourceUrl === 'https://cdn.example.com/live/master.m3u8';
  }), 'get-items exposes active jobs so a reopened popup can reconnect');
  ok(Array.isArray(chrome.__storageData.msActiveJobs) && chrome.__storageData.msActiveJobs.some(function (saved) {
    return saved.key === hlsResp.jobKey && saved.job.status === 'combining';
  }), 'active media job is persisted before a service-worker restart');
  const globalMediaJobs = await send(chrome, { type: 'ms-get-jobs', tabId: 999 });
  ok(globalMediaJobs.jobs.some(function (job) {
    return job.title === 'HLS Test Video' && job.tabId === 7 && job.type === 'media';
  }), 'active HLS job stays visible globally after switching page tabs');
  const rotatedDuplicate = await send(chrome, {
    type: 'ms-hls-download', url: 'https://cdn.example.com/live/master.m3u8?token=rotated',
    itemKey: 'stable-hls-key', title: 'HLS duplicate'
  }, { tab: { id: 7 } });
  ok(rotatedDuplicate && rotatedDuplicate.alreadyRunning && rotatedDuplicate.jobKey === hlsResp.jobKey,
    'rotating a signed URL cannot duplicate the same stable media item');
  chrome.__holdFfmpegVod = false;
  chrome.__ffmpegDone = { jobId: 'https://cdn.example.com/live/master.m3u8', url: 'blob:chrome-extension://testextensionid/ffmpeg-remux', size: 5000, ext: 'mp4', partial: false };
  chrome.__ffmpegVodResolve({ url: chrome.__ffmpegDone.url, size: chrome.__ffmpegDone.size, partial: false });
  for (let i = 0; i < 12; i++) await flush();
  ok(chrome.__leaseMessages.some(function (m) { return m.type === 'ms-offscreen-keepalive-acquire'; }), 'service worker acquires an offscreen keepalive before fetching the HLS manifest');
  ok(chrome.__leaseMessages.some(function (m) { return m.type === 'ms-offscreen-keepalive-release'; }), 'service worker releases the pre-offscreen keepalive after handoff');
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
  // Offscreen progress drives the popup's "converting" line. The previous
  // implementation polled libav APIs that do not exist in the bundled build,
  // so a job that ran for minutes displayed "media 0s · output 0B" throughout.
  chrome.__listeners.onMessage.forEach(function (fn) {
    fn({
      type: 'ms-offscreen-progress',
      jobId: hlsResp.jobKey,
      seconds: 0,
      bytes: 943718400,
      fetches: 42,
      fetchedBytes: 8388608,
    }, {}, function () {});
  });
  const hlsProgress = await send(chrome, { type: 'ms-hls-status', url: 'https://cdn.example.com/live/master.m3u8' }, {});
  eq(hlsProgress.bytes, 943718400, 'written bytes past the old 768 MiB ceiling reach the popup');
  eq(hlsProgress.fetches, 42, 'segment fetch count reaches the popup');
  eq(hlsProgress.fetchedBytes, 8388608, 'fetched bytes reach the popup');
  const jobsProgress = await send(chrome, { type: 'ms-get-jobs' });
  const progressJob = jobsProgress.jobs.find(function (job) { return job.type === 'media' && job.title === 'HLS Test Video'; });
  ok(!!progressJob, 'converting job is listed for other tabs');
  eq(progressJob && progressJob.bytes, 943718400, 'global jobs list reports the same artifact size');
  eq(progressJob && progressJob.fetches, 42, 'global jobs list reports the same fetch activity');
  // A conversion artifact is a temporary OPFS file behind an extension-owned
  // blob URL. A save that can never complete must release that URL, otherwise
  // the file survives until the offscreen document goes away.
  chrome.__revokeMessages.length = 0;
  await send(chrome, {
    type: 'ms-download',
    item: { url: 'blob:chrome-extension://testextensionid/ffmpeg-remux', kind: 'video', ext: 'mp4', contentType: 'video/mp4', title: 'Big artifact' },
    tabId: 7,
  });
  const artifactDownload = chrome.downloads.__downloads[chrome.downloads.__downloads.length - 1];
  chrome.__listeners.onChanged.forEach(function (fn) {
    fn({ id: artifactDownload.id, state: { current: 'interrupted' }, error: { current: 'NETWORK_FAILED' } });
  });
  await flush();
  ok(chrome.__revokeMessages.some(function (m) { return String(m.url).indexOf('blob:chrome-extension://') === 0; }),
    'a failed save releases its disk-backed artifact so the temporary file is deleted');
  const artifactQueue = await send(chrome, { type: 'ms-queue-status' });
  const failedArtifact = artifactQueue.queue.find(function (q) { return String(q.filename).indexOf('Big artifact') >= 0; });
  eq(failedArtifact && failedArtifact.status, 'failed',
    'a disk-backed artifact that cannot be re-fetched fails instead of retrying a dead URL');
  // queued download is the blob, with title-based filename
  qs = await send(chrome, { type: 'ms-queue-status' });
  const hlsQ = qs.queue.filter(function (q) { return q.filename.indexOf('HLS Test Video') >= 0; });
  eq(hlsQ.length, 1, 'hls output named by title');
  ok(hlsQ[0].filename.endsWith('.mp4'), 'mp4 container after remux');
  ok(Array.isArray(chrome.__storageData.msActiveQueue) && chrome.__storageData.msActiveQueue.some(function (saved) {
    return saved.hlsUrl === hlsResp.jobKey && Number.isFinite(saved.downloadId);
  }), 'browser handoff is persisted before a service-worker restart');
  // Retrying the same media leaves the old queue row behind. Status must bind
  // to the newest active handoff, never the first stale completed row.
  const oldHlsDownload = chrome.downloads.__downloads.find(function (d) { return d.opts.filename.indexOf('HLS Test Video') >= 0; });
  oldHlsDownload.receivedBytes = 5000;
  oldHlsDownload.totalBytes = 5000;
  chrome.__listeners.onChanged.forEach(function (fn) { fn({ id: oldHlsDownload.id, state: { current: 'complete' } }); });
  oldHlsDownload.done = true;
  await flush();
  const dup = await send(chrome, { type: 'ms-hls-download', url: 'https://cdn.example.com/live/master.m3u8', title: 'HLS Test Video retry' }, { tab: { id: 7 } });
  ok(dup && dup.started, 'completed HLS can be retried');
  for (let i = 0; i < 12; i++) await flush();
  const retryHlsDownload = chrome.downloads.__downloads.filter(function (d) { return d.opts.filename.indexOf('HLS Test Video retry') >= 0; }).slice(-1)[0];
  ok(!!retryHlsDownload, 'retry creates a distinct browser download handoff');
  retryHlsDownload.receivedBytes = 0;
  retryHlsDownload.totalBytes = 128;
  const retryProgress = await send(chrome, { type: 'ms-hls-status', url: 'https://cdn.example.com/live/master.m3u8' });
  eq(retryProgress.receivedBytes, 0, 'retry progress ignores stale completed queue bytes');
  eq(retryProgress.totalBytes, 128, 'retry progress uses newest active queue total');
  oldHlsDownload.delaySearch = true;
  await send(chrome, { type: 'ms-queue-status' });
  const jobBytesAfterStaleRefresh = vm.runInContext("state.hlsJobs.get('https://cdn.example.com/live/master.m3u8').receivedBytes", ctx);
  eq(jobBytesAfterStaleRefresh, 0, 'stale queue refresh cannot overwrite replacement HLS job progress');

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
  ok(encResp && encResp.started, 'encrypted HLS accepted before ffmpeg finishes');
  await settle();
  ok(chrome.__ffmpegRuns.some(function (r) { return r.url.indexOf('enc.m3u8') >= 0; }), 'encrypted playlist handed to ffmpeg');
  ctxRef.fetch = origFetch;

  async function settle() { for (let i = 0; i < 8; i++) await flush(); }

  // --- 10. multi-variant master: one item preserves every quality ------------
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
  const grouped = r.items.find(function (i) { return i.url.indexOf('multi.m3u8') >= 0; });
  eq(r.items.filter(function (i) { return i.url.indexOf('multi.m3u8') >= 0; }).length, 1, 'multi-variant: one logical item');
  const v720 = grouped && grouped.variants.find(function (i) { return i.url.indexOf('v720.m3u8') >= 0; });
  const v360 = grouped && grouped.variants.find(function (i) { return i.url.indexOf('v360.m3u8') >= 0; });
  ok(!!v720 && !!v360, 'multi-variant: all variants nested');
  eq(grouped && grouped.title, 'Cool Video Page', 'grouped item keeps the page title');
  eq(grouped && grouped.selectedVariantKey, v720 && v720.url, 'highest bandwidth variant selected by default');
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
  ok(authResp && authResp.started, 'auth hls started');
  await settle();
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
  ok(spaceResp && spaceResp.started, 'space hls started');
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
  ok(liveResp && liveResp.started, 'live recording start acknowledged without holding the popup open');
  await settle();
  let liveStatus = await send(chrome, { type: 'ms-hls-status', url: 'https://cdn.example.com/live.m3u8' });
  eq(liveStatus.status, 'recording', 'live job is recording');
  const liveRun = chrome.__ffmpegRuns.find(function (r) { return r.url.indexOf('live.m3u8') >= 0; });
  ok(!!liveRun, 'live playlist handed to ffmpeg');
  ok(liveRun && liveRun.live === true, 'ffmpeg job flagged live');
  // A live TS recording is written as fragmented MP4, where ffmpeg does not
  // convert ADTS AAC by itself; without this flag the recording died on its
  // first audio packet.
  eq(liveRun && liveRun.adtsFix, true, 'TS live recording asks for the AAC-ADTS bitstream filter');
  const queuedBehindLive = await send(chrome, {
    type: 'ms-hls-download', url: 'https://cdn.example.com/live/master.m3u8?after-live=1', title: 'After Live'
  }, { tab: { id: 8 } });
  ok(queuedBehindLive && queuedBehindLive.started, 'VOD behind a live recording is accepted');
  await settle();
  eq(chrome.__ffmpegRuns.filter(function (r) { return /after-live/.test(r.url); }).length, 0,
    'global media serializer waits for live FFmpeg to stop');
  const queuedLiveJobs = await send(chrome, { type: 'ms-get-jobs' });
  const queuedAfterLive = queuedLiveJobs.jobs.find(function (job) { return job.title === 'After Live'; });
  eq(queuedAfterLive && queuedAfterLive.status, 'queued', 'VOD behind live remains visibly queued');
  // duplicate start while recording is rejected
  const liveDup = await send(chrome, { type: 'ms-hls-download', url: 'https://cdn.example.com/live.m3u8', title: 'x' }, { tab: { id: 7 } });
  ok(liveDup && liveDup.alreadyRunning, 'live duplicate rejected');
  // user presses Stop -> offscreen aborts, blob queued
  const stopResp = await send(chrome, { type: 'ms-hls-stop', url: 'https://cdn.example.com/live.m3u8' });
  ok(stopResp && stopResp.ok, 'stop acknowledged');
  await settle();
  ok(chrome.__ffmpegRuns.some(function (r) { return /after-live/.test(r.url); }),
    'queued VOD starts after live FFmpeg stops');
  liveStatus = await send(chrome, { type: 'ms-hls-status', url: 'https://cdn.example.com/live.m3u8' });
  eq(liveStatus.status, 'downloading', 'live job downloading after stop');
  const stoppedGlobal = await send(chrome, { type: 'ms-get-jobs' });
  const stoppedJob = stoppedGlobal.jobs.find(function (job) { return /Live Show/.test(job.title); });
  eq(stoppedJob && stoppedJob.live, false, 'stopped live job no longer offers a second Stop action');
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
  ok(dashResp && dashResp.started, 'dash video started');
  await settle();
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
  ok(dashAudioResp && dashAudioResp.started, 'dash audio started');
  await settle();
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
  ok(opaqueResp && opaqueResp.started, 'fallback dash start acknowledged');
  await settle();
  const opaqueStatus = await send(chrome, { type: 'ms-hls-status', url: 'https://cdn.example.com/v3/opaque.mpd', dashEntry: -1 });
  ok(opaqueStatus && opaqueStatus.status === 'failed' && opaqueStatus.error, 'fallback dash fails cleanly with an observable error');
  eq(chrome.__dashBuilds.length, 2, 'no dash build attempted for unparseable manifest');
  ctxRef.fetch = origFetch;

  // --- 17. two-source HLS: separate audio rendition (VDH two_sources) --------
  ctxRef.fetch = function (url, opts) {
    chrome.__swFetchLog.push(url);
    chrome.__swFetchOpts.push({ url: url, opts: opts || {} });
    if (url.indexOf('two.m3u8') >= 0) {
      return Promise.resolve({ ok: true, text: function () {
        return Promise.resolve([
          '#EXTM3U',
          '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Japanese",DEFAULT=YES,URI="aud/ja.m3u8"',
          '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="aud"',
          'two-video.m3u8',
        ].join('\n'));
      } });
    }
    if (url.indexOf('two-video.m3u8') >= 0 || url.indexOf('ja.m3u8') >= 0) {
      return Promise.resolve({ ok: true, text: function () {
        return Promise.resolve('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nseg0.ts\n#EXT-X-ENDLIST\n');
      } });
    }
    return origFetch(url, opts);
  };
  wr({
    statusCode: 200, url: 'https://cdn.example.com/v4/two.m3u8', tabId: 7,
    initiator: 'https://site.example.com/', type: 'xmlhttprequest',
    responseHeaders: [{ name: 'content-type', value: 'application/vnd.apple.mpegurl' }],
  });
  await settle();
  r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
  const two = r.items.find(function (i) { return i.url.indexOf('two.m3u8') >= 0; });
  const twoVariant = two && two.variants[0];
  ok(!!two, 'two-source master item surfaced');
  ok(!!twoVariant && twoVariant.audioUrl && twoVariant.audioUrl.indexOf('aud/ja.m3u8') >= 0, 'variant carries resolved audio rendition URL');
  // save it: the ffmpeg job must receive the audio URL for the 2-input mux
  chrome.__ffmpegRuns.length = 0;
  const twoResp = await send(chrome, {
    type: 'ms-hls-download', url: two.url, title: 'Two Source',
    variantUrl: twoVariant.url, variantKey: twoVariant.url, audioUrl: twoVariant.audioUrl,
  }, { tab: { id: 7 } });
  ok(twoResp && twoResp.started, 'two-source download started');
  await settle();
  eq(chrome.__ffmpegRuns.length, 1, 'one ffmpeg run');
  eq(chrome.__ffmpegRuns[0].audioUrl.indexOf('ja.m3u8') >= 0, true, 'ffmpeg job got the separate audio playlist');
  // headers replayed for BOTH playlists (captured Authorization must reach jsfetch)
  const twoHdrs = chrome.__ffmpegRuns[0].headers;
  ok(twoHdrs && typeof twoHdrs === 'object', 'two-source job has headers object');
  ctxRef.fetch = origFetch;

  // Regression (v0.11.0 field report): a YouTube progressive item saved via
  // the popup went through startDirect; googlevideo answered 403 with a
  // text/plain body, Brave labeled it "<title>.txt" (0 bytes) and interrupted
  // with SERVER_BAD_CONTENT. YouTube items must use the offscreen fetch path,
  // and SERVER_* refusals must trigger the fallback retry.
  {
    const c1 = makeChrome();
    const ctx1 = makeContext(c1);
    vm.runInContext(logicSrc, ctx1);
    vm.runInContext(bgSrc, ctx1);
    await send(c1, { type: 'ms-download', item: {
      url: 'https://rr4---sn-x.googlevideo.com/videoplayback?expire=1&itag=18',
      kind: 'video', ext: 'mp4', title: 'e2e_yt_direct', via: 'youtube', pageUrl: 'https://www.youtube.com/watch?v=x',
    } }, { tab: { id: 7 } });
    await flush();
    eq(c1.downloads.__downloads.length, 0, 'youtube item avoids bare chrome.downloads');
    ok('youtube item fetched via offscreen blob path',
       c1.__swFetchLog.some(function (u) { return u.indexOf('googlevideo') >= 0; }));

    const c2 = makeChrome();
    const ctx2 = makeContext(c2);
    vm.runInContext(logicSrc, ctx2);
    vm.runInContext(bgSrc, ctx2);
    await send(c2, { type: 'ms-download', item: {
      url: 'https://cdn.example.com/clip.mp4', kind: 'video', ext: 'mp4', title: 'e2e_retry',
    } }, { tab: { id: 7 } });
    await flush();
    const dlRetry = c2.downloads.__downloads[0];
    ok('direct download attempted for non-youtube item', !!dlRetry);
    c2.__listeners.onChanged.forEach(function (fn) {
      fn({ id: dlRetry.id, state: { current: 'interrupted' }, error: { current: 'SERVER_BAD_CONTENT' } });
    });
    await flush(); await flush();
    ok('SERVER_BAD_CONTENT triggers fallback retry',
       c2.__swFetchLog.some(function (u) { return u.indexOf('clip.mp4') >= 0; }));
  }

  // A video response under an /hls/ path is still direct media when its MIME
  // says video/mp4; the path alone must not send it through playlist parsing.
  {
    const hlsPathVideoUrl = 'https://cdn.example.com/hls/clip.mp4?sig=direct';
    wr({
      statusCode: 200, url: hlsPathVideoUrl, tabId: 7,
      initiator: 'https://site.example.com/', type: 'media',
      responseHeaders: [
        { name: 'content-type', value: 'video/mp4' },
        { name: 'content-length', value: '5000000' },
      ],
    });
    await settle();
    r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
    const hlsPathVideo = r.items.find(function (i) { return i.url === hlsPathVideoUrl; });
    ok(!!hlsPathVideo, '/hls/*.mp4 with video MIME is detected as direct media');
    eq(hlsPathVideo && hlsPathVideo.kind, 'video', '/hls/*.mp4 remains video kind');
  }

  // Captured player credentials of any supported kind must bypass the bare
  // chrome.downloads request from the start, not wait for an interruption.
  {
    for (const headerName of ['Referer', 'Origin', 'Authorization']) {
      const authChrome = makeChrome();
      const authCtx = makeContext(authChrome);
      vm.runInContext(logicSrc, authCtx);
      vm.runInContext(bgSrc, authCtx);
      const authUrl = 'https://video.example.com/auth-header-' + headerName + '.mp4';
      const authOrigFetch = authCtx.fetch;
      authCtx.fetch = function (url, opts) {
        authChrome.__swFetchLog.push(url);
        authChrome.__swFetchOpts.push({ url: url, opts: opts || {} });
        if (url === authUrl) {
          return Promise.resolve({ ok: true, arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(5000)); } });
        }
        return authOrigFetch(url, opts);
      };
      authChrome.__listeners.onSendHeaders[0]({
        url: authUrl, initiator: 'https://site.example.com/',
        requestHeaders: [
          { name: headerName, value: 'captured-' + headerName },
          { name: 'x-media-sniper-source-origin', value: 'https://video.example.com' },
        ],
      });
      await send(authChrome, { type: 'ms-download', item: {
        url: authUrl, kind: 'video', contentType: 'video/mp4', size: 5000000,
      } }, { tab: { id: 7 } });
      await flush(); await flush(); await flush();
      eq(authChrome.downloads.__downloads.length, 1, headerName + ' auth download has one attempt');
      ok(authChrome.downloads.__downloads[0].opts.url.indexOf('blob:') === 0,
        headerName + ' auth download starts through offscreen blob');
      const authFetch = authChrome.__swFetchOpts.find(function (entry) { return entry.url === authUrl; });
      eq(authFetch && authFetch.opts.headers && authFetch.opts.headers[headerName],
        'captured-' + headerName, headerName + ' is replayed on first fetch');
    }
  }

  // Core regression: DASH MIME wins over an /hls/ path, and an extensionless
  // DASH item must keep its explicit kind when the save route is selected.
  {
    const extensionlessDashUrl = 'https://cdn.example.com/hls/extensionless-stream?sig=1';
    const extensionlessDashText =
      '<MPD mediaPresentationDuration="PT1.0S"><Period>' +
      '<AdaptationSet contentType="video"><Representation id="v" mimeType="video/mp4" bandwidth="1">' +
      '<SegmentTemplate timescale="1" duration="1" initialization="https://cdn.example.com/hls/extensionless/init.m4s" media="https://cdn.example.com/hls/extensionless/seg$Number$.m4s"/>' +
      '</Representation></AdaptationSet></Period></MPD>';
    ctxRef.fetch = function (url, opts) {
      if (url === extensionlessDashUrl) {
        return Promise.resolve({ ok: true, text: function () { return Promise.resolve(extensionlessDashText); } });
      }
      if (url.indexOf('/hls/extensionless/') >= 0) {
        return Promise.resolve({ ok: true, arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(8)); } });
      }
      return origFetch(url, opts);
    };
    const dashBuildCount = chrome.__dashBuilds.length;
    wr({
      statusCode: 200, url: extensionlessDashUrl, tabId: 7,
      initiator: 'https://site.example.com/', type: 'xmlhttprequest',
      responseHeaders: [{ name: 'content-type', value: 'application/dash+xml' }],
    });
    await settle();
    r = await send(chrome, { type: 'ms-get-items', tabId: 7 });
    const extensionlessDash = r.items.find(function (i) { return i.url === extensionlessDashUrl; });
    ok(!!extensionlessDash, 'DASH MIME is not shadowed by /hls/ path heuristic');
    eq(extensionlessDash && extensionlessDash.kind, 'dash', 'extensionless DASH item keeps dash kind');
    const extensionlessSave = await send(chrome, {
      type: 'ms-hls-download', url: extensionlessDashUrl, kind: 'dash',
      title: 'Extensionless DASH', dashEntry: 0, dashType: 'video',
    }, { tab: { id: 7 } });
    ok(extensionlessSave && extensionlessSave.started, 'extensionless DASH save uses DASH pipeline');
    await settle();
    ok(chrome.__dashBuilds.length > dashBuildCount, 'extensionless DASH save reached dash builder');
    ctxRef.fetch = origFetch;
  }

  // --- service-worker restart: active jobs remain visible -------------------
  {
    const shared = {
      msActiveJobs: [{ key: 'restored-job', job: {
        status: 'combining', tabId: 44, title: 'Restored conversion',
        sourceUrl: 'https://cdn.example.com/restored.m3u8', mode: 'ffmpeg',
        ext: 'mp4', outputKind: 'video', startedAt: Date.now(),
      } }],
    };
    const restartedChrome = makeChrome(shared);
    restartedChrome.__ffmpegDone = {
      jobId: 'restored-job', url: 'blob:chrome-extension://testextensionid/restored-output',
      size: 4321, ext: 'mp4', partial: false,
    };
    const restartedCtx = makeContext(restartedChrome);
    vm.runInContext(logicSrc, restartedCtx);
    vm.runInContext(bgSrc, restartedCtx);
    for (let i = 0; i < 12; i++) await flush();
    const restoredJobs = await send(restartedChrome, { type: 'ms-get-jobs', tabId: 999 });
    ok(restoredJobs.jobs.some(function (job) {
      return job.title === 'Restored conversion' && job.tabId === 44;
    }), 'active conversion remains visible after a service-worker restart');
    ok(restartedChrome.downloads.__downloads.some(function (download) {
      return download.opts.url === restartedChrome.__ffmpegDone.url && /Restored conversion/.test(download.opts.filename);
    }), 'service-worker restart hands a completed offscreen conversion to Downloads');
  }

  {
    const blob = 'blob:chrome-extension://testextensionid/in-progress';
    const sharedDownloads = [{
      id: 77, opts: { url: blob, filename: 'Restored handoff.mp4' }, done: false,
      receivedBytes: 1024, totalBytes: 4096,
    }];
    const shared = {
      msActiveJobs: [{ key: 'handoff-job', job: {
        status: 'downloading', tabId: 55, title: 'Restored handoff',
        sourceUrl: 'https://cdn.example.com/handoff.m3u8', mode: 'ffmpeg',
        ext: 'mp4', outputKind: 'video', queueEntryId: 'restored-q', startedAt: Date.now(),
      } }],
      msActiveQueue: [{
        id: 'restored-q', item: { url: blob, kind: 'video', title: 'Restored handoff', tabId: 55 },
        filename: 'Restored handoff.mp4', status: 'started', hlsUrl: 'handoff-job',
        downloadId: 77, startedAt: Date.now(),
      }],
    };
    const restartedChrome = makeChrome(shared, sharedDownloads);
    const restartedCtx = makeContext(restartedChrome);
    vm.runInContext(logicSrc, restartedCtx);
    vm.runInContext(bgSrc, restartedCtx);
    for (let i = 0; i < 8; i++) await flush();
    const restoredJobs = await send(restartedChrome, { type: 'ms-get-jobs', tabId: 999 });
    const restored = restoredJobs.jobs.find(function (job) { return job.title === 'Restored handoff'; });
    ok(!!restored, 'browser download handoff remains visible after a service-worker restart');
    eq(restored && restored.receivedBytes, 1024, 'restored browser handoff resumes byte progress');
    sharedDownloads[0].done = true;
    const completedAfterRestore = await send(restartedChrome, { type: 'ms-get-jobs' });
    const completedRestored = completedAfterRestore.jobs.find(function (job) { return job.title === 'Restored handoff'; });
    eq(completedRestored && completedRestored.status, 'complete', 'restored handoff observes completion even if onChanged was missed');
  }

  {
    const blob = 'blob:chrome-extension://testextensionid/already-complete';
    const sharedDownloads = [{ id: 78, opts: { url: blob }, done: true, receivedBytes: 4096, totalBytes: 4096 }];
    const shared = {
      msActiveJobs: [{ key: 'complete-race-job', job: {
        status: 'downloading', tabId: 55, title: 'Completed during restart', mode: 'ffmpeg',
        sourceUrl: 'https://cdn.example.com/complete.m3u8', queueEntryId: 'complete-race-q', startedAt: Date.now(),
      } }],
      msActiveQueue: [{ id: 'complete-race-q', item: { url: blob, kind: 'video', title: 'Completed during restart', tabId: 55 },
        filename: 'Completed during restart.mp4', status: 'started', hlsUrl: 'complete-race-job', downloadId: 78 }],
    };
    const restartedChrome = makeChrome(shared, sharedDownloads);
    const restartedCtx = makeContext(restartedChrome);
    vm.runInContext(logicSrc, restartedCtx); vm.runInContext(bgSrc, restartedCtx);
    for (let i = 0; i < 8; i++) await flush();
    const completedJobs = await send(restartedChrome, { type: 'ms-get-jobs' });
    const completed = completedJobs.jobs.find(function (job) { return job.title === 'Completed during restart'; });
    eq(completed && completed.status, 'complete', 'download completed during worker restart becomes terminal instead of remaining active');
  }

  {
    const shared = { msActiveJobs: [{ key: 'lost-preflight', job: {
      status: 'fetching', tabId: 66, title: 'Interrupted conversion',
      sourceUrl: 'https://cdn.example.com/lost.m3u8', startedAt: Date.now(),
    } }] };
    const restartedChrome = makeChrome(shared);
    const restartedCtx = makeContext(restartedChrome);
    vm.runInContext(logicSrc, restartedCtx);
    vm.runInContext(bgSrc, restartedCtx);
    for (let i = 0; i < 8; i++) await flush();
    const failedJobs = await send(restartedChrome, { type: 'ms-get-jobs', tabId: 999 });
    const failed = failedJobs.jobs.find(function (job) { return job.title === 'Interrupted conversion'; });
    ok(failed && failed.status === 'failed' && failed.error, 'unrecoverable restarted job stays visible with an error instead of disappearing');
  }

  {
    const parallelChrome = makeChrome();
    parallelChrome.__holdFfmpegVod = true;
    const parallelCtx = makeContext(parallelChrome);
    vm.runInContext(logicSrc, parallelCtx);
    vm.runInContext(bgSrc, parallelCtx);
    parallelChrome.__listeners.onMessage[0](
      { type: 'ms-hls-download', url: 'https://cdn.example.com/live/master.m3u8?tab=1', title: 'Tab one' },
      { tab: { id: 1 } }, function () {});
    parallelChrome.__listeners.onMessage[0](
      { type: 'ms-hls-download', url: 'https://cdn.example.com/live/master.m3u8?tab=2', title: 'Tab two' },
      { tab: { id: 2 } }, function () {});
    for (let i = 0; i < 16; i++) await flush();
    eq(parallelChrome.__ffmpegRuns.length, 1, 'media jobs from different tabs are globally serialized for the single offscreen engine');
    const parallelJobs = await send(parallelChrome, { type: 'ms-get-jobs' });
    const waiting = parallelJobs.jobs.find(function (job) { return job.title === 'Tab two'; });
    eq(waiting && waiting.status, 'queued', 'second cross-tab media job stays visibly queued instead of failing busy');
  }

  {
    const chainChrome = makeChrome();
    chainChrome.__holdFfmpegVod = true;
    const chainCtx = makeContext(chainChrome);
    vm.runInContext(logicSrc, chainCtx);
    vm.runInContext(bgSrc, chainCtx);
    vm.runInContext("startMediaChain(71, [" +
      "{url:'https://cdn.example.com/live/master.m3u8?chain=1',kind:'hls',title:'Chain one',tabId:71}," +
      "{url:'https://cdn.example.com/live/master.m3u8?chain=2',kind:'hls',title:'Chain two',tabId:71}" +
      "])", chainCtx);
    for (let i = 0; i < 16; i++) await flush();
    const savedChain = chainChrome.__storageData.msActiveJobs || [];
    eq(savedChain.length, 2, 'Save All persists every deferred media job before the first conversion finishes');
    chainChrome.__listeners.onRemoved.forEach(function (fn) { fn(71); });
    const afterClose = await send(chainChrome, { type: 'ms-get-jobs' });
    ok(afterClose.jobs.some(function (job) { return job.title === 'Chain two' && job.status === 'queued'; }),
      'closing the source tab does not discard deferred media work');
  }

  {
    const secureChrome = makeChrome();
    const secureCtx = makeContext(secureChrome);
    vm.runInContext(logicSrc, secureCtx);
    vm.runInContext(bgSrc, secureCtx);
    const signed = 'https://cdn.example.com/secure.m3u8?token=super-secret';
    vm.runInContext("state.hlsJobs.set(" + JSON.stringify(signed) + ", {" +
      "status:'failed',title:'Secure failure',tabId:1,error:'Authorization: Bearer secret-value at https://cdn.example.com/x?sig=hidden'" +
      "})", secureCtx);
    const exposed = await send(secureChrome, { type: 'ms-get-jobs' });
    const secureJob = exposed.jobs.find(function (job) { return job.title === 'Secure failure'; });
    const publicJson = JSON.stringify(secureJob);
    ok(publicJson.indexOf('super-secret') < 0 && publicJson.indexOf('secret-value') < 0 && publicJson.indexOf('sig=hidden') < 0,
      'global Jobs never exposes signed job keys or multi-part Authorization values');
  }

  {
    const resumedUrl = 'https://cdn.example.com/live/master.m3u8';
    const shared = { msActiveJobs: [{ key: resumedUrl, job: {
      status: 'queued', tabId: 61, title: 'Resumed queued job', mode: null,
      sourceUrl: resumedUrl, startedAt: Date.now(), itemKey: 'resume-key', ext: 'mp4',
    } }] };
    const restartedChrome = makeChrome(shared);
    const restartedCtx = makeContext(restartedChrome);
    vm.runInContext(logicSrc, restartedCtx);
    vm.runInContext(bgSrc, restartedCtx);
    for (let i = 0; i < 16; i++) await flush();
    const resumedJobs = await send(restartedChrome, { type: 'ms-get-jobs' });
    const resumed = resumedJobs.jobs.find(function (job) { return job.title === 'Resumed queued job'; });
    eq(resumed && resumed.status, 'downloading', 'queued media job resumes after a worker restart instead of failing');
    ok(restartedChrome.__ffmpegRuns.some(function (r) { return /media\.m3u8/.test(r.url); }),
      'resumed job re-runs its conversion');
  }

  {
    const hotlink = 'https://cdn.example.com/hotlink.mp4';
    const sharedDownloads = [{ id: 99, opts: { url: hotlink, filename: 'Auth clip.mp4' }, state: 'interrupted', error: 'SERVER_FORBIDDEN' }];
    const shared = { msActiveQueue: [{
      id: 'auth-q', item: { url: hotlink, kind: 'video', title: 'Auth clip', tabId: 62 },
      filename: 'Auth clip.mp4', status: 'started', downloadId: 99, startedAt: Date.now(),
    }] };
    const restartedChrome = makeChrome(shared, sharedDownloads);
    const restartedCtx = makeContext(restartedChrome);
    vm.runInContext(logicSrc, restartedCtx);
    vm.runInContext(bgSrc, restartedCtx);
    for (let i = 0; i < 16; i++) await flush();
    const restoredQueue = await send(restartedChrome, { type: 'ms-queue-status' });
    const authEntry = restoredQueue.queue.find(function (q) { return q.filename === 'Auth clip.mp4'; });
    ok(authEntry && authEntry.status !== 'failed', 'restored interrupted download retries instead of failing immediately');
    ok(restartedChrome.downloads.__downloads.some(function (d) {
      return String(d.opts.url).indexOf('blob:chrome-extension://') === 0 && /Auth clip/.test(d.opts.filename);
    }), 'authenticated retry hands the service-worker-fetched blob to Downloads');
  }

  {
    const dashUrl = 'https://cdn.example.com/v4/manifest.mpd';
    const dashMpd =
      '<MPD><Period><AdaptationSet contentType="video">' +
      '<Representation id="0" mimeType="video/mp4" codecs="avc1.42c00c" bandwidth="1000" width="320" height="240">' +
      '<SegmentTemplate timescale="15360" startNumber="1" initialization="vinit-$RepresentationID$.m4s" media="vchunk-$RepresentationID$-$Number%05d$.m4s">' +
      '<SegmentTimeline><S t="0" d="46080"/><S d="46080"/></SegmentTimeline>' +
      '</SegmentTemplate></Representation></AdaptationSet></Period></MPD>';
    const shared = { msActiveJobs: [{ key: dashUrl + '#dash-entry=0', job: {
      status: 'queued', tabId: 65, title: 'Resumed DASH', mode: null, sourceUrl: dashUrl,
      dashEntry: 0, dashType: 'video', startedAt: Date.now(), ext: 'mp4', outputKind: 'video',
    } }] };
    const restartedChrome = makeChrome(shared);
    const restartedCtx = makeContext(restartedChrome);
    vm.runInContext(logicSrc, restartedCtx);
    vm.runInContext(bgSrc, restartedCtx);
    restartedCtx.fetch = function (url) {
      if (String(url).indexOf('manifest.mpd') >= 0) {
        return Promise.resolve({ ok: true, text: function () { return Promise.resolve(dashMpd); } });
      }
      if (String(url).indexOf('.m4s') >= 0) {
        return Promise.resolve({ ok: true, arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(500)); } });
      }
      return Promise.resolve({ ok: false, text: function () { return Promise.resolve(''); } });
    };
    for (let i = 0; i < 16; i++) await flush();
    const dashJobs = await send(restartedChrome, { type: 'ms-get-jobs' });
    const resumedDash = dashJobs.jobs.find(function (job) { return job.title === 'Resumed DASH'; });
    eq(resumedDash && resumedDash.status, 'downloading', 'queued DASH job resumes through the offscreen builder after a restart');
    eq(restartedChrome.__dashBuilds.length, 1, 'resumed DASH job rebuilds its segments');
  }

  {
    const liveUrl = 'https://cdn.example.com/live/master.m3u8?recovered-live=1';
    const shared = { msActiveJobs: [{ key: liveUrl, job: {
      status: 'recording', tabId: 63, title: 'Recovered live', mode: 'ffmpeg', live: true,
      ext: 'mp4', outputKind: 'video', sourceUrl: liveUrl, startedAt: Date.now(),
    } }] };
    const restartedChrome = makeChrome(shared);
    restartedChrome.__ffmpegLiveJobId = liveUrl;
    restartedChrome.__ffmpegLiveResolve = function () {};
    const restartedCtx = makeContext(restartedChrome);
    vm.runInContext(logicSrc, restartedCtx);
    vm.runInContext(bgSrc, restartedCtx);
    for (let i = 0; i < 10; i++) await flush();
    const newSave = await send(restartedChrome, {
      type: 'ms-hls-download', url: 'https://cdn.example.com/live/master.m3u8?behind-live=1', title: 'Behind live'
    }, { tab: { id: 64 } });
    ok(newSave && newSave.started, 'save behind a recovered recording is accepted');
    for (let i = 0; i < 16; i++) await flush();
    eq(restartedChrome.__ffmpegRuns.filter(function (r) { return /behind-live/.test(r.url); }).length, 0,
      'conversion waits for the recovered recording to release the offscreen engine');
    const behindJobs = await send(restartedChrome, { type: 'ms-get-jobs' });
    const behind = behindJobs.jobs.find(function (job) { return job.title === 'Behind live'; });
    eq(behind && behind.status, 'queued', 'save behind a recovered recording stays queued instead of failing busy');
  }

  report('background');
}

run().catch(function (e) {
  console.error(e);
  process.exit(1);
});
