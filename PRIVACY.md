# Media Sniper Privacy Policy

Last updated: 2026-08-25

Media Sniper is a browser extension that detects media requested by pages you visit and lets you save supported media using your browser session. Media Sniper does not operate a backend service and does not send analytics or telemetry to the project maintainer.

## Data Media Sniper handles

To provide media detection and download functionality, the extension may process the following data locally in your browser **for tabs/sites to which Chromium currently grants the extension access**:

- the URL and hostname of the page you are viewing;
- the page title, used to suggest downloaded filenames;
- media, playlist, manifest, and segment URLs requested by the page;
- response metadata such as content type and content length;
- request metadata needed to retry authenticated media downloads: `Authorization`, `Referer`, and `Origin` when those headers are present;
- browser cookies that Chromium itself may include when the extension fetches media for the corresponding target site;
- extension settings such as the download subfolder, minimum media size, excluded domains, and whether the first-install disclosure has been acknowledged;
- detected media items for open tabs;
- browser download-history metadata used by the “Save all” feature to avoid re-downloading an item that already completed.

Media Sniper does not ask for or store your account password. It does not intentionally capture arbitrary `X-*` request headers or copy browser Cookie request headers into its own media-header cache.

## Site-access model

Media Sniper installs with **no persistent HTTP(S) host permission**.

- **Click only (default):** opening the extension action grants temporary `activeTab` access to the current tab. This access does not become a permanent all-sites grant.
- **Always this site:** the user may explicitly approve persistent access to the current HTTP(S) origin.
- **Always all sites:** the user may explicitly approve persistent access to all HTTP(S) origins for the most complete cross-origin CDN/network detection.
- **Click only** can be selected again to remove all persistent host grants made to Media Sniper.

Permission additions/removals are reflected in dynamic content-script registrations. Media Sniper does not silently expand a single-site permission to unrelated CDN hosts. As a result, narrower modes can intentionally provide less complete network-level detection than all-sites mode.

## Why this data is used

The data above is used only to provide Media Sniper’s user-facing features:

- identify media associated with the page you are viewing;
- distinguish direct media from HLS/DASH streams and individual segments;
- display detected media in the extension popup;
- retry downloads that require the same browser session or request context as the page player;
- combine supported HLS/DASH or separate audio/video tracks locally;
- choose a filename and destination inside your Downloads folder;
- remember your extension settings;
- skip items that already appear in your completed browser download history.

Media Sniper does not use browsing or authentication data for advertising, profiling, credit decisions, model training, or unrelated product purposes.

## Where processing happens

Media detection, media fetching, playlist parsing, remuxing/muxing, and filename generation happen in your browser. Media bytes are written to your browser’s Downloads destination.

There is no Media Sniper server that receives your browsing history, media URLs, media content, cookies, or captured request headers.

Media requests still go to the websites/CDNs that host the media, because downloading the media necessarily requires contacting those hosts.

## Storage and retention

Media Sniper uses Chromium-managed extension/browser storage as follows:

- `chrome.storage.local`: extension settings and the version of the first-install disclosure you acknowledged. These remain in the browser profile until you change/remove them or uninstall/clear the extension’s data.
- `chrome.storage.session`: detected media items. These are session-scoped and are cleared by Chromium when the browser session ends.
- in-memory extension state: request metadata, download queue state, media-processing job state, and other temporary runtime information.
- Origin Private File System (OPFS): temporary local media assembly files may be used for supported HLS/DASH/fallback processing so large segment sets do not need to remain fully resident in RAM. Those files belong to extension-generated temporary URLs and are deleted when their ownership ends; teardown/TTL cleanup provides an additional fallback.

Request headers are handled under an additional short-lived security boundary. Candidate `Authorization`, `Referer`, and `Origin` headers are held by request ID in memory for at most approximately 15 seconds, with a bounded pending set. They are promoted to the media-header cache only after the corresponding response is confirmed to look like media/HLS/DASH. Confirmed-media header entries also expire after a bounded idle period. Blacklisted domains are not promoted.

The extension may also read Chromium download-history metadata when “Save all” is used. Media Sniper does not copy the browser’s full download history into its own persistent storage.

