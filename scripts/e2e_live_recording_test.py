#!/usr/bin/env python3
"""Live-recording E2E: start recording a live HLS stream, stop it, and keep the
partial file.

This is the regression test for the DVR path. The reference implementation
(VDH) interrupts a running ffmpeg with `ffmpeg_interrupt`, which the bundled
libav build does not expose at all, so stopping used to leave ffmpeg running
until the stream ended. The fixture playlist has no EXT-X-ENDLIST and its
sliding window keeps growing, so the recording can only finish if the stop
actually interrupts ffmpeg.

Run directly, or through scripts/run_e2e.py with MEDIA_SNIPER_E2E_LIVE=1.
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
RECORD_SECONDS = int(os.environ.get("MEDIA_SNIPER_E2E_LIVE_SECONDS", "12"))
STOP_DEADLINE_SECONDS = 45

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
    dst = tempfile.mkdtemp(prefix="media-sniper-live-harness-")
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
    """Transport stream segments with one continuous timeline for the live
    playlist to serve. Identical or re-timestamped segments would make ffmpeg's
    demuxer discard packets ('non-monotonous DTS'), which would hide whether the
    stop interrupt works."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("ffmpeg is required to generate the live E2E fixture")
    dst = tempfile.mkdtemp(prefix="media-sniper-live-fixture-")
    hls = os.path.join(dst, "hls")
    os.makedirs(hls, exist_ok=True)
    subprocess.run([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24",
        "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000",
        "-t", "60", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-g", "48", "-c:a", "aac", "-b:a", "96k",
        "-f", "hls", "-hls_time", "2", "-hls_list_size", "0",
        "-hls_segment_filename", os.path.join(hls, "seg%d.ts"),
        os.path.join(hls, "source.m3u8"),
    ], check=True, timeout=300)
    segments = sorted(
        (name for name in os.listdir(hls) if name.startswith("seg") and name.endswith(".ts")),
        key=lambda name: int(name[3:-3]),
    )
    if len(segments) < 8:
        raise SystemExit("live fixture produced too few segments: %r" % segments)
    with open(os.path.join(hls, "index.html"), "w", encoding="utf-8") as handle:
        handle.write(
            "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Live fixture</title>"
            "</head><body><video controls src='seg0.ts'></video></body></html>\n"
        )
    print("[fixture] live segments", len(segments),
          os.path.getsize(os.path.join(hls, segments[0])), flush=True)
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


async def job_status(popup_ws, playlist, job_key):
    raw = await evaluate(popup_ws, """
      (() => new Promise(function (resolve) {
        chrome.runtime.sendMessage({type: 'ms-hls-status', url: %s, jobKey: %s},
          function (job) { resolve(JSON.stringify(job || null)); });
      }))()
    """ % (json.dumps(playlist), json.dumps(job_key)), timeout=30)
    return json.loads(raw) if raw else None


