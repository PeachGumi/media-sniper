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

  const DEFAULT_EXT = { video: 'mp4', audio: 'm4a', hls: 'ts', 'hls-audio': 'aac', dash: 'mp4', ts: 'ts' };

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
      // Playlists: the query string often carries the auth token and
      // distinguishes variants, so keep the full URL as the key.
      if (/\.(m3u8|mpd)$/i.test(u.pathname)) return url;
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
    // .aac = ADTS HLS chunks (X Spaces replays: chunk_..._a.aac)
    try {
      const u = new URL(url);
      return /\.(ts|m4s|m2ts|aac)$/i.test(u.pathname);
    } catch (e) {
      return /\.(ts|m4s|m2ts|aac)$/i.test(String(url).split(/[?#]/)[0]);
    }
  }

  // audio-only HLS (e.g. X Spaces): every segment is an ADTS .aac chunk and
  // there is no fMP4 init segment. Concatenating ADTS chunks is a playable
  // .aac file, so the output gets an .aac extension, not .ts.
  function isAudioOnlyPlaylist(parsed) {
    if (!parsed || parsed.type !== 'media' || parsed.initUrl) return false;
    if (!parsed.segments.length) return false;
    for (const s of parsed.segments) {
      const p = String(s.url).split(/[?#]/)[0];
      if (!/\.aac$/i.test(p)) return false;
    }
    return true;
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

  // DASH: full manifest resolution. ffmpeg's dash demuxer over jsfetch is
  // NOT usable in the browser with this libav build — it deadlocks the
  // moment the demuxer opens a 2nd segment through jsfetch (verified with
  // trace logs: 1-segment manifests work, 2+ segments freeze the event
  // loop; -map does not help because the demuxer fetches every
  // representation anyway). So we resolve segment URLs ourselves and fetch
  // them with plain fetch(), exactly like the HLS concat path.
  //
  // Entry numbering matches ffmpeg's dash demuxer: one entry per
  // <Representation> in document order (verified against libav 6.5.7).
  // Subtitle/text representations consume entry numbers but are not listed.
  function xmlAttr(tag, name) {
    const m = String(tag).match(new RegExp('\\b' + name + '\\s*=\\s*["\']([^"\']*)["\']'));
    return m ? m[1] : null;
  }

  // ISO 8601 duration (PT1H2M3.5S) -> seconds; 0 when unparseable
  function parseIsoDuration(s) {
    const m = String(s || '').match(/PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?/);
    if (!m || (!m[1] && !m[2] && !m[3])) return 0;
    return (parseFloat(m[1] || 0) * 3600) + (parseFloat(m[2] || 0) * 60) + parseFloat(m[3] || 0);
  }

  function dashPad(n, width) {
    let s = String(n);
    while (s.length < width) s = '0' + s;
    return s;
  }

  // $...$ template substitution (RepresentationID / Bandwidth / Number / Time)
  function dashFill(tmpl, ctx) {
    return String(tmpl)
      .replace(/\$\$/g, '\u0000')
      .replace(/\$RepresentationID\$/g, ctx.repId != null ? String(ctx.repId) : '')
      .replace(/\$Bandwidth\$/g, String(ctx.bandwidth || 0))
      .replace(/\$Number%0(\d+)d\$/g, function (_, w) { return dashPad(ctx.num, parseInt(w, 10)); })
      .replace(/\$Number\$/g, String(ctx.num))
      .replace(/\$Time%0(\d+)d\$/g, function (_, w) { return dashPad(ctx.time, parseInt(w, 10)); })
      .replace(/\$Time\$/g, String(ctx.time))
      .replace(/\u0000/g, '$');
  }

  // Resolve the BaseURL that applies to a Representation: nearest of
  // rep-level, AdaptationSet-level, or the first one anywhere in the doc
  // (MPD/Period level), all resolved against the manifest URL.
  function dashBase(repBody, asBody, fullText, mpdUrl) {
    let m = /<BaseURL[^>]*>([\s\S]*?)<\/BaseURL>/i.exec(repBody || '');
    if (!m) m = /<BaseURL[^>]*>([\s\S]*?)<\/BaseURL>/i.exec(asBody || '');
    if (!m) m = /<BaseURL[^>]*>([\s\S]*?)<\/BaseURL>/i.exec(fullText || '');
    const base = m ? m[1].trim() : null;
    try { return new URL(base || '', mpdUrl || 'http://invalid/').href; } catch (e) { return mpdUrl || ''; }
  }

  function dashResolve(u, base) {
    try { return new URL(u, base).href; } catch (e) { return u; }
  }

  const DASH_MAX_SEGMENTS = 20000;

  // Parse an MPD into downloadable tracks. Returns
  // { tracks: [ { entry, type, bandwidth, resolution, initUrl, segments: [url,...] } ] }
  // Supports SegmentTemplate with SegmentTimeline ($Number$/$Time$) and
  // duration-based SegmentTemplate. SegmentBase falls back to fetching the
  // whole source file as one segment (works when no byte ranges are used).
  function parseMpdSegments(mpdText, mpdUrl) {
    const out = { tracks: [] };
    if (!mpdText || typeof mpdText !== 'string' || mpdText.indexOf('<') < 0) return out;
    const text = mpdText.replace(/<!--[\s\S]*?-->/g, '');
    const mpdAttrs = (/<MPD\b([^>]*)>/i.exec(text) || ['', ''])[1];
    const totalDur = parseIsoDuration(xmlAttr(mpdAttrs, 'mediaPresentationDuration'));
    let entry = 0;
    const asRe = /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi;
    let m;
    while ((m = asRe.exec(text)) !== null) {
      const asAttrs = m[1];
      const asBody = m[2];
      const repRe = /<Representation\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Representation>)/gi;
      let best = null;
      let rm;
      while ((rm = repRe.exec(asBody)) !== null) {
        const attrs = rm[1];
        const body = rm[2] || '';
        const rep = {
          entry: entry++,
          id: xmlAttr(attrs, 'id'),
          bandwidth: parseInt(xmlAttr(attrs, 'bandwidth'), 10) || 0,
          mimeType: xmlAttr(attrs, 'mimeType') || '',
          codecs: xmlAttr(attrs, 'codecs') || '',
          width: parseInt(xmlAttr(attrs, 'width'), 10) || 0,
          height: parseInt(xmlAttr(attrs, 'height'), 10) || 0,
          body: body,
        };
        if (!best || rep.bandwidth > best.bandwidth) best = rep;
      }
      if (!best) continue;
      let type = String(xmlAttr(asAttrs, 'contentType') || '').toLowerCase();
      if (!type) {
        if (/^video\//i.test(best.mimeType)) type = 'video';
        else if (/^audio\//i.test(best.mimeType)) type = 'audio';
        else if (/^(text|application)\//i.test(best.mimeType)) type = 'subtitle';
        else if (/^(avc|hev|hvc|vp[89]|av0)/i.test(best.codecs)) type = 'video';
        else if (/^(mp4a|ac-[34]|ec-3|opus|flac)/i.test(best.codecs)) type = 'audio';
      }
      if (type !== 'video' && type !== 'audio') continue;

      const base = dashBase(best.body, asBody, text, mpdUrl);
      const tpl = /<SegmentTemplate\b([^>]*?)(?:\/>|>([\s\S]*?)<\/SegmentTemplate>)/i.exec(best.body);
      let initUrl = null;
      const segments = [];

      if (tpl) {
        const tplAttrs = tpl[1];
        const tplBody = tpl[2] || '';
        const timescale = parseInt(xmlAttr(tplAttrs, 'timescale'), 10) || 1;
        const startNumber = parseInt(xmlAttr(tplAttrs, 'startNumber'), 10) || 1;
        const initTmpl = xmlAttr(tplAttrs, 'initialization') || xmlAttr(tplAttrs, 'initialisation');
        const mediaTmpl = xmlAttr(tplAttrs, 'media') || '';
        if (initTmpl) {
          initUrl = dashResolve(dashFill(initTmpl, { repId: best.id, bandwidth: best.bandwidth, num: 0, time: 0 }), base);
        }
        const timeline = /<SegmentTimeline\b[^>]*>([\s\S]*?)<\/SegmentTimeline>/i.exec(tplBody);
        if (timeline) {
          const sRe = /<S\b([^>]*?)\/?>/gi;
          let sm;
          const events = []; // { t, d, r }
          while ((sm = sRe.exec(timeline[1])) !== null) {
            const sa = sm[1];
            events.push({
              t: xmlAttr(sa, 't') != null ? parseInt(xmlAttr(sa, 't'), 10) : null,
              d: parseInt(xmlAttr(sa, 'd'), 10) || 0,
              r: xmlAttr(sa, 'r') != null ? parseInt(xmlAttr(sa, 'r'), 10) : 0,
            });
          }
          let curT = 0;
          let num = startNumber;
          for (let i = 0; i < events.length && segments.length < DASH_MAX_SEGMENTS; i++) {
            const ev = events[i];
            if (ev.t != null) curT = ev.t;
            let reps = ev.r;
            if (reps < 0) {
              // repeat until the next S@t (or the end of the presentation)
              const nextT = (i + 1 < events.length && events[i + 1].t != null) ? events[i + 1].t
                : (totalDur > 0 ? Math.round(totalDur * timescale) : curT + ev.d);
              reps = ev.d > 0 ? Math.max(0, Math.ceil((nextT - curT) / ev.d)) - 1 : 0;
            }
            for (let k = 0; k <= reps && segments.length < DASH_MAX_SEGMENTS; k++) {
              segments.push(dashResolve(dashFill(mediaTmpl, { repId: best.id, bandwidth: best.bandwidth, num: num, time: curT }), base));
              num++;
              curT += ev.d;
            }
          }
        } else {
          // duration-based template
          const segDur = parseInt(xmlAttr(tplAttrs, 'duration'), 10) || 0;
          if (segDur > 0 && totalDur > 0) {
            const count = Math.min(DASH_MAX_SEGMENTS, Math.ceil((totalDur * timescale) / segDur));
            for (let i = 0; i < count; i++) {
              segments.push(dashResolve(dashFill(mediaTmpl, { repId: best.id, bandwidth: best.bandwidth, num: startNumber + i, time: i * segDur }), base));
            }
          }
        }
      } else {
        // SegmentBase / plain: one segment = the whole resolved source
        const sb = /<SegmentBase\b([^>]*?)(?:\/>|>)/i.exec(best.body);
        const src = (sb && xmlAttr(sb[1], 'sourceURL')) || null;
        segments.push(dashResolve(src || '', base));
      }

      out.tracks.push({
        entry: best.entry,
        type: type,
        bandwidth: best.bandwidth,
        resolution: best.width && best.height ? best.width + 'x' + best.height : null,
        initUrl: initUrl,
        segments: segments,
      });
    }
    return out;
  }

  // Detection-side view: same tracks, no segment lists. Kept separate from
  // parseMpdSegments so detection never pays for URL resolution.
  function parseMpdTracks(mpdText) {
    return parseMpdSegments(mpdText, null).tracks.map(function (t) {
      return { entry: t.entry, type: t.type, bandwidth: t.bandwidth, resolution: t.resolution };
    });
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
    isAudioOnlyPlaylist: isAudioOnlyPlaylist,
    isSubtitlePlaylist: isSubtitlePlaylist,
    looksLikeHlsUrl: looksLikeHlsUrl,
    smartName: smartName,
    playlistDuration: playlistDuration,
    isDedicatedSite: isDedicatedSite,
    parseMpdTracks: parseMpdTracks,
    parseMpdSegments: parseMpdSegments,
    MIN_DIRECT_MEDIA_SIZE: MIN_DIRECT_MEDIA_SIZE,
  };
})();

if (typeof globalThis !== 'undefined') globalThis.MediaSniperLogic = MediaSniperLogic;
if (typeof module !== 'undefined' && module.exports) module.exports = MediaSniperLogic;
