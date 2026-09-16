/* Content-script thumbnails: the page holds the still, so the content script
 * produces it (a playing frame when the pixels are readable, otherwise the
 * element's poster, otherwise the page's social image). VDH shows a thumbnail
 * per entry too; these tests pin ours, including the cases where nothing can be
 * shown. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { eq, ok, report } = require('./harness.js');

const contentSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'content.js'), 'utf8');

function makeCtx(options) {
  const opts = options || {};
  const media = (opts.media || []).map(function (spec) {
    const el = {
      tagName: spec.tagName || 'VIDEO',
      currentSrc: spec.currentSrc || '',
      src: spec.src || '',
      poster: spec.poster || '',
      videoWidth: spec.videoWidth || 0,
      videoHeight: spec.videoHeight || 0,
      paused: spec.paused !== false,
      currentTime: spec.currentTime || 0,
      duration: spec.duration || 0,
      querySelectorAll: function () { return spec.sources || []; },
    };
    return el;
  });
  const meta = opts.meta || {};
  const fetchCalls = [];
  const document = {
    head: { appendChild: function () {} },
    documentElement: { appendChild: function () {} },
    title: 'Thumbnail fixture',
    createElement: function (tag) {
      if (tag === 'canvas') {
        return {
          width: 0, height: 0,
          getContext: function () { return { drawImage: function () {} }; },
          toDataURL: function () {
            if (opts.tainted) throw new Error('SecurityError');
            return 'data:image/jpeg;base64,FRAME';
          },
        };
      }
      return { async: true, src: '', onload: null, remove: function () {} };
    },
    addEventListener: function () {},
    querySelector: function (selector) {
      return meta[selector] || null;
    },
    querySelectorAll: function (selector) {
      return /video|audio/.test(selector) ? media : [];
    },
  };
  const listeners = [];
  const ctx = {
    console,
    chrome: {
      runtime: {
        getURL: function (file) { return 'chrome-extension://extid/' + file; },
        lastError: null,
        sendMessage: function () {},
        onMessage: { addListener: function (fn) { listeners.push(fn); } },
      },
    },
    document,
    location: { href: opts.href || 'https://site.test/watch/1', hostname: 'site.test' },
    setTimeout: function (fn) { return 1; },
    setInterval: function () { return 1; },
    clearInterval: function () {},
    window: null,
    globalThis: null,
    fetch: function (url) {
      fetchCalls.push({ url: url, init: arguments[1] });
      const answer = opts.fetchAnswer || {};
      return Promise.resolve({
        ok: answer.ok !== false,
        headers: { get: function () { return answer.contentLength == null ? null : String(answer.contentLength); } },
        blob: function () {
          if (answer.throwOnBlob) return Promise.reject(new Error('blocked'));
          return Promise.resolve({ size: answer.size == null ? 32 : answer.size });
        },
      });
    },
    URL: URL,
    Promise: Promise,
    FileReader: function () {
      const self = this;
      this.readAsDataURL = function () {
        Promise.resolve().then(function () {
          if (opts.readerFails) { if (self.onerror) self.onerror(); return; }
          self.result = opts.readerResult === undefined ? 'data:image/png;base64,POSTER' : opts.readerResult;
          if (self.onload) self.onload();
        });
      };
    },
    Array: Array,
  };
  ctx.window = ctx;
  ctx.top = ctx;
  ctx.globalThis = ctx;
  ctx.addEventListener = function () {};
  vm.createContext(ctx);
  vm.runInContext(contentSrc, ctx, { filename: 'content.js' });
  return { ctx: ctx, listener: listeners[0], fetchCalls: fetchCalls };
}

function ask(listener, url) {
  return new Promise(function (resolve) {
    const handled = listener({ type: 'ms-thumbnail', url: url }, {}, resolve);
    if (handled !== true) resolve(undefined);
  });
}

(async function () {
  // ---- a frame from the element the page is playing -----------------------
  {
    const env = makeCtx({ media: [{ currentSrc: 'https://site.test/media/clip.mp4', videoWidth: 1280, videoHeight: 720 }] });
    const result = await ask(env.listener, 'https://site.test/media/clip.mp4');
    eq(result && result.thumb, 'data:image/jpeg;base64,FRAME', 'the playing element becomes the thumbnail');
    eq(result && result.source, 'frame', 'frame source is reported');
    eq(env.fetchCalls.length, 0, 'a readable frame needs no extra fetch');
  }

  // ---- a cross-origin frame cannot be read: fall back to the poster -------
  {
    const env = makeCtx({
      media: [{ currentSrc: 'https://site.test/clip.mp4', videoWidth: 640, videoHeight: 360, poster: 'https://cdn.test/poster.jpg' }],
      tainted: true,
    });
    const result = await ask(env.listener, 'https://site.test/clip.mp4');
    eq(result && result.thumb, 'data:image/png;base64,POSTER', 'a tainted frame falls back to the poster');
    eq(result && result.source, 'poster', 'poster source is reported');
    eq(env.fetchCalls.length, 1, 'the poster is read through the page session');
    eq(env.fetchCalls[0].init.credentials, 'include', 'the poster read carries cookies');
  }

  // ---- poster too large for an inline copy: keep the URL ------------------
  {
    const env = makeCtx({
      media: [{ currentSrc: 'https://site.test/clip.mp4', videoWidth: 640, videoHeight: 360, poster: 'https://cdn.test/huge.jpg' }],
      tainted: true, fetchAnswer: { contentLength: 8 * 1024 * 1024 },
    });
    const result = await ask(env.listener, 'https://site.test/clip.mp4');
    eq(result && result.thumb, 'https://cdn.test/huge.jpg', 'an oversized still stays a URL');
    eq(result && result.source, 'poster-url', 'the URL form is reported');
  }

  // ---- no element at all: the page's social image -------------------------
  {
    const env = makeCtx({
      meta: { 'meta[property="og:image"]': { content: '/social/cover.png' } },
    });
    const result = await ask(env.listener, 'https://site.test/stream/master.m3u8');
    eq(result && result.thumb, 'data:image/png;base64,POSTER', 'the page social image is used when no element matches');
    eq(result && result.source, 'page', 'page source is reported');
    eq(env.fetchCalls[0].url, 'https://site.test/social/cover.png', 'a relative social image is resolved');
  }

  // ---- nothing to show ----------------------------------------------------
  {
    const env = makeCtx({});
    const result = await ask(env.listener, 'https://site.test/stream/master.m3u8');
    ok(!result || !result.thumb, 'no element and no social image yields no thumbnail');
    eq(env.fetchCalls.length, 0, 'nothing to show means no extra request');
  }
  {
    const env = makeCtx({ meta: { 'meta[property="og:image"]': { content: 'https://cdn.test/x.png' } }, fetchAnswer: { ok: false } });
    const result = await ask(env.listener, 'https://site.test/stream/master.m3u8');
    eq(result && result.thumb, 'https://cdn.test/x.png', 'a blocked inline read still leaves a usable URL');
    eq(result && result.source, 'page-url', 'the URL form is reported for the page image');
  }

  // ---- the element for a manifest item is the page's main player ----------
  {
    const env = makeCtx({
      media: [
        { currentSrc: 'blob:https://site.test/aaaa', videoWidth: 0, videoHeight: 0, paused: true },
        { currentSrc: 'blob:https://site.test/bbbb', videoWidth: 1920, videoHeight: 1080, paused: false, currentTime: 12 },
      ],
    });
    const result = await ask(env.listener, 'https://site.test/stream/master.m3u8');
    eq(result && result.source, 'frame', 'an HLS item uses the page player when URLs do not match');
    ok(result && result.thumb, 'the page player still yields a still');
  }

  report('thumbnail-content');
})().catch(function (err) {
  console.error('FAIL thumbnail-content:', err && err.stack || err);
  process.exit(1);
});
