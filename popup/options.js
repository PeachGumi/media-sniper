'use strict';

const $ = (s) => document.querySelector(s);
const DEFAULT_MIN_SIZE_KB = 500;
const t = (key, subs) => MediaSniperI18n.t(key, subs);

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
    if (chrome.runtime.lastError || !s) { showStatus(t('settingsReadFailed'), true); return; }
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
    if (chrome.runtime.lastError || !resp || !resp.saved) { showStatus(t('settingsSaveFailed'), true); return; }
    $('#rootFolder').value = resp.settings.rootFolder;
    $('#minSizeKb').value = normalizeMinSize(resp.settings.minSizeKb);
    showStatus(t('settingsSaved'));
    setTimeout(() => { showStatus(''); }, 2500);
  });
});

load();
