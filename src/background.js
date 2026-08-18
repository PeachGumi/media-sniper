/* Media Sniper - MV3 background service worker.
 * Owns: per-tab detected items, download queue.
 * Loaded after logic.js (importScripts); all pure helpers come from MediaSniperLogic.
 *
 * Filename routing note: chrome.downloads.download({filename}) is honored for
 * BOTH http(s) and blob: URLs (empirically verified on Brave 151). We do NOT
 * use chrome.downloads.onDeterminingFilename: on this Chromium build it never
 * fires for blob: downloads, and an active listener that yields with a bare
 * suggest() overrides the filename option of every other download in flight.
 */
'use strict';

try { importScripts('logic.js'); } catch (e) { /* tests pre-load logic */ }

const L = globalThis.MediaSniperLogic;

const MAX_ITEMS_PER_TAB = 300;
const QUEUE_CONCURRENCY = 3;

const state = {
  itemsByTab: new Map(),     // tabId -> array of items
  queue: [],                 // [{id, item, status}]
  active: new Set(),         // in-flight download ids
  downloadToItem: new Map(), // downloadId -> queue entry
  hlsJobs: new Map(),        // playlistUrl -> {status, tabId, progress, error}
  pageMeta: new Map(),       // tabId -> {title, url}
};

// ---------------------------------------------------------------------------
// storage helpers (chrome.storage.session survives SW restarts)
// ---------------------------------------------------------------------------
function persistItems() {
  const obj = {};
  state.itemsByTab.forEach(function (items, tabId) { obj[tabId] = items; });
  return chrome.storage.session.set({ msItems: obj });
}

function restoreItems() {
  return chrome.storage.session.get('msItems').then(function (r) {
    const obj = r.msItems || {};
    Object.keys(obj).forEach(function (tabId) {
      state.itemsByTab.set(Number(tabId), obj[tabId]);
    });
  });
}

// ---------------------------------------------------------------------------
// item intake
// ---------------------------------------------------------------------------
function normalizeItem(raw, tabId) {
  if (!raw || !raw.url) return null;
  const url = String(raw.url);
  if (url.indexOf('data:') === 0 || url.indexOf('chrome-extension:') === 0) return null;
  // never report individual HLS/DASH segments (clutters the list)
  if (L.isSegmentUrl(url)) return null;
  const kind = raw.kind || L.kindFromContentType(raw.contentType || null, url);
  if (!kind && url.indexOf('blob:') !== 0) return null;
  // mp2t (TS) content type is always a stream segment, never user-facing media
  if (raw.contentType && /mp2t/i.test(String(raw.contentType))) return null;
  // dedicated-site items only pass through from their own adapter
  if (raw.via !== 'youtube' && (L.isDedicatedSite(url) || L.isDedicatedSite(raw.pageUrl || ''))) return null;
  const c = L.classifyUrl(url);
  let ext = c.ext || raw.ext || L.extFromContentType(raw.contentType, url);
  if (ext === 'm3u8' || ext === 'mpd') ext = null; // combined output, not playlist text
  const item = {
    url: url,
    key: L.itemKey(url),
    kind: kind || 'video',
    ext: ext,
    contentType: raw.contentType || null,
    size: Number(raw.size) || 0,
    via: raw.via || null,
    pageUrl: raw.pageUrl || null,
    title: raw.title || null,
    duration: Number(raw.duration) || 0,
    tabId: tabId,
  };
  return item;
}

function addItems(tabId, rawItems) {
  let items = state.itemsByTab.get(tabId) || [];
  const incoming = (rawItems || []).map(function (r) { return normalizeItem(r, tabId); }).filter(Boolean).filter(function (it) {
    // VDH rule at the detection gate: direct media with a known size under
    // 500KB is noise (ads, thumbnails, tracking pixels). blob: items and
    // items with unknown size pass through.
    if (it.url.indexOf('blob:') === 0) return true;
    if (it.size > 0 && it.size < L.MIN_DIRECT_MEDIA_SIZE) return false;
    return true;
  });
  if (!incoming.length) return { added: 0, total: items.length };
  const before = items.length;
  items = L.mergeItems(incoming, items);
  // cap list: keep newest-first order, drop overflow from the tail
  if (items.length > MAX_ITEMS_PER_TAB) items = items.slice(items.length - MAX_ITEMS_PER_TAB);
  state.itemsByTab.set(tabId, items);
  persistItems();
  updateBadge(tabId);
  fillTitles(tabId);
  return { added: items.length - before, total: items.length };
}

