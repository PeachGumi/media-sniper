/* Media Sniper - pure logic shared by background, content, bridge and popup.
 * No chrome.* APIs here. Works in Node (tests), service worker, page and popup.
 */
const MediaSniperLogic = (function () {
  'use strict';

  const EXT_KIND = {
    mp4: 'video', m4v: 'video', webm: 'video', mkv: 'video', avi: 'video',
    mov: 'video', flv: 'video', ogv: 'video',
    mp3: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio', opus: 'audio',
    wav: 'audio', flac: 'audio',
    m3u8: 'hls', mpd: 'dash',
    ts: 'ts', m4s: 'ts', fmp4: 'ts',
  };

  const DEFAULT_EXT = { video: 'mp4', audio: 'm4a', hls: 'ts', dash: 'mp4', ts: 'ts' };

  function extOf(url) {
    try {
      const u = new URL(url);
      const m = u.pathname.match(/\.([a-z0-9]{2,5})$/i);
      return m ? m[1].toLowerCase() : null;
    } catch (e) {
      return null;
    }
  }

  function classifyUrl(url) {
    if (!url || typeof url !== 'string') return { kind: null, ext: null };
    if (url.indexOf('blob:') === 0) return { kind: null, ext: null };
    const ext = extOf(url);
    return { kind: (ext && EXT_KIND[ext]) || null, ext: ext };
  }

  function kindFromContentType(ct, url) {
    if (ct) {
      const c = String(ct).toLowerCase().split(';')[0].trim();
      if (c.indexOf('text/html') === 0) return null;
      if (c.indexOf('video/') === 0) return c === 'video/mp2t' ? 'ts' : 'video';
      if (c.indexOf('audio/') === 0) return 'audio';
      if (c.indexOf('mpegurl') >= 0) return 'hls';
      if (c.indexOf('dash+xml') >= 0) return 'dash';
    }
    return classifyUrl(url).kind;
  }

  function sanitizeFilename(name, fallback) {
    let s = String(name == null ? '' : name);
    s = s.replace(/[\/\\:*?"<>|]/g, '_').trim();
    if (!s || /^[.\s_]+$/.test(s)) return fallback;
    if (s.length > 150) s = s.slice(0, 150);
    return s;
  }

  function hostOf(url) {
    try {
      let s = url;
      if (typeof s === 'string' && s.indexOf('blob:') === 0) s = s.slice(5);
      const u = new URL(s);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.hostname;
    } catch (e) { /* ignore */ }
    return null;
  }

  function lastPathSeg(url) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      return parts.length ? parts[parts.length - 1] : '';
    } catch (e) {
      return '';
    }
  }

  function filenameForItem(item) {
    // flat filename, saved directly into the user's Downloads folder
    const ext = item.ext || DEFAULT_EXT[item.kind] || 'bin';
    let base = '';
    if (item.title) base = sanitizeFilename(item.title, '');
    if (!base && item.url && item.url.indexOf('blob:') === 0) {
      const blobId = lastPathSeg(item.url);
      base = sanitizeFilename((item.kind || 'media') + '_' + blobId, '');
    }
    if (!base) {
      const srcUrl = hostOf(item.url) ? item.url : item.pageUrl;
      let seg = lastPathSeg(srcUrl || '');
      try { seg = decodeURIComponent(seg); } catch (e) { /* keep raw */ }
      seg = seg.replace(/\.[a-z0-9]{2,5}$/i, '');
      base = sanitizeFilename(seg, '');
    }
    if (!base) base = 'media-sniper_' + (item.kind || 'media');
    return sanitizeFilename(base, 'clip') + '.' + ext;
  }

  function itemKey(url) {
    if (!url) return '';
    if (url.indexOf('blob:') === 0) return url;
    try {
      const u = new URL(url);
      // YouTube videoplayback URLs differ only in query params; keep `itag`
      // so multiple formats of the same video stay separate items.
      const itag = u.searchParams.get('itag');
      u.search = '';
      u.hash = '';
      return itag ? u.href + '#itag=' + itag : u.href;
    } catch (e) {
      return url;
    }
  }

  function richness(item) {
    let score = (item.size && item.size > 0 ? item.size : 0);
    if (item.title) score += 1000;
    if (item.contentType) score += 100;
    return score;
  }

  function mergeItems(incoming, existing) {
    const map = new Map();
    for (const it of existing || []) map.set(it.key, it);
    for (const it of incoming || []) {
      const prev = map.get(it.key);
      if (!prev || richness(it) > richness(prev)) map.set(it.key, it);
    }
    return Array.from(map.values());
  }

  function formatBytes(n) {
    if (n == null || isNaN(n)) return '';
    if (n === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(1) + ' ' + units[i];
  }

  const KIND_ORDER = { video: 0, hls: 1, dash: 2, audio: 3, ts: 4 };

  function sortItems(items) {
    return items.slice().sort(function (a, b) {
      const ka = (a.kind in KIND_ORDER) ? KIND_ORDER[a.kind] : 5;
      const kb = (b.kind in KIND_ORDER) ? KIND_ORDER[b.kind] : 5;
      if (ka !== kb) return ka - kb;
      return (b.size || 0) - (a.size || 0);
    });
  }

  function ytDlpCommand(url) {
    return 'yt-dlp -o "~/Downloads/%(title)s.%(ext)s" "' + url + '"';
  }

  function resolveUrl(base, ref) {
    try { return new URL(ref, base).href; } catch (e) { return ref; }
  }

  function parseAttrs(line) {
    const attrs = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      attrs[m[1]] = m[2].replace(/^"|"$/g, '');
    }
    return attrs;
  }

  function parseM3u8(text, baseUrl) {
    const out = { type: null, variants: [], segments: [], encrypted: false, live: false, initUrl: null };
    const lines = String(text).split(/\r?\n/);
    const parentToken = (function () {
      try { const s = new URL(baseUrl).search; return s ? s.slice(1) : ''; } catch (e) { return ''; }
    })();
    let pending = null;
    let sawEndList = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
        pending = parseAttrs(line.slice('#EXT-X-STREAM-INF:'.length));
        out.type = out.type || 'master';
      } else if (line.indexOf('#EXT-X-KEY:') === 0) {
        const attrs = parseAttrs(line.slice('#EXT-X-KEY:'.length));
        if (attrs.METHOD && attrs.METHOD !== 'NONE') out.encrypted = true;
      } else if (line.indexOf('#EXT-X-MAP:') === 0) {
        const attrs = parseAttrs(line.slice('#EXT-X-MAP:'.length));
        if (attrs.URI) out.initUrl = resolveUrl(baseUrl, attrs.URI);
      } else if (line.indexOf('#EXT-X-ENDLIST') === 0) {
        sawEndList = true;
      } else if (line.indexOf('#EXTINF:') === 0) {
        pending = { duration: parseFloat(line.slice('#EXTINF:'.length)) || 0 };
        out.type = out.type || 'media';
      } else if (line[0] !== '#') {
        const url = resolveUrl(baseUrl, line);
        if (pending && pending.duration != null && out.type === 'media') {
          out.segments.push({ url: url, duration: pending.duration });
          pending = null;
        } else if (pending && out.type === 'master') {
          out.variants.push({
            url: url,
            bandwidth: parseInt(pending.BANDWIDTH, 10) || 0,
            resolution: pending.RESOLUTION || null,
            codecs: pending.CODECS || null,
            token: parentToken,
          });
          pending = null;
        } else if (out.type === 'media') {
          out.segments.push({ url: url, duration: 0 });
        }
      }
    }
    if (out.type === 'media' && !sawEndList) out.live = true;
    if (!out.type && out.segments.length) out.type = 'media';
    return out;
  }

  function pickBestVariant(variants) {
    let best = null;
    for (const v of variants || []) {
      if (!best || (v.bandwidth || 0) > (best.bandwidth || 0)) best = v;
    }
    return best;
  }

  // ---- VDH-inspired additions ------------------------------------------------

  // MIME -> extension fallback table (modeled on VDH's content-type mapping)
  const MIME_EXT = [
    [/wave?/i, 'wav'], [/3gpp2?/i, '3gp'], [/flac/i, 'flac'], [/flv/i, 'flv'],
    [/m4a/i, 'm4a'], [/m4v/i, 'm4v'], [/matroska/i, 'mkv'], [/mov/i, 'mov'],
    [/mp2t/i, 'ts'], [/mp4/i, 'mp4'], [/mpeg/i, 'mpg'], [/webm/i, 'webm'],
    [/ogg/i, 'ogg'], [/opus/i, 'opus'], [/aac/i, 'aac'], [/mp3/i, 'mp3'],
  ];

  function extFromContentType(ct, url) {
    if (!ct) return null;
    const c = String(ct).toLowerCase().split(';')[0].trim();
    if (c.indexOf('text/html') === 0 || c.indexOf('application/json') === 0) return null;
    for (const [re, ext] of MIME_EXT) {
      if (re.test(c)) return ext;
    }
    if (c === 'application/octet-stream' || !c) return null;
    return null;
  }

  function isSegmentUrl(url) {
    try {
      const u = new URL(url);
      return /\.ts$|\.m4s$|\.m2ts$/i.test(u.pathname);
    } catch (e) {
      return /\.ts$|\.m4s$|\.m2ts$/i.test(String(url).split(/[?#]/)[0]);
    }
  }

  function isSubtitlePlaylist(text) {
    const lines = String(text).split(/\r?\n/);
    let uris = 0;
    let subs = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line[0] === '#') continue;
      uris++;
      const path = line.split(/[?#]/)[0];
      const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
      if (/^(vtt|srt|webvtt|ttml)$/.test(ext)) subs++;
    }
    return uris > 0 && subs === uris;
  }

  function looksLikeHlsUrl(url) {
    if (!url) return false;
    try {
      const u = new URL(url);
      if (/\.m3u8$/i.test(u.pathname)) return true;
      if (/\/hls\//i.test(u.pathname) || /\/hls\b/i.test(u.pathname)) return true;
      if (/\/api\/playlist\/master\//i.test(u.pathname)) return true;
      return false;
    } catch (e) {
      return false;
    }
  }

  function smartName(meta) {
    const t = meta && meta.title ? String(meta.title).trim() : '';
    if (t) return { title: t };
    const url = meta && meta.url;
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length) {
        let last = decodeURIComponent(parts[parts.length - 1]);
        last = last.replace(/\.[a-z0-9]{2,5}$/i, '');
        if (last) return { title: last };
      }
    } catch (e) { /* ignore */ }
    return { title: '' };
  }

  function playlistDuration(text) {
    const lines = String(text).split(/\r?\n/);
    let total = 0;
    for (const line of lines) {
      const m = line.match(/^#EXTINF:([\d.]+)/);
      if (m) total += parseFloat(m[1]) || 0;
    }
    return Math.round(total * 10) / 10;
  }

  // ---- VDH-style site handling -----------------------------------------------
  // Sites that have dedicated extraction adapters. The generic webRequest
  // detector skips them entirely — on these sites the generic heuristics only
  // produce noise (e.g. YouTube's signature-protected DASH chunks with no
  // file extension). Mirrors VDH's yS exclusion set; a site may only be added
  // here once its adapter exists (VDH excludes instagram/vimeo/etc. because
  // it ships adapters for them — we don't yet, so we must not exclude them).
  const DEDICATED_SITES = ['youtube.com'];

  function isDedicatedSite(url) {
    const host = hostOf(url);
    if (!host) return false;
    const h = String(host).toLowerCase();
    for (const s of DEDICATED_SITES) {
      if (h === s || h.slice(-(s.length + 1)) === '.' + s) return true;
    }
    return false;
  }

  // VDH ignores direct-media responses whose known size is under 500KB
  // (ads, thumbnails, tracking pixels). Same threshold here.
  const MIN_DIRECT_MEDIA_SIZE = 500000;

  return {
    EXT_KIND: EXT_KIND,
    DEFAULT_EXT: DEFAULT_EXT,
    classifyUrl: classifyUrl,
    kindFromContentType: kindFromContentType,
    sanitizeFilename: sanitizeFilename,
    filenameForItem: filenameForItem,
    itemKey: itemKey,
    mergeItems: mergeItems,
    formatBytes: formatBytes,
    sortItems: sortItems,
    ytDlpCommand: ytDlpCommand,
    parseM3u8: parseM3u8,
    pickBestVariant: pickBestVariant,
    hostOf: hostOf,
    extFromContentType: extFromContentType,
    isSegmentUrl: isSegmentUrl,
    isSubtitlePlaylist: isSubtitlePlaylist,
    looksLikeHlsUrl: looksLikeHlsUrl,
    smartName: smartName,
    playlistDuration: playlistDuration,
    isDedicatedSite: isDedicatedSite,
    MIN_DIRECT_MEDIA_SIZE: MIN_DIRECT_MEDIA_SIZE,
  };
})();

if (typeof globalThis !== 'undefined') globalThis.MediaSniperLogic = MediaSniperLogic;
if (typeof module !== 'undefined' && module.exports) module.exports = MediaSniperLogic;
