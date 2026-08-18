#!/usr/bin/env python3
"""Final probe: is the WEB-client videoplayback URL inherently blocked?
curl with browser UA + referer, then report."""
import json, subprocess, sys, time, urllib.request

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
    if not yt_tab:
        print('NO_YT_TAB'); sys.exit(1)
    item = json.loads(await sw_eval("(function(){var items=state.itemsByTab.get(" + str(yt_tab['id']) + ")||[];var it=items.find(function(i){return i.via==='youtube'&&i.kind==='video'});return JSON.stringify(it||null)})()"))
    if not item:
        print('NO_ITEM'); sys.exit(1)
    url = item['url']
    await ws_sw.close()

    ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    p = subprocess.run([
        'curl', '-s', '-o', '/dev/null', '-w', '%{http_code} %{size_download}',
        '-r', '0-1023',
        '-H', 'User-Agent: ' + ua,
        '-H', 'Referer: https://www.youtube.com/watch?v=aqz-KE-bpKQ',
        url,
    ], capture_output=True, text=True, timeout=30)
    print('curl UA+referer:', p.stdout or p.stderr[:200])
    p2 = subprocess.run([
        'curl', '-s', '-o', '/dev/null', '-w', '%{http_code} %{size_download}',
        '-r', '0-1023', url,
    ], capture_output=True, text=True, timeout=30)
    print('curl plain:', p2.stdout or p2.stderr[:200])

asyncio.run(run())
