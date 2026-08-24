/* Media Sniper security boundary for the MV3 service worker.
 *
 * This module deliberately sits in front of background.js. It keeps the large
 * media pipeline unchanged while enforcing three invariants at the boundary:
 *   1. request credentials are promoted into the media cache only after the
 *      response is confirmed to be media;
 *   2. captured credentials are bound to the origin that originally sent them;
 *   3. page/content-script messages cannot directly invoke privileged download
 *      operations and all page-originated media reports are shape-checked.
 */
'use strict';

const MediaSniperSecurity = (function () {
  const META_SOURCE_ORIGIN = 'x-media-sniper-source-origin';
  const PENDING_TTL_MS = 15000;
  const PENDING_MAX = 256;
  const MAX_REPORT_ITEMS = 500;
  const MAX_TEXT = 500;

  const CONTENT_TYPES = new Set(['ms-page-meta', 'ms-report']);
  const UI_TYPES = new Set([
    'ms-get-items', 'ms-get-settings', 'ms-set-settings', 'ms-download-all',
    'ms-yt-mux-download', 'ms-clear', 'ms-download', 'ms-download-blob',
    'ms-hls-download', 'ms-hls-stop', 'ms-hls-status', 'ms-queue-status',
  ]);
  const EXTENSION_INTERNAL_TYPES = new Set(['ms-offscreen-progress', 'ms-hls-progress']);
  const ALLOWED_KINDS = new Set(['video', 'audio', 'hls', 'hls-audio', 'dash', 'ts']);
  const ALLOWED_VIA = new Set(['element', 'blob-size', 'youtube']);

  function originOf(url) {
    try {
      const u = new URL(String(url || ''));
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
      if (u.protocol === 'blob:') return new URL(u.pathname).origin;
    } catch (e) { /* invalid */ }
    return null;
  }

  function hostOf(url) {
    try {
      const u = new URL(String(url || ''));
      return (u.hostname || '').toLowerCase();
    } catch (e) { return ''; }
  }

  function isAllowedMediaUrl(url) {
    try {
      const u = new URL(String(url || ''));
      return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'blob:';
    } catch (e) { return false; }
  }

  function isYoutubeHost(host) {
    const h = String(host || '').toLowerCase();
    return h === 'youtube.com' || h.endsWith('.youtube.com');
  }

  function isYoutubeMediaHost(host) {
    const h = String(host || '').toLowerCase();
    return h === 'googlevideo.com' || h.endsWith('.googlevideo.com') || isYoutubeHost(h);
  }

  function isBlacklisted(host, raw) {
    const h = String(host || '').toLowerCase();
    if (!h) return false;
    for (const entry of String(raw || '').toLowerCase().split(/[\n,]/)) {
      let p = entry.trim().replace(/^https?:\/\//, '').replace(/^www\./, '');
      if (!p) continue;
      if (p.includes('/')) p = p.slice(0, p.indexOf('/'));
      if (h === p || h.endsWith('.' + p)) return true;
    }
    return false;
  }

  function captureAllowedName(name) {
    const n = String(name || '').toLowerCase();
    // Do not capture arbitrary X-* request headers. Those frequently contain
    // CSRF/API/session tokens unrelated to media. Add narrowly scoped entries
    // only when a concrete media provider requires one and tests cover it.
    return n === 'authorization' || n === 'referer' || n === 'origin';
  }

  function isSensitiveName(name) {
    const n = String(name || '').toLowerCase();
    return n === 'authorization' || n === 'proxy-authorization' ||
      n === 'cookie' || n === 'set-cookie' || n.startsWith('x-');
  }

  function headerEntries(headers) {
    if (!headers) return [];
    if (Array.isArray(headers)) {
      return headers.map(function (h) { return [String(h.name || ''), String(h.value || '')]; });
    }
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      return Array.from(headers.entries());
    }
    return Object.keys(headers).map(function (k) { return [k, String(headers[k])]; });
  }

  function sourceOriginFromHeaders(headers) {
    for (const [name, value] of headerEntries(headers)) {
      if (name.toLowerCase() === META_SOURCE_ORIGIN) return value || null;
    }
    return null;
  }

  function sanitizeHeadersForTargets(headers, targets) {
    const entries = headerEntries(headers);
    if (!entries.length) return {};
    const sourceOrigin = sourceOriginFromHeaders(headers);
    const targetOrigins = (targets || []).map(originOf).filter(Boolean);
    const sameOrigin = !!sourceOrigin && targetOrigins.length > 0 &&
      targetOrigins.every(function (o) { return o === sourceOrigin; });
    const out = {};
    for (const [name, value] of entries) {
      const lower = name.toLowerCase();
      if (lower === META_SOURCE_ORIGIN) continue; // internal metadata, never network
      if (isSensitiveName(lower) && !sameOrigin) continue;
      out[name] = value;
    }
    return out;
  }

  function responseLooksMedia(details) {
    if (!details || details.statusCode < 200 || details.statusCode > 299) return false;
    let contentType = '';
    for (const h of details.responseHeaders || []) {
      if (String(h.name || '').toLowerCase() === 'content-type') {
        contentType = String(h.value || '').toLowerCase().split(';')[0].trim();
        break;
      }
    }
    if (contentType.startsWith('video/') || contentType.startsWith('audio/')) return true;
    if (contentType.includes('mpegurl') || contentType.includes('dash+xml')) return true;
    if (contentType === 'application/octet-stream') {
      return /\.(mp4|m4v|webm|mkv|mov|flv|ogv|mp3|m4a|aac|ogg|opus|wav|flac)(?:$|[?#])/i.test(details.url || '');
    }
    if (contentType.startsWith('text/') || contentType.includes('json')) return false;
    return /\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|flv|ogv|mp3|m4a|aac|ogg|opus|wav|flac|ts|m4s|m2ts)(?:$|[?#])/i.test(details.url || '');
  }

  function cleanText(value, maxLen) {
    const s = String(value == null ? '' : value);
    return s.length > maxLen ? s.slice(0, maxLen) : s;
  }

  function finiteNonNegative(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  function sanitizeReportedItem(raw, senderUrl) {
    if (!raw || typeof raw !== 'object' || !isAllowedMediaUrl(raw.url)) return null;
    const kind = String(raw.kind || '');
    if (kind && !ALLOWED_KINDS.has(kind)) return null;
    const via = String(raw.via || '');
    if (via && !ALLOWED_VIA.has(via)) return null;

    if (via === 'youtube') {
      const senderHost = hostOf(senderUrl);
      const mediaHost = hostOf(raw.url);
      if (!isYoutubeHost(senderHost) || !isYoutubeMediaHost(mediaHost)) return null;
    }

    const out = {
      url: String(raw.url),
      kind: kind || null,
      contentType: raw.contentType == null ? null : cleanText(raw.contentType, 200),
      size: finiteNonNegative(raw.size),
      via: via || null,
      pageUrl: senderUrl || null,
      duration: finiteNonNegative(raw.duration),
    };
    if (raw.title != null) out.title = cleanText(raw.title, MAX_TEXT);
    if (raw.ext != null) out.ext = cleanText(raw.ext, 12).replace(/[^a-z0-9]/gi, '').toLowerCase() || null;
    if (raw.audioUrl && isAllowedMediaUrl(raw.audioUrl)) out.audioUrl = String(raw.audioUrl);
    if (raw.dashEntry != null && Number.isInteger(Number(raw.dashEntry))) out.dashEntry = Number(raw.dashEntry);
    if (raw.dashType === 'video' || raw.dashType === 'audio') out.dashType = raw.dashType;
    return out;
  }

  function isExtensionSender(sender, extensionId) {
    if (!sender || sender.id !== extensionId) return false;
    const url = String(sender.url || sender.documentUrl || '');
    return url.startsWith('chrome-extension://' + extensionId + '/');
  }

  function normalizeInboundMessage(msg, sender, extensionId) {
    if (!msg || typeof msg.type !== 'string') return { ok: false, error: 'invalid message' };
    const type = msg.type;

    if (CONTENT_TYPES.has(type)) {
      if (!sender || sender.id !== extensionId || !sender.tab) return { ok: false, error: 'content sender required' };
      const senderUrl = String(sender.url || sender.tab.url || '');
      if (type === 'ms-page-meta') {
        return {
          ok: true,
          msg: { type: type, title: cleanText(msg.title, MAX_TEXT), url: senderUrl },
        };
      }
      const cleaned = [];
      for (const raw of (Array.isArray(msg.items) ? msg.items.slice(0, MAX_REPORT_ITEMS) : [])) {
        const item = sanitizeReportedItem(raw, senderUrl);
        if (item) cleaned.push(item);
      }
      return { ok: true, msg: { type: type, items: cleaned } };
    }

    if (UI_TYPES.has(type)) {
      // Content scripts have sender.tab. Privileged operations must originate
      // from our own popup/options/extension page, never from a web page.
      if (!isExtensionSender(sender, extensionId) || sender.tab) return { ok: false, error: 'extension UI sender required' };
      return { ok: true, msg: msg };
    }

    if (EXTENSION_INTERNAL_TYPES.has(type)) {
      if (!isExtensionSender(sender, extensionId)) return { ok: false, error: 'extension sender required' };
      return { ok: true, msg: msg };
    }

    return { ok: true, msg: msg };
  }

  function collectTargets(msg) {
    const out = [];
    function add(v) { if (typeof v === 'string' && isAllowedMediaUrl(v)) out.push(v); }
    if (!msg || typeof msg !== 'object') return out;
    add(msg.url); add(msg.audioUrl); add(msg.initUrl); add(msg.videoUrl);
    for (const u of msg.segments || []) add(u);
    for (const track of [msg.video, msg.audio]) {
      if (!track) continue;
      add(track.initUrl);
      for (const u of track.segments || []) add(u);
    }
    return out;
  }

  let prepared = false;
  let capturedHeaderRegistration = null;
  let capturedResponseRegistration = null;
  let originals = null;
  let blacklist = '';
  const pending = new Map();

  function prunePending(now) {
    const t = now || Date.now();
    for (const [id, p] of pending) {
      if (t - p.at > PENDING_TTL_MS) pending.delete(id);
    }
    while (pending.size > PENDING_MAX) pending.delete(pending.keys().next().value);
  }

  function prepare(chromeObj) {
    if (prepared) return;
    prepared = true;
    const c = chromeObj || chrome;
    originals = {
      sendHeadersAdd: c.webRequest.onSendHeaders.addListener.bind(c.webRequest.onSendHeaders),
      responseAdd: c.webRequest.onResponseStarted.addListener.bind(c.webRequest.onResponseStarted),
      runtimeMessageAdd: c.runtime.onMessage.addListener.bind(c.runtime.onMessage),
      runtimeSendMessage: c.runtime.sendMessage.bind(c.runtime),
      fetch: globalThis.fetch ? globalThis.fetch.bind(globalThis) : null,
    };

    // Capture background.js registrations so activation can put our promotion
    // listener ahead of background's response handler.
    c.webRequest.onSendHeaders.addListener = function (fn, filter, extraInfoSpec) {
      if (!capturedHeaderRegistration) {
        capturedHeaderRegistration = { fn: fn, filter: filter, extraInfoSpec: extraInfoSpec };
        return;
      }
      return originals.sendHeadersAdd(fn, filter, extraInfoSpec);
    };
    c.webRequest.onResponseStarted.addListener = function (fn, filter, extraInfoSpec) {
      if (!capturedResponseRegistration) {
        capturedResponseRegistration = { fn: fn, filter: filter, extraInfoSpec: extraInfoSpec };
        return;
      }
      return originals.responseAdd(fn, filter, extraInfoSpec);
    };

    // Wrap the single background runtime listener with an explicit trust gate.
    c.runtime.onMessage.addListener = function (fn) {
      const guarded = function (msg, sender, sendResponse) {
        const normalized = normalizeInboundMessage(msg, sender, c.runtime.id);
        if (!normalized.ok) {
          try { sendResponse({ error: 'rejected by security policy' }); } catch (e) { /* no receiver */ }
          return false;
        }
        return fn(normalized.msg, sender, sendResponse);
      };
      return originals.runtimeMessageAdd(guarded);
    };

    // Ensure internal origin metadata never leaves the service worker and bind
    // replayed credentials to the origin that originally sent them.
    c.runtime.sendMessage = function (message) {
      const args = Array.prototype.slice.call(arguments, 1);
      let outbound = message;
      if (message && typeof message === 'object' && /^ms-offscreen-/.test(message.type || '') && message.headers) {
        outbound = Object.assign({}, message, {
          headers: sanitizeHeadersForTargets(message.headers, collectTargets(message)),
        });
      }
      return originals.runtimeSendMessage.apply(null, [outbound].concat(args));
    };

    if (originals.fetch) {
      globalThis.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url);
        if (init && init.headers) {
          init = Object.assign({}, init, { headers: sanitizeHeadersForTargets(init.headers, [url]) });
        }
        return originals.fetch(input, init);
      };
    }

    // Keep blacklist hot in memory; header promotion is synchronous.
    try {
      c.storage.local.get('blacklist').then(function (r) { blacklist = String(r.blacklist || ''); }).catch(function () {});
      if (c.storage.onChanged) {
        c.storage.onChanged.addListener(function (changes, area) {
          if (area === 'local' && changes.blacklist) blacklist = String(changes.blacklist.newValue || '');
        });
      }
    } catch (e) { /* defaults are safe */ }
  }

  function activate(chromeObj) {
    const c = chromeObj || chrome;
    if (!prepared || !originals) return;

    // Restore public registration methods first; only the already-captured
    // background listeners remain wrapped.
    c.webRequest.onSendHeaders.addListener = originals.sendHeadersAdd;
    c.webRequest.onResponseStarted.addListener = originals.responseAdd;
    c.runtime.onMessage.addListener = originals.runtimeMessageAdd;

    if (capturedHeaderRegistration && capturedResponseRegistration) {
      const filter = capturedHeaderRegistration.filter;
      originals.sendHeadersAdd(function (details) {
        try {
          prunePending();
          if (!details || details.requestId == null || !details.url) return;
          if (isBlacklisted(hostOf(details.url), blacklist)) return;
          const headers = (details.requestHeaders || []).filter(function (h) { return captureAllowedName(h.name); });
          if (!headers.length) return;
          pending.set(details.requestId, {
            at: Date.now(),
            details: Object.assign({}, details, { requestHeaders: headers }),
          });
          prunePending();
        } catch (e) { /* never disturb browsing */ }
      }, filter, capturedHeaderRegistration.extraInfoSpec || ['requestHeaders']);

      // Register promotion BEFORE background's detector. The background handler
      // can then immediately read the exact-URL media header cache.
      originals.responseAdd(function (details) {
        try {
          const p = details && pending.get(details.requestId);
          if (!p) return;
          pending.delete(details.requestId);
          if (!responseLooksMedia(details)) return;
          if (isBlacklisted(hostOf(details.url), blacklist)) return;
          const sourceOrigin = originOf(details.url);
          const promoted = Object.assign({}, p.details, {
            requestHeaders: p.details.requestHeaders.concat(sourceOrigin ? [{ name: META_SOURCE_ORIGIN, value: sourceOrigin }] : []),
          });
          capturedHeaderRegistration.fn(promoted);
        } catch (e) { /* fail closed: no credential promotion */ }
      }, capturedResponseRegistration.filter, ['responseHeaders']);

      originals.responseAdd(
        capturedResponseRegistration.fn,
        capturedResponseRegistration.filter,
        capturedResponseRegistration.extraInfoSpec
      );
    } else {
      // Unexpected API shape: preserve background functionality rather than
      // silently dropping all detection; no header promotion is installed.
      if (capturedHeaderRegistration) {
        originals.sendHeadersAdd(capturedHeaderRegistration.fn, capturedHeaderRegistration.filter, capturedHeaderRegistration.extraInfoSpec);
      }
      if (capturedResponseRegistration) {
        originals.responseAdd(capturedResponseRegistration.fn, capturedResponseRegistration.filter, capturedResponseRegistration.extraInfoSpec);
      }
    }
  }

  return {
    META_SOURCE_ORIGIN: META_SOURCE_ORIGIN,
    originOf: originOf,
    captureAllowedName: captureAllowedName,
    isSensitiveName: isSensitiveName,
    sanitizeHeadersForTargets: sanitizeHeadersForTargets,
    responseLooksMedia: responseLooksMedia,
    sanitizeReportedItem: sanitizeReportedItem,
    normalizeInboundMessage: normalizeInboundMessage,
    collectTargets: collectTargets,
    prepare: prepare,
    activate: activate,
  };
})();

globalThis.MediaSniperSecurity = MediaSniperSecurity;
if (typeof module !== 'undefined' && module.exports) module.exports = MediaSniperSecurity;
