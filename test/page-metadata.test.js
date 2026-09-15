'use strict';
const fs = require('fs');
const path = require('path');
const { eq, ok, report } = require('./harness.js');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'page-metadata.js'), 'utf8');

function node(tagName, attrs, text, parent) {
  attrs = Object.assign({}, attrs || {});
  return {
    tagName: String(tagName || '').toUpperCase(),
    parentElement: parent || null,
    textContent: text == null ? '' : String(text),
    getAttribute: function (name) {
      const key = String(name || '').toLowerCase();
      const found = Object.keys(attrs).find(function (k) { return k.toLowerCase() === key; });
      return found == null ? null : String(attrs[found]);
    },
  };
}

function documentFixture(opts) {
  opts = opts || {};
  const metas = opts.metas || [];
  const scripts = opts.scripts || [];
  const media = opts.media || [];
  return {
    title: opts.title || '',
    querySelectorAll: function (selector) {
      if (selector === 'meta') return metas;
      if (selector === 'script[type="application/ld+json"]') return scripts;
      if (selector === 'video, audio, source') return media;
      if (selector === '[data-vimeo-id], [data-vimeo-url], iframe[src*="vimeo.com"]') return opts.vimeo || [];
      return [];
    },
  };
}

const ctx = { console, URL, globalThis: null, module: { exports: {} } };
ctx.globalThis = ctx;
require('vm').createContext(ctx);
require('vm').runInContext(source, ctx, { filename: 'page-metadata.js' });
const P = ctx.module.exports;
ok(!!P, 'page metadata adapter exports an API');

const video = node('video', { src: '/media/clip-without-extension', type: 'video/mp4' });
const dynamicVideo = node('video', { src: 'https://cdn.example/stale.mp4', type: 'video/webm' });
dynamicVideo.currentSrc = 'https://cdn.example/current.webm';
const audio = node('source', { src: 'https://cdn.example/audio/song.mp3', type: 'audio/mpeg' });
const vimeoElement = node('div', { 'data-vimeo-id': '123456789' });
video.parentElement = vimeoElement;
const jsonLd = node('script', {}, JSON.stringify({
  '@graph': [
    { '@type': 'VideoObject', name: 'Graph clip', contentUrl: 'https://schema.example/graph.mp4', embedUrl: 'https://player.example/embed/should-not-download' },
    { '@type': ['Thing', 'VideoObject'], contentUrl: ['data:text/plain,nope', 'https://schema.example/array.webm'] },
    { '@type': 'VideoObject', embedUrl: 'https://player.example/only-an-embed' },
  ],
}));
const longUrl = 'https://cdn.example/' + 'x'.repeat(5000) + '.mp4';
const doc = documentFixture({
  title: 'Document title',
  metas: [
    node('meta', { property: 'og:title', content: 'Open Graph title' }),
    node('meta', { property: 'og:video:secure_url', content: 'https://cdn.example/og-secure.mp4' }),
    node('meta', { property: 'og:video', content: 'https://vimeo.com/13579' }),
    node('meta', { property: 'og:video:type', content: 'video/mp4' }),
    node('meta', { property: 'og:audio', content: 'https://cdn.example/sound.mp3' }),
    node('meta', { property: 'og:audio:type', content: 'audio/mpeg' }),
    node('meta', { property: 'og:video', content: 'javascript:alert(1)' }),
    node('meta', { property: 'og:video', content: 'chrome-extension://bad/video.mp4' }),
    node('meta', { property: 'og:video', content: 'data:video/mp4;base64,AAAA' }),
    node('meta', { property: 'og:video', content: longUrl }),
  ],
  scripts: [jsonLd],
  media: [video, dynamicVideo, audio],
  vimeo: [vimeoElement, node('div', { 'data-vimeo-url': 'https://player.vimeo.com/video/24680' }), node('div', { 'data-vimeo-url': 'https://player.vimeo.com/video/' + '9'.repeat(21) }), node('div', { 'data-vimeo-url': 'https://evil.vimeo.com/video/13579' }), node('div', { 'data-vimeo-url': 'https://evil.example/video/999' })],
});

const result = P.collect(doc, 'https://site.example/watch/1');
eq(result.pageTitle, 'Open Graph title', 'Open Graph title is preferred and bounded');
ok(result.candidates.some((x) => x.url === 'https://cdn.example/og-secure.mp4' && x.kind === 'video'), 'og secure video candidate emitted');
ok(result.candidates.some((x) => x.url === 'https://cdn.example/sound.mp3' && x.kind === 'audio'), 'og audio candidate emitted');
ok(result.candidates.some((x) => x.url === 'https://schema.example/graph.mp4' && x.title === 'Graph clip'), 'VideoObject contentUrl candidate emitted');
ok(result.candidates.some((x) => x.url === 'https://schema.example/array.webm'), 'bounded @graph array candidate emitted');
ok(result.candidates.some((x) => x.url === 'https://site.example/media/clip-without-extension' && x.kind === 'video'), 'HTMLMediaElement with MIME candidate emitted');
ok(result.candidates.some((x) => x.url === 'https://cdn.example/current.webm'), 'HTMLMediaElement prefers currentSrc over stale src attribute');
ok(!result.candidates.some((x) => x.url === 'https://cdn.example/stale.mp4'), 'stale HTMLMediaElement src is not emitted when currentSrc exists');
ok(result.candidates.some((x) => x.url === 'https://cdn.example/audio/song.mp3' && x.kind === 'audio'), 'source element candidate emitted');
ok(!result.candidates.some((x) => /embed|player\.example/.test(x.url)), 'embedUrl values never become candidates');
ok(!result.candidates.some((x) => x.url === 'https://vimeo.com/13579'), 'Vimeo page URL with media MIME stays identity-only');
ok(!result.candidates.some((x) => /^(data|javascript|chrome-extension):/i.test(x.url)), 'unsafe schemes rejected');
ok(!result.candidates.some((x) => x.url === longUrl), 'overlong URL rejected');
ok(!result.candidates.some((x) => x.url.indexOf('https://cdn.example/' + 'x'.repeat(100)) === 0), 'truncated overlong URL is not emitted');
ok(result.candidates.every((x) => Object.keys(x).every((k) => k !== 'raw' && k !== 'json' && k !== 'payload')), 'candidates stay compact and omit raw JSON');
eq(result.vimeoIdentities[0].id, '123456789', 'public Vimeo data attribute yields identity only');
eq(result.vimeoIdentities[1].id, '24680', 'public Vimeo URL attribute yields a second identity');
ok(!result.vimeoIdentities.some((x) => x.id === '9'.repeat(20)), 'overlong Vimeo identity is rejected');
ok(!result.vimeoIdentities.some((x) => x.id === '13579'), 'untrusted Vimeo subdomain is rejected');
ok(result.candidates.some((x) => x.vimeoId === '123456789'), 'concrete media can carry a bounded Vimeo identity');

report('page-metadata');
