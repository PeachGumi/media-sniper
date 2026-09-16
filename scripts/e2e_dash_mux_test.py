#!/usr/bin/env python3
"""Large DASH mux E2E: a video+audio DASH item whose combined tracks exceed the
old in-memory mux budget (384 MiB) must still be saved.

The reference implementation keeps DASH inputs inside ffmpeg (`-f dash -i
jsfetch:<mpd>`), so track size was never a memory question there. Media Sniper
downloads the tracks itself and muxes them, which used to fail with
"DASH mux input exceeds supported in-memory mux limit (384 MiB combined)".
Tracks are now read through libav's block reader device, so the mux is bounded
by storage instead.

Run directly, or through scripts/run_e2e.py with MEDIA_SNIPER_E2E_DASH=1.
"""
import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import traceback
import urllib.request

try:
    import websockets
except ImportError as exc:  # pragma: no cover - environment check
    raise SystemExit("websockets is required for E2E: pip install websockets") from exc

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DURATION = int(os.environ.get("MEDIA_SNIPER_E2E_DASH_SECONDS", "200"))
MIN_INPUT_BYTES = 420 * 1024 * 1024  # above the removed 384 MiB mux budget
FIXTURE_DIR = os.environ.get("MEDIA_SNIPER_E2E_DASH_FIXTURE_DIR") or "/tmp/media-sniper-dash-fixture"

verdict = {"steps": [], "pass": False}


def step(name, ok, detail=""):
    verdict["steps"].append({"step": name, "ok": bool(ok), "detail": str(detail or "")[:300]})
    print(f"[{'ok ' if ok else 'FAIL'}] {name} {str(detail or '')[:200]}", flush=True)


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


def media_bytes(root):
    total = 0
    for name in os.listdir(root):
        if name.endswith(".m4s"):
            total += os.path.getsize(os.path.join(root, name))
    return total


