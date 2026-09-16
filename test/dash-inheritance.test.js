'use strict';
const { eq, ok, report } = require('./harness.js');
const L = require('../src/logic.js');
require('../src/dash-inheritance.js');

// AdaptationSet-level SegmentTemplate is inherited by Representation.
{
  const mpd = [
    '<MPD mediaPresentationDuration="PT2S">',
    '<Period><AdaptationSet contentType="video">',
    '<SegmentTemplate timescale="1" duration="1" startNumber="1" initialization="init-$RepresentationID$.m4s" media="seg-$RepresentationID$-$Number$.m4s"/>',
    '<Representation id="v1" mimeType="video/mp4" bandwidth="1000000" width="1280" height="720"/>',
    '</AdaptationSet></Period></MPD>',
  ].join('');
  const r = L.parseMpdSegments(mpd, 'https://cdn.example/path/manifest.mpd');
  eq(r.tracks.length, 1, 'AS template track found');
  eq(r.tracks[0].initUrl, 'https://cdn.example/path/init-v1.m4s', 'AS initialization inherited');
  eq(r.tracks[0].segments.length, 2, 'AS duration template segment count');
  eq(r.tracks[0].segments[0], 'https://cdn.example/path/seg-v1-1.m4s', 'AS media template inherited');
}

// Representation-level attributes override the parent template while omitted
// attributes remain inherited.
{
  const mpd = [
    '<MPD mediaPresentationDuration="PT2S"><Period><AdaptationSet contentType="video">',
    '<SegmentTemplate timescale="10" duration="10" startNumber="5" initialization="init-$RepresentationID$.m4s" media="parent-$Number$.m4s"/>',
    '<Representation id="v2" mimeType="video/mp4" bandwidth="2000000">',
    '<SegmentTemplate media="child-$Number$.m4s"/>',
    '</Representation></AdaptationSet></Period></MPD>',
  ].join('');
  const t = L.parseMpdSegments(mpd, 'https://x.example/a/manifest.mpd').tracks[0];
  eq(t.initUrl, 'https://x.example/a/init-v2.m4s', 'child inherits parent initialization');
  eq(t.segments.length, 2, 'child inherits duration/timescale');
  eq(t.segments[0], 'https://x.example/a/child-5.m4s', 'child overrides media and inherits startNumber');
}

// SegmentTimeline may live on Period while AdaptationSet/Representation only
// add or override template attributes.
{
  const mpd = [
    '<MPD mediaPresentationDuration="PT3S"><Period>',
    '<SegmentTemplate timescale="1" initialization="p-init-$RepresentationID$.m4s" media="p-$Time$.m4s">',
    '<SegmentTimeline><S t="10" d="1" r="2"/></SegmentTimeline></SegmentTemplate>',
    '<AdaptationSet contentType="audio"><Representation id="a1" mimeType="audio/mp4" bandwidth="128000"/>',
    '</AdaptationSet></Period></MPD>',
  ].join('');
  const t = L.parseMpdSegments(mpd, 'https://audio.example/m.mpd').tracks[0];
  eq(t.segments.length, 3, 'Period timeline inherited');
  eq(t.segments[0], 'https://audio.example/p-10.m4s', 'timeline first time');
  eq(t.segments[2], 'https://audio.example/p-12.m4s', 'timeline repeated time');
}

// BaseURL is resolved hierarchically rather than picking a single nearest
// string without its parent context.
{
  const mpd = [
    '<MPD mediaPresentationDuration="PT1S"><BaseURL>root/</BaseURL><Period><BaseURL>p/</BaseURL>',
    '<AdaptationSet contentType="video"><BaseURL>v/</BaseURL>',
    '<SegmentTemplate timescale="1" duration="1" media="$RepresentationID$-$Number$.m4s"/>',
    '<Representation id="hi" mimeType="video/mp4" bandwidth="1"><BaseURL>r/</BaseURL></Representation>',
    '</AdaptationSet></Period></MPD>',
  ].join('');
  const t = L.parseMpdSegments(mpd, 'https://cdn.example/base/manifest.mpd').tracks[0];
  eq(t.segments[0], 'https://cdn.example/base/root/p/v/r/hi-1.m4s', 'BaseURL hierarchy composed');
}

