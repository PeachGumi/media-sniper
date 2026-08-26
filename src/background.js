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
  // never write a partial map over storage before restore has merged it
  return restorePromise.then(function () {
    const obj = {};
    state.itemsByTab.forEach(function (items, tabId) { obj[tabId] = items; });
    return chrome.storage.session.set({ msItems: obj });
  });
}

function restoreItems() {
  return chrome.storage.session.get('msItems').then(function (r) {
    const obj = r.msItems || {};
    Object.keys(obj).forEach(function (tabId) {
      const t = Number(tabId);
      // merge, never clobber: items detected during boot win
      if (!state.itemsByTab.has(t)) state.itemsByTab.set(t, obj[tabId]);
    });
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
  if (url.indexOf('data:') === 0 || url.indexOf('chrome-extension:') === 0) return null;
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
    dashEntry: raw.dashEntry != null ? raw.dashEntry : null,
    dashType: raw.dashType || null,
    audioUrl: raw.audioUrl || null, // separate-track audio playlist (HLS two-source)
    tabId: tabId,
  };
  return item;
}

function addItems(tabId, rawItems) {
  let items = state.itemsByTab.get(tabId) || [];
  const minSize = effectiveMinSize();
  const incoming = (rawItems || []).map(function (r) { return normalizeItem(r, tabId); }).filter(Boolean).filter(function (it) {
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
function enqueue(item, forcedFilename) {
  const filename = forcedFilename || L.filenameForItem(item, settings.rootFolder);
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
  if (url.indexOf('blob:') === 0) { startDirect(entry); return; }
  // Auth-protected CDNs (X/Twitter's video CDN above all): chrome.downloads
  // cannot send custom headers, and those CDNs answer a headerless request
  // with 200 + a tiny error body — a "successful" download that is junk.
  // If the player itself needed Authorization for this URL, skip the direct
  // attempt and fetch through the offscreen document with the header.
  const hdrs = headersFor(url, entry.item.headers);
  if (hdrs && (hdrs.Authorization || hdrs.authorization)) {
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

function startDirect(entry) {
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
    if (entry.hlsUrl) {
      const j = state.hlsJobs.get(entry.hlsUrl);
      if (j) j.status = 'complete';
      advanceChainByJob(entry.hlsUrl);
    }
    pump();
  } else if (s === 'interrupted') {
    const errCode = (delta.error && delta.error.current) || 'interrupted';
    // CDN refused the bare download (403 / auth / hotlink protection):
    // retry through a SW fetch that carries the browser's cookies plus the
    // headers we captured from the player's own requests (VDH sent_headers).
    // SERVER_BAD_CONTENT: server refused the body (googlevideo answers its
    // 403 page as text/plain → Brave surfaces exactly this code).
    const retriable = /FORBIDDEN|UNAUTHORIZED|ACCESS_DENIED|NETWORK_FAILED|SERVER_BAD_CONTENT|SERVER_FORBIDDEN/i.test(errCode);
    if (retriable && !entry.triedFallback && entry.item && entry.item.url.indexOf('blob:') !== 0) {
      entry.triedFallback = true;
      state.downloadToItem.delete(delta.id);
      fallbackDownload(entry);
      return; // keep the queue slot; fallback re-registers or frees it
    }
    entry.status = 'failed';
    entry.error = errCode;
    state.downloadToItem.delete(delta.id);
    state.active.delete(entry.id);
    if (entry.hlsUrl) {
      const j = state.hlsJobs.get(entry.hlsUrl);
      if (j) { j.status = 'failed'; j.error = errCode; }
      advanceChainByJob(entry.hlsUrl);
    }
    pump();
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
  // captured player headers first (webRequest path), item.headers second
  // (popup/adapter path)
  const headers = headersFor(item.url, item.headers);
  // offscreen fetches the body itself (bytes never cross SW messaging)
  const mime = item.contentType || 'video/mp4';
  makeBlobUrlFromRemote(item.url, mime, headers).then(function (made) {
    return chrome.downloads.download({
      url: made.url,
      filename: entry.filename,
      conflictAction: 'uniquify',
      saveAs: false,
    });
  }).then(function (downloadId) {
    entry.downloadId = downloadId;
    state.downloadToItem.set(downloadId, entry);
  }).catch(function (err) {
    entry.status = 'failed';
    entry.error = String(err && err.message || err);
    state.active.delete(entry.id);
    if (entry.hlsUrl) {
      const j = state.hlsJobs.get(entry.hlsUrl);
      if (j) { j.status = 'failed'; j.error = entry.error; }
    }
    pump();
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
    headers: req.headers || {},
  });
  if (!resp || !resp.url) throw new Error('ffmpeg job failed' + (resp && resp.error ? ': ' + resp.error : ''));
  return { url: resp.url, size: resp.size || 0, partial: !!resp.partial };
}

function swFetchText(url, headers) {
  return fetch(url, { credentials: 'include', headers: headers || {} }).then(function (res) {
    if (!res.ok) throw new Error('http ' + res.status);
    return res.text();
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
  const hdrs = headersFor(playlistUrl);

  job.status = 'fetching';
  const masterText = await swFetchText(playlistUrl, hdrs);
  const masterParsed = L.parseM3u8(masterText, playlistUrl);

  let mediaUrl = playlistUrl;
  let mediaText = masterText;
  let variant = null;

  if (masterParsed.type === 'master') {
    variant = L.pickBestVariant(masterParsed.variants);
    if (!variant) throw new Error('no variants in master playlist');
    mediaUrl = withToken(variant.url, variant.token);
    job.status = 'fetching';
    mediaText = await swFetchText(mediaUrl, headersFor(mediaUrl, hdrs));
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
    const segHeaders = headersFor(media.segments[0].url, hdrs);
    const made = await offscreenHlsBuild({
      playlistUrl: playlistUrl,
      segments: media.segments.map(function (s) { return s.url; }),
      initUrl: media.initUrl || null,
      headers: segHeaders,
      mime: 'audio/aac',
    }, job);
    return finishMediaJob(playlistUrl, made, 'aac', 'audio');
  }

  // Path 2: ffmpeg (VDH architecture). Handles everything the hand-rolled
  // combiner could not: AES-128 keys, fMP4/BYTERANGE, TS->MP4 remux.
  job.mode = 'ffmpeg';
  job.ext = audioOnly ? 'aac' : 'mp4';
  // Separate-track audio (VDH "m3u8_audio_video_two_sources"): the variant's
  // video playlist has no in-band audio, so ffmpeg gets a second -i for the
  // audio playlist and maps one stream from each. VOD only — live two-source
  // muxing is not worth the complexity here.
  const twoSource = !audioOnly && !media.live && job.audioUrl;
  const audioHeaders = twoSource ? Object.assign({}, headersFor(mediaUrl, hdrs), headersFor(job.audioUrl, hdrs)) : null;
  const req = {
    jobId: playlistUrl,
    kind: 'hls',
    url: mediaUrl,
    audioUrl: twoSource ? job.audioUrl : null,
    ext: job.ext,
    live: !!media.live,
    headers: twoSource ? audioHeaders : headersFor(mediaUrl, hdrs),
  };

  if (media.live) {
    // Live recording: ffmpeg runs until the user presses Stop. Fragmented
    // MP4 keeps the partial file playable. The popup gets {recording:true}
    // immediately and polls ms-hls-status; the ffmpeg job keeps running in
    // the offscreen document, and when it ends the blob is queued.
    job.status = 'recording';
    job.live = true;
    job.startedAt = Date.now();
    offscreenFfmpegRun(req).then(function (made) {
      const secs = Math.max(1, Math.round((Date.now() - job.startedAt) / 1000));
      job.title = (job.title || 'stream') + ' [' + fmtClock(secs) + ']';
      return finishMediaJob(playlistUrl, made, job.ext, audioOnly ? 'audio' : 'video');
    }).catch(function (err) {
      job.status = 'failed';
      job.error = String(err && err.message || err);
    });
    return { recording: true };
  }

  job.status = 'combining';
  const made = await offscreenFfmpegRun(req);
  return finishMediaJob(playlistUrl, made, job.ext, audioOnly ? 'audio' : 'video');
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
  const entry = enqueue(item);
  // link the queue entry back to the job so completion/failure of the blob
  // download updates the job state the popup is polling
  entry.hlsUrl = playlistUrl;
  job.filename = entry.filename;
  return { queued: true };
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
  const hdrs = headersFor(url);
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
  const hdrs = headersFor(item.url, item.headers);

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
  const aResp = await makeBlobUrlFromRemote(audioUrl, 'audio/mp4', headersFor(audioUrl, hdrs));
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

function startHls(tabId, jobKey, url, title, pageUrl, dashEntry, dashType, audioUrl, itemRef) {
  msgItemRef = itemRef || null;
  const existing = state.hlsJobs.get(jobKey);
  if (existing && (existing.status === 'fetching' || existing.status === 'combining' || existing.status === 'recording')) {
    return Promise.resolve({ alreadyRunning: true });
  }
  state.hlsJobs.set(jobKey, {
    status: 'fetching', tabId: tabId, done: 0, total: 0, error: null, live: false,
    title: title || null, pageUrl: pageUrl || null, blobUrl: null, size: 0,
    seconds: 0, bytes: 0, startedAt: 0, mode: null, ext: null,
    dashEntry: dashEntry != null ? dashEntry : null,
    dashType: dashType || null,
    audioUrl: audioUrl || null,
  });
  let runner = null;
  if (url.indexOf('yt-mux:') === 0 && msgItemRef) {
    runner = function () { return runYtMuxJob(jobKey, msgItemRef); };
  } else {
    runner = /\.mpd(\?|$)/i.test(url) ? runDashJob : runHlsJob;
  }
  return runner(jobKey, url).catch(function (err) {
    const j = state.hlsJobs.get(jobKey);
    if (j) { j.status = 'failed'; j.error = String(err && err.message || err); }
    return { error: j && j.error };
  });
}

// stop a live recording (ffmpeg abort; fragmented MP4 stays valid)
function stopLiveRecording(url) {
  const job = state.hlsJobs.get(url);
  if (!job || job.status !== 'recording') return Promise.resolve({ ok: false });
  return ensureOffscreen().then(function () {
    return chrome.runtime.sendMessage({ type: 'ms-offscreen-ffmpeg-abort', jobId: url });
  }).then(function (r) {
    return { ok: !!(r && r.ok) };
  }).catch(function () { return { ok: false }; });
}

// ---------------------------------------------------------------------------
// Media chain (download-all): HLS/DASH jobs run ONE at a time — the offscreen
// document holds a single ffmpeg instance, so parallel jobs would just queue
// on the busy-guard anyway. Direct items are already in the download queue.
// ---------------------------------------------------------------------------
let msgItemRef = null;
const mediaChains = new Map(); // tabId -> {items, idx, running, current, tabId}

function startMediaChain(tabId, items) {
  mediaChains.set(tabId, { items: items, idx: 0, running: false, current: null, tabId: tabId });
  pumpMediaChain(tabId);
}

function pumpMediaChain(tabId) {
  const chain = mediaChains.get(tabId);
  if (!chain || chain.running) return;
  while (chain.idx < chain.items.length) {
    const item = chain.items[chain.idx];
    const jobKey = item.url + (item.dashEntry != null && item.dashEntry >= 0 ? '#dash-entry=' + item.dashEntry : '');
    const prev = state.hlsJobs.get(jobKey);
    if (prev && prev.status === 'complete') { chain.idx++; continue; }
    if (prev && (prev.status === 'fetching' || prev.status === 'combining' || prev.status === 'downloading' || prev.status === 'recording')) {
      // already in flight (user clicked it individually, or a previous chain
      // pass started it): park on it — advanceChainByJob fires on completion
      chain.current = jobKey;
      chain.running = true;
      return;
    }
    chain.running = true;
    chain.current = jobKey;
    startHls(tabId, jobKey, item.url, item.title, item.pageUrl || null,
      item.dashEntry != null ? item.dashEntry : null, item.dashType || null, item.audioUrl || null)
      .then(function (resp) {
        // {queued:true}: the blob DOWNLOAD is now in flight. The chain must
        // NOT advance here — the runner resolving only means "queued". The
        // download's onChanged (complete/interrupted) calls
        // advanceChainByJob, which flips running=false, idx++ and pumps.
        // Keep chain.running=true so nothing else re-pumps this slot.
        if (resp && resp.queued) return;
        // live recording / error / alreadyRunning: this item will never
        // produce an onChanged of its own — skip it and move on.
        chain.running = false;
        chain.idx++;
        pumpMediaChain(tabId);
      })
      .catch(function () {
        chain.running = false;
        chain.idx++;
        pumpMediaChain(tabId);
      });
    return;
  }
  mediaChains.delete(tabId);
}

function advanceChainByJob(jobKey) {
  mediaChains.forEach(function (chain) {
    if (chain.running && chain.current === jobKey) {
      chain.running = false;
      chain.idx++;
      pumpMediaChain(chain.tabId);
    }
  });
}

// ---------------------------------------------------------------------------
// webRequest detection (VDH-style): watch response headers directly.
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

function headersFor(url, fallback) {
  // captured array first; fallback may be a captured array OR a plain object
  const cap = capturedReqHeaders.get(L.itemKey(url));
  const src = (cap && cap.length) ? cap : fallback;
  if (!src) return {};
  const out = {};
  if (Array.isArray(src)) {
    for (const h of src) { if (keepableHeader(h.name)) out[h.name] = h.value; }
  } else {
    for (const k of Object.keys(src)) { if (keepableHeader(k)) out[k] = src[k]; }
  }
  return out;
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
    // user blacklist: these hosts never produce items
    if (L.isBlacklisted(L.hostOf(url), settings.blacklist)) return;

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
      // validate playlist text (SW fetch carries cookies thanks to host perms,
      // plus any headers the player itself sent for this URL)
      fetch(url, { credentials: 'include', headers: headersFor(url) }).then(function (res) {
        if (!res.ok) return null;
        return res.text();
      }).then(function (text) {
        if (!text || text.indexOf('#EXTM3U') !== 0) return;
        if (L.isSubtitlePlaylist(text)) return;
        const parsed = L.parseM3u8(text, url);
        const pageUrl = details.initiator || details.url;
        const baseTitle = pageTitle(details.tabId);
        if (parsed.type === 'master' && parsed.variants.length) {
          // VDH-style: surface each variant as its own item so the user picks
          // a resolution, instead of one opaque "HLS" entry. Each variant URL
          // is a playable media playlist (tokens from the master are kept).
          const metas = parsed.variants.map(function (v) {
            const vurl = withToken(v.url, v.token);
            const label = v.resolution ? ' [' + v.resolution + ']' : '';
            return {
              url: vurl, kind: 'hls', contentType: ct || null, size: 0,
              via: 'webrequest', pageUrl: pageUrl,
              title: (baseTitle || 'video') + label, duration: 0,
              audioUrl: (function () { const a = pickAudioUrl(parsed, v); return a ? withToken(a, v.token) : null; })(),
            };
          });
          addItems(details.tabId, metas);
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

    const isDash = (ct && /dash\+xml/i.test(ct)) || /\.mpd(\?|$)/i.test(url);
    if (isDash) {
      // VDH-style: enumerate the mpd's tracks (video renditions + audio) as
      // separate items. ffmpeg downloads one track per job — concurrent
      // adaptation-set fetches deadlock jsfetch, so no combined v+a here.
      fetch(url, { credentials: 'include', headers: headersFor(url) }).then(function (res) {
        if (!res.ok) return null;
        return res.text();
      }).then(function (mpd) {
        const tracks = L.parseMpdTracks(mpd);
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
        sendResponse({ items: L.sortItems(items) });
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
    case 'ms-download-all': {
      restorePromise.then(function () {
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
          if (it.kind === 'hls' || it.kind === 'hls-audio' || it.kind === 'dash') { deferredItems.push(it); continue; }
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
      if (existing && (existing.status === 'fetching' || existing.status === 'combining')) {
        sendResponse({ alreadyRunning: true, jobKey: jobKey });
        return false;
      }
      state.hlsJobs.set(jobKey, {
        status: 'fetching', tabId: tabId, done: 0, total: 2, error: null, live: false,
        title: item.title || null, pageUrl: item.pageUrl || null, blobUrl: null, size: 0,
        seconds: 0, bytes: 0, startedAt: Date.now(), mode: 'mux', ext: 'mp4',
      });
      runYtMuxJob(jobKey, item).catch(function (err) {
        const j = state.hlsJobs.get(jobKey);
        if (j) { j.status = 'failed'; j.error = String(err && err.message || err); }
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
      const jobKey = msg.url + (msg.dashEntry != null && msg.dashEntry >= 0 ? '#dash-entry=' + msg.dashEntry : '');
      startHls(tabId, jobKey, msg.url, msg.title, msg.pageUrl, msg.dashEntry != null ? msg.dashEntry : null, msg.dashType || null, msg.audioUrl || null).then(sendResponse);
      return true;
    }
    case 'ms-hls-stop': {
      stopLiveRecording(msg.url).then(sendResponse);
      return true;
    }
    case 'ms-hls-status': {
      // jobKey form is used by yt-mux jobs (their key is not the media URL)
      const jobKey = msg.jobKey || (msg.url + (msg.dashEntry != null && msg.dashEntry >= 0 ? '#dash-entry=' + msg.dashEntry : ''));
      const job = state.hlsJobs.get(jobKey) || state.hlsJobs.get(msg.url);
      sendResponse(job ? {
        status: job.status, done: job.done, total: job.total, error: job.error,
        live: job.live, filename: job.filename || null, mode: job.mode,
        seconds: job.seconds || 0, bytes: job.bytes || 0, ext: job.ext || null,
      } : null);
      return false;
    }
    case 'ms-offscreen-progress': {
      const job = state.hlsJobs.get(msg.jobId);
      if (job) { job.seconds = msg.seconds || 0; job.bytes = msg.bytes || 0; }
      return false;
    }
    case 'ms-hls-progress': {
      // counters only (structured-clone safe): offscreen never sends bytes
      const job = state.hlsJobs.get(msg.playlistUrl);
      if (job) { job.done = msg.done || 0; if (msg.total) job.total = msg.total; }
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
// restoreItems() already ran at boot (restorePromise above).