// ---------------------------------------------------------------------------
// badge
// ---------------------------------------------------------------------------
function updateBadge(tabId) {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      const t = tabs && tabs[0];
      if (!t || t.id !== tabId) return;
      const n = (state.itemsByTab.get(tabId) || []).length;
      chrome.action.setBadgeText({ text: n ? String(n) : '' });
    });
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// download queue
//
// Filenames are passed via the download() option only. Verified empirically
// that the option is honored for http(s) and blob: alike, and that
// onDeterminingFilename is both unnecessary and harmful here.
// ---------------------------------------------------------------------------
function enqueue(item) {
  const filename = L.filenameForItem(item);
  const entry = { id: 'q' + Date.now() + '-' + Math.floor(Math.random() * 1e6), item: item, filename: filename, status: 'queued', error: null };
  state.queue.push(entry);
  pump();
  return entry;
}

function pump() {
  while (state.active.size < QUEUE_CONCURRENCY && state.queue.length) {
    const entry = state.queue.find(function (q) { return q.status === 'queued'; });
    if (!entry) break;
    entry.status = 'started';
    state.active.add(entry.id);
    startOne(entry);
  }
}

function startOne(entry) {
  const url = entry.item.url;
  const opts = { url: url };
  // ユーザー指定: フォルダ管理なし、~/Downloads 直下にフラット保存。
  // conflictAction は uniquify: 同名ファイルは上書きせず番号付きで残す。
  opts.filename = entry.filename;
  opts.conflictAction = 'uniquify';
  opts.saveAs = false;
  const onDone = function (downloadId) {
    if (chrome.runtime.lastError) {
      entry.status = 'failed';
      entry.error = chrome.runtime.lastError.message || 'download failed';
      state.active.delete(entry.id);
      pump();
      return;
    }
    entry.downloadId = downloadId;
    state.downloadToItem.set(downloadId, entry);
  };
  const res = chrome.downloads.download(opts, onDone);
  if (res && typeof res.then === 'function') {
    res.then(function (downloadId) {
      entry.downloadId = downloadId;
      state.downloadToItem.set(downloadId, entry);
    }).catch(function (err) {
      entry.status = 'failed';
      entry.error = err && err.message || 'download failed';
      state.active.delete(entry.id);
      pump();
    });
  }
}

chrome.downloads.onChanged.addListener(function (delta) {
  const entry = state.downloadToItem.get(delta.id);
  if (!entry) return; // not ours
  const s = delta.state && delta.state.current;
  if (s === 'complete') {
    entry.status = 'complete';
    state.downloadToItem.delete(delta.id);
    state.active.delete(entry.id);
    pump();
  } else if (s === 'interrupted') {
    entry.status = 'failed';
    entry.error = (delta.error && delta.error.current) || 'interrupted';
    state.downloadToItem.delete(delta.id);
    state.active.delete(entry.id);
    pump();
  }
});

// ---------------------------------------------------------------------------
// HLS orchestration: entirely in the service worker.
// SW has <all_urls> host_permissions, so it can fetch segments with cookies
// (credentials: 'include'), concatenate them, and hand a blob to downloads.
// This avoids the page-world blob URL cross-context problem.
// ---------------------------------------------------------------------------
const HLS_CONCURRENCY = 6;

async function ensureOffscreen() {
  if (!chrome.offscreen) return;
  try {
    if (typeof chrome.offscreen.hasDocument === 'function') {
      const has = await chrome.offscreen.hasDocument();
      if (has) return;
    }
    await chrome.offscreen.createDocument({
      url: 'src/offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Create blob URL for combined media segments',
    });
  } catch (e) {
    // "Only a single offscreen" error is fine
  }
}

async function makeBlobUrl(parts, mime) {
  await ensureOffscreen();
  const resp = await chrome.runtime.sendMessage({
    type: 'ms-offscreen-blob',
    parts: parts,
    mime: mime || 'application/octet-stream',
  });
  if (!resp || !resp.url) throw new Error('offscreen blob creation failed' + (resp && resp.error ? ': ' + resp.error : ''));
  return { url: resp.url, size: resp.size || 0 };
}

function swFetchText(url) {
  return fetch(url, { credentials: 'include' }).then(function (res) {
    if (!res.ok) throw new Error('http ' + res.status);
    return res.text();
  });
}

function swFetchSegment(url) {
  return fetch(url, { credentials: 'include' }).then(function (res) {
    if (!res.ok) throw new Error('segment http ' + res.status);
    return res.arrayBuffer();
  });
}

function withToken(url, token) {
  if (!token) return url;
  try {
    const u = new URL(url);
    if (!u.search) return url + '?' + token;
  } catch (e) { /* ignore */ }
  return url;
}

