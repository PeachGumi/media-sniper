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
}

{
  let persistCalls = 0;
  let badgeTab = null;
  const state = {
    itemsByTab: new Map([[7, [{ pageUrl: 'https://a.test/old', url: 'https://cdn.test/old.mp4' }]]]),
    pageMeta: new Map([[7, { title: 'old', url: 'https://a.test/old' }]]),
  };
  const ctx = {
    URL,
    state,
    persistItems: function () { persistCalls++; },
    updateBadge: function (tabId) { badgeTab = tabId; },
    globalThis: null,
    module: { exports: {} },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  state.pageMeta.set(7, { title: 'new', url: 'https://a.test/new' });
  eq(state.itemsByTab.has(7), false, 'stale tab media cleared on navigation');
  eq(persistCalls, 1, 'navigation cleanup persisted');
  eq(badgeTab, 7, 'navigation cleanup updates badge');
}

report('navigation-refresh');
