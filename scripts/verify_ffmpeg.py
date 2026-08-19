#!/usr/bin/env python3
"""E2E: ffmpeg pipeline (v0.7). Real headless Brave + real libav.js WASM.
1) VOD TS HLS -> ffmpeg remux -> real .mp4 in ~/Downloads
2) live playlist -> recording state -> stop -> playable partial .mp4
"""
import json, os, subprocess, sys, time, urllib.request

CDP = 'http://127.0.0.1:9222'
DL = os.path.expanduser('~/Downloads')
FIX = 'http://127.0.0.1:8901'

def get_json(path):
    with urllib.request.urlopen(CDP + path, timeout=5) as r:
        return json.loads(r.read().decode())

def ffprobe(path):
    try:
        out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=format_name,duration',
                              '-of', 'default=nw=1', path], capture_output=True, text=True, timeout=30)
        return out.stdout.strip()
    except Exception as e:
        return 'probe error: ' + str(e)

def main():
    import websockets, asyncio

    async def run():
        page = next(t for t in get_json('/json') if t.get('type') == 'page')
        ws_p = await websockets.connect(page['webSocketDebuggerUrl'], max_size=50_000_000)
        eid_p = [100]

        async def page_eval(expr, timeout=30):
            eid_p[0] += 1
            await ws_p.send(json.dumps({'id': eid_p[0], 'method': 'Runtime.evaluate',
                'params': {'expression': expr, 'returnByValue': True, 'awaitPromise': True}}))
            end = time.time() + timeout
            while time.time() < end:
                try:
                    msg = json.loads(await asyncio.wait_for(ws_p.recv(), timeout=1))
                except asyncio.TimeoutError:
                    continue
                if msg.get('id') == eid_p[0]:
                    return msg.get('result', {}).get('result', {}).get('value')
            return None

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
            raise TimeoutError('sw_eval: ' + expr[:80])

        ok_src = await sw_eval("String(runHlsJob).indexOf('offscreenFfmpegRun') >= 0")
        print('SW has ffmpeg pipeline:', ok_src)
        if not ok_src:
            print('ABORT: stale code'); sys.exit(1)

        tabid = await sw_eval("Array.from(state.itemsByTab.keys())[0] ?? -1")

        # ---- TEST 1: VOD TS playlist -> ffmpeg remux -> mp4 --------------------
        print('\n--- TEST 1: VOD HLS -> mp4 (ffmpeg remux) ---')
        vod_url = FIX + '/realindex.m3u8'
        resp = await sw_eval("startHls(" + str(tabid) + ", '" + vod_url + "', '" + vod_url + "', 'ff e2e vod', '" + FIX + "/', null, null).then(function(r){return JSON.stringify(r)})")
        print('startHls resp:', resp)
        st = None
        t0 = time.time()
        while time.time() - t0 < 180:
            st = await sw_eval("(function(){var j=state.hlsJobs.get('" + vod_url + "');return j?JSON.stringify({status:j.status,error:j.error,blob:(j.blobUrl||'').slice(0,40),size:j.size,mode:j.mode,ext:j.ext}):null})()")
            if st:
                obj = json.loads(st)
                print('  job:', obj)
                if obj['status'] in ('downloading', 'complete', 'failed'):
                    break
            await asyncio.sleep(2)
        obj = json.loads(st) if st else {}
        if obj.get('status') not in ('downloading', 'complete'):
            print('TEST1: FAIL -', obj.get('error') or st)
        else:
            # wait for the blob download to land
            target = None
            t0 = time.time()
            while time.time() - t0 < 60:
                q = await sw_eval("chrome.downloads.search({}).then(function(d){var m=d.filter(function(i){return i.filename&&i.filename.indexOf('ff e2e vod')>=0}).sort(function(a,b){return b.id-a.id});return m.length?JSON.stringify({state:m[0].state,bytes:m[0].bytesReceived,file:m[0].filename}):null})")
                if q:
                    rec = json.loads(q)
                    print('  download:', rec['state'], rec['bytes'], os.path.basename(rec['file']))
                    if rec['state'] == 'complete':
                        target = rec['file']
                        for _ in range(30):
                            if os.path.exists(target) and os.path.getsize(target) == rec['bytes']:
                                break
                            await asyncio.sleep(0.3)
                        break
                    if rec['state'] == 'interrupted':
                        print('TEST1: FAIL interrupted'); break
                await asyncio.sleep(2)
            if target:
                size = os.path.getsize(target)
                probe = ffprobe(target)
                ok1 = target.endswith('.mp4') and size > 100000 and 'mp4' in probe
                print('TEST1 file:', target, size, 'bytes')
                print('TEST1 probe:', probe)
                print('TEST1 VOD remux:', 'PASS' if ok1 else 'FAIL')
                os.remove(target)
            else:
                print('TEST1: FAIL - no file')

        # ---- TEST 2: live playlist -> recording -> stop -> playable partial ----
        print('\n--- TEST 2: live recording -> stop -> partial mp4 ---')
        live_url = FIX + '/liveindex.m3u8'
        resp = await sw_eval("startHls(" + str(tabid) + ", '" + live_url + "', '" + live_url + "', 'ff e2e live', '" + FIX + "/', null, null).then(function(r){return JSON.stringify(r)})")
        print('startHls resp:', resp)
        st = await sw_eval("(function(){var j=state.hlsJobs.get('" + live_url + "');return j?JSON.stringify({status:j.status,live:j.live}):null})()")
        print('status after start:', st)
        ok_rec = st and json.loads(st)['status'] == 'recording'
        print('TEST2 recording state:', 'PASS' if ok_rec else 'FAIL')
        if ok_rec:
            await asyncio.sleep(8)  # record ~8 seconds
            stop = await sw_eval("stopLiveRecording('" + live_url + "').then(function(r){return JSON.stringify(r)})")
            print('stop resp:', stop)
            st = None
            t0 = time.time()
            while time.time() - t0 < 60:
                st = await sw_eval("(function(){var j=state.hlsJobs.get('" + live_url + "');return j?JSON.stringify({status:j.status,error:j.error,ext:j.ext}):null})()")
                if st:
                    obj = json.loads(st)
                    print('  job:', obj)
                    if obj['status'] in ('downloading', 'complete', 'failed'):
                        break
                await asyncio.sleep(2)
            target = None
            t0 = time.time()
            while time.time() - t0 < 60:
                q = await sw_eval("chrome.downloads.search({}).then(function(d){var m=d.filter(function(i){return i.filename&&i.filename.indexOf('ff e2e live')>=0}).sort(function(a,b){return b.id-a.id});return m.length?JSON.stringify({state:m[0].state,bytes:m[0].bytesReceived,file:m[0].filename}):null})")
                if q:
                    rec = json.loads(q)
                    print('  download:', rec['state'], rec['bytes'], os.path.basename(rec['file']))
                    if rec['state'] == 'complete':
                        target = rec['file']
                        for _ in range(30):
                            if os.path.exists(target) and os.path.getsize(target) == rec['bytes']:
                                break
                            await asyncio.sleep(0.3)
                        break
                    if rec['state'] == 'interrupted':
                        print('TEST2: FAIL interrupted'); break
                await asyncio.sleep(2)
            if target and os.path.exists(target):
                size = os.path.getsize(target)
                probe = ffprobe(target)
                ok2 = size > 5000 and ('mp4' in probe or 'mov' in probe)
                print('TEST2 file:', target, size, 'bytes')
                print('TEST2 probe:', probe)
                print('TEST2 live record:', 'PASS' if ok2 else 'FAIL')
                os.remove(target)
            else:
                print('TEST2: FAIL - no file')

        await ws_sw.close(); await ws_p.close()

    asyncio.run(run())

if __name__ == '__main__':
    main()
