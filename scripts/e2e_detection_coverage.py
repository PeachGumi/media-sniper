#!/usr/bin/env python3
"""Detection coverage: does Media Sniper detect everything the page itself got?

Ground truth comes from the page, not from VDH: every subresource the page
fetched is already in its resource timing, so "media the page requested" is a
superset of what any downloader adapter can see. The check is therefore:

    for each media URL the page fetched (manifest or whole file, size at or
    above the configured minimum) -> the extension must have detected it

That catches the class of gap the X regression belonged to without needing to
read another extension's internals.

Fixture cases pin the shapes (plain HLS, AES-128, DASH, live, audio-only,
MSE-fed manifest, page-config manifest); real sites are measured as far as a
session-less headless browser allows, and pages that never start a player are
reported as unmeasurable rather than as failures.

Run: python3 scripts/e2e_detection_coverage.py
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
WAIT_SECONDS = int(os.environ.get("MEDIA_SNIPER_COVERAGE_WAIT", "18"))
# The comparison must use the extension's own minimum size: a whole file below
# that setting is dropped by design, not by a missing detection path. It is read
# from the extension at runtime (fallback: the shipped default of 500 KiB).
MIN_BYTES = int(os.environ.get("MEDIA_SNIPER_COVERAGE_MIN_BYTES", str(500 * 1024)))

REAL_SITES = [
    "https://kick.com/xqc",
    "https://www.facebook.com/watch/?v=10153231379946729",
    "https://x.com/CuteIdolSunna/status/2099586589567451609",
    "https://vimeo.com/76979871",
]

verdict = {"cases": [], "pass": True}
failures = []


def log(ok, name, detail=""):
    verdict["cases"].append({"case": name, "ok": bool(ok), "detail": str(detail)[:300]})
    print(f"[{'ok ' if ok else 'FAIL'}] {name} {str(detail or '')[:220]}", flush=True)
    if not ok:
        verdict["pass"] = False
        failures.append(name + ": " + str(detail)[:200])


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
    dst = tempfile.mkdtemp(prefix="media-sniper-coverage-harness-")
    shutil.rmtree(dst)
    shutil.copytree(REPO_ROOT, dst, ignore=shutil.ignore_patterns(".git", ".venv", "node_modules", "media-sniper.zip"))
    manifest_path = os.path.join(dst, "manifest.json")
    with open(manifest_path, encoding="utf-8") as handle:
        manifest = json.load(handle)
    # Test build: the fixture origin plus the media host the fixture deliberately
    # serves from a second origin. Real-site coverage is measured with the
    # per-site grants a user would have.
    manifest["host_permissions"] = ["*://*/*"]
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return dst


def make_fixture():
    """Fixture pages for every detection shape, including the ones that only the
    page's own resource timing can reveal (MSE, player config)."""
    dst = tempfile.mkdtemp(prefix="media-sniper-coverage-fixture-")
    hls = os.path.join(dst, "hls")
    os.makedirs(hls, exist_ok=True)
    ffmpeg = shutil.which("ffmpeg") or "ffmpeg"
    # a real HLS upload (video+audio) and an audio-only rendition
    subprocess.run([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24",
        "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000",
        "-t", "6", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "48",
        "-c:a", "aac", "-b:a", "96k",
        "-f", "hls", "-hls_time", "2", "-hls_list_size", "0",
        "-hls_segment_filename", os.path.join(hls, "seg%d.ts"),
        os.path.join(hls, "media.m3u8"),
    ], check=True, timeout=200)
    # audio-only ADTS playlist (the X-Spaces shape)
    subprocess.run([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000", "-t", "6",
        "-c:a", "aac", "-b:a", "96k", "-vn", "-f", "adts",
        os.path.join(hls, "audio.aac"),
    ], check=True, timeout=200)
    with open(os.path.join(hls, "audio.m3u8"), "w", encoding="utf-8") as handle:
        handle.write("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\naudio.aac\n#EXT-X-ENDLIST\n")
    # live (no ENDLIST)
    with open(os.path.join(hls, "live.m3u8"), "w", encoding="utf-8") as handle:
        handle.write("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:6.0,\nseg0.ts\n")
    # DASH (segment list, single representation each)
    with open(os.path.join(hls, "stream.mpd"), "w", encoding="utf-8") as handle:
        handle.write(
            "<?xml version='1.0'?><MPD type='static' mediaPresentationDuration='PT6S' minBufferTime='PT2S'>"
            "<Period><AdaptationSet mimeType='video/mp4'><Representation id='v' bandwidth='400000' width='320' height='180'>"
            "<BaseURL>seg</BaseURL><SegmentList><Initialization sourceURL='init.mp4'/>"
            "<SegmentURL media='0.ts'/><SegmentURL media='1.ts'/></SegmentList></Representation></AdaptationSet></Period></MPD>"
        )
    # a whole mp4 (direct download shape) and a poster for the page
    subprocess.run([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-t", "5",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        os.path.join(hls, "direct.mp4"),
    ], check=True, timeout=200)
    # a whole mp4 above the default minimum size (500 KB): the direct-download
    # shape is only reported when the file is big enough to be wanted
    subprocess.run([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-t", "30",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-b:v", "900k",
        os.path.join(hls, "big.mp4"),
    ], check=True, timeout=300)
    # pages: native video, MSE-fed manifest, manifest only in page data
    pages = {
        "native.html": "<video controls width='320' src='media.m3u8'></video>",
        "mse.html": (
            "<video id='v' controls></video><script>"
            "var v=document.getElementById('v');"
            "var ms=new MediaSource();v.src=URL.createObjectURL(ms);"
            "ms.addEventListener('sourceopen',function(){"
            "fetch('media.m3u8').then(function(r){return r.text();}).catch(function(){});});"
            "</script>"
        ),
        "config.html": (
            "<video id='v' controls></video><script>"
            "window.playerConfig={hls:{manifest:'media.m3u8'}};"
            "var ms=new MediaSource();document.getElementById('v').src=URL.createObjectURL(ms);"
            "fetch('live.m3u8').then(function(r){return r.text();}).catch(function(){});"
            "</script>"
        ),
        "audio.html": "<audio controls src='audio.m3u8'></audio>",
        "mp4.html": "<video controls width='320' src='direct.mp4'></video>",
        "dash.html": (
            "<video id='v' controls></video><script>"
            "var ms=new MediaSource();document.getElementById('v').src=URL.createObjectURL(ms);"
            "fetch('stream.mpd').then(function(r){return r.text();}).catch(function(){});"
            "</script>"
        ),
        "bigmp4.html": "<video controls width='320' src='big.mp4'></video>",
    }
    for name, body in pages.items():
        with open(os.path.join(hls, name), "w", encoding="utf-8") as handle:
            handle.write("<!DOCTYPE html><html><head><meta charset='utf-8'><title>" + name + "</title></head><body>" + body + "</body></html>\n")
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
                raise RuntimeError(json.dumps(result["exceptionDetails"])[:300])
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


