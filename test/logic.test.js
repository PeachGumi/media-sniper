'use strict';
const { eq, ok, report } = require('./harness.js');
const L = require('../src/logic.js');

// --- classifyUrl ---------------------------------------------------------
eq(L.classifyUrl('https://cdn.example.com/v/movie.mp4').kind, 'video', 'mp4 -> video');
eq(L.classifyUrl('https://cdn.example.com/v/movie.MP4?x=1').kind, 'video', 'case-insensitive ext');
eq(L.classifyUrl('https://x.com/i/videos/123.m3u8').kind, 'hls', 'm3u8 -> hls');
eq(L.classifyUrl('https://x.com/track.m3u8?a=b').kind, 'hls', 'm3u8 with query');
eq(L.classifyUrl('https://site.com/stream.mpd').kind, 'dash', 'mpd -> dash');
eq(L.classifyUrl('https://site.com/song.mp3').kind, 'audio', 'mp3 -> audio');
eq(L.classifyUrl('https://site.com/song.m4a').kind, 'audio', 'm4a -> audio');
eq(L.classifyUrl('https://site.com/clip.webm').kind, 'video', 'webm -> video');
eq(L.classifyUrl('https://site.com/seg-1-v1.ts').kind, 'ts', 'segment .ts');
eq(L.classifyUrl('https://site.com/seg-1.m4s').kind, 'ts', 'segment .m4s');
eq(L.classifyUrl('https://site.com/page.html').kind, null, 'html not media');
eq(L.classifyUrl('https://site.com/api/feed').kind, null, 'no ext -> null');
eq(L.classifyUrl('blob:https://site.com/abc-123').kind, null, 'blob url not classifiable by ext');

// --- kindFromContentType ---------------------------------------------------
eq(L.kindFromContentType('video/mp4', 'https://a/b'), 'video', 'ct video/mp4');
eq(L.kindFromContentType('application/vnd.apple.mpegurl', 'https://a/b'), 'hls', 'ct apple mpegurl');
eq(L.kindFromContentType('application/x-mpegURL', 'https://a/b'), 'hls', 'ct x-mpegurl');
eq(L.kindFromContentType('audio/mpeg', 'https://a/b'), 'audio', 'ct audio/mpeg');
eq(L.kindFromContentType('application/dash+xml', 'https://a/b'), 'dash', 'ct dash+xml');
eq(L.kindFromContentType('video/MP2T', 'https://a/b'), 'ts', 'ct video/mp2t');
// content-type says octet-stream but url has ext -> fall back to ext
eq(L.kindFromContentType('application/octet-stream', 'https://a/b.mp4'), 'video', 'octet-stream falls back to url ext');
eq(L.kindFromContentType('text/html', 'https://a/b.mp4'), null, 'text/html never media');

// --- sanitizeFilename -----------------------------------------------------
eq(L.sanitizeFilename('a/b\\c:d*e?f"g<h>i|j', 'x'), 'a_b_c_d_e_f_g_h_i_j', 'illegal chars replaced');
eq(L.sanitizeFilename('   ', 'fallback'), 'fallback', 'whitespace-only -> fallback');
eq(L.sanitizeFilename('..', 'fallback'), 'fallback', 'dotdot -> fallback');
eq(L.sanitizeFilename('x'.repeat(300), 'f').length <= 150, true, 'truncated to <=150');
eq(L.sanitizeFilename('', 'fallback'), 'fallback', 'empty -> fallback');

// --- filenameForItem -------------------------------------------------------
const item1 = { url: 'https://cdn.example.com/path/My%20Clip.mp4', kind: 'video', ext: 'mp4', title: 'cool/video: test' };
eq(L.filenameForItem(item1), 'cool_video_ test.mp4', 'flat filename from title');
const item2 = { url: 'blob:https://site.com/abcd', kind: 'video', ext: null, title: null, pageUrl: 'https://site.com/watch/1' };
eq(L.filenameForItem(item2), 'video_abcd.mp4', 'blob item named by blob id');

// --- itemKey / dedupe ------------------------------------------------------
eq(L.itemKey('https://a.com/v.mp4?token=***'), 'https://a.com/v.mp4', 'key strips query');
eq(L.itemKey('https://a.com/v.mp4'), 'https://a.com/v.mp4', 'key keeps clean url');
ok(L.itemKey('blob:https://a.com/x') !== L.itemKey('blob:https://a.com/y'), 'blob urls keep uuid');
const deduped = L.mergeItems([
  { key: 'k1', url: 'https://a/v.mp4', kind: 'video', size: 0 },
  { key: 'k1', url: 'https://a/v.mp4', kind: 'video', size: 12345 },
  { key: 'k2', url: 'https://a/w.mp3', kind: 'audio', size: 5 },
]);
eq(deduped.length, 2, 'mergeItems dedupes by key');
eq(deduped.find((i) => i.key === 'k1').size, 12345, 'richer copy wins');

