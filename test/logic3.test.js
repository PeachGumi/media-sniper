'use strict';
/* Settings + folder/blacklist logic tests (v0.10 features). */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { eq, ok, report } = require('./harness.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'logic.js'), 'utf8');
const ctx = { console, URL, Promise };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);
const L = ctx.MediaSniperLogic;

// --- sanitizeRootFolder -----------------------------------------------------
eq(L.sanitizeRootFolder('media-sniper'), 'media-sniper', 'plain folder kept');
eq(L.sanitizeRootFolder('My Videos'), 'My Videos', 'spaces kept');
eq(L.sanitizeRootFolder('a/b\\c'), 'a_b_c', 'slashes flattened');
eq(L.sanitizeRootFolder('..'), '', 'dotdot rejected');
eq(L.sanitizeRootFolder('.'), '', 'dot rejected');
eq(L.sanitizeRootFolder('  '), '', 'whitespace only -> empty');
eq(L.sanitizeRootFolder(''), '', 'empty stays empty');
eq(L.sanitizeRootFolder('con:??*'), 'con____', 'illegal chars replaced');
ok(L.sanitizeRootFolder('x'.repeat(200)).length <= 80, 'long folder trimmed to 80');

// --- filenameForItem with root ---------------------------------------------
const item = { url: 'https://cdn.example.com/v.mp4', kind: 'video', ext: 'mp4', title: 'Clip One' };
eq(L.filenameForItem(item, ''), 'Clip One.mp4', 'no root: flat (back-compat)');
eq(L.filenameForItem(item, 'media-sniper'), 'media-sniper/Clip One.mp4', 'root prefixed');
eq(L.filenameForItem(item, 'a/b'), 'a_b/Clip One.mp4', 'root sanitized before use');
const noTitle = { url: 'https://cdn.example.com/video_abc.mp4', kind: 'video', ext: 'mp4' };
eq(L.filenameForItem(noTitle, 'ms'), 'ms/video_abc.mp4', 'url-segment fallback still works under root');

// --- isBlacklisted -----------------------------------------------------------
eq(L.isBlacklisted('ads.example.com', 'example.com'), true, 'subdomain matches');
eq(L.isBlacklisted('example.com', 'example.com'), true, 'exact host matches');
eq(L.isBlacklisted('notexample.com', 'example.com'), false, 'suffix without dot does not match');
eq(L.isBlacklisted('cdn.tracker.io', 'example.com, tracker.io'), true, 'comma list works');
eq(L.isBlacklisted('a.x.com', 'example.com\nx.com'), true, 'newline list works');
eq(L.isBlacklisted('good.com', ''), false, 'empty list never blocks');
eq(L.isBlacklisted('good.com', null), false, 'null list never blocks');
eq(L.isBlacklisted('', 'x.com'), false, 'no host never blocked');
eq(L.isBlacklisted('sub.X.COM', 'x.com'), true, 'case-insensitive');

// --- itemKey: chunked CDN (googlevideo-style) keys --------------------------
const gvA = 'https://rr3---sn-abcd.googlevideo.com/videoplayback?id=VIDEO_A&itag=137&range=0-1000';
const gvB = 'https://rr3---sn-abcd.googlevideo.com/videoplayback?id=VIDEO_B&itag=137&range=0-2000';
const gvA2 = 'https://rr3---sn-abcd.googlevideo.com/videoplayback?id=VIDEO_A&itag=137&range=5000-9000';
const gvA140 = 'https://rr3---sn-abcd.googlevideo.com/videoplayback?id=VIDEO_A&itag=140&range=0-100';
eq(L.itemKey(gvA) === L.itemKey(gvB), false, 'different videos never share a key');
eq(L.itemKey(gvA) === L.itemKey(gvA2), true, 'range chunks of one track dedupe');
eq(L.itemKey(gvA) === L.itemKey(gvA140), false, 'different itags stay distinct');
eq(L.isBlacklisted('sub.X.COM', 'x.com'), true, 'case-insensitive');

// A refreshed signed URL keeps the stable item key but must replace stale
// media URLs without throwing away the richer metadata already collected.
const refreshed = L.mergeItems([
  {
    key: 'yt-track', url: 'https://g.example/videoplayback?itag=137&sig=new',
    audioUrl: 'https://g.example/videoplayback?itag=140&sig=new', kind: 'video', ext: 'mp4', size: 0,
  },
], [
  {
    key: 'yt-track', url: 'https://g.example/videoplayback?itag=137&sig=old',
    audioUrl: 'https://g.example/videoplayback?itag=140&sig=old', kind: 'video', ext: 'mp4',
    size: 9000000, title: 'Richer title', contentType: 'video/mp4', duration: 42,
    pageUrl: 'https://www.youtube.com/watch?v=track',
  },
]);
eq(refreshed.length, 1, 'refreshed signed item remains deduplicated');
eq(refreshed[0].url, 'https://g.example/videoplayback?itag=137&sig=new', 'refreshed video URL replaces stale URL');
eq(refreshed[0].audioUrl, 'https://g.example/videoplayback?itag=140&sig=new', 'refreshed audio URL replaces stale URL');
eq(refreshed[0].size, 9000000, 'richer size retained across URL refresh');
eq(refreshed[0].title, 'Richer title', 'richer title retained across URL refresh');
eq(refreshed[0].contentType, 'video/mp4', 'richer content type retained across URL refresh');

