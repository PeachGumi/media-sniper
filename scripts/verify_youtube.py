#!/usr/bin/env python3
"""Verify YouTube adapter on a real youtube.com watch page (headless Brave)."""
import json, os, sys, time, urllib.request

CDP = 'http://127.0.0.1:9222'

def get_json(path):
    with urllib.request.urlopen(CDP + path, timeout=5) as r:
        return json.loads(r.read().decode())

import websockets, asyncio

# a public, long-standing video (Big Buck Bunny on Blender's channel)
YT_URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'

async def run():
    page = next(t for t in get_json('/json') if t.get('type') == 'page')
    ws_p = await websockets.connect(page['webSocketDebuggerUrl'], max_size=50_000_000)
    eid = [0]

    async def page_eval(expr, timeout=20):
        eid[0] += 1
        await ws_p.send(json.dumps({'id': eid[0], 'method': 'Runtime.evaluate', 'params': {'expression': expr, 'returnByValue': True}}))
        end = time.time() + timeout
        while time.time() < end:
            try:
                msg = json.loads(await asyncio.wait_for(ws_p.recv(), timeout=1))
            except asyncio.TimeoutError:
                continue
            if msg.get('id') == eid[0]:
                r = msg.get('result', {}).get('result', {})
                return r.get('value', r.get('description'))
        return None

    await ws_p.send(json.dumps({'id': 1, 'method': 'Page.enable'}))
    await ws_p.send(json.dumps({'id': 2, 'method': 'Page.navigate', 'params': {'url': YT_URL}}))
    await asyncio.sleep(10)

    url_now = await page_eval("location.href")
    title = await page_eval("document.title")
    pr_present = await page_eval("!!window.ytInitialPlayerResponse && !!window.ytInitialPlayerResponse.streamingData")
    installed = await page_eval("!!window.__mediaSniperYtInstalled")
    print('url now:', url_now)
    print('title:', title)
    print('ytInitialPlayerResponse.streamingData:', pr_present)
    print('adapter installed:', installed)

    # wait for SW + items
    sw = None
    t0 = time.time()
    while time.time() - t0 < 20 and not sw:
        sw = next((t for t in get_json('/json') if t.get('type') == 'service_worker' and 'chrome-extension://' in t.get('url', '')), None)
        await asyncio.sleep(0.5)
    if not sw:
        print('SW: MISSING')
        await ws_p.close()
        sys.exit(1)
    ws_sw = await websockets.connect(sw['webSocketDebuggerUrl'], max_size=50_000_000)
    eid2 = [0]

    async def sw_eval(expr, timeout=20):
        eid2[0] += 1
        await ws_sw.send(json.dumps({'id': eid2[0], 'method': 'Runtime.evaluate', 'params': {'expression': expr, 'returnByValue': True, 'awaitPromise': True}}))
        end = time.time() + timeout
        while time.time() < end:
            try:
                msg = json.loads(await asyncio.wait_for(ws_sw.recv(), timeout=1))
            except asyncio.TimeoutError:
                continue
            if msg.get('id') == eid2[0]:
                r = msg.get('result', {}).get('result', {})
                return r.get('value', r.get('description'))
        return None

    # find the tab id for the youtube page
    tabs = await sw_eval("chrome.tabs.query({}).then(function(t){return JSON.stringify(t.map(function(x){return {id:x.id,url:x.url}}))})")
    print('tabs:', tabs)
    tab = json.loads(tabs)
    yt_tab = next((t for t in tab if 'youtube.com' in (t.get('url') or '')), None)
    if not yt_tab:
        print('FAIL: no youtube tab')
        sys.exit(1)
    items = await sw_eval("(function(){var items=state.itemsByTab.get(" + str(yt_tab['id']) + ")||[];return JSON.stringify(items.map(function(i){return {url:i.url.slice(0,80),kind:i.kind,size:i.size,via:i.via,title:i.title,ext:i.ext}}))})()")
    arr = json.loads(items) if items else []
    print('items detected:', len(arr))
    for it in arr:
        print('  -', json.dumps(it, ensure_ascii=False))
    yt_items = [i for i in arr if i.get('via') == 'youtube']
    if yt_items:
        print('\nRESULT: PASS - YouTube adapter extracted', len(yt_items), 'formats')
    else:
        print('\nRESULT: FAIL - no youtube items')
    await ws_sw.close()
    await ws_p.close()

asyncio.run(run())
