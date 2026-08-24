/* Background lifecycle policy.
 *
 * Loaded after background.js in the same classic-script service-worker realm.
 * It can therefore see the background's global lexical state without making
 * that large legacy file expose privileged internals on globalThis.
 */
'use strict';

(function () {
  const QUEUE_TERMINAL_MAX = 100;
  const QUEUE_TERMINAL_TTL_MS = 10 * 60 * 1000;
  const JOB_TERMINAL_MAX = 100;
  const JOB_TERMINAL_TTL_MS = 10 * 60 * 1000;
  const CAPTURED_HEADERS_TTL_MS = 5 * 60 * 1000;
  const REVOKED_URL_MAX = 256;

  function isTerminalStatus(status) {
    return status === 'complete' || status === 'failed' || status === 'aborted';
  }

  function pruneQueue(queue, now) {
    const t = now == null ? Date.now() : now;
    const terminals = [];
    for (const entry of queue || []) {
      if (!entry || !isTerminalStatus(entry.status)) continue;
      if (!entry._terminalAt) entry._terminalAt = t;
      if (t - entry._terminalAt <= QUEUE_TERMINAL_TTL_MS) terminals.push(entry);
    }
    terminals.sort(function (a, b) { return (b._terminalAt || 0) - (a._terminalAt || 0); });
    const keepTerminal = new Set(terminals.slice(0, QUEUE_TERMINAL_MAX));
    const kept = (queue || []).filter(function (entry) {
      if (!entry || !isTerminalStatus(entry.status)) return true;
      return keepTerminal.has(entry) && t - (entry._terminalAt || t) <= QUEUE_TERMINAL_TTL_MS;
    });
    if (queue && kept.length !== queue.length) queue.splice.apply(queue, [0, queue.length].concat(kept));
    return kept.length;
  }

  function pruneJobs(jobMap, now) {
    const t = now == null ? Date.now() : now;
    const terminals = [];
    if (!jobMap || typeof jobMap.forEach !== 'function') return 0;
    jobMap.forEach(function (job, key) {
      if (!job || !isTerminalStatus(job.status)) return;
      if (!job._terminalAt) job._terminalAt = t;
      if (t - job._terminalAt > JOB_TERMINAL_TTL_MS) jobMap.delete(key);
      else terminals.push([key, job]);
    });
    terminals.sort(function (a, b) { return (b[1]._terminalAt || 0) - (a[1]._terminalAt || 0); });
    for (let i = JOB_TERMINAL_MAX; i < terminals.length; i++) jobMap.delete(terminals[i][0]);
    return jobMap.size;
  }

  function pruneCapturedHeaders(headerMap, timeMap, now) {
    const t = now == null ? Date.now() : now;
    if (!headerMap || !timeMap) return 0;
    for (const [key, at] of timeMap) {
      if (t - at > CAPTURED_HEADERS_TTL_MS) {
        timeMap.delete(key);
        headerMap.delete(key);
      } else if (!headerMap.has(key)) {
        timeMap.delete(key);
      }
    }
    return headerMap.size;
  }

  function isOwnedExtensionBlob(url, extensionId) {
    return typeof url === 'string' && !!extensionId &&
      url.indexOf('blob:chrome-extension://' + extensionId + '/') === 0;
  }

  function installRuntime() {
    if (typeof state === 'undefined' || typeof mediaChains === 'undefined' ||
        typeof capturedReqHeaders === 'undefined' || typeof chrome === 'undefined') return;

    const capturedTimes = new Map();
    const revokedUrls = new Map();

    function rememberRevoked(url) {
      revokedUrls.delete(url);
      revokedUrls.set(url, Date.now());
      while (revokedUrls.size > REVOKED_URL_MAX) revokedUrls.delete(revokedUrls.keys().next().value);
    }

    function revokeOwnedUrl(url) {
      if (!isOwnedExtensionBlob(url, chrome.runtime && chrome.runtime.id)) return;
      rememberRevoked(url);
      try {
        const p = chrome.runtime.sendMessage({ type: 'ms-offscreen-revoke-url', url: url });
        if (p && typeof p.catch === 'function') p.catch(function () { /* TTL remains the fallback */ });
      } catch (_) { /* offscreen may already be gone */ }
    }

    // Timestamp confirmed-media header cache entries without changing the
    // legacy value shape expected by headersFor()/tests.
    const rawHeaderSet = capturedReqHeaders.set.bind(capturedReqHeaders);
    const rawHeaderDelete = capturedReqHeaders.delete.bind(capturedReqHeaders);
    const rawHeaderClear = capturedReqHeaders.clear.bind(capturedReqHeaders);
    capturedReqHeaders.set = function (key, value) {
      capturedTimes.set(key, Date.now());
      return rawHeaderSet(key, value);
    };
    capturedReqHeaders.delete = function (key) {
      capturedTimes.delete(key);
      return rawHeaderDelete(key);
    };
    capturedReqHeaders.clear = function () {
      capturedTimes.clear();
      return rawHeaderClear();
    };

    if (typeof headersFor === 'function') {
      const rawHeadersFor = headersFor;
      headersFor = function (url, fallback) {
        pruneCapturedHeaders(capturedReqHeaders, capturedTimes);
        const key = L.itemKey(url);
        const result = rawHeadersFor(url, fallback);
        if (capturedReqHeaders.has(key)) capturedTimes.set(key, Date.now());
        return result;
      };
    }
    if (typeof enrichFromCapture === 'function') {
      const rawEnrich = enrichFromCapture;
      enrichFromCapture = function (item) {
        pruneCapturedHeaders(capturedReqHeaders, capturedTimes);
        const result = rawEnrich(item);
        if (item && capturedReqHeaders.has(L.itemKey(item.url))) capturedTimes.set(L.itemKey(item.url), Date.now());
        return result;
      };
    }

    // Keep terminal queue history long enough for popup polling, but never let
    // completed/failed entries grow for the whole browser session.
    if (typeof pump === 'function') {
      const rawPump = pump;
      pump = function () {
        pruneQueue(state.queue);
        pruneJobs(state.hlsJobs);
        pruneCapturedHeaders(capturedReqHeaders, capturedTimes);
        const ret = rawPump.apply(this, arguments);
        pruneQueue(state.queue);
        return ret;
      };
    }
    if (typeof enqueue === 'function') {
      const rawEnqueue = enqueue;
      enqueue = function () {
        pruneQueue(state.queue);
        const entry = rawEnqueue.apply(this, arguments);
        if (entry && entry.item && isOwnedExtensionBlob(entry.item.url, chrome.runtime.id)) {
          entry.ownedBlobUrl = entry.item.url;
        }
        pruneQueue(state.queue);
        return entry;
      };
    }

    // Track extension-created blob URLs at the downloads API boundary. This
    // also covers fallback downloads whose queue item itself is still http(s).
    if (chrome.downloads && typeof chrome.downloads.download === 'function') {
      const rawDownload = chrome.downloads.download.bind(chrome.downloads);
      const ownedByDownloadId = new Map();
      chrome.downloads.download = function (options, callback) {
        const owned = options && isOwnedExtensionBlob(options.url, chrome.runtime.id) ? options.url : null;
        function record(id) { if (owned && id != null) ownedByDownloadId.set(id, owned); }
        const wrappedCallback = typeof callback === 'function' ? function (id) {
          record(id);
          callback.apply(this, arguments);
          if (owned && id == null) revokeOwnedUrl(owned);
        } : callback;
        let result;
        try {
          result = rawDownload(options, wrappedCallback);
        } catch (e) {
          if (owned) revokeOwnedUrl(owned);
          throw e;
        }
        if (result && typeof result.then === 'function') {
          result.then(record, function () { if (owned) revokeOwnedUrl(owned); });
        }
        return result;
      };

      if (chrome.downloads.onChanged && typeof chrome.downloads.onChanged.addListener === 'function') {
        chrome.downloads.onChanged.addListener(function (delta) {
          const status = delta && delta.state && delta.state.current;
          if (status === 'complete' || status === 'interrupted') {
            const owned = ownedByDownloadId.get(delta.id);
            if (owned) {
              ownedByDownloadId.delete(delta.id);
              revokeOwnedUrl(owned);
            }
          }
          pruneQueue(state.queue);
          pruneJobs(state.hlsJobs);
        });
      }
    }

    // Local video/audio blobs used only as ffmpeg mux inputs must be released
    // as soon as the mux request settles. Also mask an offscreen recovery result
    // if its Blob URL has already been revoked in this SW lifetime.
    if (chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
      const rawSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = function (message) {
        const args = Array.prototype.slice.call(arguments, 1);
        const muxInputs = message && message.type === 'ms-offscreen-mux-local'
          ? [message.videoUrl, message.audioUrl].filter(function (u) { return isOwnedExtensionBlob(u, chrome.runtime.id); })
          : [];
        let result = rawSendMessage.apply(null, [message].concat(args));
        if (result && typeof result.then === 'function') {
          if (message && message.type === 'ms-offscreen-ffmpeg-status') {
            result = result.then(function (response) {
              if (response && response.done && revokedUrls.has(response.done.url)) {
                return Object.assign({}, response, { done: null });
              }
              return response;
            });
          }
          if (muxInputs.length) {
            result = result.finally(function () { muxInputs.forEach(revokeOwnedUrl); });
          }
        }
        return result;
      };
    }

    // New jobs naturally trigger pruning, bounding hlsJobs even when no popup
    // asks for status after old jobs finish.
    const rawJobSet = state.hlsJobs.set.bind(state.hlsJobs);
    state.hlsJobs.set = function (key, value) {
      pruneJobs(state.hlsJobs);
      const ret = rawJobSet(key, value);
      pruneJobs(state.hlsJobs);
      return ret;
    };

    // Full tab-scoped cleanup. Active downloads/media jobs may continue after
    // the page closes, so only terminal jobs are removed here.
    if (chrome.tabs && chrome.tabs.onRemoved && typeof chrome.tabs.onRemoved.addListener === 'function') {
      chrome.tabs.onRemoved.addListener(function (tabId) {
        state.pageMeta.delete(tabId);
        mediaChains.delete(tabId);
        state.hlsJobs.forEach(function (job, key) {
          if (job && job.tabId === tabId && isTerminalStatus(job.status)) state.hlsJobs.delete(key);
        });
        pruneQueue(state.queue);
        pruneJobs(state.hlsJobs);
        pruneCapturedHeaders(capturedReqHeaders, capturedTimes);
      });
    }

    // Best-effort periodic cleanup while the MV3 worker is alive. A worker
    // restart drops all of these in-memory structures entirely, which is also
    // a valid cleanup boundary.
    if (typeof setInterval === 'function') {
      setInterval(function () {
        pruneQueue(state.queue);
        pruneJobs(state.hlsJobs);
        pruneCapturedHeaders(capturedReqHeaders, capturedTimes);
      }, 60 * 1000);
    }

    globalThis.MediaSniperLifecycle = {
      pruneNow: function () {
        pruneQueue(state.queue);
        pruneJobs(state.hlsJobs);
        pruneCapturedHeaders(capturedReqHeaders, capturedTimes);
      },
      capturedTimes: capturedTimes,
    };
  }

  const api = {
    QUEUE_TERMINAL_MAX,
    QUEUE_TERMINAL_TTL_MS,
    JOB_TERMINAL_MAX,
    JOB_TERMINAL_TTL_MS,
    CAPTURED_HEADERS_TTL_MS,
    isTerminalStatus,
    pruneQueue,
    pruneJobs,
    pruneCapturedHeaders,
    isOwnedExtensionBlob,
  };

  globalThis.MediaSniperLifecyclePolicy = api;
  installRuntime();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
