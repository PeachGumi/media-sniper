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
| Privacy | No persistent site access by default; confirmed-media-only credential promotion; no telemetry |

### Limitations

- DRM-protected streams (Widevine/EME) are not supported.
- MSE-only sites with no discoverable media/playlist URL may only be partially detectable.
- Subtitles are not downloaded.
- Media Sniper is intentionally **bounded**, not an unlimited-size transcoder. Direct browser downloads are not constrained by the offscreen media assembler. OPFS-backed concat/track assembly supports up to 768 MiB, while DASH video+audio local mux is limited to 384 MiB combined input before the memory-heavy ffmpeg stage. Oversize work is rejected explicitly instead of relying on browser OOM. See [docs/MEMORY.md](docs/MEMORY.md).

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
2. Open the Media Sniper popup. This temporarily enables detection for the current tab through `activeTab`; installation itself grants no persistent website access.
3. If desired, choose **Always this site** or **Always all sites** for persistent automatic detection. **Click only** removes persistent host grants again.
4. Choose an item and press Save, or use Save all.
5. Files are written to Downloads or your configured subfolder.

Site-only access deliberately does not expand itself to unrelated CDN origins. For sites whose playlists/media live entirely on unrelated CDNs, the explicit all-sites mode gives the most complete network-level detection. See [docs/PERMISSIONS.md](docs/PERMISSIONS.md).

For detailed behavior and troubleshooting, see [docs/USAGE.ja.md](docs/USAGE.ja.md).

## Security and privacy model

Media Sniper installs without required host permissions. Opening the action grants temporary access to the current tab, while persistent site/all-sites access is optional and user-controlled. Network observation is limited by whichever HTTP(S) origins Chrome currently grants to the extension. Within that scope, explicit trust boundaries apply:

- request headers are first held in a bounded short-lived request-ID buffer;
- only `Authorization`, `Referer`, and `Origin` are candidates for capture;
- a candidate set is promoted only after the corresponding response is confirmed to look like media/HLS/DASH;
- arbitrary `X-*` headers are not collected by the media-header path;
- sensitive headers are associated with their source origin and stripped from extension-managed cross-origin replay;
- page/content-script data is treated as untrusted and schema-checked;
- privileged download/settings/clear/queue operations must originate from Media Sniper's own extension pages;
- captured authentication headers are not written to extension storage and confirmed-media header cache entries have a bounded lifetime;
- completed queue/job history is bounded and extension-owned Blob URLs have explicit release ownership plus a TTL fallback;
- excluded domains do not contribute promoted request metadata.

Chromium may still attach cookies belonging to the target media origin when the extension performs a credentialed fetch. Media Sniper does not copy a Cookie header from one origin to another.

Read the full [Privacy Policy](PRIVACY.md), [permission rationale](docs/PERMISSIONS.md), and [security policy](SECURITY.md).

## Architecture

```text
user action / optional site grant
             │
             ▼
      site-access manager
             │
page / player│
   │         │
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
                        OPFS assembly + bounded ffmpeg WASM
                                               │
                                               ▼
                                      browser Downloads
```

Key files:

```text
src/background-entry.js      service-worker entrypoint / security bootstrap
src/site-access.js           optional host grants + dynamic content scripts
src/security-guard.js        request/message trust boundary
src/background-lifecycle.js  bounded queue/job/header/blob lifecycle policy
src/logic.js                 shared media parsing/naming helpers
src/dash-inheritance.js      DASH hierarchy resolver
src/background.js            detection, queue, HLS/DASH orchestration
src/offscreen-policy.js      offscreen sender/memory/blob ownership policy
src/offscreen-streaming.js   OPFS-backed remote/HLS/DASH assembly
src/offscreen.js             ffmpeg/libav.js operations and legacy fallback
src/content.js               isolated-world relay and page metadata
src/bridge.js                page media/blob scanner
src/youtube.js               full-build YouTube MAIN-world adapter
popup/                       popup, access controls, settings, first-install disclosure
```

## Development and release checks

