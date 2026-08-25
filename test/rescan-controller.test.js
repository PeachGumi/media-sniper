'use strict';
const { eq, report } = require('./harness.js');
const controller = require('../popup/rescan-controller.js');

(async function () {
  {
    let scans = 0;
    let polls = 0;
    const result = await controller.scanWithPolling({
      beforeCount: 2,
      maxPolls: 3,
      intervalMs: 1,
      sendScan: async function () { scans++; },
      refresh: async function () { polls++; return 2; },
      wait: async function () {},
    });
    eq(result, 2, 'no-new-media scan still completes');
    eq(scans, 1, 'scan command sent once');
    eq(polls, 3, 'no-new-media scan stops at max polls');
  }

  {
    let polls = 0;
    const result = await controller.scanWithPolling({
      beforeCount: 1,
      maxPolls: 6,
      intervalMs: 1,
      sendScan: async function () {},
      refresh: async function () { polls++; return polls === 2 ? 3 : 1; },
      wait: async function () {},
    });
    eq(result, 3, 'scan returns updated count');
    eq(polls, 2, 'scan stops early after new media appears');
  }

  {
    let rejected = false;
    try {
      await controller.scanWithPolling({
        beforeCount: 0,
        sendScan: async function () { throw new Error('no receiver'); },
        refresh: async function () { return 0; },
        wait: async function () {},
      });
    } catch (e) { rejected = /no receiver/.test(e.message); }
    eq(rejected, true, 'send failure rejects instead of hanging');
  }

  report('rescan-controller');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
