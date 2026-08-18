#!/usr/bin/env python3
"""Dump a fresh gvideo URL for curl testing."""
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
    print(item['url'])
    await ws_sw.close()

asyncio.run(run())
