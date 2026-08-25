#!/usr/bin/env python3
"""Packaged-browser E2E for the bundled libav runtime.

Exercises AES-128 encrypted HLS through the real Media Sniper offscreen ffmpeg
path and verifies that a non-trivial MP4 reaches Chromium Downloads. The runner
supplies CDP_PORT, MEDIA_SNIPER_EXTENSION_ID and the fixture port.
"""
import asyncio
import json
import os
import sys
import time
import urllib.parse
import urllib.request

try:
    import websockets
except ImportError as exc:
    raise SystemExit("websockets is required: pip install websockets") from exc

CDP_PORT = int(os.environ.get("CDP_PORT", "9222"))
CDP = f"http://127.0.0.1:{CDP_PORT}"
EXT_ID = os.environ.get("MEDIA_SNIPER_EXTENSION_ID", "").strip()
if not EXT_ID:
    raise SystemExit("MEDIA_SNIPER_EXTENSION_ID is required")
FIXTURE_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
FIX = f"http://127.0.0.1:{FIXTURE_PORT}"
ENC = FIX + "/hls/encindex.m3u8"
PAGE = FIX + "/hls/index.html"
TITLE = "e2e aes libav"


def targets():
    with urllib.request.urlopen(CDP + "/json/list", timeout=5) as r:
        return json.loads(r.read().decode())


def find_target(kind, part):
    return next((t for t in targets() if t.get("type") == kind and part in (t.get("url") or "")), None)


def open_tab(url):
    req = urllib.request.Request(CDP + "/json/new?" + urllib.parse.quote(url, safe=":/?=&"), method="PUT")
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read().decode())


async def eval_ws(ws_url, expr, timeout=30, user_gesture=False):
    async with websockets.connect(ws_url, max_size=50_000_000) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
        await ws.recv()
        params = {"expression": expr, "returnByValue": True, "awaitPromise": True}
        if user_gesture:
            params["userGesture"] = True
        await ws.send(json.dumps({"id": 2, "method": "Runtime.evaluate", "params": params}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.time())))
            if msg.get("id") != 2:
                continue
            res = msg.get("result", {}).get("result", {})
            if res.get("subtype") == "error":
                raise RuntimeError(res.get("description", "Runtime.evaluate failed"))
            return res.get("value")
    raise TimeoutError("Runtime.evaluate timeout")


async def main():
    popup = find_target("page", "popup/popup.html")
    if not popup:
        open_tab(f"chrome-extension://{EXT_ID}/popup/popup.html")
        await asyncio.sleep(1)
        popup = find_target("page", "popup/popup.html")
    if not popup:
        raise RuntimeError("popup target not found")

    # The previous general E2E revokes persistent access intentionally. Grant it
    # again with an explicit user gesture for this dedicated media-engine test.
    granted = await eval_ws(
        popup["webSocketDebuggerUrl"],
        "chrome.permissions.request({origins:['http://*/*','https://*/*']})",
        user_gesture=True,
    )
    if granted is not True:
        raise RuntimeError("optional host permission was not granted")

    sw = find_target("service_worker", EXT_ID)
    if not sw:
        raise RuntimeError("service worker target not found")
    sw_url = sw["webSocketDebuggerUrl"]

    # Use the same internal HLS entry point invoked by the privileged message
    # handler. This test is specifically for media-engine compatibility; the
    # separate E2E already verifies page -> extension privilege boundaries.
    start_expr = (
        "startHls(9003," + json.dumps(ENC) + "," + json.dumps(ENC) + "," +
        json.dumps(TITLE) + "," + json.dumps(PAGE) + ",null,null)"
        ".then(r=>JSON.stringify(r)).catch(e=>JSON.stringify({error:String(e)}))"
    )
    started_raw = await eval_ws(sw_url, start_expr, timeout=30)
    started = json.loads(started_raw) if started_raw else {}
    print("AES start:", started)
    if started.get("error"):
        raise RuntimeError("startHls failed: " + str(started.get("error")))

    job = None
    deadline = time.time() + 180
    while time.time() < deadline:
        raw = await eval_ws(
            sw_url,
            "(function(){var j=state.hlsJobs.get(" + json.dumps(ENC) + ");"
            "return j?JSON.stringify({status:j.status,error:j.error,size:j.size,filename:j.filename}):null})()",
            timeout=10,
        )
        if raw:
            job = json.loads(raw)
            print("AES job:", job)
            if job.get("status") in ("complete", "failed"):
                break
        await asyncio.sleep(1)

    if not job or job.get("status") != "complete":
        raise RuntimeError("AES HLS job did not complete: " + str(job))

    record = None
    deadline = time.time() + 60
    while time.time() < deadline:
        raw = await eval_ws(
            sw_url,
            "chrome.downloads.search({}).then(items=>{const m=items.filter(i=>i.filename&&i.filename.includes('e2e aes libav')).sort((a,b)=>b.id-a.id)[0];"
            "return m?JSON.stringify({state:m.state,error:m.error,bytes:m.bytesReceived,filename:m.filename}):null})",
            timeout=10,
        )
        if raw:
            record = json.loads(raw)
            if record.get("state") in ("complete", "interrupted"):
                break
        await asyncio.sleep(1)

    if not record or record.get("state") != "complete":
        raise RuntimeError("AES HLS download did not complete: " + str(record))
    if int(record.get("bytes") or 0) < 100_000:
        raise RuntimeError("AES HLS output unexpectedly small: " + str(record))

    filename = record.get("filename") or ""
    if not filename.lower().endswith(".mp4"):
        raise RuntimeError("AES HLS output is not MP4: " + filename)

    # Chromium reports completion only after the file is finalized. Verify a
    # basic ISO BMFF signature without requiring host ffprobe/ffmpeg packages.
    for _ in range(30):
        if os.path.isfile(filename):
            break
        await asyncio.sleep(0.2)
    if not os.path.isfile(filename):
        raise RuntimeError("downloaded MP4 is not present on disk: " + filename)
    with open(filename, "rb") as f:
        head = f.read(64)
    if b"ftyp" not in head:
        raise RuntimeError("downloaded file lacks MP4 ftyp signature")

    print("AES-128 HLS -> reproducible libav -> MP4: PASS", record)
    try:
        os.remove(filename)
    except OSError:
        pass

    await eval_ws(
        popup["webSocketDebuggerUrl"],
        "chrome.permissions.remove({origins:['http://*/*','https://*/*']})",
        user_gesture=True,
    )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        print("AES-128 HLS E2E: FAIL", repr(exc))
        sys.exit(1)
