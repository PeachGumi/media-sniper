#!/usr/bin/env python3
"""Probe: re-request the player response as TVHTML5 client, then test if the
returned format URLs are fetchable (SW + page + raw curl)."""
import json, subprocess, sys, time, urllib.request

CDP = 'http://127.0.0.1:9222'

def get_json(path):
    with urllib.request.urlopen(CDP + path, timeout=5) as r:
        return json.loads(r.read().decode())

import websockets, asyncio

async def run():
    sw = next((t for t in get_json('/json') if t.get('type') == 'service_worker' and 'chrome-extension://' in t.get('url', '')), None)
    page = next((t for t in get_json('/json') if t.get('type') == 'page' and 'youtube.com' in t.get('url', '')), None)
    if not sw or not page:
        print('MISSING sw or page', bool(sw), bool(page)); sys.exit(1)

    ws_p = await websockets.connect(page['webSocketDebuggerUrl'], max_size=50_000_000)
    eid = [0]

    async def page_eval(expr, timeout=40):
        eid[0] += 1
        await ws_p.send(json.dumps({'id': eid[0], 'method': 'Runtime.evaluate', 'params': {'expression': expr, 'returnByValue': True, 'awaitPromise': True}}))
        end = time.time() + timeout
        while time.time() < end:
            try:
                msg = json.loads(await asyncio.wait_for(ws_p.recv(), timeout=1))
            except asyncio.TimeoutError:
                continue
            if msg.get('id') == eid[0]:
                r = msg.get('result', {})
                if 'exceptionDetails' in r:
                    return 'EXC: ' + json.dumps(r['exceptionDetails'])[:300]
                res = r.get('result', {})
                return res.get('value', res.get('description'))
        return None

    # grab innertube config + video id from the page
    cfg = await page_eval("JSON.stringify({key: window.ytcfg && window.ytcfg.get('INNERTUBE_API_KEY'), ctx: window.ytcfg && window.ytcfg.get('INNERTUBE_CONTEXT'), vid: window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.videoDetails && window.ytInitialPlayerResponse.videoDetails.videoId})")
    print('ytcfg:', (cfg or '')[:300])
    o = json.loads(cfg)
    key, ctx, vid = o['key'], o['ctx'], o['vid']
    body = {
        'context': {'client': {'clientName': 'TVHTML5', 'clientVersion': '7.20260311.12.00', 'hl': 'ja', 'gl': 'JP'}},
        'videoId': vid,
        'playbackContext': {'contentPlaybackContext': {'html5Preference': 'HTML5_PREF_WANTS'}},
    }
    body_json = json.dumps(body).replace('\\', '\\\\').replace("'", "\\'")
    expr = (
        "fetch('https://www.youtube.com/youtubei/v1/player?key=" + key + "', {"
        "method:'POST', credentials:'include', headers:{'Content-Type':'application/json'},"
        "body:'" + body_json + "'})"
        ".then(function(r){return r.text()})"
        ".then(function(t){try{var j=JSON.parse(t);var f=(j.streamingData&&j.streamingData.formats)||[];return JSON.stringify({status:j.playabilityStatus&&j.playabilityStatus.status, n:f.length, first: f[0] && {url:(f[0].url||'').slice(0,120), itag:f[0].itag, q:f[0].qualityLabel, mime:f[0].mimeType}})}catch(e){return 'PARSE FAIL '+t.slice(0,200)}})"
        ".catch(function(e){return 'EXC '+e})"
    )
    res = await page_eval(expr, timeout=30)
    print('TVHTML5 player resp:', res)
    try:
        rr = json.loads(res)
    except Exception:
        print('no formats'); sys.exit(1)
    if not rr.get('first') or not rr['first'].get('url'):
        print('no usable url'); sys.exit(1)

    # fetch full formats to get the actual url for testing
    expr2 = (
        "fetch('https://www.youtube.com/youtubei/v1/player?key=" + key + "', {"
        "method:'POST', credentials:'include', headers:{'Content-Type':'application/json'},"
        "body:'" + body_json + "'})"
        ".then(function(r){return r.json()})"
        ".then(function(j){var f=(j.streamingData&&j.streamingData.formats)||[];var best=f.filter(function(x){return x.url}).sort(function(a,b){return (b.contentLength?+b.contentLength:0)-(a.contentLength?+a.contentLength:0)})[0];return best?best.url:''})"
        ".catch(function(e){return 'EXC '+e})"
    )
    tvurl = await page_eval(expr2, timeout=30)
    print('TV url:', (tvurl or '')[:120])
    if not tvurl or tvurl.startswith('EXC'):
        sys.exit(1)
    await ws_p.close()

    # test 1: curl from terminal (different IP than the browser? no - same machine)
    p = subprocess.run(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code} %{size_download}', '-r', '0-1023', tvurl], capture_output=True, text=True, timeout=30)
    print('curl range:', p.stdout)

    # test 2: SW fetch
    ws_sw = await websockets.connect(sw['webSocketDebuggerUrl'], max_size=50_000_000)
    eid2 = [0]

    async def sw_eval(expr, timeout=40):
        eid2[0] += 1
        await ws_sw.send(json.dumps({'id': eid2[0], 'method': 'Runtime.evaluate', 'params': {'expression': expr, 'returnByValue': True, 'awaitPromise': True}}))
        end = time.time() + timeout
        while time.time() < end:
            try:
                msg = json.loads(await asyncio.wait_for(ws_sw.recv(), timeout=1))
            except asyncio.TimeoutError:
                continue
            if msg.get('id') == eid2[0]:
                r = msg.get('result', {})
                if 'exceptionDetails' in r:
                    return 'EXC: ' + json.dumps(r['exceptionDetails'])[:200]
                res = r.get('result', {})
                return res.get('value', res.get('description'))
        return None

    safe = tvurl.replace("'", "\\'")
    r4 = await sw_eval("fetch('" + safe + "', {headers:{'Range':'bytes=0-1023'}}).then(function(r){return r.arrayBuffer().then(function(b){return 'SW range: '+r.status+' bytes='+b.byteLength})}).catch(function(e){return 'SW range EXC: '+e})")
    print(r4)
    await ws_sw.close()

asyncio.run(run())
