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
let jobPublicSequence = 0;

const state = {
  itemsByTab: new Map(),     // tabId -> array of items
  queue: [],                 // [{id, item, status}]
  active: new Set(),         // in-flight download ids
  downloadToItem: new Map(), // downloadId -> queue entry
  hlsJobs: new Map(),        // playlistUrl -> {status, tabId, progress, error}
  pageMeta: new Map(),       // tabId -> {title, url}
};

function persistActiveJobs() {
  const saved = [];
  state.hlsJobs.forEach(function (job, key) {
    if (!isMediaJobRunning(job)) return;
    saved.push({ key: key, job: {
      status: job.status, tabId: job.tabId, done: job.done || 0, total: job.total || 0,
      title: job.title || null, pageUrl: job.pageUrl || null, live: !!job.live,
      seconds: job.seconds || 0, bytes: job.bytes || 0, startedAt: job.startedAt || Date.now(),
      mode: job.mode || null, ext: job.ext || null, sourceUrl: job.sourceUrl || null,
      itemKey: job.itemKey || null, outputKind: job.outputKind || null,
      publicId: ensurePublicJobId(job),
      audioUrl: job.audioUrl || null, dashEntry: job.dashEntry != null ? job.dashEntry : null,
      dashType: job.dashType || null, variantUrl: job.variantUrl || null, variantKey: job.variantKey || null,
      queueEntryId: job.queueEntryId || null, filename: job.filename || null,
    } });
  });
  const queue = state.queue.filter(function (entry) {
    return entry && entry.status !== 'complete' && entry.status !== 'failed';
  }).slice(0, MAX_ITEMS_PER_TAB).map(function (entry) {
    return {
      id: entry.id, item: entry.item, filename: entry.filename, status: entry.status,
      error: entry.error || null, hlsUrl: entry.hlsUrl || null,
      startedAt: entry.startedAt || 0, downloadId: entry.downloadId,
      receivedBytes: entry.receivedBytes || 0, totalBytes: entry.totalBytes || 0,
      triedFallback: !!entry.triedFallback,
    };
  });
  return chrome.storage.session.set({ msActiveJobs: saved, msActiveQueue: queue }).catch(function () {});
}

// ---------------------------------------------------------------------------
// storage helpers (chrome.storage.session survives SW restarts)
// ---------------------------------------------------------------------------
function persistItems() {
  // never write a partial map over storage before restore has merged it
  return restorePromise.then(function () {
    const obj = {};
    state.itemsByTab.forEach(function (items, tabId) { obj[tabId] = items; });
    return chrome.storage.session.set({ msItems: obj });
  });
}

function restoreItems() {
  return chrome.storage.session.get(['msItems', 'msActiveJobs', 'msActiveQueue']).then(function (r) {
    const obj = r.msItems || {};
    Object.keys(obj).forEach(function (tabId) {
      const t = Number(tabId);
      // merge, never clobber: items detected during boot win
      if (!state.itemsByTab.has(t)) state.itemsByTab.set(t, obj[tabId]);
    });
    for (const saved of (Array.isArray(r.msActiveJobs) ? r.msActiveJobs : [])) {
      if (!saved || typeof saved.key !== 'string' || !saved.job || !isMediaJobRunning(saved.job)) continue;
      saved.job._restored = true;
      if (!state.hlsJobs.has(saved.key)) state.hlsJobs.set(saved.key, saved.job);
    }
    for (const saved of (Array.isArray(r.msActiveQueue) ? r.msActiveQueue : [])) {
      if (!saved || typeof saved.id !== 'string' || !saved.item ||
          saved.status === 'complete' || saved.status === 'failed') continue;
      const item = normalizeItem(saved.item, saved.item.tabId);
      if (!item) continue;
      state.queue.push({
        id: saved.id, item: item, filename: String(saved.filename || L.filenameForItem(item, settings.rootFolder)),
        status: saved.status || 'queued', error: saved.error || null, hlsUrl: saved.hlsUrl || null,
        startedAt: saved.startedAt || Date.now(), downloadId: saved.downloadId,
        receivedBytes: saved.receivedBytes || 0, totalBytes: saved.totalBytes || 0,
        triedFallback: !!saved.triedFallback, _restored: true,
      });
    }
  });
}

// Restore runs at SW boot; message handlers that read restored state must
// await this (otherwise a freshly-woken SW answers the popup with an empty
// list — the "scan feels broken/slow" race).
const restorePromise = restoreItems();

// ---------------------------------------------------------------------------
// settings (storage.local; the options page reads/writes the same keys)
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = { rootFolder: '', minSizeKb: 500, blacklist: '' };
const settings = Object.assign({}, DEFAULT_SETTINGS);
const settingsReady = chrome.storage.local.get(['rootFolder', 'minSizeKb', 'blacklist']).then(function (r) {
  settings.rootFolder = L.sanitizeRootFolder(r.rootFolder);
  const n = parseInt(r.minSizeKb, 10);
  settings.minSizeKb = (n > 0) ? n : DEFAULT_SETTINGS.minSizeKb;
  settings.blacklist = String(r.blacklist || '');
}).catch(function () { /* fresh profile: defaults */ });

function effectiveMinSize() {
  return (settings.minSizeKb > 0 ? settings.minSizeKb : DEFAULT_SETTINGS.minSizeKb) * 1024;
}

// ---------------------------------------------------------------------------
// item intake
// ---------------------------------------------------------------------------
function normalizeItem(raw, tabId) {
  if (!raw || !raw.url) return null;
  const url = String(raw.url);
  if (url.length > 4096) return null;
  // Extension-owned blobs are the output of our offscreen document. All other
  // URLs, including page blobs and non-network schemes, must pass the shared
  // safe URL policy before they reach a download queue.
  if (url.indexOf('blob:chrome-extension://') !== 0 &&
      typeof L.isSafeMediaUrl === 'function' && !L.isSafeMediaUrl(url)) return null;
  if (url.indexOf('data:') === 0 || url.indexOf('chrome-extension:') === 0) return null;
  if (raw.via === 'youtube' && typeof L.isYouTubeMediaUrl === 'function' &&
      (!L.isYouTubeMediaUrl(url) || (raw.audioUrl && !L.isYouTubeMediaUrl(raw.audioUrl)))) return null;
  if (raw.via === 'metadata' && typeof L.isConcreteMetadataUrl === 'function' &&
      !L.isConcreteMetadataUrl(url, raw.contentType || null)) return null;
  // Page-created blob URLs (MSE players, X above all) are revoked by the page
  // the moment playback context changes; downloading one reliably fails with
  // SERVER_CANCELED and Chrome surfaces it as "check your internet
  // connection". They were dead weight in the list. Real downloads of page
  // media go through http(s) detection or our own assembled artifacts, which
  // arrive as blob:chrome-extension:// URLs from HLS/DASH jobs.
  if (url.indexOf('blob:') === 0 && url.indexOf('blob:chrome-extension://') !== 0) return null;
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
  const variants = L.normalizeHlsVariants(raw.variants || []);
  const requestedVariant = L.selectHlsVariant({ variants: variants }, raw.selectedVariantKey);
  const defaultVariant = requestedVariant || L.pickBestVariant(variants);
  const item = {
    url: url,
    key: L.itemKey(url) + (raw.dashEntry != null ? '#e' + raw.dashEntry : ''),
    kind: kind || 'video',
    ext: ext,
    contentType: raw.contentType || null,
    size: Number(raw.size) || 0,
    via: raw.via || null,
    pageUrl: raw.pageUrl || null,
    title: raw.title || null,
    duration: Number(raw.duration) || 0,
    metadataSource: raw.metadataSource || null,
    vimeoId: /^\d{1,20}$/.test(String(raw.vimeoId || '')) ? String(raw.vimeoId) : null,
    dashEntry: raw.dashEntry != null ? raw.dashEntry : null,
    dashType: raw.dashType || null,
    audioUrl: raw.audioUrl || null, // separate-track audio playlist (HLS two-source)
    variants: variants,
    selectedVariantKey: defaultVariant ? L.hlsVariantKey(defaultVariant) : null,
    tabId: tabId,
  };
  return item;
}

function groupedChildKeys(masters) {
  const keys = new Set();
  for (const master of masters || []) {
    if (!master || master.kind !== 'hls' || !Array.isArray(master.variants)) continue;
    for (const variant of master.variants) {
      if (!variant || !variant.url) continue;
      const key = L.hlsVariantKey(variant);
      if (key) keys.add(key);
      if (variant.audioUrl) {
        const audioKey = L.itemKey(variant.audioUrl);
        if (audioKey) keys.add(audioKey);
      }
    }
  }
  return keys;
}

function isGroupedPlaylistChild(item, childKeys, masterKeys) {
  if (!item || (item.kind !== 'hls' && item.kind !== 'hls-audio')) return false;
  return childKeys.has(item.key) && !masterKeys.has(item.key);
}

