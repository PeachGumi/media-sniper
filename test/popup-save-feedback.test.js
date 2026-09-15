'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { eq, ok, report } = require('./harness.js');
const L = require('../src/logic.js');

const popupSrc = fs.readFileSync(path.join(__dirname, '..', 'popup', 'popup.js'), 'utf8');

function makeElement(tag, id) {
  const listeners = {};
  const classes = new Set();
  let textValue = '';
  const el = {
    tagName: String(tag).toUpperCase(), id: id || '', children: [], dataset: {}, value: '',
    title: '', className: '', disabled: false,
    classList: {
      add: function (name) { classes.add(name); el.className = Array.from(classes).join(' '); },
      remove: function (name) { classes.delete(name); el.className = Array.from(classes).join(' '); },
      contains: function (name) { return classes.has(name); },
    },
    appendChild: function (child) { el.children.push(child); child.parentElement = el; return child; },
    addEventListener: function (type, fn) { listeners[type] = fn; },
    dispatch: function (type) { if (listeners[type]) listeners[type]({ target: el, preventDefault: function () {} }); },
    setAttribute: function (name, value) { el[name] = String(value); },
    removeAttribute: function (name) { delete el[name]; },
    getAttribute: function (name) { return el[name]; },
    __listeners: listeners,
  };
  Object.defineProperty(el, 'textContent', {
    get: function () { return textValue; },
    set: function (value) { textValue = String(value); if (value === '') el.children = []; },
  });
  return el;
}

function flush() { return new Promise(function (resolve) { setImmediate(resolve); }); }
function allText(el) { return (el.textContent || '') + (el.children || []).map(allText).join(''); }

