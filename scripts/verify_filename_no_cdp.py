#!/usr/bin/env python3
"""Isolate: does chrome.downloads.download filename option work WITHOUT CDP
setDownloadBehavior? Headless may cancel, but we learn which mechanism holds."""
import json, os, sys, time, urllib.request

CDP = 'http://127.0.0.1:9222'
DL = os.path.expanduser('~/Downloads')
FIX = 'http://127.0.0.1:8901'

def get_json(path):
    with urllib.request.urlopen(CDP + path, timeout=5) as r:
        return json.loads(r.read().decode())

import websockets, asyncio

async def run():
    # NOTE: deliberately NO Browser.setDownloadBehavior here.
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
        print('SW MISSING'); sys.exit(1)
    ws_sw = await websockets.connect(sw['webSocketDebuggerUrl'], max_size=50_000_000)
    eid = [0]

    async def sw_eval(expr, timeout=25):
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
    target = DL + '/named-direct-test.mp4'
    if os.path.exists(target): os.remove(target)
    # raw chrome.downloads.download with filename option, no queue
    res = await sw_eval("new Promise(function(res){chrome.downloads.download({url:'" + FIX + "/clip.mp4', filename:'named-direct-test.mp4', saveAs:false}, function(id){ res(JSON.stringify({id:id, err: chrome.runtime.lastError && chrome.runtime.lastError.message})) })})")
    print('download() ->', res)
    await asyncio.sleep(4)
    log = await sw_eval("JSON.stringify(state.dffLog||[])")
    print('dffLog:', log)
    rec = await sw_eval("chrome.downloads.search({}).then(function(i){return JSON.stringify(i.filter(function(x){return x.url.indexOf('clip.mp4')>=0}).slice(0,1).map(function(x){return {state:x.state,fileName:x.filename,error:x.error,bytes:x.bytesReceived}}))})")
    print('record:', rec)
    print('named file exists:', os.path.exists(target))
    print('clip.mp4 (basename) exists:', os.path.exists(DL + '/clip.mp4'))
    await ws_sw.close(); await ws_p.close()

asyncio.run(run())
