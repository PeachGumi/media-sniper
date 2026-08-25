'use strict';
const { eq, report } = require('./harness.js');
const guard = require('../src/direct-media-guard.js');

eq(guard.isLikelyAacSegment('https://a.example/chunk_1_0_a.aac'), true, 'X Spaces chunk is segment');
eq(guard.isLikelyAacSegment('https://a.example/chunk_1_0_a.aac?sig=x'), true, 'chunk query ignored');
eq(guard.isLikelyAacSegment('https://a.example/seg00012.aac'), true, 'segNNN naming is segment');
eq(guard.isLikelyAacSegment('https://a.example/fileSequence0.aac'), true, 'fileSequence naming is segment');
eq(guard.isLikelyAacSegment('https://a.example/00001.aac'), true, 'numeric AAC naming is segment');
eq(guard.isLikelyAacSegment('https://a.example/music/song.aac'), false, 'ordinary song.aac is standalone media');
eq(guard.isLikelyAacSegment('https://a.example/audio/interview.aac?download=1'), false, 'ordinary AAC with query is standalone media');

{
  const logic = {
    isSegmentUrl: function (url) { return /\.(?:ts|m4s|m2ts|aac)(?:[?#]|$)/i.test(String(url)); },
  };
  const root = { MediaSniperLogic: logic };
  eq(guard.install(root), true, 'guard installs');
  eq(logic.isSegmentUrl('https://a.example/video/seg0.ts'), true, 'non-AAC legacy segment behavior retained');
  eq(logic.isSegmentUrl('https://a.example/music/song.aac'), false, 'standalone AAC no longer suppressed');
  eq(logic.isSegmentUrl('https://a.example/chunk_1_0_a.aac'), true, 'AAC HLS chunk remains suppressed');
  eq(guard.install(root), true, 'install is idempotent');
}

report('direct-media-guard');
