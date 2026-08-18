#!/usr/bin/env python3
"""E2E: verify downloads actually land in ~/Downloads (headless + CDP).
Tests: (1) direct mp4 download via queue, (2) full HLS pipeline (SW fetch +
offscreen blob + filename routing)."""
import json, os, sys, time, urllib.request

CDP = 'http://127.0.0.1:9222'
DL = os.path.expanduser('~/Downloads')
FIX = 'http://127.0.0.1:8901'

def get_json(path):
    with urllib.request.urlopen(CDP + path, timeout=5) as r:
        return json.loads(r.read().decode())

def main():
    import websockets, asyncio

    async def run():
        # NOTE: deliberately NO Browser.setDownloadBehavior — it overrides the
        # extension's filename option. The test profile's Preferences
        # (prompt_for_download=false, default_directory=~/Downloads) are enough
        # for headless downloads to complete.
        # wake SW via fixture page
        page = next(t for t in get_json('/json') if t.get('type') == 'page')
        ws_p = await websockets.connect(page['webSocketDebuggerUrl'], max_size=50_000_000)
        await ws_p.send(json.dumps({'id': 1, 'method': 'Page.enable'}))
        await ws_p.send(json.dumps({'id': 2, 'method': 'Page.navigate', 'params': {'url': FIX + '/index.html'}}))
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

        async def sw_eval(expr, timeout=15):
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
                    res = msg.get('result', {}).get('result', {})
                    if res.get('type') == 'undefined':
                        return None
                    return res.get('value', res.get('description'))
            raise TimeoutError('sw_eval: ' + expr[:80])

        async def poll_download(name_part, timeout=45):
            t0 = time.time()
            last = None
            while time.time() - t0 < timeout:
                q = await sw_eval(
                    "chrome.downloads.search({}).then(function(items){return JSON.stringify(items.filter(function(i){return i.filename && i.filename.indexOf('" + name_part + "')>=0;}).sort(function(a,b){return b.id-a.id;}).map(function(i){return {url:i.url,state:i.state,bytes:i.bytesReceived,fileName:i.filename,error:i.error}}))})")
                try:
                    arr = json.loads(q) if q else []
                except Exception:
                    arr = []
                if arr:
                    last = arr[0]
                    if arr[0]['state'] == 'complete':
                        return arr[0]
                    if arr[0]['state'] == 'interrupted':
                        return arr[0]
                await asyncio.sleep(0.7)
            return last

        # ---------- TEST 1: direct mp4 via queue ----------
        clip = DL + '/e2e clip.mp4'
        if os.path.exists(clip): os.remove(clip)
        q = await sw_eval(
            "JSON.stringify((function(){var e=enqueue(normalizeItem({url:'" + FIX + "/clip.mp4',contentType:'video/mp4',size:4108,title:'e2e clip'},9001));return {id:e.id,filename:e.filename}})())")
        print('TEST1 enqueue:', q)
        d1 = await poll_download('e2e clip')
        print('TEST1 download record:', json.dumps(d1, ensure_ascii=False) if d1 else None)
        # allow a beat for the OS to finalize the file after state=complete
        for _ in range(20):
            if os.path.exists(clip) and os.path.getsize(clip) == 4108:
                break
            await asyncio.sleep(0.25)
        ok1 = d1 and d1['state'] == 'complete' and os.path.exists(clip) and os.path.getsize(clip) == 4108
        print('TEST1 direct mp4:', 'PASS' if ok1 else 'FAIL')

        # ---------- TEST 2: full HLS pipeline ----------
        hls_out = DL + '/e2e hls.ts'
        if os.path.exists(hls_out): os.remove(hls_out)
        h = await sw_eval(
            "startHls(9002, '" + FIX + "/master.m3u8', 'e2e hls', '" + FIX + "/').then(function(r){return JSON.stringify(r)})")
        print('TEST2 startHls resp:', h)
        # wait for job to reach downloading
        t0 = time.time()
        st = None
        while time.time() - t0 < 45:
            st = await sw_eval(
                "(function(){var j=state.hlsJobs.get('" + FIX + "/master.m3u8');return j?JSON.stringify({status:j.status,done:j.done,total:j.total,error:j.error,blobUrl:j.blobUrl}):null})()")
            if st:
                obj = json.loads(st)
                if obj['status'] in ('downloading', 'failed'):
                    break
            await asyncio.sleep(0.7)
        print('TEST2 job state:', st)
        obj = json.loads(st) if st else {}
        if obj.get('status') == 'failed':
            print('TEST2 HLS pipeline: FAIL -', obj.get('error'))
        else:
            d2 = await poll_download('e2e hls', timeout=45)
            print('TEST2 download record:', json.dumps(d2, ensure_ascii=False) if d2 else None)
            landed = os.path.exists(hls_out)
            size = os.path.getsize(hls_out) if landed else 0
            ok2 = landed and size == 120  # 8 segments x ~15 bytes combined = 120 in fixture
            print('TEST2 HLS ->', hls_out, size, 'bytes:', 'PASS' if ok2 else 'FAIL')
            if not ok2:
                # list what appeared
                print('  files matching e2e:', [f for f in os.listdir(DL) if 'e2e' in f])

        await ws_sw.close(); await ws_p.close()

    asyncio.run(run())

if __name__ == '__main__':
    main()
