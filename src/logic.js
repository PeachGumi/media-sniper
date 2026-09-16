/* Media Sniper - pure logic shared by background, content, bridge and popup.
 * No chrome.* APIs here. Works in Node (tests), service worker, page and popup.
 *
 * Re-execution safe: this file can be injected into the same JS realm more
 * than once (persistent dynamic content script + popup executeScript overlap
 * on an already-granted tab). A top-level `const` here would throw
 * "Identifier 'MediaSniperLogic' has already been declared" on the second run,
 * so declare with var and reuse an existing copy instead of rebuilding.
 */
var MediaSniperLogic = globalThis.MediaSniperLogic || (function () {
  'use strict';

  const EXT_KIND = {
    mp4: 'video', m4v: 'video', webm: 'video', mkv: 'video', avi: 'video',
    mov: 'video', flv: 'video', ogv: 'video',
    mp3: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio', opus: 'audio',
    wav: 'audio', flac: 'audio',
    m3u8: 'hls', mpd: 'dash',
    ts: 'ts', m4s: 'ts', fmp4: 'ts',
  };

  const MAX_URL_LENGTH = 4096;

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

  function isSafeMediaUrl(url) {
    try {
      const raw = String(url || '');
      if (!raw || raw.length > MAX_URL_LENGTH) return false;
      const u = new URL(raw);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.href.length <= MAX_URL_LENGTH;
      if (u.protocol === 'blob:') {
        const inner = new URL(String(u.href).slice('blob:'.length));
        return (inner.protocol === 'http:' || inner.protocol === 'https:') && u.href.length <= MAX_URL_LENGTH;
      }
      return false;
    } catch (e) { return false; }
  }

  function isYouTubeMediaUrl(url) {
    try {
      const u = new URL(String(url || ''));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      const h = String(u.hostname || '').toLowerCase();
      return h === 'youtube.com' || h.endsWith('.youtube.com') ||
        h === 'googlevideo.com' || h.endsWith('.googlevideo.com');
    } catch (e) { return false; }
  }

  function isVimeoPlayerUrl(url) {
    try {
      const u = new URL(String(url || ''));
      const h = String(u.hostname || '').toLowerCase();
      if (h !== 'vimeo.com' && h !== 'www.vimeo.com' && h !== 'player.vimeo.com') return false;
      return !/\.(mp4|m4v|webm|mkv|mov|flv|ogv|mp3|m4a|aac|ogg|opus|wav|flac)(?:$|[?#])/i.test(u.pathname || '');
    } catch (e) { return false; }
  }

  function isConcreteMetadataUrl(url, contentType) {
    if (!isSafeMediaUrl(url)) return false;
    const kind = kindFromContentType(contentType || null, url);
    if (kind !== 'video' && kind !== 'audio') return false;
    if (isVimeoPlayerUrl(url)) return false;
    return true;
  }

  // A URL observed in the page's own resource timing: a media file or a
  // manifest (which the metadata rule above deliberately refuses, because a
  // metadata hint is not allowed to be a manifest).
  function isConcretePageDataUrl(url) {
    if (!isSafeMediaUrl(url)) return false;
    const raw = String(url || '');
    if (/\.(m3u8|mpd)(?:$|[?#])/i.test(raw)) return !isSegmentUrl(raw);
    const kind = kindFromContentType(null, raw);
    return (kind === 'video' || kind === 'audio') && !isSegmentUrl(raw);
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

  // Optional root folder inside ~/Downloads. Empty string = flat (legacy).
  function sanitizeRootFolder(root) {
    let s = String(root == null ? '' : root).trim();
    if (!s || /^[.\s_]+$/.test(s)) return '';
    if (/^(\/|\\|[a-zA-Z]:)/.test(s)) return ''; // absolute paths rejected
    if (/(^|[\\/])\.\.($|[\\/])/.test(s)) return ''; // '..' segment rejected
    s = s.replace(/[\\/:*?"<>|]/g, '_');
    s = s.replace(/\s+$/, '');
    if (s.length > 80) s = s.slice(0, 80);
    return s;
  }

  function isBlacklisted(host, listRaw) {
    const h = String(host || '').toLowerCase();
    const list = String(listRaw || '').toLowerCase();
    if (!h || !list.trim()) return false;
    const parts = list.split(/[\n,]/);
    for (let raw of parts) {
      let p = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
      if (!p) continue;
      if (p.indexOf('/') >= 0) p = p.slice(0, p.indexOf('/'));
      if (h === p || h.endsWith('.' + p)) return true;
    }
    return false;
  }

  function filenameForItem(item, rootFolder) {
    // flat filename, saved directly into the user's Downloads folder
    // (or <rootFolder>/name.ext when a root folder is configured)
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
    const root = sanitizeRootFolder(rootFolder);
    const name = sanitizeFilename(base, 'clip') + '.' + ext;
    return root ? root + '/' + name : name;
  }

  // Query parameters used to authorize a request are not part of a media
  // item's identity. Keep this list deliberately narrow: unknown parameters
  // may carry a rendition, language, or other quality selector and therefore
  // must remain in the stable key.
  const TRANSIENT_AUTH_PARAMS = new Set([
    'auth', 'authorization', 'expires', 'expire', 'expiry', 'e', 'et',
    'hdnea', 'hmac', 'hash', 'jwt', 'key', 'policy', 'session', 'sig',
    'signature', 'sp', 'st', 'se', 'token', 'tok', 'x-token', 'access_token',
    'x-amz-algorithm', 'x-amz-credential', 'x-amz-date', 'x-amz-expires',
    'x-amz-security-token', 'x-amz-signature',
  ]);

  function queryParamName(raw) {
    try { return decodeURIComponent(String(raw || '').replace(/\\+/g, ' ')).toLowerCase(); }
    catch (e) { return String(raw || '').toLowerCase(); }
  }

  function isTransientAuthParam(name) {
    const n = queryParamName(name);
    return TRANSIENT_AUTH_PARAMS.has(n) || /^x-amz-(?:algorithm|credential|date|expires|security-token|signature)$/i.test(n);
  }

  function stableUrl(url) {
    const u = new URL(url);
    const rawQuery = u.search ? u.search.slice(1) : '';
    const kept = rawQuery ? rawQuery.split('&').filter(function (part) {
      return !isTransientAuthParam(part.split('=', 1)[0]);
    }) : [];
    u.search = kept.length ? '?' + kept.join('&') : '';
    u.hash = '';
    return u.href;
  }

  function itemKey(url) {
    if (!url) return '';
    if (url.indexOf('blob:') === 0) return url;
    try {
      const u = new URL(url);
      // Chunked media CDNs (googlevideo et al.): range requests for ONE track
      // differ in transient params, while DIFFERENT tracks or videos share the
      // same pathname. Key on path + itag (format) + id (video) so chunks of
      // one track dedupe without colliding across videos or formats.
      const itag = u.searchParams.get('itag');
      const gid = u.searchParams.get('id');
      if (itag != null || gid != null) {
        u.search = '';
        u.hash = '';
        let k = u.href;
        if (itag != null) k += '#itag=' + itag;
        if (gid != null) k += '#gid=' + gid;
        return k;
      }
      return stableUrl(url);
    } catch (e) {
      return url;
    }
  }

  function richness(item) {
    let score = (item.size && item.size > 0 ? item.size : 0);
    if (item.title) score += 1000;
    if (item.contentType) score += 100;
    if (item.variants && item.variants.length) score += item.variants.length * 100;
    return score;
  }

  function mergeItems(incoming, existing) {
    const map = new Map();
    for (const it of existing || []) map.set(it.key, it);
    for (const it of incoming || []) {
      const prev = map.get(it.key);
      if (!prev) {
        map.set(it.key, it);
        continue;
      }

      // Signed media URLs rotate while the logical item key stays stable.
      // Merge the new identity/metadata into the old item, but do not let a
      // sparse refresh erase title, type, size, or other richer fields.
      const merged = Object.assign({}, prev, it);
      const retainedFields = ['title', 'contentType', 'size', 'duration', 'via', 'pageUrl', 'ext', 'audioUrl', 'dashType'];
      for (const field of retainedFields) {
        const next = it[field];
        const old = prev[field];
        const nextHasValue = next !== null && next !== undefined && next !== '' && !(typeof next === 'number' && next === 0);
        const oldHasValue = old !== null && old !== undefined && old !== '' && !(typeof old === 'number' && old === 0);
        if (!nextHasValue && oldHasValue) merged[field] = old;
      }
      // A refreshed response can carry a smaller/unknown size while the
      // previously observed size remains the more useful metadata.
      if (Number(prev.size) > Number(it.size || 0)) merged.size = prev.size;
      if (Number(prev.duration) > Number(it.duration || 0)) merged.duration = prev.duration;
      if (it.kind === 'hls' && (prev.variants || it.variants)) {
        const variants = mergeHlsVariants(prev.variants, it.variants);
        merged.variants = variants;
        const previousSelection = selectHlsVariant({ variants: variants }, prev.selectedVariantKey);
        const incomingSelection = selectHlsVariant({ variants: variants }, it.selectedVariantKey);
        const selected = previousSelection || incomingSelection || pickBestVariant(variants);
        merged.selectedVariantKey = selected ? hlsVariantKey(selected) : null;
      }
      // The URL itself is the refresh signal and must always come from the
      // newest report, even when that report is otherwise sparse.
      merged.url = it.url;
      map.set(it.key, merged);
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

  const MAX_HLS_PLAYLIST_CHARS = 2 * 1024 * 1024;
  const MAX_HLS_VARIANTS = 128;
  const MAX_HLS_MEDIA = 128;
  const MAX_HLS_SEGMENTS = 20000;
  const MAX_HLS_KEYS = 128;

  function parseM3u8(text, baseUrl) {
    const out = {
      type: null, variants: [], segments: [], encrypted: false, live: false,
      initUrl: null, media: [], keyUrls: [], truncated: false,
    };
    if (typeof text !== 'string') return out;
    if (text.length > MAX_HLS_PLAYLIST_CHARS) {
      out.truncated = true;
      return out;
    }
    const lines = text.split(/\r?\n/);
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
        if (attrs.URI && out.keyUrls.length < MAX_HLS_KEYS) {
          out.keyUrls.push(resolveUrl(baseUrl, attrs.URI));
        } else if (attrs.URI) {
          out.truncated = true;
        }
      } else if (line.indexOf('#EXT-X-MEDIA:') === 0) {
        // alternate renditions (separate audio playlists, VDH "two sources")
        const attrs = parseAttrs(line.slice('#EXT-X-MEDIA:'.length));
        if (out.media.length >= MAX_HLS_MEDIA) {
          out.truncated = true;
          continue;
        }
        out.media.push({
          type: String(attrs.TYPE || '').toUpperCase(),
          groupId: attrs['GROUP-ID'] || null,
          name: attrs.NAME || null,
          language: attrs.LANGUAGE || null,
          uri: attrs.URI ? resolveUrl(baseUrl, attrs.URI) : null,
          isDefault: /^(YES|TRUE)$/i.test(attrs.DEFAULT || ''),
        });
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
          if (out.segments.length >= MAX_HLS_SEGMENTS) {
            out.truncated = true;
          } else {
            out.segments.push({ url: url, duration: pending.duration });
          }
          pending = null;
        } else if (pending && out.type === 'master') {
          if (out.variants.length >= MAX_HLS_VARIANTS) {
            out.truncated = true;
          } else {
            out.variants.push({
              url: url,
              bandwidth: parseInt(pending.BANDWIDTH, 10) || 0,
              resolution: pending.RESOLUTION || null,
              codecs: pending.CODECS || null,
              audioGroup: pending.AUDIO || null,
              token: parentToken,
            });
          }
          pending = null;
        } else if (out.type === 'media') {
          if (out.segments.length >= MAX_HLS_SEGMENTS) {
            out.truncated = true;
          } else {
            out.segments.push({ url: url, duration: 0 });
          }
        }
      }
    }
    if (out.type === 'media' && !sawEndList) out.live = true;
    if (!out.type && out.segments.length) out.type = 'media';
    return out;
  }

  function withPlaylistToken(url, token) {
    if (!token) return url;
    try {
      const u = new URL(url);
      if (!u.search) return url + '?' + token;
    } catch (e) { /* keep the resolved URL */ }
    return url;
  }

  // Rewrite every URI inside a media playlist to an absolute `jsfetch:` URL.
  //
  // ffmpeg's HLS demuxer resolves the URIs it finds against the *input* URL. When
  // that input is `jsfetch:https://host/path/list.m3u8`, ffmpeg's URL splitter
  // sees the protocol as `jsfetch` and the rest as a plain path, so a
  // root-relative URI ("/media/seg1.ts", which X's manifests use) is rebuilt as
  // `jsfetch:/media/seg1.ts`: the host is gone, every nested fetch fails, the
  // demuxer reports "Output file does not contain any stream" and the job ends
  // as a bare `ffmpeg failed (rc=-1)`. Relative URIs happen to survive because
  // the tail of the base is kept, which is why this stayed hidden.
  //
  // Resolving the URIs ourselves removes the ambiguity: ffmpeg then opens
  // exactly the URLs we resolved, with the browser session attached by the
  // jsfetch protocol, and the AES-128 key URI keeps working (the HLS demuxer
  // prefixes `crypto+` unless the URI already carries `crypto+` or `data:`).
  const URI_ATTR_TAGS = /^#EXT-X-(KEY|MAP|MEDIA|I-FRAME-STREAM-INF|PART|PRELOAD-HINT|RENDITION-REPORT)/;
  const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

  function absoluteJsFetchUri(rawUri, baseUrl, scheme) {
    const uri = String(rawUri || '').trim();
    if (!uri) return rawUri;
    const jsfetch = scheme || 'jsfetch';
    // Absolute http(s) URIs still need the jsfetch prefix: this build has no
    // http protocol of its own, so an unprefixed URL cannot be opened at all.
    if (/^https?:\/\//i.test(uri)) return jsfetch + ':' + uri;
    if (HAS_SCHEME.test(uri)) return uri; // data:/blob:/crypto+/jsfetch: are explicit
    let resolved = uri;
    try { resolved = new URL(uri, baseUrl).href; } catch (e) { return uri; }
    return jsfetch + ':' + resolved;
  }

  function rewriteHlsUrisAbs(text, baseUrl, scheme) {
    if (!text || !baseUrl) return { text: String(text || ''), rewritten: 0 };
    const lines = String(text).split(/\r?\n/);
    const out = [];
    let rewritten = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { out.push(line); continue; }
      if (trimmed.charAt(0) !== '#') {
        // segment / variant URI line
        out.push(absoluteJsFetchUri(trimmed, baseUrl, scheme));
        rewritten++;
        continue;
      }
      if (!URI_ATTR_TAGS.test(trimmed)) { out.push(line); continue; }
      const replaced = line.replace(/URI="([^"]*)"/g, function (whole, uri) {
        rewritten++;
        return 'URI="' + absoluteJsFetchUri(uri, baseUrl, scheme) + '"';
      });
      out.push(replaced);
    }
    return { text: out.join('\n'), rewritten: rewritten };
  }

  function hlsVariantKey(variant) {
    return variant && variant.url ? itemKey(String(variant.url)) : '';
  }

  function resolutionArea(resolution) {
    const m = String(resolution || '').match(/^(\d+)x(\d+)$/i);
    return m ? Number(m[1]) * Number(m[2]) : 0;
  }

  function normalizeHlsVariants(variants) {
    const byKey = new Map();
    for (const raw of variants || []) {
      if (!raw || !raw.url) continue;
      const variant = Object.assign({}, raw, {
        url: String(raw.url),
        bandwidth: Number(raw.bandwidth) || 0,
        resolution: raw.resolution ? String(raw.resolution) : null,
        codecs: raw.codecs ? String(raw.codecs) : null,
        audioUrl: raw.audioUrl ? String(raw.audioUrl) : null,
      });
      const key = hlsVariantKey(variant);
      const previous = byKey.get(key);
      if (!previous && byKey.size >= MAX_HLS_VARIANTS) continue;
      // A later observation can fill in an alternate audio URL or richer
      // rendition metadata without creating a duplicate quality entry.
      if (previous) {
        const merged = Object.assign({}, previous, variant);
        if (!variant.audioUrl && previous.audioUrl) merged.audioUrl = previous.audioUrl;
        if (!variant.resolution && previous.resolution) merged.resolution = previous.resolution;
        if (!variant.codecs && previous.codecs) merged.codecs = previous.codecs;
        if (!variant.bandwidth && previous.bandwidth) merged.bandwidth = previous.bandwidth;
        byKey.set(key, merged);
      } else {
        byKey.set(key, variant);
      }
    }
    return Array.from(byKey.values());
  }

  function mergeHlsVariants(existing, incoming) {
    return normalizeHlsVariants((existing || []).concat(incoming || []));
  }

  function hlsVariantLabel(variant) {
    if (!variant) return '';
    if (variant.resolution) return String(variant.resolution);
    if (variant.bandwidth) return Math.round(Number(variant.bandwidth) / 1000) + ' kbps';
    return 'HLS';
  }

  function pickBestVariant(variants) {
    let best = null;
    for (const v of variants || []) {
      if (!best || (Number(v.bandwidth) || 0) > (Number(best.bandwidth) || 0) ||
          ((Number(v.bandwidth) || 0) === (Number(best.bandwidth) || 0) &&
           resolutionArea(v.resolution) > resolutionArea(best.resolution))) best = v;
    }
    return best;
  }

  function variantKeyValue(key) {
    const raw = String(key || '');
    if (!raw) return '';
    return itemKey(raw);
  }

  function selectedHlsVariant(item) {
    const variants = item && Array.isArray(item.variants) ? item.variants : [];
    if (!variants.length) return null;
    const key = variantKeyValue(item && item.selectedVariantKey);
    if (key) {
      const selected = variants.find(function (variant) { return hlsVariantKey(variant) === key; });
      if (selected) return selected;
    }
    return pickBestVariant(variants);
  }

  function selectHlsVariant(item, key) {
    const variants = item && Array.isArray(item.variants) ? item.variants : [];
    const wanted = variantKeyValue(key);
    return variants.find(function (variant) { return hlsVariantKey(variant) === wanted; }) || null;
  }

  // Convert one validated master playlist into the single logical item shown
  // by the popup. Variant URLs inherit the master's auth query when needed;
  // alternate audio stays attached to its corresponding quality.
  function groupHlsItem(masterUrl, parsed, meta) {
    const media = parsed && Array.isArray(parsed.media) ? parsed.media : [];
    const rawVariants = (parsed && parsed.variants || []).map(function (raw) {
      const variant = Object.assign({}, raw, {
        url: withPlaylistToken(raw.url, raw.token),
      });
      if (!variant.audioUrl && variant.audioGroup) {
        const audio = media.find(function (entry) {
          return entry && entry.type === 'AUDIO' && entry.uri && entry.groupId === variant.audioGroup && entry.isDefault;
        }) || media.find(function (entry) {
          return entry && entry.type === 'AUDIO' && entry.uri && entry.groupId === variant.audioGroup;
        });
        if (audio) variant.audioUrl = withPlaylistToken(audio.uri, variant.token);
      }
      return variant;
    });
    const variants = normalizeHlsVariants(rawVariants);
    const best = pickBestVariant(variants);
    return Object.assign({}, meta || {}, {
      url: String(masterUrl),
      kind: 'hls',
      variants: variants,
      selectedVariantKey: best ? hlsVariantKey(best) : null,
    });
  }

  // ---- Media format helpers ---------------------------------------------------

  // MIME -> extension fallback table for common media formats.
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

  function fullMediaUrlFromByteRange(url) {
    // Instagram/Meta serves fMP4 playback chunks through an otherwise normal
    // looking *.mp4 URL with bytestart/byteend in the query. Saving that URL
    // produces a file beginning with `moof` (no ftyp/moov), so it is not a
    // playable MP4. The same signed CDN URL without only those two parameters
    // returns the complete file. Preserve every other query byte verbatim —
    // reserializing a signed query can invalidate it.
    const raw = String(url || '');
    const hashAt = raw.indexOf('#');
    const hash = hashAt >= 0 ? raw.slice(hashAt) : '';
    const noHash = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
    const queryAt = noHash.indexOf('?');
    if (queryAt < 0) return raw;
    const base = noHash.slice(0, queryAt);
    const parts = noHash.slice(queryAt + 1).split('&');
    let hasStart = false;
    let hasEnd = false;
    for (const part of parts) {
      const key = part.split('=', 1)[0].toLowerCase();
      if (key === 'bytestart') hasStart = true;
      if (key === 'byteend') hasEnd = true;
    }
    if (!hasStart || !hasEnd) return raw;
    const kept = parts.filter(function (part) {
      const key = part.split('=', 1)[0].toLowerCase();
      return key !== 'bytestart' && key !== 'byteend';
    });
    return base + (kept.length ? '?' + kept.join('&') : '') + hash;
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

  // ---- Dedicated-site handling -----------------------------------------------
  // Sites that have dedicated extraction adapters. The generic webRequest
  // detector skips them entirely — on these sites the generic heuristics only
  // produce noise (e.g. YouTube's signature-protected DASH chunks with no
  // file extension). A site may only be added here once its adapter exists;
  // unsupported sites must remain eligible for generic detection.
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
        // SegmentList: an explicit list of segment URLs (with an optional
        // Initialization). Left unhandled it fell through to the SegmentBase
        // branch and became "one segment = the manifest URL", so a SegmentList
        // manifest could not be downloaded at all. The list may also be
        // inherited from the AdaptationSet.
        const segList = /<SegmentList\b([^>]*?)(?:\/>|>([\s\S]*?)<\/SegmentList>)/i.exec(best.body)
          || /<SegmentList\b([^>]*?)(?:\/>|>([\s\S]*?)<\/SegmentList>)/i.exec(asBody);
        if (segList) {
          const listBody = segList[2] || '';
          const init = /<Initialization\b([^>]*?)(?:\/>|>)/i.exec(listBody);
          const initSrc = init ? (xmlAttr(init[1], 'sourceURL') || xmlAttr(init[1], 'initialisation')) : null;
          if (initSrc) initUrl = dashResolve(initSrc, base);
          const urlRe = /<SegmentURL\b([^>]*?)(?:\/>|>)/gi;
          let um;
          const seenRangeFiles = Object.create(null);
          while ((um = urlRe.exec(listBody)) !== null && segments.length < DASH_MAX_SEGMENTS) {
            const media = xmlAttr(um[1], 'media');
            if (!media) continue;
            const range = xmlAttr(um[1], 'mediaRange');
            if (range) {
              // Byte ranges into a single file: fetch that file once instead of
              // treating a range as a URL. base is the composed BaseURL chain,
              // so a bare media attribute resolves to the file itself.
              const resolved = dashResolve(media, base);
              if (!seenRangeFiles[resolved]) {
                seenRangeFiles[resolved] = true;
                segments.push(resolved);
              }
              continue;
            }
            segments.push(dashResolve(media, base));
          }
        } else {
          // SegmentBase / plain: one segment = the whole resolved source, but
          // only when it actually names a file (a BaseURL chain may end in a
          // directory, and the manifest URL is never a segment).
          const sb = /<SegmentBase\b([^>]*?)(?:\/>|>)/i.exec(best.body);
          const src = (sb && xmlAttr(sb[1], 'sourceURL')) || null;
          // Without a sourceURL the composed BaseURL chain is the file itself
          // when it names one, never a directory and never the manifest.
          const whole = src ? dashResolve(src, base)
            : (/[^/]$/.test(base) && !/\.mpd($|\?)/i.test(base) ? base : null);
          if (whole) segments.push(whole);
        }
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
    MAX_URL_LENGTH: MAX_URL_LENGTH,
    classifyUrl: classifyUrl,
    kindFromContentType: kindFromContentType,
    isSafeMediaUrl: isSafeMediaUrl,
    isYouTubeMediaUrl: isYouTubeMediaUrl,
    isYoutubeMediaUrl: isYouTubeMediaUrl,
    isVimeoPlayerUrl: isVimeoPlayerUrl,
    isConcreteMetadataUrl: isConcreteMetadataUrl,
    sanitizeFilename: sanitizeFilename,
    filenameForItem: filenameForItem,
    sanitizeRootFolder: sanitizeRootFolder,
    isBlacklisted: isBlacklisted,
    itemKey: itemKey,
    mergeItems: mergeItems,
    formatBytes: formatBytes,
    sortItems: sortItems,
    ytDlpCommand: ytDlpCommand,
    parseM3u8: parseM3u8,
    MAX_HLS_PLAYLIST_CHARS: MAX_HLS_PLAYLIST_CHARS,
    MAX_HLS_VARIANTS: MAX_HLS_VARIANTS,
    MAX_HLS_MEDIA: MAX_HLS_MEDIA,
    MAX_HLS_SEGMENTS: MAX_HLS_SEGMENTS,
    groupHlsItem: groupHlsItem,
    normalizeHlsVariants: normalizeHlsVariants,
    mergeHlsVariants: mergeHlsVariants,
    hlsVariantKey: hlsVariantKey,
    hlsVariantLabel: hlsVariantLabel,
    pickBestVariant: pickBestVariant,
    selectedHlsVariant: selectedHlsVariant,
    selectHlsVariant: selectHlsVariant,
    hostOf: hostOf,
    extFromContentType: extFromContentType,
    fullMediaUrlFromByteRange: fullMediaUrlFromByteRange,
    isSegmentUrl: isSegmentUrl,
    isAudioOnlyPlaylist: isAudioOnlyPlaylist,
    isSubtitlePlaylist: isSubtitlePlaylist,
    looksLikeHlsUrl: looksLikeHlsUrl,
    smartName: smartName,
    playlistDuration: playlistDuration,
    isDedicatedSite: isDedicatedSite,
    rewriteHlsUrisAbs: rewriteHlsUrisAbs,
    isConcretePageDataUrl: isConcretePageDataUrl,
    parseMpdTracks: parseMpdTracks,
    parseMpdSegments: parseMpdSegments,
    MIN_DIRECT_MEDIA_SIZE: MIN_DIRECT_MEDIA_SIZE,
  };
})();

if (typeof globalThis !== 'undefined') globalThis.MediaSniperLogic = MediaSniperLogic;
if (typeof module !== 'undefined' && module.exports) module.exports = MediaSniperLogic;
