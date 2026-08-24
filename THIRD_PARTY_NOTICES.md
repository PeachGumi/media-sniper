# Third-Party Notices

Media Sniper includes third-party software. This document records what is
currently known about those artifacts so release and licensing information does
not claim more provenance than the repository can demonstrate.

## libav.js / FFmpeg WebAssembly

Vendored files:

- `src/libav/libav-6.5.7.1-h264-aac-mp3.wasm.mjs`
- `src/libav/libav-6.5.7.1-h264-aac-mp3.wasm.wasm`

The generated module identifies itself as:

```text
libav.js v6.5.7.1-61-g823eb97
```

The module's embedded license header contains the applicable FFmpeg / LGPL-2.1
notices. A copy of the extracted license notice is also kept in
`LICENSE.libav`.

### Downstream modification

The vendored generated JavaScript module is **not an unmodified upstream
artifact**. Media Sniper commit
`328ae6f258583ccdd22089043b20b9bfe40a1448` records a downstream vendor patch
that changes libav.js's stdin prompt path (`window.prompt("Input: ")`) to an
immediate EOF-style result. The runtime also invokes ffmpeg with `-nostdin`.

The WASM/module pair first appears in Media Sniper history in commit
`6b702b13ed784bf484cb114637d12e36f2523871`. The parent commit does not contain
these vendored files.

### Source provenance status

As of 2026-08-25, the exact corresponding source archive/build recipe for the
currently vendored artifact has **not yet been established from repository
history**.

The official upstream `Yahweasel/libav.js` release tagged `v6.5.7.1` points to
commit `d54191e`, while the vendored generated file reports
`v6.5.7.1-61-g823eb97`. The short revision `823eb97` has not been resolved to a
verified upstream commit during the release-readiness audit.

The `h264-aac-mp3` variant also contains MPEG-family codecs and should be treated
as a custom/downstream build unless its exact upstream provenance is recovered.

Therefore, **do not represent the current artifact as an unmodified official
v6.5.7.1 binary, and do not claim that a generic upstream source checkout is
necessarily its corresponding source.**

### Commercial-release gate

Before a v1.0 commercial release, one of the following must be completed:

1. Recover the exact source revision, dependency sources, build configuration,
   and downstream patch corresponding to the current binary; or
2. Replace the vendored artifact with a reproducible build from a pinned source
   revision and keep the complete corresponding source/build recipe available
   to recipients.

The release process should also record cryptographic hashes for the shipped
artifacts and make the corresponding sources available with comparable ease of
access.

Tracking: GitHub Issue #10.

## Media Sniper source

Media Sniper's own source code is licensed under the MIT License in `LICENSE`.
Third-party files retain their respective licenses; the Media Sniper MIT license
does not override them.
