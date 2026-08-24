# Release process

Media Sniper's public full build is self-distributed through GitHub Releases. A Git tag alone is **not** sufficient to publish a release.

## CI gate

The same `.github/workflows/ci.yml` runs for pull requests, `main`, and `v*` tags.

Every run has three stages:

1. **test** — unit tests, syntax checks, manifest/package/UI version checks, package creation, required-file validation, privacy scan, and SHA-256 generation;
2. **e2e** — builds `media-sniper.zip`, extracts that exact ZIP to a clean directory, loads the extracted artifact in pinned Chrome for Testing, and runs browser detection/download/settings fixtures;
3. **artifact** — runs only after both earlier jobs succeed, rebuilds the ZIP, writes `media-sniper.zip.sha256`, and uploads both as a verified workflow artifact.

The artifact job is therefore structurally unable to run when unit or browser E2E fails.

## Public GitHub Release

For a tag such as `v1.0.0`:

- the tag version must exactly equal `manifest.json` and `package.json`;
- test and packaged-artifact browser E2E must both pass;
- the repository must contain `docs/RELEASE_APPROVED` with exactly the text `approved`;
- only then does CI call `gh release create` and attach both `media-sniper.zip` and `media-sniper.zip.sha256`.

`docs/RELEASE_APPROVED` is intentionally absent while a commercial/v1.0 release blocker remains. It is a final explicit repository-level release switch, not a substitute for resolving the tracked blockers.

## Chrome for Testing

Modern branded Chrome builds no longer support command-line unpacked-extension loading used by this E2E harness. CI therefore pins Chrome for Testing to a known version. On GitHub-hosted Ubuntu, a CI-only wrapper supplies `--no-sandbox` because the hosted runner restricts the user namespace Chrome normally uses. Normal user/browser execution does not use that wrapper.

## Manual release checklist

Before adding `docs/RELEASE_APPROVED` and creating a `v*` tag:

- all v1.0 blocker issues in the release-readiness tracker are resolved or explicitly scoped out with documented rationale;
- privacy, permissions, security, third-party notices, supported browsers, and known limitations match the actual artifact;
- libav.js/FFmpeg corresponding-source and build provenance requirements are satisfied for commercial distribution;
- large-media behavior is within the documented safety envelope;
- clean-profile install → disclosure → detect → save has been accepted on supported browser/OS combinations;
- support/update/refund policy is defined for any paid distribution channel.

Do not manually upload a different ZIP to a release and call it CI-verified. The release assets are expected to be the outputs created by the tag workflow.
