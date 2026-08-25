'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { eq, report } = require('./harness.js');

const source = fs.readFileSync(path.join(__dirname, '../src/navigation-refresh.js'), 'utf8');

{
  const ctx = { URL, globalThis: null, module: { exports: {} } };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  const p = ctx.module.exports;
  eq(p.shouldResetPage('https://a.test/watch/1', 'https://a.test/watch/2'), true, 'path navigation resets');
  eq(p.shouldResetPage('https://a.test/watch?q=1', 'https://a.test/watch?q=2'), true, 'query navigation resets');
  eq(p.shouldResetPage('https://a.test/watch', 'https://b.test/watch'), true, 'origin navigation resets');
  eq(p.shouldResetPage('https://a.test/watch#one', 'https://a.test/watch#two'), false, 'ordinary anchor does not reset');
  eq(p.shouldResetPage('https://a.test/#/one', 'https://a.test/#/two'), true, 'hash-router navigation resets');
  eq(p.shouldResetPage('https://a.test/watch', 'https://a.test/watch'), false, 'same URL does not reset');
  eq(p.sameOriginNavigationUrl('https://a.test/watch/2', 'https://a.test/watch/1'), 'https://a.test/watch/2', 'same-origin SPA URL accepted');
  eq(p.sameOriginNavigationUrl('https://evil.test/watch/2', 'https://a.test/watch/1'), null, 'cross-origin SPA URL rejected');
  eq(p.sameOriginNavigationUrl('javascript:alert(1)', 'https://a.test/watch/1'), null, 'non-http SPA URL rejected');
  eq(p.originPattern('https://a.test:8443/watch'), 'https://a.test/*', 'site origin pattern follows Chrome host matching');
  eq(p.isYoutube('https://www.youtube.com/watch?v=x'), true, 'YouTube host recognized');
}

{
  let persistCalls = 0;
  let badgeTab = null;
  const listeners = [];
  const tabUpdatedListeners = [];
  const injected = [];
  const state = {
    itemsByTab: new Map([[7, [{ pageUrl: 'https://a.test/old', url: 'https://cdn.test/old.mp4' }]]]),
    pageMeta: new Map([[7, { title: 'old', url: 'https://a.test/old' }]]),
  };
  const ctx = {
    URL,
    state,
    chrome: {
      runtime: {
        id: 'extid',
        onMessage: { addListener: function (fn) { listeners.push(fn); } },
      },
      tabs: {
        onUpdated: { addListener: function (fn) { tabUpdatedListeners.push(fn); } },
      },
      permissions: {
        contains: async function () { return false; },
      },
      scripting: {
        executeScript: async function (details) { injected.push(details); return []; },
      },
    },
    persistItems: function () { persistCalls++; },
    updateBadge: function (tabId) { badgeTab = tabId; },
    globalThis: null,
    module: { exports: {} },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(source, ctx);

  let response = null;
  listeners[0]({ type: 'ms-navigation', title: 'new', url: 'https://a.test/new' }, {
    id: 'extid', frameId: 0, url: 'https://a.test/old', tab: { id: 7, url: 'https://a.test/old' },
  }, function (r) { response = r; });
  eq(response && response.ok, true, 'trusted same-origin navigation accepted');
  eq(state.pageMeta.get(7).url, 'https://a.test/new', 'SPA route stored as page identity');
  eq(state.itemsByTab.has(7), false, 'stale tab media cleared on navigation');
  eq(persistCalls, 1, 'navigation cleanup persisted');
  eq(badgeTab, 7, 'navigation cleanup updates badge');

  state.itemsByTab.set(7, [{ pageUrl: 'https://a.test/new', url: 'https://cdn.test/new.mp4' }]);
  response = null;
  listeners[0]({ type: 'ms-navigation', title: 'evil', url: 'https://evil.test/hijack' }, {
    id: 'extid', frameId: 0, url: 'https://a.test/old', tab: { id: 7, url: 'https://a.test/old' },
  }, function (r) { response = r; });
  eq(response && response.ok, false, 'cross-origin navigation claim rejected');
  eq(state.itemsByTab.has(7), true, 'rejected claim cannot clear tab media');

  // A real document navigation must reset the old page immediately. The
  // reinjection itself is asynchronous, but the reset is synchronous with the
  // trusted tabs.onUpdated URL signal.
  eq(tabUpdatedListeners.length, 1, 'full-navigation listener registered');
  tabUpdatedListeners[0](7, { url: 'https://a.test/full-page' }, { id: 7, title: 'full page', url: 'https://a.test/full-page' });
  eq(state.pageMeta.get(7).url, 'https://a.test/full-page', 'full navigation stores new page identity');
  eq(state.itemsByTab.has(7), false, 'full navigation clears stale media immediately');
}

report('navigation-refresh');
