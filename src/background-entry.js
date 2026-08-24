/* Media Sniper MV3 service-worker entrypoint.
 * Security policy is installed before the legacy media pipeline registers its
 * listeners, then activated after background.js has finished registration.
 */
'use strict';

importScripts('security-bootstrap.js');
MediaSniperSecurityBootstrap.install(chrome);
importScripts('security-guard.js');
MediaSniperSecurity.prepare(chrome);
try {
  importScripts('background.js');
} finally {
  MediaSniperSecurity.activate(chrome);
}
