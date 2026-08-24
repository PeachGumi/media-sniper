'use strict';

const $ = (s) => document.querySelector(s);
const t = (key, subs) => MediaSniperI18n.t(key, subs);

let tabId = null;
let pageUrl = null;
let items = [];
const hlsTimers = new Map();

function L() { return globalThis.MediaSniperLogic; }

function setStatus(text, isErr) {
  const el = $('#status');
  el.textContent = text || '';
  el.className = isErr ? 'err' : '';
}

function shortUrl(u) {
  try {
    const x = new URL(u);
    const p = x.pathname.length > 34 ? x.pathname.slice(0, 34) + '…' : x.pathname;
    return x.hostname.replace(/^www\./, '') + p;
  } catch (e) { return u; }
}

function formatBytes(n) { return L().formatBytes(n); }

function fmtDuration(sec) {
  const s = Math.round(sec);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? m + 'm' + r + 's' : m + 'm';
  const h = Math.floor(m / 60);
  return h + 'h' + (m % 60) + 'm';
}

function labelFor(item) {
  switch (item.kind) {
    case 'video': return t('video');
    case 'hls': return 'HLS';
    case 'hls-audio': return t('audioHls');
    case 'audio': return t('audio');
    case 'dash': return 'DASH';
    case 'ts': return 'TS';
    default: return item.kind || '?';
  }
}

function resetSaveButton(btn) {
  btn.classList.remove('busy');
  btn.textContent = t('save');
}

function render() {
  const list = $('#list');
  list.textContent = '';
  $('#count').textContent = items.length ? t('detectedCount', [String(items.length)]) : '';
  if (!items.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = t('emptyMedia');
    list.appendChild(d);
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'item';
    row.dataset.key = item.key;

    const badge = document.createElement('span');
    badge.className = 'badge ' + item.kind;
    badge.textContent = labelFor(item);

    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = item.title || shortUrl(item.url);
    name.title = item.url;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const bits = [];
    if (item.size) bits.push(formatBytes(item.size));
    if (item.duration) bits.push(fmtDuration(item.duration));
    if (item.via) bits.push(item.via);
    meta.textContent = bits.join(' · ') || item.contentType || '';
    info.appendChild(name);
    info.appendChild(meta);

    const dl = document.createElement('button');
    dl.className = 'dl';
    dl.textContent = t('save');
    dl.addEventListener('click', () => save(item, dl));

    const copy = document.createElement('button');
    copy.textContent = 'URL';
    copy.title = t('copyUrl');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(item.url);
        copy.textContent = '✓';
        setTimeout(() => { copy.textContent = 'URL'; }, 900);
      } catch (e) {
        setStatus(t('copyFailed'), true);
      }
    });

    row.appendChild(badge);
    row.appendChild(info);
    row.appendChild(copy);
    row.appendChild(dl);
    list.appendChild(row);
  }
}

