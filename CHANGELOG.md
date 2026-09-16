# Changelog

## v0.13.1 (2026-09-16)

Follow-up to v0.13.0 from an independent review of that change (commit
e3fe990). The review's one blocking finding was correct: the "a blocked host is
named at runtime too" claim was not implemented.

### Fixed

- The runtime host mapping now works. The worker re-threw the original
  `TypeError` after checking it, so a fetch the preflight could not see (the
  page's own origin is deliberately not gated, because a transient activeTab
  grant is invisible to `permissions.contains`) still ended as a bare
  "Failed to fetch" with no way forward. Verified with a rejecting fetch in the
  worker test: before the fix it reports `Failed to fetch` and no hosts, after
  it names the host and exposes the pattern for the grant.
- A master playlist that points at a variant on another host is gated before
  that fetch, not after it.
- The offscreen document maps the same way for its remaining fetches (the
  YouTube mux input and the ADTS concat through `fetchBuf`, DASH segments
  through `fetchTrack`), and clears any recorded pattern when a job reserves the
  engine, so a stale host cannot attach to an unrelated error response.
- "配信元を許可して再試行" now starts a fresh save operation. The failure path
  had already cleared the row's operation, so the retry re-armed a poll that
  dropped every response: the row sat on "retrying" with no progress while the
  job actually finished (visible only in the Jobs tab). The grant button is also
  re-applied after a re-render instead of being wiped by the deferred render
  that `resetSaveButton` schedules.
- Retrying a YouTube mux job validates its audio track before clearing the job
  state, instead of leaving a queued job that could never run.
- Removed two unreachable host-grant branches from the save path: a media save
  is acknowledged before any fetch, so preflight failures only surface through
  job polling.

### Fixed (thumbnails)

- Size limits are aligned: the content script inlines up to 384 KiB, which is
  ~524k base64 characters, inside the worker's 600k acceptance limit. A poster
  between the old 400k-character limit and 512 KiB was fetched, converted and
  then dropped, with no fallback.
- The page's main player is chosen by numeric score. The score was compared as
  a joined string, so '1:90:0' beat '1:100:0' and a smaller element could win.
- The worker's still cache is capped at 40 entries and a tab's stills are
  dropped when that tab closes.

## v0.13.0 (2026-09-16)

### Added

- Every detected entry now shows a thumbnail, like the reference
  implementation. It is taken from the page: a frame from the element that is
  playing the item when the pixels are readable, otherwise that element's
  poster, otherwise the page's own social image (`og:image` / `twitter:image`);
  a page with none of those keeps a quiet placeholder rather than a broken
  image. The still is produced by the content script, cached in the worker for
  the session, and never persisted.

### Fixed

- Media hosted on an origin the extension has not been granted no longer dies
  as `TypeError: Failed to fetch`. The reference implementation ships
  `host_permissions: ["<all_urls>"]`, so this case cannot happen for it; this
  build asks for site access at runtime, and a CDN or separate media host was
  simply unreachable. A job now names the blocked host before it fetches
  ("配信元へのアクセス許可がありません: cdn.example"), the popup offers
  "配信元を許可して再試行", and the same job is rerun once the grant exists
  (one click, same media item, no need to find it again). Runtime failures
  (a redirect to an ungranted CDN) map to the same actionable error.

## v0.12.5 (2026-09-16)

### Fixed

- Live recording works for MPEG-TS streams again. A recording is written as
  fragmented MP4, and that muxer never converts the TS's ADTS AAC to ASC on its
  own: ffmpeg failed on the first audio packet and every TS recording died
  within a second (it was then reported as a successful save). TS recordings now
  pass `-bsf:a aac_adtstoasc`, and a recording that ends on its own with a
  trivially small artifact is reported as failed instead of saved.
- Stop now actually interrupts the running converter. The bundled libav build
  exposes neither `ffmpeg_interrupt` nor a module-level `abortController`, and
  its jsfetch protocol calls the global `fetch` (not the configured retry
  helper), so the interrupt cancels the open jsfetch responses *and* refuses
  further reads until the job ends. A stopped recording finishes immediately and
  keeps its partial file (verified: stop acknowledged and Downloads complete in
  the same second).
- Large items no longer die at the end of a conversion with "media output
  exceeds in-memory safety limit (768 MiB)". FFmpeg's output is written
  straight into an OPFS file as the muxer produces it, and the finished
  artifact is handed to Downloads as that disk-backed file, so nothing is
  assembled in memory and artifact size is bounded by storage, not by heap.