(async function () {
  const ids = ['status', 'count', 'list', 'mediaTab', 'jobsTab', 'mediaPanel', 'jobsPanel', 'jobsList', 'jobsCount', 'rescan', 'saveall', 'clear', 'ytdlp', 'options', 'destHint', 'accessSite', 'accessAll', 'accessClick', 'accessStatus'];
  const elements = {};
  ids.forEach(function (id) { elements[id] = makeElement('div', id); });
  const item = { key: 'direct-1', url: 'https://cdn.example/video.mp4', kind: 'video', title: 'Direct video', size: 900000 };
  const hlsItem = { key: 'hls-1', url: 'https://cdn.example/master.m3u8', kind: 'hls', title: 'HLS video' };
  const ytItem = { key: 'yt-1', url: 'https://rr.example.googlevideo.com/video', audioUrl: 'https://rr.example.googlevideo.com/audio', kind: 'video', via: 'youtube', title: 'YouTube video' };
  const intervals = [];
  let now = 1000;
  let downloadCallback = null;
  let hlsCallback = null;
  let ytCallback = null;
  let stopCallback = null;
  let hlsState = null;
  let holdHlsStatus = false;
  const pendingHlsStatus = [];
  let queueState = { id: 'queue-1', status: 'queued', filename: 'Direct video.mp4' };
  let jobsState = [{ id: 'foreign-job', type: 'download', status: 'started', tabId: 77, title: 'Other tab video', receivedBytes: 1024, totalBytes: 4096 }];
  let holdJobs = false;
  const jobCallbacks = [];

  const chrome = {
    runtime: {
      lastError: null,
      sendMessage: function (message, callback) {
        if (message.type === 'ms-get-settings') callback({ rootFolder: '', minSizeKb: 500, blacklist: '' });
        else if (message.type === 'ms-get-items') callback({ items: [item, hlsItem, ytItem] });
        else if (message.type === 'ms-get-jobs') {
          if (holdJobs) jobCallbacks.push(callback);
          else callback({ jobs: jobsState });
        }
        else if (message.type === 'ms-download') downloadCallback = callback;
        else if (message.type === 'ms-hls-download') hlsCallback = callback;
        else if (message.type === 'ms-yt-mux-download') ytCallback = callback;
        else if (message.type === 'ms-hls-stop') stopCallback = callback;
        else if (message.type === 'ms-hls-status') {
          if (holdHlsStatus) pendingHlsStatus.push(callback);
          else callback(hlsState);
        }
        else if (message.type === 'ms-queue-status') callback({ queue: [queueState] });
        else if (callback) callback({ ok: true });
      },
      openOptionsPage: function () {},
    },
    tabs: {
      query: function (_query, callback) { callback([{ id: 1, url: 'https://site.example/watch' }]); },
      sendMessage: function (_id, _message, callback) { if (callback) callback({ ok: true }); },
    },
  };
  const document = {
    readyState: 'complete',
    querySelector: function (selector) { return selector[0] === '#' ? elements[selector.slice(1)] : null; },
    createElement: function (tag) { return makeElement(tag); },
    addEventListener: function () {},
  };
  const ctx = {
    chrome, document, console, URL, Promise, Date: { now: function () { return now; } }, Math,
    setTimeout: function () {},
    setInterval: function (fn) { intervals.push(fn); return intervals.length; },
    clearInterval: function () {},
    navigator: { clipboard: { writeText: function () { return Promise.resolve(); } } },
    MediaSniperI18n: { t: function (key, subs) { return subs && subs.length ? key + ':' + subs.join('|') : key; } },
    MediaSniperLogic: L,
    globalThis: null,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(popupSrc, ctx);
  await flush();

  eq(elements.jobsList.children.length, 1, 'global jobs render separately from detected media');
  ok(allText(elements.jobsList.children[0]).indexOf('Other tab video') >= 0, 'job from another page tab is visible');
  ok(allText(elements.jobsList.children[0]).indexOf('downloadProgress:25|1.0 KB|4.0 KB') >= 0, 'global job card shows live progress');
  elements.jobsTab.dispatch('click');
  eq(elements.mediaPanel.hidden, true, 'Jobs tab hides the detected-video panel');
  eq(elements.jobsPanel.hidden, false, 'Jobs tab shows the global job panel');
  elements.mediaTab.dispatch('click');

  holdJobs = true;
  ctx.loadJobs();
  ctx.loadJobs();
  jobCallbacks[1]({ jobs: [{ id: 'new-progress', type: 'download', status: 'downloading', title: 'Newest progress', receivedBytes: 3072, totalBytes: 4096 }] });
  jobCallbacks[0]({ jobs: [{ id: 'old-progress', type: 'download', status: 'downloading', title: 'Stale progress', receivedBytes: 1024, totalBytes: 4096 }] });
  ok(allText(elements.jobsList).indexOf('Newest progress') >= 0 && allText(elements.jobsList).indexOf('Stale progress') < 0,
    'late global-job response cannot overwrite newer progress');
  holdJobs = false;

  jobsState = [{ id: 'ffmpeg-job', type: 'media', status: 'combining', mode: 'ffmpeg', tabId: 77,
    title: 'Converting video', seconds: 12, bytes: 2048, startedAt: 1000 }];
  elements.jobsTab.dispatch('click');
  ok(allText(elements.jobsList.children[0]).indexOf('ffmpegProgress:2.0 KB|0s') >= 0,
    'media card and global job use the same FFmpeg conversion status');

  // Before the muxer writes its first byte the job is still fetching segments:
  // the card must show that activity instead of a frozen 0 B.
  jobsState = [{ id: 'ffmpeg-fetching-job', type: 'media', status: 'combining', mode: 'ffmpeg', tabId: 77,
    title: 'Fetching video', bytes: 0, fetches: 9, fetchedBytes: 4194304, startedAt: 1000 }];
  elements.jobsTab.dispatch('click');
  ok(allText(elements.jobsList.children[0]).indexOf('mediaFetchingProgress:9|4.0 MB|0s') >= 0,
    'ffmpeg job without output yet reports the segment fetches it performed');

  jobsState = [{ id: 'failed-job', type: 'media', status: 'failed', tabId: 77,
    title: 'Failed video', error: 'conversion stopped' }];
  elements.jobsTab.dispatch('click');
  ok(allText(elements.jobsList.children[0]).indexOf('failedPrefix:conversion stopped') >= 0,
    'failed jobs remain visible with their final error');

  jobsState = [{ id: 'fallback-job', type: 'download', status: 'fallback', tabId: 77,
    title: 'Authenticated retry' }];
  elements.jobsTab.dispatch('click');
  ok(allText(elements.jobsList.children[0]).indexOf('downloadInProgress') >= 0,
    'authenticated fallback is shown as active instead of waiting in queue');
  elements.mediaTab.dispatch('click');

  const row = elements.list.children[0];
  const info = row.children[1];
  const action = info.children.find(function (child) { return child.className === 'action-status'; });
  const actionProgress = info.children.find(function (child) { return child.className === 'action-progress'; });
  const save = row.children[3];
  ok(!!action, 'each media card has an inline action status');
  ok(!!actionProgress, 'each media card has an inline progress bar');
  eq(actionProgress.hidden, true, 'progress bar is hidden before saving');

  save.dispatch('click');
  eq(save.disabled, true, 'save disables immediately to prevent duplicate starts');
  eq(save.textContent, 'starting', 'save button immediately says starting');
  eq(action.textContent, 'startingDownload', 'card immediately shows that saving started');
  eq(elements.status.textContent, 'startingDownload', 'global status immediately announces saving');
  const activeRow = elements.list.children[0];
  const activeRowCount = elements.list.children.length;
  vm.runInContext('render()', ctx);
  ok(elements.list.children[0] === activeRow, 'rerender keeps the active save button');
  eq(elements.list.children.length, activeRowCount, 'rerender is deferred while a save is active');

  downloadCallback({ id: 'queue-1', queued: true });
  eq(save.textContent, 'queued', 'accepted direct download says queued');
  eq(action.textContent, 'queuedStatus', 'card shows queued state');

  queueState = { id: 'queue-1', status: 'started', filename: 'Direct video.mp4' };
  intervals[0]();
  eq(save.textContent, 'saving', 'started browser download says saving');
  eq(action.textContent, 'downloadInProgress', 'card shows started download as active');

  queueState = { id: 'queue-1', status: 'downloading', filename: 'Direct video.mp4', receivedBytes: 450000, totalBytes: 900000 };
  intervals[0]();
  eq(save.textContent, '50%', 'active browser download shows a real percentage');
  eq(action.textContent, 'downloadProgress:50|439.5 KB|878.9 KB', 'card shows received and total browser bytes');
  eq(actionProgress.value, 450000, 'browser progress bar reflects received bytes');
  eq(actionProgress.max, 900000, 'browser progress bar reflects total bytes');

  queueState = { id: 'queue-1', status: 'failed', filename: 'Direct video.mp4', error: 'NETWORK_FAILED' };
  intervals[0]();
  eq(save.disabled, false, 'failed download re-enables save');
  eq(save.textContent, 'save', 'failed download restores save label');
  eq(action.textContent, 'failedPrefix:NETWORK_FAILED', 'card shows the failure reason');
  ok(action.classList.contains('err'), 'failed card state is visually marked as an error');

  save.dispatch('click');
  downloadCallback({ id: 'queue-1', queued: true });
  queueState = { id: 'queue-1', status: 'complete', filename: 'Direct video.mp4' };
  intervals[1]();
  eq(save.disabled, false, 'completed download re-enables save');
  eq(action.textContent, 'savedFile:Direct video.mp4', 'card confirms the saved filename');
  ok(!action.classList.contains('err'), 'successful retry clears the previous error style');

  save.dispatch('click');
  downloadCallback({ id: 'queue-missing', queued: true });
  queueState = { id: 'some-other-entry', status: 'started', filename: 'Other.mp4' };
  intervals[2]();
  eq(save.disabled, false, 'missing queue entry re-enables save');
  eq(action.textContent, 'jobLost', 'missing queue entry reports a terminal error');
  ok(action.classList.contains('err'), 'missing queue entry is visually marked as an error');

  save.dispatch('click');
  downloadCallback({ id: 'queue-long', queued: true });
  queueState = { id: 'queue-long', status: 'queued', filename: 'Long video.mp4' };
  now += 31000;
  intervals[3]();
  queueState = { id: 'queue-long', status: 'complete', filename: 'Long video.mp4' };
  intervals[3]();
  eq(save.disabled, false, 'download completing after 30 seconds still restores save');
  eq(action.textContent, 'savedFile:Long video.mp4', 'long download still reports completion');

  const hlsRow = elements.list.children[1];
  const hlsInfo = hlsRow.children[1];
  const hlsAction = hlsInfo.children.find(function (child) { return child.className === 'action-status'; });
  const hlsSave = hlsRow.children[3];
  hlsSave.dispatch('click');
  eq(hlsSave.textContent, 'starting', 'HLS save also acknowledges the click immediately');
  eq(hlsAction.textContent, 'startingDownload', 'HLS card immediately shows starting state');
  hlsCallback({ queued: true, jobKey: 'hls-job' });
  eq(hlsSave.textContent, 'fetching', 'HLS acknowledgement changes to fetching');
  eq(hlsAction.textContent, 'hlsFetching', 'HLS card shows segment-fetch state');

  hlsState = { status: 'fetching', done: 3, total: 10, bytes: 3145728, elapsedSeconds: 12 };
  intervals[4]();
  eq(hlsSave.textContent, '30%', 'HLS fetch shows segment percentage');
  eq(hlsAction.textContent, 'segmentProgressDetail:3|10|3.0 MB|12s', 'HLS fetch proves activity with segments, bytes, and elapsed time');

  hlsState = { status: 'queued', elapsedSeconds: 7 };
  intervals[4]();
  eq(hlsAction.textContent, 'mediaQueued 7s', 'a job waiting for the converter shows the wait, not a conversion');

  hlsState = { status: 'combining', mode: 'ffmpeg', seconds: 30, bytes: 2097152, elapsedSeconds: 42 };
  intervals[4]();
  eq(hlsSave.textContent, '2.0 MB', 'ffmpeg phase shows produced bytes on the button');
  eq(hlsAction.textContent, 'ffmpegProgress:2.0 MB|42s', 'ffmpeg phase shows produced bytes and elapsed time');

  // The bundled libav build has no ffmpeg out-time API, so "media 0s" was a
  // permanent lie. While the muxer has written nothing, the honest report is
  // the segment fetching ffmpeg already performed.
  hlsState = { status: 'combining', mode: 'ffmpeg', bytes: 0, fetches: 12, fetchedBytes: 5242880, elapsedSeconds: 20 };
  intervals[4]();
  eq(hlsAction.textContent, 'mediaFetchingProgress:12|5.0 MB|20s', 'ffmpeg phase without output reports fetches and bytes fetched');
  eq(hlsSave.textContent, 'processing', 'no produced bytes yet keeps the generic processing label');

  hlsState = { status: 'combining', mode: 'ffmpeg', bytes: 0, fetches: 0, fetchedBytes: 0, elapsedSeconds: 8 };
  intervals[4]();
  eq(hlsAction.textContent, 'fetchingElapsed:8s', 'ffmpeg startup still proves elapsed time');

  hlsState = { status: 'combining', mode: 'concat', done: 3, total: 10, bytes: 3145728, elapsedSeconds: 12 };
  intervals[4]();
  eq(hlsSave.textContent, '30%', 'OPFS segment fetch shows percentage while combining');
  eq(hlsAction.textContent, 'segmentProgressDetail:3|10|3.0 MB|12s', 'OPFS segment fetch keeps byte and elapsed detail');
  hlsState = { status: 'combining', mode: 'concat', done: 10, total: 10, bytes: 10485760, elapsedSeconds: 18 };
  intervals[4]();
  eq(hlsSave.textContent, 'processing', 'completed segment fetch does not claim 100% while muxing still runs');

  hlsState = { status: 'recording', seconds: 3, bytes: 1024 };
  intervals[4]();
  eq(hlsSave.disabled, false, 'recording re-enables the button as a Stop control');
  eq(hlsSave.textContent, 'stop', 'recording changes the control to Stop');

  hlsState = { status: 'downloading' };
  intervals[4]();
  eq(hlsSave.disabled, true, 'leaving recording disables repeat starts during handoff');
  eq(hlsSave.dataset.recording, '', 'leaving recording clears the Stop mode');

  hlsState = { status: 'complete', filename: 'HLS video.mp4' };
  intervals[4]();

  hlsSave.dispatch('click');
  hlsCallback({ recording: true, jobKey: 'live-job' });
  eq(hlsSave.dataset.jobKey, 'live-job', 'recording keeps the accepted variant-specific job key');
  eq(hlsSave.dataset.recording, '1', 'recording response switches to Stop mode atomically');
  eq(hlsSave.disabled, false, 'recording response enables the Stop control');
  eq(hlsSave.textContent, 'stop', 'recording response immediately shows Stop');
  hlsSave.dispatch('click');
  eq(hlsSave.dataset.stopping, '1', 'Stop enters a distinct stopping state');
  const lateStopCallback = stopCallback;
  hlsState = { status: 'recording', seconds: 4, bytes: 2048 };
  intervals[5]();
  eq(hlsSave.disabled, true, 'recording poll cannot re-enable Stop during handoff');
  eq(hlsSave.textContent, 'stopping', 'recording poll preserves the stopping label');
  hlsState = { status: 'downloading' };
  intervals[5]();
  lateStopCallback({ ok: true });
  eq(hlsSave.disabled, true, 'late Stop response cannot re-enable after download handoff');
  eq(hlsSave.textContent, 'saving', 'late Stop response cannot overwrite newer download state');
  hlsState = { status: 'complete', filename: 'Live.mp4' };
  intervals[5]();

  hlsSave.dispatch('click');
  hlsCallback({ recording: true, jobKey: 'live-job-2' });
  hlsSave.dispatch('click');
  const failedStopCallback = stopCallback;
  if (stopCallback) stopCallback(null);
  else ok(false, 'recording response routes the next click to Stop');
  eq(hlsSave.disabled, false, 'failed stop re-enables the Stop control');
  eq(hlsSave.textContent, 'stop', 'failed stop restores the Stop label');
  eq(hlsSave.dataset.stopping, '', 'failed stop clears stopping state');

  hlsSave.dispatch('click');
  const retryStopCallback = stopCallback;
  failedStopCallback({ ok: false });
  eq(hlsSave.disabled, true, 'late response from an earlier Stop cannot override its retry');
  eq(hlsSave.textContent, 'stopping', 'late earlier Stop response preserves retry state');
  if (retryStopCallback) retryStopCallback({ ok: true });
  else ok(false, 'retry still routes through Stop');
  hlsState = null;
  if (intervals[6]) intervals[6]();
  else ok(false, 'retry retains HLS status polling');
  eq(hlsSave.disabled, false, 'lost HLS job re-enables save');
  eq(hlsSave.dataset.recording, '', 'lost HLS job clears stale Stop mode');
  eq(hlsSave.textContent, 'save', 'lost HLS job allows a clean retry');

  hlsSave.dispatch('click');
  hlsCallback({ queued: true, jobKey: 'old-job' });
  holdHlsStatus = true;
  intervals[7]();
  holdHlsStatus = false;
  hlsState = { status: 'complete', filename: 'Old.mp4' };
  intervals[7]();
  hlsSave.dispatch('click');
  hlsCallback({ queued: true, jobKey: 'new-job' });
  pendingHlsStatus[0]({ status: 'failed', error: 'OLD_FAILURE' });
  eq(hlsSave.disabled, true, 'late callback from an old attempt cannot reset a new save');
  eq(hlsSave.dataset.jobKey, 'new-job', 'late callback cannot clear the new job key');
  eq(hlsSave.textContent, 'fetching', 'late callback cannot overwrite the new operation state');

  holdHlsStatus = true;
  intervals[8]();
  intervals[8]();
  holdHlsStatus = false;
  pendingHlsStatus[2]({ status: 'downloading' });
  pendingHlsStatus[1]({ status: 'recording', seconds: 8, bytes: 4096 });
  eq(hlsSave.disabled, true, 'older recording poll cannot follow a newer downloading poll');
  eq(hlsSave.textContent, 'saving', 'out-of-order HLS polls preserve the newest state');

  hlsState = { status: 'complete', filename: 'New.mp4' };
  intervals[8]();
  const ytRow = elements.list.children[2];
  const ytSave = ytRow.children[3];
  const ytAction = ytRow.children[1].children.find(function (child) { return child.className === 'action-status'; });
  ytSave.dispatch('click');
  ytCallback({ queued: true, jobKey: 'yt-mux-job' });
  hlsState = { status: 'complete', filename: 'YouTube video.mp4' };
  intervals[9]();
  eq(ytSave.disabled, false, 'adaptive YouTube completion re-enables save');
  eq(ytAction.textContent, 'savedFile:YouTube video.mp4', 'adaptive YouTube completion is shown');

  save.dispatch('click');
  downloadCallback({ id: 'queue-clear', queued: true });
  vm.runInContext('items = []; render()', ctx);
  queueState = { id: 'queue-clear', status: 'complete', filename: 'Cleared.mp4' };
  intervals[10]();
  await flush();
  eq(elements.list.children.length, 1, 'deferred render replaces stale media rows after completion');
  eq(elements.list.children[0].className, 'empty', 'deferred render shows the updated empty state');

  ctx.testHlsItem = hlsItem;
  vm.runInContext("items = [Object.assign({}, testHlsItem, {url:'https://cdn.example/refreshed.m3u8'})]; activeJobs = [{jobKey:'resumed-job',itemKey:testHlsItem.key,sourceUrl:testHlsItem.url,status:'fetching'}]; render()", ctx);
  const resumedSave = elements.list.children[0].children[3];
  eq(resumedSave.dataset.jobKey, 'resumed-job', 'reopened popup reconnects to the active media job');
  eq(resumedSave.disabled, true, 'reopened popup keeps the active job from being started twice');
  eq(resumedSave.textContent, 'fetching', 'reopened popup immediately shows the active phase');
  ctx.testDashItems = [
    { key: 'dash-video', url: 'https://cdn.example/manifest.mpd', kind: 'dash', dashEntry: 0 },
    { key: 'dash-audio', url: 'https://cdn.example/manifest.mpd', kind: 'dash', dashEntry: 1 },
  ];
  vm.runInContext("activeSaveCount = 0; renderPending = false; items = testDashItems; activeJobs = [{jobKey:'dash-job-video',itemKey:'dash-video',sourceUrl:testDashItems[0].url,status:'fetching'},{jobKey:'dash-job-audio',itemKey:'dash-audio',sourceUrl:testDashItems[1].url,status:'fetching'}]; render()", ctx);
  eq(elements.list.children[0].children[3].dataset.jobKey, 'dash-job-video', 'DASH video reconnects to its own entry-qualified job');
  eq(elements.list.children[1].children[3].dataset.jobKey, 'dash-job-audio', 'DASH audio reconnects to its own entry-qualified job');
  hlsState = { status: 'complete', filename: 'Resumed.mp4' };
  ctx.testDirectItem = item;
  vm.runInContext("activeSaveCount = 0; renderPending = false; items = [testDirectItem]; activeJobs = []; activeDownloads = [{id:'resumed-direct',itemKey:testDirectItem.key,status:'started'}]; render()", ctx);
  const resumedDirectSave = elements.list.children[0].children[3];
  eq(resumedDirectSave.disabled, true, 'reopened popup reconnects to an active direct download');
  eq(resumedDirectSave.textContent, 'saving', 'reopened popup immediately shows direct download activity');

  report('popup-save-feedback');
})().catch(function (error) {
  console.error(error);
  process.exit(1);
});
