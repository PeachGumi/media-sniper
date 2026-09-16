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

**Exception — ffmpeg output is disk-backed.** HLS remuxes and live recordings
write every muxer chunk straight into an OPFS file (positional writes, merged
into one file-system write per `FLUSH_BYTES` = 8 MiB and drained in order) and
the finished artifact is handed to Downloads as that disk-backed File, so
artifact size is bounded by storage rather than by heap. The only memory bound
on that path is the queued-write budget (`MAX_PENDING_WRITE_BYTES`, 512 MiB):
if the file system stops draining, the job fails explicitly instead of queueing
the artifact in the renderer.

For DASH, OPFS assembly occurs first and **combined video+audio input must not
exceed 384 MiB** before entering the local mux stage.

Segment assembly that produces a user-facing artifact (audio-only ADTS concat,
remote fallback, single-track DASH) writes to OPFS but keeps an in-memory typed
Blob up to 256 MiB; beyond `MAX_DISK_ASSEMBLY_BYTES` (768 MiB) it fails
explicitly.

The general offscreen safety policy additionally limits:

- one declared network response: 512 MiB;
- one in-memory output Blob: 768 MiB. Disk-backed `File` artifacts (an OPFS
  file) are exempt: they are not resident heap bytes, and the storage quota
  governs them instead.

These are product limits, not estimates. Inputs beyond the supported processing
budget should produce an explicit error rather than rely on the browser to OOM.

## Why there is no “2 GB supported” claim

A downloader can be high quality without pretending every media-processing
operation is size-unbounded. The browser Downloads API is appropriate for very
large direct files. Media transformations that require WebAssembly/MEMFS have a
smaller documented support envelope.

Device-backed storage now covers the ffmpeg *output* path; the remaining limits
above are for assembly paths that still need a single in-memory artifact or
whole inputs. Until input-side streaming (readahead/file-backed demuxer inputs)
is proven with browser stress tests, Media Sniper intentionally chooses
deterministic limits over optimistic memory usage.

## Cleanup guarantees

- terminal queue/job history is bounded and expires;
- captured media headers expire;
- temporary Blob URLs are revoked on download/mux completion or timeout;
- OPFS files owned by streaming Blob URLs are deleted when the URL is revoked;
- offscreen page teardown revokes remaining owned URLs;
- tab close removes tab-scoped metadata/chains.

See `src/offscreen-policy.js`, `src/offscreen-streaming.js`, and
`src/background-lifecycle.js`.
