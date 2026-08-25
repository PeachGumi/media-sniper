#!/usr/bin/env python3
"""Packaged-browser E2E for the bundled libav runtime.

First proves plain MPEG-TS HLS remux works, then exercises AES-128 encrypted
HLS through the same offscreen ffmpeg path. This isolates HLS/jsfetch support
from crypto support when a reproducible libav build regresses.
"""
import asyncio
import json
import os
import sys
import time
import urllib.parse
import urllib.request

try:
    import websockets
except ImportError as exc:
    raise SystemExit("websockets is required: pip install websockets") from exc

CDP_PORT = int(os.environ.get("CDP_PORT", "9222"))
CDP = f"http://127.0.0.1:{CDP_PORT}"
EXT_ID = os.environ.get("MEDIA_SNIPER_EXTENSION_ID", "").strip()
if not EXT_ID: raise SystemExit("MEDIA_SNIPER_EXTENSION_ID is required")
FIXTURE_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
FIX = f"http://127.0.0.1:{FIXTURE_PORT}"
PLAIN = FIX + "/hls/media.m3u8"
ENC = FIX + "/hls/encindex.m3u8"
PAGE = FIX + "/hls/index.html"
ALL = ["http://*/*", "https://*/*"]
PREGRANTED = os.environ.get("MEDIA_SNIPER_E2E_PREGRANTED") == "1"


def targets():
    with urllib.request.urlopen(CDP + "/json/list", timeout=5) as r: return json.loads(r.read().decode())

def find_target(kind, part): return next((t for t in targets() if t.get("type") == kind and part in (t.get("url") or "")), None)

def open_tab(url):
    req=urllib.request.Request(CDP+"/json/new?"+urllib.parse.quote(url,safe=":/?=&"),method="PUT")
    with urllib.request.urlopen(req,timeout=5) as r: return json.loads(r.read().decode())

async def eval_ws(ws_url, expr, timeout=30, user_gesture=False):
    async with websockets.connect(ws_url,max_size=50_000_000) as ws:
        await ws.send(json.dumps({"id":1,"method":"Runtime.enable"})); await ws.recv()
        params={"expression":expr,"returnByValue":True,"awaitPromise":True}
        if user_gesture: params["userGesture"]=True
        await ws.send(json.dumps({"id":2,"method":"Runtime.evaluate","params":params}))
        deadline=time.time()+timeout
        while time.time()<deadline:
            msg=json.loads(await asyncio.wait_for(ws.recv(),timeout=max(.1,deadline-time.time())))
            if msg.get("id")!=2: continue
            res=msg.get("result",{}).get("result",{})
            if res.get("subtype")=="error": raise RuntimeError(res.get("description","Runtime.evaluate failed"))
            return res.get("value")
    raise TimeoutError("Runtime.evaluate timeout")

async def permission_origins(ws_url):
    raw=await eval_ws(ws_url,"chrome.permissions.getAll().then(p=>JSON.stringify(p.origins||[]))",timeout=5)
    return json.loads(raw) if isinstance(raw,str) else (raw or [])

async def wait_permission(ws_url,granted,seconds=12):
    deadline=time.time()+seconds; last=[]
    while time.time()<deadline:
        last=await permission_origins(ws_url); has_all=all(x in last for x in ALL)
        if has_all==granted: return last
        await asyncio.sleep(.4)
    return last

async def run_hls(sw_url, url, title, tab_id):
    expr=("startHls("+str(tab_id)+","+json.dumps(url)+","+json.dumps(url)+","+json.dumps(title)+","+json.dumps(PAGE)+",null,null)"
          ".then(r=>JSON.stringify(r)).catch(e=>JSON.stringify({error:String(e)}))")
    raw=await eval_ws(sw_url,expr,timeout=90)
    result=json.loads(raw) if raw else {}
    print(title+" start:",result,flush=True)
    return result

