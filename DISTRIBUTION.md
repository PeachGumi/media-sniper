# Distribution Policy

Media Sniper is distributed as a **full/self-distributed build** from this
repository and its GitHub Releases. The full build is **not a Chrome Web Store
artifact**.

## Why

The full product contains a dedicated YouTube adapter, adaptive video/audio
selection, local muxing, and a yt-dlp helper. Chrome Web Store policy and review
risk for extensions that facilitate downloading YouTube content is incompatible
with treating that full feature set as a store-ready artifact.

Rather than maintain a partially stripped build whose behavior and privacy
claims can drift from the full product, v1.0 uses one explicit distribution
contract:

- GitHub Releases / source checkout: supported full build
- Chrome / Brave: load unpacked in Developer mode
- Chrome Web Store: **not a supported distribution channel for the full build**
- Any future Web Store edition must be a separately reviewed product/flavor and
  must not reuse the full artifact unchanged

## Release artifact rules

A release is acceptable only when:

1. `npm test` and syntax checks pass.
2. Browser E2E passes on the automated release target.
3. The packaged ZIP is checked for required runtime files, licenses, privacy,
   distribution and support notices.
4. Manifest/package versions match the release tag.
5. A SHA-256 checksum is published.
6. Privacy/security documentation matches the implementation.
7. Third-party license provenance and corresponding-source requirements are satisfied.
8. The manual acceptance checklist in `docs/RELEASE.md` is complete for each
   browser/OS combination claimed as verified in release notes.
9. Repository release controls described in `docs/RELEASE.md` are enabled before
   the release approval switch is committed.

## YouTube boundary

`src/youtube.js`, YouTube mux handlers, and yt-dlp UI are features of the full
self-distributed build. Their presence is an intentional signal that the
artifact is **not** the Web Store edition.

If a Web Store edition is created in the future, CI must fail unless all of the
following are absent from that artifact:

- the YouTube MAIN-world content script
- `src/youtube.js`
- YouTube adaptive mux handlers
- yt-dlp command UI/code
- listing/README claims for YouTube downloading

Until such a separate flavor exists, no `media-sniper.zip` produced by this
repository should be uploaded to the Chrome Web Store.

## Updates

Self-distributed installations are updated by replacing the unpacked extension
folder with the new release and reloading the extension from the browser's
extensions page. Release notes must call out permission, privacy, data-flow,
security, browser-support, and third-party dependency changes.

## Support scope

The support and compatibility contract is defined in `SUPPORT.md`. In short:

- the latest workflow-produced GitHub Release is the supported public artifact;
- current stable Chrome and Brave are the intended interactive desktop targets,
  but a browser/OS combination is only called verified after the release
  checklist is run on it;
- Firefox and Safari are not supported by the current implementation;
- repackaged third-party artifacts are outside the project support contract.

Store-specific billing, automatic Web Store updates, and Web Store review are
outside the support scope of the full build.
