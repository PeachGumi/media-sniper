# Contributing to Media Sniper

Thanks for your interest! This document covers the essentials.

## Development setup

Requirements:

- Node.js 24 recommended (CI uses Node 24)
- Python 3.12+ for browser E2E
- `ffmpeg` on `PATH` for generated HLS/AES fixtures
- a Chromium-based browser; CI installs a pinned Chrome for Testing build

There are no runtime npm dependencies.

```bash
npm test
npm run check
npm run zip
npm run e2e
```

`npm run e2e` creates a throwaway browser profile, loads the packaged extension, generates valid media fixtures, and exercises the browser/offscreen/libav path. The runner supports CI and local environments through environment variables; it is not tied to a fixed extension ID or one machine path.

## How the code is organized

See the project layout section in the README. Key rule: **pure parsing/sanitization logic belongs in `src/logic.js` or another explicitly pure helper module**. Code that touches `chrome.*` stays in extension-context modules and should be covered by the strict fake-Chrome harness or browser E2E.

## Testing expectations

- New pure logic → add/update Node tests under `test/`.
- Service-worker behavior → extend the background/security/lifecycle tests. The fake `chrome.*` harness is deliberately strict; match the real API shape instead of weakening the mock.
- Security-boundary changes → add negative tests for rejected senders, URL/origin changes, and retained/replayed headers.
- User-visible media flows → extend browser E2E when practical.
- libav build-input changes → update `tools/libav/config.json`; the rebuild workflow must regenerate the runtime and `PROVENANCE.json` on the same branch before merge.

CI runs three release-oriented jobs on pull requests:

1. `test` — unit tests, syntax, manifest/version/permission checks, libav provenance/hash validation, packaging and privacy scan;
2. `e2e` — exact-artifact startup plus localhost-only functional browser testing, including plain and AES-128 HLS remux;
3. `artifact` — only after both earlier jobs pass, rebuilds and uploads the verified ZIP/checksum.

Do not merge a release-affecting change with any of these jobs failing.

## Code style

- Plain modern JavaScript; no transpiler or remote runtime code
- Single quotes, 2-space indent, semicolons
- Comments explain **why**, not what
- Page-facing code must treat page data as untrusted and fail closed at privileged boundaries

## Privacy and security rules

- No analytics or telemetry without an explicit product/privacy decision and review
- No remote JavaScript or WebAssembly loading
- Do not broaden required host access; site access is optional and user-controlled
- Never forward captured sensitive headers across an unsafe origin boundary
- Do not persist captured authentication headers
- Keep page/content-script messages untrusted until validated in extension context

The CI privacy/security checks catch mechanical regressions; reviewers still need to evaluate data flow and privilege boundaries.

## Pull requests

1. Branch from `main`.
2. Keep the PR focused.
3. Run `npm test && npm run check` before pushing.
4. Describe what changed and how it was verified (unit / E2E / manual).
5. Do not add `docs/RELEASE_APPROVED` merely to make a tag publish. That file is the final release switch and is only appropriate after the checklist in `docs/RELEASE.md` is satisfied.

## Reporting bugs

Open an issue with browser + version, the page/site shape (a public example is ideal), expected vs. actual behavior, and relevant extension service-worker/offscreen console output.

Please do not include copyrighted media or links to pirated content in issues. For exploitable security problems, follow `SECURITY.md` and use private vulnerability reporting instead of a public issue.
