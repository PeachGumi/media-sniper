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

report('dash-inheritance');
