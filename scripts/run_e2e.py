#!/usr/bin/env python3
"""Media Sniper browser E2E runner.

One invocation performs two isolated browser runs:
1. load the exact extension artifact unchanged and require its MV3 service
   worker to start;
2. copy that artifact to a temporary functional harness, changing *only*
   manifest.host_permissions to `http://127.0.0.1/*`, then exercise detection,
   direct download and the bundled libav HLS/AES-128 remux path.

The localhost manifest overlay exists solely because headless Chrome cannot
approve the interactive optional-permission confirmation UI. Runtime JS/WASM
bytes are copied unchanged from the exact packaged artifact.

HLS media fixtures are generated at test time with the host ffmpeg instead of
checking binary MPEG-TS/AES blobs into Git. This makes the fixture deterministic
and prevents text/binary transport corruption from turning the media into an
invalid TS stream while still testing the extension's bundled libav runtime.
"""
import json
import os
import re
import shutil
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


def make_fixture_harness():
    ffmpeg=shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to generate valid browser E2E HLS fixtures")
    dst=tempfile.mkdtemp(prefix="media-sniper-e2e-fixture-")
    shutil.rmtree(dst)
    shutil.copytree(os.path.join(REPO_ROOT,"test","fixture"),dst)
    hls=os.path.join(dst,"hls")
    os.makedirs(hls,exist_ok=True)

    for name in os.listdir(hls):
        if re.match(r"^(?:seg|encseg)\d+\.ts$",name):
            try: os.remove(os.path.join(hls,name))
            except OSError: pass

    common=[
        ffmpeg,"-hide_banner","-loglevel","error","-y",
        "-f","lavfi","-i","testsrc2=size=320x180:rate=24",
        "-f","lavfi","-i","sine=frequency=1000:sample_rate=48000",
        "-t","2","-c:v","libx264","-preset","ultrafast","-pix_fmt","yuv420p","-g","48",
        "-c:a","aac","-b:a","96k",
    ]
    subprocess.run(common+[
        "-f","hls","-hls_time","10","-hls_list_size","0",
        "-hls_segment_filename",os.path.join(hls,"seg%d.ts"),
        os.path.join(hls,"media.m3u8"),
    ],check=True,timeout=60)

    # Root-relative segment URIs (what X's manifests use) and a master with a
    # separate audio rendition: two shapes that used to fail as a bare
    # `ffmpeg failed (rc=-1)`. See scripts/verify_hls_nested.py.
    with open(os.path.join(hls,"media.m3u8"),encoding="utf-8") as f:
        media_text=f.read()
    rootrel=[]
    for line in media_text.splitlines():
        if line and not line.startswith("#"):
            rootrel.append("/hls/"+line)
        else:
            rootrel.append(line)
    with open(os.path.join(hls,"rootrel.m3u8"),"w",encoding="utf-8") as f:
        f.write("\n".join(rootrel)+"\n")

    vdir=os.path.join(hls,"v"); adir=os.path.join(hls,"a")
    os.makedirs(vdir,exist_ok=True); os.makedirs(adir,exist_ok=True)
    subprocess.run([
        ffmpeg,"-hide_banner","-loglevel","error","-y",
        "-f","lavfi","-i","testsrc2=size=320x180:rate=24","-t","6",
        "-c:v","libx264","-preset","ultrafast","-pix_fmt","yuv420p","-g","48","-an",
        "-f","hls","-hls_time","2","-hls_list_size","0",
        "-hls_segment_filename",os.path.join(vdir,"seg%d.ts"),
        os.path.join(vdir,"media.m3u8"),
    ],check=True,timeout=120)
    subprocess.run([
        ffmpeg,"-hide_banner","-loglevel","error","-y",
        "-f","lavfi","-i","sine=frequency=660:sample_rate=48000","-t","6",
        "-c:a","aac","-b:a","96k","-vn",
        "-f","hls","-hls_time","2","-hls_list_size","0",
        "-hls_segment_filename",os.path.join(adir,"seg%d.ts"),
        os.path.join(adir,"audio.m3u8"),
    ],check=True,timeout=120)
    with open(os.path.join(hls,"twosource.m3u8"),"w",encoding="utf-8") as f:
        f.write(
            "#EXTM3U\n#EXT-X-VERSION:6\n"
            '#EXT-X-MEDIA:NAME="Audio",TYPE=AUDIO,GROUP-ID="aud",AUTOSELECT=YES,DEFAULT=YES,URI="a/audio.m3u8"\n'
            '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=320x180,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud"\n'
            "v/media.m3u8\n"
        )

    # A second copy of the same valid stream is served behind a synthetic
    # Authorization requirement. The fixture page requests its playlist with
    # that header so webRequest captures the context; the bundled LibAV then
    # has to replay it for the protected segment during the save job.
    shutil.copy2(os.path.join(hls,"seg0.ts"),os.path.join(hls,"authseg0.ts"))
    shutil.copy2(os.path.join(hls,"seg0.ts"),os.path.join(hls,"slowseg0.ts"))
    with open(os.path.join(hls,"slowmanifest.m3u8"),"w",encoding="utf-8") as f:
        f.write("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nslowseg0.ts\n#EXT-X-ENDLIST\n")
    shutil.copy2(os.path.join(hls,"audio.mp3"),os.path.join(hls,"slowaudio.aac"))
    with open(os.path.join(hls,"slowaudio.m3u8"),"w",encoding="utf-8") as f:
        f.write("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nslowaudio.aac\n#EXT-X-ENDLIST\n")
    with open(os.path.join(hls,"auth.m3u8"),"w",encoding="utf-8") as f:
        f.write("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nauthseg0.ts\n#EXT-X-ENDLIST\n")
    index_path=os.path.join(hls,"index.html")
    with open(index_path,encoding="utf-8") as f: index=f.read()
    probe="<script>fetch('/hls/auth.m3u8',{headers:{Authorization:'Bearer media-sniper-e2e'}}).catch(()=>{});</script>"
    with open(index_path,"w",encoding="utf-8") as f: f.write(index.replace("</body>",probe+"</body>"))

    key_path=os.path.join(hls,"aes.key")
    with open(key_path,"wb") as f: f.write(bytes(range(16)))
    key_info=os.path.join(hls,"aes-key-info.txt")
    with open(key_info,"w",encoding="utf-8") as f:
        f.write("aes.key\n"+key_path+"\n000102030405060708090a0b0c0d0e0f\n")
    subprocess.run([
        ffmpeg,"-hide_banner","-loglevel","error","-y",
        "-i",os.path.join(hls,"media.m3u8"),"-c","copy",
        "-hls_time","10","-hls_list_size","0",
        "-hls_key_info_file",key_info,
        "-hls_segment_filename",os.path.join(hls,"encseg%d.ts"),
        os.path.join(hls,"encindex.m3u8"),
    ],check=True,timeout=60)
    try: os.remove(key_info)
    except OSError: pass

    plain=os.path.join(hls,"seg0.ts"); enc=os.path.join(hls,"encseg0.ts")
    if os.path.getsize(plain)<100_000 or os.path.getsize(enc)<100_000:
        raise RuntimeError("generated HLS fixture is unexpectedly small")
    print("[fixture] generated valid HLS/AES media",os.path.getsize(plain),os.path.getsize(enc),flush=True)
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