## Authentication-related request data

Some media servers require request context that the page’s own player used. Media Sniper temporarily processes the smallest header set currently required for this purpose: `Authorization`, `Referer`, and `Origin`.

Sensitive replay is origin-bound. An `Authorization` or other sensitive header set that was captured for one origin is stripped before an extension-managed fetch to a different origin. The internal source-origin marker used to make this decision is never sent to the network.

This rule is intentionally conservative: a cross-origin CDN layout may lose an authenticated fallback instead of forwarding a credential to an unrelated origin. Browser-managed cookies remain controlled by Chromium for the target origin rather than being copied from one host to another by Media Sniper.

Media Sniper does not persist captured Authorization headers in `chrome.storage.local` or `chrome.storage.session`, and it does not transmit them to a Media Sniper-controlled server.

## Page-to-extension trust boundary

Information originating from a web page is treated as untrusted input. Media reports are schema-checked and associated with the sender tab/frame rather than trusting a page-provided tab ID or page URL. Page/content-script senders cannot directly invoke privileged download, settings, clear, or queue operations; those operations are limited to Media Sniper’s own extension pages.

## Third parties

Media Sniper does not sell, rent, or share user data with advertisers or data brokers.

The extension contacts third-party websites only as required to detect or fetch media that the user is accessing or saving. Those sites remain governed by their own privacy policies and terms.

## Remote code and analytics

Media Sniper does not download executable JavaScript or WebAssembly from a remote server at runtime. The media-processing WebAssembly bundled with the extension is shipped inside the extension package.

Media Sniper does not include analytics, telemetry, advertising SDKs, or tracking pixels.

## User controls and deletion

You can:

- use Media Sniper only temporarily on the tab where you opened the popup;
- grant persistent access only to the current site;
- explicitly enable all HTTP(S) sites for full automatic/CDN coverage;
- return to Click only mode to remove persistent host grants;
- revoke site permissions through Chromium’s own extension controls;
- clear detected items for the current tab from the popup;
- change or clear extension settings from the options page;
- exclude domains from media collection using the blacklist setting;
- remove Media Sniper from the browser to delete extension-local data managed by Chromium;
- clear browser download history separately using Chromium’s own download-history controls.

The domain exclusion setting is applied to both detected media collection and promotion of captured request metadata.

## First-install disclosure

On a fresh installation, Media Sniper opens a local onboarding page that explains the browser activity it may process for media detection, the temporary use of authentication-related request metadata for confirmed media, browser-managed cookie behavior, local processing, storage, deletion controls, and the absence of a Media Sniper backend/telemetry service.

Installing the extension itself does not grant persistent all-sites access. Persistent host permissions are requested only later through explicit user actions in the popup.

## Permissions

Media Sniper requests browser permissions only to implement its stated media-detection and download purpose. A detailed explanation is maintained in [`docs/PERMISSIONS.md`](docs/PERMISSIONS.md).

Required permissions do not include `tabs` or persistent `host_permissions`. The maximum optional host scope is HTTP(S), and users choose whether to grant one site or all sites. The release CI verifies this manifest contract and packaged browser E2E covers grant and revocation behavior.

## Distribution

The full Media Sniper build in this repository is self-distributed through source/GitHub Releases and loaded unpacked in Chromium-based browsers. It is not presented as a Chrome Web Store artifact. See [`DISTRIBUTION.md`](DISTRIBUTION.md).

If a separate Chrome Web Store edition is created in the future, it must undergo a separate feature, permission, privacy, and policy review. Its disclosures must match that edition’s actual artifact and Chrome Web Store requirements at the time of submission.

## Security reports

Please do not disclose security vulnerabilities in a public issue. Follow [`SECURITY.md`](SECURITY.md) for private vulnerability reporting instructions.

## Changes to this policy

Material changes to data handling will be reflected in this document and in the extension’s user-facing disclosures before a release containing those changes.

## Contact

For privacy questions, contact the project maintainer through the repository owner’s GitHub profile or repository support channels:

- Repository: `PeachGumi/media-sniper`