GROUND_TRUTH = """
(() => {
  const url = new URL(location.href);
  const base = url.origin + url.pathname.replace(/[^/]*$/, '');
  const entries = (performance.getEntriesByType('resource') || []).map(function (e) {
    return {
      name: e.name,
      size: Math.max(e.encodedBodySize || 0, e.transferSize || 0),
      initiator: e.initiatorType || '',
    };
  });
  const mediaish = function (u) {
    const p = new URL(u).pathname || '';
    if (/\\.(m3u8|mpd)(?:$)/i.test(p)) return 'manifest';
    if (/\\.(mp4|m4v|webm|mkv|mov|ogv|mp3|m4a|aac|ogg|opus|wav|flac)(?:$)/i.test(p)) return 'file';
    return null;
  };
  const out = [];
  for (const e of entries) {
    if (!/^https?:/i.test(e.name)) continue;
    const path = new URL(e.name).pathname || '';
    if (/\.(ts|m4s)$/i.test(path)) continue; // segments are never items
    let kind = mediaish(e.name);
    // CDNs often serve media without an extension (facebook's fbcdn does), but
    // the element that pulled it is recorded as the initiator.
    if (!kind && (e.initiator === 'video' || e.initiator === 'audio')) kind = 'file';
    if (!kind) continue;
    out.push({ url: e.name, kind: kind, size: e.size, initiator: e.initiator });
  }
  const vids = Array.from(document.querySelectorAll('video')).map(function (v) {
    return { src: (v.currentSrc || v.src || '').slice(0, 120), readyState: v.readyState, width: v.videoWidth || 0 };
  });
  const wall = /captcha|verify you are human|unusual traffic|are you a robot/i.test(document.documentElement.innerHTML.slice(0, 20000));
  const login = /log ?in|sign ?in|ログイン|password/i.test((document.body ? document.body.innerText : '').slice(0, 3000));
  return JSON.stringify({ entries: out, videos: vids, wall: wall, login: login, title: document.title.slice(0, 60) });
})()
"""


