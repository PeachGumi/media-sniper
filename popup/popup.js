'use strict';

const $ = (s) => document.querySelector(s);
const t = (key, subs) => MediaSniperI18n.t(key, subs);

let tabId = null;
let pageUrl = null;
let items = [];
const hlsTimers = new Map();
let saveOperationSequence = 0;
let activeSaveCount = 0;
let renderPending = false;

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

function selectedQuality(item) {
  if (!item || item.kind !== 'hls' || !item.variants || !item.variants.length) return null;
  return L().selectedHlsVariant(item);
}

function qualitySelector(item) {
  const source = item && item.kind === 'hls' && Array.isArray(item.variants) ? item.variants : [];
  if (!source.length) return null;
  const limit = Number(L().MAX_HLS_VARIANTS) || 128;
  const variants = source.slice(0, limit);
  const boundedItem = Object.assign({}, item, { variants: variants });
  const select = document.createElement('select');
  select.className = 'quality';
  select.setAttribute('aria-label', 'Quality');
  const current = selectedQuality(boundedItem);
  if (current) item.selectedVariantKey = L().hlsVariantKey(current);
  for (const variant of variants) {
    const option = document.createElement('option');
    option.value = L().hlsVariantKey(variant);
    option.textContent = L().hlsVariantLabel(variant);
    if (current && option.value === L().hlsVariantKey(current)) option.selected = true;
    select.appendChild(option);
  }
  if (current) select.value = L().hlsVariantKey(current);
  select.addEventListener('change', () => {
    const variant = L().selectHlsVariant(item, select.value);
    if (!variant) return;
    item.selectedVariantKey = L().hlsVariantKey(variant);
    chrome.runtime.sendMessage({
      type: 'ms-select-quality', tabId: tabId, itemKey: item.key, itemUrl: item.url,
      variantKey: item.selectedVariantKey,
    }, () => { void chrome.runtime.lastError; });
  });
  return select;
}

function resetSaveButton(btn) {
  if (btn.dataset.activeSave === '1') {
    btn.dataset.activeSave = '';
    activeSaveCount = Math.max(0, activeSaveCount - 1);
    if (activeSaveCount === 0 && renderPending) Promise.resolve().then(flushDeferredRender);
  }
  btn.classList.remove('busy');
  btn.disabled = false;
  btn.setAttribute('aria-busy', 'false');
  btn.dataset.recording = '';
  btn.dataset.stopping = '';
  btn.dataset.jobKey = '';
  btn.dataset.operation = '';
  btn.dataset.stopAttempt = '';
  btn.textContent = t('save');
}

function setActionStatus(btn, text, isErr) {
  const el = btn && btn._actionStatusEl;
  if (!el) return;
  el.textContent = text || '';
  if (isErr) el.classList.add('err');
  else el.classList.remove('err');
}

function beginSave(btn) {
  const operation = String(++saveOperationSequence);
  btn.classList.add('busy');
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.textContent = t('starting');
  btn.dataset.operation = operation;
  btn.dataset.activeSave = '1';
  btn.dataset.stopAttempt = '0';
  activeSaveCount++;
  btn.dataset.stopping = '';
  btn.dataset.jobKey = '';
  setActionStatus(btn, t('startingDownload'));
  setStatus(t('startingDownload'));
  return operation;
}

function isCurrentSave(btn, operation) {
  return btn.dataset.operation === operation;
}

function flushDeferredRender() {
  if (activeSaveCount > 0 || !renderPending) return;
  renderPending = false;
  render();
}

