#!/usr/bin/env python3
"""Host-access E2E: media hosted on an origin the extension has no permission
for.

The reference implementation (VDH) ships `host_permissions: ['<all_urls>']`,
so every media host is reachable. Media Sniper requests site access at runtime
and keeps `<all_urls>` out of the manifest, so a manifest or segment on a
second origin (a CDN, a video host) is a real capability gap: the fetch is
blocked and the job dies.

Two phases, same fixture, two browser instances:
  A. only the page origin is permitted  -> saving must fail with an error that
     names the host and says access is missing (not a bare "Failed to fetch").
  B. the media origin is permitted too   -> the same save must complete, which
     is the capability VDH gets from <all_urls>.

Run directly, or through scripts/run_e2e.py with MEDIA_SNIPER_E2E_HOST_ACCESS=1.
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
PAGE_HOST = "127.0.0.1"
MEDIA_HOST = "localhost"  # same fixture server, different origin

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


def make_harness(extra_origin=None):
    dst = tempfile.mkdtemp(prefix="media-sniper-host-harness-")
    shutil.rmtree(dst)
    shutil.copytree(REPO_ROOT, dst)
    manifest_path = os.path.join(dst, "manifest.json")
    with open(manifest_path, encoding="utf-8") as handle:
        manifest = json.load(handle)
    origins = [f"http://{PAGE_HOST}/*"]
    if extra_origin:
        origins.append(extra_origin)
    manifest["host_permissions"] = origins
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return dst


def make_fixture():
    dst = tempfile.mkdtemp(prefix="media-sniper-host-fixture-")
    hls = os.path.join(dst, "hls")
    os.makedirs(hls, exist_ok=True)
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24",
        "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000",
        "-t", "24", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-g", "48", "-c:a", "aac", "-b:a", "96k",
        "-f", "hls", "-hls_time", "2", "-hls_list_size", "0",
        "-hls_segment_filename", os.path.join(hls, "seg%d.ts"),
        os.path.join(hls, "media.m3u8"),
    ], check=True, timeout=300)
    segments = [n for n in os.listdir(hls) if n.endswith(".ts")]
    if len(segments) < 4:
        raise SystemExit("fixture produced too few segments")
    # The page lives on PAGE_HOST and embeds media served from MEDIA_HOST.
    with open(os.path.join(hls, "index.html"), "w", encoding="utf-8") as handle:
        handle.write(
            "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Host access fixture</title>"
            f"<meta property='og:image' content='http://{MEDIA_HOST}/hls/poster.png'>"
            "</head><body>"
            f"<video controls poster='http://{MEDIA_HOST}/hls/poster.png' "
            f"src='http://{MEDIA_HOST}/hls/media.m3u8'></video>"
            "</body></html>\n"
        )
    print("[fixture] segments", len(segments), flush=True)
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


async def attempt_save(fixture_root, fixture_port, extra_origin, grant_and_retry=False):
    """Launch a browser with the given host grant and try to save the
    cross-origin HLS manifest. Returns a dict describing the outcome.

    With grant_and_retry the popup grants the reported host at runtime (the
    real user flow: the failure names the host, the popup asks for it, the same
    job is retried) instead of shipping the grant in the manifest.
    """
    harness = make_harness(extra_origin)
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    profile = tempfile.mkdtemp(prefix="media-sniper-host-profile-")
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
        find_browser(), "--headless=new", f"--remote-debugging-port={port}", f"--user-data-dir={profile}",
        f"--disable-extensions-except={harness}", f"--load-extension={harness}",
        "--no-first-run", "--no-default-browser-check", "--disable-gpu",
        "--autoplay-policy=no-user-gesture-required", "about:blank",
    ], stdout=log, stderr=log)
    processes = [brave, server]
    outcome: dict = {"error": None, "job": None, "download": None, "granted": None, "saved": None}
    try:
        sw = await find_target(base, lambda t: t.get("type") == "service_worker" and t.get("url", "").endswith("/src/background-entry.js"))
        if not sw:
            outcome["error"] = "no service worker"
            return outcome
        sw_ws = sw["webSocketDebuggerUrl"]
        outcome["granted"] = json.loads(await evaluate(
            sw_ws, "chrome.permissions.getAll().then(p => JSON.stringify(p.origins || []))", timeout=20))

        page_url = f"http://{PAGE_HOST}:{fixture_port}/hls/index.html"
        open_tab(base, page_url)
        page = await find_target(base, lambda t: t.get("type") == "page" and f"{fixture_port}" in t.get("url", ""))
        if not page:
            outcome["error"] = "no fixture page"
            return outcome
        await asyncio.sleep(2)
        tab_id = await evaluate(sw_ws, "chrome.tabs.query({active:true,currentWindow:true}).then(t => t[0] && t[0].id)", timeout=20)

        extension_id = sw["url"].split("/")[2]
        open_tab(base, f"chrome-extension://{extension_id}/popup/popup.html")
        popup = await find_target(base, lambda t: "popup/popup.html" in t.get("url", ""))
        if not popup:
            outcome["error"] = "no popup context"
            return outcome
        popup_ws = popup["webSocketDebuggerUrl"]

        playlist = f"http://{MEDIA_HOST}:{fixture_port}/hls/media.m3u8"
        started = await evaluate(popup_ws, """
          (() => new Promise(function (resolve) {
            chrome.runtime.sendMessage({
              type: 'ms-hls-download', url: %s, kind: 'hls', tabId: %d,
              title: 'Host access E2E', pageUrl: %s
            }, function (response) {
              resolve(JSON.stringify({response: response || null, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : null}));
            });
          }))()
        """ % (json.dumps(playlist), tab_id or 0, json.dumps(page_url)), timeout=60)
        outcome["started"] = started
        try:
            job_key = json.loads(json.loads(started)["response"])["jobKey"]
        except Exception:
            job_key = None

        deadline = time.time() + 90
        while time.time() < deadline:
            raw = await evaluate(popup_ws, """
              (() => new Promise(function (resolve) {
                chrome.runtime.sendMessage({type: 'ms-hls-status', url: %s, jobKey: %s},
                  function (job) { resolve(JSON.stringify(job || null)); });
              }))()
            """ % (json.dumps(playlist), json.dumps(job_key)), timeout=30)
            job = json.loads(raw) if raw else None
            if job:
                outcome["job"] = job
                if job.get("status") in ("failed", "complete"):
                    break
            await asyncio.sleep(1)

        rows = json.loads(await evaluate(sw_ws,
            "chrome.downloads.search({}).then(x => JSON.stringify(x.map(d => ({state:d.state,error:d.error,bytesReceived:d.bytesReceived,filename:d.filename}))))",
            timeout=30))
        outcome["download"] = next((r for r in rows if "Host access" in str(r.get("filename", ""))), None)
        if outcome["download"] and outcome["download"].get("state") == "complete":
            saved = os.path.join(download_dir, os.path.basename(outcome["download"]["filename"]))
            outcome["saved"] = {"path": saved, "size": os.path.getsize(saved) if os.path.exists(saved) else 0}

        if grant_and_retry:
            # The browser's consent prompt cannot be automated here (headless
            # never resolves chrome.permissions.request), so this phase asserts
            # the UI the user actually clicks: the failed job must show the
            # host it needs and offer the grant button. The grant -> retry
            # plumbing itself is pinned by test/background.test.js
            # (ms-retry-host-access) and by phase B (grant present -> completes).
            await asyncio.sleep(2)
            ui = await evaluate(popup_ws, """
              (() => {
                const tab = document.getElementById('jobsTab');
                if (tab) tab.click();
                const rows = Array.from(document.querySelectorAll('#jobsList .job'));
                const row = rows.find(function (r) {
                  return (r.textContent || '').indexOf('Host access E2E') !== -1;
                }) || rows[0] || null;
                const btn = row ? row.querySelector('button.host-access') : null;
                return JSON.stringify({
                  rows: rows.length,
                  hasButton: !!btn,
                  label: btn ? btn.textContent : null,
                  title: btn ? btn.title : null,
                  rowText: row ? row.textContent : null,
                });
              })()
            """, timeout=30)
            outcome["ui"] = json.loads(ui) if ui else {}
            return outcome
        return outcome
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


async def main():
    if not find_browser():
        raise SystemExit("no Chromium browser found")
    fixture_root = make_fixture()
    fixture_port = free_port()
    try:
        print("=== phase A: only the page origin is permitted ===", flush=True)
        without = await attempt_save(fixture_root, fixture_port, None)
        job = without.get("job") or {}
        error = str(job.get("error") or "")
        step("A: page-origin-only grants are what the extension asked for",
             without.get("granted") == [f"http://{PAGE_HOST}/*"], without.get("granted"))
        step("A: cross-origin media save was refused", job.get("status") == "failed",
             json.dumps(job, ensure_ascii=False)[:300])
        step("A: failure names the blocked host instead of a bare fetch error",
             MEDIA_HOST in error, error[:300])
        step("A: failure says access must be granted", "アクセス" in error or "許可" in error, error[:300])
        step("A: no download was produced", (without.get("download") or {}).get("state") != "complete",
             json.dumps(without.get("download")))

        print("=== phase B: the media origin is permitted too ===", flush=True)
        with_grant = await attempt_save(fixture_root, fixture_port, f"http://{MEDIA_HOST}/*")
        job_b = with_grant.get("job") or {}
        step("B: both origins permitted", len(with_grant.get("granted") or []) == 2, with_grant.get("granted"))
        step("B: cross-origin media save completed", job_b.get("status") == "complete",
             json.dumps(job_b, ensure_ascii=False)[:300])
        step("B: no error reported", not job_b.get("error"), str(job_b.get("error") or ""))
        step("B: artifact reached Downloads", (with_grant.get("download") or {}).get("state") == "complete",
             json.dumps(with_grant.get("download")))
        step("B: artifact has bytes", (with_grant.get("saved") or {}).get("size", 0) > 0,
             json.dumps(with_grant.get("saved")))

        print("=== phase C: the popup offers the grant for the blocked host ===", flush=True)
        blocked_run = await attempt_save(fixture_root, fixture_port, None, grant_and_retry=True)
        ui = blocked_run.get("ui") or {}
        step("C: the failed job is visible in the popup", (ui.get("rows") or 0) >= 1, json.dumps(ui)[:300])
        step("C: the job row explains the blocked host",
             f"{MEDIA_HOST}" in str(ui.get("title") or "") or f"{MEDIA_HOST}" in str(ui.get("rowText") or ""),
             json.dumps(ui)[:300])
        step("C: the job row offers a grant button", bool(ui.get("hasButton")), json.dumps(ui)[:300])

        verdict["pass"] = all(item["ok"] for item in verdict["steps"])
    finally:
        shutil.rmtree(fixture_root, ignore_errors=True)
    print("HOST ACCESS E2E: " + ("PASS" if verdict["pass"] else "FAIL"), flush=True)


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
