#!/usr/bin/env python3
"""Media Sniper packaged-browser E2E.

Starts with no persistent host access, exercises the real popup controls to
request/revoke optional access, verifies dynamic detector registration, then
checks detection, direct download and settings paths.
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
    raise SystemExit("websockets is required for E2E: pip install websockets") from exc

CDP = "http://localhost:" + os.environ.get("CDP_PORT", "9222")
EXT_ID = os.environ.get("MEDIA_SNIPER_EXTENSION_ID", "").strip()
if not EXT_ID:
    raise SystemExit("MEDIA_SNIPER_EXTENSION_ID is required; run via scripts/run_e2e.py")
FIXTURE_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
FIXTURE_URL = f"http://127.0.0.1:{FIXTURE_PORT}/hls/index.html"
verdict = {"steps": [], "pass": False}


def step(name, ok, detail=""):
    verdict["steps"].append({"step": name, "ok": bool(ok), "detail": str(detail)[:300]})
    print(f"[{'ok ' if ok else 'FAIL'}] {name} {str(detail)[:200]}", flush=True)


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
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.time())))
            if msg.get("id") != 2:
                continue
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


async def get_origins(popup_ws):
    return parse_json_value(await ws_eval(
        popup_ws,
        "chrome.permissions.getAll().then(p=>JSON.stringify(p.origins||[]))",
        timeout=5,
    ))


async def wait_origins(popup_ws, want_granted, seconds=12):
    deadline = time.time() + seconds
    last = []
    while time.time() < deadline:
        try:
            last = await get_origins(popup_ws)
            granted = "http://*/*" in last and "https://*/*" in last
            if granted == want_granted:
                return last
        except Exception:
            pass
        await asyncio.sleep(0.4)
    return last


async def wait_registered(popup_ws, want=True, seconds=12):
    deadline = time.time() + seconds
    last = []
    while time.time() < deadline:
        try:
            last = parse_json_value(await ws_eval(
                popup_ws,
                "chrome.scripting.getRegisteredContentScripts().then(x=>JSON.stringify(x.map(s=>s.id)))",
                timeout=5,
            ))
            if (("media-sniper-sites" in last) == want):
                return last
        except Exception:
            pass
        await asyncio.sleep(0.4)
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

    # Capture the real Web tab ID while it is still active. A Chrome action
    # popup does not become the active tab; our CDP test popup is a normal tab,
    # so we restore this Web tab to active before requesting optional access.
    try:
        fixture_tab_id = await ws_eval(
            sw_ws(),
            "chrome.tabs.query({active:true,currentWindow:true}).then(t=>t[0]&&t[0].id)",
            timeout=5,
        )
        if not isinstance(fixture_tab_id, int):
            raise RuntimeError("could not resolve active fixture tab")
        step("capture fixture chrome tab", True, fixture_tab_id)
    except Exception as e:
        step("capture fixture chrome tab", False, e)
        return

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

    try:
        before = await get_origins(popup_ws)
        step("no persistent host access by default", before == [], before)
        if before != []:
            return
    except Exception as e:
        step("no persistent host access by default", False, e)
        return

    try:
        active = await ws_eval(
            popup_ws,
            f"chrome.tabs.update({fixture_tab_id},{{active:true}}).then(t=>t.id)",
            timeout=5,
        )
        step("restore fixture as active tab", active == fixture_tab_id, active)
        if active != fixture_tab_id:
            return
    except Exception as e:
        step("restore fixture as active tab", False, e)
        return

    # Exercise the production control itself while the real Web page remains
    # the browser's active tab, matching an actual extension action popup.
    try:
        clicked = await ws_eval(
            popup_ws,
            "(function(){const b=document.getElementById('accessAll'); if(!b) throw new Error('accessAll missing'); b.click(); return true;})()",
            user_gesture=True,
        )
        origins = await wait_origins(popup_ws, True)
        granted = "http://*/*" in origins and "https://*/*" in origins
        step("optional all-sites permission granted via popup", clicked is True and granted, origins)
        if not granted:
            return
    except Exception as e:
        step("optional all-sites permission granted via popup", False, e)
        return

    registered = await wait_registered(popup_ws, True)
    step("persistent detector registered", "media-sniper-sites" in registered, registered)
    if "media-sniper-sites" not in registered:
        return

    try:
        await ws_eval(page["webSocketDebuggerUrl"], "location.reload(); 'reloaded'", timeout=8)
        await asyncio.sleep(2)
        step("reload fixture after host grant", True)
    except Exception as e:
        step("reload fixture after host grant", False, e)
        return

    try:
        items = parse_json_value(await ws_eval(sw_ws(),
            "chrome.storage.session.get('msItems').then(r => JSON.stringify(r.msItems || {}))"))
        flat = [i for arr in items.values() for i in arr]
        step("read msItems", True, f"{len(flat)} items")
    except Exception as e:
        step("read msItems", False, e)
        return

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
        await asyncio.sleep(1)
    step("detected video/audio/hls-variant", all(need.values()), json.dumps(need))
    if not all(need.values()):
        return

    trigger = (
        "chrome.runtime.sendMessage({type:'ms-download', item:{url:'"
        f"http://127.0.0.1:{FIXTURE_PORT}/hls/clip.mp4"
        "', kind:'video', ext:'mp4', title:'e2e-headless-test'}})"
        ".then(r => JSON.stringify(r)).catch(e => JSON.stringify({err: String(e)}))"
    )
    try:
        res = parse_json_value(await ws_eval(popup_ws, trigger))
        accepted = isinstance(res, dict) and res.get("queued") is True
        step("ms-download accepted (popup->SW)", accepted, res)
        if not accepted:
            return
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

    ok_download = bool(final and final.get("state") == "complete")
    step("download reached terminal state", ok_download, final or "never appeared")
    if not ok_download:
        return

    try:
        st = parse_json_value(await ws_eval(popup_ws,
            "chrome.runtime.sendMessage({type:'ms-set-settings',settings:{rootFolder:'e2e-root',minSizeKb:500,blacklist:''}})"
            ".then(r=>JSON.stringify(r)).catch(e=>JSON.stringify({err:String(e)}))"))
        ok_st = isinstance(st, dict) and st.get("saved") and st.get("settings", {}).get("rootFolder") == "e2e-root"
        step("set-settings saved (root sanitized/kept)", bool(ok_st), st)
        if not ok_st:
            return
    except Exception as e:
        step("set-settings saved (root sanitized/kept)", False, e)
        return

    try:
        q = parse_json_value(await ws_eval(popup_ws,
            "chrome.runtime.sendMessage({type:'ms-queue-status'}).then(r=>JSON.stringify(r))"))
        step("queue status", True, q)
    except Exception as e:
        step("queue status", False, e)
        return

    try:
        clicked = await ws_eval(
            popup_ws,
            "(function(){const b=document.getElementById('accessClick'); if(!b) throw new Error('accessClick missing'); b.click(); return true;})()",
            user_gesture=True,
        )
        origins = await wait_origins(popup_ws, False)
        removed = origins == []
        step("persistent host access removable via popup", clicked is True and removed, origins)
        if not removed:
            return
        registered = await wait_registered(popup_ws, False)
        clean = "media-sniper-sites" not in registered
        step("revocation unregisters persistent detector", clean, registered)
    except Exception as e:
        step("persistent host access removable via popup", False, e)
        return

    try:
        await ws_eval(popup_ws,
            "chrome.runtime.sendMessage({type:'ms-set-settings',settings:{rootFolder:'',minSizeKb:500,blacklist:''}})")
    except Exception:
        pass


try:
    asyncio.run(main())
finally:
    verdict["pass"] = bool(verdict["steps"]) and all(s["ok"] for s in verdict["steps"])
    print(json.dumps(verdict, ensure_ascii=False, indent=1), flush=True)
    print("RESULT:", "PASS" if verdict["pass"] else "FAIL", flush=True)

sys.exit(0 if verdict["pass"] else 1)
