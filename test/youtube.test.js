'use strict';
/* YouTube adapter tests: adaptive formats, mux item, refreshed signed URLs. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { eq, ok, report } = require('./harness.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'youtube.js'), 'utf8');

function runAdapter(playerResponses) {
  const messages = [];
  const ctx = {
    console,
    location: { hostname: 'www.youtube.com', href: 'https://www.youtube.com/watch?v=abc123' },
    window: null,
    setTimeout,
    setInterval,
    clearInterval,
  };
  const win = {
    location: ctx.location,
    fetch: function () { return Promise.resolve(new (class { clone() { return this; } text() { return Promise.resolve('{}'); } })()); },
    addEventListener: function () {},
    postMessage: function (m) { messages.push(m); },
  };
  ctx.window = win;
  ctx.XMLHttpRequest = function () {};
  ctx.XMLHttpRequest.prototype = {
    open: function () {},
    send: function () {},
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const list = Array.isArray(playerResponses) ? playerResponses : [playerResponses];
  list.forEach(function (pr) { win.ytInitialPlayerResponse = pr; });
  return messages;
}

// --- 1. progressive + audio only --------------------------------------------
{
  const msgs = runAdapter({
    videoDetails: { videoId: 'v1', title: 'Test Video', lengthSeconds: '120' },
    streamingData: {
      formats: [
        { url: 'https://g.example/v/progressive?itag=18', mimeType: 'video/mp4; codecs="avc1"', qualityLabel: '360p', contentLength: '1000', bitrate: '500000' },
      ],
      adaptiveFormats: [
        { url: 'https://g.example/a/audio?itag=140', mimeType: 'audio/mp4; codecs="mp4a"', bitrate: '130000', contentLength: '500' },
        { url: 'https://g.example/v/videoonly?itag=137', mimeType: 'video/mp4; codecs="avc1.640028"', qualityLabel: '1080p', bitrate: '3000000', contentLength: '90000' },
        { url: 'https://g.example/v/webm?itag=303', mimeType: 'video/webm; codecs="vp9"', qualityLabel: '1080p60', bitrate: '4000000', contentLength: '95000' },
      ],
    },
  });
  eq(msgs.length, 1, 'one report posted');
  const items = msgs[0].items || [];
  eq(items.length, 3, 'progressive + mux + audio = 3 items');
  eq(items[0].title, 'Test Video [360p]', 'progressive first');
  ok(items[1].title.indexOf('[1080p]+音声') >= 0, 'mux item labeled with res + 音声');
  eq(items[1].kind, 'video', 'mux item kind video');
  ok(!!items[1].audioUrl, 'mux item carries audioUrl');
  eq(items[1].size, 90500, 'mux size = video + audio');
  ok(/itag=140/.test(items[1].audioUrl), 'mux audio is the mp4 one');
  eq(items[2].kind, 'audio', 'audio-only last');
}

// --- 2. higher-bitrate Opus must not hide available m4a mux audio -----------
{
  const msgs = runAdapter({
    videoDetails: { videoId: 'v2', title: 'Mixed Audio', lengthSeconds: '10' },
    streamingData: {
      formats: [],
      adaptiveFormats: [
        { url: 'https://g.example/v/videoonly?itag=137', mimeType: 'video/mp4; codecs="avc1"', qualityLabel: '1080p', bitrate: '3000000', contentLength: '90000' },
        { url: 'https://g.example/a/m4a?itag=140', mimeType: 'audio/mp4; codecs="mp4a"', bitrate: '128000', contentLength: '500' },
        { url: 'https://g.example/a/opus?itag=251', mimeType: 'audio/webm; codecs=opus', bitrate: '160000', contentLength: '600' },
      ],
    },
  });
  const items = msgs[0].items || [];
  eq(items.length, 2, 'mixed audio: mux + best audio-only');
  ok(/itag=140/.test(items[0].audioUrl), 'mux keeps the best audio/mp4 even when Opus bitrate is higher');
  ok(/itag=251/.test(items[1].url), 'audio-only still offers the highest-bitrate audio');
  eq(items[1].ext, 'webm', 'highest-bitrate Opus remains downloadable as webm');
}

// --- 3. no mp4 video-only -> no mux item -------------------------------------
{
  const msgs = runAdapter({
    videoDetails: { videoId: 'v3', title: 'No MP4', lengthSeconds: '10' },
    streamingData: {
      formats: [],
      adaptiveFormats: [
        { url: 'https://g.example/v/webm?itag=303', mimeType: 'video/webm', qualityLabel: '1080p', bitrate: '4000000', contentLength: '95000' },
        { url: 'https://g.example/a/opus?itag=251', mimeType: 'audio/webm; codecs=opus', bitrate: '160000', contentLength: '300' },
      ],
    },
  });
  const items = msgs[0].items || [];
  eq(items.length, 1, 'webm-only: just the audio item, no mux');
  eq(items[0].kind, 'audio', 'audio item present');
}

// --- 4. opus-only audio -> no mux item ---------------------------------------
{
  const msgs = runAdapter({
    videoDetails: { videoId: 'v4', title: 'Opus Only Audio', lengthSeconds: '10' },
    streamingData: {
      formats: [],
      adaptiveFormats: [
        { url: 'https://g.example/v/videoonly?itag=137', mimeType: 'video/mp4', qualityLabel: '1080p', bitrate: '3000000', contentLength: '90000' },
        { url: 'https://g.example/a/opus?itag=251', mimeType: 'audio/webm; codecs=opus', bitrate: '160000', contentLength: '300' },
      ],
    },
  });
  const items = msgs[0].items || [];
  eq(items.length, 1, 'opus audio cannot mux into mp4: no mux item');
  eq(items[0].kind, 'audio', 'audio item still offered');
}

// --- 5. identical response dedupes, refreshed signed URL re-reports ---------
{
  function response(sig) {
    return {
      videoDetails: { videoId: 'same-video', title: 'Refresh', lengthSeconds: '10' },
      streamingData: {
        formats: [
          { url: 'https://rr.googlevideo.com/videoplayback?itag=18&sig=' + sig, mimeType: 'video/mp4', qualityLabel: '360p', contentLength: '1000' },
        ],
        adaptiveFormats: [],
      },
    };
  }
  const first = response('old');
  const refreshed = response('new');
  const msgs = runAdapter([first, first, refreshed]);
  eq(msgs.length, 2, 'same URL set dedupes but refreshed signed URLs are emitted');
  ok(/sig=old/.test(msgs[0].items[0].url), 'first signed URL reported');
  ok(/sig=new/.test(msgs[1].items[0].url), 'refreshed signed URL replaces stale report');
}

report('youtube');
