#!/usr/bin/env python3
"""Clean-instance probe: does downloads.download({filename}) work for http AND
blob URLs when NO onDeterminingFilename interference exists?
No CDP setDownloadBehavior (that was shown to clobber filenames)."""
import json, os, sys, time, urllib.request

CDP = 'http://127.0.0.1:9222'
DL = os.path.expanduser('~/Downloads')
FIX = 'http://127.0.0.1:8901'

def get_json(path):
    with urllib.request.urlopen(CDP + path, timeout=5) as r:
        return json.loads(r.read().decode())

import websockets, asyncio

async def run():
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
    print('SW:', sw['url'])
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
                if 'exceptionDetails' in msg.get('result', {}):
                    return 'EXC: ' + json.dumps(msg['result']['exceptionDetails'])[:300]
                return r.get('value', r.get('description'))
        raise TimeoutError(expr[:60])

    # confirm no listener is registered (fresh profile)
    probe = await sw_eval("JSON.stringify({listener: chrome.downloads.onDeterminingFilename.hasListener(onDeterminingFilename), blobMap: state.blobFilenames.size})")
    print('probe (listener/blobMap):', probe)

    # --- A) http download with filename option ---
    tgtA = DL + '/probe-http-name.mp4'
    if os.path.exists(tgtA): os.remove(tgtA)
    ra = await sw_eval("new Promise(function(res){chrome.downloads.download({url:'" + FIX + "/clip.mp4', filename:'probe-http-name.mp4', saveAs:false}, function(id){ res(JSON.stringify({id:id, err: chrome.runtime.lastError && chrome.runtime.lastError.message})) })})")
    print('A) http download() ->', ra)
    await asyncio.sleep(3)
    reca = await sw_eval("chrome.downloads.search({}).then(function(i){return JSON.stringify(i.filter(function(x){return x.url.indexOf('clip.mp4')>=0}).slice(0,1).map(function(x){return {state:x.state,fileName:x.filename,error:x.error}}))})")
    print('A) record:', reca)
    print('A) file on disk:', os.path.exists(tgtA))

    # --- B) blob download with filename option (via offscreen blob) ---
    tgtB = DL + '/probe-blob-name.ts'
    if os.path.exists(tgtB): os.remove(tgtB)
    rb = await sw_eval("makeBlobUrl([new Uint8Array([1,2,3,4]).buffer], 'video/mp2t').then(function(m){return new Promise(function(res){chrome.downloads.download({url:m.url, filename:'probe-blob-name.ts', saveAs:false}, function(id){ res(JSON.stringify({id:id, blobUrl:m.url, err: chrome.runtime.lastError && chrome.runtime.lastError.message})) })})})")
    print('B) blob download() ->', rb)
    await asyncio.sleep(4)
    recb = await sw_eval("chrome.downloads.search({}).then(function(i){return JSON.stringify(i.filter(function(x){return x.url.indexOf('blob:')===0}).map(function(x){return {state:x.state,fileName:x.filename,error:x.error,bytes:x.bytesReceived}}))})")
    print('B) blob records:', recb)
    print('B) file on disk:', os.path.exists(tgtB))

    # --- C) rename API probe: does chrome.downloads.rename exist? ---
    rc = await sw_eval("typeof chrome.downloads.rename")
    print('C) chrome.downloads.rename type:', rc)

    await ws_sw.close(); await ws_p.close()

asyncio.run(run())