async def wait_download(sw_url,title,minimum):
    record=None; deadline=time.time()+60
    while time.time()<deadline:
        expr="chrome.downloads.search({}).then(items=>{const m=items.filter(i=>i.filename&&i.filename.includes("+json.dumps(title)+")).sort((a,b)=>b.id-a.id)[0];return m?JSON.stringify({state:m.state,error:m.error,bytes:m.bytesReceived,filename:m.filename}):null})"
        raw=await eval_ws(sw_url,expr,timeout=10)
        if raw:
            record=json.loads(raw)
            if record.get("state") in ("complete","interrupted"): break
        await asyncio.sleep(1)
    if not record or record.get("state")!="complete": raise RuntimeError(title+" download did not complete: "+str(record))
    if int(record.get("bytes") or 0)<minimum: raise RuntimeError(title+" output unexpectedly small: "+str(record))
    return record

async def main():
    popup=find_target("page","popup/popup.html")
    if not popup:
        open_tab(f"chrome-extension://{EXT_ID}/popup/popup.html"); await asyncio.sleep(1); popup=find_target("page","popup/popup.html")
    if not popup: raise RuntimeError("popup target not found")
    popup_ws=popup["webSocketDebuggerUrl"]
    if PREGRANTED:
        origins=await permission_origins(popup_ws)
        if "http://127.0.0.1/*" not in origins: raise RuntimeError("localhost functional harness grant missing: "+repr(origins))
    else:
        await eval_ws(popup_ws,"(function(){const b=document.getElementById('accessAll'); if(!b) throw new Error('accessAll missing'); b.click(); return true;})()",user_gesture=True)
        origins=await wait_permission(popup_ws,True)
        if not all(x in origins for x in ALL): raise RuntimeError("optional host permission was not granted: "+repr(origins))

    sw=find_target("service_worker",EXT_ID)
    if not sw: raise RuntimeError("service worker target not found")
    sw_url=sw["webSocketDebuggerUrl"]

    # Stage 1: plain HLS. If this fails, the regression is HLS/jsfetch/TS,
    # not AES. startHls returns only after ffmpeg has produced its blob.
    plain=await run_hls(sw_url,PLAIN,"e2e plain libav",9002)
    if plain.get("error"): raise RuntimeError("plain HLS failed before AES: "+str(plain.get("error")))
    plain_dl=await wait_download(sw_url,"e2e plain libav",100_000)
    print("plain HLS -> reproducible libav -> MP4: PASS",plain_dl,flush=True)

    # Stage 2: AES-128 HLS.
    aes=await run_hls(sw_url,ENC,"e2e aes libav",9003)
    if aes.get("error"): raise RuntimeError("AES HLS failed: "+str(aes.get("error")))
    record=await wait_download(sw_url,"e2e aes libav",100_000)
    filename=record.get("filename") or ""
    if not filename.lower().endswith(".mp4"): raise RuntimeError("AES HLS output is not MP4: "+filename)
    for _ in range(30):
        if os.path.isfile(filename): break
        await asyncio.sleep(.2)
    if not os.path.isfile(filename): raise RuntimeError("downloaded MP4 is not present on disk: "+filename)
    with open(filename,"rb") as f: head=f.read(64)
    if b"ftyp" not in head: raise RuntimeError("downloaded file lacks MP4 ftyp signature")
    print("AES-128 HLS -> reproducible libav -> MP4: PASS",record,flush=True)

    for rec in (plain_dl,record):
        try: os.remove(rec.get("filename") or "")
        except OSError: pass

    if not PREGRANTED:
        await eval_ws(popup_ws,"(function(){const b=document.getElementById('accessClick'); if(!b) throw new Error('accessClick missing'); b.click(); return true;})()",user_gesture=True)
        origins=await wait_permission(popup_ws,False)
        if origins: raise RuntimeError("persistent host permission was not removed: "+repr(origins))

if __name__=="__main__":
    try: asyncio.run(main())
    except Exception as exc:
        print("LIBAV HLS E2E: FAIL",repr(exc),flush=True); sys.exit(1)
