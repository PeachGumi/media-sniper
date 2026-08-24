'use strict';
const { eq, ok, report } = require('./harness.js');
const I = require('../src/install.js');

let opened = null;
const fakeChrome = {
  runtime: {
    getURL: function (p) { return 'chrome-extension://extid/' + p; },
  },
  tabs: {
    create: function (opts) { opened = opts; return Promise.resolve({ id: 1 }); },
  },
};

eq(I.openInstallDisclosure({ reason: 'update' }, fakeChrome), false, 'update does not open disclosure');
eq(opened, null, 'no tab opened for update');
eq(I.openInstallDisclosure({ reason: 'install' }, fakeChrome), true, 'install opens disclosure');
ok(opened && /popup\/onboarding\.html$/.test(opened.url), 'onboarding URL opened');

report('install');
