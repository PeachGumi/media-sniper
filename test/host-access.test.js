/* Host-access preflight: a media host the extension has not been granted is a
 * real capability gap (VDH ships <all_urls>), and it used to surface as a bare
 * "Failed to fetch". These tests pin the mapping from a blocked fetch to an
 * actionable, named host. */
'use strict';

const assert = require('assert');
const path = require('path');

const API = require(path.join(__dirname, '..', 'src', 'host-access.js'));

let passed = 0;
function eq(actual, expected, label) {
  assert.deepStrictEqual(actual, expected, label + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  passed++;
}
function ok(value, label) {
  assert.ok(value, label);
  passed++;
}
function eqAsync(actual, expected, label) {
  eq(actual, expected, label);
}

function withChrome(grantedOrigins, fn) {
  const previous = globalThis.chrome;
  const calls = [];
  globalThis.chrome = {
    permissions: {
      contains: async function (opts) {
        calls.push(opts.origins);
        return (opts.origins || []).every(function (o) { return grantedOrigins.indexOf(o) !== -1; });
      },
    },
  };
  return Promise.resolve()
    .then(fn)
    .finally(function () {
      if (previous === undefined) delete globalThis.chrome;
      else globalThis.chrome = previous;
      void calls;
    });
}

(async function run() {
  // ---- pattern derivation -------------------------------------------------
  eq(API.patternFor('https://cdn.example.com/media/seg1.ts?token=abc'), 'https://cdn.example.com/*', 'https host');
  eq(API.patternFor('http://localhost:8080/hls/x.m3u8'), 'http://localhost:8080/*', 'port keeps origin');
  eq(API.patternFor('blob:chrome-extension://abc/def'), null, 'blob has no host');
  eq(API.patternFor('data:video/mp4;base64,AAAA'), null, 'data has no host');
  eq(API.patternFor('chrome-extension://abc/x.js'), null, 'extension url is not a media host');
  eq(API.patternFor(''), null, 'empty url');
  eq(API.patternFor(null), null, 'null url');
  eq(API.hostFor('https://cdn.example.com/a/b?c=d'), 'cdn.example.com', 'host only');
  eq(API.uniquePatterns([
    'https://cdn.example.com/a.ts',
    'https://cdn.example.com/b.ts?sig=1#frag',
    'https://other.example.net/c.mp4',
    'blob:abc',
  ]), ['https://cdn.example.com/*', 'https://other.example.net/*'], 'dedupe by origin, skip non-http');

  // ---- error shape --------------------------------------------------------
  const err = API.error(['https://cdn.example.com/*']);
  ok(API.isHostAccessError(err), 'typed error');
  eq(err.name, 'HostAccessError', 'error name');
  eq(err.hosts, ['cdn.example.com'], 'hosts carried');
  eq(err.hostPatterns, ['https://cdn.example.com/*'], 'patterns carried');
  ok(err.message.indexOf('cdn.example.com') !== -1, 'message names the host');
  ok(err.message.indexOf('sig=') === -1, 'no query string in the message');
  eq(API.isHostAccessError(new Error('Failed to fetch')), false, 'plain error is not a host error');
  eq(API.isHostAccessError(null), false, 'null is not a host error');
  eq(API.info('plain string'), null, 'info of a plain string');
  eq(API.info(new Error('nope')), null, 'info of a plain error');
  eq(API.info(err).patterns, ['https://cdn.example.com/*'], 'info round-trip');
  eq(API.info(err).hosts, ['cdn.example.com'], 'info hosts');

  // ---- permission checks --------------------------------------------------
  await withChrome(['https://cdn.example.com/*'], async function () {
    eq(await API.missing(['https://cdn.example.com/a.ts']), [], 'granted host is not missing');
    eq(await API.missing(['https://cdn.example.com/a.ts', 'https://blocked.example.net/b.ts']),
      ['https://blocked.example.net/*'], 'only the ungranted host is missing');
    eq(await API.missing(['blob:abc', 'data:,x']), [], 'non-http urls need no permission');
    eq(await API.granted(['https://cdn.example.com/*', 'https://blocked.example.net/*']),
      ['https://cdn.example.com/*'], 'granted subset');
  });

  const previousChrome = globalThis.chrome;
  delete globalThis.chrome;
  eq(await API.missing(['https://cdn.example.com/a.ts']), [], 'without the permissions API nothing is missing');
  eq(await API.describeFetchFailure('https://cdn.example.com/a.ts', new TypeError('Failed to fetch')), null,
    'without the permissions API a TypeError stays a plain error');
  if (previousChrome === undefined) delete globalThis.chrome;
  else globalThis.chrome = previousChrome;

  // ---- fetch failure mapping ---------------------------------------------
  await withChrome([], async function () {
    const mapped = await API.describeFetchFailure('https://cdn.example.com/media.m3u8?sig=secret',
      new TypeError('Failed to fetch'));
    ok(mapped, 'a TypeError on an ungranted host is recognised');
    eq(mapped.patterns, ['https://cdn.example.com/*'], 'mapped pattern');
    eq(mapped.hosts, ['cdn.example.com'], 'mapped host');
    ok(mapped.message.indexOf('secret') === -1, 'mapped message leaks no signature');
    eq(API.takePending(), ['https://cdn.example.com/*'], 'the failure is recorded for the job');
    eq(API.takePending(), [], 'recording is one-shot');

    eq(await API.describeFetchFailure('https://cdn.example.com/a.ts', new Error('http 404')), null,
      'a real http error is not a host problem');
    eq(await API.describeFetchFailure('https://cdn.example.com/a.ts', new DOMExceptionLike('AbortError')), null,
      'an abort is not a host problem');
  });
  await withChrome(['https://cdn.example.com/*'], async function () {
    eq(await API.describeFetchFailure('https://cdn.example.com/a.ts', new TypeError('Failed to fetch')), null,
      'a granted host keeps its normal error path');
    eq(API.pendingPatterns(), [], 'nothing recorded for a granted host');
  });

  // ---- pending list -------------------------------------------------------
  API.record(['https://a.example/*', 'https://a.example/*', 'https://b.example/*']);
  eq(API.pendingPatterns(), ['https://a.example/*', 'https://b.example/*'], 'pending dedupes');
  API.record(['https://b.example/*', 'https://c.example/*']);
  eq(API.takePending(), ['https://a.example/*', 'https://b.example/*', 'https://c.example/*'], 'pending accumulates then clears');
  eq(API.pendingPatterns(), [], 'cleared');

  function DOMExceptionLike(name) {
    const e = new Error(name);
    e.name = name;
    return e;
  }

  console.log('ok host-access: ' + passed + ' passed, 0 failed');
})().catch(function (err) {
  console.error('FAIL host-access:', err && err.stack || err);
  process.exit(1);
});
