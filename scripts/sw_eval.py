#!/usr/bin/env python3
"""Evaluate an expression inside the extension service worker over CDP.

CDP port: env CDP_PORT (default 9222). Host: localhost (Brave may bind ::1).
"""
import json
import os
import sys
import urllib.request

for _p in (
    "/Users/user/.local/share/uv/tools/browser-use/lib/python3.11/site-packages",
    "/Users/user/.local/share/uvx/browser-use/lib/python3.13/site-packages",
    "/Users/user/.local/share/uvx/browser-use/lib/python3.12/site-packages",
):
    if os.path.isdir(_p) and _p not in sys.path:
        sys.path.insert(0, _p)
try:
    import websockets
except ImportError:
    pass

import asyncio

EXT_ID = "gahplhbihkiodjleemjahaiajhgaijlb"


def find_sw():
    data = json.load(urllib.request.urlopen(
        "http://localhost:" + os.environ.get("CDP_PORT", "9222") + "/json/list"))
    for t in data:
        if t["type"] == "service_worker" and EXT_ID in t.get("url", ""):
            return t["webSocketDebuggerUrl"]
    raise SystemExit("service worker not found: " + json.dumps([(t['type'], t['url']) for t in data]))


async def main():
    expr = sys.argv[1] if len(sys.argv) > 1 else "1+1"
    ws_url = find_sw()
    async with websockets.connect(ws_url, max_size=10 * 1024 * 1024) as ws:
        await ws.send(json.dumps({
            "id": 1, "method": "Runtime.enable",
        }))
        await ws.recv()
        await ws.send(json.dumps({
            "id": 2, "method": "Runtime.evaluate",
            "params": {"expression": expr, "awaitPromise": True, "returnByValue": True},
        }))
        while True:
            msg = json.loads(await ws.recv())
            if msg.get("id") == 2:
                res = msg.get("result", {}).get("result", {})
                if "value" in res:
                    print(json.dumps(res["value"], ensure_ascii=False, indent=1))
                else:
                    print(json.dumps(res, ensure_ascii=False)[:2000])
                break


asyncio.run(main())
