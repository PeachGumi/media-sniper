'use strict';
const { eq, ok, report } = require('./harness.js');
const S = require('../src/security-guard.js');

// Header capture is deliberately narrow. Arbitrary X-* headers often contain
// API/CSRF/session tokens unrelated to media and must not enter the media cache.
eq(S.captureAllowedName('Authorization'), true, 'capture Authorization');
eq(S.captureAllowedName('Referer'), true, 'capture Referer');
eq(S.captureAllowedName('Origin'), true, 'capture Origin');
eq(S.captureAllowedName('X-CSRF-Token'), false, 'do not capture arbitrary X-*');
eq(S.captureAllowedName('X-API-Key'), false, 'do not capture API keys');

// Replayed credentials are origin-bound and the internal origin marker never
// reaches the network.
{
  const headers = {
    Authorization: 'Bearer secret',
    Referer: 'https://page.example/watch',
    Origin: 'https://page.example',
    'X-CSRF-Token': 'csrf-secret',
    'X-Media-Sniper-Source-Origin': 'https://media.example',
  };
  const same = S.sanitizeHeadersForTargets(headers, ['https://media.example/video.mp4']);
  eq(same.Authorization, 'Bearer secret', 'same-origin Authorization preserved');
  eq(same['X-CSRF-Token'], 'csrf-secret', 'same-origin sensitive header preserved if explicitly supplied');
  eq(same['X-Media-Sniper-Source-Origin'], undefined, 'internal marker stripped');

  const cross = S.sanitizeHeadersForTargets(headers, ['https://cdn.other.example/video.mp4']);
  eq(cross.Authorization, undefined, 'cross-origin Authorization stripped');
  eq(cross['X-CSRF-Token'], undefined, 'cross-origin X-* stripped');
  eq(cross.Referer, undefined, 'cross-origin Referer stripped');
  eq(cross.Origin, undefined, 'cross-origin Origin stripped');

  const mixed = S.sanitizeHeadersForTargets(headers, [
    'https://media.example/a.ts',
    'https://cdn.other.example/b.ts',
  ]);
  eq(mixed.Authorization, undefined, 'shared header set fails closed if any target changes origin');
}

// Response promotion only treats actual media as media.
eq(S.responseLooksMedia({ statusCode: 200, url: 'https://a.example/api', responseHeaders: [{ name: 'Content-Type', value: 'application/json' }] }), false, 'JSON is not promoted');
eq(S.responseLooksMedia({ statusCode: 200, url: 'https://a.example/video', responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }] }), true, 'video MIME promoted');
eq(S.responseLooksMedia({ statusCode: 200, url: 'https://a.example/master.m3u8', responseHeaders: [] }), true, 'm3u8 URL promoted');
eq(S.responseLooksMedia({ statusCode: 403, url: 'https://a.example/video.mp4', responseHeaders: [] }), false, 'failed response not promoted');

// Page/content-script messages are untrusted and are normalized before the
// background pipeline sees them.
{
  const sender = {
    id: 'extid',
    url: 'https://site.example/frame',
    tab: { id: 9, url: 'https://site.example/watch' },
  };
  const n = S.normalizeInboundMessage({
    type: 'ms-report',
    tabId: 999,
    items: [{
      url: 'https://cdn.example/video.mp4',
      kind: 'video',
      via: 'element',
      pageUrl: 'https://attacker.invalid/fake',
      size: -100,
      duration: '12.5',
    }],
  }, sender, 'extid');
  ok(n.ok, 'valid content report accepted');
  eq(n.msg.tabId, undefined, 'content cannot choose a tab id');
  eq(n.msg.items.length, 1, 'one valid item preserved');
  eq(n.msg.items[0].pageUrl, 'https://site.example/frame', 'pageUrl comes from sender, not payload');
  eq(n.msg.items[0].size, 0, 'negative size normalized');
  eq(n.msg.items[0].duration, 12.5, 'duration normalized');

  const metadata = S.normalizeInboundMessage({
    type: 'ms-report',
    items: [{
      url: 'https://cdn.example/clip.mp4', kind: 'video', via: 'metadata',
      metadataSource: 'og', title: 'Clip', vimeoId: '123456789',
    }],
  }, sender, 'extid');
  ok(metadata.ok && metadata.msg.items.length === 1, 'generic metadata report accepted');
  eq(metadata.msg.items[0] && metadata.msg.items[0].metadataSource, 'og', 'metadata source preserved compactly');
  eq(metadata.msg.items[0] && metadata.msg.items[0].vimeoId, '123456789', 'bounded Vimeo identity preserved');
  const metadataHints = S.normalizeInboundMessage({
    type: 'ms-report',
    items: [
      { url: 'https://player.vimeo.com/video/123456789', kind: 'video', via: 'metadata', contentType: 'video/mp4' },
      { url: 'https://vimeo.com/13579', kind: 'video', via: 'metadata', contentType: 'video/mp4' },
      { url: 'https://site.example/player', kind: 'video', via: 'metadata' },
      { url: 'https://cdn.example/fake.mp4', kind: 'video', via: 'metadata', contentType: 'text/html' },
      { url: 'https://cdn.example/' + 'x'.repeat(5000) + '.mp4', kind: 'video', via: 'metadata' },
    ],
  }, sender, 'extid');
  eq(metadataHints.msg.items.length, 0, 'metadata-only/player/overlong hints rejected');
}

