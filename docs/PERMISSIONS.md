# Browser permissions

Media Sniper follows a least-privilege site-access model. Installing the extension does **not** permanently grant access to every website.

## Site access modes

### Click only — default

Opening the Media Sniper action grants Chrome's temporary `activeTab` access to the current HTTP(S) tab. The popup injects the media detector into that tab only.

This is intentionally non-persistent: navigating away or closing the tab ends the temporary host grant. It is the default mode after installation.

Because `activeTab` primarily covers the page the user invoked the extension on, some media delivered exclusively from unrelated CDN origins may not be visible to the network-level detector in this mode. DOM/Blob/direct-element detection on the active page still works where Chrome allows injection.

### Always this site

The popup can request the current origin through `chrome.permissions.request()`. If the user approves, Media Sniper registers its detector dynamically for that granted origin at `document_start`, including frames Chrome permits for the grant.

This improves early Blob/media-element coverage on that site without granting unrelated sites.

Cross-origin CDN requests can still require access to the CDN origin itself. Media Sniper does not silently expand a site grant to unrelated hosts.

### Always all sites — explicit power-user mode

The user can explicitly grant:

- `http://*/*`
- `https://*/*`

This gives the most complete automatic `webRequest`/CDN detection across arbitrary sites. It is **optional**, is requested only from a user gesture, and can be removed from the popup with “Click only”.

The project intentionally does not request `file://`, browser-internal, or other non-HTTP(S) schemes.

## Required permissions

### `activeTab`

Provides temporary host access after the user invokes the extension action. It powers the default click-only mode and avoids permanent access to every site.

### `scripting`

Used to:

- inject `logic.js` + `content.js` into the current `activeTab`;
- inject the YouTube MAIN-world adapter only on supported YouTube tabs;
- register persistent document-start content scripts for origins the user explicitly grants;
- unregister those scripts when persistent host access is removed.

It is not used to execute remote code. Every injected script is packaged inside the extension.

### `downloads`

Used to start user-requested downloads, choose a filename under Downloads, observe completion/failure of Media Sniper downloads, and inspect completed download metadata for the Save-all skip-existing feature.

It is not used to upload files or read arbitrary file contents from disk.

### `storage`

Used for:

- `chrome.storage.local`: download subfolder, minimum direct-media size, excluded domains;
- `chrome.storage.session`: detected media needed across Manifest V3 service-worker restarts.

Authentication-related request headers are never written to persistent extension storage.

### `webRequest`

Used to observe media network metadata **only for origins Chrome has currently granted to the extension**. This is required for reliable HLS/DASH detection and content type/size discovery that DOM inspection alone cannot provide.

Request-header handling is constrained by the security boundary:

- only confirmed media requests can promote captured headers;
- capture candidates are limited to `Authorization`, `Referer`, and `Origin`;
- arbitrary `X-*` headers are not collected by this media path;
- sensitive data remains origin-bound for extension-managed replay;
- caches are bounded and short-lived;
- captured authentication headers are not persisted.

### `offscreen`

Creates the Manifest V3 offscreen document used for Blob URLs, OPFS-backed media assembly, and the bundled ffmpeg/libav.js processing paths.

The offscreen document is not used for hidden browsing, analytics, advertising, or telemetry.

## Optional host permissions

The manifest declares only these as `optional_host_permissions`:

```text
http://*/*
https://*/*
```

They define the maximum site-access scope the user may choose later; they are not granted merely because the extension was installed.

Permission changes are reconciled into dynamic content-script registrations by `src/site-access.js`. Removing host permissions unregisters persistent detectors. The popup's current-tab `activeTab` mode remains available.

## Content-script timing and frames

Persistent site grants use `document_start` and `allFrames: true` for the generic isolated-world detector because early Blob URLs can be created before DOM ready and embedded players often live in frames.

This cost applies only to origins the user has explicitly granted persistently. The default click-only mode injects on demand after the extension action is opened.

The YouTube-specific adapter runs in the MAIN world only on YouTube and only when that tab/site is currently accessible.

## Why `tabs` is no longer required

The popup only needs the currently active tab after the user opens the extension action. `activeTab` provides the temporary page access needed for its URL/title and injection, so the broader `tabs` permission is unnecessary and has been removed.

## User control guarantees

- Install: no persistent HTTP(S) host grant.
- Open popup: temporary access to the current tab only.
- “Always this site”: explicit current-origin persistent grant.
- “Always all sites”: explicit broad HTTP(S) persistent grant.
- “Click only”: removes all persistent host grants and dynamic persistent detectors.
- Revoking permissions in browser settings is also supported; `permissions.onRemoved` reconciles registrations automatically.

## Review checklist

For every release:

- required permissions remain limited to current core features;
- no required `host_permissions` are introduced without an architectural review;
- optional origins remain HTTP(S)-only unless a concrete product requirement is documented;
- permission request UX remains user-gesture initiated;
- grant and revocation paths are covered by unit and packaged-browser E2E tests;
- privacy/security documentation matches actual code and packaged manifest;
- the packaged artifact is inspected for unexpected static content scripts or broad required host access.