function render() {
  const list = $('#list');
  if (activeSaveCount > 0) {
    renderPending = true;
    return;
  }
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
    const quality = qualitySelector(item);
    if (quality) info.appendChild(quality);

    const action = document.createElement('div');
    action.classList.add('action-status');
    action.setAttribute('role', 'status');
    action.setAttribute('aria-live', 'polite');
    info.appendChild(action);

    const dl = document.createElement('button');
    dl.className = 'dl';
    dl.textContent = t('save');
    dl._actionStatusEl = action;
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
  if (btn.dataset.stopping === '1') return;
  if (btn.dataset.recording === '1') {
    const operation = btn.dataset.operation;
    const jobKey = btn.dataset.jobKey || item.jobKey || null;
    const stopAttempt = String((Number(btn.dataset.stopAttempt) || 0) + 1);
    btn.dataset.stopAttempt = stopAttempt;
    btn.disabled = true;
    btn.dataset.stopping = '1';
    btn.textContent = t('stopping');
    setActionStatus(btn, t('stoppingRecording'));
    chrome.runtime.sendMessage({ type: 'ms-hls-stop', url: item.url, jobKey: jobKey }, (resp) => {
      if (!isCurrentSave(btn, operation) || btn.dataset.jobKey !== (jobKey || '') ||
          btn.dataset.stopping !== '1' || btn.dataset.stopAttempt !== stopAttempt) return;
      if (chrome.runtime.lastError || !resp || resp.ok === false) {
        setStatus(t('stopFailed'), true);
        setActionStatus(btn, t('stopFailed'), true);
        btn.disabled = false;
        btn.dataset.stopping = '';
        btn.textContent = t('stop');
        return;
      }
      btn.textContent = t('stopping');
      setStatus(t('stoppingRecording'));
    });
    return;
  }

  const operation = beginSave(btn);

  if (item.kind === 'hls' || item.kind === 'hls-audio' || item.kind === 'dash') {
    const variant = selectedQuality(item);
    chrome.runtime.sendMessage(
      {
        type: 'ms-hls-download', url: item.url, kind: item.kind, tabId: tabId, title: item.title, pageUrl: pageUrl,
        dashEntry: item.dashEntry != null ? item.dashEntry : null, dashType: item.dashType || null,
        variantUrl: variant ? variant.url : null,
        variantKey: variant ? L().hlsVariantKey(variant) : null,
        audioUrl: variant ? (variant.audioUrl || null) : (item.audioUrl || null),
      },
      (resp) => {
        if (!isCurrentSave(btn, operation)) return;
        if (chrome.runtime.lastError || !resp) {
          const error = chrome.runtime.lastError ? chrome.runtime.lastError.message : t('noResponse');
          setStatus(t('errorPrefix', [error]), true);
          setActionStatus(btn, t('errorPrefix', [error]), true);
          resetSaveButton(btn);
          return;
        }
        if (resp && resp.error) {
          setStatus(t('failedPrefix', [String(resp.error)]), true);
          setActionStatus(btn, t('failedPrefix', [String(resp.error)]), true);
          resetSaveButton(btn);
          return;
        }
        if (resp && resp.alreadyRunning) {
          setStatus(t('alreadyRunning'));
          setActionStatus(btn, t('alreadyRunning'));
          resetSaveButton(btn);
          return;
        }
        if (resp && resp.recording) {
          setStatus(t('recordingStarted'));
          setActionStatus(btn, t('recordingStarted'));
          btn.dataset.recording = '1';
          btn.dataset.jobKey = resp.jobKey || item.url;
          btn.disabled = false;
          btn.textContent = t('stop');
          pollHls(Object.assign({}, item, { jobKey: resp.jobKey || item.url }), btn, operation);
          return;
        }
        const fetching = item.kind === 'dash' ? t('dashFetching') : t('hlsFetching');
        setStatus(fetching);
        setActionStatus(btn, fetching);
        btn.textContent = t('fetching');
        btn.dataset.jobKey = resp.jobKey || item.url;
        pollHls(Object.assign({}, item, { jobKey: resp.jobKey || item.url }), btn, operation);
      }
    );
    return;
  }

  if (item.via === 'youtube' && item.audioUrl) {
    chrome.runtime.sendMessage({ type: 'ms-yt-mux-download', item: item, tabId: tabId }, (resp) => {
      if (!isCurrentSave(btn, operation)) return;
      if (chrome.runtime.lastError || !resp) {
        const error = chrome.runtime.lastError ? chrome.runtime.lastError.message : t('noResponse');
        setStatus(t('errorPrefix', [error]), true);
        setActionStatus(btn, t('errorPrefix', [error]), true);
        resetSaveButton(btn);
        return;
      }
      if (resp && resp.error) {
        setStatus(t('failedPrefix', [String(resp.error)]), true);
        setActionStatus(btn, t('failedPrefix', [String(resp.error)]), true);
        resetSaveButton(btn);
        return;
      }
      if (resp && resp.alreadyRunning) {
        setStatus(t('muxRunning'));
        setActionStatus(btn, t('muxRunning'));
        resetSaveButton(btn);
        return;
      }
      btn.textContent = t('muxing');
      setStatus(t('muxStatus'));
      setActionStatus(btn, t('muxStatus'));
      btn.dataset.jobKey = resp.jobKey || '';
      pollHls({ key: resp.jobKey, jobKey: resp.jobKey, url: resp.jobKey, dashEntry: null }, btn, operation);
    });
    return;
  }

  const msg = item.url.indexOf('blob:') === 0
    ? { type: 'ms-download-blob', url: item.url, kind: item.kind, ext: item.ext, title: item.title, pageUrl: pageUrl, size: item.size, tabId: tabId }
    : { type: 'ms-download', item: item, tabId: tabId };

  chrome.runtime.sendMessage(msg, (resp) => {
    if (!isCurrentSave(btn, operation)) return;
    if (chrome.runtime.lastError || !resp) {
      const error = chrome.runtime.lastError ? chrome.runtime.lastError.message : t('noResponse');
      setStatus(t('errorPrefix', [error]), true);
      setActionStatus(btn, t('errorPrefix', [error]), true);
      resetSaveButton(btn);
      return;
    }
    if (resp && resp.error) {
      setStatus(t('failedPrefix', [String(resp.error)]), true);
      setActionStatus(btn, t('failedPrefix', [String(resp.error)]), true);
      resetSaveButton(btn);
      return;
    }
    btn.textContent = t('queued');
    setActionStatus(btn, t('queuedStatus'));
    watchQueueEntry(resp.id, btn, item.via === 'youtube', operation);
  });
}

