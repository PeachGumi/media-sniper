# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| latest on `main` | yes |
| older tags | no |

## Reporting a vulnerability

Please do NOT open a public issue for security problems.

Use GitHub's private vulnerability reporting (Security tab → Report a
vulnerability), or contact the maintainer directly. Include:

- Browser and version affected
- Steps to reproduce or a proof of concept
- Impact assessment

You'll get a response within a week. Once fixed, credit is yours if you want it.

## Scope notes

This extension handles media URLs and downloads them with the user's own
browser session. Areas of particular interest to security review:

- The page-world bridge (`src/bridge.js`) and its postMessage protocol —
  messages from the page are untrusted input; only fixed `source` markers
  are accepted and payloads are shape-checked downstream
- Header capture/replay (`capturedReqHeaders` in `src/background.js`) —
  captured Authorization headers are used only for fetching the same URL
  the player requested, never persisted, never sent anywhere else
- The offscreen document's fetch + ffmpeg pipeline (`src/offscreen.js`)
- Filename sanitization (`sanitizeFilename`, `sanitizeRootFolder` in
  `src/logic.js`) — path traversal must remain impossible

There is intentionally no server side: nothing to compromise beyond the
browser itself.
