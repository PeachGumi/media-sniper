'use strict';
/* Settings + folder/blacklist logic tests (v0.10 features). */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { eq, ok, report } = require('./harness.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'logic.js'), 'utf8');
const ctx = { console, URL, Promise };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);
const L = ctx.MediaSniperLogic;

// --- sanitizeRootFolder -----------------------------------------------------
eq(L.sanitizeRootFolder('media-sniper'), 'media-sniper', 'plain folder kept');
eq(L.sanitizeRootFolder('My Videos'), 'My Videos', 'spaces kept');
eq(L.sanitizeRootFolder('a/b\\c'), 'a_b_c', 'slashes flattened');
eq(L.sanitizeRootFolder('..'), '', 'dotdot rejected');
eq(L.sanitizeRootFolder('.'), '', 'dot rejected');
eq(L.sanitizeRootFolder('  '), '', 'whitespace only -> empty');
eq(L.sanitizeRootFolder(''), '', 'empty stays empty');
eq(L.sanitizeRootFolder('con:??*'), 'con____', 'illegal chars replaced');
ok(L.sanitizeRootFolder('x'.repeat(200)).length <= 80, 'long folder trimmed to 80');

// --- filenameForItem with root ---------------------------------------------
const item = { url: 'https://cdn.example.com/v.mp4', kind: 'video', ext: 'mp4', title: 'Clip One' };
eq(L.filenameForItem(item, ''), 'Clip One.mp4', 'no root: flat (back-compat)');
eq(L.filenameForItem(item, 'media-sniper'), 'media-sniper/Clip One.mp4', 'root prefixed');
eq(L.filenameForItem(item, 'a/b'), 'a_b/Clip One.mp4', 'root sanitized before use');
const noTitle = { url: 'https://cdn.example.com/video_abc.mp4', kind: 'video', ext: 'mp4' };
eq(L.filenameForItem(noTitle, 'ms'), 'ms/video_abc.mp4', 'url-segment fallback still works under root');

// --- isBlacklisted -----------------------------------------------------------
eq(L.isBlacklisted('ads.example.com', 'example.com'), true, 'subdomain matches');
eq(L.isBlacklisted('example.com', 'example.com'), true, 'exact host matches');
eq(L.isBlacklisted('notexample.com', 'example.com'), false, 'suffix without dot does not match');
eq(L.isBlacklisted('cdn.tracker.io', 'example.com, tracker.io'), true, 'comma list works');
eq(L.isBlacklisted('a.x.com', 'example.com\nx.com'), true, 'newline list works');
eq(L.isBlacklisted('good.com', ''), false, 'empty list never blocks');
eq(L.isBlacklisted('good.com', null), false, 'null list never blocks');
eq(L.isBlacklisted('', 'x.com'), false, 'no host never blocked');
eq(L.isBlacklisted('sub.X.COM', 'x.com'), true, 'case-insensitive');

// --- itemKey: chunked CDN (googlevideo-style) keys --------------------------
const gvA = 'https://rr3---sn-abcd.googlevideo.com/videoplayback?id=VIDEO_A&itag=137&range=0-1000';
const gvB = 'https://rr3---sn-abcd.googlevideo.com/videoplayback?id=VIDEO_B&itag=137&range=0-2000';
const gvA2 = 'https://rr3---sn-abcd.googlevideo.com/videoplayback?id=VIDEO_A&itag=137&range=5000-9000';
const gvA140 = 'https://rr3---sn-abcd.googlevideo.com/videoplayback?id=VIDEO_A&itag=140&range=0-100';
eq(L.itemKey(gvA) === L.itemKey(gvB), false, 'different videos never share a key');
eq(L.itemKey(gvA) === L.itemKey(gvA2), true, 'range chunks of one track dedupe');
eq(L.itemKey(gvA) === L.itemKey(gvA140), false, 'different itags stay distinct');
eq(L.isBlacklisted('sub.X.COM', 'x.com'), true, 'case-insensitive');

report('logic3');