// A content script/web page must never invoke privileged download operations.
{
  const contentSender = { id: 'extid', url: 'https://site.example/', tab: { id: 1, url: 'https://site.example/' } };
  const popupSender = { id: 'extid', url: 'chrome-extension://extid/popup/popup.html' };
  eq(S.normalizeInboundMessage({ type: 'ms-download', item: {} }, contentSender, 'extid').ok, false, 'content sender cannot download');
  eq(S.normalizeInboundMessage({ type: 'ms-download', item: {} }, popupSender, 'extid').ok, true, 'own popup may download');
  eq(S.normalizeInboundMessage({ type: 'ms-get-jobs' }, popupSender, 'extid').ok, true, 'own popup may read global jobs');
  eq(S.normalizeInboundMessage({ type: 'ms-get-jobs' }, contentSender, 'extid').ok, false, 'content sender cannot read global jobs');
  eq(S.normalizeInboundMessage({ type: 'ms-set-settings', settings: {} }, contentSender, 'extid').ok, false, 'content sender cannot change settings');
  eq(S.normalizeInboundMessage({ type: 'ms-select-quality', itemKey: 'master', variantKey: 'variant' }, popupSender, 'extid').ok, true, 'own popup may select quality');
}

// The YouTube adapter is accepted only from YouTube and only for its expected
// media hosts; a page cannot use the well-known marker to inject arbitrary URLs.
{
  const ytSender = { id: 'extid', url: 'https://www.youtube.com/watch?v=abc', tab: { id: 1, url: 'https://www.youtube.com/watch?v=abc' } };
  const good = S.normalizeInboundMessage({
    type: 'ms-report',
    items: [{ url: 'https://rr1---sn.example.googlevideo.com/videoplayback?itag=18', kind: 'video', via: 'youtube' }],
  }, ytSender, 'extid');
  eq(good.msg.items.length, 1, 'YouTube googlevideo item accepted');
  const bad = S.normalizeInboundMessage({
    type: 'ms-report',
    items: [{ url: 'https://evil.example/payload', kind: 'video', via: 'youtube' }],
  }, ytSender, 'extid');
  eq(bad.msg.items.length, 0, 'YouTube arbitrary host rejected');
  const badAudio = S.normalizeInboundMessage({
    type: 'ms-report',
    items: [{
      url: 'https://rr1---sn.example.googlevideo.com/videoplayback?itag=137',
      audioUrl: 'https://evil.example/audio.mp4', kind: 'video', via: 'youtube',
    }],
  }, ytSender, 'extid');
  eq(badAudio.msg.items.length, 0, 'YouTube audio URL outside YouTube/googlevideo rejected');
}

