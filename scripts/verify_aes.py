#!/usr/bin/env python3
"""E2E: AES-128 encrypted HLS -> ffmpeg decrypts + remuxes -> .mp4"""
import json, os, subprocess, sys, time, urllib.request

CDP = 'http://127.0.0.1:9222'
DL = os.path.expanduser('~/Downloads')
FIX = 'http://127.0.0.1:8901'
ENC = FIX + '/encindex.m3u8'

def get_json(path):
    with urllib.request.urlopen(CDP + path, timeout=5) as r:
        return json.loads(r.read().decode())

def main():
    import websockets, asyncio

    async def run():
        page = next(t for t in get_json('/json') if t.get('type') == 'page')
        ws_p = await websockets.connect(page['webSocketDebuggerUrl'], max_size=50_000_000)
        eid_p = [100]
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
        resp = await sw_eval("startHls(" + str(tabid) + ", '" + ENC + "', '" + ENC + "', 'ff e2e aes', '" + FIX + "/', null, null).then(function(r){return JSON.stringify(r)})")
        print('startHls resp:', resp)
        st = None
        t0 = time.time()
        while time.time() - t0 < 180:
            st = await sw_eval("(function(){var j=state.hlsJobs.get('" + ENC + "');return j?JSON.stringify({status:j.status,error:j.error,size:j.size}):null})()")
            if st:
                obj = json.loads(st)
                print('  job:', obj)
                if obj['status'] in ('downloading', 'complete', 'failed'):
                    break
            await asyncio.sleep(2)
        obj = json.loads(st) if st else {}
        if obj.get('status') not in ('downloading', 'complete'):
            print('AES E2E: FAIL -', obj.get('error') or st)
            sys.exit(1)
        target = None
        t0 = time.time()
        while time.time() - t0 < 60:
            q = await sw_eval("chrome.downloads.search({}).then(function(d){var m=d.filter(function(i){return i.filename&&i.filename.indexOf('ff e2e aes')>=0}).sort(function(a,b){return b.id-a.id});return m.length?JSON.stringify({state:m[0].state,bytes:m[0].bytesReceived,file:m[0].filename}):null})")
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
                    print('AES E2E: FAIL interrupted'); sys.exit(1)
            await asyncio.sleep(2)
        if not target:
            print('AES E2E: FAIL - no file'); sys.exit(1)
        size = os.path.getsize(target)
        probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=format_name,duration',
                                '-of', 'default=nw=1', target], capture_output=True, text=True).stdout.strip()
        print('AES file:', target, size, 'bytes')
        print('probe:', probe)
        ok = target.endswith('.mp4') and size > 100000 and 'mp4' in probe and '2.0' in probe
        print('AES-128 DECRYPT+REMUX:', 'PASS' if ok else 'FAIL')
        os.remove(target)
        await ws_sw.close(); await ws_p.close()

    asyncio.run(run())

if __name__ == '__main__':
    main()
