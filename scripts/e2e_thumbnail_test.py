#!/usr/bin/env python3
"""Thumbnail E2E: every detected media entry shows a still, taken from the page.

VDH shows a thumbnail per entry; Media Sniper did not. The content script now
produces one (a readable frame from the element that is playing the item, else
the element's poster, else the page's social image) and the worker caches it in
memory for the popup. This test drives the real browser and asserts both the
data path (ms-item-thumb) and what the popup actually renders, including the
case where there is nothing to show.

Run directly, or through scripts/run_e2e.py with MEDIA_SNIPER_E2E_THUMB=1.
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
import urllib.request

try:
    import websockets
except ImportError as exc:  # pragma: no cover - environment check
    raise SystemExit("websockets is required for E2E: pip install websockets") from exc

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Two origins on the same fixture server: the page, and the "CDN" the poster /
# manifest live on (ungranted in the harness, like pbs.twimg.com for a tweet).
PAGE_HOST = "127.0.0.1"
MEDIA_HOST = "localhost"
verdict = {"steps": [], "pass": False}


def step(name, ok, detail=""):
    verdict["steps"].append({"step": name, "ok": bool(ok), "detail": str(detail or "")[:400]})
    print(f"[{'ok ' if ok else 'FAIL'}] {name} {str(detail or '')[:300]}", flush=True)


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


def make_harness():
    dst = tempfile.mkdtemp(prefix="media-sniper-thumb-harness-")
    shutil.rmtree(dst)
    shutil.copytree(REPO_ROOT, dst)
    manifest_path = os.path.join(dst, "manifest.json")
    with open(manifest_path, encoding="utf-8") as handle:
        manifest = json.load(handle)
    manifest["host_permissions"] = ["http://127.0.0.1/*"]
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return dst


def make_fixture():
    dst = tempfile.mkdtemp(prefix="media-sniper-thumb-fixture-")
    page = os.path.join(dst, "thumb")
    os.makedirs(page, exist_ok=True)
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12", "-t", "2",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        os.path.join(page, "clip.mp4"),
    ], check=True, timeout=120)
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=0x3355aa:s=160x90", "-frames:v", "1",
        os.path.join(page, "poster.jpg"),
    ], check=True, timeout=120)
    with open(os.path.join(page, "index.html"), "w", encoding="utf-8") as handle:
        handle.write(
            "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Thumb poster</title>"
            "</head><body>"
            "<video controls width='320' poster='poster.jpg' src='clip.mp4'></video>"
            "</body></html>\n"
        )
    # No media element at all: the item is discovered from the network request,
    # so the page's social image (or nothing) is the only thumbnail source.
    with open(os.path.join(page, "social.html"), "w", encoding="utf-8") as handle:
        handle.write(
            "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Thumb social</title>"
            "<meta property='og:image' content='cover.png'></head><body>"
            "<script>fetch('stream.m3u8').then(function(r){return r.text();}).catch(function(){});</script>"
            "</body></html>\n"
        )
    with open(os.path.join(page, "empty.html"), "w", encoding="utf-8") as handle:
        handle.write(
            "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Thumb empty</title></head><body>"
            "<script>fetch('stream.m3u8').then(function(r){return r.text();}).catch(function(){});</script>"
            "</body></html>\n"
        )
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=0x22aa55:s=160x90", "-frames:v", "1",
        os.path.join(page, "cover.png"),
    ], check=True, timeout=120)
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=0xaa3355:s=320x180", "-frames:v", "1",
        os.path.join(page, "xs_poster.jpg"),
    ], check=True, timeout=120)
    # The shape a tweet has: media, poster and the page's og:image all live on
    # another origin than the page, and the player cannot give a readable frame.
    # Same-origin fixtures missed this shape entirely.
    with open(os.path.join(page, "xtweet.html"), "w", encoding="utf-8") as handle:
        handle.write(
            "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Thumb x-shape</title>"
            f"<meta property='og:image' content='http://{MEDIA_HOST}/thumb/cover.png'>"
            "</head><body>"
            "<article><img src='cover.png' width='48' height='48' alt='avatar'>"
            f"<video controls width='320' poster='http://{MEDIA_HOST}/thumb/xs_poster.jpg' "
            f"src='http://{MEDIA_HOST}/thumb/stream.m3u8'></video></article>"
            "</body></html>\n"
        )
    # A player that only exists seconds after the popup opened: the first
    # thumbnail request finds nothing, so the popup has to retry.
    with open(os.path.join(page, "late.html"), "w", encoding="utf-8") as handle:
        handle.write(
            "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Thumb late</title></head><body>"
            "<div id='slot'></div><script>"
            "setTimeout(function(){"
            "var v=document.createElement('video');v.controls=true;"
            "v.poster='poster.jpg';v.src='clip.mp4';"
            "document.getElementById('slot').appendChild(v);},6000);"
            "</script></body></html>\n"
        )
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
        "-t", "4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "64k", "-f", "hls", "-hls_time", "2", "-hls_list_size", "0",
        "-hls_segment_filename", os.path.join(page, "seg%d.ts"),
        os.path.join(page, "stream.m3u8"),
    ], check=True, timeout=200)
    print("[fixture] thumbnail pages ready", flush=True)
    return dst


def get_json(base, path):
    with urllib.request.urlopen(base + path, timeout=5) as response:
        return json.load(response)


def open_tab(base, url):
    request = urllib.request.Request(base + "/json/new?" + url, method="PUT")
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


async def evaluate(ws_url, expression, timeout=60):
    async with websockets.connect(ws_url, max_size=50 * 1024 * 1024) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
        await ws.recv()
        await ws.send(json.dumps({
            "id": 2,
            "method": "Runtime.evaluate",
            "params": {"expression": expression, "awaitPromise": True, "returnByValue": True, "userGesture": True},
        }))
        deadline = time.time() + timeout
        while time.time() < deadline:
            message = json.loads(await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.time())))
            if message.get("id") != 2:
                continue
            result = message.get("result", {})
            if result.get("exceptionDetails"):
                raise RuntimeError(json.dumps(result["exceptionDetails"])[:600])
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


async def items_for(popup_ws, tab_id, deadline_seconds=30):
    deadline = time.time() + deadline_seconds
    while time.time() < deadline:
        raw = await evaluate(popup_ws, "chrome.runtime.sendMessage({type:'ms-get-items', tabId: %d}).then(r => JSON.stringify((r && r.items) || []))" % tab_id, timeout=20)
        items = json.loads(raw) if raw else []
        if items:
            return items
        await asyncio.sleep(0.5)
    return []


async def hydrate_popup(popup_ws, page_url):
    """popup.html opens as a normal tab in this harness (it is itself the active
    tab), so drive the same background message + render path the toolbar popup
    uses against the fixture tab."""
    raw = await evaluate(popup_ws, """
      chrome.tabs.query({url: %s}).then(function (tabs) {
        if (!tabs.length) return 0;
        const fixture = tabs[0];
        return chrome.runtime.sendMessage({type: 'ms-get-items', tabId: fixture.id}).then(function (resp) {
          tabId = fixture.id;
          pageUrl = fixture.url;
          items = (resp && resp.items) || [];
          render();
          return items.length;
        });
      })
    """ % json.dumps(page_url), timeout=40)
    return raw


async def thumb_for(popup_ws, url, item_key, tab_id):
    raw = await evaluate(popup_ws, """
      (() => new Promise(function (resolve) {
        chrome.runtime.sendMessage({type: 'ms-item-thumb', url: %s, itemKey: %s, tabId: %s},
          function (resp) { resolve(JSON.stringify(resp || null)); });
      }))()
    """ % (json.dumps(url), json.dumps(item_key), json.dumps(tab_id)), timeout=60)
    return json.loads(raw) if raw else None


async def popup_thumbs(popup_ws):
    raw = await evaluate(popup_ws, """
      (() => {
        const rows = Array.from(document.querySelectorAll('#list .item'));
        return JSON.stringify(rows.map(function (row) {
          const img = row.querySelector('img.thumb');
          return {
            text: (row.textContent || '').slice(0, 60),
            hasThumb: !!img,
            src: img ? String(img.src).slice(0, 40) : null,
            empty: img ? img.className.indexOf('empty') !== -1 : null,
            source: img ? (img.dataset ? img.dataset.source || null : null) : null,
          };
        }));
      })()
    """, timeout=30)
    return json.loads(raw) if raw else []


async def main():
    browser = find_browser()
    if not browser:
        raise SystemExit("no Chromium browser found")
    fixture_root = make_fixture()
    harness = make_harness()
    port = free_port()
    fixture_port = free_port()
    base = f"http://127.0.0.1:{port}"
    profile = tempfile.mkdtemp(prefix="media-sniper-thumb-profile-")
    download_dir = os.path.join(profile, "downloads")
    os.makedirs(os.path.join(profile, "Default"), exist_ok=True)
    os.makedirs(download_dir, exist_ok=True)
    log = open(os.path.join(profile, "browser.log"), "w", encoding="utf-8")
    server = subprocess.Popen(
        [sys.executable, os.path.join(REPO_ROOT, "scripts", "e2e_fixture_server.py"), str(fixture_port), fixture_root],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    brave = subprocess.Popen([
        browser, "--headless=new", f"--remote-debugging-port={port}", f"--user-data-dir={profile}",
        f"--disable-extensions-except={harness}", f"--load-extension={harness}",
        "--no-first-run", "--no-default-browser-check", "--disable-gpu",
        "--autoplay-policy=no-user-gesture-required", "about:blank",
    ], stdout=log, stderr=log)
    processes = [brave, server]
    try:
        sw = await find_target(base, lambda t: t.get("type") == "service_worker" and t.get("url", "").endswith("/src/background-entry.js"))
        step("service worker started", sw is not None, str((sw or {}).get("url") or ""))
        if not sw:
            return
        sw_ws = sw["webSocketDebuggerUrl"]
        extension_id = sw["url"].split("/")[2]

        popup_url = f"chrome-extension://{extension_id}/popup/popup.html"
        open_tab(base, popup_url)
        popup_target = await find_target(base, lambda t: "popup/popup.html" in t.get("url", ""))
        step("popup context opened", popup_target is not None, str((popup_target or {}).get("url") or ""))
        if not popup_target:
            return
        popup_ws = popup_target["webSocketDebuggerUrl"]

        # --- poster page ------------------------------------------------------
        page_url = f"http://127.0.0.1:{fixture_port}/thumb/index.html"
        open_tab(base, page_url)
        page = await find_target(base, lambda t: t.get("type") == "page" and "thumb/index.html" in t.get("url", ""))
        step("poster fixture page opened", page is not None, str((page or {}).get("url") or ""))
        if not page:
            return
        await evaluate(sw_ws, "chrome.tabs.query({active:true,currentWindow:true}).then(t => t[0] && t[0].id)", timeout=20)
        await asyncio.sleep(3)
        tab_id = await evaluate(sw_ws, f"chrome.tabs.query({{url: '{page_url}'}}).then(t => t[0] && t[0].id)", timeout=20)
        items = await items_for(popup_ws, tab_id)
        step("fixture media detected", any(i.get("url", "").endswith("clip.mp4") for i in items),
             json.dumps([i.get("url") for i in items])[:200])
        video = next((i for i in items if str(i.get("url", "")).endswith("clip.mp4")), None)
        if not video:
            return
        # The content script must be reachable in this tab at all, otherwise the
        # thumbnail request has nowhere to go (site not granted, frame gone).
        diag = await evaluate(popup_ws, """
          (async () => {
            const out = {};
            try { out.scan = JSON.stringify(await chrome.tabs.sendMessage(%d, {type: 'ms-scan'})); }
            catch (e) { out.scanError = String(e && e.message || e); }
            try { out.thumb = JSON.stringify(await chrome.tabs.sendMessage(%d, {type: 'ms-thumbnail', url: %s})); }
            catch (e) { out.thumbError = String(e && e.message || e); }
            return JSON.stringify(out);
          })()
        """ % (tab_id or -1, tab_id or -1, json.dumps(video.get("url"))), timeout=40)
        step("content script answers both messages in the fixture tab",
             "scanError" not in str(diag) and "thumbError" not in str(diag), str(diag)[:300])

        raw_item = await evaluate(popup_ws, """
          (() => new Promise(function (resolve) {
            chrome.runtime.sendMessage({type: 'ms-item-thumb', url: %s, itemKey: %s, tabId: %d},
              function (resp) {
                resolve(JSON.stringify({resp: resp || null, lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null}));
              });
          }))()
        """ % (json.dumps(video.get("url")), json.dumps(video.get("key")), tab_id or -1), timeout=40)
        step("ms-item-thumb round trip returns a still",
             '"thumb":"data:image' in str(raw_item) and 'lastError":null' in str(raw_item), str(raw_item)[:400])

        thumb = await thumb_for(popup_ws, video.get("url"), video.get("key"), tab_id)
        step("the page supplies the thumbnail",
             bool(thumb) and str(thumb.get("thumb", "")).startswith("data:image/")
             and str(thumb.get("thumbSource", "")).split("-")[0] in ("poster", "frame"),
             json.dumps({"source": (thumb or {}).get("thumbSource"), "len": len(str((thumb or {}).get("thumb") or ""))})[:200])
        again = await thumb_for(popup_ws, video.get("url"), video.get("key"), tab_id)
        step("a second request is served from the worker cache", bool(again) and again.get("cached") is True,
             json.dumps({k: v for k, v in (again or {}).items() if k != "thumb"})[:200])

        # --- what the popup actually renders ---------------------------------
        hydrated = await hydrate_popup(popup_ws, page_url)
        step("popup hydrated from the fixture tab", isinstance(hydrated, int) and hydrated > 0, repr(hydrated))
        await asyncio.sleep(3)
        rows = await popup_thumbs(popup_ws)
        step("popup renders a still per entry", bool(rows) and all(r.get("hasThumb") for r in rows), json.dumps(rows)[:300])
        step("popup still is real image data",
             bool(rows) and all(str(r.get("src") or "").startswith("data:image") for r in rows),
             json.dumps([r.get("src") for r in rows])[:200])

        # --- page with only a social image -----------------------------------
        social_url = f"http://127.0.0.1:{fixture_port}/thumb/social.html"
        open_tab(base, social_url)
        social_page = await find_target(base, lambda t: t.get("type") == "page" and "thumb/social.html" in t.get("url", ""))
        step("social fixture page opened", social_page is not None, str((social_page or {}).get("url") or ""))
        await asyncio.sleep(3)
        social_tab = await evaluate(sw_ws, f"chrome.tabs.query({{url: '{social_url}'}}).then(t => t[0] && t[0].id)", timeout=20)
        social_items = await items_for(popup_ws, social_tab)
        step("element-less page still yields an item", bool(social_items), json.dumps([i.get("url") for i in social_items])[:200])
        social_video = next((i for i in social_items if "stream.m3u8" in str(i.get("url", ""))), None)
        social_thumb = await thumb_for(popup_ws, social_video.get("url"), social_video.get("key"), social_tab) if social_video else None
        step("page social image is used when the page has no media element",
             bool(social_thumb) and str(social_thumb.get("thumbSource", "")).startswith("page")
             and str(social_thumb.get("thumb", "")).startswith("data:image/"),
             json.dumps({"source": (social_thumb or {}).get("thumbSource"), "len": len(str((social_thumb or {}).get("thumb") or ""))})[:200])

        # --- nothing to show --------------------------------------------------
        empty_url = f"http://127.0.0.1:{fixture_port}/thumb/empty.html"
        open_tab(base, empty_url)
        await find_target(base, lambda t: t.get("type") == "page" and "thumb/empty.html" in t.get("url", ""))
        await asyncio.sleep(3)
        empty_tab = await evaluate(sw_ws, f"chrome.tabs.query({{url: '{empty_url}'}}).then(t => t[0] && t[0].id)", timeout=20)
        empty_items = await items_for(popup_ws, empty_tab)
        empty_video = next((i for i in empty_items if "stream.m3u8" in str(i.get("url", ""))), None)
        empty_thumb = await thumb_for(popup_ws, empty_video.get("url"), empty_video.get("key"), empty_tab) if empty_video else {"thumb": None}
        empty_rows = await hydrate_popup(popup_ws, empty_url)
        # the popup retries a few times before it settles on the placeholder
        await asyncio.sleep(17)
        empty_rendered = await popup_thumbs(popup_ws)
        step("popup keeps the placeholder without a source",
             isinstance(empty_rows, int) and empty_rows > 0
             and bool(empty_rendered) and all(r.get("empty") for r in empty_rendered),
             json.dumps(empty_rendered)[:200])
        step("no source means no thumbnail (popup keeps the placeholder)", not (empty_thumb or {}).get("thumb"),
             json.dumps({k: v for k, v in (empty_thumb or {}).items() if k != "thumb"})[:200])

        # --- the tweet shape: cross-origin poster, no readable frame ---------
        print("=== x-shaped page: poster on a second origin ===", flush=True)
        x_url = f"http://{PAGE_HOST}:{fixture_port}/thumb/xtweet.html"
        open_tab(base, x_url)
        await find_target(base, lambda t: t.get("type") == "page" and "thumb/xtweet.html" in t.get("url", ""))
        await asyncio.sleep(3)
        x_items = await items_for(popup_ws, await evaluate(sw_ws, f"chrome.tabs.query({{url: '{x_url}'}}).then(t => t[0] && t[0].id)", timeout=20))
        x_video = next((i for i in x_items if "stream.m3u8" in str(i.get("url", ""))), None)
        step("x-shape: the manifest is detected", bool(x_video), json.dumps([i.get("url") for i in x_items])[:200])
        if x_video:
            x_thumb = await thumb_for(popup_ws, x_video.get("url"), x_video.get("key"), x_video.get("tabId"))
            step("x-shape: a thumbnail is produced (poster on another origin)",
                 bool(x_thumb) and bool((x_thumb or {}).get("thumb")),
                 json.dumps({"source": (x_thumb or {}).get("thumbSource"), "len": len(str((x_thumb or {}).get("thumb") or ""))})[:200])
            await hydrate_popup(popup_ws, x_url)
            await asyncio.sleep(3)
            x_rows = await popup_thumbs(popup_ws)
            step("x-shape: the popup renders it",
                 bool(x_rows) and all(str(r.get("src") or "") not in ("", "None") for r in x_rows),
                 json.dumps(x_rows)[:300])
            step("x-shape: the popup did not fall back to the placeholder",
                 bool(x_rows) and all(not r.get("empty") for r in x_rows),
                 json.dumps(x_rows)[:300])

        # --- a player that appears late (the popup must retry) --------------
        print("=== late player: detection and the popup retry ===", flush=True)
        late_url = f"http://{PAGE_HOST}:{fixture_port}/thumb/late.html"
        open_tab(base, late_url)
        await find_target(base, lambda t: t.get("type") == "page" and "thumb/late.html" in t.get("url", ""))
        await asyncio.sleep(9)
        late_hydrated = await hydrate_popup(popup_ws, late_url)
        step("late player: the item is detected once the player appears",
             isinstance(late_hydrated, int) and late_hydrated > 0, repr(late_hydrated))
        await asyncio.sleep(12)
        late_rows = await popup_thumbs(popup_ws)
        step("late player: a thumbnail appears after a retry",
             bool(late_rows) and all(not r.get("empty") and str(r.get("src") or "").startswith("data:image") for r in late_rows),
             json.dumps(late_rows)[:300])

        verdict["pass"] = all(item["ok"] for item in verdict["steps"])
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
        for process in processes:
            try:
                process.wait(timeout=10)
            except Exception:
                try:
                    process.kill()
                except Exception:
                    pass
        log.close()
        shutil.rmtree(profile, ignore_errors=True)
        shutil.rmtree(fixture_root, ignore_errors=True)
        shutil.rmtree(harness, ignore_errors=True)
    print("THUMBNAIL E2E: " + ("PASS" if verdict["pass"] else "FAIL"), flush=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        verdict["pass"] = False
    finally:
        if not verdict["pass"]:
            print(json.dumps(verdict, ensure_ascii=False, indent=1), flush=True)
            sys.exit(1)
