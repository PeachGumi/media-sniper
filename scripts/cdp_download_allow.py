#!/usr/bin/env python3
"""Set headless download behavior via CDP browser endpoint."""
import json
import sys
import urllib.request

sys.path.insert(0, "/Users/user/.local/share/uv/tools/browser-use/lib/python3.11/site-packages")
import asyncio
import websockets


async def main():
    version = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json/version"))
    ws_url = version["webSocketDebuggerUrl"]
    path = sys.argv[1] if len(sys.argv) > 1 else "/Users/user/Downloads"
    async with websockets.connect(ws_url, max_size=10 * 1024 * 1024) as ws:
        await ws.send(json.dumps({
            "id": 1,
            "method": "Browser.setDownloadBehavior",
            "params": {"behavior": "allow", "downloadPath": path, "eventsEnabled": True},
        }))
        msg = json.loads(await ws.recv())
        print(json.dumps(msg))


asyncio.run(main())
