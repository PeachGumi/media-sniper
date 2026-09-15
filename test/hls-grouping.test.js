'use strict';
const { eq, ok, report } = require('./harness.js');
const L = require('../src/logic.js');

const masterUrl = 'https://cdn.example.test/hls/master.m3u8?auth=parent';
const masterText = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Main",DEFAULT=YES,URI="audio/main.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1",AUDIO="aud"',
  'video/720.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1",AUDIO="aud"',
  'video/1080.m3u8',
].join('\n');
const parsed = L.parseM3u8(masterText, masterUrl);
const grouped = L.groupHlsItem(masterUrl, parsed, { title: 'Grouped video', pageUrl: 'https://site.example/watch' });

// One master is one logical item; all quality metadata and alternate audio
// remain nested on the item rather than becoming duplicate top-level entries.
eq(grouped.url, masterUrl, 'group keeps the master playlist URL');
eq(grouped.kind, 'hls', 'group is an HLS item');
eq(grouped.title, 'Grouped video', 'group keeps display metadata');
eq(grouped.variants.length, 2, 'group preserves every quality');
eq(grouped.variants[0].resolution, '1280x720', 'first resolution preserved');
eq(grouped.variants[1].bandwidth, 6000000, 'second bandwidth preserved');
eq(
  grouped.variants[0].audioUrl,
  'https://cdn.example.test/hls/audio/main.m3u8?auth=parent',
  'each variant keeps its alternate audio URL',
);

const best = L.selectedHlsVariant(grouped);
eq(best.resolution, '1920x1080', 'default selection is highest bandwidth/resolution');
eq(grouped.selectedVariantKey, L.hlsVariantKey(best), 'default selection is persisted as a stable key');

const lowerKey = L.hlsVariantKey(grouped.variants[0]);
const selected = L.selectHlsVariant(grouped, lowerKey);
eq(selected.url, grouped.variants[0].url, 'quality selection resolves the requested variant');
const selectedItem = Object.assign({}, grouped, { selectedVariantKey: lowerKey });
eq(L.selectedHlsVariant(selectedItem).url, grouped.variants[0].url, 'selected key overrides the default');

const merged = L.mergeHlsVariants(
  [{ url: grouped.variants[0].url, bandwidth: 2500000, resolution: '1280x720' }],
  [{ url: grouped.variants[0].url, bandwidth: 2500000, resolution: '1280x720', audioUrl: grouped.variants[0].audioUrl }, grouped.variants[1]],
);
eq(merged.length, 2, 'variant merge deduplicates a repeated quality');
eq(merged[0].audioUrl, grouped.variants[0].audioUrl, 'variant merge keeps richer audio metadata');
ok(merged.some(function (v) { return v.resolution === '1920x1080'; }), 'variant merge keeps new qualities');

report('hls-grouping');