- The "converting" line no longer reports "media 0s · output 0B" for the whole
  job. The bundled libav build has no `ffmpeg_get_out_time_ms` /
  `ffmpeg_get_total_size_bytes`, so the previous progress timer threw once per
  second and was swallowed; progress now reports the bytes actually written to
  the artifact, and the segment fetches FFmpeg already performed while it still
  has nothing to write ("取得中… N件 · X B · 経過 T").
- An in-memory artifact is now capped at 768 MiB only when the disk-backed path
  is unavailable; OPFS Files are exempt because the storage quota, not the JS
  heap, governs them.
- A save that can never complete (interrupted blob artifact, or a restored job
  whose download state is gone) now releases its artifact URL, which is what
  deletes the temporary OPFS file. Previously a failed save of a multi-gigabyte
  item kept that file until the offscreen document went away, and the artifact
  URL's 30-minute expiry revoked natively without running that cleanup.
- A tick of the progress timer no longer relies on an API the bundled libav
  build does not have, so the popup can no longer sit at "0s / 0B" for the whole
  job.

### Changed

- DASH video+audio muxing writes its result through the same disk-backed sink.
- Mux inputs are read from disk through libav's block reader device instead of
  being copied into MEMFS, so a mux is no longer bounded by the combined input
  size (the 384 MiB budget now applies only to the no-OPFS fallback).
- Segment assembly keeps an in-memory (typed) artifact only up to 256 MiB;
  larger assemblies stay disk-backed instead of being read back into the heap.
- The disk-backed writer fails explicitly when the file system stops draining
  its queue (queued writes exceeding 512 MiB) or reports an unusable output
  offset, instead of queueing the artifact in the renderer's heap.
- Contiguous muxer chunks are merged into one file-system write per 8 MiB. One
  write call per muxer chunk could not keep up with a 1.2 GB remux (it backlogged
  hundreds of megabytes); merging keeps the queue near a single batch again.

### Notes

- Assembly paths that still need one in-memory artifact keep their documented
  limits: audio-only ADTS concat / remote fallback / single-track DASH up to
  768 MiB. The DASH/YouTube mux input budget only applies when the disk-backed
  inputs are unavailable. These are described in README and docs/MEMORY.md.
- Subtitle tracks are still parsed out on detection and are not muxed into the
  saved file: the bundled libav build enables no encoders at all, so the
  `mov_text` conversion the reference implementation uses is unavailable without
  rebuilding that artifact. See docs/VDH-PROCESSING-DIFF.md.

## v0.12.4 (2026-09-15)

### Changed

- The popup now separates current-tab detected media from a global Jobs view.
- Active direct, HLS, DASH, mux, and recording jobs remain visible with live
  progress after switching to a different page tab.
- Media cards and the Jobs view now share one status vocabulary (waiting,
  fetching, converting, saving, done, failed) instead of two different labels.

### Fixed

- Saving no longer depends on the service worker staying alive: active media
  jobs, their conversion input, and pending browser handoffs are written to
  session storage and restored after a worker restart, so a job can no longer
  vanish mid-conversion.
- A conversion that survives a worker restart is reconnected, and a job that
  has not reached the converter yet is re-run instead of failing.
- The single offscreen converter now takes jobs from one global queue, so two
  tabs saving at once queue up instead of failing with a busy error.
- Downloads interrupted by a restart retry through the authenticated fetch path
  instead of being marked failed, and completion observed later still lands in
  the final state.
- Failed and finished jobs stay listed with their error message instead of
  disappearing, and job errors/ids are redacted before reaching the popup.

## v0.12.3 (2026-09-15)

### Changed

- Media cards now show live progress: browser download bytes and percentage,
  HLS/DASH segment counts and bytes, FFmpeg output, and elapsed time.
- Reopening the popup reconnects to active direct, HLS, DASH, and mux jobs
  instead of showing an idle Save button while work continues in the background.

## v0.12.2 (2026-09-15)

### Fixed

- HLS and DASH jobs are acknowledged before long media processing finishes, so
  closing the popup or switching tabs no longer owns the job response channel.
- Offscreen fetch, FFmpeg, and mux work now keeps the MV3 service worker awake
  until the resulting browser download has been queued.
