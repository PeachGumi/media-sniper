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

function labelFor(item) {
  switch (item.kind) {
    case 'video': return '動画';
    case 'hls': return 'HLS';
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
    if (item.duration) bits.push(Math.round(item.duration) + 's');
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
  if (item.kind === 'dash') {
    setStatus('DASH(mpd)は未対応 — yt-dlp コマンドで落としてください', true);
    return;
  }
  btn.classList.add('busy');
  btn.textContent = '…';
  if (item.kind === 'hls') {
    chrome.runtime.sendMessage(
      { type: 'ms-hls-download', url: item.url, tabId: tabId, title: item.title, pageUrl: pageUrl },
      (resp) => {
        if (chrome.runtime.lastError) { setStatus('エラー: ' + chrome.runtime.lastError.message, true); btn.classList.remove('busy'); btn.textContent = '保存'; return; }
        if (resp && resp.error) { setStatus(resp.error, true); btn.classList.remove('busy'); btn.textContent = '保存'; return; }
        setStatus('HLS セグメント取得中… (ページ内で処理)');
        btn.textContent = '取得中';
        pollHls(item, btn);
      }
    );
    return;
  }
  const msg = item.url.indexOf('blob:') === 0
    ? { type: 'ms-download-blob', url: item.url, kind: item.kind, ext: item.ext, title: item.title, pageUrl: pageUrl, size: item.size, tabId: tabId }
    : { type: 'ms-download', item: item, tabId: tabId };
  chrome.runtime.sendMessage(msg, (resp) => {
    if (chrome.runtime.lastError) { setStatus('エラー: ' + chrome.runtime.lastError.message, true); btn.classList.remove('busy'); btn.textContent = '保存'; return; }
    btn.textContent = 'キュー追加';
    if (item.via === 'youtube') {
      // YouTube URLs can be 403-blocked outside a logged-in context; watch
      // the queue entry briefly so we can point the user at yt-dlp instead.
      watchQueueEntry(resp.id, btn);
    } else {
      setTimeout(() => { btn.classList.remove('busy'); btn.textContent = '保存'; }, 1200);
    }
  });
}

function watchQueueEntry(entryId, btn) {
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
        const forbidden = /FORBIDDEN|403|UNAUTHORIZED/i.test(e.error || '');
        setStatus(forbidden
          ? 'YouTubeが直接ダウンロードを拒否しました — 下の「yt-dlp」ボタンでコマンドをコピーして使ってください'
          : '失敗: ' + e.error, true);
      } else if (Date.now() - started > 30000) {
        clearInterval(t);
        btn.classList.remove('busy'); btn.textContent = '保存';
        setStatus('ダウンロード中… (進捗はブラウザのダウンロードバーで)');
      }
    });
  }, 1000);
}

function pollHls(item, btn) {
  const t = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'ms-hls-status', url: item.url }, (job) => {
      if (chrome.runtime.lastError || !job) return;
      if (job.status === 'combining' && job.total) {
        btn.textContent = Math.round((job.done / job.total) * 100) + '%';
      } else if (job.status === 'downloading') {
        btn.textContent = '保存中';
        clearInterval(t);
        setTimeout(() => { btn.classList.remove('busy'); btn.textContent = '保存'; setStatus('HLS をダウンロードに渡しました'); }, 1500);
      } else if (job.status === 'failed') {
        clearInterval(t);
        btn.classList.remove('busy');
        btn.textContent = '保存';
        setStatus('HLS失敗: ' + (job.error || 'unknown'), true);
      }
    });
  }, 700);
  hlsTimers.set(item.key, t);
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
  setTimeout(load, 900);
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

document.addEventListener('DOMContentLoaded', load);
if (document.readyState !== 'loading') load();