// Integration: prepare()/activate() must install the promotion listener before
// background's response listener, otherwise authenticated playlists race and
// miss their captured header on the first response.
{
  function fakeEvent() {
    const listeners = [];
    return {
      listeners,
      addListener: function (fn) { listeners.push(fn); },
    };
  }

  const sendHeadersEvent = fakeEvent();
  const responseEvent = fakeEvent();
  const runtimeEvent = fakeEvent();
  const storageChanged = fakeEvent();
  const fakeChrome = {
    runtime: {
      id: 'extid',
      onMessage: runtimeEvent,
      sendMessage: function (m) { return Promise.resolve(m); },
    },
    webRequest: {
      onSendHeaders: sendHeadersEvent,
      onResponseStarted: responseEvent,
    },
    storage: {
      local: { get: function () { return Promise.resolve({ blacklist: '' }); } },
      onChanged: storageChanged,
    },
  };

  const oldFetch = globalThis.fetch;
  globalThis.fetch = function () { return Promise.resolve({ ok: true }); };

  S.prepare(fakeChrome);

  let promoted = null;
  let backgroundSawPromotion = false;
  // Match background.js registration order: response listener first, then
  // send-headers listener.
  fakeChrome.webRequest.onResponseStarted.addListener(function () {
    backgroundSawPromotion = !!promoted;
  }, { urls: ['<all_urls>'] }, ['responseHeaders']);
  fakeChrome.webRequest.onSendHeaders.addListener(function (details) {
    promoted = details;
  }, { urls: ['<all_urls>'] }, ['requestHeaders']);

  let handledMessage = null;
  fakeChrome.runtime.onMessage.addListener(function (msg) {
    handledMessage = msg;
    return false;
  });

  S.activate(fakeChrome);
  eq(sendHeadersEvent.listeners.length, 1, 'one real request-header buffer listener installed');
  eq(responseEvent.listeners.length, 2, 'promotion + background response listeners installed');

  const req = {
    requestId: 'media-1',
    url: 'https://media.example/master.m3u8',
    requestHeaders: [
      { name: 'Authorization', value: 'Bearer media-secret' },
      { name: 'X-CSRF-Token', value: 'must-not-be-captured' },
    ],
  };
  const resp = {
    requestId: 'media-1',
    statusCode: 200,
    url: req.url,
    responseHeaders: [{ name: 'Content-Type', value: 'application/vnd.apple.mpegurl' }],
  };
  sendHeadersEvent.listeners[0](req);
  responseEvent.listeners[0](resp); // security promotion
  responseEvent.listeners[1](resp); // background detector
  ok(!!promoted, 'media response promotes request headers');
  eq(promoted.requestHeaders.some(function (h) { return h.name.toLowerCase() === 'authorization'; }), true, 'Authorization promoted');
  eq(promoted.requestHeaders.some(function (h) { return h.name.toLowerCase() === 'x-csrf-token'; }), false, 'arbitrary X-* never promoted');
  eq(promoted.requestHeaders.some(function (h) { return h.name.toLowerCase() === S.META_SOURCE_ORIGIN; }), true, 'source origin metadata attached internally');
  eq(backgroundSawPromotion, true, 'promotion runs before background response handler');

  promoted = null;
  backgroundSawPromotion = false;
  const jsonReq = {
    requestId: 'api-1',
    url: 'https://media.example/api/me',
    requestHeaders: [{ name: 'Authorization', value: 'Bearer account-secret' }],
  };
  const jsonResp = {
    requestId: 'api-1', statusCode: 200, url: jsonReq.url,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
  };
  sendHeadersEvent.listeners[0](jsonReq);
  responseEvent.listeners[0](jsonResp);
  responseEvent.listeners[1](jsonResp);
  eq(promoted, null, 'non-media Authorization never promoted');

  const contentSender = { id: 'extid', url: 'https://site.example/', tab: { id: 1, url: 'https://site.example/' } };
  let rejection = null;
  runtimeEvent.listeners[0]({ type: 'ms-download', item: {} }, contentSender, function (r) { rejection = r; });
  eq(handledMessage, null, 'rejected privileged content message never reaches background');
  ok(rejection && /rejected/.test(rejection.error), 'rejected sender receives explicit error');

  const popupSender = { id: 'extid', url: 'chrome-extension://extid/popup/popup.html' };
  runtimeEvent.listeners[0]({ type: 'ms-queue-status' }, popupSender, function () {});
  eq(handledMessage.type, 'ms-queue-status', 'trusted extension UI message reaches background');

  globalThis.fetch = oldFetch;
}

report('security-guard');
