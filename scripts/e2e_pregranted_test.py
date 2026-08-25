#!/usr/bin/env python3
"""Functional browser E2E for the manifest-only localhost grant harness.

The harness is copied from the exact packaged ZIP and changes only manifest
host_permissions to `http://127.0.0.1/*`. All runtime JS/WASM bytes are the
release bytes. This avoids automating Chrome's user-consent permission prompt
while still exercising detection/download behavior in a real browser.
"""
import asyncio
import json
import os
import sys
import time
import urllib.request

try:
    import websockets
except ImportError as exc:
    raise SystemExit("websockets is required: pip install websockets") from exc

CDP = "http://localhost:" + os.environ.get("CDP_PORT", "9222")
EXT_ID = os.environ.get("MEDIA_SNIPER_EXTENSION_ID", "").strip()
FIXTURE_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
FIXTURE_URL = f"http://127.0.0.1:{FIXTURE_PORT}/hls/index.html"
HOST_PATTERN = "http://127.0.0.1/*"
steps = []


def step(name, ok, detail=""):
    steps.append(bool(ok))
    print(f"[{'ok ' if ok else 'FAIL'}] {name} {str(detail)[:240]}", flush=True)
    if not ok:
        raise RuntimeError(name + ": " + str(detail))


def targets():
    return json.load(urllib.request.urlopen(CDP + "/json/list", timeout=5))


def target(kind, part):
    return next((t for t in targets() if t.get("type") == kind and part in (t.get("url") or "")), None)


def open_tab(url):
    req = urllib.request.Request(CDP + "/json/new?" + url, method="PUT")
    return json.load(urllib.request.urlopen(req, timeout=5))


async def evaluate(ws_url, expression, timeout=15):
    async with websockets.connect(ws_url, max_size=20 * 1024 * 1024) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
        await ws.recv()
        await ws.send(json.dumps({"id": 2, "method": "Runtime.evaluate", "params": {
            "expression": expression, "awaitPromise": True, "returnByValue": True,
        }}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=max(.1, deadline-time.time())))
            if msg.get("id") != 2:
                continue
            r = msg.get("result", {}).get("result", {})
            if r.get("subtype") == "error":
                raise RuntimeError(r.get("description", "Runtime.evaluate failed"))
            return r.get("value")
    raise TimeoutError("evaluate timeout")


def decode(raw):
    if isinstance(raw, str):
        try: return json.loads(raw)
        except Exception: return raw
    return raw


async def main():
    sw = target("service_worker", EXT_ID)
    step("service worker target", sw is not None, sw and sw.get("url"))
    sw_ws = sw["webSocketDebuggerUrl"]

    origins = decode(await evaluate(sw_ws, "chrome.permissions.getAll().then(p=>JSON.stringify(p.origins||[]))"))
    step("localhost harness host grant present", HOST_PATTERN in origins, origins)

    # site-access.js reconciles required/optional granted origins into dynamic
    # content-script registrations. Wait for startup reconciliation.
    ids = []
    deadline = time.time() + 12
    while time.time() < deadline:
        ids = decode(await evaluate(sw_ws,
            "chrome.scripting.getRegisteredContentScripts().then(x=>JSON.stringify(x.map(s=>s.id)))"))
        if "media-sniper-sites" in ids:
            break
        await asyncio.sleep(.4)
    step("dynamic detector registered", "media-sniper-sites" in ids, ids)

    open_tab(FIXTURE_URL)
    await asyncio.sleep(2)
    page = target("page", str(FIXTURE_PORT))
    step("fixture page opened", page is not None, page and page.get("url"))

    need = {"clip.mp4": False, "audio.mp3": False, "media.m3u8": False}
    deadline = time.time() + 15
    while time.time() < deadline:
        raw = await evaluate(sw_ws, "chrome.storage.session.get('msItems').then(r=>JSON.stringify(r.msItems||{}))")
        items = decode(raw) or {}
        urls = [i.get("url", "") for arr in items.values() for i in arr if f":{FIXTURE_PORT}/" in i.get("url", "")]
        for u in urls:
            for suffix in need:
                if u.endswith(suffix): need[suffix] = True
        if all(need.values()): break
        await asyncio.sleep(1)
    step("detect direct video/audio/HLS", all(need.values()), need)

    popup_url = f"chrome-extension://{EXT_ID}/popup/popup.html"
    open_tab(popup_url)
    await asyncio.sleep(1)
    popup = target("page", "popup/popup.html")
    step("popup context opened", popup is not None, popup and popup.get("url"))
    popup_ws = popup["webSocketDebuggerUrl"]

    trigger = (
        "chrome.runtime.sendMessage({type:'ms-download',item:{url:'"
        f"http://127.0.0.1:{FIXTURE_PORT}/hls/clip.mp4"
        "',kind:'video',ext:'mp4',title:'e2e-headless-test'}})"
        ".then(r=>JSON.stringify(r)).catch(e=>JSON.stringify({err:String(e)}))"
    )
    response = decode(await evaluate(popup_ws, trigger))
    step("direct download queued", isinstance(response, dict) and response.get("queued") is True, response)

    final = None
    deadline = time.time() + 35
    while time.time() < deadline:
        dls = decode(await evaluate(sw_ws, "chrome.downloads.search({}).then(x=>JSON.stringify(x))")) or []
        for d in dls:
            if (d.get("url") or "").endswith("clip.mp4") and f":{FIXTURE_PORT}/" in (d.get("url") or ""):
                final = d
                if d.get("state") in ("complete", "interrupted"): break
        if final and final.get("state") in ("complete", "interrupted"): break
        await asyncio.sleep(1)
    step("direct download completed", bool(final and final.get("state") == "complete"), final)

    settings = decode(await evaluate(popup_ws,
        "chrome.runtime.sendMessage({type:'ms-set-settings',settings:{rootFolder:'e2e-root',minSizeKb:500,blacklist:''}}).then(r=>JSON.stringify(r))"))
    step("settings write accepted", isinstance(settings, dict) and settings.get("saved") is True, settings)

    queue = decode(await evaluate(popup_ws,
        "chrome.runtime.sendMessage({type:'ms-queue-status'}).then(r=>JSON.stringify(r))"))
    step("queue status available", isinstance(queue, dict) and isinstance(queue.get("queue"), list), queue)

    await evaluate(popup_ws,
        "chrome.runtime.sendMessage({type:'ms-set-settings',settings:{rootFolder:'',minSizeKb:500,blacklist:''}})")
    print("FUNCTIONAL E2E: PASS", flush=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        print("FUNCTIONAL E2E: FAIL", repr(exc), flush=True)
        sys.exit(1)
