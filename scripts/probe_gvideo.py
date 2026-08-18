#!/usr/bin/env python3
"""Wake SW then probe gvideo fetch variants."""
import json, sys, time, urllib.request

CDP = 'http://127.0.0.1:9222'

def get_json(path):
    with urllib.request.urlopen(CDP + path, timeout=5) as r:
        return json.loads(r.read().decode())

import websockets, asyncio

async def run():
    # wake: open a FRESH tab at youtube (re-navigating an already-loaded page
    # generates no network events and won't wake the idle SW)
    try:
        req = urllib.request.Request(CDP + '/json/new?' + urllib.parse.quote('https://www.youtube.com/watch?v=aqz-KE-bpKQ'), method='PUT')
        urllib.request.urlopen(req, timeout=5)
    except Exception as e:
        print('new tab failed:', e)
    sw = None
    t0 = time.time()
    while time.time() - t0 < 20 and not sw:
        sw = next((t for t in get_json('/json') if t.get('type') == 'service_worker' and 'chrome-extension://' in t.get('url', '')), None)
        await asyncio.sleep(0.5)
    if not sw:
        print('SW MISSING after wake'); sys.exit(1)
    ws_sw = await websockets.connect(sw['webSocketDebuggerUrl'], max_size=50_000_000)
    eid = [0]

    async def sw_eval(expr, timeout=40):
        eid[0] += 1
        await ws_sw.send(json.dumps({'id': eid[0], 'method': 'Runtime.evaluate', 'params': {'expression': expr, 'returnByValue': True, 'awaitPromise': True}}))
        end = time.time() + timeout
        while time.time() < end:
            try:
                msg = json.loads(await asyncio.wait_for(ws_sw.recv(), timeout=1))
            except asyncio.TimeoutError:
                continue
            if msg.get('id') == eid[0]:
                r = msg.get('result', {})
                if 'exceptionDetails' in r:
                    return 'EXC: ' + json.dumps(r['exceptionDetails'])[:300]
                res = r.get('result', {})
                return res.get('value', res.get('description'))
        return None

    # wait for adapter items (page reload happened)
    await asyncio.sleep(8)
    tabs = await sw_eval("chrome.tabs.query({}).then(function(t){return JSON.stringify(t.map(function(x){return {id:x.id,url:x.url}}))})")
    tabarr = json.loads(tabs) if tabs else []
    yt_tab = next((t for t in tabarr if 'youtube.com' in (t.get('url') or '')), None)
    if not yt_tab:
        print('no youtube tab'); sys.exit(1)
    await asyncio.sleep(3)
    item = json.loads(await sw_eval("(function(){var items=state.itemsByTab.get(" + str(yt_tab['id']) + ")||[];var it=items.find(function(i){return i.via==='youtube'&&i.kind==='video'});return JSON.stringify(it||null)})()"))
    if not item:
        print('no youtube item yet'); sys.exit(1)
    url = item['url']
    print('probe url:', url[:90], '...')

    r1 = await sw_eval("fetch('" + url + "').then(function(r){return 'plain: '+r.status+' len='+r.headers.get('content-length')}).catch(function(e){return 'plain EXC: '+e})")
    print(r1)
    r2 = await sw_eval("fetch('" + url + "', {credentials:'include'}).then(function(r){return 'creds: '+r.status+' len='+r.headers.get('content-length')}).catch(function(e){return 'creds EXC: '+e})")
    print(r2)
    r3 = await sw_eval("fetch('" + url + "', {credentials:'include', headers:{'Referer':'https://www.youtube.com/'}}).then(function(r){return 'referer: '+r.status+' len='+r.headers.get('content-length')}).catch(function(e){return 'referer EXC: '+e})")
    print(r3)
    r4 = await sw_eval("fetch('" + url + "', {credentials:'include', headers:{'Range':'bytes=0-1023'}}).then(function(r){return r.arrayBuffer().then(function(b){return 'range: '+r.status+' bytes='+b.byteLength})}).catch(function(e){return 'range EXC: '+e})")
    print(r4)
    await ws_sw.close()

asyncio.run(run())
