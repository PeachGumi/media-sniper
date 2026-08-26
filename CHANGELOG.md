# Changelog

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
