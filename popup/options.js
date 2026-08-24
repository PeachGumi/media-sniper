'use strict';

const $ = (s) => document.querySelector(s);
const DEFAULT_MIN_SIZE_KB = 500;

function showStatus(text, isErr) {
  const el = $('#status');
  el.textContent = text;
  el.className = isErr ? 'err' : '';
}

function normalizeMinSize(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MIN_SIZE_KB;
}

function load() {
  chrome.runtime.sendMessage({ type: 'ms-get-settings' }, (s) => {
    if (chrome.runtime.lastError || !s) { showStatus('設定を読めません', true); return; }
    $('#rootFolder').value = s.rootFolder || '';
    $('#minSizeKb').value = normalizeMinSize(s.minSizeKb);
    $('#blacklist').value = s.blacklist || '';
  });
}

$('#save').addEventListener('click', () => {
  const settings = {
    rootFolder: $('#rootFolder').value.trim(),
    minSizeKb: normalizeMinSize($('#minSizeKb').value),
    blacklist: $('#blacklist').value,
  };
  chrome.runtime.sendMessage({ type: 'ms-set-settings', settings: settings }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.saved) { showStatus('保存に失敗しました', true); return; }
    // reflect what was actually stored (root folder gets sanitized)
    $('#rootFolder').value = resp.settings.rootFolder;
    $('#minSizeKb').value = normalizeMinSize(resp.settings.minSizeKb);
    showStatus('保存しました');
    setTimeout(() => { showStatus(''); }, 2500);
  });
});

load();