- Routine FFmpeg progress output no longer floods Brave's extension-error list.

## v0.12.1 (2026-09-15)

### Changed

- Save buttons now acknowledge clicks immediately and show per-item states for
  starting, queued, downloading, processing, completed, and failed saves.
- An active save disables repeat clicks; recording mode re-enables the button
  when it becomes the Stop control.
- Missing background responses now surface as an explicit error instead of
  leaving the popup looking idle.

## v0.12.0 (2026-09-15)

### Changed

- HLS master playlists now appear as one logical video with a compact quality
  selector instead of one popup card per rendition. The selected quality and
  alternate-audio binding are preserved for individual and Save All jobs.
- Page detection now also reads bounded, local-only HTML media, Open Graph and
  Schema.org `VideoObject` metadata. Player/embed hints are never promoted to
  downloadable items without a concrete media URL.
- Direct media carrying the player's `Authorization`, `Referer` or `Origin`
  context goes straight through the authenticated fetch path instead of first
  creating a known-bad bare download.

### Fixed

- Extensionless DASH manifests are classified and routed by media kind rather
  than a `.mpd` filename suffix; a `/hls/` path no longer overrides an explicit
  MP4 or DASH content type.
- Single-track DASH output is materialized as a typed downloadable Blob instead
  of an OPFS-backed URL Chromium cancels.
- Refreshed signed media URLs replace expired URLs without discarding richer
  title, type, size or duration metadata.
- Save All now sends adaptive YouTube video+audio items through the same mux
  path as an individual save.
- Byte-range observations use the full `Content-Range` size when available and
  no longer present fragment length as complete-file size.
- Non-live FFmpeg jobs with a non-zero return code no longer expose partial
  output as a successful download.
- Authorization-protected HLS now replays origin-bound request context through
  the bundled LibAV segment/key fetches instead of only fetching the manifest.
- HLS manifests, variants, segments, and popup quality options are bounded;
  child playlists are suppressed once their master group is known.
- Save All now advances after a download API rejection instead of leaving the
  remaining media chain permanently blocked.

## v0.11.0 (2026-08-27)

29 commits since v0.10.1. Highlights below; see the full log for everything.

### Changed

- **Permission model**: constant all-sites access is gone. The extension now
  requests access only when you click one of the site-access buttons in the
  popup ("always on this site" / "always on all sites"), with dynamic content
  scripts per grant and automatic re-scan on navigation (#25).
- **Large media assembly streams through OPFS** instead of holding every
  segment in RAM, bounded by a 768 MiB safety limit (#24).

### Fixed

- **HLS/audio saves failed to download** after the OPFS rework: final artifacts
  are now materialized as typed in-memory blobs that `chrome.downloads` accepts,
  keeping the correct extension (.aac/.mp4) — fixes X Spaces saves failing with
  a misleading network error, and the silent `.aac → .txt` rename (#31).
- **Dead page blobs no longer clutter the detection list**: items pointing at
  page-originated `blob:` URLs (e.g. MSE segments X revokes immediately) are
  excluded; only extension-owned artifacts are listed (#31).
- **Double-injection SyntaxError**: opening the popup on an already-granted tab
  no longer throws `Identifier 'MediaSniperLogic' has already been declared`;
  logic.js is now re-execution safe and the popup injects content.js only (#32).
- Navigation re-scan: stale media from SPA route changes is dropped and the
  current route is scanned automatically; manual rescan terminates cleanly (#30).
- Standalone AAC files are listed without exposing HLS chunk noise (#28).

### Added / Improved

- DASH: SegmentTemplate inherited from AdaptationSet/Period is resolved;
  SegmentTimeline and duration-based templates supported (#11).
- Reproducible libav runtime replaces the untraceable binary; corresponding
  source + notices ship with every release artifact (#26, #20).
- Queue/job/blob lifecycle bounds with guaranteed cleanup (#9, #6).
- Security hardening: auth headers are never forwarded cross-origin, page-world
  postMessage input is validated, header collection minimized (#1–#3).
- Privacy policy, permission rationale, Japanese user guide, README rewrite
  (#17, #5, docs).
- CI: packaged-browser E2E gates release artifacts; portable E2E runner (#8, #16).
- UI: version drift fixed, accessibility improvements, min-size contract fixed
  ("0 = disabled" actually disables) (#19, #7).
