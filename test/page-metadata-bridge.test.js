'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { eq, ok, report } = require('./harness.js');

const logicSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'logic.js'), 'utf8');
const metadataSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'page-metadata.js'), 'utf8');
const bridgeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'bridge.js'), 'utf8');

function node(tagName, attrs, text) {
  attrs = Object.assign({}, attrs || {});
  return {
    tagName: String(tagName || '').toUpperCase(),
    textContent: text == null ? '' : String(text),
    parentElement: null,
    getAttribute: function (name) {
      const key = String(name || '').toLowerCase();
      const found = Object.keys(attrs).find(function (k) { return k.toLowerCase() === key; });
      return found == null ? null : String(attrs[found]);
    },
  };
}

const meta = node('meta', { property: 'og:title', content: 'Bridge title' });
const ogVideo = node('meta', { property: 'og:video', content: 'https://cdn.test/metadata/no-extension' });
const ogType = node('meta', { property: 'og:video:type', content: 'video/mp4' });
const unsafe = node('meta', { property: 'og:video', content: 'javascript:alert(1)' });
const jsonLd = node('script', {}, JSON.stringify({
  '@graph': [{ '@type': 'VideoObject', name: 'JSON-LD title', contentUrl: 'https://cdn.test/schema/clip.webm' }],
}));
const observed = node('video', { src: 'https://cdn.test/observed/no-extension' });
const vimeoOnly = node('div', { 'data-vimeo-id': '987654321' });
const elements = [observed];
const metas = [meta, ogVideo, ogType, unsafe];
const scripts = [jsonLd];
const posted = [];
const messageHandlers = [];
const intervalCbs = [];

const ctx = {
  console,
  URL,
  Promise,
  setTimeout: function (fn) { return { fn }; },
  setInterval: function (fn) { intervalCbs.push(fn); return intervalCbs.length; },
  clearInterval: function () {},
  location: { href: 'https://site.test/watch/1' },
  document: {
    title: 'Document title',
    querySelectorAll: function (selector) {
      if (selector === 'meta') return metas;
      if (selector === 'script[type="application/ld+json"]') return scripts;
      if (selector === '[data-vimeo-id], [data-vimeo-url], iframe[src*="vimeo.com"]') return [vimeoOnly];
      if (selector === 'video, video source, audio' || selector === 'video, audio, source') return elements;
      return [];
    },
  },
};
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.addEventListener = function (type, fn) { if (type === 'message') messageHandlers.push(fn); };
ctx.postMessage = function (data) { posted.push(data); };
let fetchCalls = 0;
ctx.fetch = function () { fetchCalls++; return Promise.resolve({ ok: true }); };
ctx.__fetch = ctx.fetch;
vm.createContext(ctx);
vm.runInContext(logicSrc, ctx);
vm.runInContext(metadataSrc, ctx);
vm.runInContext(bridgeSrc, ctx);

const scan = intervalCbs[0];
ok(typeof scan === 'function', 'bridge scan interval registered');
eq(ctx.fetch, ctx.__fetch, 'metadata adapter preserves fetch without wrapping');

const metaEmit = posted.find((x) => x.type === 'media' && x.url === 'https://cdn.test/metadata/no-extension');
ok(!!metaEmit, 'Open Graph metadata travels through bridge media pipeline');
eq(metaEmit && metaEmit.via, 'metadata', 'metadata candidate is marked metadata');
eq(metaEmit && metaEmit.title, 'Bridge title', 'metadata title is compactly forwarded');
const schemaEmit = posted.find((x) => x.type === 'media' && x.url === 'https://cdn.test/schema/clip.webm');
ok(!!schemaEmit, 'JSON-LD candidate travels through bridge');
eq(schemaEmit && schemaEmit.title, 'JSON-LD title', 'JSON-LD name is forwarded as title');
const observedEmit = posted.find((x) => x.type === 'media' && x.url === 'https://cdn.test/observed/no-extension');
ok(!!observedEmit, 'HTMLMediaElement URL travels through bridge');
eq(observedEmit && observedEmit.title, 'Bridge title', 'observed media gets page metadata title');
ok(!posted.some((x) => x.url && /^javascript:/i.test(x.url)), 'unsafe metadata URL never emitted');
ok(posted.every((x) => !('raw' in x) && !('json' in x)), 'bridge payloads contain no raw JSON');
ok(!posted.some((x) => x.url && x.url.indexOf('987654321') >= 0), 'Vimeo identity without media URL is not a media candidate');

// Repeated periodic scans must not re-emit unchanged metadata records.
const beforeRepeat = posted.filter((x) => x.via === 'metadata').length;
scan();
eq(posted.filter((x) => x.via === 'metadata').length, beforeRepeat, 'periodic metadata scan is deduplicated');

// A later DOM metadata node is picked up by a forced rescan, but a second
// forced rescan does not multiply the same metadata hint.
metas.push(node('meta', { property: 'og:audio', content: 'https://cdn.test/new/song.mp3' }));
messageHandlers.forEach(function (fn) { fn({ data: { source: 'media-sniper-content', type: 'scan' } }); });
ok(posted.some((x) => x.url === 'https://cdn.test/new/song.mp3' && x.kind === 'audio'), 'forced scan sees newly added metadata');
const newCount = posted.filter((x) => x.url === 'https://cdn.test/new/song.mp3').length;
messageHandlers.forEach(function (fn) { fn({ data: { source: 'media-sniper-content', type: 'scan' } }); });
eq(posted.filter((x) => x.url === 'https://cdn.test/new/song.mp3').length, newCount, 'forced metadata scan stays double-execution safe');

// Loading the real bridge a second time is safe and does not install another
// observer/timer or emit the initial metadata batch again.
const handlerCount = messageHandlers.length;
const postedCount = posted.length;
vm.runInContext(bridgeSrc, ctx, { filename: 'bridge.js (again)' });
eq(messageHandlers.length, handlerCount, 'bridge second execution installs no duplicate handlers');
eq(posted.length, postedCount, 'bridge second execution emits nothing');

eq(fetchCalls, 0, 'metadata detection performs no page fetch');
report('page-metadata-bridge');
