#!/usr/bin/env python3
"""media-sniper headless E2E download test (one command, LLM-friendly).

Prereqs (already running):
  - headless Brave/Chrome/Chromium with --load-extension=<project dir>
  - fixture http server on FIXTURE_PORT (default 8899), root = test/fixture
  - MEDIA_SNIPER_EXTENSION_ID set by run_e2e.py

Steps:
  1. Open a fresh tab on the fixture page (Target.createTarget)
  2. Wait for the service worker to wake; read msItems from storage.session
  3. Assert clip.mp4 / audio.mp3 / HLS were detected
  4. Open the real popup page (chrome-extension://ID/popup/popup.html) in a tab
  5. Send ms-download FROM THE POPUP CONTEXT (the exact production path)
  6. Poll chrome.downloads.search until the item completes or interrupts
  7. Report a JSON verdict + PASS/FAIL line

Usage: e2e_download_test.py [fixture_port]
"""
import json
import os
import sys
import time
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
except ImportError as exc:
    raise SystemExit("websockets is required for E2E: pip install websockets") from exc

import asyncio

CDP = "http://localhost:" + os.environ.get("CDP_PORT", "9222")
EXT_ID = os.environ.get("MEDIA_SNIPER_EXTENSION_ID", "").strip()
if not EXT_ID:
    raise SystemExit("MEDIA_SNIPER_EXTENSION_ID is required; run via scripts/run_e2e.py")
FIXTURE_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
FIXTURE_URL = f"http://127.0.0.1:{FIXTURE_PORT}/hls/index.html"
verdict = {"steps": [], "pass": False}


def step(name, ok, detail=""):
    verdict["steps"].append({"step": name, "ok": bool(ok), "detail": str(detail)[:300]})
    print(f"[{'ok ' if ok else 'FAIL'}] {name} {str(detail)[:200]}")


def cdp_list():
    return json.load(urllib.request.urlopen(CDP + "/json/list"))


def find_target(ttype, url_part):
    for t in cdp_list():
        if t["type"] == ttype and url_part in t.get("url", ""):
            return t
    return None