def print_log_tail(path, limit=30000):
    try:
        with open(path,encoding="utf-8",errors="replace") as f: text=f.read()
        if text:
            print("[browser log tail]",flush=True)
            print(text[-limit:],flush=True)
    except Exception as exc:
        print("[browser log unavailable]",repr(exc),flush=True)


def browser_run(browser, root, functional=False, fixture_root=None):
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
    fp=None
    if functional:
        if not fixture_root: raise RuntimeError("functional browser run requires fixture_root")
        fp=subprocess.Popen([
            sys.executable,os.path.join(REPO_ROOT,"scripts","e2e_fixture_server.py"),
            str(fixture_port),fixture_root,
        ],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    procs=[p for p in (bp,fp) if p is not None]

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
        if general.returncode!=0:
            log.flush(); print_log_tail(log_path)
            return False
        libav=subprocess.run([sys.executable,os.path.join(REPO_ROOT,"scripts","verify_aes.py"),str(fixture_port)],env=e,timeout=240)
        if libav.returncode!=0:
            log.flush(); print_log_tail(log_path)
            return False
        # Root-relative URIs and a separate audio rendition (the two shapes that
        # used to end as a bare rc=-1).
        nested=subprocess.run([sys.executable,os.path.join(REPO_ROOT,"scripts","verify_hls_nested.py"),str(fixture_port)],env=e,timeout=300)
        if nested.returncode!=0:
            log.flush(); print_log_tail(log_path)
            return False
        # Opt-in: a ~900 MiB artifact through the real ffmpeg path. Slow (the
        # fixture is generated with the host ffmpeg), so it is not part of the
        # default gate; MEDIA_SNIPER_E2E_LARGE=1 turns it on.
        if os.environ.get("MEDIA_SNIPER_E2E_LARGE") == "1":
            large=subprocess.run([sys.executable,os.path.join(REPO_ROOT,"scripts","e2e_large_output_test.py")],env=os.environ.copy())
            if large.returncode!=0:
                log.flush(); print_log_tail(log_path)
                return False
        # Opt-in: live recording (start, stop, keep the partial file).
        if os.environ.get("MEDIA_SNIPER_E2E_LIVE") == "1":
            live=subprocess.run([sys.executable,os.path.join(REPO_ROOT,"scripts","e2e_live_recording_test.py")],env=os.environ.copy())
            if live.returncode!=0:
                log.flush(); print_log_tail(log_path)
                return False
        # Opt-in: DASH video+audio mux with tracks past the old memory budget.
        if os.environ.get("MEDIA_SNIPER_E2E_DASH") == "1":
            dash=subprocess.run([sys.executable,os.path.join(REPO_ROOT,"scripts","e2e_dash_mux_test.py")],env=os.environ.copy())
            if dash.returncode!=0:
                log.flush(); print_log_tail(log_path)
                return False
        # Opt-in: media on a host the extension has not been granted (VDH ships
        # <all_urls>, this build asks at runtime).
        if os.environ.get("MEDIA_SNIPER_E2E_HOST_ACCESS") == "1":
            host_access=subprocess.run([sys.executable,os.path.join(REPO_ROOT,"scripts","e2e_host_access_test.py")],env=os.environ.copy())
            if host_access.returncode!=0:
                log.flush(); print_log_tail(log_path)
                return False
        # Opt-in: does the extension detect every media URL the page itself
        # fetched (the differential that keeps "VDH finds it, we do not" closed)?
        if os.environ.get("MEDIA_SNIPER_E2E_COVERAGE") == "1":
            cov=subprocess.run([sys.executable,os.path.join(REPO_ROOT,"scripts","e2e_detection_coverage.py")],env=os.environ.copy(),timeout=900)
            if cov.returncode!=0:
                log.flush(); print_log_tail(log_path)
                return False
        # Opt-in: per-entry thumbnails taken from the page.
        if os.environ.get("MEDIA_SNIPER_E2E_THUMB") == "1":
            thumb=subprocess.run([sys.executable,os.path.join(REPO_ROOT,"scripts","e2e_thumbnail_test.py")],env=os.environ.copy())
            if thumb.returncode!=0:
                log.flush(); print_log_tail(log_path)
                return False
        return True
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

    harness=None; fixture=None
    try:
        harness=make_functional_harness(BASE_EXTENSION_ROOT)
        fixture=make_fixture_harness()
        print("[gate 2] localhost-only functional harness",flush=True)
        ok=browser_run(browser,harness,True,fixture)
        print("RUNNER:","PASS" if ok else "FAIL",flush=True)
        return ok
    finally:
        if harness and not KEEP: shutil.rmtree(harness,ignore_errors=True)
        if fixture and not KEEP: shutil.rmtree(fixture,ignore_errors=True)


if __name__=="__main__":
    try: sys.exit(0 if main() else 1)
    except Exception as exc:
        print("RUNNER: FAIL",repr(exc),flush=True); sys.exit(1)
