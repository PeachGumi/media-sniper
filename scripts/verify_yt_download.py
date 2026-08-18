#!/usr/bin/env python3
"""Queue the detected YouTube item and verify bytes actually flow, then cancel."""
import json, sys, time, urllib.request

CDP = 'http://127.0.0.1:9222'

def get_json(path):
    with urllib.request.urlopen(CDP + path, timeout=5) as r:
        return json.loads(r.read().decode())

import websockets, asyncio

async def run():
    sw = next((t for t in get_json('/json') if t.get('type') == 'service_worker' and 'chrome-extension://' in t.get('url', '')), None)
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
        return None

    # find the youtube tab + its 360p item
    tabs = json.loads(await sw_eval("chrome.tabs.query({}).then(function(t){return JSON.stringify(t.map(function(x){return {id:x.id,url:x.url}}))})"))
    yt_tab = next((t for t in tabs if 'youtube.com' in (t.get('url') or '')), None)
    if not yt_tab:
        print('no youtube tab'); sys.exit(1)
    item = json.loads(await sw_eval("(function(){var items=state.itemsByTab.get(" + str(yt_tab['id']) + ")||[];var it=items.find(function(i){return i.via==='youtube'&&i.kind==='video'&&i.title.indexOf('360p')>=0;});return JSON.stringify(it||null)})()"))
    if not item:
        print('no 360p item'); sys.exit(1)
    print('enqueueing:', item['title'])

    # enqueue via the real message path
    resp = await sw_eval("(function(){var item=state.itemsByTab.get(" + str(yt_tab['id']) + ").find(function(i){return i.via==='youtube'&&i.title.indexOf('360p')>=0;});var e=enqueue(item);return JSON.stringify({id:e.id,filename:e.filename})})()")
    print('enqueued:', resp)

    # poll until bytes flow (or complete)
    saw_bytes = False
    t0 = time.time()
    last = None
    while time.time() - t0 < 40:
        rec = await sw_eval("chrome.downloads.search({}).then(function(i){var x=i.filter(function(d){return d.byExtensionId===chrome.runtime.id}).sort(function(a,b){return b.id-a.id})[0];return x?JSON.stringify({id:x.id,state:x.state,bytes:x.bytesReceived,total:x.totalBytes,fileName:x.filename,error:x.error}):null})")
        if rec:
            last = json.loads(rec)
            if last['bytes'] and last['bytes'] > 0:
                saw_bytes = True
            if last['state'] in ('in_progress', 'complete') and saw_bytes:
                break
            if last['state'] == 'interrupted':
                break
        await asyncio.sleep(1)
    print('download record:', json.dumps(last, ensure_ascii=False) if last else None)

    # cancel + erase to avoid leaving a partial file around
    if last:
        await sw_eval("chrome.downloads.cancel(" + str(last['id']) + ").then(function(){return chrome.downloads.erase({id:" + str(last['id']) + "})}).catch(function(){})")
    await asyncio.sleep(1)

    if saw_bytes and last['state'] != 'interrupted':
        print('\nRESULT: PASS - YouTube format download is receiving bytes; filename:', last['fileName'])
    elif saw_bytes:
        print('\nRESULT: PARTIAL - bytes flowed but download interrupted:', last.get('error'))
    else:
        print('\nRESULT: FAIL - no bytes received')

    await ws_sw.close()

asyncio.run(run())
