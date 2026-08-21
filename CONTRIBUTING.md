# Contributing to Media Sniper

Thanks for your interest! This document covers the essentials.

## Development setup

Requirements: Node.js 18+ and a Chromium-based browser (Chrome/Brave) for E2E.

```bash
npm install -g nothing   # there are no runtime deps; scripts are stdlib-only
npm test                 # 345 unit tests across 7 suites
npm run e2e              # headless E2E (macOS path baked in; see scripts/run_e2e.py)
```

There is no build step. The repository is loaded directly via
"Load unpacked" in `brave://extensions`.

## How the code is organized

See the project layout section in the README. Key rule: **all pure logic
belongs in `src/logic.js`** — it runs in the service worker, the popup, the
page world and Node tests. Anything that touches `chrome.*` stays out of it.

## Testing expectations

- New logic → new tests in `test/logic*.test.js` (plain node, no framework)
- Service-worker behavior → extend `test/background*.test.js`. The fake
  `chrome.*` harness is deliberately strict (argument contracts, callback +
  promise forms). If your change needs a looser mock, that's a smell —
  match the real API shape instead.
- User-visible flows should get an E2E step in `scripts/e2e_download_test.py`
  when practical.

CI runs the unit suite, syntax checks, manifest validation, packaging and a
privacy scan on every push and PR.

## Code style

- Plain ES2017+, no transpiler, no bundler
- Single quotes, 2-space indent, semicolons
- Comments explain **why**, not what
- Defensive boundaries: page-facing code (bridge/content/youtube adapters)
  must never throw into the page — wrap and swallow

## Privacy rules (hard requirements)

- No analytics, telemetry, or remote code loading
- No new host permissions beyond what a feature strictly needs
- No requests to any endpoint except CDNs serving media the user asked to save
- The CI privacy scan enforces the obvious patterns; reviewers enforce the rest

## Pull requests

1. Fork + branch from `main`
2. Keep PRs focused; one feature or fix per PR
3. Run `npm test && npm run check` before pushing
4. Describe what changed and how you verified it (unit / E2E / manual)

## Reporting bugs

Open an issue with: browser + version, the page/site shape (a public example
is ideal), what you expected vs. what happened, and any console output from
the extension's service worker (`brave://extensions` → Media Sniper →
service worker link).

Please do not include copyrighted media or links to pirated content in
issues.