async def main():
    browser = find_browser()
    if not browser:
        raise SystemExit("no Chromium browser found")
    fixture_root = make_fixture()
    harness = make_harness()
    port = free_port()
    fixture_port = free_port()
    base = f"http://127.0.0.1:{port}"
    profile = tempfile.mkdtemp(prefix="media-sniper-live-profile-")
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
        tab_id = await evaluate(sw_ws, "chrome.tabs.query({active:true,currentWindow:true}).then(t => t[0] && t[0].id)", timeout=20)
        step("fixture tab registered", isinstance(tab_id, int), tab_id)

        extension_id = sw["url"].split("/")[2]
        open_tab(base, f"chrome-extension://{extension_id}/popup/popup.html")
        popup_target = await find_target(base, lambda t: "popup/popup.html" in t.get("url", ""))
        step("popup context opened", popup_target is not None, str((popup_target or {}).get("url") or ""))
        if not popup_target:
            return
        popup_ws = popup_target["webSocketDebuggerUrl"]

        playlist = f"http://127.0.0.1:{fixture_port}/hls/live.m3u8"
        started = await evaluate(popup_ws, """
          (() => new Promise(function (resolve) {
            chrome.runtime.sendMessage({
              type: 'ms-hls-download', url: %s, kind: 'hls', tabId: %d,
              title: 'Live E2E recording', pageUrl: %s
            }, function (response) {
              resolve(JSON.stringify({response: response || null, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : null}));
            });
          }))()
        """ % (json.dumps(playlist), tab_id, json.dumps(fixture_url)), timeout=60)
        step("live save accepted", "started" in str(started), started)
        try:
            job_key = json.loads(json.loads(started)["response"])["jobKey"]
        except Exception:
            job_key = None

        # wait for the recording to actually run and write bytes
        deadline = time.time() + 90
        recording = None
        max_bytes = 0
        byte_readings = []
        seen = []
        last_job = None
        while time.time() < deadline:
            job = await job_status(popup_ws, playlist, job_key)
            if job:
                last_job = job
                label = "%s/%s" % (job.get("status"), job.get("mode") or job.get("total") or "")
                if not seen or seen[-1] != label:
                    seen.append(label)
                if job.get("status") == "recording":
                    recording = job
                if job.get("bytes"):
                    max_bytes = max(max_bytes, int(job.get("bytes") or 0))
                    byte_readings.append(int(job.get("bytes") or 0))
                if job.get("status") == "failed":
                    step("recording started", False, json.dumps(job))
                    return
                if job.get("status") == "recording" and len(set(byte_readings)) >= 3:
                    break
            await asyncio.sleep(1)
        step("live recording started", recording is not None, json.dumps(recording))
        step("recording reports growing output", len(set(byte_readings)) >= 2 and max_bytes > 0,
             f"max={max_bytes} readings={len(set(byte_readings))}")
        if not recording:
            step("live job diagnostics", False,
                 f"states={seen} last={json.dumps(last_job, ensure_ascii=False)[:220]}")
            return

        record_started = time.time()
        await asyncio.sleep(max(1, RECORD_SECONDS - (time.time() - record_started)))
        recorded_seconds = time.time() - record_started

        stop_ack = await evaluate(popup_ws, """
          (() => new Promise(function (resolve) {
            chrome.runtime.sendMessage({type: 'ms-hls-stop', url: %s, jobKey: %s},
              function (response) { resolve(JSON.stringify(response || null)); });
          }))()
        """ % (json.dumps(playlist), json.dumps(job_key)), timeout=30)
        step("stop acknowledged", "ok" in str(stop_ack), stop_ack)

        stop_at = time.time()
        final = None
        stop_states = []
        while time.time() - stop_at < STOP_DEADLINE_SECONDS:
            job = await job_status(popup_ws, playlist, job_key)
            label = "none" if not job else "%s/%s" % (job.get("status"), job.get("bytes"))
            if not stop_states or stop_states[-1] != label:
                stop_states.append(label)
            if job and job.get("status") in ("complete", "failed"):
                final = job
                break
            if job and job.get("status") == "downloading":
                final = job
                break
            await asyncio.sleep(1)
        elapsed_after_stop = time.time() - stop_at
        step("recording stopped promptly", final is not None and elapsed_after_stop < STOP_DEADLINE_SECONDS,
             f"status={(final or {}).get('status')} after {elapsed_after_stop:.1f}s states={stop_states[:8]}")
        step("stopped recording has no error", not (final or {}).get("error"), str((final or {}).get("error") or ""))
        if final is None:
            persisted = await evaluate(sw_ws, "chrome.storage.session.get('msActiveJobs').then(r => JSON.stringify(r.msActiveJobs || []))", timeout=30)
            global_jobs = await evaluate(sw_ws, "chrome.runtime.sendMessage({type:'ms-get-jobs'}).then(r => JSON.stringify((r && r.jobs) || []))", timeout=30)
            step("stopped job diagnostics", False,
                 f"persisted={str(persisted)[:200]} jobs={str(global_jobs)[:200]}")

        download = None
        deadline = time.time() + 120
        while time.time() < deadline:
            raw = await evaluate(sw_ws,
                "chrome.downloads.search({}).then(x => JSON.stringify(x.map(d => ({state:d.state,error:d.error,bytesReceived:d.bytesReceived,filename:d.filename}))))",
                timeout=30)
            rows = json.loads(raw)
            download = next((r for r in rows if "Live E2E" in str(r.get("filename", ""))), None)
            if download and download.get("state") in ("complete", "interrupted"):
                break
            await asyncio.sleep(1)
        step("partial recording reached Downloads", bool(download) and download.get("state") == "complete", json.dumps(download))

        if download and download.get("state") == "complete":
            saved = os.path.join(download_dir, os.path.basename(download["filename"]))
            size = os.path.getsize(saved) if os.path.exists(saved) else 0
            step("partial recording is not empty", size > 0, f"{saved} size={size}")
            probe = shutil.which("ffprobe")
            if probe:
                result = subprocess.run(
                    [probe, "-v", "error", "-show_entries", "format=duration", "-of", "json", saved],
                    capture_output=True, text=True, timeout=120,
                )
                try:
                    probed = float(json.loads(result.stdout or "{}").get("format", {}).get("duration") or 0)
                except Exception:
                    probed = 0
                step("partial recording is playable",
                     result.returncode == 0 and probed > 0,
                     f"rc={result.returncode} duration={probed} recorded~{recorded_seconds:.0f}s err={result.stderr[:120]}")
                step("partial duration matches the recorded window",
                     record_started <= time.time() and 1 <= probed <= (recorded_seconds + 30),
                     f"duration={probed} recorded={recorded_seconds:.0f}s")

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
    print("LIVE RECORDING E2E: " + ("PASS" if verdict["pass"] else "FAIL"), flush=True)


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
