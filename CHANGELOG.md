# Changelog

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
