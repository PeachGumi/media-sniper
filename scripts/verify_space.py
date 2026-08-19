#!/usr/bin/env python3
"""E2E against the REAL X Spaces replay playlist the user reported
(x.com/Feel_Good__Inc_/status/2083094081656537286): detection must surface
one 'hls-audio' item (no master exists), and saving must produce a real .aac
file in ~/Downloads with the full 48-minute body.

Note on detection: the real x.com page player fetches the playlist with
Origin: https://x.com (200). Our fixture page's origin gets a 403 from the
CDN, so instead of relying on a page fetch we synthesize the exact
onResponseStarted event the real tab produces and let the SW validate the
playlist itself (SW fetch carries no Origin -> 200)."""
import json, os, sys, time, urllib.request

CDP = 'http://127.0.0.1:9222'
DL = os.path.expanduser('~/Downloads')
FIX = 'http://127.0.0.1:8901'
SPACE = ('https://prod-fastly-ap-northeast-1.video.pscp.tv/Transcoding/v1/hls/'
         'ABYh7-M-UptaX3ukpqJp-QAV91LLZO6tk5kAeXdVF0bGzsriEif49i_mu_0-rXlDqC10njro8uvBhskrGoMq7A/'
         'non_transcode/ap-northeast-1/periscope-replay-direct-prod-ap-northeast-1-public/'
         'audio-space/playlist_16661257885387052060.m3u8?type=replay')

def get_json(path):
    with urllib.request.urlopen(CDP + path, timeout=5) as r:
        return json.loads(r.read().decode())

