/* Compatibility shim for the historical Media Sniper import path.
 *
 * The old untraceable libav.js v6.5.7.1 binary is no longer used. Runtime
 * execution is delegated to the reproducible Media Sniper variant generated
 * from Yahweasel/libav.js v6.10.9.0. Keep this shim only until callers migrate
 * to the new filename directly.
 */
import LibAVFactory from './libav-6.10.9.0-media-sniper.wasm.mjs';

export default function MediaSniperLibAVFactory(options = {}) {
  return LibAVFactory({
    ...options,
    wasmurl: new URL('./libav-6.10.9.0-media-sniper.wasm.wasm', import.meta.url).href,
  });
}