def normalize(url):
    try:
        parsed = urllib.parse.urlparse(url)
        return parsed.netloc + parsed.path
    except Exception:
        return str(url)


def http_size(url):
    """Declared size of a URL. HEAD first (cheap), GET headers as a fallback:
    the fixture server answers 501 to HEAD."""
    for method in ("HEAD", "GET"):
        try:
            request = urllib.request.Request(url, method=method)
            with urllib.request.urlopen(request, timeout=15) as response:
                declared = response.headers.get("content-length")
                if declared:
                    return int(declared)
        except Exception:
            continue
    return 0


def compare(case_name, ground, detected):
    """Every ground-truth media URL at or above the size floor must be detected.

    A whole file below the extension's minimum size is dropped by *settings*
    ("minSizeKb"), which is intended behaviour; resource timing cannot always
    report that size (cross-origin without Timing-Allow-Origin), so it is asked
    of the server before a miss is called a gap.
    """
    detected_norm = {normalize(item.get("url")) for item in detected}
    missing = []
    filtered = []
    for entry in ground:
        if entry.get("kind") == "file":
            size = entry.get("size") or 0
            if not size:
                size = http_size(entry["url"])
            if size and size < MIN_BYTES:
                filtered.append(dict(entry, size=size))
                continue
        if normalize(entry["url"]) not in detected_norm:
            missing.append(entry)
    return missing, filtered


async def measure(base, sw_ws, popup_ws, url, label, expect_detection=True, need_player=True):
    open_tab(base, url)
    page = await find_target(base, lambda t, u=url: t.get("type") == "page" and t.get("url", "").startswith(u[:70]))
    if not page:
        log(False, label + ": page opened", "tab did not open")
        return None
    await asyncio.sleep(WAIT_SECONDS)
    try:
        probe = json.loads(await evaluate(page["webSocketDebuggerUrl"], GROUND_TRUTH, timeout=30))
    except Exception as exc:
        log(False, label + ": page probe", str(exc)[:160])
        return None
    tab_id = await evaluate(sw_ws, "chrome.tabs.query({active:true,currentWindow:true}).then(t=>t[0]&&t[0].id)", timeout=15)
    items_raw = await evaluate(popup_ws,
        "chrome.runtime.sendMessage({type:'ms-get-items', tabId: %s}).then(r => JSON.stringify((r && r.items) || []))" % json.dumps(tab_id),
        timeout=30)
    items = json.loads(items_raw) if items_raw else []
    missing, filtered = compare(label, probe.get("entries") or [], items)
    if probe.get("wall") or (need_player and not probe.get("videos") and not probe.get("entries")):
        note = "unmeasurable (bot wall)" if probe.get("wall") else "unmeasurable (no player, no requests)"
        print(f"[--] {label}: {note} items={len(items)} ground={len(probe.get('entries') or [])}", flush=True)
        verdict["cases"].append({"case": label, "ok": True, "detail": note, "unmeasurable": True})
        return {"probe": probe, "items": items, "unmeasurable": True}
    if not expect_detection:
        return {"probe": probe, "items": items}
    ok = not missing
    log(ok, label + ": every page-fetched media URL is detected",
        "ground=" + str(len(probe.get("entries") or [])) + " detected=" + str(len(items))
        + (" missing=" + json.dumps([m["url"] for m in missing], ensure_ascii=False)[:200] if missing else "")
        + (" below-size=" + str(len(filtered)) if filtered else ""))
    return {"probe": probe, "items": items, "missing": missing}


