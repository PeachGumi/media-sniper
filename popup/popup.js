'use strict';

const $ = (s) => document.querySelector(s);

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
    case 'video': return '動画';
    case 'hls': return 'HLS';
    case 'hls-audio': return '音声(HLS)';
    case 'audio': return '音声';
    case 'dash': return 'DASH';
    case 'ts': return 'TS';
    default: return item.kind || '?';
  }
}

function render() {
  const list = $('#list');
  list.textContent = '';
  $('#count').textContent = items.length ? items.length + ' 件検出' : '';
  if (!items.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'このページでメディアを検出していません。動画を再生してから再スキャンしてください。';
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
    dl.textContent = '保存';
    dl.addEventListener('click', () => save(item, dl));

    const copy = document.createElement('button');
    copy.textContent = 'URL';
    copy.title = 'URLをコピー';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(item.url); copy.textContent = '✓'; setTimeout(() => { copy.textContent = 'URL'; }, 900); } catch (e) { setStatus('コピー失敗', true); }
    });

    row.appendChild(badge);
    row.appendChild(info);
    row.appendChild(copy);
    row.appendChild(dl);
    list.appendChild(row);
  }
}

function save(item, btn) {
  // live recording in progress: this same button is the stop control
  if (btn.dataset.recording === '1') {
    chrome.runtime.sendMessage({ type: 'ms-hls-stop', url: item.url }, (resp) => {
      if (chrome.runtime.lastError || (resp && resp.ok === false)) {
        setStatus('停止失敗 — もう一度押してください', true);
        return;
      }
      btn.textContent = '停止中';
      setStatus('録画を停止しています…');
    });
    return;
  }
  btn.classList.add('busy');
  btn.textContent = '…';
  if (item.kind === 'hls' || item.kind === 'hls-audio' || item.kind === 'dash') {
    chrome.runtime.sendMessage(
      { type: 'ms-hls-download', url: item.url, tabId: tabId, title: item.title, pageUrl: pageUrl,
        dashEntry: item.dashEntry != null ? item.dashEntry : null, dashType: item.dashType || null,
        audioUrl: item.audioUrl || null },
      (resp) => {
        if (chrome.runtime.lastError) { setStatus('エラー: ' + chrome.runtime.lastError.message, true); btn.classList.remove('busy'); btn.textContent = '保存'; return; }
        if (resp && resp.error) { setStatus(resp.error, true); btn.classList.remove('busy'); btn.textContent = '保存'; return; }
        if (resp && resp.alreadyRunning) { setStatus('既に実行中です'); btn.classList.remove('busy'); btn.textContent = '保存'; return; }
        if (resp && resp.recording) {
          // live: recording started; poll will flip the button to 停止
          setStatus('録画を開始しました — 停止で保存されます');
          btn.textContent = '録画中';
          pollHls(item, btn);
          return;
        }
        setStatus(item.kind === 'dash' ? 'DASH取得中…' : 'HLS セグメント取得中…');
        btn.textContent = '取得中';
        pollHls(item, btn);
      }
    );
    return;
  }
  // YouTube adaptive mux item (video-only URL + separate audioUrl): fetch
  // both tracks and mux them in the offscreen document instead of saving a
  // silent video-only stream.
  if (item.via === 'youtube' && item.audioUrl) {
    chrome.runtime.sendMessage({ type: 'ms-yt-mux-download', item: item, tabId: tabId }, (resp) => {
      if (chrome.runtime.lastError) { setStatus('エラー: ' + chrome.runtime.lastError.message, true); btn.classList.remove('busy'); btn.textContent = '保存'; return; }
      if (resp && resp.error) { setStatus('失敗: ' + resp.error, true); btn.classList.remove('busy'); btn.textContent = '保存'; return; }
      if (resp && resp.alreadyRunning) { setStatus('mux実行中です'); btn.classList.remove('busy'); btn.textContent = '保存'; return; }
      btn.textContent = 'mux中';
      setStatus('映像+音声を取得してmuxしています…');
      pollHls({ key: resp.jobKey, url: resp.jobKey, dashEntry: null }, btn);
    });
    return;
  }
  const msg = item.url.indexOf('blob:') === 0
    ? { type: 'ms-download-blob', url: item.url, kind: item.kind, ext: item.ext, title: item.title, pageUrl: pageUrl, size: item.size, tabId: tabId }
    : { type: 'ms-download', item: item, tabId: tabId };
  chrome.runtime.sendMessage(msg, (resp) => {
    if (chrome.runtime.lastError) { setStatus('エラー: ' + chrome.runtime.lastError.message, true); btn.classList.remove('busy'); btn.textContent = '保存'; return; }
    if (resp && resp.error) { setStatus('失敗: ' + resp.error, true); btn.classList.remove('busy'); btn.textContent = '保存'; return; }
    btn.textContent = 'キュー追加';
    // Every download gets watched: failures must always surface (a silent
    // button is the "保存を押しても何も起きない" bug).
    watchQueueEntry(resp.id, btn, item.via === 'youtube');
  });
}

