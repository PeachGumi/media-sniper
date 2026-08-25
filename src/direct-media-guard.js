/* Runtime refinement for direct-media intake.
 *
 * The legacy pure helper intentionally treated every .aac URL as an HLS
 * segment to suppress X Spaces-style ADTS chunk noise. That also hid genuine
 * standalone AAC downloads such as /music/song.aac. Keep the proven segment
 * suppression for segment-like names while allowing ordinary AAC files to
 * reach normalizeItem().
 */
'use strict';

const MediaSniperDirectMediaGuard = (function () {
  function pathOf(url) {
    try { return new URL(String(url)).pathname; }
    catch (e) { return String(url || '').split(/[?#]/)[0]; }
  }

  function isLikelyAacSegment(url) {
    let name = pathOf(url).split('/').pop() || '';
    try { name = decodeURIComponent(name); } catch (e) { /* keep raw */ }
    if (!/\.aac$/i.test(name)) return false;
    const stem = name.replace(/\.aac$/i, '');

    // Common HLS/ADTS naming families, including X Spaces
    // chunk_1_0_a.aac and ffmpeg-style fileSequence0.aac.
    if (/(?:chunk|seg(?:ment)?|part|frag(?:ment)?|sequence)[_-]?\d/i.test(stem)) return true;
    // Bare sequence-number segments such as 00001.aac.
    if (/^\d{2,}$/.test(stem)) return true;
    return false;
  }

  function install(root) {
    const target = root || globalThis;
    const L = target.MediaSniperLogic;
    if (!L || typeof L.isSegmentUrl !== 'function') return false;
    if (L.__directMediaGuardInstalled) return true;

    const original = L.isSegmentUrl.bind(L);
    L.isSegmentUrl = function (url) {
      if (/\.aac$/i.test(pathOf(url))) return isLikelyAacSegment(url);
      return original(url);
    };
    Object.defineProperty(L, '__directMediaGuardInstalled', {
      value: true,
      enumerable: false,
      configurable: false,
    });
    return true;
  }

  return { pathOf, isLikelyAacSegment, install };
})();

if (typeof globalThis !== 'undefined') {
  globalThis.MediaSniperDirectMediaGuard = MediaSniperDirectMediaGuard;
  if (globalThis.MediaSniperLogic) MediaSniperDirectMediaGuard.install(globalThis);
}
if (typeof module !== 'undefined' && module.exports) module.exports = MediaSniperDirectMediaGuard;
