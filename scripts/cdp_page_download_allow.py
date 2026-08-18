#!/usr/bin/env python3
"""Enable downloads per page session via CDP Page.setDownloadBehavior."""
import json
import sys
import urllib.request

sys.path.insert(0, "/Users/user/.local/share/uv/tools/browser-use/lib/python3.11/site-packages")
import asyncio
import websockets


async def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "/Users/user/Downloads"
    targets = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json/list"))
    for t in targets:
        if t["type"] != "page":
            continue
        ws_url = t["webSocketDebuggerUrl"]
        async with websockets.connect(ws_url, max_size=10 * 1024 * 1024) as ws:
            await ws.send(json.dumps({
                "id": 1,
                "method": "Page.setDownloadBehavior",
                "params": {"behavior": "allow", "downloadPath": path},
            }))
            msg = json.loads(await ws.recv())
            print(t["url"][:50], "->", json.dumps(msg)[:120])


asyncio.run(main())