function watchQueueEntry(entryId, btn, isYoutube) {
  const started = Date.now();
  const t = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'ms-queue-status' }, (qs) => {
      if (chrome.runtime.lastError || !qs) return;
      const e = (qs.queue || []).find((q) => q.id === entryId);
      if (!e) return;
      if (e.status === 'complete') {
        clearInterval(t);
        btn.classList.remove('busy'); btn.textContent = '保存';
        setStatus('保存しました: ' + (e.filename || ''));
      } else if (e.status === 'failed') {
        clearInterval(t);
        btn.classList.remove('busy'); btn.textContent = '保存';
        const forbidden = /FORBIDDEN|403|UNAUTHORIZED|http 403|http 401/i.test(e.error || '');
        setStatus(forbidden && isYoutube
          ? 'YouTubeが直接ダウンロードを拒否しました — 下の「yt-dlp」ボタンでコマンドをコピーして使ってください'
          : '失敗: ' + (e.error || 'unknown'), true);
      } else if (e.status === 'fallback') {
        btn.textContent = '再試行中';
        setStatus('CDNが直接アクセスを拒否したため、セッション付きで再取得しています…');
      } else if (Date.now() - started > 30000) {
        clearInterval(t);
        btn.classList.remove('busy'); btn.textContent = '保存';
        setStatus('ダウンロード中… (進捗はブラウザのダウンロードバーで)');
      }
    });
  }, 1000);
}

function pollHls(item, btn) {
  // Poll until the job truly finishes: the blob download itself can still
  // fail AFTER the "downloading" state, so keep watching for complete/failed.
  const started = Date.now();
  const t = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'ms-hls-status', url: item.url, dashEntry: item.dashEntry != null ? item.dashEntry : null }, (job) => {
      if (chrome.runtime.lastError || !job) {
        // job vanished (SW restart): tell the user instead of hanging forever
        clearInterval(t);
        btn.classList.remove('busy'); btn.textContent = '保存';
        setStatus('HLSジョブの状態を見失いました — もう一度「保存」を押してください', true);
        return;
      }
      if (job.status === 'recording') {
        // live: show elapsed time/size, button becomes the stop control
        btn.dataset.recording = '1';
        btn.textContent = '停止';
        setStatus('録画中 ' + fmtDuration(job.seconds) + ' · ' + formatBytes(job.bytes) + ' — 停止を押すと保存されます');
        return;
      }
      btn.dataset.recording = '';
      if (job.status === 'combining' && job.total) {
        btn.textContent = Math.round((job.done / job.total) * 100) + '%';
        setStatus('セグメント取得中 ' + job.done + '/' + job.total);
      } else if (job.status === 'combining' && job.mode === 'ffmpeg') {
        btn.textContent = job.bytes ? formatBytes(job.bytes) : '処理中';
        setStatus('ffmpeg処理中… ' + (job.seconds ? fmtDuration(job.seconds) : ''));
      } else if (job.status === 'downloading') {
        btn.textContent = '保存中';
        setStatus('結合完了 — ダウンロードに保存中…');
      } else if (job.status === 'complete') {
        clearInterval(t);
        btn.classList.remove('busy'); btn.textContent = '保存';
        setStatus('保存しました: ' + (job.filename || ''));
      } else if (job.status === 'failed') {
        clearInterval(t);
        btn.classList.remove('busy');
        btn.textContent = '保存';
        setStatus('失敗: ' + (job.error || 'unknown'), true);
      } else if (Date.now() - started > 30 * 60 * 1000) {
        clearInterval(t);
        btn.classList.remove('busy'); btn.textContent = '保存';
        setStatus('タイムアウト — 長い動画は時間がかかります。進捗はステータスを確認', true);
      }
    });
  }, 700);
  // replace (don't stack) the poll timer when the same item is saved again
  const prev = hlsTimers.get(item.key);
  if (prev) clearInterval(prev);
  hlsTimers.set(item.key, t);
}

