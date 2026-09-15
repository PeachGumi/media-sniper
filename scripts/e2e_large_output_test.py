#!/usr/bin/env python3
"""Large-artifact E2E: a real HLS item whose remuxed artifact is well past the
old 768 MiB in-memory ceiling must convert and reach Downloads.

This is the regression test for the field failure
    "ffmpeg job failed: media output exceeds in-memory safety limit (768 MiB)"
and for the frozen progress line
    "変換中… 動画 0s · 出力 0B · 経過 6m32s"

The fixture is generated at test time with the host ffmpeg (~900 MiB of MPEG-TS
across ~75 segments) and served from a local HTTP server. The extension runs
from a functional harness copy whose only change is manifest.host_permissions
(the interactive optional-permission prompt cannot be approved headlessly), so
the packaged artifact itself is never modified.

Run directly, or through scripts/run_e2e.py with MEDIA_SNIPER_E2E_LARGE=1.
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
TARGET_BYTES = 900 * 1024 * 1024
MIN_ARTIFACT_BYTES = 800 * 1024 * 1024  # above the removed 768 MiB guard

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


def make_harness():
    dst = tempfile.mkdtemp(prefix="media-sniper-large-harness-")
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


def fixture_bytes(root):
    hls = os.path.join(root, "hls")
    if not os.path.isdir(hls):
        return 0
    return sum(
        os.path.getsize(os.path.join(hls, name))
        for name in os.listdir(hls)
        if name.startswith("seg") and name.endswith(".ts")
    )


def ensure_fixture(duration):
    """Generate (or reuse) a real HLS fixture bigger than the old 768 MiB cap.

    Generating ~1.2 GiB of MPEG-TS takes a couple of minutes, so the fixture
    lives at a stable path and is reused across runs.
    """
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("ffmpeg is required to generate the large E2E fixture")
    dst = os.environ.get("MEDIA_SNIPER_E2E_LARGE_FIXTURE_DIR") or "/tmp/media-sniper-large-fixture"
    hls = os.path.join(dst, "hls")
    existing = fixture_bytes(dst)
    if existing > MIN_ARTIFACT_BYTES and os.path.exists(os.path.join(hls, "media.m3u8")):
        print("[fixture] reusing", existing, flush=True)
        return dst, existing, True
    os.makedirs(hls, exist_ok=True)
    for name in os.listdir(hls):
        try:
            os.remove(os.path.join(hls, name))
        except OSError:
            pass
    subprocess.run([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        # Noise keeps the encoder busy: without it a synthetic source encodes
        # far below the requested rate and the fixture lands under the ceiling
        # this test exists to cross.
        "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30,noise=alls=30:allf=t",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
        "-t", str(duration),
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-b:v", "32M", "-maxrate", "34M", "-minrate", "28M", "-bufsize", "8M", "-g", "60",
        "-c:a", "aac", "-b:a", "128k",
        "-f", "hls", "-hls_time", "4", "-hls_list_size", "0",
        "-hls_segment_filename", os.path.join(hls, "seg%d.ts"),
        os.path.join(hls, "media.m3u8"),
    ], check=True, timeout=1800)
    with open(os.path.join(hls, "index.html"), "w", encoding="utf-8") as handle:
        handle.write(
            "<!DOCTYPE html><html><head><meta charset='utf-8'>"
            "<title>Large fixture</title></head><body>"
            "<video controls src='player.mp4'></video></body></html>\n"
        )
    total = fixture_bytes(dst)
    print("[fixture] segments bytes", total, flush=True)
    return dst, total, False


def get_json(base, path):
    with urllib.request.urlopen(base + path, timeout=5) as response:
        return json.load(response)


def open_tab(base, url):
    """CDP tab creation needs PUT; a GET returns 405."""
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
    duration = int(os.environ.get("MEDIA_SNIPER_E2E_LARGE_SECONDS", "300"))

    fixture_root, total_bytes, reused_fixture = ensure_fixture(duration)
    harness = make_harness()
    port = free_port()
    fixture_port = free_port()
    base = f"http://127.0.0.1:{port}"
    profile = tempfile.mkdtemp(prefix="media-sniper-large-profile-")
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
        "--no-first-run", "--no-default-browser-check", "--disable-gpu",
        "--autoplay-policy=no-user-gesture-required", "about:blank",
    ], stdout=log, stderr=log)

    processes = [brave, server]
    try:
        step("large fixture is bigger than the removed 768 MiB ceiling",
             total_bytes > MIN_ARTIFACT_BYTES, f"{total_bytes} bytes")
        if total_bytes <= MIN_ARTIFACT_BYTES:
            return

        sw = await find_target(base, lambda t: t.get("type") == "service_worker" and t.get("url", "").endswith("/src/background-entry.js"))
        step("service worker started", sw is not None, str((sw or {}).get("url") or ""))
        if not sw:
            return
        sw_ws = sw["webSocketDebuggerUrl"]

        fixture_url = f"http://127.0.0.1:{fixture_port}/hls/index.html"
        open_tab(base, fixture_url)
        page = await find_target(base, lambda t: t.get("type") == "page" and str(fixture_port) in t.get("url", ""))
        step("fixture page opened", page is not None, str((page or {}).get("url") or ""))
        if not page:
            return
        for stray in [t for t in get_json(base, "/json/list") if t.get("type") == "page" and t.get("url") == "about:blank"]:
            try:
                get_json(base, "/json/close/" + stray.get("id", ""))
            except Exception:
                pass
        tab_id = await evaluate(sw_ws, "chrome.tabs.query({active:true,currentWindow:true}).then(t => t[0] && t[0].id)", timeout=20)
        step("fixture tab registered", isinstance(tab_id, int), tab_id)

        extension_id = sw["url"].split("/")[2]
        open_tab(base, f"chrome-extension://{extension_id}/popup/popup.html")
        popup_target = await find_target(base, lambda t: "popup/popup.html" in t.get("url", ""))
        step("popup context opened", popup_target is not None, str((popup_target or {}).get("url") or ""))
        if not popup_target:
            return
        popup_ws = popup_target["webSocketDebuggerUrl"]

        playlist = f"http://127.0.0.1:{fixture_port}/hls/media.m3u8"
        started = await evaluate(popup_ws, """
          (() => new Promise(function (resolve) {
            chrome.runtime.sendMessage({
              type: 'ms-hls-download', url: %s, kind: 'hls', tabId: %d,
              title: 'Large E2E artifact', pageUrl: %s
            }, function (response) {
              resolve(JSON.stringify({response: response || null, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : null}));
            });
          }))()
        """ % (json.dumps(playlist), tab_id, json.dumps(fixture_url)), timeout=60)
        print("start:", started, flush=True)
        step("large save accepted", "started" in str(started), started)
        try:
            job_key = json.loads(json.loads(started)["response"] if isinstance(started, str) else started)["jobKey"]
        except Exception:
            job_key = None

        deadline = time.time() + 1800
        max_bytes = 0
        byte_readings = []
        final_status = None
        saw_converting = False
        while time.time() < deadline:
            # Poll exactly like the popup does: this is the UI regression that
            # reported "media 0s · output 0B" for the whole job.
            raw = await evaluate(popup_ws, """
              (() => new Promise(function (resolve) {
                chrome.runtime.sendMessage({type: 'ms-hls-status', url: %s, jobKey: %s},
                  function (job) { resolve(JSON.stringify(job || null)); });
              }))()
            """ % (json.dumps(playlist), json.dumps(job_key)), timeout=30)
            job = json.loads(raw) if raw else None
            if job:
                final_status = job
                if job.get("bytes"):
                    max_bytes = max(max_bytes, int(job.get("bytes") or 0))
                    byte_readings.append(int(job.get("bytes") or 0))
                if job.get("status") == "combining":
                    saw_converting = True
                if job.get("status") in ("complete", "failed"):
                    break
            if raw is None:
                break
            await asyncio.sleep(2)

        status = (final_status or {}).get("status")
        error = (final_status or {}).get("error")
        step("large item converted without the in-memory guard",
             "in-memory safety limit" not in str(error or ""), error or "no error")
        step("conversion reported progress instead of a frozen 0 B",
             saw_converting and len(set(byte_readings)) >= 2, f"max={max_bytes} readings={len(set(byte_readings))}")

        # wait for the browser download to finish
        download = None
        deadline = time.time() + 900
        while time.time() < deadline:
            raw = await evaluate(sw_ws,
                "chrome.downloads.search({}).then(x => JSON.stringify(x.map(d => ({state:d.state,error:d.error,bytesReceived:d.bytesReceived,totalBytes:d.totalBytes,filename:d.filename}))))",
                timeout=30)
            rows = json.loads(raw)
            download = next((r for r in rows if "Large E2E" in str(r.get("filename", ""))), None)
            if download and download.get("state") in ("complete", "interrupted"):
                break
            await asyncio.sleep(2)
        step("artifact download completed", bool(download) and download.get("state") == "complete", json.dumps(download))
        if download and download.get("state") == "complete":
            saved = os.path.join(download_dir, os.path.basename(download["filename"]))
            exists = os.path.exists(saved)
            size = os.path.getsize(saved) if exists else 0
            step("saved file is past the old 768 MiB ceiling",
                 exists and size > MIN_ARTIFACT_BYTES,
                 f"{saved} exists={exists} size={size}")
            step("saved bytes match the browser record",
                 size == int(download.get("bytesReceived") or 0), f"disk={size} browser={download.get('bytesReceived')}")
            # A real remux, not a bloated file: the writer device honours
            # positioned writes (an mp4 muxer rewrites its header in place), so
            # an artifact far larger than its source would mean the file system
            # writer appended instead of writing at the reported offsets.
            ratio = size / max(1, total_bytes)
            step("artifact size tracks the source size", 0.6 <= ratio <= 1.15,
                 f"artifact={size} source={total_bytes} ratio={ratio:.3f}")
            probe = shutil.which("ffprobe")
            if probe:
                result = subprocess.run(
                    [probe, "-v", "error", "-show_entries", "format=duration", "-of", "json", saved],
                    capture_output=True, text=True, timeout=180,
                )
                try:
                    probed_duration = float(json.loads(result.stdout or "{}").get("format", {}).get("duration") or 0)
                except Exception:
                    probed_duration = 0
                step("downloaded artifact is a playable mp4",
                     result.returncode == 0 and probed_duration > duration * 0.5,
                     f"rc={result.returncode} duration={probed_duration} expected~{duration} err={result.stderr[:120]}")
            if os.environ.get("MEDIA_SNIPER_E2E_LARGE_KEEP") == "1":
                kept = "/tmp/media-sniper-large-artifact.mp4"
                shutil.copyfile(saved, kept)
                print("[kept]", kept, flush=True)
        else:
            step("saved file is past the old 768 MiB ceiling", False, "download did not complete")

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
        if not reused_fixture:
            shutil.rmtree(fixture_root, ignore_errors=True)
        shutil.rmtree(harness, ignore_errors=True)
    print("LARGE ARTIFACT E2E: " + ("PASS" if verdict["pass"] else "FAIL"), flush=True)


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