function watchQueueEntry(entryId, btn, isYoutube, operation) {
  const started = Date.now();
  let requestedStatus = 0;
  let appliedStatus = 0;
  const timer = setInterval(() => {
    const request = ++requestedStatus;
    chrome.runtime.sendMessage({ type: 'ms-queue-status' }, (qs) => {
      if (!isCurrentSave(btn, operation) || request < appliedStatus) return;
      appliedStatus = request;
      if (chrome.runtime.lastError || !qs) {
        clearInterval(timer);
        resetSaveButton(btn);
        setStatus(t('jobLost'), true);
        setActionStatus(btn, t('jobLost'), true);
        return;
      }
      const e = (qs.queue || []).find((x) => x.id === entryId);
      if (!e) {
        clearInterval(timer);
        resetSaveButton(btn);
        setStatus(t('jobLost'), true);
        setActionStatus(btn, t('jobLost'), true);
        return;
      }

      if (e.status === 'complete') {
        clearInterval(timer);
        resetSaveButton(btn);
        const saved = t('savedFile', [e.filename || '']);
        setStatus(saved);
        setActionStatus(btn, saved);
      } else if (e.status === 'failed') {
        clearInterval(timer);
        resetSaveButton(btn);
        const forbidden = /FORBIDDEN|403|UNAUTHORIZED|http 403|http 401/i.test(e.error || '');
        const failed = forbidden && isYoutube ? t('youtubeDenied') : t('failedPrefix', [e.error || 'unknown']);
        setStatus(failed, true);
        setActionStatus(btn, failed, true);
      } else if (e.status === 'fallback') {
        btn.textContent = t('retrying');
        setStatus(t('cdnRetry'));
        setActionStatus(btn, t('cdnRetry'));
      } else if (e.status === 'started' || e.status === 'downloading') {
        btn.textContent = t('saving');
        setStatus(t('downloadInProgress'));
        setActionStatus(btn, t('downloadInProgress'));
      } else if (Date.now() - started > 30000) {
        btn.textContent = t('saving');
        setStatus(t('downloadInProgress'));
        setActionStatus(btn, t('downloadInProgress'));
      }
    });
  }, 1000);
}

