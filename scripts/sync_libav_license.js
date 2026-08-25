'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const modulePath = path.join(root, 'src/libav/libav-6.10.9.0-media-sniper.wasm.mjs');
const licensePath = path.join(root, 'LICENSE.libav');

const source = fs.readFileSync(modulePath, 'utf8');
if (!source.startsWith('/*!')) {
  throw new Error('bundled libav module does not start with the expected license header');
}

const end = source.indexOf('*/');
if (end < 0) throw new Error('bundled libav module license header is not terminated');

const header = source.slice(0, end + 2).trimEnd();
const generated = [
  'License notices extracted from the libav.js/FFmpeg WebAssembly module shipped by Media Sniper.',
  'Runtime: src/libav/libav-6.10.9.0-media-sniper.wasm.mjs / .wasm',
  'Build provenance: src/libav/PROVENANCE.json and tools/libav/config.json',
  'This file is generated from the shipped module header; do not edit it independently.',
  '',
  header,
  '',
].join('\n');

if (process.argv.includes('--check')) {
  const current = fs.readFileSync(licensePath, 'utf8');
  if (current !== generated) {
    console.error('LICENSE.libav is stale; run node scripts/sync_libav_license.js');
    process.exit(1);
  }
  console.log('LICENSE.libav matches the shipped libav module header');
  process.exit(0);
}

fs.writeFileSync(licensePath, generated);
console.log('wrote ' + licensePath);
