/* The packaged artifact must contain every script the extension loads at
 * runtime. A new file (src/host-access.js) was imported by the worker entry but
 * missing from the packer's include list: the zip shipped, the service worker
 * died on importScripts in the packaged build, and only the packaged-artifact
 * E2E in CI noticed. Unit tests and the repo-checkout E2E both passed, because
 * neither reads the include list. This test closes that gap. */
'use strict';

const fs = require('fs');
const path = require('path');
const { ok, eq, report } = require('./harness.js');

const root = path.join(__dirname, '..');
const pack = require(path.join(root, 'scripts', 'pack.js'));
const included = new Set(pack.includes);
const referenced = new Set();

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function add(rel) {
  if (!rel) return;
  const clean = String(rel).replace(/^\.\//, '').replace(/^\/+/, '');
  if (!clean || /^(https?:|data:|chrome-extension:)/.test(clean)) return;
  referenced.add(clean);
}

function resolveFrom(file, target) {
  if (!target || /^(https?:|data:|chrome-extension:|#)/.test(target)) return null;
  return path.normalize(path.join(path.dirname(file), target)).split(path.sep).join('/');
}

// ---- manifest ------------------------------------------------------------
const manifest = JSON.parse(read('manifest.json'));
add(manifest.background && manifest.background.service_worker);
for (const entry of manifest.content_scripts || []) for (const f of entry.js || []) add(f);
for (const res of manifest.web_accessible_resources || []) {
  const list = Array.isArray(res) ? res : (res.resources || []);
  for (const f of list) add(f);
}

// ---- worker entry --------------------------------------------------------
for (const m of read('src/background-entry.js').matchAll(/importScripts\(\s*'([^']+)'\s*\)/g)) add(m[1]);

// ---- packaged documents --------------------------------------------------
for (const html of ['src/offscreen.html', 'popup/popup.html', 'popup/options.html', 'popup/onboarding.html']) {
  for (const m of read(html).matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) add(resolveFrom(html, m[1]));
}

// ---- dynamically registered content scripts ------------------------------
for (const m of read('src/site-access.js').matchAll(/js:\s*\[([^\]]*)\]/g)) {
  for (const q of m[1].matchAll(/'([^']+)'/g)) add(q[1]);
}

// ---- files injected into the page world ----------------------------------
for (const m of read('src/content.js').matchAll(/'(src\/[A-Za-z0-9/._-]+\.js)'/g)) add(m[1]);

// ---- wasm/module paths the offscreen document loads at runtime -----------
for (const m of read('src/offscreen.js').matchAll(/'(src\/[A-Za-z0-9/._-]+\.(?:js|mjs))'/g)) add(m[1]);
for (const m of read('src/offscreen-streaming.js').matchAll(/'(src\/[A-Za-z0-9/._-]+\.(?:js|mjs))'/g)) add(m[1]);

// Only assert on references that exist: a stale string literal in the code is a
// different (already harmless) problem, while "exists but not packed" is exactly
// the failure this test is for.
const existing = Array.from(referenced).filter(function (rel) {
  return fs.existsSync(path.join(root, rel));
}).sort();

ok(existing.length >= 15, 'found the scripts the extension loads (' + existing.length + ')');
const missing = existing.filter(function (rel) { return !included.has(rel); });
eq(missing, [], 'every runtime-loaded script is in the packaged file list');
ok(included.has('src/host-access.js'), 'the host-access helper is packaged');
ok(included.has('src/offscreen.js'), 'the offscreen document script is packaged');
ok(included.has('popup/popup.js'), 'the popup script is packaged');

report('pack-manifest');
