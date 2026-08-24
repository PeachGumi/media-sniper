# Media Sniper Privacy Policy

Last updated: 2026-08-25

Media Sniper is a browser extension that detects media requested by pages you visit and lets you save supported media using your browser session. Media Sniper does not operate a backend service and does not send analytics or telemetry to the project maintainer.

## Data Media Sniper handles

To provide media detection and download functionality, the extension may process the following data locally in your browser:

- the URL and hostname of the page you are viewing;
- the page title, used to suggest downloaded filenames;
- media, playlist, manifest, and segment URLs requested by the page;
- response metadata such as content type and content length;
- request metadata needed to retry media downloads that depend on the browser session, including Referer, Origin, Authorization, and selected request headers when they are present;
- the browser cookies that Chromium automatically includes when the extension fetches a permitted media URL with credentials enabled;
- extension settings such as the download subfolder, minimum media size, and excluded domains;
- detected media items for open tabs;
- browser download-history metadata used by the “Save all” feature to avoid re-downloading an item that already completed.

Media Sniper does not ask for or store your account password.

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

Media Sniper does not use browsing or authentication data for advertising, profiling, credit decisions, or unrelated product purposes.

## Where processing happens

Media detection, media fetching, playlist parsing, remuxing/muxing, and filename generation happen in your browser. Media bytes are written to your browser’s Downloads destination.

There is no Media Sniper server that receives your browsing history, media URLs, media content, cookies, or captured request headers.

Media requests still go to the websites/CDNs that host the media, because downloading the media necessarily requires contacting those hosts.

## Storage and retention

Media Sniper uses Chromium extension storage as follows:

- `chrome.storage.local`: extension settings. These remain in the browser profile until you change/remove them or uninstall/clear the extension’s data.
- `chrome.storage.session`: detected media items. These are intended to be session-scoped and are cleared by Chromium when the browser session ends.
- in-memory extension state: request metadata, download queue state, media-processing job state, and other temporary runtime information. This is not intentionally persisted to disk by Media Sniper.

The extension may also read Chromium download-history metadata when “Save all” is used. Media Sniper does not copy the browser’s full download history into its own persistent storage.

## Authentication-related request data

Some media servers require request context that the page’s own player used. Media Sniper may temporarily process authentication-related request metadata for this purpose.

The project is actively tightening this logic so that only the minimum data necessary for a confirmed media request is retained and replayed, and sensitive request headers remain bound to appropriate origins. General release is gated on those security changes.

Media Sniper does not intentionally persist captured Authorization headers in extension storage and does not transmit them to a Media Sniper-controlled server.

## Third parties

Media Sniper does not sell, rent, or share user data with advertisers or data brokers.

The extension contacts third-party websites only as required to fetch media that the user is accessing or saving. Those sites remain governed by their own privacy policies and terms.

## Remote code and analytics

Media Sniper does not download executable JavaScript or WebAssembly from a remote server at runtime. The media-processing WebAssembly bundled with the extension is shipped inside the extension package.

Media Sniper does not include analytics, telemetry, advertising SDKs, or tracking pixels.

## User controls and deletion

You can:

- clear detected items for the current tab from the popup;
- change or clear extension settings from the options page;
- remove Media Sniper from the browser to delete extension-local data managed by Chromium;
- clear browser download history separately using Chromium’s own download-history controls.

Media Sniper’s domain exclusion setting prevents excluded domains from contributing detected media items. Security work tracked for the v1.0 release also requires excluded domains to be respected consistently by request-metadata handling.

## Permissions

Media Sniper requests browser permissions only to implement its stated media-detection and download purpose. A detailed explanation is maintained in [`docs/PERMISSIONS.md`](docs/PERMISSIONS.md).

## Chrome Web Store Limited Use

If Media Sniper is distributed through the Chrome Web Store, use of information received from Chrome APIs will comply with the Chrome Web Store User Data Policy, including the Limited Use requirements. Data obtained through Chrome APIs is used only to provide or improve the extension’s prominent user-facing media-detection and download functionality.

## Security reports

Please do not disclose security vulnerabilities in a public issue. Follow [`SECURITY.md`](SECURITY.md) for private vulnerability reporting instructions.

## Changes to this policy

Material changes to data handling will be reflected in this document and in the extension’s user-facing disclosures before a general release containing those changes.

## Contact

For privacy questions, contact the project maintainer through the repository owner’s GitHub profile or repository support channels:

- Repository: `PeachGumi/media-sniper`
