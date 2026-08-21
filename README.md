# Media Sniper

A privacy-first MV3 browser extension that detects and downloads videos, HLS/DASH streams and audio from the page you're viewing — using your browser's own logged-in session. No accounts, no servers, no telemetry: media is fetched with your cookies by your browser and saved straight to `~/Downloads`.

Works on Chrome and Brave (Manifest V3). Verified on Brave 151.

## Why another downloader?

- **Session-aware**: downloads ride the same login/cookies as your browsing, so player-only streams (hotlink-protected CDNs, auth'd HLS) just work — the same trick Video DownloadHelper uses, without the upsell.
- **Real files, real names**: HLS VODs are remuxed to a single `.mp4` in-browser (ffmpeg WASM), AES-128 included; DASH video+audio are muxed; YouTube adaptive 1080p+ (video-only + audio-only) are fetched separately and muxed locally.
- **Zero network footprint**: no analytics, no remote code, no upload endpoints. The extension only talks to the CDNs serving the media you asked for.

> **Note**: this project was previously developed privately under the name "media-sniper". Same code, now public.

## Features

| Area | What you get |
|---|---|
| Detection | Direct mp4/webm/audio links, HLS (master → per-resolution items), DASH (per-track), `<video>`/`<audio>` blob sources, YouTube adaptive formats |
| Download | Bounded queue (3 parallel) with automatic hot-link fallback: when a CDN rejects the bare download (403/auth), it re-fetches with the page's own headers (Authorization/Referer captured via webRequest) through an offscreen document |
| HLS | VOD remux to `.mp4`, AES-128 decryption, fMP4 + BYTERANGE, separate-audio-rendition muxing (`EXT-X-MEDIA`), audio-only (`.aac` ADTS concat), live recording (fragmented MP4, stop button) |
| DASH | Self-managed segment fetch + local mux (avoids the libav.js dash-demuxer deadlock); video+audio or track-by-track |
| YouTube | Progressive formats, best-audio-only, and **adaptive mux** (best video-only mp4 + best mp4 audio → one file) |
| Batch | "Save all" with skip-existing (completed download history match) and one-at-a-time chain for HLS/DASH jobs |
| Settings | Root folder inside Downloads, minimum direct-media size, per-domain blacklist |
| Naming | Title-based filenames with sanitization; optional root folder; `uniquify` conflict handling |

Not supported: subtitle embedding, DRM (Widevine/EME) content, and sites where the stream never traverses the browser.

## Install

1. `git clone` this repo
2. Open `brave://extensions` (or `chrome://extensions`) → enable Developer mode
3. "Load unpacked" → select this directory

No build step required — the repo is load-ready.

## Usage

1. Open a page with video/audio and play it (detection watches actual media requests)
2. Click the Media Sniper icon → pick an item → 保存 (Save)
3. Files land in `~/Downloads/` (or your configured root folder)

For live HLS, the Save button becomes 停止 (Stop): recording writes fragmented MP4 as it goes and finalizes when you stop.

## How it works

```
page ──webRequest(onResponseStarted/onSendHeaders)──▶ service worker
                                                        │ parse playlists,
                                                        │ capture auth headers
                                                        ▼
                                              offscreen document
                                              (fetch bytes w/ session,
                                               ffmpeg WASM mux,
                                               createObjectURL)
                                                        │ blob URL
                                                        ▼
                                     chrome.downloads.download({filename})
```

- Pure logic lives in `src/logic.js` (shared: worker/page/popup/tests)
- The page-world bridge (`src/bridge.js`) deliberately does NOT wrap fetch/XHR (detection is fully covered by webRequest; wrapping becomes the blamed frame for pages' own failed fetches)
- Filenames are passed exclusively via the `downloads.download` option — no `onDeterminingFilename` listener, so other extensions' naming never breaks (see commit history for why)

## Development

```bash
npm test        # unit tests (logic / bridge / background / youtube VM suites)
npm run check   # syntax-check every JS entry point
npm run e2e     # one-command headless E2E: boots Brave + fixture server,
                #   verifies detection + real download + settings round-trip,
                #   tears everything down (exit 0 = PASS)
npm run zip     # distributable zip
```

The E2E uses its own throwaway Brave profile and never touches your daily browser. CI runs the unit suite on every push (see `.github/workflows/ci.yml`).

Project layout:

```
src/logic.js      pure helpers (URL classification, naming, m3u8/mpd parsing)
src/background.js service worker: detection, queue, HLS/DASH orchestration
src/offscreen.js  byte-fetcher + ffmpeg WASM runner (libav.js)
src/bridge.js     page-world <video>/blob scanner
src/content.js    isolated relay + metadata
src/youtube.js    MAIN-world YouTube adapter (streamingData reader)
popup/            popup UI + options page
test/             node VM suites with strict fake-chrome harness
scripts/          E2E runner, CDP tools, fixture generator
```

## Privacy

No analytics. No telemetry. No external requests beyond fetching the media itself from the CDN that served it. Settings live in `chrome.storage.local`; detected item lists in `chrome.storage.session` (cleared when the browser closes).

## License

MIT for Media Sniper's own code — see [LICENSE](LICENSE).

`src/libav/` contains an unmodified [libav.js](https://libav.js.org) build of **ffmpeg**, which is licensed under **LGPL-2.1** (see [LICENSE.libav](LICENSE.libav)). It is dynamically loaded as-is and not linked into this project's code; corresponding source is available upstream.

## Disclaimer

This tool downloads media from pages you have legitimate access to, for personal use. Respect copyright and the terms of service of the sites you use it with. Don't use it to redistribute content you don't own.
