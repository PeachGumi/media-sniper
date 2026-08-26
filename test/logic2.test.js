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
eq(L.isSegmentUrl('https://a/chunk_1_0_a.aac'), true, '.aac ADTS chunk is a segment (X Spaces)');
eq(L.isSegmentUrl('https://a/chunk_1_0_a.aac?sig=x'), true, '.aac chunk with query');
eq(L.isSegmentUrl('https://a/song.aac'), true, '.aac treated as segment anywhere');

// Instagram/Meta byte-range fMP4 URLs are playback fragments even though the
// path ends in .mp4. Strip only bytestart/byteend so saving fetches the full
// signed object; preserve all other query bytes and fragments verbatim.
eq(
  L.fullMediaUrlFromByteRange('https://scontent.example/o1/video.mp4?sig=a%2Fb&bytestart=927166&byteend=2193211&ccb=17-1#x'),
  'https://scontent.example/o1/video.mp4?sig=a%2Fb&ccb=17-1#x',
  'Meta byte-range params stripped without reserializing signed query'
);
eq(
  L.fullMediaUrlFromByteRange('https://cdn.example/video.mp4?sig=x&bytestart=0'),
  'https://cdn.example/video.mp4?sig=x&bytestart=0',
  'one range parameter alone is left untouched'
);
eq(
  L.fullMediaUrlFromByteRange('https://cdn.example/video.mp4?sig=x'),
  'https://cdn.example/video.mp4?sig=x',
  'normal MP4 URL remains unchanged'
);

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