function addItems(tabId, rawItems) {
  let items = state.itemsByTab.get(tabId) || [];
  const minSize = effectiveMinSize();
  let incoming = (rawItems || []).map(function (r) { return normalizeItem(r, tabId); }).filter(Boolean).filter(function (it) {
    // VDH rule at the detection gate: direct media with a known size below
    // the threshold is noise (ads, thumbnails, tracking pixels). blob: items
    // and items with unknown size pass through.
    if (it.url.indexOf('blob:') === 0) return true;
    if (it.size > 0 && it.size < minSize) return false;
    // user blacklist: never collect from these hosts
    if (L.isBlacklisted(L.hostOf(it.url) || L.hostOf(it.pageUrl), settings.blacklist)) return false;
    return true;
  });
  if (!incoming.length) return { added: 0, total: items.length };

  const before = items.length;
  const candidateMasters = items.filter(function (it) {
    return it && it.kind === 'hls' && Array.isArray(it.variants) && it.variants.length;
  }).concat(incoming.filter(function (it) {
    return it && it.kind === 'hls' && Array.isArray(it.variants) && it.variants.length;
  }));
  const childKeys = groupedChildKeys(candidateMasters);
  const masterKeys = new Set(candidateMasters.map(function (it) { return it.key; }));
  // If a variant arrives after its master, ignore it. If it arrived first,
  // the final cleanup below removes it when the master supplies the group.
  incoming = incoming.filter(function (it) {
    return !isGroupedPlaylistChild(it, childKeys, masterKeys);
  });
  if (incoming.length) items = L.mergeItems(incoming, items);

  // Detection order is not guaranteed: a child can be stored before the
  // master. Recompute relationships from the merged masters and remove every
  // child playlist from the top-level card list in one pass.
  const masters = items.filter(function (it) {
    return it && it.kind === 'hls' && Array.isArray(it.variants) && it.variants.length;
  });
  const mergedChildKeys = groupedChildKeys(masters);
  const mergedMasterKeys = new Set(masters.map(function (it) { return it.key; }));
  items = items.filter(function (it) {
    return !isGroupedPlaylistChild(it, mergedChildKeys, mergedMasterKeys);
  });

  // cap list: keep newest-first order, drop overflow from the tail
  if (items.length > MAX_ITEMS_PER_TAB) items = items.slice(items.length - MAX_ITEMS_PER_TAB);
  state.itemsByTab.set(tabId, items);
  persistItems();
  updateBadge(tabId);
  fillTitles(tabId);
  return { added: Math.max(0, items.length - before), total: items.length };
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
function enqueue(item, forcedFilename, hlsUrl) {
  const filename = forcedFilename || L.filenameForItem(item, settings.rootFolder);
  const entry = { id: 'q' + Date.now() + '-' + Math.floor(Math.random() * 1e6), item: item, filename: filename, status: 'queued', error: null, hlsUrl: hlsUrl || null, startedAt: Date.now() };
  state.queue.push(entry);
  pump();
  persistActiveJobs();
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
  if (url.indexOf('blob:') === 0) { startDirect(entry); return; }
  // Auth-protected CDNs (X/Twitter's video CDN above all): chrome.downloads
  // cannot send custom headers, and those CDNs answer a headerless request
  // with 200 + a tiny error body — a "successful" download that is junk.
  // If the player itself needed Authorization for this URL, skip the direct
  // attempt and fetch through the offscreen document with the header.
  const hdrs = headersFor(url, entry.item.headers, entry.item.pageUrl);
  if (hasAuthenticatedHeaders(hdrs)) {
    fallbackDownload(entry);
    return;
  }
  // googlevideo (YouTube) rejects bare downloads with 403 + a text/plain
  // error body, which Brave then labels "<title>.txt" (0 bytes,
  // SERVER_BAD_CONTENT). The adapter's URLs only work with the player's
  // cookie/header context, so always take the offscreen fetch path for them.
  if (entry.item.via === 'youtube') {
    fallbackDownload(entry);
    return;
  }
  startDirect(entry);
}

// Release an extension-owned artifact URL (a blob URL the offscreen document
// created for a finished conversion). The offscreen streaming layer deletes the
// temporary OPFS file behind that URL when it is revoked, so releasing is the
// only way a save that can no longer complete stops holding gigabytes on disk.
function releaseArtifactUrl(url) {
  // Only extension-owned blob URLs carry a temporary OPFS artifact. The
  // offscreen document re-verifies ownership before releasing anything, so
  // matching the scheme and host is enough here.
  if (typeof url !== 'string' || url.indexOf('blob:chrome-extension://') !== 0) return null;
  try {
    const sent = chrome.runtime.sendMessage({ type: 'ms-offscreen-revoke-url', url: url });
    if (sent && typeof sent.catch === 'function') {
      sent.catch(function () { /* offscreen document already gone: file is cleaned with it */ });
    }
  } catch (e) { /* offscreen document already gone */ }
  return url;
}

function failDownloadEntry(entry, error) {
  if (!entry || entry.status === 'failed' || entry.status === 'complete') return;
  entry.status = 'failed';
  entry.error = String(error && error.message || error || 'download failed');
  state.active.delete(entry.id);
  if (entry.downloadId != null) state.downloadToItem.delete(entry.downloadId);
  // A permanently failed save can no longer consume its artifact, and that
  // artifact is a temporary OPFS file behind an extension-owned blob URL.
  // Releasing the URL is what deletes the file; without this a failed save of a
  // multi-gigabyte item kept its file until the offscreen document went away.
  const released = releaseArtifactUrl(entry.item && entry.item.url);
  if (entry.hlsUrl) {
    const j = state.hlsJobs.get(entry.hlsUrl);
    if (j && (!j.queueEntryId || j.queueEntryId === entry.id)) {
      j.status = 'failed';
      j.error = entry.error;
      if (released && j.blobUrl === released) j.blobUrl = null;
    }
  }
  pump();
  persistActiveJobs();
}

// A bare chrome.downloads request can be refused by a hotlink-protecting CDN
// (403 / auth / googlevideo's text/plain 403 page shows up as
// SERVER_BAD_CONTENT). Retry once through a SW fetch that carries the
// browser's cookies plus the headers captured from the player's own requests.
// Returns true when the retry was started instead of failing the entry.
function retryOrFailInterruptedDownload(entry, error) {
  const errCode = String(error && error.message || error || 'interrupted');
  const retriable = /FORBIDDEN|UNAUTHORIZED|ACCESS_DENIED|NETWORK_FAILED|SERVER_BAD_CONTENT|SERVER_FORBIDDEN/i.test(errCode);
  if (retriable && !entry.triedFallback && entry.item && String(entry.item.url).indexOf('blob:') !== 0) {
    entry.triedFallback = true;
    if (entry.downloadId != null) state.downloadToItem.delete(entry.downloadId);
    delete entry.downloadId;
    fallbackDownload(entry);
    return true;
  }
  failDownloadEntry(entry, errCode);
  return false;
}

function acceptDownloadId(entry, downloadId) {
  if (entry.status === 'failed' || entry.status === 'complete' || entry.downloadId != null) return;
  if (chrome.runtime.lastError) {
    failDownloadEntry(entry, chrome.runtime.lastError.message || 'download failed');
    return;
  }
  if (!Number.isFinite(downloadId) || downloadId < 1) {
    failDownloadEntry(entry, 'download API returned no id');
    return;
  }
  entry.downloadId = downloadId;
  state.downloadToItem.set(downloadId, entry);
  persistActiveJobs();
}

function requestChromeDownload(entry, opts) {
  let settled = false;
  const done = function (downloadId) {
    if (settled) return;
    settled = true;
    acceptDownloadId(entry, downloadId);
  };
  try {
    const result = chrome.downloads.download(opts, done);
    if (result && typeof result.then === 'function') {
      result.then(done).catch(function (err) {
        if (settled) return;
        settled = true;
        failDownloadEntry(entry, err);
      });
    }
  } catch (err) {
    if (!settled) {
      settled = true;
      failDownloadEntry(entry, err);
    }
  }
}

function refreshDownloadProgress(entry) {
  if (!entry || entry.downloadId == null || !chrome.downloads || typeof chrome.downloads.search !== 'function') {
    return Promise.resolve(entry);
  }
  return new Promise(function (resolve) {
    let settled = false;
    const done = function (items) {
      if (settled) return;
      settled = true;
      const item = Array.isArray(items) ? items[0] : null;
      if (item) {
        entry.receivedBytes = Number(item.bytesReceived) || 0;
        entry.totalBytes = Number(item.totalBytes) || 0;
        if (item.state === 'complete') {
          entry.status = 'complete';
          state.downloadToItem.delete(entry.downloadId);
          state.active.delete(entry.id);
          persistActiveJobs();
        } else if (item.state === 'interrupted') {
          retryOrFailInterruptedDownload(entry, item.error || 'interrupted');
        }
        if (entry.hlsUrl) {
          const job = state.hlsJobs.get(entry.hlsUrl);
          if (job && job.queueEntryId === entry.id) {
            job.receivedBytes = entry.receivedBytes;
            job.totalBytes = entry.totalBytes;
            if (entry.status === 'complete' || entry.status === 'failed') job.status = entry.status;
          }
        }
      }
      resolve(entry);
    };
    try {
      const result = chrome.downloads.search({ id: entry.downloadId }, done);
      if (result && typeof result.then === 'function') result.then(done).catch(function () { done([]); });
    } catch (e) { done([]); }
  });
}

function publicError(error) {
  if (!error) return null;
  return String(error)
    .replace(/https?:\/\/[^\s"'<>]+/gi, function (raw) {
      try {
        const u = new URL(raw);
        return u.origin + u.pathname + (u.search ? '?[REDACTED]' : '');
      } catch (_) { return '[REDACTED URL]'; }
    })
    .replace(/\b(authorization|cookie|set-cookie)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi, '$1: [REDACTED]');
}

function ensurePublicJobId(job) {
  if (!job.publicId) job.publicId = 'j' + Date.now().toString(36) + (++jobPublicSequence).toString(36) + Math.random().toString(36).slice(2, 8);
  return job.publicId;
}

function mediaJobByPublicId(publicId) {
  let found = null;
  state.hlsJobs.forEach(function (job, key) {
    if (!found && job && ensurePublicJobId(job) === publicId) found = { key: key, job: job };
  });
  return found;
}

function publicQueueEntry(q) {
  return {
    id: q.id, status: q.status, filename: q.filename, error: publicError(q.error),
    receivedBytes: q.receivedBytes || 0, totalBytes: q.totalBytes || 0,
  };
}

function publicJobs() {
  const jobs = [];
  state.hlsJobs.forEach(function (job, jobKey) {
    if (!job) return;
    const publicId = ensurePublicJobId(job);
    jobs.push({
      id: 'media:' + publicId, jobKey: publicId, type: 'media', status: job.status,
      tabId: job.tabId, title: job.title || job.filename || 'Media',
      filename: job.filename || null, live: !!job.live,
      done: job.done || 0, total: job.total || 0, bytes: job.bytes || 0,
      seconds: job.seconds || 0, receivedBytes: job.receivedBytes || 0,
      totalBytes: job.totalBytes || 0, startedAt: job.startedAt || 0,
      fetches: job.fetches || 0, fetchedBytes: job.fetchedBytes || 0,
      mode: job.mode || null, error: publicError(job.error),
    });
  });
  state.queue.forEach(function (entry) {
    if (!entry || entry.hlsUrl) return;
    jobs.push({
      id: entry.id, type: 'download', status: entry.status,
      tabId: entry.item && entry.item.tabId,
      title: entry.item && entry.item.title || entry.filename || 'Media',
      filename: entry.filename || null, live: false,
      receivedBytes: entry.receivedBytes || 0, totalBytes: entry.totalBytes || 0,
      startedAt: entry.startedAt || 0, error: publicError(entry.error),
    });
  });
  return jobs.slice(0, MAX_ITEMS_PER_TAB);
}

function startDirect(entry) {
  const url = entry.item.url;
  const opts = { url: url };
  // ユーザー指定: フォルダ管理なし、~/Downloads 直下にフラット保存。
  // conflictAction は uniquify: 同名ファイルは上書きせず番号付きで残す。
  opts.filename = entry.filename;
  opts.conflictAction = 'uniquify';
  opts.saveAs = false;
  requestChromeDownload(entry, opts);
}

chrome.downloads.onChanged.addListener(function (delta) {
  const entry = state.downloadToItem.get(delta.id);
  if (!entry) return; // not ours
  const s = delta.state && delta.state.current;
  if (s === 'complete') {
    entry.status = 'complete';
    state.downloadToItem.delete(delta.id);
    state.active.delete(entry.id);
    if (entry.hlsUrl) {
      const j = state.hlsJobs.get(entry.hlsUrl);
      if (j && (!j.queueEntryId || j.queueEntryId === entry.id)) {
        j.status = 'complete';
      }
    }
    pump();
    persistActiveJobs();
  } else if (s === 'interrupted') {
    // keep the queue slot; the fallback retry re-registers or frees it
    retryOrFailInterruptedDownload(entry, (delta.error && delta.error.current) || 'interrupted');
  }
});

// ---------------------------------------------------------------------------
// Fallback download: fetch the media in the service worker (cookies +
// captured player headers), then hand the bytes to chrome.downloads via an
// offscreen blob URL. Used when chrome.downloads.download gets 403'd by a
// hotlink-protecting CDN.
// ---------------------------------------------------------------------------
function fallbackDownload(entry) {
  const item = entry.item;
  entry.status = 'fallback';
  persistActiveJobs();
  // captured player headers first (webRequest path), item.headers second
  // (popup/adapter path)
  const headers = headersFor(item.url, item.headers, item.pageUrl);
  // offscreen fetches the body itself (bytes never cross SW messaging)
  const mime = item.contentType || 'video/mp4';
  makeBlobUrlFromRemote(item.url, mime, headers).then(function (made) {
    requestChromeDownload(entry, {
      url: made.url,
      filename: entry.filename,
      conflictAction: 'uniquify',
      saveAs: false,
    });
  }).catch(function (err) {
    failDownloadEntry(entry, err);
  });
}

// ---------------------------------------------------------------------------
// HLS orchestration: parsed in the service worker, bytes fetched & combined
// in the offscreen document.
//
// WHY offscreen does the byte work: on Brave 151 an ArrayBuffer sent through
// chrome.runtime.sendMessage arrives at the other side as a plain {} —
// segments sent SW -> offscreen produced a file of "[object Object]"
// (8 x 188-byte segments = 120-byte "video", the empty-file bug). So the SW
// only sends URLs + headers (small, structured-clone-safe) and the offscreen
// document fetches, combines, and mints the blob URL itself.
// ---------------------------------------------------------------------------
const HLS_CONCURRENCY = 6;

async function ensureOffscreen() {
  if (!chrome.offscreen) throw new Error('offscreen API unavailable');
  try {
    if (typeof chrome.offscreen.hasDocument === 'function') {
      const has = await chrome.offscreen.hasDocument();
      if (has) return;
    }
    await chrome.offscreen.createDocument({
      url: 'src/offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Fetch and combine media segments, create blob URL',
    });
  } catch (e) {
    // "Only a single offscreen" error is fine
  }
}

let mediaLeaseSequence = 0;

async function runWithMediaJobLease(work) {
  await ensureOffscreen();
  mediaLeaseSequence = (mediaLeaseSequence + 1) % 1000000;
  const leaseId = 'job-' + Date.now() + '-' + mediaLeaseSequence;
  const acquired = await chrome.runtime.sendMessage({
    type: 'ms-offscreen-keepalive-acquire', leaseId: leaseId,
  });
  if (!acquired || !acquired.ok) throw new Error('media keepalive unavailable');
  try {
    return await work();
  } finally {
    try {
      await chrome.runtime.sendMessage({ type: 'ms-offscreen-keepalive-release', leaseId: leaseId });
    } catch (e) { /* closing/restarted offscreen document releases the port */ }
  }
}

// Fetch a media body and return a blob URL for it (fallback download path).
// Bytes stay inside the offscreen document.
async function makeBlobUrlFromRemote(url, mime, headers) {
  await ensureOffscreen();
  const resp = await chrome.runtime.sendMessage({
    type: 'ms-offscreen-fetch-blob',
    url: url,
    mime: mime || 'application/octet-stream',
    headers: headers || {},
  });
  if (!resp || !resp.url) throw new Error('offscreen fetch failed' + (resp && resp.error ? ': ' + resp.error : ''));
  return { url: resp.url, size: resp.size || 0 };
}

// Delegate segment fetch + combine + blob creation to the offscreen document.
// Progress comes back as plain counters via 'ms-hls-progress' messages.
// Used for the audio-only ADTS path (X Spaces): raw concat is byte-perfect.
async function offscreenHlsBuild(req, job) {
  await ensureOffscreen();
  const resp = await chrome.runtime.sendMessage({
    type: 'ms-offscreen-hls-build',
    playlistUrl: req.playlistUrl,
    segments: req.segments,
    initUrl: req.initUrl,
    headers: req.headers,
    mime: req.mime,
  });
  if (job) job.done = job.total; // message may race; final state is authoritative
  if (!resp || !resp.url) throw new Error('offscreen hls build failed' + (resp && resp.error ? ': ' + resp.error : ''));
  return { url: resp.url, size: resp.size || 0 };
}

// Run an HLS ffmpeg job inside the offscreen document (VDH's architecture:
// the browser session is fed to ffmpeg through the jsfetch protocol, so
// ffmpeg natively handles AES-128 keys, fMP4/BYTERANGE, TS->MP4 remux and
// live recording). DASH does NOT go through here — see runDashJob.
async function offscreenFfmpegRun(req) {
  await ensureOffscreen();
  // SW-restart recovery: the SW can die between "offscreen finished" and
  // "download queued". If the offscreen document still holds the result for
  // this jobId (or is still running the same job), reuse it instead of
  // re-running a multi-gigabyte ffmpeg job from scratch.
  try {
    const st = await chrome.runtime.sendMessage({ type: 'ms-offscreen-ffmpeg-status' });
    if (st) {
      if (st.done && st.done.jobId === req.jobId && !st.running) {
        return { url: st.done.url, size: st.done.size || 0, partial: !!st.done.partial };
      }
      if (st.running && st.jobId === req.jobId) {
        // wait for the surviving offscreen job to finish
        const started = Date.now();
        while (Date.now() - started < 30 * 60 * 1000) {
          const s2 = await chrome.runtime.sendMessage({ type: 'ms-offscreen-ffmpeg-status' });
          if (s2 && !s2.running && s2.done && s2.done.jobId === req.jobId) {
            return { url: s2.done.url, size: s2.done.size || 0, partial: !!s2.done.partial };
          }
          if (!s2 || !s2.running) break; // job vanished: re-run below
          await new Promise(function (r) { setTimeout(r, 1500); });
        }
      }
    }
  } catch (e) { /* offscreen gone: run fresh below */ }
  const resp = await chrome.runtime.sendMessage({
    type: 'ms-offscreen-ffmpeg-run',
    jobId: req.jobId,
    url: req.url,
    audioUrl: req.audioUrl || null,
    ext: req.ext || 'mp4',
    live: !!req.live,
    adtsFix: !!req.adtsFix,
    headers: req.headers || {},
    pageUrl: req.pageUrl || null,
  });
  if (!resp || !resp.url) throw new Error('ffmpeg job failed' + (resp && resp.error ? ': ' + resp.error : ''));
  return { url: resp.url, size: resp.size || 0, partial: !!resp.partial };
}

function responseHeader(res, name) {
  if (!res || !res.headers) return null;
  if (typeof res.headers.get === 'function') return res.headers.get(name);
  const wanted = String(name).toLowerCase();
  for (const key of Object.keys(res.headers)) {
    if (key.toLowerCase() === wanted) return res.headers[key];
  }
  return null;
}

async function boundedResponseText(res, maxChars) {
  const max = Number(maxChars) || 0;
  const declared = parseInt(responseHeader(res, 'content-length'), 10);
  if (declared > max) throw new Error('manifest response exceeds limit');
  if (!res || typeof res.text !== 'function') throw new Error('manifest response has no text body');
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    if (typeof text !== 'string' || text.length > max) throw new Error('manifest response exceeds limit');
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const value = part.value instanceof Uint8Array ? part.value : new Uint8Array(part.value || 0);
      total += value.byteLength;
      if (total > max) {
        try { await reader.cancel(); } catch (e) { /* best effort */ }
        throw new Error('manifest response exceeds limit');
      }
      chunks.push(value);
    }
  } catch (err) {
    try { reader.releaseLock(); } catch (e) { /* best effort */ }
    throw err;
  }
  try { reader.releaseLock(); } catch (e) { /* best effort */ }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (typeof TextDecoder === 'undefined') throw new Error('manifest decoder unavailable');
  const text = new TextDecoder().decode(bytes);
  if (text.length > max) throw new Error('manifest response exceeds limit');
  return text;
}

