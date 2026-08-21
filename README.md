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

### Limitations

- DRM-protected streams (Widevine/EME — Netflix, most paid streaming) cannot be downloaded, by design
- Some sites serve media via MSE (blob: streaming without a playlist); detection there is partial — if you can see an m3u8/mpd request in DevTools, Media Sniper will still pick it up
- Subtitles are not downloaded

Not supported means we won't help make it work; everything else is fair game for bug reports.

## Install

No build step and no dependencies — the repository loads as-is.

### Option A: Download a zip (no git needed)

1. Download and unzip: [latest release](https://github.com/PeachGumi/media-sniper/releases/latest) (`media-sniper.zip`)
   - macOS/Linux: double-click, or `unzip media-sniper.zip -d media-sniper`
   - Windows: right-click → Extract All
2. Open the extensions page in your browser:
   - Brave: `brave://extensions`
   - Chrome / Edge / Chromium: `chrome://extensions` (Edge: `edge://extensions`)
3. Turn on **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked** and select the unzipped `media-sniper` folder
   - ⚠️ Select the folder that directly contains `manifest.json`, not its parent

### Option B: Clone with git

```bash
git clone https://github.com/PeachGumi/media-sniper.git
```

Then follow steps 2–4 above, selecting the cloned `media-sniper` directory.

### Updating to a new version

1. Grab the new zip (or `git pull` if you cloned)
2. Replace the folder's contents — or simply remove it and load the fresh copy
3. On the extensions page, click the ↻ **reload** icon on the Media Sniper card
4. If anything looks odd after an update, remove the extension and load it again (downloads and settings are not affected — they live in the browser profile)

### Verifying it works

- The Media Sniper icon appears in the toolbar (pin it via the puzzle-piece menu)
- Open any page with a video, play it, then click the icon — detected items are listed
- Files are saved to `~/Downloads/` (or the root folder you set in Settings)

### Troubleshooting

| Symptom | Fix |
|---|---|
| "Load unpacked" is missing | Developer mode toggle (step 3) is off |
| Icon does nothing | Reload the extension, then reopen the popup |
| Items never appear | Media must actually be played/requested on the page; press 再スキャン (Rescan) |
| Download saves but file won't play | Some sites serve DRM or MSE-only streams — see Limitations below |
| Extension disappears after browser update | Re-do steps 2–4; unpacked extensions can need re-loading after major version bumps |

> **Note**: unpacked extensions are not sandboxed like store installs — Chrome may show a
> "disable developer mode extensions" notice occasionally. This is expected and harmless here
> since all code is in this repository and auditable.

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

The E2E uses its own throwaway browser profile and never touches your daily browser. It auto-detects Brave/Chrome/Chromium (macOS/Windows/Linux); set `MEDIA_SNIPER_BRAVE=/path/to/binary` to override. CI runs the unit suite on every push (see `.github/workflows/ci.yml`).

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
