#!/usr/bin/env python3
"""Wake the SW via fixture reload, then dump diagnostic state in one shot."""
import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, "/Users/user/.local/share/uvx/browser-use/lib/python3.13/site-packages")
try:
    import websockets
except ImportError:
    sys.path.insert(0, "/Users/user/.local/share/uvx/browser-use/lib/python3.12/site-packages")
    import websockets

import asyncio

CDP = "http://localhost:" + os.environ.get("CDP_PORT", "9222")
EXT_ID = "gahplhbihkiodjleemjahaiajhgaijlb"
FIXTURE_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899


def cdp_list():
    return json.load(urllib.request.urlopen(CDP + "/json/list"))


def find(ttype, part):
    for t in cdp_list():
        if t["type"] == ttype and part in t.get("url", ""):
            return t
    return None


async def ev(ws_url, expr, timeout=12):
    async with websockets.connect(ws_url, max_size=10 * 1024 * 1024) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
        await ws.recv()
        await ws.send(json.dumps({"id": 2, "method": "Runtime.evaluate",
                                  "params": {"expression": expr, "awaitPromise": True, "returnByValue": True}}))
        dl = time.time() + timeout
        while time.time() < dl:
            m = json.loads(await asyncio.wait_for(ws.recv(), timeout=dl - time.time()))
            if m.get("id") == 2:
                return m.get("result", {}).get("result", {})
    raise TimeoutError


def pj(res):
    if res.get("type") == "object" and res.get("subtype") == "error":
        return "JS-ERROR: " + str(res.get("description"))[:200]
    return res.get("value", res)


async def main():
    # wake: reload fixture page so content script reports -> SW wakes
    page = find("page", str(FIXTURE_PORT))
    if page:
        try:
            await ev(page["webSocketDebuggerUrl"], "location.reload(); 'r'")
        except Exception as e:
            print("reload failed:", e)
    sw = None
    for _ in range(20):
        sw = find("service_worker", EXT_ID)
        if sw:
            break
        await asyncio.sleep(0.5)
    if not sw:
        print("SW never woke")
        return
    ws_url = sw["webSocketDebuggerUrl"]
    probes = {
        "dffLog": "JSON.stringify((typeof state!=='undefined' && state.dffLog) || 'none')",
        "listener": "JSON.stringify({mapSize: state.blobFilenames.size, listenerActive: chrome.downloads.onDeterminingFilename.hasListener(onDeterminingFilename)})",
        "blobMap": "chrome.storage.session.get('msBlobMap').then(r=>JSON.stringify(r.msBlobMap||{}))",
        "in_progress": "chrome.downloads.search({state:'in_progress'}).then(d=>JSON.stringify(d.map(x=>({url:x.url.slice(0,70),filename:x.filename,error:x.error,bytes:x.bytesReceived+'/'+x.totalBytes}))))",
        "interrupted": "chrome.downloads.search({state:'interrupted'}).then(d=>JSON.stringify(d.slice(-3).map(x=>({url:x.url.slice(0,70),filename:x.filename,error:x.error,bytes:x.bytesReceived+'/'+x.totalBytes}))))",
        "queue": "chrome.runtime.sendMessage({type:'ms-queue-status'}).then(r=>JSON.stringify(r))",
    }
    for name, expr in probes.items():
        try:
            print(name + ":", pj(await ev(ws_url, expr)))
        except Exception as e:
            print(name + ": ERR", e)


asyncio.run(main())