// HLS master and rendition signatures rotate without changing the logical
// playlist/quality identity. The stable key must retain quality selectors while
// dropping only transient authorization parameters.
const hlsMasterOld = 'https://cdn.example/master.m3u8?quality=720&token=old&variant=video';
const hlsMasterNew = 'https://cdn.example/master.m3u8?quality=720&token=new&variant=video';
const hlsMasterOtherQuality = 'https://cdn.example/master.m3u8?quality=1080&token=new&variant=video';
eq(L.itemKey(hlsMasterOld), L.itemKey(hlsMasterNew), 'signed HLS master refresh keeps one stable key');
eq(L.itemKey(hlsMasterOld) === L.itemKey(hlsMasterOtherQuality), false, 'HLS quality identity remains in stable key');
const hlsVariantOld = { url: 'https://cdn.example/v720.m3u8?quality=720&sig=old', bandwidth: 800000, resolution: '1280x720' };
const hlsVariantNew = { url: 'https://cdn.example/v720.m3u8?quality=720&sig=new', bandwidth: 800000, resolution: '1280x720' };
const variantsAfterRefresh = L.normalizeHlsVariants([hlsVariantOld, hlsVariantNew]);
eq(variantsAfterRefresh.length, 1, 'signed HLS rendition refresh does not duplicate quality');
eq(variantsAfterRefresh[0].url, hlsVariantNew.url, 'signed HLS rendition uses newest URL');
eq(L.hlsVariantKey(hlsVariantOld), L.hlsVariantKey(hlsVariantNew), 'HLS selection key survives signature rotation');

// --- HLS URI resolution (root-relative URIs killed whole downloads) --------
// ffmpeg resolves a playlist's URIs against its input URL, and with a
// `jsfetch:https://host/...` input a root-relative URI loses the host
// ("jsfetch:/media/seg1.ts"). X's manifests are root-relative throughout, so
// the worker now resolves every URI itself before ffmpeg sees the playlist.
const rwBase = 'https://video.example.com/amplify/123/pl/abc.m3u8?tag=29';
const rwSrc = [
  '#EXTM3U',
  '#EXT-X-VERSION:6',
  '#EXT-X-MAP:URI="/amplify/123/aud/init.mp4"',
  '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
  '#EXT-X-BYTERANGE:1000@0',
  '#EXTINF:3.000,',
  '/amplify/123/aud/0/seg0.m4s',
  '#EXTINF:3.000,',
  'relative/seg1.m4s',
  '#EXTINF:3.000,',
  'https://cdn.example.com/abs/seg2.m4s',
  '#EXT-X-ENDLIST',
].join('\n');
const rw = L.rewriteHlsUrisAbs(rwSrc, rwBase);
eq(rw.rewritten, 5, 'every URI in the playlist is rewritten');
ok(rw.text.indexOf('jsfetch:https://video.example.com/amplify/123/aud/init.mp4') >= 0,
  'root-relative EXT-X-MAP keeps the host');
ok(rw.text.indexOf('jsfetch:https://video.example.com/amplify/123/pl/key.bin') >= 0,
  'a relative AES key resolves against the playlist');
ok(rw.text.indexOf('jsfetch:https://video.example.com/amplify/123/aud/0/seg0.m4s') >= 0,
  'root-relative segment keeps the host');
ok(rw.text.indexOf('jsfetch:https://video.example.com/amplify/123/pl/relative/seg1.m4s') >= 0,
  'relative segment resolves against the playlist directory');
ok(rw.text.indexOf('jsfetch:https://cdn.example.com/abs/seg2.m4s') >= 0,
  'absolute segment gets the jsfetch prefix (no http protocol in this build)');
ok(rw.text.indexOf('URI="/') === -1, 'no root-relative URI is left behind');
ok(rw.text.indexOf('#EXT-X-BYTERANGE:1000@0') >= 0, 'byte ranges are untouched');
ok(rw.text.indexOf('?tag=29') === -1, 'segment URIs are not given the playlist token');
const rwNoop = L.rewriteHlsUrisAbs('#EXTM3U\n#EXT-X-ENDLIST\n', null);
eq(rwNoop.rewritten, 0, 'without a base URL nothing is rewritten');
eq(rwNoop.text.indexOf('EXTM3U') >= 0, true, 'the playlist text survives an empty base');

report('logic3');
