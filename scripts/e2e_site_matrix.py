#!/usr/bin/env python3
"""Site matrix measurement for the detection adapters.

VDH ships per-site content scripts (facebook, instagram, vk, ok.ru, bilibili,
iq, canva, chaturbate, twitcasting, vimeo, kick, youtube). Media Sniper has
YouTube plus generic detection, so the question this answers is concrete: on
which of those sites does the generic layer find nothing, and why.

For each URL it reports what the extension detected (items), what the page's own
player is doing (video element state) and whether the page is a login/consent
wall (in which case a zero result says nothing about the extension).

Usage: python3 scripts/e2e_site_matrix.py [url ...]   (defaults below)
"""
import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.parse
import urllib.request

try:
    import websockets
except ImportError as exc:  # pragma: no cover
    raise SystemExit("websockets is required: pip install websockets") from exc

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WAIT_SECONDS = int(os.environ.get("MEDIA_SNIPER_MATRIX_WAIT", "22"))

DEFAULT_URLS = [
    "https://vimeo.com/76979871",
    "https://www.bilibili.com/video/BV1GJ411x7h7",
    "https://kick.com/xqc",
    "https://ok.ru/video/1876738110422",
    "https://www.facebook.com/watch/?v=10153231379946729",
    "https://www.instagram.com/p/CqLM8XwtWnH/",
    "https://x.com/CuteIdolSunna/status/2099586589567451609",
]

verdict = {"sites": [], "pass": False}


def find_browser():
    env_browser = os.environ.get("MEDIA_SNIPER_BRAVE")
    if env_browser and os.path.exists(env_browser):
        return env_browser
    for candidate in [
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        shutil.which("brave-browser") or "",
        shutil.which("google-chrome") or "",
    ]:
        if candidate and os.path.exists(candidate):
            return candidate
    return None


def free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def make_harness(grant_all):
    dst = tempfile.mkdtemp(prefix="media-sniper-matrix-harness-")
    shutil.rmtree(dst)
    shutil.copytree(REPO_ROOT, dst, ignore=shutil.ignore_patterns(".git", ".venv", "node_modules", "media-sniper.zip"))
    manifest_path = os.path.join(dst, "manifest.json")
    with open(manifest_path, encoding="utf-8") as handle:
        manifest = json.load(handle)
    if grant_all:
        manifest["host_permissions"] = ["http://*/*", "https://*/*"]
    else:
        manifest["host_permissions"] = ["http://127.0.0.1/*"]
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return dst


def get_json(base, path):
    with urllib.request.urlopen(base + path, timeout=5) as response:
        return json.load(response)


def open_tab(base, url):
    request = urllib.request.Request(base + "/json/new?" + urllib.parse.quote(url, safe=":/?=&"), method="PUT")
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


async def evaluate(ws_url, expression, timeout=40):
    async with websockets.connect(ws_url, max_size=50 * 1024 * 1024) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
        await ws.recv()
        await ws.send(json.dumps({
            "id": 2,
            "method": "Runtime.evaluate",
            "params": {"expression": expression, "awaitPromise": True, "returnByValue": True},
        }))
        deadline = time.time() + timeout
        while time.time() < deadline:
            message = json.loads(await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.time())))
            if message.get("id") != 2:
                continue
            result = message.get("result", {})
            if result.get("exceptionDetails"):
                return {"__error": json.dumps(result["exceptionDetails"])[:200]}
            remote = result.get("result", {})
            return remote.get("value", remote.get("description"))
    raise TimeoutError("Runtime.evaluate timed out")


async def find_target(base, predicate, seconds=40):
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            for target in get_json(base, "/json/list"):
                if predicate(target):
                    return target
        except Exception:
            pass
        await asyncio.sleep(0.25)
    return None


PAGE_PROBE = """
(() => {
  const vids = Array.from(document.querySelectorAll('video'));
  const playing = vids.map(function (v) {
    return {
      src: (v.currentSrc || v.src || '').slice(0, 90),
      readyState: v.readyState,
      duration: Math.round(v.duration || 0),
      paused: v.paused,
      width: v.videoWidth || 0,
    };
  }).filter(function (v) { return v.readyState > 0 || v.src; });
  const html = document.documentElement.innerHTML || '';
  const loginish = /log ?in|sign ?in|ログイン|continue with|password/i.test((document.body ? document.body.innerText : '').slice(0, 4000));
  const wall = /captcha|verify you are human|unusual traffic|are you a robot|challenge/i.test(html.slice(0, 20000));
  const manifests = (html.match(/https?:\\/\\/[^"'\\\\ ]+\\.(m3u8|mpd)/g) || []).slice(0, 3).map(function (u) { return u.slice(0, 90); });
  return JSON.stringify({
    title: document.title.slice(0, 80),
    videos: playing,
    hasVideoTag: vids.length,
    loginish: loginish,
    botWall: wall,
    manifestsInHtml: manifests,
  });
})()
"""


