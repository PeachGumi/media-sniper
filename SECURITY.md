# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| latest published release | yes |
| latest on `main` | development / best effort |
| older releases | no |

## Reporting a vulnerability

Please do **not** open a public issue for exploitable security problems.

Use GitHub private vulnerability reporting (Security → Report a vulnerability), or contact the maintainer directly. Include the affected browser/version, reproduction or proof of concept, and impact assessment. Public issue trackers may be used for high-level hardening work only when they do not expose an immediately reusable exploit recipe.

## Security model

Media Sniper has no application backend. The primary security boundaries are inside the browser extension itself: web pages/content scripts are untrusted, extension pages are privileged, and authenticated request context must never be replayed across an unsafe origin boundary.

### Page/content-script input

`src/bridge.js`, `src/content.js`, and site adapters can surface information that ultimately originated in a web page. Fixed `postMessage` markers are routing hints, **not authentication**.

Before that data reaches the legacy media pipeline, `src/security-guard.js`:

- requires content-report messages to come from the extension's own content-script identity and an actual tab;
- derives page context from `MessageSender` instead of trusting payload-provided tab/page fields;
- shape-checks media URL/kind/size/duration fields and restricts URL schemes;
- constrains YouTube-adapter reports to a YouTube sender and expected YouTube/googlevideo media hosts;
- prevents content/page senders from invoking privileged download, settings, clear, HLS-control, or queue operations.

Messages for privileged operations must originate from a `chrome-extension://<this-extension-id>/...` page. Extension pages opened as normal browser tabs are normalized by `src/security-bootstrap.js`; the presence of `sender.tab` is not itself a trust decision.

### Request-header capture

Media Sniper may need request context used by a player to retry authenticated media. Header handling is deliberately narrower than general `webRequest` visibility.

- Candidate names are limited to `Authorization`, `Referer`, and `Origin`.
- Arbitrary `X-*`, Cookie, CSRF, or API-key style request headers are not collected into the media-header path.
- Candidates first live in a request-ID pending buffer for at most about 15 seconds.
- The pending set is bounded (256 entries).
- A candidate is promoted to the media-header cache only after the matching response is confirmed as media/HLS/DASH.
- Blacklisted domains are not promoted.
- Captured authentication headers are not written to extension storage.

### Origin-bound replay

Promoted header sets carry an internal source-origin marker. Before extension-managed service-worker/offscreen fetches:

- the marker is removed and is never sent to the network;
- sensitive headers such as `Authorization` are preserved only when every target using that shared header set is on the source origin;
- if a target crosses origin, sensitive headers are removed rather than forwarded;
- browser-managed cookies are left to Chromium's normal target-origin credential handling rather than being copied from captured request headers.

This is intentionally fail-closed. A cross-origin CDN topology may lose a fallback download rather than receive credentials captured for another origin.

### Offscreen media processing

`src/offscreen.js` fetches media bytes and runs the bundled libav.js/FFmpeg WebAssembly. Review should pay particular attention to URL/header ownership, Blob URL lifetime, memory exhaustion on large media, ffmpeg argument construction, and worker/offscreen recovery.

No remote JavaScript or WebAssembly is loaded at runtime.

### Filenames and paths

`sanitizeFilename` and `sanitizeRootFolder` in `src/logic.js` must keep path traversal impossible. Filenames are supplied through the browser downloads API; arbitrary filesystem paths are not accepted from page content.

### Third-party binary provenance

The bundled libav.js/FFmpeg runtime is reproducibly built from pinned upstream inputs. `tools/libav/config.json` records the build inputs, `src/libav/PROVENANCE.json` records the exact upstream commit and generated artifact hashes, and CI recomputes those hashes before packaging.

Approved `v*` releases attach the matching libav.js/FFmpeg corresponding-source bundle and checksum alongside the extension ZIP. See `THIRD_PARTY_NOTICES.md`, `tools/libav/README.md`, and `docs/RELEASE.md`.

The historical untraceable libav WASM is not shipped by the current release path. Its old import name remains only as a compatibility shim and CI fails if the old WASM binary reappears.

## Security regression expectations

Changes affecting any of the following should add or update tests:

- page/content → privileged message transitions;
- request-header capture allowlists or retention;
- cross-origin replay/redirect behavior;
- URL scheme/host validation;
- filename/path sanitization;
- offscreen Blob/fetch ownership and cleanup;
- permissions or site-access scope.

A public/commercial release must pass the packaged-artifact browser E2E gate and the manual release checklist in `docs/RELEASE.md`. The repository-level release approval marker must remain absent while a release blocker is unresolved.
