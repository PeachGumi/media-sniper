'use strict';
/* Media Sniper - YouTube adapter (MAIN world, youtube.com only).
 *
 * Mirrors VDH's dedicated-adapter approach: instead of sniffing YouTube's
 * signature-protected media chunks (which have no file extension and produce
 * only noise), it reads the player response's streamingData directly and
 * reports the downloadable formats.
 *
 * Emits: { source: 'media-sniper-yt', type: 'yt-formats', videoId, items:[...] }
 */
(function () {
  'use strict';
  var host = '';
  try { host = location.hostname; } catch (e) { /* ignore */ }
  if (!/^(www\.|m\.|music\.)?youtube\.com$/.test(host)) return;
  if (window.__mediaSniperYtInstalled) return;
  window.__mediaSniperYtInstalled = true;

  var MARKER = 'media-sniper-yt';
  // videoId -> fingerprint of the last emitted URLs. Player responses can be
  // repeated verbatim, but signed googlevideo URLs can also refresh while the
  // same video remains open. Deduplicate only identical URL sets, never the
  // videoId itself.
  var seen = {};
  var buffered = [];   // last report, kept until the content script picks it up
  var bufferedId = null;

  function postReport(items, videoId) {
    try {
      window.postMessage({ source: MARKER, type: 'yt-formats', videoId: videoId, items: items }, '*');
    } catch (e) { /* ignore */ }
  }

  function extOfMime(mime) {
    var m = String(mime || '');
    if (m.indexOf('webm') >= 0) return 'webm';
    if (m.indexOf('audio/mp4') >= 0) return 'm4a';
    if (m.indexOf('mp4') >= 0) return 'mp4';
    if (m.indexOf('3gpp') >= 0) return '3gp';
    return null;
  }

  function bitrateOf(f) {
    return parseInt(f && f.bitrate, 10) || 0;
  }

  function report(pr) {
    try {
      var sd = pr && pr.streamingData;
      var vd = pr && pr.videoDetails;
      if (!sd || !vd) return;
      var videoId = vd.videoId;
      if (!videoId) return;
      var title = vd.title || videoId;
      var duration = parseFloat(vd.lengthSeconds) || 0;
      var pageUrl = location.href;
      var items = [];

      // progressive formats: audio+video in one file, directly downloadable
      (sd.formats || []).forEach(function (f) {
        if (!f || !f.url || String(f.url).indexOf('http') !== 0) return;
        items.push({
          url: f.url, kind: 'video', contentType: f.mimeType || null,
          size: parseInt(f.contentLength, 10) || 0,
          ext: extOfMime(f.mimeType),
          title: title + ' [' + (f.qualityLabel || f.quality || '?') + ']',
          via: 'youtube', pageUrl: pageUrl, duration: duration,
          ytVideoId: videoId,
        });
      });

      // Keep two audio choices. The best audio-only item may be Opus/WebM,
      // while the MP4 mux path specifically needs an audio/mp4 (m4a) track.
      // Choosing one global "best audio" first lets a higher-bitrate Opus
      // track accidentally hide a perfectly valid m4a mux track.
      var bestAudio = null;
      var bestMuxAudio = null;
      (sd.adaptiveFormats || []).forEach(function (f) {
        if (!f || !f.url || String(f.url).indexOf('http') !== 0 || !/^audio\//.test(f.mimeType || '')) return;
        if (!bestAudio || bitrateOf(f) > bitrateOf(bestAudio)) bestAudio = f;
        if (String(f.mimeType || '').indexOf('audio/mp4') === 0 &&
            (!bestMuxAudio || bitrateOf(f) > bitrateOf(bestMuxAudio))) {
          bestMuxAudio = f;
        }
      });

      // best VIDEO-ONLY adaptive mp4 + mp4 audio -> mux item (1080p+).
      // mp4-only on purpose: the offscreen muxer writes an mp4 container, and
      // webm video / opus audio in mp4 does not play anywhere.
      var bestVideoOnly = null;
      (sd.adaptiveFormats || []).forEach(function (f) {
        if (!f || !f.url || String(f.url).indexOf('http') !== 0) return;
        if (String(f.mimeType || '').indexOf('video/mp4') !== 0) return;
        if (!bestVideoOnly || bitrateOf(f) > bitrateOf(bestVideoOnly)) bestVideoOnly = f;
      });
      if (bestVideoOnly && bestMuxAudio && bestMuxAudio.url !== bestVideoOnly.url) {
        items.push({
          url: bestVideoOnly.url, kind: 'video', contentType: bestVideoOnly.mimeType || null,
          size: (parseInt(bestVideoOnly.contentLength, 10) || 0) + (parseInt(bestMuxAudio.contentLength, 10) || 0),
          ext: 'mp4',
          title: title + ' [' + (bestVideoOnly.qualityLabel || bestVideoOnly.quality || '?') + ']+音声',
          via: 'youtube', pageUrl: pageUrl, duration: duration,
          ytVideoId: videoId,
          audioUrl: bestMuxAudio.url,
        });
      }

      if (bestAudio) {
        items.push({
          url: bestAudio.url, kind: 'audio', contentType: bestAudio.mimeType || null,
          size: parseInt(bestAudio.contentLength, 10) || 0,
          ext: extOfMime(bestAudio.mimeType),
          title: title + ' [音声のみ]',
          via: 'youtube', pageUrl: pageUrl, duration: duration,
          ytVideoId: videoId,
        });
      }

      if (!items.length) return;
      var fingerprint = items.map(function (item) {
        return String(item.url || '') + '\n' + String(item.audioUrl || '');
      }).join('\n--\n');
      if (seen[videoId] === fingerprint) return;
      seen[videoId] = fingerprint;
      buffered = items;
      bufferedId = videoId;
      postReport(items, videoId);
    } catch (e) { /* never break the page */ }
  }

  // ---- 1) initial page load: capture ytInitialPlayerResponse assignment ----
  var _pr = window.ytInitialPlayerResponse;
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get: function () { return _pr; },
      set: function (v) { _pr = v; try { report(v); } catch (e) { /* ignore */ } },
    });
  } catch (e) { /* ignore */ }
  if (_pr) report(_pr);

  // ---- 2) SPA navigation: player responses arrive via /youtubei/v1/player --
  function looksLikePlayerUrl(u) {
    return typeof u === 'string' && u.indexOf('/youtubei/v1/player') >= 0;
  }

  function tryParse(text) {
    try {
      var o = JSON.parse(text);
      if (o && o.streamingData) report(o);
    } catch (e) { /* not a player response */ }
  }

  var nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      var url = '';
      try {
        if (typeof input === 'string') url = input;
        else if (input instanceof Request) url = input.url;
        else if (input && input.url) url = input.url;
      } catch (e) { /* ignore */ }
      var p = nativeFetch.apply(this, arguments);
      if (looksLikePlayerUrl(url)) {
        // observe on a side-chain handling both outcomes (no unhandled rejects)
        Promise.resolve(p).then(function (res) {
          try { res.clone().text().then(tryParse, function () {}); } catch (e) { /* ignore */ }
        }, function () { /* request failed: nothing to observe */ });
      }
      return p;
    };
  }

  var XO = XMLHttpRequest.prototype.open;
  var XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__msYtPlayer = looksLikePlayerUrl(url); } catch (e) { /* ignore */ }
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    if (xhr.__msYtPlayer) {
      try {
        xhr.addEventListener('readystatechange', function () {
          if (xhr.readyState === 4) {
            try { tryParse(xhr.responseText); } catch (e) { /* responseType=json: no responseText */ }
          }
        });
      } catch (e) { /* ignore */ }
    }
    return XS.apply(this, arguments);
  };

  // ---- 3) content script handshake -----------------------------------------
  // The content script may not be listening yet when the first report is
  // posted (initial page load). It asks us to re-send via 'yt-request'.
  window.addEventListener('message', function (ev) {
    try {
      var d = ev && ev.data;
      if (d && d.source === 'media-sniper-content' && d.type === 'yt-request') {
        if (buffered.length) postReport(buffered, bufferedId);
      }
    } catch (e) { /* ignore */ }
  });
})();
