#!/usr/bin/env python3
"""Boot check for Media Sniper: wake the SW by navigating a page, then
collect console errors from real news sites and attribute them."""
import json, sys, time, urllib.request

CDP = 'http://127.0.0.1:9222'

def get_json(path):
    with urllib.request.urlopen(CDP + path, timeout=5) as r:
        return json.loads(r.read().decode())

def find_target(ctype):
    for t in get_json('/json'):
        if t.get('type') == ctype:
            return t
    return None

def main():
    import websockets, asyncio

    async def run():
        errors = []
        sw_exceptions = []

        # 1) wake the SW: navigate the existing page to a real site.
        page = find_target('page')
        if not page:
            req = urllib.request.Request(CDP + '/json/new?about:blank', method='PUT')
            page = json.loads(urllib.request.urlopen(req, timeout=5).read().decode())
        ws_page = await websockets.connect(page['webSocketDebuggerUrl'], max_size=50_000_000)
        await ws_page.send(json.dumps({'id': 1, 'method': 'Runtime.enable'}))
        await ws_page.send(json.dumps({'id': 2, 'method': 'Log.enable'}))
        await ws_page.send(json.dumps({'id': 3, 'method': 'Page.enable'}))
        await ws_page.send(json.dumps({'id': 4, 'method': 'Page.navigate', 'params': {'url': 'https://www.sankei.com/'}}))

        # 2) wait for SW to appear (webRequest listener wakes it)
        sw = None
        t0 = time.time()
        while time.time() - t0 < 20:
            for t in get_json('/json'):
                if t.get('type') == 'service_worker' and 'chrome-extension://' in (t.get('url') or ''):
                    sw = t
                    break
            if sw:
                break
            await asyncio.sleep(0.5)
        if not sw:
            print('FAIL: extension service worker not found after wake')
            sys.exit(1)
        print('SW target:', sw['url'])

        async def drain(ws, secs, bucket):
            end = time.time() + secs
            while time.time() < end:
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=0.5)
                except asyncio.TimeoutError:
                    continue
                except Exception:
                    break
                try:
                    ev = json.loads(msg)
                except Exception:
                    continue
                m = ev.get('method')
                p = ev.get('params', {})
                if m == 'Runtime.exceptionThrown':
                    bucket.append(json.dumps(p.get('exceptionDetails', {}), ensure_ascii=False))
                elif m == 'Runtime.consoleAPICalled' and p.get('type') == 'error':
                    bucket.append(' '.join(str(a.get('value', a.get('description', '')))[:300] for a in p.get('args', [])))
                elif m == 'Log.entryAdded' and p.get('entry', {}).get('level') == 'error':
                    bucket.append(p['entry'].get('text', ''))

        # 3) inspect SW console; also prove onDeterminingFilename is defined
        ws_sw = await websockets.connect(sw['webSocketDebuggerUrl'], max_size=50_000_000)
        await ws_sw.send(json.dumps({'id': 1, 'method': 'Runtime.enable'}))
        await ws_sw.send(json.dumps({'id': 2, 'method': 'Log.enable'}))
        await ws_sw.send(json.dumps({'id': 3, 'method': 'Runtime.evaluate',
            'params': {'expression': "typeof onDeterminingFilename === 'function' ? 'fn-ok' : 'fn-missing'", 'returnByValue': True}}))
        await ws_sw.send(json.dumps({'id': 4, 'method': 'Runtime.evaluate',
            'params': {'expression': "typeof chrome.downloads.suggest", 'returnByValue': True}}))
        await drain(ws_sw, 4, sw_exceptions)
        await ws_sw.close()

        # 4) navigate to the two pages the user reported
        pages = [
            'https://www.sankei.com/article/20250408-4776CGGWIVNVZCXJUG3MFPBXVM/',
            'https://news.yahoo.co.jp/articles/bea9baffb290ee897243c08fa7259a01b7f672d6',
        ]
        for url in pages:
            print('>> navigate', url)
            await ws_page.send(json.dumps({'id': 11, 'method': 'Page.navigate', 'params': {'url': url}}))
            await drain(ws_page, 12, errors)
            await drain(ws_page, 3, errors)
        await ws_page.close()

        ms_errors = [e for e in errors if any(k in e.lower() for k in ('bridge.js', 'background.js', 'media-sniper', 'media sniper'))]

        print('\n=== SW exceptions:', len(sw_exceptions))
        for e in sw_exceptions[:10]: print('  -', e[:400])
        print('=== page console errors total:', len(errors))
        for e in errors[:15]: print('  -', e[:220])
        print('=== media-sniper-attributed errors:', len(ms_errors))
        for e in ms_errors[:10]: print('  !', e[:400])
        if not ms_errors and not sw_exceptions:
            print('\nRESULT: PASS - zero errors from Media Sniper code')
        else:
            print('\nRESULT: FAIL')
            sys.exit(1)

    asyncio.run(run())

if __name__ == '__main__':
    main()