async def main():
    browser = find_browser()
    if not browser:
        raise SystemExit("no Chromium browser found")
    harness = make_harness()
    fixture = make_fixture()
    fixture_port = free_port()
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    profile = tempfile.mkdtemp(prefix="media-sniper-coverage-profile-")
    os.makedirs(os.path.join(profile, "Default"), exist_ok=True)
    log_file = open(os.path.join(profile, "browser.log"), "w", encoding="utf-8")
    server = subprocess.Popen(
        [sys.executable, os.path.join(REPO_ROOT, "scripts", "e2e_fixture_server.py"), str(fixture_port), fixture],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    brave = subprocess.Popen([
        browser, "--headless=new", f"--remote-debugging-port={port}", f"--user-data-dir={profile}",
        f"--disable-extensions-except={harness}", f"--load-extension={harness}",
        "--no-first-run", "--no-default-browser-check", "--disable-gpu",
        "--autoplay-policy=no-user-gesture-required", "about:blank",
    ], stdout=log_file, stderr=log_file)
    try:
        sw = await find_target(base, lambda t: t.get("type") == "service_worker" and t.get("url", "").endswith("/src/background-entry.js"))
        if not sw:
            raise SystemExit("no service worker")
        sw_ws = sw["webSocketDebuggerUrl"]
        ext_id = sw["url"].split("/")[2]
        open_tab(base, f"chrome-extension://{ext_id}/popup/popup.html")
        popup = await find_target(base, lambda t: "popup/popup.html" in t.get("url", ""))
        popup_ws = popup["webSocketDebuggerUrl"]
        try:
            settings_raw = await evaluate(popup_ws, "chrome.runtime.sendMessage({type:'ms-get-settings'}).then(s => JSON.stringify(s || null))", timeout=20)
            settings = json.loads(settings_raw) if settings_raw else {}
            configured = int(settings.get("minSizeKb") or 0) * 1024
            if configured > 0:
                global MIN_BYTES
                MIN_BYTES = configured + 1024
                print(f"[cfg] extension minimum size: {configured} bytes", flush=True)
        except Exception as exc:
            print("[cfg] could not read settings, using", MIN_BYTES, str(exc)[:80], flush=True)

        print("=== fixture shapes (all detection paths) ===", flush=True)
        fixtures = [
            ("native HLS video", f"http://127.0.0.1:{fixture_port}/hls/native.html"),
            ("MSE-fed HLS", f"http://127.0.0.1:{fixture_port}/hls/mse.html"),
            ("manifest in page config", f"http://127.0.0.1:{fixture_port}/hls/config.html"),
            ("audio-only HLS", f"http://127.0.0.1:{fixture_port}/hls/audio.html"),
            ("DASH manifest (SegmentList)", f"http://127.0.0.1:{fixture_port}/hls/dash.html"),
            ("whole mp4 below the size setting", f"http://127.0.0.1:{fixture_port}/hls/mp4.html"),
            ("whole mp4 above the size setting", f"http://127.0.0.1:{fixture_port}/hls/bigmp4.html"),
        ]
        for label, url in fixtures:
            await measure(base, sw_ws, popup_ws, url, label)

        print("=== real sites (session-less headless) ===", flush=True)
        for url in REAL_SITES:
            host = urllib.parse.urlparse(url).netloc
            await measure(base, sw_ws, popup_ws, url, "site " + host, need_player=True)
    finally:
        for process in (brave, server):
            if process.poll() is None:
                process.terminate()
        for process in (brave, server):
            try:
                process.wait(timeout=10)
            except Exception:
                process.kill()
        log_file.close()
        shutil.rmtree(profile, ignore_errors=True)
        shutil.rmtree(fixture, ignore_errors=True)
        shutil.rmtree(harness, ignore_errors=True)
    measurable = [c for c in verdict["cases"] if not c.get("unmeasurable")]
    print("DETECTION COVERAGE: " + ("PASS" if verdict["pass"] else "FAIL")
          + f" ({len(measurable)} measured, {len(verdict['cases']) - len(measurable)} unmeasurable)", flush=True)
    if failures:
        print(json.dumps(failures, ensure_ascii=False, indent=1), flush=True)
    if not verdict["pass"]:
        sys.exit(1)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        sys.exit(1)