function save(item, btn) {
  if (btn.dataset.recording === '1') {
    chrome.runtime.sendMessage({ type: 'ms-hls-stop', url: item.url }, (resp) => {
      if (chrome.runtime.lastError || (resp && resp.ok === false)) {
        setStatus(t('stopFailed'), true);
        return;
      }
      btn.textContent = t('stopping');
      setStatus(t('stoppingRecording'));
    });
    return;
  }

  btn.classList.add('busy');
  btn.textContent = '…';

  if (item.kind === 'hls' || item.kind === 'hls-audio' || item.kind === 'dash') {
    chrome.runtime.sendMessage(
      {
        type: 'ms-hls-download', url: item.url, tabId: tabId, title: item.title, pageUrl: pageUrl,
        dashEntry: item.dashEntry != null ? item.dashEntry : null, dashType: item.dashType || null,
        audioUrl: item.audioUrl || null,
      },
      (resp) => {
        if (chrome.runtime.lastError) {
          setStatus(t('errorPrefix', [chrome.runtime.lastError.message]), true);
          resetSaveButton(btn);
          return;
        }
        if (resp && resp.error) {
          setStatus(t('failedPrefix', [String(resp.error)]), true);
          resetSaveButton(btn);
          return;
        }
        if (resp && resp.alreadyRunning) {
          setStatus(t('alreadyRunning'));
          resetSaveButton(btn);
          return;
        }
        if (resp && resp.recording) {
          setStatus(t('recordingStarted'));
          btn.textContent = t('recording');
          pollHls(item, btn);
          return;
        }
        setStatus(item.kind === 'dash' ? t('dashFetching') : t('hlsFetching'));
        btn.textContent = t('fetching');
        pollHls(item, btn);
      }
    );
    return;
  }

  if (item.via === 'youtube' && item.audioUrl) {
    chrome.runtime.sendMessage({ type: 'ms-yt-mux-download', item: item, tabId: tabId }, (resp) => {
      if (chrome.runtime.lastError) {
        setStatus(t('errorPrefix', [chrome.runtime.lastError.message]), true);
        resetSaveButton(btn);
        return;
      }
      if (resp && resp.error) {
        setStatus(t('failedPrefix', [String(resp.error)]), true);
        resetSaveButton(btn);
        return;
      }
      if (resp && resp.alreadyRunning) {
        setStatus(t('muxRunning'));
        resetSaveButton(btn);
        return;
      }
      btn.textContent = t('muxing');
      setStatus(t('muxStatus'));
      pollHls({ key: resp.jobKey, url: resp.jobKey, dashEntry: null }, btn);
    });
    return;
  }

  const msg = item.url.indexOf('blob:') === 0
    ? { type: 'ms-download-blob', url: item.url, kind: item.kind, ext: item.ext, title: item.title, pageUrl: pageUrl, size: item.size, tabId: tabId }
    : { type: 'ms-download', item: item, tabId: tabId };

  chrome.runtime.sendMessage(msg, (resp) => {
    if (chrome.runtime.lastError) {
      setStatus(t('errorPrefix', [chrome.runtime.lastError.message]), true);
      resetSaveButton(btn);
      return;
    }
    if (resp && resp.error) {
      setStatus(t('failedPrefix', [String(resp.error)]), true);
      resetSaveButton(btn);
      return;
    }
    btn.textContent = t('queued');
    watchQueueEntry(resp.id, btn, item.via === 'youtube');
  });
}

function watchQueueEntry(entryId, btn, isYoutube) {
  const started = Date.now();
  const timer = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'ms-queue-status' }, (qs) => {
      if (chrome.runtime.lastError || !qs) return;
      const e = (qs.queue || []).find((q) => q.id === entryId);
      if (!e) return;

      if (e.status === 'complete') {
        clearInterval(timer);
        resetSaveButton(btn);
        setStatus(t('savedFile', [e.filename || '']));
      } else if (e.status === 'failed') {
        clearInterval(timer);
        resetSaveButton(btn);
        const forbidden = /FORBIDDEN|403|UNAUTHORIZED|http 403|http 401/i.test(e.error || '');
        setStatus(
          forbidden && isYoutube ? t('youtubeDenied') : t('failedPrefix', [e.error || 'unknown']),
          true
        );
      } else if (e.status === 'fallback') {
        btn.textContent = t('retrying');
        setStatus(t('cdnRetry'));
      } else if (Date.now() - started > 30000) {
        clearInterval(timer);
        resetSaveButton(btn);
        setStatus(t('downloadInProgress'));
      }
    });
  }, 1000);
}

