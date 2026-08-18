#!/usr/bin/env python3
"""Probe gvideo fetch from the PAGE world (youtube.com tab context) vs SW.
The signed URL may only validate with the page's cookie/origin context."""
import json, sys, time, urllib.request

CDP = 'http://127.0.0.1:9222'

def get_json(path):
    with urllib.request.urlopen(CDP + path, timeout=5) as r:
        return json.loads(r.read().decode())

import websockets, asyncio

async def run():
    sw = next((t for t in get_json('/json') if t.get('type') == 'service_worker' and 'chrome-extension://' in t.get('url', '')), None)
    if not sw:
        print('SW_MISSING'); sys.exit(1)
    page = next((t for t in get_json('/json') if t.get('type') == 'page' and 'youtube.com' in t.get('url', '')), None)
    if not page:
        print('NO_YT_PAGE'); sys.exit(1)

    ws_sw = await websockets.connect(sw['webSocketDebuggerUrl'], max_size=50_000_000)
    eid = [0]

    async def sw_eval(expr, timeout=30):
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

    tabs = json.loads(await sw_eval("chrome.tabs.query({}).then(function(t){return JSON.stringify(t.map(function(x){return {id:x.id,url:x.url}}))})"))
    yt_tab = next((t for t in tabs if 'youtube.com' in (t.get('url') or '')), None)
    item = json.loads(await sw_eval("(function(){var items=state.itemsByTab.get(" + str(yt_tab['id']) + ")||[];var it=items.find(function(i){return i.via==='youtube'&&i.kind==='video'});return JSON.stringify(it||null)})()"))
    url = item['url']
    await ws_sw.close()

    # now fetch from the PAGE world
    ws_p = await websockets.connect(page['webSocketDebuggerUrl'], max_size=50_000_000)
    eid2 = [0]

    async def page_eval(expr, timeout=40):
        eid2[0] += 1
        await ws_p.send(json.dumps({'id': eid2[0], 'method': 'Runtime.evaluate', 'params': {'expression': expr, 'returnByValue': True, 'awaitPromise': True}}))
        end = time.time() + timeout
        while time.time() < end:
            try:
                msg = json.loads(await asyncio.wait_for(ws_p.recv(), timeout=1))
            except asyncio.TimeoutError:
                continue
            if msg.get('id') == eid2[0]:
                r = msg.get('result', {})
                if 'exceptionDetails' in r:
                    return 'EXC: ' + json.dumps(r['exceptionDetails'])[:300]
                res = r.get('result', {})
                return res.get('value', res.get('description'))
        return None

    print('probe url:', url[:90])
    r1 = await page_eval("fetch('" + url + "').then(function(r){return 'page plain: '+r.status+' len='+(r.headers.get('content-length')||'?')}).catch(function(e){return 'page plain EXC: '+e})")
    print(r1)
    r2 = await page_eval("fetch('" + url + "', {credentials:'include'}).then(function(r){return 'page creds: '+r.status+' len='+(r.headers.get('content-length')||'?')}).catch(function(e){return 'page creds EXC: '+e})")
    print(r2)
    await ws_p.close()

asyncio.run(run())
