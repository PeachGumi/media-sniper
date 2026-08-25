# Release process

Media Sniper's public full build is self-distributed through GitHub Releases. A Git tag alone is **not** sufficient to publish a release.

## CI gate

The same `.github/workflows/ci.yml` runs for pull requests, `main`, and `v*` tags.

Every run has three stages:

1. **test** — unit tests, syntax checks, manifest/package/UI version checks, reproducible-libav provenance/hash validation, package creation, required-file validation, privacy scan, and SHA-256 generation;
2. **e2e** — builds `media-sniper.zip`, extracts that exact ZIP, loads it unchanged in pinned Chrome for Testing to prove the MV3 artifact starts without required host permissions, then runs a localhost-only functional harness using the same runtime JavaScript/WASM bytes;
3. **artifact** — runs only after both earlier jobs succeed, rebuilds the ZIP, writes `media-sniper.zip.sha256`, and uploads both as a verified workflow artifact. For approved `v*` tags it also builds the matching libav.js/FFmpeg corresponding-source bundle and checksum before release publication.

The artifact job is therefore structurally unable to run when unit or browser E2E fails.

### Browser E2E trust boundary

Headless Chrome cannot approve the user-facing optional-host-permission confirmation dialog. CI must not pretend that consent happened. The E2E runner therefore separates artifact validation from functional media testing:

- **Gate 1:** the extracted distribution ZIP is loaded unchanged and must start successfully with no required `host_permissions`.
- **Gate 2:** the extracted artifact is copied to a throwaway directory and only the test copy's manifest receives `http://127.0.0.1/*`. Runtime JavaScript, HTML and WASM bytes are unchanged. Permission request/revoke semantics remain covered by unit/manifest checks and this manual release checklist.

The functional gate generates fresh valid H.264/AAC MPEG-TS HLS and AES-128 HLS fixtures with the host FFmpeg, verifies ordinary detection/direct download/settings/queue behavior, and then requires both plain and encrypted HLS to pass through the bundled libav.js/FFmpeg runtime, `-c copy` remux to MP4, Chromium download completion, non-trivial output size, and an MP4 `ftyp` signature.

This generated-fixture design deliberately avoids treating stale or corrupted checked-in binary media as a runtime regression.

## Public GitHub Release

For a tag such as `v1.0.0`:

- the tag version must exactly equal `manifest.json` and `package.json`;
- test and packaged-artifact browser E2E must both pass;
- the bundled libav.js module/WASM hashes must match `src/libav/PROVENANCE.json`;
- the repository must contain `docs/RELEASE_APPROVED` with exactly the text `approved`;
- only then does CI call `gh release create`.

An approved release attaches:

- `media-sniper.zip`;
- `media-sniper.zip.sha256`;
- `media-sniper-libav-corresponding-source.tar.gz`;
- `media-sniper-libav-corresponding-source.tar.gz.sha256`.

The corresponding-source bundle is assembled from the exact pinned libav.js revision, generated custom variant configuration, extracted dependency sources, rebuild recipe, and shipped provenance used for the runtime binary.

`docs/RELEASE_APPROVED` is intentionally absent while a commercial/v1.0 release blocker remains. It is a final explicit repository-level release switch, not a substitute for resolving the tracked blockers.

## Chrome for Testing

Modern branded Chrome builds no longer support command-line unpacked-extension loading used by this E2E harness. CI therefore pins Chrome for Testing to a known version. On GitHub-hosted Ubuntu, a CI-only wrapper supplies `--no-sandbox` because the hosted runner restricts the user namespace Chrome normally uses. Normal user/browser execution does not use that wrapper.

The functional HLS fixtures are generated at test time and therefore require a host `ffmpeg` executable. CI installs it explicitly; local `npm run e2e` users must also have `ffmpeg` on `PATH`.

## Manual release checklist

Before adding `docs/RELEASE_APPROVED` and creating a `v*` tag:

- all v1.0 blocker issues in the release-readiness tracker are resolved or explicitly scoped out with documented rationale;
- privacy, permissions, security, third-party notices, supported browsers, and known limitations match the actual artifact;
- optional site/all-sites grant and revoke are manually exercised in a normal interactive browser, because CI does not auto-approve permission consent;
- libav.js/FFmpeg corresponding-source and build provenance requirements are satisfied for commercial distribution;
- large-media behavior is within the documented safety envelope;
- clean-profile install → disclosure → detect → save has been accepted on supported browser/OS combinations;
- support/update/refund policy is defined for any paid distribution channel.

Do not manually upload a different ZIP to a release and call it CI-verified. The release assets are expected to be the outputs created by the tag workflow.
