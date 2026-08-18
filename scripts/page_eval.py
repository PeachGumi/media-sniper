#!/usr/bin/env python3
"""Evaluate JS on the fixture page over CDP."""
import json, sys, urllib.request
sys.path.insert(0, "/Users/user/.local/share/uvx/browser-use/lib/python3.13/site-packages")
try:
    import websockets
except ImportError:
    sys.path.insert(0, "/Users/user/.local/share/uvx/browser-use/lib/python3.12/site-packages")
    import websockets
import asyncio

def find_page():
    data = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json/list"))
    for t in data:
        if t["type"] == "page" and "8899" in t.get("url", ""):
            return t["webSocketDebuggerUrl"]
    raise SystemExit("fixture page not found: " + json.dumps([(t['type'], t['url']) for t in data]))

async def main():
    expr = sys.argv[1]
    async with websockets.connect(find_page(), max_size=10*1024*1024) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
        await ws.recv()
        await ws.send(json.dumps({"id": 2, "method": "Runtime.evaluate",
                                  "params": {"expression": expr, "awaitPromise": True, "returnByValue": True}}))
        while True:
            msg = json.loads(await ws.recv())
            if msg.get("id") == 2:
                res = msg.get("result", {}).get("result", {})
                print(json.dumps(res.get("value", res), ensure_ascii=False)[:2000])
                break

asyncio.run(main())