async function runHlsJob(playlistUrl) {
  const job = state.hlsJobs.get(playlistUrl);
  if (!job) throw new Error('no job');

  job.status = 'fetching';
  const masterText = await swFetchText(playlistUrl);
  const masterParsed = L.parseM3u8(masterText, playlistUrl);

  let mediaUrl = playlistUrl;
  let mediaText = masterText;
  let variant = null;

  if (masterParsed.type === 'master') {
    variant = L.pickBestVariant(masterParsed.variants);
    if (!variant) throw new Error('no variants in master playlist');
    mediaUrl = withToken(variant.url, variant.token);
    job.status = 'fetching';
    mediaText = await swFetchText(mediaUrl);
  }

  const media = L.parseM3u8(mediaText, mediaUrl);
  if (media.type !== 'media') throw new Error('not a media playlist');
  if (media.encrypted) throw new Error('AES-128 encrypted HLS not supported - use yt-dlp');
  if (!media.segments.length) throw new Error('playlist has no segments');

  job.status = 'combining';
  job.total = media.segments.length + (media.initUrl ? 1 : 0);

  const queue = [];
  if (media.initUrl) queue.push({ i: -1, url: media.initUrl });
  media.segments.forEach(function (seg, idx) { queue.push({ i: idx, url: seg.url }); });

  const results = [];
  let totalBytes = 0;
  let done = 0;
  let failed = null;

  async function worker() {
    while (queue.length && !failed) {
      const entry = queue.shift();
      try {
        const buf = await swFetchSegment(entry.url);
        totalBytes += buf.byteLength;
        results.push({ i: entry.i, buf: buf });
        done++;
        job.done = done;
      } catch (err) {
        failed = err;
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(HLS_CONCURRENCY, queue.length + 1); w++) workers.push(worker());
  await Promise.all(workers);
  if (failed) throw failed;

  results.sort(function (a, b) { return a.i - b.i; });

  // URL.createObjectURL is unavailable in service workers; the offscreen
  // document builds the blob URL (same pattern VDH uses).
  const made = await makeBlobUrl(results.map(function (r) { return r.buf; }), 'video/mp2t');
  const blobUrl = made.url;

  job.status = 'downloading';
  job.blobUrl = blobUrl;
  job.size = totalBytes;

  const ext = media.initUrl ? 'mp4' : 'ts';
  const item = normalizeItem({
    url: blobUrl,
    kind: 'video',
    ext: ext,
    title: job.title || null,
    pageUrl: job.pageUrl || null,
    size: totalBytes,
  }, job.tabId);
  enqueue(item);

  return { queued: true };
}

function startHls(tabId, playlistUrl, title, pageUrl) {
  const existing = state.hlsJobs.get(playlistUrl);
  if (existing && (existing.status === 'fetching' || existing.status === 'combining')) {
    return Promise.resolve({ alreadyRunning: true });
  }
  state.hlsJobs.set(playlistUrl, {
    status: 'fetching', tabId: tabId, done: 0, total: 0, error: null, live: false,
    title: title || null, pageUrl: pageUrl || null, blobUrl: null, size: 0,
  });
  return runHlsJob(playlistUrl).catch(function (err) {
    const j = state.hlsJobs.get(playlistUrl);
    if (j) { j.status = 'failed'; j.error = String(err && err.message || err); }
    return { error: j && j.error };
  });
}

// ---------------------------------------------------------------------------
// webRequest detection (VDH-style): watch response headers directly.
// Works even on pages where content-script injection is blocked.
// ---------------------------------------------------------------------------
const WATCH_TYPES = ['xmlhttprequest', 'media', 'main_frame', 'other'];

function onResponseStarted(details) {
  try {
    if (details.statusCode < 200 || details.statusCode > 299) return;
    const url = details.url;
    if (!url || url.indexOf('data:') === 0) return;
    if (url.indexOf('chrome-extension:') === 0) return;
    if (details.initiator && details.initiator.indexOf('chrome-extension:') === 0) return;
    if (details.tabId == null || details.tabId < 0) return;
    // segments are never user-facing media
    if (L.isSegmentUrl(url)) return;
    // dedicated-site adapters handle their own sites; the generic detector
    // only produces noise there (VDH's yS exclusion set, same idea)
    if (L.isDedicatedSite(url) || L.isDedicatedSite(details.initiator || '')) return;

    let ct = null;
    let size = 0;
    if (details.responseHeaders) {
      for (const h of details.responseHeaders) {
        const name = String(h.name || '').toLowerCase();
        if (name === 'content-type') ct = h.value;
        if (name === 'content-length') size = parseInt(h.value, 10) || 0;
      }
    }
    // an html response is never media (anti-hotlink redirects serve html)
    if (ct && String(ct).toLowerCase().indexOf('text/html') === 0) return;

    const isHls = (ct && /mpegurl/i.test(ct)) || L.looksLikeHlsUrl(url);
    const kind = L.kindFromContentType(ct, url);

    if (isHls) {
      // validate playlist text (SW fetch carries cookies thanks to host perms)
      fetch(url, { credentials: 'include' }).then(function (res) {
        if (!res.ok) return null;
        return res.text();
      }).then(function (text) {
        if (!text || text.indexOf('#EXTM3U') !== 0) return;
        if (L.isSubtitlePlaylist(text)) return;
        const parsed = L.parseM3u8(text, url);
        const meta = {
          url: url, kind: 'hls', contentType: ct || null, size: 0,
          via: 'webrequest', pageUrl: details.initiator || details.url, title: pageTitle(details.tabId),
          duration: parsed.type === 'media' ? L.playlistDuration(text) : 0,
        };
        if (parsed.type === 'master' && parsed.variants.length) meta.note = parsed.variants.length + ' variants';
        addItems(details.tabId, [meta]);
      }).catch(function () { /* unreachable playlist: skip silently */ });
      return;
    }

    if (kind === 'video' || kind === 'audio') {
      // VDH rule: direct media below 500KB is noise (ads, thumbs, pixels)
      if (size > 0 && size < L.MIN_DIRECT_MEDIA_SIZE) return;
      addItems(details.tabId, [{
        url: url, kind: kind, contentType: ct, size: size,
        via: 'webrequest', pageUrl: details.initiator || details.url, title: pageTitle(details.tabId),
      }]);
    }
  } catch (e) { /* never break browsing */ }
}

function pageTitle(tabId) {
  const meta = state.pageMeta.get(tabId);
  return meta ? meta.title : null;
}

// fill missing titles lazily: media requests often arrive before page-meta
function fillTitles(tabId) {
  let need = false;
  const items = state.itemsByTab.get(tabId) || [];
  for (const it of items) { if (!it.title) { need = true; break; } }
  if (!need) return;
  try {
    chrome.tabs.get(tabId, function (tab) {
      if (chrome.runtime.lastError || !tab || !tab.title) return;
      const list = state.itemsByTab.get(tabId) || [];
      let changed = false;
      for (const it of list) {
        if (!it.title) { it.title = tab.title; changed = true; }
      }
      if (changed) persistItems();
    });
  } catch (e) { /* ignore */ }
}

if (chrome.webRequest && chrome.webRequest.onResponseStarted) {
  chrome.webRequest.onResponseStarted.addListener(onResponseStarted, { urls: ['<all_urls>'], types: WATCH_TYPES }, ['responseHeaders']);
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== 'string') return false;
  const tabId = msg.tabId != null ? msg.tabId : (sender.tab && sender.tab.id);

  switch (msg.type) {
    case 'ms-page-meta': {
      state.pageMeta.set(tabId, { title: msg.title || null, url: msg.url || null });
      sendResponse({ ok: true });
      return false;
    }
    case 'ms-report': {
      const r = addItems(tabId, msg.items);
      sendResponse(r);
      return false;
    }
    case 'ms-get-items': {
      const items = state.itemsByTab.get(tabId) || [];
      sendResponse({ items: L.sortItems(items) });
      return false;
    }
    case 'ms-clear': {
      state.itemsByTab.delete(tabId);
      persistItems();
      updateBadge(tabId);
      sendResponse({ ok: true });
      return false;
    }
    case 'ms-download': {
      const item = normalizeItem(msg.item, tabId);
      if (!item) { sendResponse({ error: 'invalid item' }); return false; }
      const entry = enqueue(item);
      sendResponse({ queued: true, id: entry.id });
      return false;
    }
    case 'ms-download-blob': {
      const item = normalizeItem({
        url: msg.url, kind: msg.kind || 'video', ext: msg.ext || null,
        title: msg.title || null, pageUrl: msg.pageUrl || null, size: msg.size || 0,
      }, tabId);
      if (!item) { sendResponse({ error: 'invalid item' }); return false; }
      const entry = enqueue(item);
      sendResponse({ queued: true, id: entry.id });
      return false;
    }
    case 'ms-hls-download': {
      startHls(tabId, msg.url, msg.title, msg.pageUrl).then(sendResponse);
      return true;
    }
    case 'ms-hls-status': {
      const job = state.hlsJobs.get(msg.url);
      sendResponse(job ? { status: job.status, done: job.done, total: job.total, error: job.error, live: job.live } : null);
      return false;
    }
    case 'ms-queue-status': {
      sendResponse({ queue: state.queue.map(function (q) { return { id: q.id, status: q.status, filename: q.filename, error: q.error }; }) });
      return false;
    }
    default:
      return false;
  }
});

// ---------------------------------------------------------------------------
// tab lifecycle
// ---------------------------------------------------------------------------
chrome.tabs.onRemoved.addListener(function (tabId) {
  state.itemsByTab.delete(tabId);
  persistItems();
});

chrome.tabs.onActivated.addListener(function (info) {
  updateBadge(info.tabId);
});

restoreItems();