function pollHls(item, btn, operation) {
  const started = Date.now();
  let requestedStatus = 0;
  let appliedStatus = 0;
  const timer = setInterval(() => {
    const request = ++requestedStatus;
    chrome.runtime.sendMessage({
      type: 'ms-hls-status', jobKey: item.jobKey || null,
      url: item.url,
      dashEntry: item.dashEntry != null ? item.dashEntry : null,
    }, (job) => {
      if (!isCurrentSave(btn, operation) || btn.dataset.jobKey !== (item.jobKey || '') || request < appliedStatus) return;
      appliedStatus = request;
      if (chrome.runtime.lastError || !job) {
        clearInterval(timer);
        resetSaveButton(btn);
        setStatus(t('jobLost'), true);
        setActionStatus(btn, t('jobLost'), true);
        return;
      }

      if (job.status === 'recording') {
        btn.dataset.recording = '1';
        if (btn.dataset.stopping === '1') return;
        btn.disabled = false;
        btn.textContent = t('stop');
        const recording = t('recordingStatus', [fmtDuration(job.seconds), formatBytes(job.bytes)]);
        setStatus(recording);
        setActionStatus(btn, recording);
        return;
      }

      btn.dataset.recording = '';
      btn.dataset.stopping = '';
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      if (job.status === 'combining' && job.total) {
        btn.textContent = Math.round((job.done / job.total) * 100) + '%';
        const progress = t('segmentProgress', [String(job.done), String(job.total)]);
        setStatus(progress);
        setActionStatus(btn, progress);
      } else if (job.status === 'combining' && job.mode === 'ffmpeg') {
        btn.textContent = job.bytes ? formatBytes(job.bytes) : t('processing');
        const processing = t('ffmpegStatus', [job.seconds ? fmtDuration(job.seconds) : '']);
        setStatus(processing);
        setActionStatus(btn, processing);
      } else if (job.status === 'downloading') {
        btn.textContent = t('saving');
        setStatus(t('combinedSaving'));
        setActionStatus(btn, t('combinedSaving'));
      } else if (job.status === 'complete') {
        clearInterval(timer);
        resetSaveButton(btn);
        const saved = t('savedFile', [job.filename || '']);
        setStatus(saved);
        setActionStatus(btn, saved);
      } else if (job.status === 'failed') {
        clearInterval(timer);
        resetSaveButton(btn);
        const failed = t('failedPrefix', [job.error || 'unknown']);
        setStatus(failed, true);
        setActionStatus(btn, failed, true);
      } else if (Date.now() - started > 30 * 60 * 1000) {
        clearInterval(timer);
        resetSaveButton(btn);
        setStatus(t('timeout'), true);
        setActionStatus(btn, t('timeout'), true);
      }
    });
  }, 700);

  const prev = hlsTimers.get(item.key);
  if (prev) clearInterval(prev);
  hlsTimers.set(item.key, timer);
}

function selectedQualityMap() {
  const selections = {};
  for (const item of items) {
    const variant = selectedQuality(item);
    if (variant && item.key) selections[item.key] = L().hlsVariantKey(variant);
  }
  return selections;
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
  btn.disabled = true;
  btn.textContent = t('starting');
  setStatus(t('startingDownload'));
  chrome.runtime.sendMessage({ type: 'ms-download-all', tabId: tabId, selections: selectedQualityMap() }, (resp) => {
    btn.classList.remove('busy');
    btn.disabled = false;
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