// Detection-side view must use the same inherited resolver.
{
  const mpd = '<MPD mediaPresentationDuration="PT1S"><Period><AdaptationSet contentType="video"><SegmentTemplate duration="1" media="x-$Number$.m4s"/><Representation id="r" mimeType="video/mp4" bandwidth="3"/></AdaptationSet></Period></MPD>';
  const tracks = L.parseMpdTracks(mpd);
  eq(tracks.length, 1, 'parseMpdTracks sees inherited template');
  eq(tracks[0].bandwidth, 3, 'track metadata preserved');
  ok(tracks[0].segments === undefined, 'detection view omits segment list');
}

// SegmentList: an explicit list of segment URLs. Before this was handled it
// fell through to the SegmentBase branch and produced "one segment = the
// manifest URL", so such a manifest could not be downloaded at all.
{
  const mpd = [
    '<MPD mediaPresentationDuration="PT6S"><Period duration="PT6S">',
    '<AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v" bandwidth="800000">',
    '<SegmentList timescale="1" duration="2"><Initialization sourceURL="init.mp4"/>',
    '<SegmentURL media="seg-1.m4s"/><SegmentURL media="seg-2.m4s"/><SegmentURL media="https://cdn.other/x.m4s"/>',
    '</SegmentList></Representation></AdaptationSet></Period></MPD>',
  ].join('');
  const t = L.parseMpdSegments(mpd, 'https://cdn.example/v/stream.mpd').tracks[0];
  eq(t.initUrl, 'https://cdn.example/v/init.mp4', 'SegmentList initialization resolved');
  eq(t.segments, ['https://cdn.example/v/seg-1.m4s', 'https://cdn.example/v/seg-2.m4s', 'https://cdn.other/x.m4s'],
    'SegmentList media entries resolved (relative and absolute)');
}

// A SegmentList declared on the AdaptationSet applies to its representations.
{
  const mpd = [
    '<MPD mediaPresentationDuration="PT4S"><Period><AdaptationSet contentType="audio" mimeType="audio/mp4">',
    '<SegmentList><Initialization sourceURL="a-init.mp4"/><SegmentURL media="a-1.m4s"/><SegmentURL media="a-2.m4s"/></SegmentList>',
    '<Representation id="a" bandwidth="128000"/></AdaptationSet></Period></MPD>',
  ].join('');
  const t = L.parseMpdSegments(mpd, 'https://cdn.example/a/manifest.mpd').tracks[0];
  eq(t.initUrl, 'https://cdn.example/a/a-init.mp4', 'AdaptationSet-level SegmentList initialization');
  eq(t.segments.length, 2, 'AdaptationSet-level SegmentList inherited');
}

// Byte ranges into one file: fetch that file once instead of treating a range
// as a URL.
{
  const mpd = [
    '<MPD mediaPresentationDuration="PT4S"><Period><AdaptationSet contentType="video" mimeType="video/mp4">',
    '<Representation id="v" bandwidth="1"><BaseURL>movie.mp4</BaseURL>',
    '<SegmentList><Initialization range="0-999"/><SegmentURL media="movie.mp4" mediaRange="1000-1999"/>',
    '<SegmentURL media="movie.mp4" mediaRange="2000-2999"/></SegmentList></Representation>',
    '</AdaptationSet></Period></MPD>',
  ].join('');
  const t = L.parseMpdSegments(mpd, 'https://cdn.example/v/manifest.mpd').tracks[0];
  eq(t.segments, ['https://cdn.example/v/movie.mp4'], 'mediaRange segments collapse to the one file');
}

// SegmentBase without sourceURL: the composed BaseURL is the file when it names
// one, and never the manifest or a directory.
{
  const single = [
    '<MPD mediaPresentationDuration="PT4S"><Period><AdaptationSet contentType="video" mimeType="video/mp4">',
    '<Representation id="v" bandwidth="1"><BaseURL>movie.mp4</BaseURL><SegmentBase indexRange="0-999"/></Representation>',
    '</AdaptationSet></Period></MPD>',
  ].join('');
  const t = L.parseMpdSegments(single, 'https://cdn.example/v/manifest.mpd').tracks[0];
  eq(t.segments, ['https://cdn.example/v/movie.mp4'], 'single-file SegmentBase uses the BaseURL file');

  const directory = [
    '<MPD mediaPresentationDuration="PT4S"><Period><AdaptationSet contentType="video" mimeType="video/mp4">',
    '<BaseURL>dir/</BaseURL><Representation id="v" bandwidth="1"/></AdaptationSet></Period></MPD>',
  ].join('');
  eq(L.parseMpdSegments(directory, 'https://cdn.example/v/manifest.mpd').tracks[0].segments, [],
    'a directory BaseURL never becomes a segment');
}

report('dash-inheritance');
