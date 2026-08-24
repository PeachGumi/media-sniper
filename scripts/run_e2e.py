#!/usr/bin/env python3
"""media-sniper one-command E2E runner.

Boots everything the headless E2E needs, runs the test suites, tears down:
  1. (re)writes download prefs into the dedicated test profile
  2. launches headless Brave/Chrome/Chromium with --load-extension on a free port
  3. starts the fixture http server (test/fixture)
  4. waits for the Media Sniper extension service worker and discovers its ID
  5. runs scripts/e2e_download_test.py (detection + real popup-path download)
  6. tears the browser and server down

Usage:
  scripts/run_e2e.py            # full boot + run
  scripts/run_e2e.py --keep     # keep browser/server running after the run
Exit code: 0 = PASS, 1 = FAIL.
"""
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROFILE = os.path.expanduser("~/.cache/ms-brave-test-e2e")
KEEP = "--keep" in sys.argv


def find_browser():
    """Locate a Chromium-based browser binary across platforms.

    Priority: $MEDIA_SNIPER_BRAVE env var > brave > chrome, per-platform
    well-known install paths plus PATH lookup via shutil.which.
    """
    import shutil

    def candidates():
        if sys.platform == "darwin":
            yield "brave", [
                "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
                os.path.expanduser("~/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"),
            ]
            yield "chrome", [
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                os.path.expanduser("~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            ]
        elif os.name == "nt":
            pf = os.environ.get("PROGRAMFILES", r"C:\Program Files")
            pf86 = os.environ.get("PROGRAMFILES(X86)", pf)
            local = os.environ.get("LOCALAPPDATA", "")
            yield "brave", [
                os.path.join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
                os.path.join(pf86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
                os.path.join(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
            ]
            yield "chrome", [
                os.path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
                os.path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
            ]
        else:
            yield "brave", ["brave-browser", "brave-browser-stable", "brave"]
            yield "chrome", ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]

    env_browser = os.environ.get("MEDIA_SNIPER_BRAVE")
    if env_browser and os.path.exists(env_browser):
        return env_browser

    for _, paths in candidates():
        for p in paths:
            if os.sep not in p and "/" not in p:
                found = shutil.which(p)
                if found:
                    return found
            elif os.path.exists(p):
                return p
    return None


def free_port():
    import socket
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def write_prefs():
    """prompt_for_download=false so automated downloads never stall."""
    base = os.path.join(PROFILE, "Default")
    os.makedirs(base, exist_ok=True)
    prefs_path = os.path.join(base, "Preferences")
    prefs = {}
    if os.path.exists(prefs_path):
        try:
            with open(prefs_path, encoding="utf-8") as f:
                prefs = json.load(f)
        except Exception:
            prefs = {}
    prefs.setdefault("download", {})["prompt_for_download"] = False
    prefs["download"]["default_directory"] = os.path.expanduser("~/Downloads")
    prefs["download"]["directory_upgrade"] = True
    with open(prefs_path, "w", encoding="utf-8") as f:
        json.dump(prefs, f)
    return prefs_path


def cdp_targets(port):
    return json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=2))


def wait_cdp(port, seconds=30):
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2))
            return True
        except Exception:
            time.sleep(0.5)
    return False


def extension_id_from_target(target):
    url = target.get("url", "")
    m = re.match(r"^chrome-extension://([a-p]{32})/", url)
    if not m:
        return None
    return m.group(1)


def wait_sw(port, seconds=25):
    """Return Media Sniper's dynamically assigned unpacked extension ID."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            for t in cdp_targets(port):
                if t.get("type") != "service_worker":
                    continue
                url = t.get("url", "")
                if not url.endswith("/src/background.js"):
                    continue
                ext_id = extension_id_from_target(t)
                if ext_id:
                    return ext_id
        except Exception:
            pass
        time.sleep(1)
    return None


def main():
    cdp_port = free_port()
    fixture_port = free_port()

    prefs = write_prefs()
    print(f"[boot] prefs written: {prefs}")

    browser = find_browser()
    if not browser:
        print("[FAIL] no Chromium browser found (install Brave/Chrome/Chromium, "
              "or point MEDIA_SNIPER_BRAVE at the binary)")
        return False
    print(f"[boot] browser: {browser}")

    env = dict(os.environ)
    brave_cmd = [
        browser,
        "--headless=new",
        f"--remote-debugging-port={cdp_port}",
        f"--user-data-dir={PROFILE}",
        f"--load-extension={ROOT}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--autoplay-policy=no-user-gesture-required",
        "about:blank",
    ]
    brave_proc = subprocess.Popen(brave_cmd, env=env,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"[boot] browser pid={brave_proc.pid} cdp={cdp_port}")

    fix_proc = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(fixture_port)],
        cwd=os.path.join(ROOT, "test", "fixture"),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"[boot] fixture server port={fixture_port}")

    procs = [(brave_proc, "browser"), (fix_proc, "fixture")]

    def teardown(*_):
        for p, _ in procs:
            if p.poll() is None:
                try:
                    try:
                        json.load(urllib.request.urlopen(
                            f"http://127.0.0.1:{cdp_port}/json/version", timeout=2))
                        if os.name != "nt":
                            subprocess.run(["pkill", "-TERM", "-f",
                                            f"remote-debugging-port={cdp_port}"],
                                           capture_output=True, timeout=5)
                        else:
                            p.terminate()
                    except Exception:
                        p.terminate()
                except Exception:
                    pass
        for p, _ in procs:
            try:
                p.wait(timeout=5)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass

    signal.signal(signal.SIGINT, lambda *a: (teardown(), sys.exit(130)))
    signal.signal(signal.SIGTERM, lambda *a: (teardown(), sys.exit(143)))

    ok = True
    try:
        if not wait_cdp(cdp_port):
            print("[FAIL] CDP never came up")
            return False
        print("[ok] CDP up")

        ext_id = wait_sw(cdp_port)
        if not ext_id:
            print("[FAIL] Media Sniper service worker never appeared "
                  "(extension load failure or unexpected background path)")
            return False
        print(f"[ok] service worker awake extension_id={ext_id}")

        e2e_env = dict(env)
        e2e_env["CDP_PORT"] = str(cdp_port)
        e2e_env["MEDIA_SNIPER_EXTENSION_ID"] = ext_id
        r = subprocess.run(
            [sys.executable, os.path.join(ROOT, "scripts", "e2e_download_test.py"),
             str(fixture_port)],
            env=e2e_env, timeout=180)
        ok = r.returncode == 0
    finally:
        if KEEP:
            print(f"\n[keep] browser left running: CDP={cdp_port} fixture={fixture_port}")
            print(f"[keep] stop with the process using remote-debugging-port={cdp_port}")
        else:
            teardown()
            print("[teardown] done")

    print("RUNNER:", "PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