async def main():
    urls = sys.argv[1:] or DEFAULT_URLS
    browser = find_browser()
    if not browser:
        raise SystemExit("no Chromium browser found")
    harness = make_harness(True)
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    profile = tempfile.mkdtemp(prefix="media-sniper-matrix-profile-")
    os.makedirs(os.path.join(profile, "Default"), exist_ok=True)
    log = open(os.path.join(profile, "browser.log"), "w", encoding="utf-8")
    brave = subprocess.Popen([
        browser, "--headless=new", f"--remote-debugging-port={port}", f"--user-data-dir={profile}",
        f"--disable-extensions-except={harness}", f"--load-extension={harness}",
        "--no-first-run", "--no-default-browser-check", "--disable-gpu",
        "--autoplay-policy=no-user-gesture-required", "about:blank",
    ], stdout=log, stderr=log)
    try:
        sw = await find_target(base, lambda t: t.get("type") == "service_worker" and t.get("url", "").endswith("/src/background-entry.js"))
        if not sw:
            raise SystemExit("no service worker")
        sw_ws = sw["webSocketDebuggerUrl"]
        ext_id = sw["url"].split("/")[2]
        open_tab(base, f"chrome-extension://{ext_id}/popup/popup.html")
        popup = await find_target(base, lambda t: "popup/popup.html" in t.get("url", ""))
        popup_ws = popup["webSocketDebuggerUrl"]

        for url in urls:
            host = urllib.parse.urlparse(url).netloc
            open_tab(base, url)
            page = await find_target(base, lambda t, u=url: t.get("type") == "page" and t.get("url", "").startswith(u[:60]))
            entry = {"url": url, "host": host, "items": [], "page": None, "fetches": 0}
            if not page:
                entry["error"] = "tab did not open"
                verdict["sites"].append(entry)
                print(f"[--] {host}: tab did not open", flush=True)
                continue
            page_ws = page["webSocketDebuggerUrl"]
            await asyncio.sleep(WAIT_SECONDS)
            try:
                probe = await evaluate(page_ws, PAGE_PROBE, timeout=30)
                entry["page"] = json.loads(probe) if isinstance(probe, str) else probe
            except Exception as exc:
                entry["page"] = {"__error": str(exc)[:120]}
            try:
                tab_id = await evaluate(sw_ws, f"chrome.tabs.query({{url: {json.dumps(url[:80])} + '*'}}).then(t => t[0] && t[0].id)", timeout=15)
            except Exception:
                tab_id = None
            if tab_id is None:
                # fall back: the active tab of the window
                tab_id = await evaluate(sw_ws, "chrome.tabs.query({active:true,currentWindow:true}).then(t => t[0] && t[0].id)", timeout=15)
            items_raw = await evaluate(popup_ws,
                "chrome.runtime.sendMessage({type:'ms-get-items', tabId: %s}).then(r => JSON.stringify((r && r.items) || []))" % json.dumps(tab_id),
                timeout=30)
            try:
                items = json.loads(items_raw) if items_raw else []
            except Exception:
                items = []
            entry["items"] = [{"url": (i.get("url") or "")[:100], "kind": i.get("kind"), "via": i.get("via"), "size": i.get("size")} for i in items]
            verdict["sites"].append(entry)
            page_info = entry.get("page") or {}
            flags = []
            if page_info.get("botWall"):
                flags.append("BOT-WALL")
            if page_info.get("loginish"):
                flags.append("login-ish")
            vids = page_info.get("videos") or []
            print(f"[{'ok ' if entry['items'] else '-- '}] {host}: items={len(entry['items'])} videos={len(vids)} "
                  f"{' '.join(flags)} {json.dumps(entry['items'][:2])[:160]}", flush=True)

        verdict["pass"] = True
    finally:
        for process in (brave,):
            if process.poll() is None:
                process.terminate()
        try:
            brave.wait(timeout=10)
        except Exception:
            brave.kill()
        log.close()
        shutil.rmtree(profile, ignore_errors=True)
        shutil.rmtree(harness, ignore_errors=True)
    print("SITE MATRIX: " + json.dumps({
        s["host"]: {"items": len(s.get("items") or []), "videos": len(((s.get("page") or {}).get("videos") or [])),
                    "botWall": bool((s.get("page") or {}).get("botWall")),
                    "login": bool((s.get("page") or {}).get("loginish"))}
        for s in verdict["sites"]}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        sys.exit(1)
