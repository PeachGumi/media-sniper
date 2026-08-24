# Media Sniper

**English** | [日本語](README.ja.md)

A privacy-first Manifest V3 browser extension that detects and saves direct media, HLS/DASH streams, audio, Blob-backed media, and supported YouTube formats using the browser session you already have.

Media processing happens locally in Chromium. Media Sniper has no backend service, analytics, telemetry, advertising SDK, or remote executable code.

> **Distribution:** the full build in this repository is self-distributed through source/GitHub Releases and loaded unpacked in Developer mode. It is **not a Chrome Web Store artifact**. See [DISTRIBUTION.md](DISTRIBUTION.md).

## Features

| Area | What you get |
|---|---|
| Detection | Direct mp4/webm/audio, HLS, DASH, `<video>`/`<audio>` Blob sources, supported YouTube formats |
| Download | Bounded queue with browser-session-aware fallback for authenticated/hot-link-protected media |
| HLS | VOD remux, AES-128, fMP4/BYTERANGE, separate audio renditions, audio-only ADTS, live recording |
| DASH | Self-managed segment resolution/fetch, inherited `SegmentTemplate` support, local video+audio mux |
| YouTube | Progressive formats, audio-only, adaptive video+audio mux in the full self-distributed build |
| Batch | Save all, completed-download skip check, serialized HLS/DASH jobs |
| Settings | Downloads subfolder, minimum direct-media size, domain blacklist |
| Privacy | Confirmed-media-only credential promotion, origin-bound sensitive header replay, no telemetry |

### Limitations

- DRM-protected streams (Widevine/EME) are not supported.
- MSE-only sites with no discoverable media/playlist URL may only be partially detectable.
- Subtitles are not downloaded.
- Very large multi-gigabyte media can still be memory-intensive because some HLS/DASH/mux paths use in-memory buffers; see the open reliability work before treating this as an unlimited-size downloader.

## Install

No build step is required for an unpacked development/release folder.

1. Download and unzip the [latest release](https://github.com/PeachGumi/media-sniper/releases/latest), or clone this repository.
2. Open `brave://extensions`, `chrome://extensions`, or the equivalent Chromium extensions page.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the folder that directly contains `manifest.json`.

On first install, Media Sniper opens a local disclosure page explaining what browsing/media data it observes, how authenticated media request metadata is handled, where data is stored, and that no Media Sniper server receives it.

### Updating

Replace the unpacked folder with the new release (or `git pull`) and press the extension reload button. Read release notes for permission, privacy, security, and dependency changes.

## Usage

1. Open a page with video/audio and play it so the browser requests the media.
2. Open the Media Sniper popup.
3. Choose an item and press Save, or use Save all.
4. Files are written to Downloads or your configured subfolder.

For detailed behavior and troubleshooting, see [docs/USAGE.ja.md](docs/USAGE.ja.md).

## Security and privacy model

The extension needs broad browser access because its prominent function is automatic media detection across arbitrary sites. That access is constrained by explicit trust boundaries:

- request headers are first held in a bounded short-lived request-ID buffer;
- only `Authorization`, `Referer`, and `Origin` are candidates for capture;
- a candidate set is promoted only after the corresponding response is confirmed to look like media/HLS/DASH;
- arbitrary `X-*` headers are not collected by the media-header path;
- sensitive headers are associated with their source origin and stripped from extension-managed cross-origin replay;
- page/content-script data is treated as untrusted and schema-checked;
- privileged download/settings/clear/queue operations must originate from Media Sniper's own extension pages;
- captured authentication headers are not written to extension storage;
- excluded domains do not contribute promoted request metadata.

Chromium may still attach cookies belonging to the target media origin when the extension performs a credentialed fetch. Media Sniper does not copy a Cookie header from one origin to another.

Read the full [Privacy Policy](PRIVACY.md), [permission rationale](docs/PERMISSIONS.md), and [security policy](SECURITY.md).

## Architecture

```text
page / player
   │
   ├─ webRequest response metadata ───────────────┐
   └─ content/page media reports (untrusted) ──┐ │
                                               ▼ ▼
                                      security boundary
                                               │
                                               ▼
                                      service worker
                              detection / queue / HLS-DASH
                                               │
                                               ▼
                                      offscreen document
                              session fetch + ffmpeg WASM
                                               │
                                               ▼
                                      browser Downloads
```

Key files:

```text
src/background-entry.js  service-worker entrypoint / security bootstrap
src/security-guard.js    request/message trust boundary
src/logic.js             shared media parsing/naming helpers
src/dash-inheritance.js  DASH hierarchy resolver
src/background.js        detection, queue, HLS/DASH orchestration
src/offscreen.js         media byte processing + bundled ffmpeg/libav.js
src/content.js           isolated-world relay and page metadata
src/bridge.js            page media/blob scanner
src/youtube.js           full-build YouTube MAIN-world adapter
popup/                   popup, settings, first-install disclosure
```

## Development and release checks

```bash
npm test
npm run check
npm run e2e
npm run zip
```

The repository workflow is configured to run unit/syntax checks, validate the manifest/version/security entrypoint, build the distribution ZIP, verify required runtime/license/privacy files, hash the ZIP and vendored WASM, and run browser E2E fixtures. A release should not be called validated unless those checks have actually completed successfully in the release environment.

The E2E runner uses a throwaway browser profile and dynamically discovers the unpacked extension ID so it can run from different checkout paths/machines.

## Distribution

The supported full build includes the YouTube adapter, adaptive muxing, and yt-dlp helper. Because that feature set is not treated as Chrome Web Store-compatible, the full artifact must not be uploaded to the Chrome Web Store.

A future Web Store edition would be a separate reviewed flavor and must remove the YouTube-specific acquisition/mux/helper surface and use documentation/privacy metadata that exactly matches that artifact. See [DISTRIBUTION.md](DISTRIBUTION.md).

## Third-party software and license

Media Sniper's own source is MIT licensed; see [LICENSE](LICENSE).

`src/libav/` contains a vendored libav.js / FFmpeg WebAssembly artifact under its applicable LGPL terms; see [LICENSE.libav](LICENSE.libav) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The vendored generated JavaScript module has a recorded downstream modification and identifies itself as `libav.js v6.5.7.1-61-g823eb97`. Repository history does **not currently establish the exact corresponding source/build recipe** for that shipped artifact. Do not describe it as an unmodified official v6.5.7.1 binary or claim that a generic upstream checkout is necessarily its corresponding source. Resolving/replacing that artifact is a release/legal provenance gate for commercial v1.0 distribution.

## Disclaimer

Use Media Sniper only for media you are authorized to access and save. Respect copyright, contracts, and the terms of the services you use. DRM bypass is intentionally outside the product scope.