function pollHls(item, btn) {
  const started = Date.now();
  const timer = setInterval(() => {
    chrome.runtime.sendMessage({
      type: 'ms-hls-status',
      url: item.url,
      dashEntry: item.dashEntry != null ? item.dashEntry : null,
    }, (job) => {
      if (chrome.runtime.lastError || !job) {
        clearInterval(timer);
        resetSaveButton(btn);
        setStatus(t('jobLost'), true);
        return;
      }

      if (job.status === 'recording') {
        btn.dataset.recording = '1';
        btn.textContent = t('stop');
        setStatus(t('recordingStatus', [fmtDuration(job.seconds), formatBytes(job.bytes)]));
        return;
      }

      btn.dataset.recording = '';
      if (job.status === 'combining' && job.total) {
        btn.textContent = Math.round((job.done / job.total) * 100) + '%';
        setStatus(t('segmentProgress', [String(job.done), String(job.total)]));
      } else if (job.status === 'combining' && job.mode === 'ffmpeg') {
        btn.textContent = job.bytes ? formatBytes(job.bytes) : t('processing');
        setStatus(t('ffmpegStatus', [job.seconds ? fmtDuration(job.seconds) : '']));
      } else if (job.status === 'downloading') {
        btn.textContent = t('saving');
        setStatus(t('combinedSaving'));
      } else if (job.status === 'complete') {
        clearInterval(timer);
        resetSaveButton(btn);
        setStatus(t('savedFile', [job.filename || '']));
      } else if (job.status === 'failed') {
        clearInterval(timer);
        resetSaveButton(btn);
        setStatus(t('failedPrefix', [job.error || 'unknown']), true);
      } else if (Date.now() - started > 30 * 60 * 1000) {
        clearInterval(timer);
        resetSaveButton(btn);
        setStatus(t('timeout'), true);
      }
    });
  }, 700);

  const prev = hlsTimers.get(item.key);
  if (prev) clearInterval(prev);
  hlsTimers.set(item.key, timer);
}

let settings = { rootFolder: '', minSizeKb: 500, blacklist: '' };

function loadSettings(cb) {
  chrome.runtime.sendMessage({ type: 'ms-get-settings' }, (s) => {
    if (!chrome.runtime.lastError && s) settings = s;
    if ($('#destHint')) {
      $('#destHint').textContent = settings.rootFolder
        ? t('destFolder', [settings.rootFolder])
        : t('destRoot');
    }
    if (cb) cb();
  });
}

function load() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const currentTab = tabs[0];
    if (!currentTab) return;
    tabId = currentTab.id;
    pageUrl = currentTab.url;
    chrome.runtime.sendMessage({ type: 'ms-get-items', tabId: tabId }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        setStatus(t('backgroundUnavailable'), true);
        return;
      }
      items = resp.items || [];
      render();
    });
  });
}

$('#rescan').addEventListener('click', () => {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: 'ms-scan' }, () => { void chrome.runtime.lastError; });
  setStatus(t('scanning'));
  const before = items.length;
  let polls = 0;
  const timer = setInterval(() => {
    polls++;
    load();
    if (polls >= 6 || items.length > before) clearInterval(timer);
  }, 500);
});

$('#clear').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'ms-clear', tabId: tabId }, () => {
    items = [];
    render();
    setStatus(t('cleared'));
  });
});

$('#ytdlp').addEventListener('click', async () => {
  if (!pageUrl || pageUrl.indexOf('http') !== 0) {
    setStatus(t('tabUnsupported'), true);
    return;
  }
  const cmd = L().ytDlpCommand(pageUrl);
  try {
    await navigator.clipboard.writeText(cmd);
    setStatus(t('copied', [cmd]));
  } catch (e) {
    setStatus(t('copyFailed'), true);
  }
});

$('#saveall').addEventListener('click', () => {
  if (!items.length) {
    setStatus(t('noItems'));
    return;
  }
  const btn = $('#saveall');
  btn.classList.add('busy');
  btn.textContent = '…';
  chrome.runtime.sendMessage({ type: 'ms-download-all', tabId: tabId }, (resp) => {
    btn.classList.remove('busy');
    btn.textContent = t('saveAll');
    if (chrome.runtime.lastError || !resp) {
      const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : t('noResponse');
      setStatus(t('errorPrefix', [err]), true);
      return;
    }
    const parts = [];
    if (resp.queued) parts.push(t('queuedCount', [String(resp.queued)]));
    if (resp.skipped) parts.push(t('skippedCount', [String(resp.skipped)]));
    if (resp.deferred) parts.push(t('deferredCount', [String(resp.deferred)]));
    setStatus(parts.length ? parts.join(' · ') : t('noSavable'));
  });
});

$('#options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

document.addEventListener('DOMContentLoaded', () => loadSettings(load));
if (document.readyState !== 'loading') loadSettings(load);
