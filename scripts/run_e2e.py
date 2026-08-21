#!/usr/bin/env python3
"""media-sniper one-command E2E runner.

Boots everything the headless E2E needs, runs the test suites, tears down:
  1. (re)writes download prefs into the dedicated test profile
  2. launches headless Brave with --load-extension on a free port
  3. starts the fixture http server (test/fixture)
  4. waits for the extension service worker to appear
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
BRAVE = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
PROFILE = os.path.expanduser("~/.cache/ms-brave-test-e2e")
EXT_ID = "gahplhbihkiodjleemjahaiajhgaijlb"

KEEP = "--keep" in sys.argv


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
            prefs = json.load(open(prefs_path))
        except Exception:
            prefs = {}
    prefs.setdefault("download", {})["prompt_for_download"] = False
    prefs["download"]["default_directory"] = os.path.expanduser("~/Downloads")
    prefs["download"]["directory_upgrade"] = True
    json.dump(prefs, open(prefs_path, "w"))
    return prefs_path


def wait_cdp(port, seconds=30):
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2))
            return True
        except Exception:
            time.sleep(0.5)
    return False


def wait_sw(port, seconds=25):
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=2))
            for t in targets:
                if t.get("type") == "service_worker" and EXT_ID in t.get("url", ""):
                    return True
        except Exception:
            pass
        time.sleep(1)
    return False


def main():
    cdp_port = free_port()
    fixture_port = free_port()

    prefs = write_prefs()
    print(f"[boot] prefs written: {prefs}")

    env = dict(os.environ)
    brave_cmd = [
        BRAVE,
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
    print(f"[boot] brave pid={brave_proc.pid} cdp={cdp_port}")

    fix_proc = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(fixture_port)],
        cwd=os.path.join(ROOT, "test", "fixture"),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"[boot] fixture server port={fixture_port}")

    procs = [(brave_proc, "brave"), (fix_proc, "fixture")]

    def teardown(*_):
        for p, name in procs:
            if p.poll() is None:
                try:
                    if name == "brave":
                        # graceful: ask CDP to close, then SIGTERM fallback
                        try:
                            json.load(urllib.request.urlopen(
                                f"http://127.0.0.1:{cdp_port}/json/version", timeout=2))
                            subprocess.run(["pkill", "-TERM", "-f",
                                            f"remote-debugging-port={cdp_port}"],
                                           capture_output=True, timeout=5)
                        except Exception:
                            p.terminate()
                    else:
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
            ok = False
            return
        print("[ok] CDP up")

        if not wait_sw(cdp_port):
            print("[FAIL] extension service worker never appeared "
                  "(extension id mismatch or load failure)")
            ok = False
            return
        print("[ok] service worker awake")

        e2e_env = dict(env)
        e2e_env["CDP_PORT"] = str(cdp_port)
        r = subprocess.run(
            [sys.executable, os.path.join(ROOT, "scripts", "e2e_download_test.py"),
             str(fixture_port)],
            env=e2e_env, timeout=180)
        if r.returncode != 0:
            ok = False
    finally:
        if KEEP:
            print(f"\n[keep] browser left running: CDP={cdp_port} fixture={fixture_port}")
            print(f"[keep] stop with: pkill -f 'remote-debugging-port={cdp_port}'")
        else:
            teardown()
            print("[teardown] done")

    print("RUNNER:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
