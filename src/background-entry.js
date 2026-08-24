/* Media Sniper MV3 service-worker entrypoint.
 * Security policy is installed before the legacy media pipeline registers its
 * listeners, then activated after background.js has finished registration.
 */
'use strict';

// Event listeners that must survive MV3 worker restarts are registered during
// top-level worker evaluation.
importScripts('install.js');
importScripts('security-bootstrap.js');
MediaSniperSecurityBootstrap.install(chrome);
importScripts('security-guard.js');
MediaSniperSecurity.prepare(chrome);
try {
  importScripts('background.js');
  // Mutates the exported MediaSniperLogic object that background.js already
  // references, so all later DASH work uses the inherited-template resolver.
  importScripts('dash-inheritance.js');
  // Shares the classic-script worker realm with background.js, allowing
  // bounded cleanup without exposing privileged state on globalThis.
  importScripts('background-lifecycle.js');
} finally {
  MediaSniperSecurity.activate(chrome);
}
