# Support and Compatibility Policy

Media Sniper's supported public artifact is the **latest GitHub Release** of the full/self-distributed build described in `DISTRIBUTION.md`.

## Release channels

- **Supported:** GitHub Releases produced by the repository release workflow.
- **Development / best effort:** the current `main` branch loaded unpacked.
- **Unsupported:** repackaged or modified binaries distributed by third parties, old releases after a newer release is published, and any artifact uploaded to the Chrome Web Store as if it were the full build.

A release ZIP is considered project-produced only when it is accompanied by the workflow-generated SHA-256 checksum and the release's matching third-party/corresponding-source assets.

## Browser compatibility

The automated release gate uses the exact packaged extension with a pinned Chrome for Testing build on GitHub-hosted Ubuntu. The functional harness covers extension startup, media detection, direct download, settings/queue behavior, plain HLS remux, and AES-128 HLS decrypt/remux through the bundled libav.js/FFmpeg runtime.

The intended interactive desktop browsers are current stable Chromium-based Chrome and Brave. Before a release is approved, the maintainer must manually exercise the user-consent flows that headless CI cannot truthfully approve, especially optional site/all-sites permission grant and revoke.

A browser/OS combination should be described as **verified** in release notes only after the clean-profile acceptance flow in `docs/RELEASE.md` has been run on that combination. Lack of a release-note verification entry means compatibility is best effort, not a guarantee.

Firefox and Safari are not supported by the current Manifest V3 implementation. Other Chromium derivatives may work but are not automatically part of the support contract.

## Site compatibility

Media Sniper saves media that the browser can access and that the extension can process within its documented security and memory limits. Support does not promise compatibility with every website or delivery topology.

Known out-of-scope cases include:

- DRM/EME-protected media;
- media the browser account itself is not authorized to access;
- sites that intentionally change delivery mechanisms faster than the project can adapt;
- workflows requiring credentials to be replayed across an unsafe origin boundary;
- use that violates applicable law, site terms, or rights in the media.

Security boundaries take precedence over compatibility. A download may fail closed rather than forward authentication material to another origin.

## Bug support

For reproducible bugs, open a GitHub issue with browser/version, operating system, expected and actual behavior, and relevant extension service-worker/offscreen logs. Do not publish exploitable security details; use the private reporting path in `SECURITY.md`.

The open-source repository does not promise a response-time SLA. If Media Sniper is offered as a paid product, the paid channel must publish its own response-time, refund, billing, and update terms before sales begin. Those commercial terms must not contradict this repository's privacy, security, licensing, or distribution commitments.

## Updates

Self-distributed users update by replacing the unpacked release directory and reloading the extension. Release notes must highlight changes to permissions, privacy/data flow, security boundaries, supported browsers, and third-party runtime provenance.

Only the latest published release receives routine fixes. Security fixes may require users to update immediately; older releases are not maintained as parallel supported branches.
