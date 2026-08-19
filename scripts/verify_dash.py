#!/usr/bin/env python3
"""E2E: DASH (mpd) track enumeration + one-track-per-job ffmpeg.

dash.mpd has 2 adaptation sets (video + audio) -> 2 items with dashEntry
0/1. Each is saved through the offscreen ffmpeg with -map 0:<entry>
(video additionally maps 0:a:0? -> v+a mux; audio single-stream -> .m4a).
"""
import json, os, subprocess, sys, time, urllib.request

CDP = 'http://127.0.0.1:9222'
DL = os.path.expanduser('~/Downloads')
FIX = 'http://127.0.0.1:8901'
MPD = FIX + '/dash.mpd'

def get_json(path):
    with urllib.request.urlopen(CDP + path, timeout=5) as r:
        return json.loads(r.read().decode())

def main():
    import websockets, asyncio

    async def run():
        page = next(t for t in get_json('/json') if t.get('type') == 'page')
        ws_p = await websockets.connect(page['webSocketDebuggerUrl'], max_size=50_000_000)
        await ws_p.send(json.dumps({'id': 1, 'method': 'Runtime.enable'}))
        await ws_p.send(json.dumps({'id': 2, 'method': 'Page.enable'}))
        await ws_p.send(json.dumps({'id': 3, 'method': 'Page.navigate', 'params': {'url': FIX + '/index.html'}}))
        await asyncio.sleep(2)

        sw = None
        t0 = time.time()
        while time.time() - t0 < 15 and not sw:
            sw = next((t for t in get_json('/json')
                       if t.get('type') == 'service_worker' and 'chrome-extension://' in (t.get('url') or '')), None)
            await asyncio.sleep(0.4)
        if not sw:
            print('FAIL: SW not found'); sys.exit(1)
        ws_sw = await websockets.connect(sw['webSocketDebuggerUrl'], max_size=50_000_000)
        eid = [0]

        async def sw_eval(expr, timeout=30):
            eid[0] += 1
            await ws_sw.send(json.dumps({'id': eid[0], 'method': 'Runtime.evaluate',
                'params': {'expression': expr, 'returnByValue': True, 'awaitPromise': True}}))
            end = time.time() + timeout
            while time.time() < end:
                try:
                    msg = json.loads(await asyncio.wait_for(ws_sw.recv(), timeout=1))
                except asyncio.TimeoutError:
                    continue
                if msg.get('id') == eid[0]:
                    return msg.get('result', {}).get('result', {}).get('value')
            raise TimeoutError('sw_eval')

        tabid = await sw_eval("Array.from(state.itemsByTab.keys())[0] ?? -1")

        # detection: fire the webRequest event for the mpd
        await sw_eval("""
          onResponseStarted({
            statusCode: 200, tabId: """ + str(tabid) + """, initiator: 'https://site.example.com',
            url: '""" + MPD + """',
            responseHeaders: [{ name: 'Content-Type', value: 'application/dash+xml' }]
          }); true
        """)
        await asyncio.sleep(2)
        items_raw = await sw_eval("""
          (() => {
            const out = [];
            state.itemsByTab.forEach((its) => its.forEach(i => out.push({
              url: i.url.slice(0, 200), kind: i.kind, dashEntry: i.dashEntry,
              dashType: i.dashType, title: i.title
            })));
            return JSON.stringify(out);
          })()
        """)
        items = json.loads(items_raw or '[]')
        print('items:', json.dumps(items, ensure_ascii=False))
        dash_items = sorted([i for i in items if 'dash.mpd' in i['url']], key=lambda x: x.get('dashEntry'))
        ok_det = (len(dash_items) == 2
                  and dash_items[0]['dashEntry'] == 0 and dash_items[0]['dashType'] == 'video'
                  and dash_items[1]['dashEntry'] == 1 and dash_items[1]['dashType'] == 'audio')
        print('DASH DETECTION (2 tracks):', 'PASS' if ok_det else 'FAIL')
        if not ok_det:
            sys.exit(1)

        results = {}
        for entry, typ, title in ((0, 'video', 'ff e2e dash video'), (1, 'audio', 'ff e2e dash audio')):
            jobkey = MPD + '#dash-entry=' + str(entry)
            resp = await sw_eval(
                "startHls(" + str(tabid) + ", '" + jobkey + "', '" + MPD + "', '" + title + "', '" + FIX + "/', " + str(entry) + ", '" + typ + "').then(function(r){return JSON.stringify(r)})", timeout=180)
            print('startHls', typ, 'resp:', resp)
            st = None
            t0 = time.time()
            while time.time() - t0 < 180:
                st = await sw_eval("(function(){var j=state.hlsJobs.get('" + jobkey + "');return j?JSON.stringify({status:j.status,error:j.error,size:j.size,ext:j.ext}):null})()")
                if st:
                    obj = json.loads(st)
                    print(' ', typ, 'job:', obj)
                    if obj['status'] in ('downloading', 'complete', 'failed'):
                        break
                await asyncio.sleep(2)
            obj = json.loads(st) if st else {}
            if obj.get('status') not in ('downloading', 'complete'):
                print('DASH ' + typ.upper() + ': FAIL -', obj.get('error') or st)
                sys.exit(1)
            target = None
            t0 = time.time()
            while time.time() - t0 < 60:
                q = await sw_eval("chrome.downloads.search({}).then(function(d){var m=d.filter(function(i){return i.filename&&i.filename.indexOf('" + title + "')>=0}).sort(function(a,b){return b.id-a.id});return m.length?JSON.stringify({state:m[0].state,bytes:m[0].bytesReceived,file:m[0].filename}):null})")
                if q:
                    rec = json.loads(q)
                    print(' ', typ, 'download:', rec['state'], rec['bytes'], os.path.basename(rec['file']))
                    if rec['state'] == 'complete':
                        target = rec['file']
                        for _ in range(30):
                            if os.path.exists(target) and os.path.getsize(target) == rec['bytes']:
                                break
                            await asyncio.sleep(0.3)
                        break
                    if rec['state'] == 'interrupted':
                        print('DASH ' + typ.upper() + ': FAIL interrupted'); sys.exit(1)
                await asyncio.sleep(2)
            if not target:
                print('DASH ' + typ.upper() + ': FAIL - no file'); sys.exit(1)
            size = os.path.getsize(target)
            probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type',
                                    '-show_entries', 'format=format_name,duration',
                                    '-of', 'default=nw=1', target], capture_output=True, text=True).stdout.strip()
            print('DASH', typ, 'file:', target, size, 'bytes')
            print('probe:', probe.replace('\n', ' | '))
            if typ == 'video':
                ok = (target.endswith('.mp4') and size > 50000 and 'mp4' in probe
                      and 'duration=3.0' in probe.replace(' ', '')
                      and 'codec_type=video' in probe and 'codec_type=audio' in probe)
                print('  (video track expected: h264 + aac muxed, ~3.0s)')
            else:
                ok = (target.endswith('.m4a') and size > 5000 and 'mp4' in probe
                      and 'duration=3.0' in probe.replace(' ', '')
                      and 'codec_type=audio' in probe and 'codec_type=video' not in probe)
                print('  (audio track expected: aac only, ~3.0s)')
            print('DASH ' + typ.upper() + ' DOWNLOAD:', 'PASS' if ok else 'FAIL')
            if not ok:
                sys.exit(1)
            results[typ] = target

        for f in results.values():
            try: os.remove(f)
            except OSError: pass
        await ws_sw.close(); await ws_p.close()
        print('ALL DASH E2E PASS')

    asyncio.run(run())

if __name__ == '__main__':
    main()