def ensure_fixture():
    """A DASH presentation whose tracks together exceed the old mux budget."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("ffmpeg is required to generate the DASH E2E fixture")
    dst = FIXTURE_DIR
    os.makedirs(dst, exist_ok=True)
    existing = media_bytes(dst)
    if existing > MIN_INPUT_BYTES and os.path.exists(os.path.join(dst, "dash.mpd")):
        print("[fixture] reusing", existing, flush=True)
        return dst, existing, True
    for name in os.listdir(dst):
        try:
            os.remove(os.path.join(dst, name))
        except OSError:
            pass
    subprocess.run([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30,noise=alls=30:allf=t",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
        "-t", str(DURATION),
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-b:v", "32M", "-maxrate", "34M", "-minrate", "28M", "-bufsize", "8M", "-g", "60",
        "-c:a", "aac", "-b:a", "128k",
        "-f", "dash", "-seg_duration", "4", "-use_timeline", "1", "-use_template", "1",
        os.path.join(dst, "dash.mpd"),
    ], check=True, timeout=1800)
    with open(os.path.join(dst, "index.html"), "w", encoding="utf-8") as handle:
        handle.write("<!DOCTYPE html><html><head><meta charset='utf-8'><title>DASH fixture</title>"
                     "</head><body><video controls></video></body></html>\n")
    total = media_bytes(dst)
    print("[fixture] dash media bytes", total, flush=True)
    return dst, total, False


def make_harness():
    dst = __import__("tempfile").mkdtemp(prefix="media-sniper-dash-harness-")
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


async def main():
    browser = find_browser()
    if not browser:
        raise SystemExit("no Chromium browser found")
    fixture_root, input_bytes, reused = ensure_fixture()
    harness = make_harness()
    port = free_port()
    fixture_port = free_port()
    base = f"http://127.0.0.1:{port}"
    profile = __import__("tempfile").mkdtemp(prefix="media-sniper-dash-profile-")
    download_dir = os.path.join(profile, "downloads")
    os.makedirs(os.path.join(profile, "Default"), exist_ok=True)
    os.makedirs(download_dir, exist_ok=True)
    with open(os.path.join(profile, "Default", "Preferences"), "w", encoding="utf-8") as handle:
        json.dump({"download": {"prompt_for_download": False, "default_directory": download_dir, "directory_upgrade": True}}, handle)
    log = open(os.path.join(profile, "browser.log"), "w", encoding="utf-8")
    server = subprocess.Popen(
        [sys.executable, os.path.join(REPO_ROOT, "scripts", "e2e_fixture_server.py"), str(fixture_port), fixture_root],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    brave = subprocess.Popen([
        browser, "--headless=new", f"--remote-debugging-port={port}", f"--user-data-dir={profile}",
        f"--disable-extensions-except={harness}", f"--load-extension={harness}",
        "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank",
    ], stdout=log, stderr=log)
    processes = [brave, server]
    try:
        step("fixture tracks exceed the removed mux budget", input_bytes > MIN_INPUT_BYTES, f"{input_bytes} bytes")
        if input_bytes <= MIN_INPUT_BYTES:
            return
        sw = await find_target(base, lambda t: t.get("type") == "service_worker" and t.get("url", "").endswith("/src/background-entry.js"))
        step("service worker started", sw is not None, str((sw or {}).get("url") or ""))
        if not sw:
            return
        sw_ws = sw["webSocketDebuggerUrl"]

        fixture_url = f"http://127.0.0.1:{fixture_port}/index.html"
        open_tab(base, fixture_url)
        page = await find_target(base, lambda t: t.get("type") == "page" and str(fixture_port) in t.get("url", ""))
        step("fixture page opened", page is not None, str((page or {}).get("url") or ""))
        if not page:
            return
        tab_id = await evaluate(sw_ws, "chrome.tabs.query({active:true,currentWindow:true}).then(t => t[0] && t[0].id)", timeout=20)

        extension_id = sw["url"].split("/")[2]
        open_tab(base, f"chrome-extension://{extension_id}/popup/popup.html")
        popup = await find_target(base, lambda t: "popup/popup.html" in t.get("url", ""))
        step("popup context opened", popup is not None, str((popup or {}).get("url") or ""))
        if not popup:
            return
        popup_ws = popup["webSocketDebuggerUrl"]

        mpd = f"http://127.0.0.1:{fixture_port}/dash.mpd"
        started = await evaluate(popup_ws, """
          (() => new Promise(function (resolve) {
            chrome.runtime.sendMessage({
              type: 'ms-hls-download', url: %s, dashEntry: 0, dashType: 'video', kind: 'dash',
              tabId: %d, title: 'DASH mux E2E', pageUrl: %s
            }, function (response) {
              resolve(JSON.stringify({response: response || null, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : null}));
            });
          }))()
        """ % (json.dumps(mpd), tab_id, json.dumps(fixture_url)), timeout=60)
        step("dash save accepted", "started" in str(started), started)
        try:
            job_key = json.loads(json.loads(started)["response"])["jobKey"]
        except Exception:
            job_key = None

        async def status():
            raw = await evaluate(popup_ws, """
              (() => new Promise(function (resolve) {
                chrome.runtime.sendMessage({type: 'ms-hls-status', url: %s, jobKey: %s, dashEntry: 0},
                  function (job) { resolve(JSON.stringify(job || null)); });
              }))()
            """ % (json.dumps(mpd), json.dumps(job_key)), timeout=30)
            return json.loads(raw) if raw else None

        deadline = time.time() + 1200
        final = None
        states = []
        while time.time() < deadline:
            job = await status()
            if job:
                label = "%s/%s" % (job.get("status"), job.get("done"))
                if not states or states[-1] != label:
                    states.append(label)
                if job.get("status") in ("complete", "failed"):
                    final = job
                    break
            await asyncio.sleep(2)
        step("dash job finished", final is not None, f"states={states[:6]}")
        step("dash mux did not hit the in-memory budget",
             "in-memory mux limit" not in str((final or {}).get("error") or ""),
             str((final or {}).get("error") or "no error"))
        if (final or {}).get("status") != "complete":
            return

        download = None
        deadline = time.time() + 900
        while time.time() < deadline:
            raw = await evaluate(sw_ws,
                "chrome.downloads.search({}).then(x => JSON.stringify(x.map(d => ({state:d.state,error:d.error,bytesReceived:d.bytesReceived,filename:d.filename}))))",
                timeout=30)
            rows = json.loads(raw)
            download = next((r for r in rows if "DASH mux" in str(r.get("filename", ""))), None)
            if download and download.get("state") in ("complete", "interrupted"):
                break
            await asyncio.sleep(2)
        step("muxed artifact reached Downloads", bool(download) and download.get("state") == "complete", json.dumps(download))
        if not (download and download.get("state") == "complete"):
            return
        saved = os.path.join(download_dir, os.path.basename(download["filename"]))
        size = os.path.getsize(saved) if os.path.exists(saved) else 0
        step("muxed artifact is past the old mux budget", size > 384 * 1024 * 1024, f"{saved} size={size}")
        probe = shutil.which("ffprobe")
        if probe:
            result = subprocess.run(
                [probe, "-v", "error", "-show_entries", "stream=codec_type", "-show_entries", "format=duration", "-of", "json", saved],
                capture_output=True, text=True, timeout=300,
            )
            try:
                info = json.loads(result.stdout or "{}")
                kinds = sorted({s.get("codec_type") for s in info.get("streams", [])})
                probed = float(info.get("format", {}).get("duration") or 0)
            except Exception:
                kinds, probed = [], 0
            step("muxed artifact has video and audio", kinds == ["audio", "video"], f"rc={result.returncode} streams={kinds}")
            step("muxed artifact is playable", result.returncode == 0 and probed > DURATION * 0.5,
                 f"rc={result.returncode} duration={probed} expected~{DURATION} err={result.stderr[:120]}")
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
        shutil.rmtree(harness, ignore_errors=True)
        if not reused:
            shutil.rmtree(fixture_root, ignore_errors=True)
    print("DASH MUX E2E: " + ("PASS" if verdict["pass"] else "FAIL"), flush=True)


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
