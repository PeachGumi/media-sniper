'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { eq, ok, report } = require('./harness.js');
const L = require('../src/logic.js');

const logicSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'logic.js'), 'utf8');
const bgSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');
const popupSrc = fs.readFileSync(path.join(__dirname, '..', 'popup', 'popup.js'), 'utf8');

function flush() { return new Promise(function (resolve) { setImmediate(resolve); }); }
async function settle() { for (let i = 0; i < 8; i++) await flush(); }

function makeBackgroundChrome(session) {
  const listeners = { onChanged: [], onMessage: [], onRemoved: [], onActivated: [], onWebResponseStarted: [], onSendHeaders: [] };
  const downloads = [];
  const ffmpegRuns = [];
  let downloadId = 1;
  const store = session || {};
  const chrome = {
    storage: {
      session: {
        get: function (key) {
          const out = {};
          (Array.isArray(key) ? key : [key]).forEach(function (k) { if (k in store) out[k] = store[k]; });
          return Promise.resolve(out);
        },
        set: function (obj) { Object.assign(store, obj); return Promise.resolve(); },
      },
      local: {
        get: function () { return Promise.resolve({}); },
        set: function () { return Promise.resolve(); },
      },
    },
    downloads: {
      onChanged: { addListener: function (fn) { listeners.onChanged.push(fn); } },
      download: function (opts, cb) {
        const id = downloadId++;
        downloads.push({ id: id, opts: opts, done: false });
        if (cb) cb(id);
        return Promise.resolve(id);
      },
      search: function (query, cb) { if (cb) cb([]); return Promise.resolve([]); },
      __downloads: downloads,
    },
    runtime: {
      id: 'extid',
      lastError: null,
      onMessage: { addListener: function (fn) { listeners.onMessage.push(fn); } },
      sendMessage: function (msg) {
        if (msg && (msg.type === 'ms-offscreen-keepalive-acquire' || msg.type === 'ms-offscreen-keepalive-release')) return Promise.resolve({ ok: true });
        if (msg && msg.type === 'ms-offscreen-ffmpeg-status') return Promise.resolve({ running: false, done: null });
        if (msg && msg.type === 'ms-offscreen-ffmpeg-run') {
          ffmpegRuns.push(msg);
          return Promise.resolve({ url: 'blob:chrome-extension://extid/hls-output', size: 1234 });
        }
        return Promise.resolve(undefined);
      },
    },
    offscreen: { hasDocument: function () { return Promise.resolve(true); }, createDocument: function () { return Promise.resolve(); } },
    tabs: {
      onRemoved: { addListener: function (fn) { listeners.onRemoved.push(fn); } },
      onActivated: { addListener: function (fn) { listeners.onActivated.push(fn); } },
      query: function (query, cb) { cb([{ id: 1, title: 'Grouped page', url: 'https://site.example/watch' }]); },
      get: function (id, cb) { cb({ id: id, title: 'Grouped page', url: 'https://site.example/watch' }); },
      sendMessage: function () { return Promise.resolve({ ok: true }); },
    },
    action: { setBadgeText: function () {} },
    webRequest: {
      onResponseStarted: { addListener: function (fn) { listeners.onWebResponseStarted.push(fn); } },
      onSendHeaders: { addListener: function (fn) { listeners.onSendHeaders.push(fn); } },
    },
    __listeners: listeners,
    __ffmpegRuns: ffmpegRuns,
    __store: store,
  };
  return chrome;
}

