'use strict';
const { eq, ok, report } = require('./harness.js');
const L = require('../src/logic.js');

// --- extFromContentType (VDH-style MIME table fallback) ----------------------
eq(L.extFromContentType('video/mp4', null), 'mp4', 'video/mp4 -> mp4');
eq(L.extFromContentType('video/x-matroska', null), 'mkv', 'matroska -> mkv');
eq(L.extFromContentType('video/webm', null), 'webm', 'webm');
eq(L.extFromContentType('audio/x-m4a', null), 'm4a', 'x-m4a -> m4a');
eq(L.extFromContentType('audio/flac', null), 'flac', 'flac');
eq(L.extFromContentType('video/mp2t', null), 'ts', 'mp2t -> ts');
eq(L.extFromContentType('video/x-flv', null), 'flv', 'flv');
eq(L.extFromContentType('application/octet-stream', 'x.bin'), null, 'octet-stream -> null');
eq(L.extFromContentType('text/html', null), null, 'html -> null');

// --- isSegmentUrl (do NOT report individual segments) ------------------------
eq(L.isSegmentUrl('https://a/seg0.ts'), true, '.ts segment');
eq(L.isSegmentUrl('https://a/seg0.m4s'), true, '.m4s segment');
eq(L.isSegmentUrl('https://a/seg0.m2ts'), true, '.m2ts segment');
eq(L.isSegmentUrl('https://a/video.mp4'), false, 'mp4 not segment');
eq(L.isSegmentUrl('https://a/index.m3u8'), false, 'm3u8 not segment');
eq(L.isSegmentUrl('https://a/file.ts?x=1'), true, 'segment with query');

// --- subtitle playlist detection ----------------------------------------------
const subs = ['#EXTM3U', '#EXTINF:10,', 'subs.vtt', '#EXTINF:10,', 'subs2.srt'].join('\n');
eq(L.isSubtitlePlaylist(subs), true, 'all-vtt/srt playlist = subtitles');
const mixed = ['#EXTM3U', '#EXTINF:10,', 'seg0.ts', '#EXTINF:10,', 'subs.vtt'].join('\n');
eq(L.isSubtitlePlaylist(mixed), false, 'mixed playlist not subtitles');
const normal = ['#EXTM3U', '#EXTINF:10,', 'seg0.ts'].join('\n');
eq(L.isSubtitlePlaylist(normal), false, 'normal playlist');

// --- looksLikeHlsUrl (VDH url heuristics) -------------------------------------
eq(L.looksLikeHlsUrl('https://a/x.m3u8'), true, 'ext m3u8');
eq(L.looksLikeHlsUrl('https://a/hls/stream'), true, 'path has hls');
eq(L.looksLikeHlsUrl('https://a/api/playlist/master/abc'), true, 'playlist master path');
eq(L.looksLikeHlsUrl('https://a/video.mp4'), false, 'plain mp4');

// --- smartName: extract title from meta payload -------------------------------
eq(L.smartName({ title: 'My Video', ogImage: 'https://a/t.jpg' }).title, 'My Video', 'title passthrough');
eq(L.smartName({ title: '  ' , url: 'https://a/vid/clip.mp4' }).title, 'clip', 'fallback to last path');
eq(L.smartName({ title: 'a', url: 'blob:x' }).title, 'a', 'title kept');

// --- duration from EXTINF sum -------------------------------------------------
eq(L.playlistDuration(['#EXTM3U', '#EXTINF:6.0,', 'a.ts', '#EXTINF:4.5,', 'b.ts', '#EXT-X-ENDLIST'].join('\n')), 10.5, 'duration summed');

report('logic2');