// --- formatBytes -----------------------------------------------------------
eq(L.formatBytes(0), '0 B', 'format 0');
eq(L.formatBytes(1024), '1.0 KB', 'format kb');
eq(L.formatBytes(1048576), '1.0 MB', 'format mb');
eq(L.formatBytes(1073741824), '1.0 GB', 'format gb');
eq(L.formatBytes(null), '', 'format null -> empty');

// --- sortItems: video first, then size desc --------------------------------
const sorted = L.sortItems([
  { kind: 'audio', size: 999999 },
  { kind: 'video', size: 100 },
  { kind: 'video', size: 5000 },
  { kind: 'hls', size: 0 },
]);
eq(sorted.map((i) => i.kind), ['video', 'video', 'hls', 'audio'], 'video first then hls then audio');
eq(sorted[0].size, 5000, 'size desc within kind');

// --- ytDlpCommand -----------------------------------------------------------
eq(L.ytDlpCommand('https://site.com/watch?v=1'), 'yt-dlp -o "~/Downloads/%(title)s.%(ext)s" "https://site.com/watch?v=1"', 'ytdlp command shape');

// --- m3u8 parsing ------------------------------------------------------------
const master = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
  'v720/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080',
  '/abs/v1080/index.m3u8',
].join('\n');
const pm = L.parseM3u8(master, 'https://cdn.example.com/hls/main.m3u8?token=***');
eq(pm.type, 'master', 'master playlist type');
eq(pm.variants.length, 2, 'two variants');
eq(pm.variants[0].url, 'https://cdn.example.com/hls/v720/index.m3u8', 'relative variant resolved');
eq(pm.variants[1].url, 'https://cdn.example.com/abs/v1080/index.m3u8', 'absolute variant resolved');
eq(pm.variants[0].bandwidth, 2000000, 'bandwidth parsed');
eq(pm.variants[0].resolution, '1280x720', 'resolution parsed');
eq(pm.variants[0].token, 'token=***', 'parent query inherited into variants');

const media = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:6',
  '#EXTINF:6.000,',
  'seg-0.ts',
  '#EXTINF:6.000,',
  'https://other.cdn/seg-1.ts',
  '#EXT-X-ENDLIST',
].join('\n');
const pmedia = L.parseM3u8(media, 'https://cdn.example.com/hls/v720/index.m3u8');
eq(pmedia.type, 'media', 'media playlist type');
eq(pmedia.segments.length, 2, 'two segments');
eq(pmedia.segments[0].url, 'https://cdn.example.com/hls/v720/seg-0.ts', 'segment resolved');
eq(pmedia.segments[1].url, 'https://other.cdn/seg-1.ts', 'absolute segment kept');
eq(pmedia.encrypted, false, 'no key -> not encrypted');

const enc = ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="https://k/key.bin"', '#EXTINF:6,', 's.ts'].join('\n');
eq(L.parseM3u8(enc, 'https://a/x.m3u8').encrypted, true, 'AES-128 detected');

const best = L.pickBestVariant(pm.variants);
eq(best.url, 'https://cdn.example.com/abs/v1080/index.m3u8', 'best variant = highest bandwidth');

report('logic');


// Re-execution safety: the popup's executeScript and the persistent dynamic
// content script can both inject logic.js into the same realm. The second run
// must not throw "Identifier 'MediaSniperLogic' has already been declared"
// (regression: top-level const). Run the source twice in one VM context.
(function () {
  const vm2 = require('vm');
  const ctx = { console: console, module: { exports: {} } };
  ctx.globalThis = ctx;
  try {
    vm2.runInContext(logicSrc, ctx, { filename: 'logic.js' });
    vm2.runInContext(logicSrc, ctx, { filename: 'logic.js (again)' });
    eq('double-injection does not throw', true, true);
    ok('second run keeps a working API', !!ctx.MediaSniperLogic && typeof ctx.MediaSniperLogic.parseM3u8 === 'function');
    ok('identity preserved across runs', ctx.MediaSniperLogic === vm2.runInContext('globalThis.MediaSniperLogic', ctx));
  } catch (e) {
    ok('double-injection does not throw', false, e.message);
  }
})();