```bash
npm test
npm run check
npm run e2e
npm run zip
```

Pull requests and `main` run unit/syntax checks, manifest/package/UI version validation, runtime/license/privacy artifact checks, privacy scans, and browser E2E. CI builds `media-sniper.zip`, extracts **that exact distribution artifact** into a clean directory, and first loads the extracted ZIP contents unchanged in pinned Chrome for Testing; source-only files therefore cannot make packaged-artifact startup validation pass accidentally.

CI also verifies the SHA-256 values of the bundled reproducible libav.js module/WASM against `src/libav/PROVENANCE.json` and fails if the historical untraceable WASM reappears in source or package output.

The browser E2E then uses a second, isolated functional harness. Headless Chrome cannot approve the interactive optional-host-permission confirmation UI, so the harness copies the exact extracted artifact and changes **only** its manifest to grant `http://127.0.0.1/*`. All runtime JavaScript and WASM bytes remain identical to the distribution artifact. The permission request/revoke policy itself remains covered by unit/manifest checks and the manual release checklist rather than being silently auto-approved in CI.

For the media-engine gate, CI generates fresh valid H.264/AAC MPEG-TS HLS and AES-128 HLS fixtures with the host FFmpeg. It verifies normal detection/direct download first, then runs both plain and encrypted HLS through the bundled libav.js/FFmpeg runtime, stream-copy remuxes to MP4, requires Chromium download completion, and checks for a non-trivial MP4 `ftyp` signature. This avoids treating stale or corrupted checked-in binary fixtures as runtime failures, and a WASM that merely compiles is not accepted.

Only after both the test job and packaged browser E2E succeed does CI create the verified workflow artifact. It contains `media-sniper.zip` and `media-sniper.zip.sha256`.

`v*` tags go through the same jobs. A public GitHub Release is created only after all checks pass, the tag version matches the manifest/package version, and the explicit repository release-approval gate is enabled. The release attaches the ZIP/checksum **and** `media-sniper-libav-corresponding-source.tar.gz` plus its SHA-256 file, generated from the exact pinned libav.js source revision and dependency sources used for the bundled runtime.

See [docs/RELEASE.md](docs/RELEASE.md) for the exact release gate and manual acceptance checklist.

## Distribution

The supported full build includes the YouTube adapter, adaptive muxing, and yt-dlp helper. Because that feature set is not treated as Chrome Web Store-compatible, the full artifact must not be uploaded to the Chrome Web Store.

A future Web Store edition would be a separate reviewed flavor and must remove the YouTube-specific acquisition/mux/helper surface and use documentation/privacy metadata that exactly matches that artifact. See [DISTRIBUTION.md](DISTRIBUTION.md).

## Third-party software and license

Media Sniper's own source is MIT licensed; see [LICENSE](LICENSE).

The shipped libav.js / FFmpeg WebAssembly runtime is now a reproducible Media Sniper-specific build from `Yahweasel/libav.js` tag `v6.10.9.0`, commit `c80e885c3461f7bb7ea565c9631b34243ae0dbf1`, with FFmpeg 9.0 and Emscripten 6.0.5. The exact fragment list, compiler version, upstream revision and artifact SHA-256 values are version-controlled in `tools/libav/config.json` and `src/libav/PROVENANCE.json`. AAC/H.264/HEVC decoder support is present only so FFmpeg can probe complete input stream parameters; production media output remains `-c copy` stream remuxing and the corresponding encoders are not shipped.

The historical `v6.5.7.1-61-g823eb97` WASM whose exact source provenance could not be established is no longer packaged or used. Its old `.mjs` path remains only as a tiny compatibility shim that redirects callers to the new reproducible runtime.

Approved releases attach the complete corresponding-source bundle alongside the extension ZIP. See [LICENSE.libav](LICENSE.libav), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), and [tools/libav/README.md](tools/libav/README.md).

## Disclaimer

Use Media Sniper only for media you are authorized to access and save. Respect copyright, contracts, and the terms of the services you use. DRM bypass is intentionally outside the product scope.
