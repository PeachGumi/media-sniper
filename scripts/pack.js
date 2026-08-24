'use strict';
/* Pack the extension into a zip (no external deps; shells out to zip if present). */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'media-sniper.zip');

try { fs.unlinkSync(out); } catch (e) { /* ignore */ }

const includes = [
  'manifest.json',
  'LICENSE',
  'LICENSE.libav',
  'THIRD_PARTY_NOTICES.md',
  'src/logic.js',
  'src/bridge.js',
  'src/content.js',
  'src/background-entry.js',
  'src/security-bootstrap.js',
  'src/security-guard.js',
  'src/background.js',
  'src/offscreen.html',
  'src/offscreen.js',
  'src/youtube.js',
  'src/libav/libav-6.5.7.1-h264-aac-mp3.wasm.mjs',
  'src/libav/libav-6.5.7.1-h264-aac-mp3.wasm.wasm',
  'popup/popup.html',
  'popup/popup.js',
  'popup/meta.js',
  'popup/options.html',
  'popup/options.js',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
];

// verify everything exists
for (const f of includes) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) {
    console.error('missing: ' + f);
    process.exit(1);
  }
}

try {
  execSync('zip -r media-sniper.zip ' + includes.map((f) => `"${f}"`).join(' '), { cwd: root, stdio: 'inherit' });
  console.log('packed ' + out);
} catch (e) {
  console.error('zip failed: ' + e.message);
  process.exit(1);
}
