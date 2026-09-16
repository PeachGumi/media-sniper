/* Host-access preflight.
 *
 * The reference implementation (VDH) declares host_permissions: ['<all_urls>'],
 * so every media host is reachable from its own contexts. Media Sniper asks for
 * site access at runtime instead, which leaves one real capability gap: media
 * on a second origin (a CDN, a separate media host, a redirect target) cannot
 * be fetched until that host is granted. The blocked request surfaces as a bare
 * "Failed to fetch", which reads like a bug in the download itself.
 *
 * This module turns that case into something actionable: it names the hosts that
 * are missing, carries them across context boundaries (offscreen -> worker ->
 * popup) so the popup can offer a one-click grant, and retries the same job
 * afterwards.
 *
 * Loaded by the service worker (importScripts), the offscreen document and the
 * popup, and testable in Node with a stubbed `chrome`.
 */
(function () {
  'use strict';

  const MARKER = 'ms-host-access';
  const HTTP_PATTERNS = ['http://*/*', 'https://*/*'];

  function parse(raw) {
    try { return new URL(String(raw)); } catch (_) { return null; }
  }

  // 'https://cdn.example.com/*' for http(s) URLs, null for anything else
  // (blob:, data:, chrome-extension:, files on disk).
  function patternFor(url) {
    const parsed = parse(url);
    if (!parsed) return null;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.protocol + '//' + parsed.host + '/*';
  }

  function hostFor(url) {
    const parsed = parse(url);
    return parsed ? parsed.host : null;
  }

  function hostOfPattern(pattern) {
    return String(pattern || '').replace(/^https?:\/\//, '').replace(/\/\*$/, '');
  }

  function uniquePatterns(list) {
    const out = [];
    const seen = new Set();
    for (const raw of list || []) {
      const pattern = patternFor(raw);
      if (pattern && !seen.has(pattern)) { seen.add(pattern); out.push(pattern); }
    }
    return out;
  }

  function isHostAccessError(err) {
    return !!(err && (err.marker === MARKER || err.name === 'HostAccessError' || err.code === MARKER));
  }

  function error(missing) {
    const patterns = uniquePatterns(missing);
    const hosts = (patterns.length ? patterns : (missing || [])).map(hostOfPattern).filter(Boolean);
    const err = new Error('配信元へのアクセス許可がありません: ' + (hosts.join(', ') || 'unknown'));
    err.name = 'HostAccessError';
    err.code = MARKER;
    err.marker = MARKER;
    err.hostPatterns = patterns;
    err.hosts = hosts;
    return err;
  }

  // Structured info for a failure that crossed a context boundary (offscreen ->
  // worker -> popup): the message is user-facing text, so the hosts travel in a
  // separate field instead of being parsed back out of it.
  function info(err) {
    if (!err) return null;
    if (isHostAccessError(err)) {
      const patterns = Array.isArray(err.hostPatterns) ? err.hostPatterns.slice() : [];
      return { message: String(err.message || ''), patterns: patterns, hosts: hostsFor(patterns) };
    }
    return null;
  }

  function hostsFor(patterns) {
    return (patterns || []).map(hostOfPattern).filter(Boolean);
  }

  function permissionsApi() {
    try {
      if (typeof chrome !== 'undefined' && chrome.permissions && chrome.permissions.contains) return chrome.permissions;
    } catch (_) { /* not an extension context */ }
    return null;
  }

  async function granted(patterns) {
    const list = uniquePatterns(patterns);
    if (!list.length) return [];
    const api = permissionsApi();
    if (!api) return [];
    const out = [];
    for (const pattern of list) {
      try {
        if (await api.contains({ origins: [pattern] })) out.push(pattern);
      } catch (_) { /* treat an unreadable state as missing, never as granted */ }
    }
    return out;
  }

  // Patterns the extension may not fetch. Returns [] when the permissions API
  // is unavailable (unit tests, non-extension contexts): the caller then keeps
  // its normal error path instead of inventing a permission failure.
  async function missing(urls) {
    const wanted = uniquePatterns(urls);
    if (!wanted.length) return [];
    const api = permissionsApi();
    if (!api) return [];
    const have = new Set(await granted(wanted));
    return wanted.filter(function (pattern) { return !have.has(pattern); });
  }

  // ---- pending failure, recorded where the fetch actually happened ---------
  // jsfetch reports a blocked request to libav, which reports it to the job, so
  // the host information would be lost if it were not recorded at the fetch.
  let pending = [];
  function record(urlOrPatterns) {
    const patterns = uniquePatterns(Array.isArray(urlOrPatterns) ? urlOrPatterns : [urlOrPatterns]);
    for (const pattern of patterns) if (pending.indexOf(pattern) === -1) pending.push(pattern);
    return patterns;
  }
  function takePending() {
    const out = pending.slice();
    pending = [];
    return out;
  }
  function pendingPatterns() { return pending.slice(); }

  // Map a failed fetch to the preflight error shape when the reason is a
  // missing host grant; otherwise return null and let the caller keep its own
  // error handling.
  async function describeFetchFailure(url, err) {
    const typeError = err && (err.name === 'TypeError' || /failed to fetch|networkerror|load failed/i.test(String(err.message || '')));
    if (!typeError) return null;
    const pattern = patternFor(url);
    if (!pattern) return null;
    const absent = await missing([url]);
    if (!absent.length) return null;
    return { patterns: record(absent), hosts: hostsFor(absent), message: error(absent).message };
  }

  const api = {
    MARKER,
    HTTP_PATTERNS,
    patternFor,
    hostFor,
    hostOfPattern,
    hostsFor,
    uniquePatterns,
    error,
    info,
    isHostAccessError,
    missing,
    granted,
    record,
    takePending,
    pendingPatterns,
    describeFetchFailure,
  };

  globalThis.MediaSniperHostAccess = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