// --- audio-only HLS detection (X Spaces replays) ------------------------------
const spacePl = L.parseM3u8(['#EXTM3U', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXTINF:3.0,', 'chunk_1_0_a.aac', '#EXTINF:3.0,', 'chunk_2_1_a.aac', '#EXT-X-ENDLIST'].join('\n'), 'https://pscp.tv/hls/space.m3u8');
eq(L.isAudioOnlyPlaylist(spacePl), true, 'all-.aac media playlist is audio-only');
const tsPl = L.parseM3u8(normal, 'https://a/index.m3u8');
eq(L.isAudioOnlyPlaylist(tsPl), false, 'ts playlist not audio-only');
const fmp4Pl = L.parseM3u8(['#EXTM3U', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:2,', 'seg0.m4s', '#EXT-X-ENDLIST'].join('\n'), 'https://a/index.m3u8');
eq(L.isAudioOnlyPlaylist(fmp4Pl), false, 'fMP4 playlist not audio-only');
eq(L.isAudioOnlyPlaylist({ type: 'master', variants: [], segments: [] }), false, 'master not audio-only');
eq(L.isAudioOnlyPlaylist(null), false, 'null safe');

// --- DASH mpd track enumeration (VDH one-track-per-job model) -----------------
const dashTwo = [
  '<?xml version="1.0"?><MPD>',
  '<Period>',
  '<AdaptationSet id="0" contentType="video">',
  '<Representation id="0" mimeType="video/mp4" codecs="avc1.42c00c" bandwidth="520581" width="320" height="240"/>',
  '</AdaptationSet>',
  '<AdaptationSet id="1" contentType="audio">',
  '<Representation id="1" mimeType="audio/mp4" codecs="mp4a.40.2" bandwidth="69000"/>',
  '</AdaptationSet>',
  '</Period></MPD>',
].join('\n');
let tr = L.parseMpdTracks(dashTwo);
eq(tr.length, 2, 'two tracks from two adaptation sets');
eq(tr[0].type, 'video', 'first track video');
eq(tr[0].entry, 0, 'video entry 0');
eq(tr[0].resolution, '320x240', 'video resolution parsed');
eq(tr[1].type, 'audio', 'second track audio');
eq(tr[1].entry, 1, 'audio entry 1');

// ladder: highest-bandwidth Representation per AdaptationSet, entries are the
// GLOBAL Representation index (ffmpeg exposes one stream per Representation)
const dashLadder = [
  '<MPD><Period>',
  '<AdaptationSet contentType="video">',
  '<Representation id="0" mimeType="video/mp4" bandwidth="520581" width="320" height="240"/>',
  '<Representation id="2" mimeType="video/mp4" bandwidth="1500000" width="1280" height="720"/>',
  '</AdaptationSet>',
  '<AdaptationSet contentType="audio">',
  '<Representation id="1" mimeType="audio/mp4" bandwidth="69000"/>',
  '</AdaptationSet>',
  '</Period></MPD>',
].join('\n');
tr = L.parseMpdTracks(dashLadder);
eq(tr.length, 2, 'ladder: one item per adaptation set');
eq(tr[0].entry, 1, 'ladder: best video rep entry = its global index');
eq(tr[0].resolution, '1280x720', 'ladder: best rep chosen');
eq(tr[1].entry, 2, 'audio entry keeps counting after skipped reps');

// subtitles consume entry numbers but are not listed
const dashSubs = [
  '<MPD><Period>',
  '<AdaptationSet contentType="video"><Representation mimeType="video/mp4" bandwidth="100"/></AdaptationSet>',
  '<AdaptationSet contentType="text"><Representation mimeType="text/vtt" bandwidth="1"/></AdaptationSet>',
  '<AdaptationSet contentType="audio"><Representation mimeType="audio/mp4" bandwidth="2"/></AdaptationSet>',
  '</Period></MPD>',
].join('\n');
tr = L.parseMpdTracks(dashSubs);
eq(tr.length, 2, 'subtitle adaptation set not listed');
eq(tr[1].entry, 2, 'subtitle rep still consumed an entry number');

// no contentType attribute: infer from mimeType/codecs
const dashInfer = [
  '<MPD><Period>',
  '<AdaptationSet><Representation mimeType="video/mp4" codecs="avc1" bandwidth="1"/></AdaptationSet>',
  '<AdaptationSet><Representation codecs="mp4a.40.2" bandwidth="1"/></AdaptationSet>',
  '</Period></MPD>',
].join('\n');
tr = L.parseMpdTracks(dashInfer);
eq(tr.length, 2, 'types inferred without contentType attr');
eq(tr[0].type, 'video', 'inferred video from mimeType');
eq(tr[1].type, 'audio', 'inferred audio from codecs');

// XML comments stripped, malformed/garbage input safe
eq(L.parseMpdTracks('<MPD><!-- <AdaptationSet contentType="video"><Representation bandwidth="9"/></AdaptationSet> --><Period><AdaptationSet contentType="audio"><Representation mimeType="audio/mp4" bandwidth="9"/></AdaptationSet></Period></MPD>').length, 1, 'commented-out adaptation set ignored');
eq(L.parseMpdTracks('').length, 0, 'empty mpd safe');
eq(L.parseMpdTracks(null).length, 0, 'null mpd safe');
eq(L.parseMpdTracks('not xml at all').length, 0, 'garbage mpd safe');

// --- parseMpdSegments: SegmentTemplate + SegmentTimeline resolution -------
const dashTpl = [
  '<MPD mediaPresentationDuration="PT3.0S"><Period>',
  '<AdaptationSet contentType="video">',
  '<Representation id="0" mimeType="video/mp4" bandwidth="500" width="320" height="240">',
  '<SegmentTemplate timescale="15360" startNumber="1" initialization="init-stream$RepresentationID$.m4s" media="chunk-stream$RepresentationID$-$Number%05d$.m4s">',
  '<SegmentTimeline><S t="0" d="46080"/><S d="45056"/><S d="43212"/></SegmentTimeline>',
  '</SegmentTemplate></Representation></AdaptationSet>',
  '<AdaptationSet contentType="audio">',
  '<Representation id="1" mimeType="audio/mp4" bandwidth="70">',
  '<SegmentTemplate timescale="44100" initialization="init-stream$RepresentationID$.m4s" media="chunk-stream$RepresentationID$-$Number%05d$.m4s" startNumber="1">',
  '<SegmentTimeline><S t="0" d="44032"/><S d="45056"/><S d="43212"/></SegmentTimeline>',
  '</SegmentTemplate></Representation></AdaptationSet>',
  '</Period></MPD>',
].join('\n');
const seg = L.parseMpdSegments(dashTpl, 'http://cdn.example.com/live/manifest.mpd');
eq(seg.tracks.length, 2, 'parseMpdSegments: 2 tracks');
const sv = seg.tracks.find(function (t) { return t.type === 'video'; });
const sa = seg.tracks.find(function (t) { return t.type === 'audio'; });
ok(!!sv && !!sa, 'video + audio tracks resolved');
eq(sv.entry, 0, 'video entry 0 (document order)');
eq(sa.entry, 1, 'audio entry 1');
eq(sv.initUrl, 'http://cdn.example.com/live/init-stream0.m4s', 'init URL resolved against mpd dir');
eq(sv.segments.length, 3, '3 video segments from timeline');
eq(sv.segments[0], 'http://cdn.example.com/live/chunk-stream0-00001.m4s', 'video seg 1 padded');
eq(sv.segments[2], 'http://cdn.example.com/live/chunk-stream0-00003.m4s', 'video seg 3 numbered');
eq(sa.segments.length, 3, '3 audio segments from timeline');
eq(sa.segments[1], 'http://cdn.example.com/live/chunk-stream1-00002.m4s', 'audio seg 2 numbered');
// $RepresentationID$ / $Bandwidth$ / $Number$ substitution
const dashBw = '<MPD mediaPresentationDuration="PT2.0S"><Period><AdaptationSet contentType="video"><Representation id="v7" bandwidth="1234" mimeType="video/mp4"><SegmentTemplate timescale="1" duration="1" startNumber="5" media="seg-$RepresentationID$-$Bandwidth$-$Number$.m4s"/></Representation></AdaptationSet></Period></MPD>';
const segBw = L.parseMpdSegments(dashBw, 'http://x.example.com/a.mpd');
eq(segBw.tracks.length, 1, 'duration template: 1 track');
eq(segBw.tracks[0].segments.length, 2, 'duration 2s / seg 1s -> 2 segments');
eq(segBw.tracks[0].segments[0], 'http://x.example.com/seg-v7-1234-5.m4s', 'RepresentationID+Bandwidth+Number filled');
eq(segBw.tracks[0].segments[1], 'http://x.example.com/seg-v7-1234-6.m4s', 'Number increments');
// absolute BaseURL redirects segments elsewhere
const dashBase = '<MPD mediaPresentationDuration="PT1.0S"><Period><BaseURL>https://other.example.com/media/</BaseURL><AdaptationSet contentType="video"><Representation id="0" mimeType="video/mp4" bandwidth="1"><SegmentTemplate timescale="1" duration="1" initialization="i$RepresentationID$.m4s" media="s$Number$.m4s"/></Representation></AdaptationSet></Period></MPD>';
const segBase = L.parseMpdSegments(dashBase, 'http://manifest.example.com/dash/a.mpd');
eq(segBase.tracks[0].initUrl, 'https://other.example.com/media/i0.m4s', 'BaseURL (absolute) applied');
eq(segBase.tracks[0].segments[0], 'https://other.example.com/media/s1.m4s', 'segments follow BaseURL');
// SegmentTimeline r=-1 (repeat until next S@t or duration end)
const dashRep = '<MPD mediaPresentationDuration="PT5.0S"><Period><AdaptationSet contentType="audio"><Representation id="1" mimeType="audio/mp4" bandwidth="1"><SegmentTemplate timescale="1000" media="c$Number$.m4s" startNumber="1"><SegmentTimeline><S t="0" d="1000" r="-1"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>';
const segRep = L.parseMpdSegments(dashRep, 'http://x.example.com/a.mpd');
eq(segRep.tracks[0].segments.length, 5, 'r=-1 repeats to fill 5s/1s');
eq(segRep.tracks[0].segments[4], 'http://x.example.com/c5.m4s', 'repeated segments numbered');
// $Time$ template
const dashTime = '<MPD mediaPresentationDuration="PT2.0S"><Period><AdaptationSet contentType="video"><Representation id="0" mimeType="video/mp4" bandwidth="1"><SegmentTemplate timescale="10" media="t-$Time$.m4s" startNumber="1"><SegmentTimeline><S t="0" d="10"/><S t="10" d="10"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>';
const segTime = L.parseMpdSegments(dashTime, 'http://x.example.com/a.mpd');
eq(segTime.tracks[0].segments[0], 'http://x.example.com/t-0.m4s', '$Time$ first segment');
eq(segTime.tracks[0].segments[1], 'http://x.example.com/t-10.m4s', '$Time$ second segment');
// SegmentBase fallback: whole source as one segment
const dashSB = '<MPD><Period><AdaptationSet contentType="video"><Representation id="0" mimeType="video/mp4" bandwidth="1"><SegmentBase sourceURL="whole.mp4"/></Representation></AdaptationSet></Period></MPD>';
const segSB = L.parseMpdSegments(dashSB, 'http://x.example.com/dir/a.mpd');
eq(segSB.tracks[0].segments.length, 1, 'SegmentBase: one segment');
eq(segSB.tracks[0].segments[0], 'http://x.example.com/dir/whole.mp4', 'SegmentBase sourceURL resolved');
// detection view (parseMpdTracks) stays track-only
const tvOnly = L.parseMpdTracks(dashTpl);
ok(tvOnly[0].segments === undefined && tvOnly[0].initUrl === undefined, 'parseMpdTracks returns no segment data');

// ---- HLS alternate renditions (EXT-X-MEDIA / two-source audio) ---------------
const twoSrc = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,LANGUAGE="en",URI="audio/en.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Japanese",DEFAULT=NO,LANGUAGE="ja",URI="audio/ja.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",DEFAULT=NO,URI="subs/en.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="aud"',
  'v720/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,AUDIO="aud"',
  'v360/index.m3u8',
].join('\n');
const twoM = L.parseM3u8(twoSrc, 'https://cdn.example.com/hls/master.m3u8');
eq(twoM.type, 'master', 'two-source master type');
eq(twoM.variants.length, 2, 'two-source variants');
eq(twoM.variants[0].audioGroup, 'aud', 'variant AUDIO group captured');
eq(twoM.media.length, 3, 'all EXT-X-MEDIA entries parsed');
const audEn = twoM.media.find(function (m) { return m.name === 'English' && m.type === 'AUDIO'; });
ok(!!audEn && audEn.isDefault, 'DEFAULT=YES rendition flagged');
eq(audEn.uri, 'https://cdn.example.com/hls/audio/en.m3u8', 'audio rendition URI resolved');
eq(twoM.media.filter(function (m) { return m.type === 'AUDIO'; }).length, 2, 'subtitle rendition not counted as audio');
// media playlist with no renditions stays empty
eq(L.parseM3u8('#EXTM3U\n#EXTINF:2,\nseg0.ts\n#EXT-X-ENDLIST', 'https://a/x.m3u8').media.length, 0, 'no renditions -> empty media list');

report('logic2');