async def ws_eval(ws_url, expr, timeout=15):
    async with websockets.connect(ws_url, max_size=10 * 1024 * 1024) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
        await ws.recv()
        await ws.send(json.dumps({"id": 2, "method": "Runtime.evaluate",
                                  "params": {"expression": expr, "awaitPromise": True, "returnByValue": True}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=deadline - time.time()))
            if msg.get("id") == 2:
                res = msg.get("result", {}).get("result", {})
                if res.get("type") == "object" and res.get("subtype") == "error":
                    raise RuntimeError(str(res.get("description", res))[:300])
                return res.get("value", res)
    raise TimeoutError("no evaluate response")


def sw_ws():
    t = find_target("service_worker", EXT_ID)
    return t["webSocketDebuggerUrl"] if t else None


def open_tab(url):
    req = urllib.request.Request(CDP + "/json/new?" + url, method="PUT")
    return json.load(urllib.request.urlopen(req))


async def wait_for_sw(seconds):
    deadline = time.time() + seconds
    last_reload = 0
    while time.time() < deadline:
        if sw_ws():
            return True
        if time.time() - last_reload > 4:
            page = find_target("page", str(FIXTURE_PORT))
            if page:
                try:
                    await ws_eval(page["webSocketDebuggerUrl"], "location.reload(); 'r'", timeout=8)
                except Exception:
                    pass
                last_reload = time.time()
        await asyncio.sleep(1)
    return False


def parse_json_value(raw):
    if isinstance(raw, str):
        v = json.loads(raw)
        if isinstance(v, str):
            v = json.loads(v)
        return v
    return raw


async def main():
    try:
        open_tab(FIXTURE_URL)
        await asyncio.sleep(3)
    except Exception as e:
        step("open fixture tab", False, e)
        return
    page = find_target("page", str(FIXTURE_PORT))
    step("open fixture tab", page is not None, page and page["url"])
    if not page:
        return

    if not await wait_for_sw(20):
        step("service worker awake", False, "SW never appeared in /json/list")
        return
    step("service worker awake", True)
    try:
        items = parse_json_value(await ws_eval(sw_ws(),
            "chrome.storage.session.get('msItems').then(r => JSON.stringify(r.msItems || {}))"))
    except Exception as e:
        step("read msItems", False, e)
        return
    flat = [i for arr in items.values() for i in arr]
    step("read msItems", True, f"{len(flat)} items")

    need = {"clip.mp4": False, "audio.mp3": False, "media.m3u8": False}
    deadline = time.time() + 12
    while time.time() < deadline:
        try:
            items = parse_json_value(await ws_eval(sw_ws(),
                "chrome.storage.session.get('msItems').then(r => JSON.stringify(r.msItems || {}))", timeout=8))
            flat = [i for arr in (items or {}).values() for i in arr]
            ours = [i.get("url", "") for i in flat if f":{FIXTURE_PORT}/" in i.get("url", "")]
            for u in ours:
                for k in need:
                    if u.endswith(k):
                        need[k] = True
        except Exception:
            pass
        if all(need.values()):
            break
        await asyncio.sleep(1.5)
    step("detected video/audio/hls-variant", all(need.values()), json.dumps(need))

    popup_url = f"chrome-extension://{EXT_ID}/popup/popup.html"
    try:
        open_tab(popup_url)
        await asyncio.sleep(1)
    except Exception as e:
        step("open popup context", False, e)
        return
    popup = find_target("page", "popup.html")
    step("open popup context", popup is not None, popup and popup["url"])
    if not popup:
        return

    trigger = (
        "chrome.runtime.sendMessage({type:'ms-download', item:{url:'"
        f"http://127.0.0.1:{FIXTURE_PORT}/hls/clip.mp4"
        "', kind:'video', ext:'mp4', title:'e2e-headless-test'}})"
        ".then(r => JSON.stringify(r)).catch(e => JSON.stringify({err: String(e)}))"
    )
    try:
        res = parse_json_value(await ws_eval(popup["webSocketDebuggerUrl"], trigger))
        step("ms-download accepted (popup->SW)", isinstance(res, dict) and res.get("queued") is True, res)
    except Exception as e:
        step("ms-download accepted (popup->SW)", False, e)
        return

    final = None
    for _ in range(30):
        await asyncio.sleep(1)
        try:
            wsurl = sw_ws()
            if not wsurl:
                continue
            dls = parse_json_value(await ws_eval(wsurl,
                "chrome.downloads.search({}).then(d => JSON.stringify(d))", timeout=8))
        except Exception:
            continue
        for d in dls:
            if f":{FIXTURE_PORT}/" in (d.get("url") or "") and d["url"].endswith("clip.mp4"):
                final = d
                if d.get("state") in ("complete", "interrupted"):
                    break
        if final and final.get("state") in ("complete", "interrupted"):
            break

    if not final:
        step("download reached terminal state", False, "never appeared in chrome.downloads.search")
    else:
        ok = final.get("state") == "complete"
        step("download reached terminal state", ok, {
            "state": final.get("state"), "error": final.get("error"),
            "filename": final.get("filename"),
            "bytesReceived": final.get("bytesReceived"), "totalBytes": final.get("totalBytes"),
        })

    try:
        st = parse_json_value(await ws_eval(popup["webSocketDebuggerUrl"],
            "chrome.runtime.sendMessage({type:'ms-set-settings',settings:{rootFolder:'e2e-root',minSizeKb:500,blacklist:''}})"
            ".then(r=>JSON.stringify(r)).catch(e=>JSON.stringify({err:String(e)}))"))
        ok_st = isinstance(st, dict) and st.get("saved") and st.get("settings", {}).get("rootFolder") == "e2e-root"
        step("set-settings saved (root sanitized/kept)", bool(ok_st), st)
        try:
            da = parse_json_value(await ws_eval(popup["webSocketDebuggerUrl"],
                "chrome.runtime.sendMessage({type:'ms-download-all',tabId:1})"
                ".then(r=>JSON.stringify(r)).catch(e=>JSON.stringify({err:String(e)}))"))
            ok_da = isinstance(da, dict) and ("queued" in da) and ("skipped" in da) and ("deferred" in da)
            step("ms-download-all responds with counters", bool(ok_da), da)
        except Exception as e:
            step("ms-download-all responds with counters", False, e)
    except Exception as e:
        step("set-settings saved (root sanitized/kept)", False, e)

    try:
        await ws_eval(popup["webSocketDebuggerUrl"],
            "chrome.runtime.sendMessage({type:'ms-set-settings',settings:{rootFolder:'',minSizeKb:500,blacklist:''}})")
    except Exception:
        pass

    try:
        q = parse_json_value(await ws_eval(popup["webSocketDebuggerUrl"],
            "chrome.runtime.sendMessage({type:'ms-queue-status'}).then(r=>JSON.stringify(r))"))
        step("queue status", True, q)
    except Exception as e:
        step("queue status", False, e)

    verdict["pass"] = all(s["ok"] for s in verdict["steps"])
    print(json.dumps(verdict, ensure_ascii=False, indent=1))
    print("RESULT:", "PASS" if verdict["pass"] else "FAIL")
    sys.exit(0 if verdict["pass"] else 1)


asyncio.run(main())
