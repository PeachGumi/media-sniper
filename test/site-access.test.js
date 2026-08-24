'use strict';

const fs = require('fs');
const vm = require('vm');
const { eq, ok, report } = require('./harness.js');

let origins = [];
let registrations = [];
const listeners = { installed: [], startup: [], added: [], removed: [] };
const fakeChrome = {
  runtime: {
    onInstalled: { addListener(fn) { listeners.installed.push(fn); } },
    onStartup: { addListener(fn) { listeners.startup.push(fn); } },
  },
  permissions: {
    async getAll() { return { permissions: [], origins: origins.slice() }; },
    onAdded: { addListener(fn) { listeners.added.push(fn); } },
    onRemoved: { addListener(fn) { listeners.removed.push(fn); } },
  },
  scripting: {
    async getRegisteredContentScripts() { return registrations.slice(); },
    async unregisterContentScripts(opts) {
      const ids = new Set(opts.ids || []);
      registrations = registrations.filter((x) => !ids.has(x.id));
    },
    async registerContentScripts(items) { registrations.push(...items); },
  },
};

const context = vm.createContext({
  console,
  chrome: fakeChrome,
  URL,
  Set,
  globalThis: null,
  module: { exports: {} },
  exports: {},
});
context.globalThis = context;
const source = fs.readFileSync(require.resolve('../src/site-access.js'), 'utf8');
vm.runInContext(source, context, { filename: 'site-access.js' });
const S = context.MediaSniperSiteAccess;
ok(!!S, 'site access policy installed');

// No persistent origins means no dynamic detector registrations.
(async function () {
  await S.sync();
  eq(registrations.length, 0, 'no persistent scripts without host grant');

  origins = ['https://example.test/*'];
  await S.sync();
  eq(registrations.length, 1, 'site grant registers generic detector');
  eq(registrations[0].id, 'media-sniper-sites', 'generic registration id');
  eq(registrations[0].matches, ['https://example.test/*'], 'exact site match retained');
  eq(registrations[0].runAt, 'document_start', 'persistent detector starts at document_start');
  eq(registrations[0].allFrames, true, 'persistent generic detector covers frames');

  origins = ['https://www.youtube.com/*'];
  await S.sync();
  eq(registrations.map((x) => x.id).sort(), ['media-sniper-sites', 'media-sniper-youtube'], 'YouTube grant also registers MAIN-world adapter');
  const yt = registrations.find((x) => x.id === 'media-sniper-youtube');
  eq(yt.world, 'MAIN', 'YouTube adapter stays in MAIN world');

  origins = ['http://*/*', 'https://*/*'];
  await S.sync();
  const generic = registrations.find((x) => x.id === 'media-sniper-sites');
  eq(generic.matches, ['http://*/*', 'https://*/*'], 'all-sites mode is limited to HTTP(S)');
  ok(registrations.some((x) => x.id === 'media-sniper-youtube'), 'all-sites covers YouTube adapter');

  origins = [];
  await S.sync();
  eq(registrations.length, 0, 'revoking origins removes persistent registrations');

  eq(S.usableOriginPattern('https://a.example/*'), 'https://a.example/*', 'origin pattern normalized');
  eq(S.usableOriginPattern('file:///*'), null, 'non-http scheme rejected');
  eq(S.uniquePatterns(['https://a.example/*', 'https://a.example/*']), ['https://a.example/*'], 'duplicate grants collapse');
  eq(S.youtubeCovered(['https://music.youtube.com/*']), true, 'YouTube subdomain recognized');
  eq(S.youtubeCovered(['https://example.com/*']), false, 'unrelated site not YouTube');

  ok(listeners.installed.length === 1 && listeners.startup.length === 1, 'startup reconciliation listeners registered');
  ok(listeners.added.length === 1 && listeners.removed.length === 1, 'permission change listeners registered');

  report('site-access');
})().catch(function (e) {
  console.error(e);
  process.exitCode = 1;
});
