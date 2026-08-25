# Reproducible libav.js build

Media Sniper uses its bundled ffmpeg runtime for demuxing, stream-copy
remuxing/muxing, HLS handling, and writing MP4/AAC outputs. It does not
transcode captured media: production ffmpeg jobs use `-c copy`.

Some input codecs still need decoder support during FFmpeg stream probing.
In particular, HLS/MPEG-TS can identify an H.264/AAC stream without exposing
all container-output parameters (for example width/height, sample rate and
channel layout) unless FFmpeg can inspect codec headers. The custom
`media-sniper` variant therefore includes AAC, H.264 and HEVC decoders for
**stream-parameter probing only**, while deliberately omitting their encoders.
This keeps the shipped operation as stream copy rather than transcoding.

## Pinned inputs

`config.json` is the source of truth for:

- upstream repository and tag;
- libav.js / FFmpeg version;
- Emscripten version;
- exact configuration fragments;
- variant name.

The build workflow checks out the exact upstream tag, resolves and records its
commit SHA, creates the custom configuration using upstream's supported
`configs/mkconfig.js` interface, builds the plain WebAssembly ES module target,
and records SHA-256 hashes for the generated JavaScript module and WASM binary.

## Why this replaces the old vendored binary

The previous `v6.5.7.1-61-g823eb97` artifact could not be traced from repository
history to a complete corresponding source/build recipe and had a recorded
downstream generated-file patch. A functioning binary is not enough for a
high-quality dependency chain: maintainers should be able to rebuild, inspect,
and replace it deterministically.

The new artifact is generated from official `Yahweasel/libav.js` source rather
than copied from another extension.

## Build contract

The workflow uses upstream's own documented tooling:

```text
Node 24
Emscripten 6.0.5
Yahweasel/libav.js v6.10.9.0
node configs/mkconfig.js media-sniper <fragments-json>
make extract
make dist/libav-6.10.9.0-media-sniper.wasm.mjs
```

The normal Media Sniper CI then runs the exact packaged extension through the
browser E2E suite. The replacement is not accepted merely because compilation
succeeds.

## Functional requirements

The generated variant must support the operations Media Sniper actually uses:

- HLS input over libav.js `jsfetch`;
- encrypted HLS protocol plumbing;
- MPEG-TS/fMP4/WebM/AAC demuxing as needed for stream copy;
- MP4/AAC output;
- `ffmpeg` CLI;
- H.264/H.265/AAC/Opus/VP8/VP9/AV1 parser/bitstream metadata needed for copying
  streams between supported containers;
- AAC/H.264/HEVC decode support sufficient to probe complete input stream
  parameters before a `-c copy` output header is written;
- local video+audio MP4 mux with `-c copy`;
- fragmented MP4 output for live-recording mode.

No quality claim depends on an unverified binary provenance after this build is
adopted.
