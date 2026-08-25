#!/usr/bin/env python3
"""Media Sniper one-command browser E2E runner.

`MEDIA_SNIPER_EXTENSION_ROOT` selects the unpacked artifact under test.
`MEDIA_SNIPER_E2E_SMOKE_ONLY=1` only verifies that the exact artifact loads and
its MV3 service worker starts. Functional CI may use a manifest-only test copy
with localhost host access pre-granted; all JS/WASM bytes remain the packaged
release bytes.
"""
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXTENSION_ROOT = os.path.abspath(os.environ.get("MEDIA_SNIPER_EXTENSION_ROOT", REPO_ROOT))
PROFILE = os.path.expanduser(os.environ.get("MEDIA_SNIPER_E2E_PROFILE", "~/.cache/ms-brave-test-e2e"))
KEEP = "--keep" in sys.argv
SMOKE_ONLY = os.environ.get("MEDIA_SNIPER_E2E_SMOKE_ONLY") == "1"


def find_browser():
    env_browser = os.environ.get("MEDIA_SNIPER_BRAVE")
    if env_browser and os.path.exists(env_browser):
        return env_browser
    candidates = []
    if sys.platform == "darwin":
        candidates += [
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ]
    elif os.name == "nt":
        pf = os.environ.get("PROGRAMFILES", r"C:\Program Files")
        local = os.environ.get("LOCALAPPDATA", "")
        candidates += [
            os.path.join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
            os.path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
        ]
    else:
        candidates += ["brave-browser", "brave", "google-chrome", "google-chrome-stable", "chromium"]
    for candidate in candidates:
        if os.path.isabs(candidate) and os.path.exists(candidate):
            return candidate
        found = shutil.which(candidate)
        if found:
            return found
    return None


def manifest_service_worker():
    path = os.path.join(EXTENSION_ROOT, "manifest.json")
    if not os.path.isfile(path):
        raise RuntimeError("extension root has no manifest.json: " + EXTENSION_ROOT)
    with open(path, encoding="utf-8") as f:
        manifest = json.load(f)
    sw = manifest.get("background", {}).get("service_worker")
    if not isinstance(sw, str) or not sw:
        raise RuntimeError("manifest background.service_worker is missing")
    return sw.lstrip("/")


def free_port():
    import socket
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def write_prefs():
    base = os.path.join(PROFILE, "Default")
    os.makedirs(base, exist_ok=True)
    p = os.path.join(base, "Preferences")
    prefs = {"download": {
        "prompt_for_download": False,
        "default_directory": os.path.expanduser("~/Downloads"),
        "directory_upgrade": True,
    }}
    with open(p, "w", encoding="utf-8") as f:
        json.dump(prefs, f)
    return p


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


def wait_sw(port, expected_path, seconds=25):
    suffix = "/" + expected_path.lstrip("/")
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            for t in cdp_targets(port):
                if t.get("type") != "service_worker" or not (t.get("url") or "").endswith(suffix):
                    continue
                m = re.match(r"^chrome-extension://([a-p]{32})/", t.get("url", ""))
                if m:
                    return m.group(1)
        except Exception:
            pass
        time.sleep(0.5)
    return None


def print_browser_log(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
        if text:
            print("[browser stderr tail]")
            print(text[-10000:])
    except Exception:
        pass


def main():
    if not KEEP:
        shutil.rmtree(PROFILE, ignore_errors=True)
    cdp_port, fixture_port = free_port(), free_port()
    prefs = write_prefs()
    print(f"[boot] prefs written: {prefs}")
    print(f"[boot] extension root: {EXTENSION_ROOT}")

    browser = find_browser()
    if not browser:
        print("[FAIL] no Chromium browser found")
        return False
    try:
        expected_sw = manifest_service_worker()
    except Exception as exc:
        print(f"[FAIL] {exc}")
        return False

    log_path = os.path.join(PROFILE, "browser-e2e.log")
    log = open(log_path, "w", encoding="utf-8")
    env = dict(os.environ)
    browser_proc = subprocess.Popen([
        browser, "--headless=new", f"--remote-debugging-port={cdp_port}",
        f"--user-data-dir={PROFILE}", f"--disable-extensions-except={EXTENSION_ROOT}",
        f"--load-extension={EXTENSION_ROOT}", "--enable-logging=stderr", "--v=1",
        "--no-first-run", "--no-default-browser-check", "--disable-gpu",
        "--autoplay-policy=no-user-gesture-required", "about:blank",
    ], env=env, stdout=log, stderr=log)
    fixture_proc = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(fixture_port)],
        cwd=os.path.join(REPO_ROOT, "test", "fixture"),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    procs = [browser_proc, fixture_proc]

    def teardown(*_):
        for p in procs:
            if p.poll() is None:
                try: p.terminate()
                except Exception: pass
        for p in procs:
            try: p.wait(timeout=5)
            except Exception:
                try: p.kill()
                except Exception: pass
        try: log.close()
        except Exception: pass

    signal.signal(signal.SIGINT, lambda *_: (teardown(), sys.exit(130)))
    signal.signal(signal.SIGTERM, lambda *_: (teardown(), sys.exit(143)))
    ok = False
    try:
        if not wait_cdp(cdp_port):
            print("[FAIL] CDP never came up")
            print_browser_log(log_path)
            return False
        ext_id = wait_sw(cdp_port, expected_sw)
        if not ext_id:
            print("[FAIL] service worker never appeared")
            print_browser_log(log_path)
            return False
        print(f"[ok] service worker awake extension_id={ext_id}")

        if SMOKE_ONLY:
            ok = True
            print("[ok] exact packaged artifact browser-startup smoke")
            return True

        e2e_env = dict(env)
        e2e_env.update({
            "CDP_PORT": str(cdp_port),
            "MEDIA_SNIPER_EXTENSION_ID": ext_id,
            "MEDIA_SNIPER_E2E_PREGRANTED": os.environ.get("MEDIA_SNIPER_E2E_PREGRANTED", "0"),
        })
        general = subprocess.run(
            [sys.executable, os.path.join(REPO_ROOT, "scripts", "e2e_download_test.py"), str(fixture_port)],
            env=e2e_env, timeout=180)
        if general.returncode != 0:
            return False
        libav = subprocess.run(
            [sys.executable, os.path.join(REPO_ROOT, "scripts", "verify_aes.py"), str(fixture_port)],
            env=e2e_env, timeout=240)
        ok = libav.returncode == 0
        return ok
    finally:
        if not KEEP:
            teardown()
            print("[teardown] done")
        print("RUNNER:", "PASS" if ok else "FAIL")


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
