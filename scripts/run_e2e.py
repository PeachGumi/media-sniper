#!/usr/bin/env python3
"""Media Sniper browser E2E runner.

One invocation performs two isolated browser runs:
1. load the exact extension artifact unchanged and require its MV3 service
   worker to start;
2. copy that artifact to a temporary functional harness, changing *only*
   manifest.host_permissions to `http://127.0.0.1/*`, then exercise detection,
   direct download and the bundled libav AES-128 HLS remux path.

The localhost manifest overlay exists solely because headless Chrome cannot
approve the interactive optional-permission confirmation UI. Runtime JS/WASM
bytes are copied unchanged from the exact packaged artifact.
"""
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE_EXTENSION_ROOT = os.path.abspath(os.environ.get("MEDIA_SNIPER_EXTENSION_ROOT", REPO_ROOT))
KEEP = "--keep" in sys.argv
SMOKE_ONLY = os.environ.get("MEDIA_SNIPER_E2E_SMOKE_ONLY") == "1"


def find_browser():
    env_browser = os.environ.get("MEDIA_SNIPER_BRAVE")
    if env_browser and os.path.exists(env_browser): return env_browser
    candidates=[]
    if sys.platform=="darwin": candidates += ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser","/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    elif os.name=="nt":
        pf=os.environ.get("PROGRAMFILES",r"C:\Program Files"); local=os.environ.get("LOCALAPPDATA","")
        candidates += [os.path.join(pf,"BraveSoftware","Brave-Browser","Application","brave.exe"),os.path.join(local,"Google","Chrome","Application","chrome.exe")]
    else: candidates += ["brave-browser","brave","google-chrome","google-chrome-stable","chromium"]
    for c in candidates:
        if os.path.isabs(c) and os.path.exists(c): return c
        found=shutil.which(c)
        if found: return found
    return None


def free_port():
    import socket
    s=socket.socket(); s.bind(("127.0.0.1",0)); p=s.getsockname()[1]; s.close(); return p


def read_manifest(root):
    p=os.path.join(root,"manifest.json")
    if not os.path.isfile(p): raise RuntimeError("extension root has no manifest.json: "+root)
    with open(p,encoding="utf-8") as f: return json.load(f)


def service_worker_path(root):
    sw=read_manifest(root).get("background",{}).get("service_worker")
    if not isinstance(sw,str) or not sw: raise RuntimeError("manifest background.service_worker is missing")
    return sw.lstrip("/")


def make_functional_harness(root):
    dst=tempfile.mkdtemp(prefix="media-sniper-e2e-functional-")
    shutil.rmtree(dst)
    shutil.copytree(root,dst)
    manifest=read_manifest(dst)
    if manifest.get("host_permissions"):
        raise RuntimeError("release artifact unexpectedly already has required host_permissions")
    manifest["host_permissions"]=["http://127.0.0.1/*"]
    with open(os.path.join(dst,"manifest.json"),"w",encoding="utf-8") as f:
        json.dump(manifest,f,ensure_ascii=False,indent=2); f.write("\n")
    return dst


def write_prefs(profile):
    base=os.path.join(profile,"Default"); os.makedirs(base,exist_ok=True)
    p=os.path.join(base,"Preferences")
    prefs={"download":{"prompt_for_download":False,"default_directory":os.path.expanduser("~/Downloads"),"directory_upgrade":True}}
    with open(p,"w",encoding="utf-8") as f: json.dump(prefs,f)


def cdp_targets(port): return json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list",timeout=2))


def wait_cdp(port,seconds=30):
    deadline=time.time()+seconds
    while time.time()<deadline:
        try: json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version",timeout=2)); return True
        except Exception: time.sleep(.4)
    return False


def wait_sw(port,expected_path,seconds=25):
    suffix="/"+expected_path; deadline=time.time()+seconds
    while time.time()<deadline:
        try:
            for t in cdp_targets(port):
                if t.get("type")!="service_worker" or not (t.get("url") or "").endswith(suffix): continue
                m=re.match(r"^chrome-extension://([a-p]{32})/",t.get("url", ""))
                if m: return m.group(1)
        except Exception: pass
        time.sleep(.4)
    return None


def browser_run(browser, root, functional=False):
    cdp_port,fixture_port=free_port(),free_port()
    profile=tempfile.mkdtemp(prefix="ms-browser-profile-")
    write_prefs(profile)
    log_path=os.path.join(profile,"browser.log"); log=open(log_path,"w",encoding="utf-8")
    env=dict(os.environ)
    bp=subprocess.Popen([
        browser,"--headless=new",f"--remote-debugging-port={cdp_port}",f"--user-data-dir={profile}",
        f"--disable-extensions-except={root}",f"--load-extension={root}","--enable-logging=stderr","--v=1",
        "--no-first-run","--no-default-browser-check","--disable-gpu","--autoplay-policy=no-user-gesture-required","about:blank",
    ],env=env,stdout=log,stderr=log)
    fp=subprocess.Popen([sys.executable,"-m","http.server",str(fixture_port)],cwd=os.path.join(REPO_ROOT,"test","fixture"),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    procs=[bp,fp]

    def teardown():
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
        if not KEEP: shutil.rmtree(profile,ignore_errors=True)

    try:
        if not wait_cdp(cdp_port): raise RuntimeError("CDP never came up")
        ext_id=wait_sw(cdp_port,service_worker_path(root))
        if not ext_id: raise RuntimeError("service worker never appeared")
        print(f"[ok] {'functional harness' if functional else 'exact artifact'} service worker awake extension_id={ext_id}",flush=True)
        if not functional: return True

        e={**env,"CDP_PORT":str(cdp_port),"MEDIA_SNIPER_EXTENSION_ID":ext_id,"MEDIA_SNIPER_E2E_PREGRANTED":"1"}
        general=subprocess.run([sys.executable,os.path.join(REPO_ROOT,"scripts","e2e_pregranted_test.py"),str(fixture_port)],env=e,timeout=180)
        if general.returncode!=0: return False
        libav=subprocess.run([sys.executable,os.path.join(REPO_ROOT,"scripts","verify_aes.py"),str(fixture_port)],env=e,timeout=240)
        return libav.returncode==0
    finally:
        teardown()


def main():
    browser=find_browser()
    if not browser:
        print("[FAIL] no Chromium browser found"); return False
    exact=read_manifest(BASE_EXTENSION_ROOT)
    if exact.get("host_permissions"):
        print("[FAIL] exact release artifact has required host_permissions",exact.get("host_permissions")); return False
    print("[gate 1] exact artifact browser startup",flush=True)
    if not browser_run(browser,BASE_EXTENSION_ROOT,False): return False
    if SMOKE_ONLY: return True

    harness=None
    try:
        harness=make_functional_harness(BASE_EXTENSION_ROOT)
        print("[gate 2] localhost-only functional harness",flush=True)
        ok=browser_run(browser,harness,True)
        print("RUNNER:","PASS" if ok else "FAIL",flush=True)
        return ok
    finally:
        if harness and not KEEP: shutil.rmtree(harness,ignore_errors=True)


if __name__=="__main__":
    try: sys.exit(0 if main() else 1)
    except Exception as exc:
        print("RUNNER: FAIL",repr(exc),flush=True); sys.exit(1)
