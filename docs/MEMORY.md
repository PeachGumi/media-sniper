# Large-media memory contract

Media Sniper is designed to fail predictably instead of allowing an extension
process to exhaust all available browser memory.

## Supported processing model

### Direct browser downloads

Direct media URLs that can be handed to `chrome.downloads` do not pass through
Media Sniper's in-memory media assembler. Their practical size limit is the
browser/filesystem, not the limits below.

### Disk-backed concat paths

When Origin Private File System (OPFS) is available, the offscreen document
streams these operations to temporary extension-origin files instead of keeping
all segments as `ArrayBuffer`s:

- authenticated remote fallback responses;
- plain HLS/ADTS segment concatenation;
- DASH init + media segment concatenation for each track.

Only the current network chunk and browser stream buffers need to be resident
for these assembly steps. The resulting `File` is exposed through a temporary
Blob URL and the OPFS entry is deleted when that URL is released.

Maximum disk-backed assembled item/track: **768 MiB**.

The limit is checked both from `Content-Length` when available and while bytes
are actually streamed, so missing/incorrect size metadata does not disable the
runtime budget.

### ffmpeg/libav.js paths

Some operations still require the bundled ffmpeg/libav.js runtime:

- HLS remux / AES-128 / fragmented MP4 recording;
- DASH video + audio mux;
- YouTube adaptive video + audio mux.

These operations are intentionally bounded because libav.js's MEMFS / CLI
interface can require full local inputs or output chunks in JavaScript memory.

For DASH, OPFS assembly occurs first and **combined video+audio input must not
exceed 384 MiB** before entering the local mux stage.

The general offscreen safety policy additionally limits:

- one declared network response: 512 MiB;
- one in-memory output Blob: 768 MiB.

These are product limits, not estimates. Inputs beyond the supported processing
budget should produce an explicit error rather than rely on the browser to OOM.

## Why there is no “2 GB supported” claim

A downloader can be high quality without pretending every media-processing
operation is size-unbounded. The browser Downloads API is appropriate for very
large direct files. Media transformations that require WebAssembly/MEMFS have a
smaller documented support envelope.

A future architecture may move ffmpeg I/O to asynchronous/device-backed storage
and raise these limits. Until that work is proven with browser stress tests,
Media Sniper intentionally chooses deterministic limits over optimistic memory
usage.

## Cleanup guarantees

- terminal queue/job history is bounded and expires;
- captured media headers expire;
- temporary Blob URLs are revoked on download/mux completion or timeout;
- OPFS files owned by streaming Blob URLs are deleted when the URL is revoked;
- offscreen page teardown revokes remaining owned URLs;
- tab close removes tab-scoped metadata/chains.

See `src/offscreen-policy.js`, `src/offscreen-streaming.js`, and
`src/background-lifecycle.js`.
