#!/usr/bin/env python3
"""Packaged-browser E2E for the two HLS shapes that used to fail silently.

1. A playlist whose segment URIs are ROOT-RELATIVE ("/hls/seg0.ts"), which is
   what X's manifests use. ffmpeg's own resolver rebuilt those against the
   `jsfetch:` input as "jsfetch:/hls/seg0.ts" - host gone - so every nested fetch
   failed and the job ended as a bare `ffmpeg failed (rc=-1)` with no streams.
   The worker now resolves every URI itself (L.rewriteHlsUrisAbs).

2. A master with a separate audio rendition (EXT-X-MEDIA TYPE=AUDIO): two
   network inputs cannot be open at once in this libav build, so the audio track
   is assembled locally and muxed as a file. The assertion is the one that
   matters for a user: the saved MP4 must contain BOTH a video and an audio
   stream (the old code produced neither).
"""
import asyncio
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request

try:
    import websockets
except ImportError as exc:  # pragma: no cover
    raise SystemExit("websockets is required: pip install websockets") from exc

CDP_PORT = int(os.environ.get("CDP_PORT", "9222"))
CDP = f"http://127.0.0.1:{CDP_PORT}"
EXT_ID = os.environ.get("MEDIA_SNIPER_EXTENSION_ID", "").strip()
if not EXT_ID:
    raise SystemExit("MEDIA_SNIPER_EXTENSION_ID is required")
FIXTURE_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
FIX = f"http://127.0.0.1:{FIXTURE_PORT}"
PAGE = FIX + "/hls/index.html"
ALL = ["http://*/*", "https://*/*"]
PREGRANTED = os.environ.get("MEDIA_SNIPER_E2E_PREGRANTED") == "1"

CASES = [
    ("RootRel HLS", FIX + "/hls/rootrel.m3u8", ["video"]),
    ("Two Source HLS", FIX + "/hls/twosource.m3u8", ["video", "audio"]),
]

# Real-site check: MEDIA_SNIPER_E2E_CASES='[{"title":...,"url":...,"expect":["video","audio"]}]'
# replaces the fixture cases (needs a harness with the media host granted).
_extra = os.environ.get("MEDIA_SNIPER_E2E_CASES")
if _extra:
    try:
        CASES = [(c["title"], c["url"], c.get("expect") or ["video"]) for c in json.loads(_extra)]
    except Exception as exc:  # pragma: no cover
        raise SystemExit("MEDIA_SNIPER_E2E_CASES is not valid JSON: " + str(exc))


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
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=max(.1, deadline - time.time())))
            if msg.get("id") != 2:
                continue
            res = msg.get("result", {}).get("result", {})
            if res.get("subtype") == "error":
                raise RuntimeError(res.get("description", "Runtime.evaluate failed"))
            return res.get("value")
    raise TimeoutError("Runtime.evaluate timeout")


async def wait_download(sw_url, title, seconds=90):
    record = None
    deadline = time.time() + seconds
    while time.time() < deadline:
        expr = (
            "chrome.downloads.search({}).then(items=>{const m=items.filter(i=>i.filename&&i.filename.includes(" +
            json.dumps(title) +
            ")).sort((a,b)=>b.id-a.id)[0];return m?JSON.stringify({state:m.state,error:m.error,bytes:m.bytesReceived,filename:m.filename}):null})"
        )
        raw = await eval_ws(sw_url, expr, timeout=10)
        if raw:
            record = json.loads(raw)
            if record.get("state") in ("complete", "interrupted"):
                break
        await asyncio.sleep(1)
    return record


def probe_streams(filename):
    probe = os.environ.get("FFPROBE") or "ffprobe"
    result = subprocess.run(
        [probe, "-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", filename],
        capture_output=True, text=True, timeout=120,
    )
    kinds = [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]
    return result.returncode, kinds, result.stderr.strip()


async def main():
    popup = find_target("page", "popup/popup.html")
    if not popup:
        open_tab(f"chrome-extension://{EXT_ID}/popup/popup.html")
        await asyncio.sleep(1)
        popup = find_target("page", "popup/popup.html")
    if not popup:
        raise SystemExit("ROOTREL/2-SOURCE HLS: FAIL (no popup target)")
    popup_ws = popup["webSocketDebuggerUrl"]
    if not PREGRANTED:
        await eval_ws(
            popup_ws,
            "(function(){const b=document.getElementById('accessAll'); if(!b) throw new Error('accessAll missing'); b.click(); return true;})()",
            user_gesture=True,
        )
        await asyncio.sleep(1)
    else:
        origins = json.loads(await eval_ws(popup_ws, "chrome.permissions.getAll().then(p=>JSON.stringify(p.origins||[]))", timeout=5) or "[]")
        if "http://127.0.0.1/*" not in origins:
            raise SystemExit("ROOTREL/2-SOURCE HLS: FAIL (missing harness grant) " + repr(origins))

    sw = find_target("service_worker", "background-entry.js")
    if not sw:
        raise SystemExit("ROOTREL/2-SOURCE HLS: FAIL (no service worker)")
    sw_url = sw["webSocketDebuggerUrl"]
    tab_raw = await eval_ws(sw_url, "chrome.tabs.query({active:true,currentWindow:true}).then(t=>t[0]&&t[0].id)", timeout=10)
    tab_id = int(tab_raw) if isinstance(tab_raw, (int, float)) else 0

    failures = []
    for title, url, expect in CASES:
        expr = (
            "startHls(" + str(tab_id) + "," + json.dumps(url) + "," + json.dumps(url) + "," +
            json.dumps(title) + "," + json.dumps(PAGE) + ",null,null)"
            ".then(r=>JSON.stringify(r)).catch(e=>JSON.stringify({error:String(e)}))"
        )
        started = json.loads(await eval_ws(sw_url, expr, timeout=90) or "{}")
        print(f"{title} start: {started}", flush=True)
        record = await wait_download(sw_url, title)
        if not record or record.get("state") != "complete":
            failures.append(f"{title}: download did not complete: {record}")
            print(f"[FAIL] {title} download {record}", flush=True)
            continue
        filename = record.get("filename") or ""
        for _ in range(30):
            if os.path.isfile(filename):
                break
            await asyncio.sleep(.2)
        rc, kinds, err = probe_streams(filename)
        missing = [k for k in expect if k not in kinds]
        if rc != 0 or missing:
            failures.append(f"{title}: ffprobe rc={rc} streams={kinds} missing={missing} err={err[:120]}")
            print(f"[FAIL] {title} streams={kinds} rc={rc} {err[:120]}", flush=True)
            continue
        size = os.path.getsize(filename) if os.path.isfile(filename) else 0
        print(f"[ok ] {title} {record.get('bytes')}B streams={kinds} size={size}", flush=True)

    if failures:
        print("ROOTREL/2-SOURCE HLS: FAIL", flush=True)
        for f in failures:
            print("  - " + f, flush=True)
        sys.exit(1)
    print("ROOTREL/2-SOURCE HLS: PASS", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
