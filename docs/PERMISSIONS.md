# Browser permissions

This document explains why Media Sniper requests each Chrome/Chromium extension permission. It is intended to keep the implementation, privacy policy, store disclosures, and user-facing documentation aligned.

## Single purpose

Media Sniper’s single purpose is to detect media associated with the page the user is viewing and, when the user chooses, save supported media using the browser’s existing session.

Permissions must not be reused for unrelated browsing analysis, advertising, profiling, or telemetry.

## `downloads`

Used to start downloads, choose a filename inside the browser Downloads directory, observe completion/failure of downloads started by Media Sniper, and inspect completed download-history metadata for the user-invoked “Save all” skip-existing behavior.

It is not used to upload files or inspect arbitrary file contents on disk.

## `storage`

Used for:

- `chrome.storage.local`: user settings such as download subfolder, minimum direct-media size, and excluded domains;
- `chrome.storage.session`: detected media items needed to survive Manifest V3 service-worker restarts during the browser session.

Authentication-related request headers must not be stored in persistent extension storage.

## `tabs`

Used to associate detected media with the correct browser tab, obtain the active tab for the popup, read page title/URL information needed for display and filename suggestions, and clean up tab-scoped state when a tab closes.

It must not be used to build a browsing-history profile.

## `webRequest`

Used to observe media-related network requests and response metadata that cannot be reliably discovered from page DOM elements alone, including HLS/DASH manifests and media response content types/sizes.

Some media hosts require request context used by the page player. Request-header handling is security-sensitive and must follow these release requirements:

- retain only data needed for confirmed media requests;
- avoid broad capture of unrelated API traffic;
- keep sensitive headers bound to appropriate origins;
- apply exclusions consistently;
- keep temporary data bounded and short-lived;
- never persist captured authentication headers in extension storage.

General release remains gated on the corresponding security issues.

## `offscreen`

Used to create a Manifest V3 offscreen document for browser-context tasks that the service worker cannot perform directly, including creating Blob URLs and running the bundled media-processing WebAssembly for supported remux/mux operations.

The offscreen document is not used for advertising, hidden browsing, or background tracking.

## Host permission: `<all_urls>`

The current full-feature build requests access to all HTTP(S) sites because users may encounter media on arbitrary sites and HLS/DASH media can be served from CDNs on different hosts from the page itself.

This is a broad permission and therefore a v1.0 review item. The project tracks a least-privilege design in which users can grant site access more selectively where technically practical.

Broad host access does not authorize use of site data for unrelated purposes.

## Content scripts on `<all_urls>` / `all_frames`

The current build injects content-side detection support into pages/frames to discover media elements and Blob-backed media that `webRequest` cannot represent as a normal downloadable URL.

Because always-on, all-frame injection has privacy, compatibility, and performance cost, the release-readiness roadmap requires reevaluating whether this can be delayed or restricted to user-enabled sites/frames.

## YouTube-specific MAIN-world script

The full/sideload build currently contains a YouTube-specific adapter. Chrome Web Store distribution has separate policy constraints around YouTube downloading, so any Web Store artifact must follow the distribution decision tracked in the release-readiness issues and must not accidentally contain prohibited functionality.

## Review checklist

Before every store/release submission, verify:

- the manifest permissions exactly match this document;
- the Privacy Policy describes all data actually processed;
- Store Dashboard permission justifications use the same single-purpose rationale;
- no new permission is introduced without documentation and a user-facing reason;
- security tests cover request-header minimization and origin boundaries;
- the packaged artifact, not only the source tree, is inspected for unexpected permissions or code paths.
