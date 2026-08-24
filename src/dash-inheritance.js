/* DASH inheritance resolver.
 *
 * Overrides the exported MPD resolver after logic.js/background.js load so
 * SegmentTemplate/BaseURL inherited from AdaptationSet/Period/MPD are honored.
 * Kept separate from logic.js to make this compatibility fix reviewable and
 * easy to remove once the core parser is replaced with a structured XML parser.
 */
'use strict';

(function () {
  const L = globalThis.MediaSniperLogic || (typeof require !== 'undefined' ? require('./logic.js') : null);
  if (!L) return;

  const MAX_SEGMENTS = 20000;

  function attr(tag, name) {
    const m = String(tag || '').match(new RegExp('\\b' + name + '\\s*=\\s*["\\\']([^"\\\']*)["\\\']', 'i'));
    return m ? m[1] : null;
  }

  function attrsToObject(raw) {
    const out = {};
    const re = /([:\w-]+)\s*=\s*["']([^"']*)["']/g;
    let m;
    while ((m = re.exec(String(raw || ''))) !== null) out[m[1]] = m[2];
    return out;
  }

  function mergeAttrs() {
    const out = {};
    for (const a of arguments) Object.assign(out, a || {});
    return out;
  }

  function isoDuration(s) {
    const m = String(s || '').match(/PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?/i);
    if (!m || (!m[1] && !m[2] && !m[3])) return 0;
    return (parseFloat(m[1] || 0) * 3600) + (parseFloat(m[2] || 0) * 60) + parseFloat(m[3] || 0);
  }

  function pad(n, width) {
    let s = String(n);
    while (s.length < width) s = '0' + s;
    return s;
  }

  function fill(tmpl, ctx) {
    return String(tmpl || '')
      .replace(/\$\$/g, '\u0000')
      .replace(/\$RepresentationID\$/g, ctx.repId == null ? '' : String(ctx.repId))
      .replace(/\$Bandwidth\$/g, String(ctx.bandwidth || 0))
      .replace(/\$Number%0(\d+)d\$/g, (_, w) => pad(ctx.num, parseInt(w, 10)))
      .replace(/\$Number\$/g, String(ctx.num))
      .replace(/\$Time%0(\d+)d\$/g, (_, w) => pad(ctx.time, parseInt(w, 10)))
      .replace(/\$Time\$/g, String(ctx.time))
      .replace(/\u0000/g, '$');
  }

  function resolveUrl(value, base) {
    try { return new URL(value || '', base || 'http://invalid/').href; }
    catch (_) { return value || base || ''; }
  }

  function firstBaseBefore(body, childTag) {
    let scope = String(body || '');
    if (childTag) {
      const i = scope.search(new RegExp('<' + childTag + '\\b', 'i'));
      if (i >= 0) scope = scope.slice(0, i);
    }
    const m = /<BaseURL\b[^>]*>([\s\S]*?)<\/BaseURL>/i.exec(scope);
    return m ? m[1].trim() : null;
  }

  function templateFrom(scope, beforeTag) {
    let body = String(scope || '');
    if (beforeTag) {
      const i = body.search(new RegExp('<' + beforeTag + '\\b', 'i'));
      if (i >= 0) body = body.slice(0, i);
    }
    const m = /<SegmentTemplate\b([^>]*?)(?:\/>|>([\s\S]*?)<\/SegmentTemplate>)/i.exec(body);
    if (!m) return null;
    return { attrs: attrsToObject(m[1]), body: m[2] || '' };
  }

  function segmentBaseFrom(scope) {
    const m = /<SegmentBase\b([^>]*?)(?:\/>|>)/i.exec(String(scope || ''));
    return m ? attrsToObject(m[1]) : null;
  }

  function timelineBody(templates) {
    for (let i = templates.length - 1; i >= 0; i--) {
      const t = templates[i];
      if (!t) continue;
      const m = /<SegmentTimeline\b[^>]*>([\s\S]*?)<\/SegmentTimeline>/i.exec(t.body || '');
      if (m) return m[1];
    }
    return null;
  }

  function typeFor(asAttrs, rep) {
    let type = String(asAttrs.contentType || '').toLowerCase();
    const mime = rep.mimeType || asAttrs.mimeType || '';
    const codecs = rep.codecs || asAttrs.codecs || '';
    if (!type) {
      if (/^video\//i.test(mime)) type = 'video';
      else if (/^audio\//i.test(mime)) type = 'audio';
      else if (/^(text|application)\//i.test(mime)) type = 'subtitle';
      else if (/^(avc|hev|hvc|vp[89]|av0)/i.test(codecs)) type = 'video';
      else if (/^(mp4a|ac-[34]|ec-3|opus|flac)/i.test(codecs)) type = 'audio';
    }
    return type;
  }

  function buildSegments(tplAttrs, timeline, rep, totalDur, base) {
    const segments = [];
    const timescale = parseInt(tplAttrs.timescale, 10) || 1;
    const startNumber = parseInt(tplAttrs.startNumber, 10) || 1;
    const media = tplAttrs.media || '';
    if (!media) return segments;

    if (timeline) {
      const events = [];
      const re = /<S\b([^>]*?)\/?>/gi;
      let sm;
      while ((sm = re.exec(timeline)) !== null) {
        const a = attrsToObject(sm[1]);
        events.push({
          t: a.t != null ? parseInt(a.t, 10) : null,
          d: parseInt(a.d, 10) || 0,
          r: a.r != null ? parseInt(a.r, 10) : 0,
        });
      }
      let curT = 0;
      let num = startNumber;
      for (let i = 0; i < events.length && segments.length < MAX_SEGMENTS; i++) {
        const ev = events[i];
        if (ev.t != null) curT = ev.t;
        let reps = ev.r;
        if (reps < 0) {
          const nextT = (i + 1 < events.length && events[i + 1].t != null)
            ? events[i + 1].t
            : (totalDur > 0 ? Math.round(totalDur * timescale) : curT + ev.d);
          reps = ev.d > 0 ? Math.max(0, Math.ceil((nextT - curT) / ev.d)) - 1 : 0;
        }
        for (let k = 0; k <= reps && segments.length < MAX_SEGMENTS; k++) {
          segments.push(resolveUrl(fill(media, {
            repId: rep.id, bandwidth: rep.bandwidth, num, time: curT,
          }), base));
          num++;
          curT += ev.d;
        }
      }
      return segments;
    }

    const duration = parseInt(tplAttrs.duration, 10) || 0;
    if (duration > 0 && totalDur > 0) {
      const count = Math.min(MAX_SEGMENTS, Math.ceil((totalDur * timescale) / duration));
      for (let i = 0; i < count; i++) {
        segments.push(resolveUrl(fill(media, {
          repId: rep.id,
          bandwidth: rep.bandwidth,
          num: startNumber + i,
          time: i * duration,
        }), base));
      }
    }
    return segments;
  }

  function parseMpdSegmentsInherited(mpdText, mpdUrl) {
    const out = { tracks: [] };
    if (!mpdText || typeof mpdText !== 'string' || !mpdText.includes('<')) return out;
    const text = mpdText.replace(/<!--[\s\S]*?-->/g, '');
    const mpdOpen = /<MPD\b([^>]*)>/i.exec(text);
    const mpdAttrs = attrsToObject(mpdOpen ? mpdOpen[1] : '');
    const totalDur = isoDuration(mpdAttrs.mediaPresentationDuration);
    const mpdPrefix = text.slice((mpdOpen ? mpdOpen.index + mpdOpen[0].length : 0), Math.max(0, text.search(/<Period\b/i)) || text.length);
    const mpdTpl = templateFrom(mpdPrefix);
    let mpdBase = resolveUrl(firstBaseBefore(mpdPrefix, null) || '', mpdUrl || 'http://invalid/');

    let entry = 0;
    const periods = [];
    const periodRe = /<Period\b([^>]*)>([\s\S]*?)<\/Period>/gi;
    let pm;
    while ((pm = periodRe.exec(text)) !== null) periods.push({ attrs: attrsToObject(pm[1]), body: pm[2] });
    if (!periods.length) periods.push({ attrs: {}, body: text });

    for (const period of periods) {
      const periodPrefixEnd = period.body.search(/<AdaptationSet\b/i);
      const periodPrefix = periodPrefixEnd >= 0 ? period.body.slice(0, periodPrefixEnd) : period.body;
      const periodTpl = templateFrom(periodPrefix);
      const periodBase = resolveUrl(firstBaseBefore(periodPrefix, null) || '', mpdBase);

      const asRe = /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi;
      let am;
      while ((am = asRe.exec(period.body)) !== null) {
        const asAttrs = attrsToObject(am[1]);
        const asBody = am[2];
        const asPrefixEnd = asBody.search(/<Representation\b/i);
        const asPrefix = asPrefixEnd >= 0 ? asBody.slice(0, asPrefixEnd) : asBody;
        const asTpl = templateFrom(asPrefix);
        const asBase = resolveUrl(firstBaseBefore(asPrefix, null) || '', periodBase);

        const reps = [];
        const repRe = /<Representation\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Representation>)/gi;
        let rm;
        while ((rm = repRe.exec(asBody)) !== null) {
          const ra = attrsToObject(rm[1]);
          reps.push({
            entry: entry++,
            id: ra.id,
            bandwidth: parseInt(ra.bandwidth, 10) || 0,
            mimeType: ra.mimeType || '',
            codecs: ra.codecs || '',
            width: parseInt(ra.width, 10) || 0,
            height: parseInt(ra.height, 10) || 0,
            body: rm[2] || '',
          });
        }
        if (!reps.length) continue;
        let best = reps[0];
        for (const r of reps) if (r.bandwidth > best.bandwidth) best = r;
        const type = typeFor(asAttrs, best);
        if (type !== 'video' && type !== 'audio') continue;

        const repTpl = templateFrom(best.body);
        const templates = [mpdTpl, periodTpl, asTpl, repTpl];
        const effectiveAttrs = mergeAttrs(
          mpdTpl && mpdTpl.attrs,
          periodTpl && periodTpl.attrs,
          asTpl && asTpl.attrs,
          repTpl && repTpl.attrs
        );
        const timeline = timelineBody(templates);
        const repBase = resolveUrl(firstBaseBefore(best.body, null) || '', asBase);
        let initUrl = null;
        let segments = [];

        if (Object.keys(effectiveAttrs).length && effectiveAttrs.media) {
          const init = effectiveAttrs.initialization || effectiveAttrs.initialisation;
          if (init) {
            initUrl = resolveUrl(fill(init, {
              repId: best.id, bandwidth: best.bandwidth, num: 0, time: 0,
            }), repBase);
          }
          segments = buildSegments(effectiveAttrs, timeline, best, totalDur, repBase);
        } else {
          const sb = segmentBaseFrom(best.body) || segmentBaseFrom(asPrefix) || segmentBaseFrom(periodPrefix);
          const src = sb && sb.sourceURL;
          segments = [resolveUrl(src || '', repBase)];
        }

        out.tracks.push({
          entry: best.entry,
          type,
          bandwidth: best.bandwidth,
          resolution: best.width && best.height ? best.width + 'x' + best.height : null,
          initUrl,
          segments,
        });
      }
    }
    return out;
  }

  L.parseMpdSegments = parseMpdSegmentsInherited;
  L.parseMpdTracks = function (mpdText) {
    return parseMpdSegmentsInherited(mpdText, null).tracks.map(function (t) {
      return { entry: t.entry, type: t.type, bandwidth: t.bandwidth, resolution: t.resolution };
    });
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = {
    parseMpdSegments: parseMpdSegmentsInherited,
  };
})();
