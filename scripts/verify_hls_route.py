#!/usr/bin/env python3
"""HLS blob filename routing check on the FRESH instance (no reload).
Dumps dffLog to see if onDeterminingFilename fires for blob downloads."""
import json, os, sys, time, urllib.request

CDP = 'http://127.0.0.1:9222'
DL = os.path.expanduser('~/Downloads')
FIX = 'http://127.0.0.1:8901'

def get_json(path):
    with urllib.request.urlopen(CDP + path, timeout=5) as r:
        return json.loads(r.read().decode())

import websockets, asyncio

async def run():
    ver = get_json('/json/version')
    ws_b = await websockets.connect(ver['webSocketDebuggerUrl'], max_size=50_000_000)
    await ws_b.send(json.dumps({'id': 1, 'method': 'Browser.setDownloadBehavior',
        'params': {'behavior': 'allow', 'downloadPath': DL, 'eventsEnabled': True}}))
    await asyncio.wait_for(ws_b.recv(), 5)

    page = next(t for t in get_json('/json') if t.get('type') == 'page')
    ws_p = await websockets.connect(page['webSocketDebuggerUrl'], max_size=50_000_000)
    await ws_p.send(json.dumps({'id': 1, 'method': 'Page.enable'}))
    await ws_p.send(json.dumps({'id': 2, 'method': 'Page.navigate', 'params': {'url': FIX + '/index.html'}}))

    sw = None
    t0 = time.time()
    while time.time() - t0 < 20 and not sw:
        sw = next((t for t in get_json('/json') if t.get('type') == 'service_worker' and 'chrome-extension://' in t.get('url', '')), None)
        await asyncio.sleep(0.5)
    if not sw:
        print('SW: MISSING')
        sys.exit(1)
    print('SW:', sw['url'])
    ws_sw = await websockets.connect(sw['webSocketDebuggerUrl'], max_size=50_000_000)
    eid = [0]

    async def sw_eval(expr, timeout=20):
        eid[0] += 1
        await ws_sw.send(json.dumps({'id': eid[0], 'method': 'Runtime.evaluate', 'params': {'expression': expr, 'returnByValue': True, 'awaitPromise': True}}))
        end = time.time() + timeout
        while time.time() < end:
            try:
                msg = json.loads(await asyncio.wait_for(ws_sw.recv(), timeout=1))
            except asyncio.TimeoutError:
                continue
            if msg.get('id') == eid[0]:
                r = msg.get('result', {}).get('result', {})
                return r.get('value', r.get('description'))
        raise TimeoutError(expr[:60])

    await sw_eval("state.dffLog = []")
    # check what listener machinery looks like on this Brave version
    probe = await sw_eval("JSON.stringify({hasODF: !!chrome.downloads.onDeterminingFilename, hasListenerFn: typeof chrome.downloads.onDeterminingFilename.addListener})")
    print('probe:', probe)

    out = DL + '/e2e hls.ts'
    if os.path.exists(out):
        os.remove(out)
    h = await sw_eval("startHls(9002, '" + FIX + "/master.m3u8', 'e2e hls', '" + FIX + "/').then(function(r){return JSON.stringify(r)})")
    print('startHls:', h)
    st = None
    t0 = time.time()
    while time.time() - t0 < 40:
        st = await sw_eval("(function(){var j=state.hlsJobs.get('" + FIX + "/master.m3u8');return j?JSON.stringify({status:j.status,done:j.done,total:j.total,error:j.error}):null})()")
        if st and json.loads(st)['status'] in ('downloading', 'failed'):
            break
        await asyncio.sleep(0.6)
    print('job:', st)
    await asyncio.sleep(4)
    log = await sw_eval("JSON.stringify(state.dffLog||[])")
    print('dffLog:', log)
    lst = await sw_eval("JSON.stringify({blobKeys:Array.from(state.blobFilenames.keys()), hasListener: chrome.downloads.onDeterminingFilename.hasListener(onDeterminingFilename)})")
    print('after:', lst)
    rec = await sw_eval("chrome.downloads.search({}).then(function(i){return JSON.stringify(i.filter(function(x){return x.url.indexOf('blob:')===0}).map(function(x){return {state:x.state,fileName:x.filename,bytes:x.bytesReceived,error:x.error}}))})")
    print('blob downloads:', rec)
    print('file exists:', os.path.exists(out), os.path.getsize(out) if os.path.exists(out) else None)
    await ws_sw.close()
    await ws_p.close()
    await ws_b.close()

asyncio.run(run())
