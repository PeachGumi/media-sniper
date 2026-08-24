'use strict';

const fs = require('fs');
const path = require('path');
const { eq, ok, report } = require('./harness.js');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(root, '_locales/en/messages.json'), 'utf8'));
const ja = JSON.parse(fs.readFileSync(path.join(root, '_locales/ja/messages.json'), 'utf8'));

eq(manifest.default_locale, 'en', 'manifest default locale');
eq(manifest.name, '__MSG_extensionName__', 'manifest name localized');
eq(manifest.description, '__MSG_extensionDescription__', 'manifest description localized');

const required = [
  'extensionName', 'extensionDescription', 'rescan', 'saveAll', 'clear',
  'settings', 'detectedCount', 'emptyMedia', 'save', 'copyUrl',
  'settingsSaved', 'onboardingTitle', 'monitoringTitle', 'localTitle',
  'storageTitle', 'continue', 'privacyPolicy', 'permissions', 'version',
];
for (const key of required) {
  ok(en[key] && typeof en[key].message === 'string' && en[key].message.length > 0, 'en key ' + key);
  ok(ja[key] && typeof ja[key].message === 'string' && ja[key].message.length > 0, 'ja key ' + key);
}

const pages = ['popup/popup.html', 'popup/options.html', 'popup/onboarding.html'];
const usedKeys = new Set();
for (const rel of pages) {
  const html = fs.readFileSync(path.join(root, rel), 'utf8');
  ok(html.includes('src="i18n.js"'), rel + ' loads i18n.js');
  const re = /data-i18n(?:-title|-aria-label|-placeholder)?="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) usedKeys.add(m[1]);
}

const popupJs = fs.readFileSync(path.join(root, 'popup/popup.js'), 'utf8');
const optionsJs = fs.readFileSync(path.join(root, 'popup/options.js'), 'utf8');
ok(popupJs.includes('MediaSniperI18n.t'), 'popup dynamic UI uses i18n');
ok(optionsJs.includes('MediaSniperI18n.t'), 'options dynamic UI uses i18n');

for (const key of usedKeys) {
  ok(en[key] && en[key].message, 'HTML key exists in en: ' + key);
  ok(ja[key] && ja[key].message, 'HTML key exists in ja: ' + key);
}

const enKeys = Object.keys(en).sort();
const jaKeys = Object.keys(ja).sort();
eq(JSON.stringify(enKeys), JSON.stringify(jaKeys), 'ja/en locale keysets match');

report('i18n');