function makeBackgroundContext(chrome) {
  const ctx = {
    chrome, console, URL, Promise, Date, Math, Blob, ArrayBuffer, Uint8Array,
    fetch: function (url) {
      if (url.indexOf('master.m3u8') >= 0) {
        return Promise.resolve({ ok: true, text: function () {
          return Promise.resolve([
            '#EXTM3U',
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Main",DEFAULT=YES,URI="audio/main.m3u8"',
            '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,AUDIO="aud"',
            'video/720.m3u8',
            '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,AUDIO="aud"',
            'video/1080.m3u8',
          ].join('\n'));
        } });
      }
      if (url.indexOf('video/720.m3u8') >= 0 || url.indexOf('video/1080.m3u8') >= 0 || url.indexOf('audio/main.m3u8') >= 0) {
        return Promise.resolve({ ok: true, text: function () {
          return Promise.resolve('#EXTM3U\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n');
        } });
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

function send(chrome, message, sender) {
  const fn = chrome.__listeners.onMessage[0];
  let response;
  let done = false;
  fn(message, sender || {}, function (value) { response = value; done = true; });
  return (async function () {
    const deadline = Date.now() + 3000;
    while (!done && Date.now() < deadline) await flush();
    return response;
  })();
}

async function runBackgroundContract() {
  const session = {};
  const chrome = makeBackgroundChrome(session);
  const ctx = makeBackgroundContext(chrome);
  vm.runInContext(logicSrc, ctx);
  vm.runInContext(bgSrc, ctx);

  const response = chrome.__listeners.onWebResponseStarted[0];
  // The browser can see a variant before the master response. It is a real
  // candidate until the later master identifies it as a grouped child.
  response({
    statusCode: 200,
    url: 'https://cdn.example.test/hls/video/720.m3u8?auth=child',
    tabId: 1,
    initiator: 'https://site.example/watch',
    type: 'media',
    responseHeaders: [{ name: 'content-type', value: 'application/vnd.apple.mpegurl' }],
  });
  await settle();
  let beforeMaster = await send(chrome, { type: 'ms-get-items', tabId: 1 });
  ok(beforeMaster.items.some(function (entry) { return entry.url.indexOf('/video/720.m3u8') >= 0; }), 'variant can be observed before its master');

  response({
    statusCode: 200,
    url: 'https://cdn.example.test/hls/master.m3u8?auth=parent',
    tabId: 1,
    initiator: 'https://site.example/watch',
    type: 'xmlhttprequest',
    responseHeaders: [{ name: 'content-type', value: 'application/vnd.apple.mpegurl' }],
  });
  await settle();

  let result = await send(chrome, { type: 'ms-get-items', tabId: 1 });
  const item = result.items.find(function (entry) { return entry.url.indexOf('/master.m3u8') >= 0; });
  ok(!!item, 'background exposes one logical master item');
  eq(result.items.filter(function (entry) { return entry.url.indexOf('/master.m3u8') >= 0; }).length, 1, 'master does not create duplicate quality cards');
  eq(result.items.filter(function (entry) { return entry.url.indexOf('/video/720.m3u8') >= 0; }).length, 0, 'grouped child is removed regardless of detection order');
  eq(item && item.variants.length, 2, 'background item retains all HLS variants');
  const highest = item && item.variants.find(function (variant) { return variant.resolution === '1920x1080'; });
  eq(item && item.selectedVariantKey, L.hlsVariantKey(highest), 'background defaults to highest quality');
  ok(item && item.variants.every(function (variant) { return !!variant.audioUrl; }), 'background retains variant audio URLs');

  const popupSender = { id: 'extid', url: 'chrome-extension://extid/popup/popup.html' };
  const lower = item.variants.find(function (variant) { return variant.resolution === '1280x720'; });
  const selectResponse = await send(chrome, {
    type: 'ms-select-quality',
    tabId: 1,
    itemKey: item.key,
    variantKey: L.hlsVariantKey(lower),
  }, popupSender);
  eq(selectResponse && selectResponse.ok, true, 'popup quality selection accepted');
  eq(session.msItems[1][0].variants.length, 2, 'session persistence retains nested variants');
  eq(session.msItems[1][0].selectedVariantKey, L.hlsVariantKey(lower), 'session persistence retains selected quality');

  const all = await send(chrome, { type: 'ms-download-all', tabId: 1 }, popupSender);
  eq(all.deferred, 1, 'Save All defers one logical HLS item');
  eq(all.queued, 0, 'Save All does not queue duplicate variant downloads');
  await settle();
  eq(chrome.__ffmpegRuns.length, 1, 'Save All starts one HLS job');
  eq(chrome.__ffmpegRuns[0].url, lower.url, 'Save All uses the selected variant playlist');
  // The selected variant's audio rendition reaches the mux as a locally built
  // track (audioFileUrl); two network inputs cannot be open at once in this
  // libav build, so audioUrl stays null for a two-source VOD job.
  const run = chrome.__ffmpegRuns[0];
  ok(run.audioFileUrl || run.audioUrl, 'Save All carries the selected variant audio track');
  if (!run.audioFileUrl) eq(run.audioUrl, lower.audioUrl, 'Save All uses the selected variant audio URL');

  // A fresh worker restores the same logical item and selected quality.
  const chrome2 = makeBackgroundChrome(session);
  const ctx2 = makeBackgroundContext(chrome2);
  vm.runInContext(logicSrc, ctx2);
  vm.runInContext(bgSrc, ctx2);
  const restored = await send(chrome2, { type: 'ms-get-items', tabId: 1 }, popupSender);
  eq(restored.items[0].variants.length, 2, 'restored session item keeps variants');
  eq(restored.items[0].selectedVariantKey, L.hlsVariantKey(lower), 'restored session item keeps selection');
}

function makeElement(tag, id) {
  const listeners = {};
  const element = {
    tagName: String(tag).toUpperCase(), id: id || '', children: [], dataset: {}, value: '', textContent: '', title: '', className: '',
    classList: { add: function (name) { element.className += (element.className ? ' ' : '') + name; }, remove: function () {} },
    appendChild: function (child) { element.children.push(child); return child; },
    addEventListener: function (type, fn) { listeners[type] = fn; },
    dispatch: function (type) { if (listeners[type]) listeners[type]({ target: element, preventDefault: function () {} }); },
    setAttribute: function (name, value) { element[name] = String(value); },
    getAttribute: function (name) { return element[name]; },
    __listeners: listeners,
  };
  return element;
}

async function runPopupContract() {
  const item = {
    key: 'https://cdn.example.test/hls/master.m3u8?auth=parent',
    url: 'https://cdn.example.test/hls/master.m3u8?auth=parent',
    kind: 'hls',
    title: 'Grouped video',
    selectedVariantKey: 'https://cdn.example.test/hls/video/1080.m3u8?auth=parent',
    variants: [
      { url: 'https://cdn.example.test/hls/video/720.m3u8?auth=parent', bandwidth: 2500000, resolution: '1280x720', audioUrl: 'https://cdn.example.test/hls/audio/main.m3u8?auth=parent' },
      { url: 'https://cdn.example.test/hls/video/1080.m3u8?auth=parent', bandwidth: 6000000, resolution: '1920x1080', audioUrl: 'https://cdn.example.test/hls/audio/main.m3u8?auth=parent' },
    ],
  };
  const ids = ['status', 'count', 'list', 'mediaTab', 'jobsTab', 'mediaPanel', 'jobsPanel', 'jobsList', 'jobsCount', 'rescan', 'saveall', 'clear', 'ytdlp', 'options', 'destHint', 'accessSite', 'accessAll', 'accessClick', 'accessStatus'];
  const elements = {};
  ids.forEach(function (id) { elements[id] = makeElement('div', id); });
  const messages = [];
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage: function (message, callback) {
        messages.push(message);
        if (message.type === 'ms-get-settings') callback({ rootFolder: '', minSizeKb: 500, blacklist: '' });
        else if (message.type === 'ms-get-items') callback({ items: [item] });
        else if (message.type === 'ms-get-jobs') callback({ jobs: [] });
        else callback({ ok: true, queued: 0, deferred: 1 });
      },
      openOptionsPage: function () {},
    },
    tabs: {
      query: function (query, callback) { callback([{ id: 1, url: 'https://site.example/watch' }]); },
      sendMessage: function (id, msg, callback) { if (callback) callback({ ok: true }); },
    },
  };
  const document = {
    readyState: 'complete',
    querySelector: function (selector) { return selector[0] === '#' ? elements[selector.slice(1)] : null; },
    createElement: function (tag) { return makeElement(tag); },
    addEventListener: function () {},
  };
  const ctx = {
    chrome, document, console, URL, Promise, Date, Math, setTimeout: function () {},
    navigator: { clipboard: { writeText: function () { return Promise.resolve(); } } },
    MediaSniperI18n: { t: function (key) { return key; } },
    MediaSniperLogic: L,
    globalThis: null,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(popupSrc, ctx);
  await settle();

  eq(elements.list.children.length, 1, 'popup renders one row for a grouped master');
  const row = elements.list.children[0];
  const quality = row.children[1].children.find(function (child) { return child.tagName === 'SELECT'; });
  ok(!!quality, 'popup renders a compact quality selector');
  eq(quality && quality.value, item.selectedVariantKey, 'quality selector defaults to saved selection');
  eq(quality && quality.children.length, 2, 'quality selector contains every variant');

  quality.value = item.variants[0].url;
  quality.dispatch('change');
  const selectionMessage = messages.find(function (message) { return message.type === 'ms-select-quality'; });
  ok(!!selectionMessage, 'popup sends quality selection to the background');
  eq(selectionMessage && selectionMessage.variantKey, L.hlsVariantKey(item.variants[0]), 'popup sends the stable selected variant key');

  elements.saveall.dispatch('click');
  const allMessage = messages.filter(function (message) { return message.type === 'ms-download-all'; }).pop();
  eq(allMessage && allMessage.selections[item.key], L.hlsVariantKey(item.variants[0]), 'Save All sends the selected quality, not every variant');

  // Popup rendering is also a trust boundary for restored/session data: a
  // poisoned item must not create an unbounded number of option nodes.
  vm.runInContext("items[0].variants = Array.from({length: MediaSniperLogic.MAX_HLS_VARIANTS + 10}, (_, i) => ({url: 'https://cdn.example.test/v' + i + '.m3u8', bandwidth: i + 1})); render();", ctx);
  const boundedRow = elements.list.children[0];
  const boundedQuality = boundedRow.children[1].children.find(function (child) { return child.tagName === 'SELECT'; });
  ok(!!boundedQuality, 'popup keeps a quality selector for bounded variants');
  ok(boundedQuality && boundedQuality.children.length <= L.MAX_HLS_VARIANTS, 'popup caps quality options');
}

(async function () {
  await runBackgroundContract();
  await runPopupContract();
  report('hls-ui-contract');
})().catch(function (error) {
  console.error(error);
  process.exit(1);
});