function swFetchText(url, headers) {
  return fetch(url, { credentials: 'include', headers: headers || {} }).then(function (res) {
    if (!res.ok) throw new Error('http ' + res.status);
    return boundedResponseText(res, L.MAX_HLS_PLAYLIST_CHARS);
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

async function runHlsJob(jobKey, playlistUrl) {
  const job = state.hlsJobs.get(jobKey);
  if (!job) throw new Error('no job');

  // Replay the headers the page's player used for this playlist (X's CDN
  // requires Authorization: Bearer *** playlists AND segments alike).
  const hdrs = headersFor(playlistUrl, null, job.pageUrl);

  job.status = 'fetching';
  const masterText = await swFetchText(playlistUrl, hdrs);
  const masterParsed = L.parseM3u8(masterText, playlistUrl);

  let mediaUrl = playlistUrl;
  let mediaText = masterText;
  let variant = null;

  if (masterParsed.type === 'master') {
    variant = masterParsed.variants.find(function (candidate) {
      const candidateUrl = withToken(candidate.url, candidate.token);
      const candidateKey = L.hlsVariantKey({ url: candidateUrl });
      return (job.variantUrl && candidateUrl === job.variantUrl) ||
        (job.variantKey && (candidateUrl === job.variantKey || candidateKey === job.variantKey));
    }) || L.pickBestVariant(masterParsed.variants);
    if (!variant) throw new Error('no variants in master playlist');
    mediaUrl = withToken(variant.url, variant.token);
    if (!job.audioUrl) job.audioUrl = pickAudioUrl(masterParsed, variant);
    job.status = 'fetching';
    mediaText = await swFetchText(mediaUrl, headersFor(mediaUrl, hdrs, playlistUrl));
  }

  const media = L.parseM3u8(mediaText, mediaUrl);
  if (media.type !== 'media') throw new Error('not a media playlist');
  if (!media.segments.length) throw new Error('playlist has no segments');

  job.mediaUrl = mediaUrl;
  const audioOnly = L.isAudioOnlyPlaylist(media);

  // Path 1: audio-only ADTS (X Spaces replays). Raw concat is byte-perfect
  // and costs no wasm boot — keep the fast path.
  if (audioOnly && !media.encrypted && !media.live) {
    job.status = 'combining';
    job.mode = 'concat';
    job.total = media.segments.length + (media.initUrl ? 1 : 0);
    const segHeaders = headersFor(media.segments[0].url, hdrs, mediaUrl);
    const made = await offscreenHlsBuild({
      playlistUrl: playlistUrl,
      segments: media.segments.map(function (s) { return s.url; }),
      initUrl: media.initUrl || null,
      headers: segHeaders,
      mime: 'audio/aac',
    }, job);
    return finishMediaJob(jobKey, made, 'aac', 'audio');
  }

  // Path 2: ffmpeg (VDH architecture). Handles everything the hand-rolled
  // combiner could not: AES-128 keys, fMP4/BYTERANGE, TS->MP4 remux.
  job.mode = 'ffmpeg';
  job.ext = audioOnly ? 'aac' : 'mp4';
  job.outputKind = audioOnly ? 'audio' : 'video';
  // Separate-track audio (VDH "m3u8_audio_video_two_sources"): the variant's
  // video playlist has no in-band audio, so ffmpeg gets a second -i for the
  // audio playlist and maps one stream from each. VOD only — live two-source
  // muxing is not worth the complexity here.
  const twoSource = !audioOnly && !media.live && job.audioUrl;
  const audioHeaders = twoSource ? Object.assign({}, headersFor(mediaUrl, hdrs, playlistUrl), headersFor(job.audioUrl, hdrs, playlistUrl)) : null;
  const req = {
    jobId: jobKey,
    kind: 'hls',
    url: mediaUrl,
    audioUrl: twoSource ? job.audioUrl : null,
    ext: job.ext,
    live: !!media.live,
    pageUrl: job.pageUrl || null,
    headers: twoSource ? audioHeaders : headersFor(mediaUrl, hdrs, playlistUrl),
    // A live recording is written as fragmented MP4 (`-movflags
    // frag_keyframe+empty_moov+...`), and that muxer never applies the automatic
    // AAC-ADTS to ASC conversion: with MPEG-TS segments ffmpeg then fails on the
    // first audio packet ("Malformed AAC bitstream detected"), which used to
    // kill every live recording of a TS stream within a second. fMP4 segments
    // (EXT-X-MAP) already carry ASC, so the filter is added only for TS.
    adtsFix: !!media.live && !media.initUrl,
  };

  if (media.live) {
    // Live recording: ffmpeg runs until the user presses Stop. Fragmented
    // MP4 keeps the partial file playable. The popup gets {recording:true}
    // immediately and polls ms-hls-status; the ffmpeg job keeps running in
    // the offscreen document, and when it ends the blob is queued.
    job.status = 'recording';
    job.live = true;
    job.startedAt = Date.now();
    persistActiveJobs();
    return offscreenFfmpegRun(req).then(function (made) {
      const secs = Math.max(1, Math.round((Date.now() - job.startedAt) / 1000));
      job.title = (job.title || 'stream') + ' [' + fmtClock(secs) + ']';
      return finishMediaJob(jobKey, made, job.ext, audioOnly ? 'audio' : 'video');
    }).catch(function (err) {
      job.status = 'failed';
      job.error = String(err && err.message || err);
      persistActiveJobs();
      return { error: job.error };
    });
  }

  job.status = 'combining';
  persistActiveJobs();
  const made = await offscreenFfmpegRun(req);
  return finishMediaJob(jobKey, made, job.ext, audioOnly ? 'audio' : 'video');
}

function fmtClock(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m >= 60) return Math.floor(m / 60) + 'h' + (m % 60) + 'm';
  return m + 'm' + s + 's';
}

// common tail: blob ready -> queue the actual download, link it to the job
function finishMediaJob(playlistUrl, made, ext, kind) {
  const job = state.hlsJobs.get(playlistUrl);
  if (!job) throw new Error('no job');
  job.status = 'downloading';
  job.live = false;
  job.blobUrl = made.url;
  job.size = made.size;

  const item = normalizeItem({
    url: made.url,
    kind: kind,
    ext: ext,
    title: job.title || null,
    pageUrl: job.pageUrl || null,
    size: made.size,
  }, job.tabId);
  const entry = enqueue(item, null, playlistUrl);
  // link the queue entry back to the job so completion/failure of the blob
  // download updates the job state the popup is polling
  job.filename = entry.filename;
  job.queueEntryId = entry.id;
  persistActiveJobs();
  return { queued: true };
}

function failRestoredMediaJob(job, message) {
  job.status = 'failed';
  job.error = message;
  persistActiveJobs();
}

function waitForRestoredFfmpeg(jobKey, job) {
  const check = function () {
    return chrome.runtime.sendMessage({ type: 'ms-offscreen-ffmpeg-status' }).then(function (status) {
      if (status && status.done && status.done.jobId === jobKey && !status.running) {
        job.seconds = status.seconds || job.seconds || 0;
        job.bytes = status.bytes || status.done.size || 0;
        return finishMediaJob(jobKey, status.done, job.ext || status.done.ext || 'mp4', job.outputKind || 'video');
      }
      if (status && status.running && status.jobId === jobKey) {
        job.seconds = status.seconds || job.seconds || 0;
        job.bytes = status.bytes || job.bytes || 0;
        return new Promise(function (resolve) { setTimeout(resolve, 1500); }).then(check);
      }
      failRestoredMediaJob(job, '変換処理を復元できませんでした');
      return null;
    }).catch(function () {
      failRestoredMediaJob(job, '変換処理を復元できませんでした');
      return null;
    });
  };
  return check();
}

function recoverRestoredMediaJobs() {
  state.hlsJobs.forEach(function (job, jobKey) {
    if (!job || !job._restored) return;
    delete job._restored;
    if ((job.status === 'combining' || job.status === 'recording') && job.mode === 'ffmpeg') {
      // Reserve the global conversion slot while the recovered offscreen job
      // finishes, so a new save cannot start against the busy ffmpeg instance.
      runOnMediaTail(function () { return waitForRestoredFfmpeg(jobKey, job); });
      return;
    }
    // Jobs that never reached the offscreen document (queued / still reading
    // the manifest) are simply re-run through the scheduler.
    if (job.status === 'queued' || job.status === 'fetching') {
      resumeRestoredMediaJob(jobKey, job);
      return;
    }
    if (job.status === 'complete' || job.status === 'failed') return;
    if (job.status !== 'downloading') failRestoredMediaJob(job, 'バックグラウンド再起動後に処理を再開できませんでした');
  });
}

function reconcileRestoredQueueEntry(entry) {
  if (!entry || !entry._restored) return Promise.resolve();
  delete entry._restored;
  if (entry.status === 'queued' && entry.downloadId == null) return Promise.resolve();
  if (entry.downloadId == null) {
    // The worker died between "download requested" and "id known" (or in the
    // middle of an authenticated retry): hand it to the same SW-fetch fallback
    // the normal interrupted path uses instead of discarding the save.
    const canRetry = entry.item && String(entry.item.url).indexOf('blob:') !== 0 &&
      (entry.status === 'fallback' || !entry.triedFallback);
    if (canRetry) {
      entry.triedFallback = true;
      fallbackDownload(entry);
    } else {
      failDownloadEntry(entry, 'バックグラウンド再起動後にダウンロードを復元できませんでした');
    }
    return Promise.resolve();
  }
  return new Promise(function (resolve) {
    let settled = false;
    const done = function (items) {
      if (settled) return;
      settled = true;
      const found = Array.isArray(items) ? items[0] : null;
      if (!found) {
        failDownloadEntry(entry, 'ブラウザのダウンロード状態を復元できませんでした');
        resolve();
        return;
      }
      entry.receivedBytes = Number(found.bytesReceived) || 0;
      entry.totalBytes = Number(found.totalBytes) || 0;
      if (found.state === 'complete') {
        entry.status = 'complete';
        state.active.delete(entry.id);
        state.downloadToItem.delete(entry.downloadId);
      } else if (found.state === 'interrupted') {
        retryOrFailInterruptedDownload(entry, found.error || 'interrupted');
        resolve();
        return;
      } else {
        entry.status = 'downloading';
        state.active.add(entry.id);
        state.downloadToItem.set(entry.downloadId, entry);
      }
      if (entry.hlsUrl) {
        const job = state.hlsJobs.get(entry.hlsUrl);
        if (job && job.queueEntryId === entry.id) {
          job.status = entry.status;
          job.receivedBytes = entry.receivedBytes;
          job.totalBytes = entry.totalBytes;
        }
      }
      resolve();
    };
    try {
      const result = chrome.downloads.search({ id: entry.downloadId }, done);
      if (result && typeof result.then === 'function') result.then(done).catch(function () { done([]); });
    } catch (_) { done([]); }
  });
}

function recoverRestoredWork() {
  return Promise.all(state.queue.map(reconcileRestoredQueueEntry)).then(function () {
    recoverRestoredMediaJobs();
    pump();
    persistActiveJobs();
  });
}

// DASH (mpd) VOD — fetch-our-own architecture. ffmpeg's dash demuxer over
// jsfetch is NOT usable with this libav build in the browser: it deadlocks
// the event loop the moment the demuxer opens a 2nd segment (verified with
// -loglevel trace: single-segment manifests finish, anything with 2+
// segments freezes; -map does not help because the demuxer fetches every
// representation anyway). So we parse the manifest ourselves (entry numbers
// still match ffmpeg's per-Representation document order), fetch init +
// media segments with plain fetch() carrying the captured headers, and only
// touch ffmpeg for the video+audio mux of two already-local files.
async function runDashJob(jobKey, url) {
  const job = state.hlsJobs.get(jobKey);
  if (!job) throw new Error('no job');
  const hdrs = headersFor(url, null, job.pageUrl);
  job.status = 'fetching';
  const mpdText = await swFetchText(url, hdrs);
  const parsed = L.parseMpdSegments(mpdText, url);
  if (!parsed.tracks.length) throw new Error('MPDを解析できませんでした');

  let track = null;
  if (job.dashEntry != null) {
    track = parsed.tracks.find(function (t) { return t.entry === job.dashEntry; }) || null;
  }
  if (!track) track = parsed.tracks.find(function (t) { return t.type === job.dashType; }) || parsed.tracks[0];
  if (!track || !track.segments.length) throw new Error('トラックのセグメントを解決できませんでした');

  job.mode = 'concat';
  job.status = 'combining';
  job.total = track.segments.length + (track.initUrl ? 1 : 0);
  // Video track: mux the best audio track in as well (VDH's one-source
  // behaviour), unless the user explicitly saved the audio entry.
  let audioTrack = null;
  if (track.type === 'video') {
    audioTrack = parsed.tracks.find(function (t) { return t.type === 'audio'; }) || null;
    if (audioTrack) job.total += audioTrack.segments.length + (audioTrack.initUrl ? 1 : 0);
  }
  const isAudio = track.type === 'audio';
  job.ext = isAudio ? 'm4a' : 'mp4';

  const made = await offscreenDashBuild({
    jobKey: jobKey,
    video: track.type === 'video' ? track : null,
    audio: isAudio ? track : audioTrack,
    headers: hdrs,
  }, job);
  return finishMediaJob(jobKey, made, job.ext, track.type);
}

// Delegate DASH track fetch + concat (+ optional v/a mux) to the offscreen
// document. Progress comes back as plain counters via 'ms-hls-progress'.
async function offscreenDashBuild(req, job) {
  await ensureOffscreen();
  const resp = await chrome.runtime.sendMessage({
    type: 'ms-offscreen-dash-build',
    playlistUrl: req.jobKey,
    video: req.video ? { initUrl: req.video.initUrl || null, segments: req.video.segments } : null,
    audio: req.audio ? { initUrl: req.audio.initUrl || null, segments: req.audio.segments } : null,
    headers: req.headers,
  });
  if (!resp || !resp.url) throw new Error('DASHビルド失敗' + (resp && resp.error ? ': ' + resp.error : ''));
  return { url: resp.url, size: resp.size || 0 };
}

// ---------------------------------------------------------------------------
// YouTube adaptive mux: fetch the DASH video + audio tracks with the page's
// googlevideo session ourselves, then mux two LOCAL files in ffmpeg — the
// exact architecture that already works for DASH (jsfetch+dash demuxer is
// unusable in this libav build; local-file mux never touches it).
// ---------------------------------------------------------------------------
async function runYtMuxJob(jobKey, item) {
  const job = state.hlsJobs.get(jobKey);
  if (!job) throw new Error('no job');
  const hdrs = headersFor(item.url, item.headers, item.pageUrl);

  // resolve real track URLs: youtube.com/oembed gives title metadata but not
  // streams; the adapter already extracted signed googlevideo urls.
  const videoUrl = item.url;
  let audioUrl = item.audioUrl;
  if (!audioUrl) throw new Error('音声トラックのURLがありません');

  job.status = 'fetching';
  job.mode = 'mux';
  job.ext = 'mp4';

  const vResp = await makeBlobUrlFromRemote(videoUrl, 'video/mp4', hdrs);
  job.total = 2; job.done = 1;
  const aResp = await makeBlobUrlFromRemote(audioUrl, 'audio/mp4', headersFor(audioUrl, hdrs, item.url));
  job.done = 2;

  job.status = 'combining';
  const resp = await chrome.runtime.sendMessage({
    type: 'ms-offscreen-mux-local',
    jobId: jobKey,
    videoUrl: vResp.url,
    audioUrl: aResp.url,
    ext: 'mp4',
  });
  if (!resp || !resp.url) throw new Error('YouTube mux失敗' + (resp && resp.error ? ': ' + resp.error : ''));
  return finishMediaJob(jobKey, resp, 'mp4', 'video');
}

function buildMediaJobKey(url, dashEntry, variantKey) {
  let key = String(url || '');
  if (dashEntry != null && dashEntry >= 0) key += '#dash-entry=' + dashEntry;
  if (variantKey) key += '#hls-variant=' + encodeURIComponent(String(variantKey));
  return key;
}

function selectedHlsRequest(item) {
  const variant = item && item.kind === 'hls' ? L.selectedHlsVariant(item) : null;
  return {
    variant: variant,
    variantUrl: variant ? variant.url : null,
    variantKey: variant ? L.hlsVariantKey(variant) : null,
    audioUrl: variant ? (variant.audioUrl || null) : (item && item.audioUrl ? item.audioUrl : null),
  };
}

function isMediaJobRunning(job) {
  return !!job && (job.status === 'queued' || job.status === 'fetching' || job.status === 'combining' ||
    job.status === 'recording' || job.status === 'downloading');
}

function runningMediaJobByItemKey(itemKey) {
  if (!itemKey) return null;
  let found = null;
  state.hlsJobs.forEach(function (job, key) {
    if (!found && job && job.itemKey === itemKey && isMediaJobRunning(job)) found = { key: key, job: job };
  });
  return found;
}

let mediaExecutionTail = Promise.resolve();

// The offscreen document owns exactly ONE ffmpeg instance, so every conversion
// (new save, recovered live recording, restarted queued job) must reserve this
// global tail. Running two at once only trips the offscreen busy guard.
function runOnMediaTail(task) {
  const execution = mediaExecutionTail.catch(function () {}).then(task);
  mediaExecutionTail = execution.then(function () {}, function () {});
  return execution;
}

function scheduleMediaExecution(jobKey, runner) {
  // Bootstrap order: finish session restore + recovery first, so a save started
  // right after a worker restart cannot jump ahead of the recovered FFmpeg job.
  return restorePromise.then(function () {
    return runOnMediaTail(function () {
      const job = state.hlsJobs.get(jobKey);
      if (!job || !isMediaJobRunning(job)) throw new Error('job is no longer active');
      if (job.status === 'queued') job.status = 'fetching';
      persistActiveJobs();
      return runWithMediaJobLease(runner);
    });
  });
}

function resumeRestoredMediaJob(jobKey, job) {
  const url = job.sourceUrl || null;
  if (!url) { failRestoredMediaJob(job, 'URLを復元できないため再開できませんでした'); return; }
  let runner = null;
  if (jobKey.indexOf('yt-mux:') === 0) {
    const item = normalizeItem({
      url: url, kind: 'video', via: 'youtube', audioUrl: job.audioUrl || null,
      title: job.title || null, pageUrl: job.pageUrl || null,
    }, job.tabId);
    if (!item || !item.audioUrl) {
      failRestoredMediaJob(job, '音声トラックのURLを復元できないため再開できませんでした');
      return;
    }
    runner = function () { return runYtMuxJob(jobKey, item); };
  } else if (job.dashEntry != null || /\.mpd(\?|$)/i.test(url)) {
    runner = function () { return runDashJob(jobKey, url); };
  } else {
    runner = function () { return runHlsJob(jobKey, url); };
  }
  job.status = 'queued';
  persistActiveJobs();
  scheduleMediaExecution(jobKey, runner).catch(function (err) {
    const j = state.hlsJobs.get(jobKey);
    if (j && isMediaJobRunning(j)) {
      j.status = 'failed';
      j.error = String(err && err.message || err);
    }
    persistActiveJobs();
  });
}

function startHls(tabId, jobKey, url, title, pageUrl, dashEntry, dashType, audioUrl, itemRef, requestedKind, variantUrl, variantKey, itemKey) {
  const ref = itemRef || null;
  const existing = state.hlsJobs.get(jobKey);
  if (isMediaJobRunning(existing)) {
    return Promise.resolve({ alreadyRunning: true });
  }
  state.hlsJobs.set(jobKey, {
    status: 'queued', tabId: tabId, done: 0, total: 0, error: null, live: false,
    title: title || null, pageUrl: pageUrl || null, blobUrl: null, size: 0,
    seconds: 0, bytes: 0, startedAt: Date.now(), mode: null, ext: null,
    dashEntry: dashEntry != null ? dashEntry : null,
    dashType: dashType || null,
    audioUrl: audioUrl || null,
    variantUrl: variantUrl || null,
    variantKey: variantKey || null,
    sourceUrl: url,
    itemKey: itemKey || (ref && ref.key) || null,
  });
  persistActiveJobs();
  let runner = null;
  if (ref && ref.via === 'youtube' && ref.audioUrl) {
    runner = function () { return runYtMuxJob(jobKey, ref); };
  } else {
    runner = (requestedKind === 'dash' || /\.mpd(\?|$)/i.test(url)) ? runDashJob : runHlsJob;
  }
  return scheduleMediaExecution(jobKey, function () { return runner(jobKey, url); }).then(function (result) {
    if (result && typeof result === 'object') result.jobKey = jobKey;
    return result;
  }).catch(function (err) {
    const j = state.hlsJobs.get(jobKey);
    if (j) { j.status = 'failed'; j.error = String(err && err.message || err); persistActiveJobs(); }
    return { error: j && j.error, jobKey: jobKey };
  });
}

// stop a live recording (ffmpeg abort; fragmented MP4 stays valid)
function stopLiveRecording(url, jobKey) {
  const publicMatch = jobKey ? mediaJobByPublicId(jobKey) : null;
  const key = publicMatch ? publicMatch.key : (jobKey || url);
  const job = publicMatch ? publicMatch.job : (state.hlsJobs.get(key) || state.hlsJobs.get(url));
  if (!job || job.status !== 'recording') return Promise.resolve({ ok: false });
  return ensureOffscreen().then(function () {
    return chrome.runtime.sendMessage({ type: 'ms-offscreen-ffmpeg-abort', jobId: key });
  }).then(function (r) {
    return { ok: !!(r && r.ok) };
  }).catch(function () { return { ok: false }; });
}

// ---------------------------------------------------------------------------
// Media chain (download-all): HLS/DASH jobs run ONE at a time — the offscreen
// document holds a single ffmpeg instance, so parallel jobs would just queue
// on the busy-guard anyway. Direct items are already in the download queue.
// ---------------------------------------------------------------------------
// Legacy per-tab Save-All chains: superseded by the global serialized media
// scheduler above (every deferred item becomes a queued job immediately, so a
// tab close or worker restart can no longer drop it). The map stays because the
// lifecycle cleanup still clears it per tab.
const mediaChains = new Map(); // tabId -> chain (unused)

function startMediaChain(tabId, items) {
  // Register every deferred item immediately. The global media scheduler runs
  // them one at a time, while storage.session preserves the visible queue if
  // the MV3 worker sleeps or the source tab closes.
  for (const item of items || []) {
    const isYtMux = item.via === 'youtube' && item.audioUrl;
    const request = selectedHlsRequest(item);
    const jobKey = isYtMux
      ? 'yt-mux:' + (item.key || item.url)
      : buildMediaJobKey(item.url, item.dashEntry, request.variantKey);
    const prev = state.hlsJobs.get(jobKey);
    if (prev && (prev.status === 'complete' || isMediaJobRunning(prev))) continue;
    startHls(tabId, jobKey, item.url, item.title, item.pageUrl || null,
      item.dashEntry != null ? item.dashEntry : null, item.dashType || null, request.audioUrl,
      isYtMux ? item : null, item.kind, request.variantUrl, request.variantKey, item.key || null);
  }
}

// ---------------------------------------------------------------------------
// Generic webRequest detection: watch response headers directly.
// Works even on pages where content-script injection is blocked.
// ---------------------------------------------------------------------------
const WATCH_TYPES = ['xmlhttprequest', 'media', 'main_frame', 'other'];

// ---------------------------------------------------------------------------
// Captured request headers (VDH's "sent_headers" idea).
// Many CDNs (X's video CDN, hotlink-protected hosts) only serve media when the
// request carries headers the page's player added itself — typically
// Authorization: Bearer, Referer, Origin. chrome.downloads.download sends
// none of those, and a bare SW fetch only carries cookies. So we watch what
// the browser actually sent and replay the relevant headers when we fetch.
// ---------------------------------------------------------------------------
const CAPTURED_HEADERS_MAX = 1000;
const capturedReqHeaders = new Map(); // itemKey(url) -> [{name, value}]

function keepableHeader(name) {
  const n = String(name || '').toLowerCase();
  return n === 'referer' || n === 'origin' || n === 'authorization' || n.indexOf('x-') === 0;
}

function onSendHeaders(details) {
  try {
    if (!details.requestHeaders || !details.requestHeaders.length) return;
    const url = details.url;
    if (!url || url.indexOf('http') !== 0) return;
    if (details.initiator && details.initiator.indexOf('chrome-extension:') === 0) return;
    const keep = details.requestHeaders.filter(function (h) { return keepableHeader(h.name); });
    if (!keep.length) return;
    const key = L.itemKey(url);
    if (!key) return;
    capturedReqHeaders.set(key, keep);
    if (capturedReqHeaders.size > CAPTURED_HEADERS_MAX) {
      const first = capturedReqHeaders.keys().next().value;
      capturedReqHeaders.delete(first);
    }
  } catch (e) { /* never break browsing */ }
}

function originOfUrl(url) {
  try {
    const u = new URL(String(url || ''));
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.origin : null;
  } catch (e) { return null; }
}

function capturedSourceOrigin(src) {
  const entries = Array.isArray(src)
    ? src.map(function (h) { return [h.name, h.value]; })
    : Object.keys(src || {}).map(function (k) { return [k, src[k]]; });
  for (const [name, value] of entries) {
    if (String(name).toLowerCase() === 'x-media-sniper-source-origin') {
      const origin = originOfUrl(value);
      if (origin) return origin;
    }
  }
  for (const [name, value] of entries) {
    if (String(name).toLowerCase() === 'origin') {
      const origin = originOfUrl(value);
      if (origin) return origin;
    }
  }
  for (const [name, value] of entries) {
    if (String(name).toLowerCase() === 'referer') {
      const origin = originOfUrl(value);
      if (origin) return origin;
    }
  }
  return null;
}

function headersFor(url, fallback, fallbackUrl) {
  // captured array first; fallback may be a captured array OR a plain object
  const cap = capturedReqHeaders.get(L.itemKey(url));
  const src = (cap && cap.length) ? cap : fallback;
  if (!src) return {};
  const targetOrigin = originOfUrl(url);
  const sourceOrigin = (cap && capturedSourceOrigin(cap)) || originOfUrl(fallbackUrl);
  const crossOrigin = !targetOrigin || !sourceOrigin || targetOrigin !== sourceOrigin;
  const out = {};
  const entries = Array.isArray(src)
    ? src.map(function (h) { return [h.name, h.value]; })
    : Object.keys(src).map(function (k) { return [k, src[k]]; });
  for (const [name, value] of entries) {
    if (!keepableHeader(name)) continue;
    const lower = String(name).toLowerCase();
    if (crossOrigin && (lower === 'referer' || lower === 'origin')) continue;
    out[name] = value;
  }
  return out;
}

function hasAuthenticatedHeaders(headers) {
  for (const name of Object.keys(headers || {})) {
    if (/^(?:referer|origin|authorization)$/i.test(name) && headers[name]) return true;
  }
  return false;
}

function enrichFromCapture(item) {
  const cap = capturedReqHeaders.get(L.itemKey(item.url));
  if (cap && cap.length) item.headers = cap.slice();
  return item;
}

// VDH "m3u8_audio_video_two_sources": pick the alternate audio rendition the
// variant points at (EXT-X-MEDIA TYPE=AUDIO). Only attach audio when the
// variant EXPLICITLY references an AUDIO group — per the HLS spec a variant
// without an AUDIO attribute carries its audio in-band, and muxing in a
// separate rendition there would drop the in-band track. Prefer DEFAULT=YES,
// else the first rendition with a URI in the referenced group.
function pickAudioUrl(parsed, variant) {
  if (!variant || !variant.audioGroup) return null;
  const candidates = (parsed.media || []).filter(function (m) {
    return m.type === 'AUDIO' && m.uri && m.groupId === variant.audioGroup;
  });
  if (!candidates.length) return null;
  for (const m of candidates) { if (m.isDefault) return m.uri; }
  return candidates[0].uri;
}

function onResponseStarted(details) {
  try {
    if (details.statusCode < 200 || details.statusCode > 299) return;
    const observedUrl = details.url;
    if (!observedUrl || observedUrl.indexOf('data:') === 0) return;
    if (observedUrl.indexOf('chrome-extension:') === 0) return;
    if (details.initiator && details.initiator.indexOf('chrome-extension:') === 0) return;
    if (details.tabId == null || details.tabId < 0) return;
    // segments are never user-facing media
    if (L.isSegmentUrl(observedUrl)) return;
    // Meta/Instagram appends bytestart+byteend to an otherwise valid signed
    // *.mp4 URL for fMP4 playback chunks. The observed response starts with
    // `moof`, not ftyp/moov, and cannot play by itself. Removing only those
    // two query parameters asks the same CDN for the complete MP4.
    const url = L.fullMediaUrlFromByteRange(observedUrl);
    // dedicated-site adapters handle their own sites; the generic detector
    // only produces noise there (VDH's yS exclusion set, same idea)
    if (L.isDedicatedSite(url) || L.isDedicatedSite(details.initiator || '')) return;
    // user blacklist: these hosts never produce items
    if (L.isBlacklisted(L.hostOf(url), settings.blacklist)) return;

    let ct = null;
    let size = 0;
    let rangeTotal = 0;
    const isFullMediaUrl = url !== observedUrl;
    if (details.responseHeaders) {
      for (const h of details.responseHeaders) {
        const name = String(h.name || '').toLowerCase();
        if (name === 'content-type') ct = h.value;
        if (name === 'content-length') size = parseInt(h.value, 10) || 0;
        if (name === 'content-range') {
          const m = String(h.value || '').match(/\/(\d+)\s*$/);
          if (m) rangeTotal = parseInt(m[1], 10) || 0;
        }
      }
    }
    // The observed response is a playback fragment. Content-Length is only
    // the fragment size; use the advertised full-object total when present,
    // otherwise keep the full URL's size unknown.
    if (isFullMediaUrl) size = rangeTotal;
    // an html response is never media (anti-hotlink redirects serve html)
    if (ct && String(ct).toLowerCase().indexOf('text/html') === 0) return;

    const kind = L.kindFromContentType(ct, url);
    // A declared media type is authoritative. Path heuristics are only a
    // fallback for extensionless responses, otherwise /hls/*.mp4 and DASH
    // manifests carrying an /hls/ path get routed to the wrong pipeline.
    const isHls = kind === 'hls' || (!kind && L.looksLikeHlsUrl(url));

    if (isHls) {
      // validate playlist text (SW fetch carries cookies thanks to host perms,
      // plus any headers the player itself sent for this URL)
      fetch(url, { credentials: 'include', headers: headersFor(url) }).then(function (res) {
        if (!res.ok) return null;
        return boundedResponseText(res, L.MAX_HLS_PLAYLIST_CHARS);
      }).then(function (text) {
        if (!text || text.indexOf('#EXTM3U') !== 0) return;
        if (L.isSubtitlePlaylist(text)) return;
        const parsed = L.parseM3u8(text, url);
        if (parsed.truncated) return;
        const pageUrl = details.initiator || details.url;
        const baseTitle = pageTitle(details.tabId);
        if (parsed.type === 'master' && parsed.variants.length) {
          // A master playlist is one logical item. Keep every rendition
          // nested on it so the popup can choose a quality without creating
          // duplicate cards or Save All jobs.
          addItems(details.tabId, [L.groupHlsItem(url, parsed, {
            contentType: ct || null,
            size: 0,
            via: 'webrequest',
            pageUrl: pageUrl,
            title: baseTitle,
            duration: 0,
          })]);
        } else {
          // audio-only HLS (X Spaces replays: .aac ADTS chunks) is its own
          // kind so the popup can label it 音声 and the save path picks .aac
          const audioOnly = L.isAudioOnlyPlaylist(parsed);
          addItems(details.tabId, [{
            url: url, kind: audioOnly ? 'hls-audio' : 'hls',
            contentType: ct || null, size: 0,
            via: 'webrequest', pageUrl: pageUrl, title: baseTitle,
            duration: parsed.type === 'media' ? L.playlistDuration(text) : 0,
          }]);
        }
      }).catch(function () { /* unreachable playlist: skip silently */ });
      return;
    }

    const isDash = kind === 'dash' || (!kind && /\.mpd(\?|$)/i.test(url));
    if (isDash) {
      // Enumerate the MPD's tracks (video renditions + audio) as
      // separate items. ffmpeg downloads one track per job — concurrent
      // adaptation-set fetches deadlock jsfetch, so no combined v+a here.
      fetch(url, { credentials: 'include', headers: headersFor(url) }).then(function (res) {
        if (!res.ok) return null;
        return boundedResponseText(res, L.MAX_HLS_PLAYLIST_CHARS);
      }).then(function (mpd) {
        if (typeof mpd === 'string' && mpd.length > L.MAX_HLS_PLAYLIST_CHARS) return;
        const tracks = L.parseMpdTracks(mpd || '');
        const pageUrl = details.initiator || details.url;
        const baseTitle = pageTitle(details.tabId);
        if (!tracks.length) {
          // unparseable manifest: one plain item, ffmpeg will try its best
          addItems(details.tabId, [{
            url: url, kind: 'dash', contentType: ct || null, size: 0,
            via: 'webrequest', pageUrl: pageUrl, title: baseTitle, dashEntry: -1,
          }]);
          return;
        }
        const metas = tracks.map(function (t) {
          const label = t.type === 'video'
            ? (t.resolution ? ' [' + t.resolution + ']' : ' [' + Math.round(t.bandwidth / 1000) + 'k]')
            : ' [音声]';
          return {
            url: url, kind: 'dash', contentType: ct || null, size: 0,
            via: 'webrequest', pageUrl: pageUrl,
            title: (baseTitle || 'video') + label,
            dashEntry: t.entry, dashType: t.type,
          };
        });
        addItems(details.tabId, metas);
      }).catch(function () { /* unreachable manifest: skip silently */ });
      return;
    }

    if (kind === 'video' || kind === 'audio') {
      // VDH rule: direct media below the configured threshold is noise
      if (size > 0 && size < effectiveMinSize()) return;
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

function findItemForQuality(tabId, itemKey, itemUrl) {
  const list = state.itemsByTab.get(tabId) || [];
  return list.find(function (item) {
    return (itemKey && item.key === itemKey) || (itemUrl && item.url === itemUrl);
  }) || null;
}

function applyQualitySelection(tabId, itemKey, itemUrl, variantKey) {
  const item = findItemForQuality(tabId, itemKey, itemUrl);
  if (!item || !item.variants || !item.variants.length) return null;
  const variant = L.selectHlsVariant(item, variantKey);
  if (!variant) return null;
  item.selectedVariantKey = L.hlsVariantKey(variant);
  persistItems();
  return variant;
}

function applyQualitySelections(tabId, selections) {
  if (!selections || typeof selections !== 'object') return;
  const list = state.itemsByTab.get(tabId) || [];
  let changed = false;
  for (const item of list) {
    if (!item || !item.variants || !item.variants.length) continue;
    const wanted = selections[item.key] || selections[item.url];
    const variant = L.selectHlsVariant(item, wanted);
    if (variant && item.selectedVariantKey !== L.hlsVariantKey(variant)) {
      item.selectedVariantKey = L.hlsVariantKey(variant);
      changed = true;
    }
  }
  if (changed) persistItems();
}

if (chrome.webRequest && chrome.webRequest.onResponseStarted) {
  chrome.webRequest.onResponseStarted.addListener(onResponseStarted, { urls: ['<all_urls>'], types: WATCH_TYPES }, ['responseHeaders']);
}
if (chrome.webRequest && chrome.webRequest.onSendHeaders) {
  // VDH "sent_headers": capture Authorization/Referer/Origin the player sent,
  // replay them when we fetch the same URL ourselves.
  chrome.webRequest.onSendHeaders.addListener(onSendHeaders, { urls: ['<all_urls>'], types: WATCH_TYPES }, ['requestHeaders']);
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------
// An offscreen media job sends periodic port messages while it owns a long
// ffmpeg/fetch operation. Receiving them keeps MV3 from suspending this worker
// after the popup closes or the user switches tabs.
if (chrome.runtime.onConnect && typeof chrome.runtime.onConnect.addListener === 'function') {
  chrome.runtime.onConnect.addListener(function (port) {
    if (!port || port.name !== 'ms-media-job' || !port.onMessage) return;
    port.onMessage.addListener(function () { /* heartbeat only */ });
  });
}

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
      // wait for restore so a just-woke SW never closes the race by merging
      // into a not-yet-restored map
      restorePromise.then(function () {
        const r = addItems(tabId, msg.items);
        sendResponse(r);
      });
      return true;
    }
    case 'ms-get-items': {
      restorePromise.then(function () {
        const items = state.itemsByTab.get(tabId) || [];
        const activeJobs = [];
        state.hlsJobs.forEach(function (job, jobKey) {
          if (job.tabId !== tabId || !isMediaJobRunning(job)) return;
          activeJobs.push({
            jobKey: jobKey, status: job.status, sourceUrl: job.sourceUrl || null,
            itemKey: job.itemKey || null, live: !!job.live,
          });
        });
        const activeDownloads = state.queue.filter(function (entry) {
          return entry.item && entry.item.tabId === tabId && entry.status !== 'queued' &&
            entry.status !== 'complete' && entry.status !== 'failed';
        }).map(function (entry) {
          return {
            id: entry.id, status: entry.status, itemKey: entry.item.key || null,
            sourceUrl: entry.item.url || null,
          };
        });
        sendResponse({ items: L.sortItems(items), activeJobs: activeJobs, activeDownloads: activeDownloads });
      });
      return true;
    }
    case 'ms-get-jobs': {
      const runningEntries = state.queue.filter(function (entry) {
        return entry && entry.status !== 'complete' && entry.status !== 'failed';
      });
      Promise.all(runningEntries.map(refreshDownloadProgress)).then(function () {
        sendResponse({ jobs: publicJobs() });
      });
      return true;
    }
    case 'ms-get-settings': {
      settingsReady.then(function () {
        sendResponse(Object.assign({}, settings));
      });
      return true;
    }
    case 'ms-set-settings': {
      settingsReady.then(function () {
        const inc = msg.settings || {};
        if ('rootFolder' in inc) settings.rootFolder = L.sanitizeRootFolder(inc.rootFolder);
        if ('minSizeKb' in inc) {
          const n = parseInt(inc.minSizeKb, 10);
          settings.minSizeKb = (n > 0) ? n : DEFAULT_SETTINGS.minSizeKb;
        }
        if ('blacklist' in inc) settings.blacklist = String(inc.blacklist || '');
        chrome.storage.local.set({
          rootFolder: settings.rootFolder,
          minSizeKb: settings.minSizeKb,
          blacklist: settings.blacklist,
        }).catch(function () {});
        sendResponse({ saved: true, settings: Object.assign({}, settings) });
      });
      return true;
    }
    case 'ms-select-quality': {
      restorePromise.then(function () {
        const variant = applyQualitySelection(tabId, msg.itemKey || null, msg.itemUrl || null, msg.variantKey);
        sendResponse(variant ? {
          ok: true,
          variantKey: L.hlsVariantKey(variant),
        } : { ok: false, error: 'quality not found' });
      });
      return true;
    }
    case 'ms-download-all': {
      restorePromise.then(function () {
        applyQualitySelections(tabId, msg.selections);
        const items = L.sortItems(state.itemsByTab.get(tabId) || []);
        const existingSet = new Set();
        try {
          chrome.downloads.search({ limit: 1000 }, function (found) {
            void chrome.runtime.lastError;
            (found || []).forEach(function (d) { if (d.filename) existingSet.add(d.filename); });
            respondAll(items, existingSet);
          });
        } catch (e) {
          respondAll(items, existingSet); // search unavailable: no skip
        }
      });
      const respondAll = function (items, existingSet) {
        const root = settings.rootFolder;
        let queued = 0;
        let skipped = 0;
        const deferredItems = [];
        for (const it of items) {
          if (it.kind === 'hls' || it.kind === 'hls-audio' || it.kind === 'dash' ||
              (it.via === 'youtube' && it.audioUrl)) { deferredItems.push(it); continue; }
          const fname = L.filenameForItem(it, root);
          // skip-existing: compare against completed browser download history.
          // The final on-disk name may differ from our suggestion (uniquify's
          // " (n)" suffix), so accept any name with the same base+ext.
          const m = /^(.*\/)?(.*)$/.exec(fname);
          const base = m[2] || fname;
          const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp('^(.*\\/)?' + esc.replace(/ \\(\\d+)\\./, ' ($1).') + '$');
          let exists = false;
          existingSet.forEach(function (f) {
            const nm = f.split('/').pop();
            if (re.test(nm)) exists = true;
          });
          if (exists) { skipped++; continue; }
          enqueue(it, fname);
          queued++;
        }
        if (deferredItems.length) startMediaChain(tabId, deferredItems);
        sendResponse({ queued: queued, skipped: skipped, deferred: deferredItems.length });
      };
      return true;
    }
    case 'ms-yt-mux-download': {
      const item = normalizeItem(msg.item, tabId);
      if (!item || !msg.item.audioUrl) { sendResponse({ error: 'muxには映像と音声のURLが必要です' }); return false; }
      enrichFromCapture(item);
      item.audioUrl = msg.item.audioUrl;
      const jobKey = 'yt-mux:' + (item.key || item.url);
      const existing = state.hlsJobs.get(jobKey);
      if (isMediaJobRunning(existing)) {
        sendResponse({ alreadyRunning: true, jobKey: jobKey });
        return false;
      }
      state.hlsJobs.set(jobKey, {
        status: 'queued', tabId: tabId, done: 0, total: 2, error: null, live: false,
        title: item.title || null, pageUrl: item.pageUrl || null, blobUrl: null, size: 0,
        seconds: 0, bytes: 0, startedAt: Date.now(), mode: 'mux', ext: 'mp4',
        sourceUrl: item.url, itemKey: item.key || null,
      });
      persistActiveJobs();
      scheduleMediaExecution(jobKey, function () { return runYtMuxJob(jobKey, item); }).catch(function (err) {
        const j = state.hlsJobs.get(jobKey);
        if (j) { j.status = 'failed'; j.error = String(err && err.message || err); persistActiveJobs(); }
      });
      sendResponse({ started: true, jobKey: jobKey });
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
      enrichFromCapture(item);
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
      const jobKey = msg.jobKey || buildMediaJobKey(msg.url, msg.dashEntry, msg.variantKey || null);
      const stableExisting = runningMediaJobByItemKey(msg.itemKey || null);
      if (stableExisting) {
        sendResponse({ alreadyRunning: true, jobKey: stableExisting.key });
        return false;
      }
      const existing = state.hlsJobs.get(jobKey);
      if (isMediaJobRunning(existing)) {
        sendResponse({ alreadyRunning: true, jobKey: jobKey });
        return false;
      }
      startHls(tabId, jobKey, msg.url, msg.title, msg.pageUrl, msg.dashEntry != null ? msg.dashEntry : null,
        msg.dashType || null, msg.audioUrl || null, null, msg.kind || null,
        msg.variantUrl || null, msg.variantKey || null, msg.itemKey || null);
      // Acknowledge before playlist fetch/ffmpeg completes. The popup is an
      // ephemeral view and may close on tab switch; job ownership stays here.
      sendResponse({ started: true, jobKey: jobKey });
      return false;
    }
    case 'ms-hls-stop': {
      stopLiveRecording(msg.url, msg.jobKey || null).then(sendResponse);
      return true;
    }
    case 'ms-hls-status': {
      // jobKey form is used by yt-mux jobs (their key is not the media URL)
      const jobKey = msg.jobKey || buildMediaJobKey(msg.url, msg.dashEntry, msg.variantKey || null);
      const job = state.hlsJobs.get(jobKey) || state.hlsJobs.get(msg.url);
      const linkedEntry = job && job.queueEntryId
        ? state.queue.find(function (entry) { return entry.id === job.queueEntryId; })
        : null;
      const progressReady = linkedEntry ? refreshDownloadProgress(linkedEntry) : Promise.resolve();
      progressReady.then(function () { sendResponse(job ? {
        status: job.status, done: job.done, total: job.total, error: job.error,
        live: job.live, filename: job.filename || null, mode: job.mode,
        seconds: job.seconds || 0, bytes: job.bytes || 0, ext: job.ext || null,
        fetches: job.fetches || 0, fetchedBytes: job.fetchedBytes || 0,
        elapsedSeconds: job.startedAt ? Math.max(0, Math.floor((Date.now() - job.startedAt) / 1000)) : 0,
        receivedBytes: job.receivedBytes || 0, totalBytes: job.totalBytes || 0,
      } : null); });
      return true;
    }
    case 'ms-offscreen-progress': {
      const job = state.hlsJobs.get(msg.jobId);
      if (job) {
        job.seconds = msg.seconds || 0;
        job.bytes = msg.bytes || 0;
        job.fetches = msg.fetches || 0;
        job.fetchedBytes = msg.fetchedBytes || 0;
      }
      return false;
    }
    case 'ms-hls-progress': {
      // Structured-clone-safe counters only; media bytes never cross messaging.
      const job = state.hlsJobs.get(msg.playlistUrl);
      if (job) {
        job.done = msg.done || 0;
        if (msg.total) job.total = msg.total;
        if (msg.bytes != null) job.bytes = Number(msg.bytes) || 0;
      }
      return false;
    }
    case 'ms-queue-status': {
      Promise.all(state.queue.map(refreshDownloadProgress)).then(function () {
        sendResponse({ queue: state.queue.map(publicQueueEntry) });
      });
      return true;
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
// restoreItems() already ran at boot (restorePromise above).
restorePromise.then(recoverRestoredWork).catch(function () {});