def main():
    import websockets, asyncio

    async def run():
        page = next(t for t in get_json('/json') if t.get('type') == 'page')
        ws_p = await websockets.connect(page['webSocketDebuggerUrl'], max_size=50_000_000)
        eid_p = [100]

        async def page_eval(expr, timeout=30):
            eid_p[0] += 1
            await ws_p.send(json.dumps({'id': eid_p[0], 'method': 'Runtime.evaluate',
                'params': {'expression': expr, 'returnByValue': True, 'awaitPromise': True}}))
            end = time.time() + timeout
            while time.time() < end:
                try:
                    msg = json.loads(await asyncio.wait_for(ws_p.recv(), timeout=1))
                except asyncio.TimeoutError:
                    continue
                if msg.get('id') == eid_p[0]:
                    return msg.get('result', {}).get('result', {}).get('value')
            return None

        await ws_p.send(json.dumps({'id': 1, 'method': 'Runtime.enable'}))
        await ws_p.send(json.dumps({'id': 2, 'method': 'Page.enable'}))
        await ws_p.send(json.dumps({'id': 3, 'method': 'Page.navigate', 'params': {'url': FIX + '/index.html'}}))
        await asyncio.sleep(2)

        sw = None
        t0 = time.time()
        while time.time() - t0 < 15 and not sw:
            sw = next((t for t in get_json('/json')
                       if t.get('type') == 'service_worker' and 'chrome-extension://' in (t.get('url') or '')), None)
            await asyncio.sleep(0.4)
        if not sw:
            print('FAIL: SW not found'); sys.exit(1)
        ws_sw = await websockets.connect(sw['webSocketDebuggerUrl'], max_size=50_000_000)
        eid = [0]

        async def sw_eval(expr, timeout=20):
            eid[0] += 1
            await ws_sw.send(json.dumps({'id': eid[0], 'method': 'Runtime.evaluate',
                'params': {'expression': expr, 'returnByValue': True, 'awaitPromise': True}}))
            end = time.time() + timeout
            while time.time() < end:
                try:
                    msg = json.loads(await asyncio.wait_for(ws_sw.recv(), timeout=1))
                except asyncio.TimeoutError:
                    continue
                if msg.get('id') == eid[0]:
                    return msg.get('result', {}).get('result', {}).get('value')
            raise TimeoutError('sw_eval: ' + expr[:80])

        # ---- SANITY: the loaded SW must contain the new code
        ok_src = await sw_eval("String(runHlsJob).indexOf('audioOnly') >= 0 && typeof L.isAudioOnlyPlaylist === 'function'")
        print('SW has new code:', ok_src)
        if not ok_src:
            print('ABORT: stale extension code loaded'); sys.exit(1)

        tabid = await sw_eval("Array.from(state.itemsByTab.keys())[0] ?? -1")

        # ---- DETECTION: synthesize the onResponseStarted event a real x.com
        # tab produces when its player fetches the playlist
        await sw_eval("""
          onResponseStarted({
            statusCode: 200, tabId: """ + str(tabid) + """, initiator: 'https://x.com',
            url: '""" + SPACE + """',
            responseHeaders: [{ name: 'Content-Type', value: 'application/vnd.apple.mpegurl' }]
          }); true
        """)
        items = []
        for _ in range(10):
            await asyncio.sleep(1.5)
            items_raw = await sw_eval("""
              (() => {
                const out = [];
                state.itemsByTab.forEach((its) => its.forEach(i => out.push({
                  url: i.url.slice(0, 200), kind: i.kind, duration: i.duration, title: i.title })));
                return JSON.stringify(out);
              })()
            """)
            items = json.loads(items_raw or '[]')
            if any('pscp.tv' in i['url'] for i in items):
                break
        print('detected items:', json.dumps(items, indent=1, ensure_ascii=False))
        space_items = [i for i in items if 'pscp.tv' in i['url']]
        aac_items = [i for i in items if i['url'].split('?')[0].endswith('.aac')]
        ok_det = (len(space_items) == 1
                  and space_items[0]['kind'] == 'hls-audio'
                  and space_items[0]['duration'] and space_items[0]['duration'] > 2800
                  and not aac_items)
        print('DETECTION (one audio-HLS item, no chunks, ~48m):', 'PASS' if ok_det else 'FAIL')

        # ---- SAVE: full pipeline against the real CDN (960 segments)
        out = DL + '/x space e2e.aac'
        if os.path.exists(out): os.remove(out)
        resp = await sw_eval("startHls(" + str(tabid) + ", '" + SPACE + "', '" + SPACE + "', 'x space e2e', '" + FIX + "/', null, null).then(function(r){return JSON.stringify(r)})")
        print('startHls resp:', resp)
        t0 = time.time()
        st = None
        while time.time() - t0 < 240:
            st = await sw_eval(
                "(function(){var j=state.hlsJobs.get('" + SPACE + "');return j?JSON.stringify({status:j.status,done:j.done,total:j.total,error:j.error}):null})()")
            if st:
                obj = json.loads(st)
                print('  job:', obj['status'], obj['done'], '/', obj['total'], obj.get('error') or '')
                if obj['status'] in ('downloading', 'failed'):
                    break
            await asyncio.sleep(3)
        obj = json.loads(st) if st else {}
        if obj.get('status') != 'downloading':
            print('SPACE SAVE PIPELINE: FAIL -', obj.get('error') or st)
            await ws_sw.close(); await ws_p.close(); sys.exit(1)

        # wait for the blob download to finalize on disk
        size = 0
        t0 = time.time()
        while time.time() - t0 < 120:
            q = await sw_eval(
                "chrome.downloads.search({}).then(function(items){var m=items.filter(function(i){return i.filename&&i.filename.indexOf('x space e2e')>=0}).sort(function(a,b){return b.id-a.id});return m.length?JSON.stringify({state:m[0].state,bytes:m[0].bytesReceived,file:m[0].filename,err:m[0].error&&m[0].error.current}):null})")
            if q:
                rec = json.loads(q)
                print('  download:', rec['state'], rec['bytes'], os.path.basename(rec['file']))
                if rec['state'] == 'complete':
                    # chrome reports complete a beat before the OS finalizes
                    for _ in range(30):
                        if os.path.exists(rec['file']) and os.path.getsize(rec['file']) == rec['bytes']:
                            break
                        await asyncio.sleep(0.3)
                    size = os.path.getsize(rec['file']) if os.path.exists(rec['file']) else 0
                    print('file:', rec['file'], size, 'bytes')
                    ok_save = size > 30_000_000 and rec['file'].endswith('.aac')
                    print('SPACE SAVE PIPELINE (.aac, >30MB):', 'PASS' if ok_save else 'FAIL')
                    break
                if rec['state'] == 'interrupted':
                    print('SPACE SAVE PIPELINE: FAIL - interrupted', rec.get('err'))
                    break
            await asyncio.sleep(2)
        else:
            print('SPACE SAVE PIPELINE: FAIL - timeout waiting for download')

        await ws_sw.close(); await ws_p.close()

    asyncio.run(run())

if __name__ == '__main__':
    main()