let settings = { rootFolder: '', minSizeKb: 500, blacklist: '' };

function loadSettings(cb) {
  chrome.runtime.sendMessage({ type: 'ms-get-settings' }, (s) => {
    if (!chrome.runtime.lastError && s) settings = s;
    if ($('#destHint')) {
      $('#destHint').textContent = settings.rootFolder
        ? '保存先: ~/Downloads/' + settings.rootFolder + '/'
        : '保存先: ~/Downloads/ 直下';
    }
    if (cb) cb();
  });
}

function load() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const t = tabs[0];
    if (!t) return;
    tabId = t.id;
    pageUrl = t.url;
    chrome.runtime.sendMessage({ type: 'ms-get-items', tabId: tabId }, (resp) => {
      if (chrome.runtime.lastError || !resp) { setStatus('background と通信できません (拡張を再読み込み)', true); return; }
      items = resp.items || [];
      render();
    });
  });
}

$('#rescan').addEventListener('click', () => {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: 'ms-scan' }, () => { void chrome.runtime.lastError; });
  setStatus('スキャン中…');
  const before = items.length;
  let polls = 0;
  const t = setInterval(() => {
    polls++;
    load();
    if (polls >= 6 || items.length > before) { clearInterval(t); }
  }, 500);
});

$('#clear').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'ms-clear', tabId: tabId }, () => {
    items = [];
    render();
    setStatus('クリアしました');
  });
});

$('#ytdlp').addEventListener('click', async () => {
  if (!pageUrl || pageUrl.indexOf('http') !== 0) { setStatus('このタブは対象外', true); return; }
  const cmd = L().ytDlpCommand(pageUrl);
  try {
    await navigator.clipboard.writeText(cmd);
    setStatus('コピー: ' + cmd);
  } catch (e) { setStatus('コピー失敗', true); }
});

// 全部保存: direct items go through ms-download-all (skip-existing +
// uniquify-safe), HLS/DASH run one-by-one in the background's media chain.
$('#saveall').addEventListener('click', () => {
  if (!items.length) { setStatus('保存するアイテムがありません'); return; }
  const btn = $('#saveall');
  btn.classList.add('busy');
  btn.textContent = '…';
  chrome.runtime.sendMessage({ type: 'ms-download-all', tabId: tabId }, (resp) => {
    btn.classList.remove('busy');
    btn.textContent = '全部保存';
    if (chrome.runtime.lastError || !resp) { setStatus('エラー: ' + (chrome.runtime.lastError ? chrome.runtime.lastError.message : '応答なし'), true); return; }
    const parts = [];
    if (resp.queued) parts.push(resp.queued + '件をキューに追加');
    if (resp.skipped) parts.push(resp.skipped + '件は保存済みでスキップ');
    if (resp.deferred) parts.push(resp.deferred + '件のHLS/DASHを順次処理中');
    setStatus(parts.length ? parts.join(' · ') : '保存できるアイテムがありません');
  });
});

$('#options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

document.addEventListener('DOMContentLoaded', () => loadSettings(load));
if (document.readyState !== 'loading') { loadSettings(load); }
