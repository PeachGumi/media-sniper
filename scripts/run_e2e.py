#!/usr/bin/env python3
"""Media Sniper one-command browser E2E runner.

The test driver and fixtures live in the repository, while the extension under
test can be a different directory (for example an unpacked release zip) via
MEDIA_SNIPER_EXTENSION_ROOT. Exit code 0 means PASS.
"""
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.request

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXTENSION_ROOT = os.path.abspath(os.environ.get("MEDIA_SNIPER_EXTENSION_ROOT", REPO_ROOT))
PROFILE = os.path.expanduser("~/.cache/ms-brave-test-e2e")
KEEP = "--keep" in sys.argv


def find_browser():
    import shutil

    env_browser = os.environ.get("MEDIA_SNIPER_BRAVE")
    if env_browser and os.path.exists(env_browser):
        return env_browser

    candidates = []
    if sys.platform == "darwin":
        candidates += [
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            os.path.expanduser("~/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"),
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            os.path.expanduser("~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ]
    elif os.name == "nt":
        pf = os.environ.get("PROGRAMFILES", r"C:\Program Files")
        pf86 = os.environ.get("PROGRAMFILES(X86)", pf)
        local = os.environ.get("LOCALAPPDATA", "")
        candidates += [
            os.path.join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
            os.path.join(pf86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
            os.path.join(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
            os.path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
            os.path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
        ]
    else:
        candidates += [
            "brave-browser", "brave-browser-stable", "brave",
            "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
        ]

    for candidate in candidates:
        if os.sep in candidate or "/" in candidate:
            if os.path.exists(candidate):
                return candidate
        else:
            found = shutil.which(candidate)
            if found:
                return found
    return None


def manifest_service_worker():
    manifest_path = os.path.join(EXTENSION_ROOT, "manifest.json")
    if not os.path.isfile(manifest_path):
        raise RuntimeError("extension root has no manifest.json: " + EXTENSION_ROOT)
    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)
    path = manifest.get("background", {}).get("service_worker")
    if not path or not isinstance(path, str):
        raise RuntimeError("manifest background.service_worker is missing")
    return path.lstrip("/")


def free_port():
    import socket
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def write_prefs():
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
    match = re.match(r"^chrome-extension://([a-p]{32})/", target.get("url", ""))
    return match.group(1) if match else None


def wait_sw(port, expected_path, seconds=25):
    """Return the dynamically assigned extension ID for the manifest SW."""
    suffix = "/" + expected_path.lstrip("/")
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            for target in cdp_targets(port):
                if target.get("type") != "service_worker":
                    continue
                if not target.get("url", "").endswith(suffix):
                    continue
                ext_id = extension_id_from_target(target)
                if ext_id:
                    return ext_id
        except Exception:
            pass
        time.sleep(1)
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
    cdp_port = free_port()
    fixture_port = free_port()
    prefs = write_prefs()
    print(f"[boot] prefs written: {prefs}")
    print(f"[boot] extension root: {EXTENSION_ROOT}")

    browser = find_browser()
    if not browser:
        print("[FAIL] no Chromium browser found (install Brave/Chrome/Chromium, or set MEDIA_SNIPER_BRAVE)")
        return False
    print(f"[boot] browser: {browser}")

    try:
        expected_sw = manifest_service_worker()
    except Exception as exc:
        print(f"[FAIL] {exc}")
        return False
    print(f"[boot] expected service worker: {expected_sw}")

    os.makedirs(PROFILE, exist_ok=True)
    browser_log_path = os.path.join(PROFILE, "browser-e2e.log")
    browser_log = open(browser_log_path, "w", encoding="utf-8")
    env = dict(os.environ)
    browser_cmd = [
        browser,
        "--headless=new",
        f"--remote-debugging-port={cdp_port}",
        f"--user-data-dir={PROFILE}",
        # Deterministic automation: runner/browser images can ship built-in or
        # policy-installed extensions. Explicitly allow only the exact artifact
        # under test so source-only files can never make an E2E pass accidentally.
        f"--disable-extensions-except={EXTENSION_ROOT}",
        f"--load-extension={EXTENSION_ROOT}",
        "--enable-logging=stderr",
        "--v=1",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--autoplay-policy=no-user-gesture-required",
        "about:blank",
    ]
    browser_proc = subprocess.Popen(browser_cmd, env=env, stdout=browser_log, stderr=browser_log)
    print(f"[boot] browser pid={browser_proc.pid} cdp={cdp_port}")

    fixture_proc = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(fixture_port)],
        cwd=os.path.join(REPO_ROOT, "test", "fixture"),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    print(f"[boot] fixture server port={fixture_port}")

    procs = [(browser_proc, "browser"), (fixture_proc, "fixture")]

    def teardown(*_):
        for proc, _name in procs:
            if proc.poll() is not None:
                continue
            try:
                proc.terminate()
            except Exception:
                pass
        for proc, _name in procs:
            try:
                proc.wait(timeout=5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        try:
            browser_log.flush()
            browser_log.close()
        except Exception:
            pass

    signal.signal(signal.SIGINT, lambda *_: (teardown(), sys.exit(130)))
    signal.signal(signal.SIGTERM, lambda *_: (teardown(), sys.exit(143)))

    ok = False
    try:
        if not wait_cdp(cdp_port):
            print("[FAIL] CDP never came up")
            print_browser_log(browser_log_path)
            return False
        print("[ok] CDP up")

        ext_id = wait_sw(cdp_port, expected_sw)
        if not ext_id:
            print(f"[FAIL] Media Sniper service worker never appeared at {expected_sw}")
            try:
                print("[debug] CDP targets:", json.dumps(cdp_targets(cdp_port), ensure_ascii=False)[:6000])
            except Exception:
                pass
            browser_log.flush()
            print_browser_log(browser_log_path)
            return False
        print(f"[ok] service worker awake extension_id={ext_id}")

        e2e_env = dict(env)
        e2e_env["CDP_PORT"] = str(cdp_port)
        e2e_env["MEDIA_SNIPER_EXTENSION_ID"] = ext_id
        result = subprocess.run(
            [sys.executable, os.path.join(REPO_ROOT, "scripts", "e2e_download_test.py"), str(fixture_port)],
            env=e2e_env,
            timeout=180,
        )
        ok = result.returncode == 0
        return ok
    finally:
        if KEEP:
            print(f"[keep] browser left running: CDP={cdp_port} fixture={fixture_port}")
            try:
                browser_log.flush()
            except Exception:
                pass
        else:
            teardown()
            print("[teardown] done")
        print("RUNNER:", "PASS" if ok else "FAIL")


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
