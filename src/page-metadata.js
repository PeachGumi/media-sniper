/* Bounded page-DOM metadata adapter for Media Sniper.
 *
 * This module only reads DOM attributes/text. It never wraps fetch/XHR, calls a
 * site API, or sends a raw JSON-LD object across the page/content boundary.
 * The bridge owns emission; this file returns compact records for it to emit.
 *
 * Re-execution safe: content-script injection paths can load this file more
 * than once in the same MAIN-world realm.
 */
'use strict';

var MediaSniperPageMetadata = globalThis.MediaSniperPageMetadata || (function () {
  const MAX_URL_LENGTH = 4096;
  const MAX_TEXT_LENGTH = 500;
  const MAX_CONTENT_TYPE_LENGTH = 200;
  const MAX_CANDIDATES = 128;
  const MAX_HINTS = 128;
  const MAX_MEDIA_ELEMENTS = 128;
  const MAX_META_ELEMENTS = 256;
  const MAX_JSONLD_SCRIPTS = 32;
  const MAX_JSONLD_TEXT = 100000;
  const MAX_JSONLD_NODES = 512;
  const MAX_JSONLD_DEPTH = 8;
  const MAX_JSONLD_ARRAY = 64;
  const MAX_JSONLD_KEYS = 64;
  const MAX_VIMEO_IDENTITIES = 32;
  const MAX_VIMEO_ID_LENGTH = 20;

  const FALLBACK_EXT_KIND = {
    mp4: 'video', m4v: 'video', webm: 'video', mkv: 'video', avi: 'video',
    mov: 'video', flv: 'video', ogv: 'video',
    mp3: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio', opus: 'audio',
    wav: 'audio', flac: 'audio',
    m3u8: 'hls', mpd: 'dash', ts: 'ts', m4s: 'ts', fmp4: 'ts',
  };

  const logic = (typeof globalThis !== 'undefined' && globalThis.MediaSniperLogic) || {};

  function text(value, maxLen) {
    if (value == null) return '';
    const s = String(value).trim();
    return s.length > maxLen ? s.slice(0, maxLen) : s;
  }

  function attr(el, name) {
    if (!el) return '';
    try {
      const value = typeof el.getAttribute === 'function' ? el.getAttribute(name) : el[name];
      if (value == null) return '';
      const s = String(value).trim();
      // Preserve the over-limit signal so safeUrl() rejects it; truncating a
      // URL before validation would accidentally turn an unsafe long URL into
      // a different, seemingly valid candidate.
      return s.length > MAX_URL_LENGTH ? s.slice(0, MAX_URL_LENGTH + 1) : s;
    } catch (_) { return ''; }
  }

  function query(doc, selector, limit) {
    try {
      if (!doc || typeof doc.querySelectorAll !== 'function') return [];
      const nodes = doc.querySelectorAll(selector) || [];
      const out = [];
      const max = Number.isFinite(limit) ? Math.max(0, limit) : 128;
      for (let i = 0; i < nodes.length && i < max; i++) out.push(nodes[i]);
      return out;
    } catch (_) { return []; }
  }

  function safeUrl(raw, baseUrl) {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    if (!value || value.length > MAX_URL_LENGTH) return null;
    try {
      const u = new URL(value, baseUrl || '');
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        return u.href.length <= MAX_URL_LENGTH ? u.href : null;
      }
      if (u.protocol === 'blob:') {
        // Page-created blobs are handled by the existing element path. Only
        // permit blobs whose inner URL is an HTTP(S) page origin; do not let a
        // page metadata record name an extension-owned blob.
        const inner = new URL(String(u.href).slice('blob:'.length));
        if ((inner.protocol === 'http:' || inner.protocol === 'https:') && u.href.length <= MAX_URL_LENGTH) {
          return u.href;
        }
      }
    } catch (_) { /* malformed or unsupported URL */ }
    return null;
  }

  function isSafeUrl(raw, baseUrl) {
    return !!safeUrl(raw, baseUrl);
  }

  function pathExtension(url) {
    try {
      const u = new URL(url);
      const m = u.pathname.match(/\.([a-z0-9]{2,5})$/i);
      return m ? m[1].toLowerCase() : null;
    } catch (_) { return null; }
  }

  function kindFromType(contentType, url) {
    let kind = null;
    if (logic && typeof logic.kindFromContentType === 'function') {
      try { kind = logic.kindFromContentType(contentType || null, url); } catch (_) {}
    }
    if (!kind && logic && typeof logic.classifyUrl === 'function') {
      try { kind = logic.classifyUrl(url).kind; } catch (_) {}
    }
    if (!kind) kind = FALLBACK_EXT_KIND[pathExtension(url)];
    return kind || null;
  }

  function normalizedContentType(value) {
    const ct = text(value, MAX_CONTENT_TYPE_LENGTH);
    return ct || null;
  }

  function mediaKind(url, contentType, hint, elementContext) {
    const inferred = kindFromType(contentType, url);
    // A public Vimeo player URL is identity metadata, even when a page labels
    // it video/mp4. Only a concrete media URL may become a candidate.
    if (!elementContext && logic && typeof logic.isVimeoPlayerUrl === 'function') {
      try { if (logic.isVimeoPlayerUrl(url)) return null; } catch (_) {}
    }
    // A manifest/segment must not become a video merely because it appears in
    // a <video> tag. Background webRequest owns playlists and segments.
    if (inferred === 'hls' || inferred === 'dash' || inferred === 'ts') return null;
    if (inferred === 'video' || inferred === 'audio') return inferred;
    if (elementContext && (hint === 'video' || hint === 'audio')) return hint;
    // Metadata records need either a recognizable media URL or a media MIME;
    // an arbitrary player/embed URL is only a hint and is never downloadable.
    return null;
  }

  function elementHint(el) {
    let current = el;
    for (let depth = 0; current && depth < 8; depth++, current = current.parentElement) {
      const tag = String(current.tagName || '').toLowerCase();
      if (tag === 'video') return 'video';
      if (tag === 'audio') return 'audio';
    }
    return null;
  }

  function finiteDuration(value) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
    return 0;
  }

  function isoDuration(value) {
    if (typeof value === 'number') return finiteDuration(value);
    const m = String(value || '').match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
    if (!m || (!m[1] && !m[2] && !m[3])) return 0;
    return finiteDuration((Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0));
  }

  function typeHas(value, wanted) {
    const values = Array.isArray(value) ? value : [value];
    return values.some(function (v) {
      const s = String(v || '').toLowerCase();
      return s === wanted.toLowerCase() || s.endsWith('/' + wanted.toLowerCase()) || s.endsWith('#' + wanted.toLowerCase());
    });
  }

  function isVimeoHost(host) {
    const h = String(host || '').toLowerCase();
    return h === 'vimeo.com' || h === 'www.vimeo.com' || h === 'player.vimeo.com';
  }

  function numericVimeoId(value) {
    const id = String(value == null ? '' : value).trim();
    if (id.length > MAX_VIMEO_ID_LENGTH) return null;
    return /^\d{1,20}$/.test(id) ? id : null;
  }

  function vimeoIdFromUrl(raw, baseUrl) {
    const url = safeUrl(raw, baseUrl);
    if (!url) return null;
    try {
      const u = new URL(url);
      if (!isVimeoHost(u.hostname)) return null;
      const parts = u.pathname.split('/').filter(Boolean);
      for (let i = parts.length - 1; i >= 0; i--) {
        const id = numericVimeoId(decodeURIComponent(parts[i]));
        if (id) return id;
      }
    } catch (_) { /* invalid public data attribute */ }
    return null;
  }

  function vimeoIdentityForElement(el, baseUrl) {
    let current = el;
    for (let depth = 0; current && depth < 8; depth++, current = current.parentElement) {
      const dataId = numericVimeoId(attr(current, 'data-vimeo-id'));
      if (dataId) return dataId;
      const dataUrl = attr(current, 'data-vimeo-url');
      const urlId = vimeoIdFromUrl(dataUrl, baseUrl);
      if (urlId) return urlId;
      const tag = String(current.tagName || '').toLowerCase();
      if (tag === 'iframe') {
        const frameId = vimeoIdFromUrl(attr(current, 'src'), baseUrl);
        if (frameId) return frameId;
      }
    }
    return null;
  }

  function collectVimeoIdentities(doc, baseUrl) {
    const out = [];
    const seen = new Set();
    const elements = query(doc, '[data-vimeo-id], [data-vimeo-url], iframe[src*="vimeo.com"]', MAX_VIMEO_IDENTITIES);
    for (let i = 0; i < elements.length && out.length < MAX_VIMEO_IDENTITIES; i++) {
      const el = elements[i];
      const id = vimeoIdentityForElement(el, baseUrl);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ provider: 'vimeo', id: id });
    }
    return out;
  }

  function recordKey(record) {
    return record.url + '\u0000' + (record.kind || '');
  }

  function compactRecord(url, kind, contentType, title, via, metadataSource, duration, vimeoId) {
    const out = {
      url: url,
      kind: kind,
      contentType: normalizedContentType(contentType),
      size: 0,
      via: via,
      metadataSource: metadataSource,
    };
    const t = text(title, MAX_TEXT_LENGTH);
    if (t) out.title = t;
    const d = finiteDuration(duration);
    if (d) out.duration = d;
    const id = numericVimeoId(vimeoId);
    if (id) out.vimeoId = id;
    return out;
  }

  function addRecord(state, rawUrl, baseUrl, kindHint, contentType, title, via, metadataSource, duration, vimeoId, elementContext) {
    const url = safeUrl(rawUrl, baseUrl);
    if (!url) return null;
    const kind = mediaKind(url, contentType, kindHint, elementContext);
    const record = compactRecord(url, kind, contentType, title, via, metadataSource, duration, vimeoId);
    const list = kind === 'video' || kind === 'audio' ? state.candidates : state.hints;
    const limit = list === state.candidates ? MAX_CANDIDATES : MAX_HINTS;
    if (list.length >= limit) return record;
    const key = recordKey(record);
    const existing = state.seen.get((list === state.candidates ? 'c:' : 'h:') + key);
    if (existing) {
      if (!existing.title && record.title) existing.title = record.title;
      if (!existing.contentType && record.contentType) existing.contentType = record.contentType;
      if (!existing.duration && record.duration) existing.duration = record.duration;
      if (!existing.vimeoId && record.vimeoId) existing.vimeoId = record.vimeoId;
      return existing;
    }
    state.seen.set((list === state.candidates ? 'c:' : 'h:') + key, record);
    list.push(record);
    return record;
  }

  function pageTitle(doc, metaValues) {
    const og = metaValues && metaValues.ogTitle ? metaValues.ogTitle : '';
    if (og) return text(og, MAX_TEXT_LENGTH);
    try { return text(doc && doc.title, MAX_TEXT_LENGTH); } catch (_) { return ''; }
  }

  function collectOpenGraph(doc, baseUrl, state, metaValues) {
    const groups = {
      video: { urls: [], type: '' },
      audio: { urls: [], type: '' },
    };
    const metas = query(doc, 'meta', MAX_META_ELEMENTS);
    for (let i = 0; i < metas.length && i < MAX_META_ELEMENTS; i++) {
      const el = metas[i];
      const property = (attr(el, 'property') || attr(el, 'name')).toLowerCase();
      const content = attr(el, 'content');
      if (!content && property !== 'og:title') continue;
      if (property === 'og:title') {
        if (!metaValues.ogTitle) metaValues.ogTitle = content;
        continue;
      }
      const m = property.match(/^og:(video|audio)(?::(secure_url|url|type))?$/);
      if (!m) continue;
      const group = groups[m[1]];
      const field = m[2] || 'url';
      if (field === 'type') {
        if (!group.type) group.type = content;
      } else if (group.urls.length < 16) {
        group.urls.push(content);
      }
    }
    ['video', 'audio'].forEach(function (kind) {
      const group = groups[kind];
      for (const rawUrl of group.urls) {
        addRecord(state, rawUrl, baseUrl, kind, group.type, state.pageTitle, 'metadata', 'og', 0, null, false);
      }
    });
  }

  function collectMedia(doc, baseUrl, state) {
    const elements = query(doc, 'video, audio, source', MAX_MEDIA_ELEMENTS);
    for (let i = 0; i < elements.length && i < MAX_MEDIA_ELEMENTS; i++) {
      const el = elements[i];
      let rawUrl = '';
      try { rawUrl = typeof el.currentSrc === 'string' ? el.currentSrc : ''; } catch (_) {}
      if (!rawUrl) rawUrl = attr(el, 'src') || attr(el, 'currentSrc') || (function () {
        try { return typeof el.src === 'string' ? el.src : ''; } catch (_) { return ''; }
      })();
      if (!rawUrl) continue;
      const hint = elementHint(el);
      const contentType = attr(el, 'type');
      let duration = 0;
      try { duration = finiteDuration(el.duration); } catch (_) {}
      if (!duration && el.parentElement) {
        try { duration = finiteDuration(el.parentElement.duration); } catch (_) {}
      }
      const tag = String(el.tagName || '').toLowerCase();
      const ownHint = tag === 'audio' ? 'audio' : (tag === 'video' ? 'video' : hint);
      addRecord(state, rawUrl, baseUrl, ownHint, contentType, attr(el, 'title') || attr(el, 'aria-label') || '', 'element', 'element', duration, vimeoIdentityForElement(el, baseUrl), true);
    }
  }

  function collectJsonLd(doc, baseUrl, state) {
    const scripts = query(doc, 'script[type="application/ld+json"]', MAX_JSONLD_SCRIPTS);
    const budget = { nodes: 0 };
    function addObject(obj) {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !typeHas(obj['@type'], 'VideoObject')) return;
      const title = text(obj.name, MAX_TEXT_LENGTH) || state.pageTitle;
      const contentType = normalizedContentType(obj.encodingFormat || obj.fileFormat);
      const urls = Array.isArray(obj.contentUrl) ? obj.contentUrl.slice(0, 16) : [obj.contentUrl];
      for (const rawUrl of urls) {
        if (typeof rawUrl !== 'string') continue;
        addRecord(state, rawUrl, baseUrl, 'video', contentType, title, 'metadata', 'jsonld', isoDuration(obj.duration), null, false);
      }
    }
    function walk(value, depth) {
      if (budget.nodes >= MAX_JSONLD_NODES || depth > MAX_JSONLD_DEPTH || value == null) return;
      budget.nodes++;
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length && i < MAX_JSONLD_ARRAY; i++) walk(value[i], depth + 1);
        return;
      }
      if (typeof value !== 'object') return;
      addObject(value);
      const keys = Object.keys(value).slice(0, MAX_JSONLD_KEYS);
      for (const key of keys) {
        // Do not treat embedUrl (or any other schema field) as a media URL.
        // Recursing through @graph and arrays is enough to find nested objects.
        if (key === 'contentUrl' || key === 'embedUrl') continue;
        walk(value[key], depth + 1);
      }
    }
    for (let i = 0; i < scripts.length && i < MAX_JSONLD_SCRIPTS; i++) {
      let raw = '';
      try { raw = String(scripts[i].textContent || ''); } catch (_) { raw = ''; }
      if (!raw || raw.length > MAX_JSONLD_TEXT) continue;
      try { walk(JSON.parse(raw), 0); } catch (_) { /* malformed JSON-LD is ignored */ }
      if (budget.nodes >= MAX_JSONLD_NODES) break;
    }
  }

  function collect(doc, baseUrl) {
    const state = {
      candidates: [],
      hints: [],
      seen: new Map(),
      pageTitle: '',
    };
    const metaValues = { ogTitle: '' };
    collectOpenGraph(doc, baseUrl, state, metaValues);
    state.pageTitle = pageTitle(doc, metaValues);
    // Revisit OG records only for title enrichment after og:title is known.
    for (const item of state.candidates) {
      if (item.metadataSource === 'og' && !item.title && state.pageTitle) item.title = state.pageTitle;
    }
    collectMedia(doc, baseUrl, state);
    collectJsonLd(doc, baseUrl, state);
    return {
      pageTitle: state.pageTitle,
      candidates: state.candidates,
      hints: state.hints,
      vimeoIdentities: collectVimeoIdentities(doc, baseUrl),
    };
  }

  return {
    MAX_URL_LENGTH,
    MAX_CANDIDATES,
    MAX_HINTS,
    MAX_JSONLD_NODES,
    MAX_JSONLD_DEPTH,
    safeUrl,
    isSafeUrl,
    vimeoIdFromUrl,
    vimeoIdentityForElement,
    collectVimeoIdentities,
    collect,
  };
})();

if (typeof globalThis !== 'undefined') globalThis.MediaSniperPageMetadata = MediaSniperPageMetadata;
if (typeof module !== 'undefined' && module.exports) module.exports = MediaSniperPageMetadata;
