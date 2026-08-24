#!/usr/bin/env python3
"""Media Sniper browser E2E.

The test intentionally starts with no persistent host access, grants optional
HTTP(S) access from a real extension page using a CDP user gesture, verifies
that dynamic document-start detection becomes active, then exercises the normal
download/settings paths and finally revokes persistent host access again.
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


async def ws_eval(ws_url, expr, timeout=15, user_gesture=False):
    async with websockets.connect(ws_url, max_size=10 * 1024 * 1024) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
        await ws.recv()
        params = {"expression": expr, "awaitPromise": True, "returnByValue": True}
        if user_gesture:
            params["userGesture"] = True
        await ws.send(json.dumps({"id": 2, "method": "Runtime.evaluate", "params": params}))
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
    while time.time() < deadline:
        if sw_ws():
            return True
        await asyncio.sleep(0.5)
    return False


def parse_json_value(raw):
    if isinstance(raw, str):
        v = json.loads(raw)
        if isinstance(v, str):
            v = json.loads(v)
        return v
    return raw


async def wait_registered(popup_ws, seconds=10):
    deadline = time.time() + seconds
    last = []
    while time.time() < deadline:
        try:
            last = parse_json_value(await ws_eval(
                popup_ws,
                "chrome.scripting.getRegisteredContentScripts().then(x=>JSON.stringify(x.map(s=>s.id)))",
                timeout=5,
            ))
            if "media-sniper-sites" in last:
                return last
        except Exception:
            pass
        await asyncio.sleep(0.5)
    return last


async def main():
    try:
        open_tab(FIXTURE_URL)
        await asyncio.sleep(2)
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
    popup_ws = popup["webSocketDebuggerUrl"]

    # A clean profile must have no permanent site access before the user opts in.
    try:
        before = parse_json_value(await ws_eval(
            popup_ws,
            "chrome.permissions.getAll().then(p=>JSON.stringify(p.origins||[]))",
        ))
        step("no persistent host access by default", before == [], before)
    except Exception as e:
        step("no persistent host access by default", False, e)
        return

    # Request broad optional access with an explicit user-gesture bit. This is
    # equivalent to the popup's "Always all sites" button and is the mode used
    # to exercise network-level HLS detection in this fixture.
    try:
        granted = await ws_eval(
            popup_ws,
            "chrome.permissions.request({origins:['http://*/*','https://*/*']})",
            user_gesture=True,
        )
        step("optional all-sites permission granted", granted is True, granted)
        if granted is not True:
            return
    except Exception as e:
        step("optional all-sites permission granted", False, e)
        return

    registered = await wait_registered(popup_ws)
    step("persistent detector registered", "media-sniper-sites" in registered, registered)
    if "media-sniper-sites" not in registered:
        return

    # Dynamic document-start registrations apply on the next navigation.
    try:
        await ws_eval(page["webSocketDebuggerUrl"], "location.reload(); 'reloaded'", timeout=8)
        await asyncio.sleep(2)
    except Exception as e:
        step("reload fixture after host grant", False, e)
        return
    step("reload fixture after host grant", True)

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

    trigger = (
        "chrome.runtime.sendMessage({type:'ms-download', item:{url:'"
        f"http://127.0.0.1:{FIXTURE_PORT}/hls/clip.mp4"
        "', kind:'video', ext:'mp4', title:'e2e-headless-test'}})"
        ".then(r => JSON.stringify(r)).catch(e => JSON.stringify({err: String(e)}))"
    )
    try:
        res = parse_json_value(await ws_eval(popup_ws, trigger))
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
        st = parse_json_value(await ws_eval(popup_ws,
            "chrome.runtime.sendMessage({type:'ms-set-settings',settings:{rootFolder:'e2e-root',minSizeKb:500,blacklist:''}})"
            ".then(r=>JSON.stringify(r)).catch(e=>JSON.stringify({err:String(e)}))"))
        ok_st = isinstance(st, dict) and st.get("saved") and st.get("settings", {}).get("rootFolder") == "e2e-root"
        step("set-settings saved (root sanitized/kept)", bool(ok_st), st)
    except Exception as e:
        step("set-settings saved (root sanitized/kept)", False, e)

    try:
        q = parse_json_value(await ws_eval(popup_ws,
            "chrome.runtime.sendMessage({type:'ms-queue-status'}).then(r=>JSON.stringify(r))"))
        step("queue status", True, q)
    except Exception as e:
        step("queue status", False, e)

    # Permission revocation is part of the product contract. onRemoved must
    # reconcile dynamic registrations back to zero.
    try:
        removed = await ws_eval(
            popup_ws,
            "chrome.permissions.remove({origins:['http://*/*','https://*/*']})",
            user_gesture=True,
        )
        step("persistent host access removable", removed is True, removed)
        await asyncio.sleep(1)
        after = parse_json_value(await ws_eval(
            popup_ws,
            "Promise.all([chrome.permissions.getAll(),chrome.scripting.getRegisteredContentScripts()]).then(([p,s])=>JSON.stringify({origins:p.origins||[],ids:s.map(x=>x.id)}))",
        ))
        clean = after.get("origins") == [] and "media-sniper-sites" not in after.get("ids", [])
        step("revocation unregisters persistent detector", clean, after)
    except Exception as e:
        step("persistent host access removable", False, e)

    try:
        await ws_eval(popup_ws,
            "chrome.runtime.sendMessage({type:'ms-set-settings',settings:{rootFolder:'',minSizeKb:500,blacklist:''}})")
    except Exception:
        pass

    verdict["pass"] = all(s["ok"] for s in verdict["steps"])
    print(json.dumps(verdict, ensure_ascii=False, indent=1))
    print("RESULT:", "PASS" if verdict["pass"] else "FAIL")
    sys.exit(0 if verdict["pass"] else 1)


asyncio.run(main())
