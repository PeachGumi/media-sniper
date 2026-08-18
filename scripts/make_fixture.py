#!/usr/bin/env python3
"""Create a tiny HLS fixture: master + media playlist + fake .ts segments."""
import os

out = "test/fixture/hls"
os.makedirs(out, exist_ok=True)

master = """#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
media.m3u8
"""

media_lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:2"]
for i in range(8):
    seg = f"seg{i}.ts"
    # fake TS segment: real downloads test the pipeline, content doesn't matter
    with open(os.path.join(out, seg), "wb") as f:
        f.write(b"\x47" + bytes([i]) * 187)  # 188-byte TS sync byte
    media_lines.append("#EXTINF:2.000,")
    media_lines.append(seg)
media_lines.append("#EXT-X-ENDLIST")

with open(os.path.join(out, "master.m3u8"), "w") as f:
    f.write(master)
with open(os.path.join(out, "media.m3u8"), "w") as f:
    f.write("\n".join(media_lines) + "\n")

# plain mp4-ish page asset: serve an existing real mp4 if we have one, else tiny file
page = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>MediaSniper test page</title></head>
<body>
<h1>test page</h1>
<video id="v1" src="clip.mp4" controls width="320"></video>
<video id="v2" src="hls/master.m3u8" controls width="320"></video>
<audio id="a1" src="audio.mp3" controls></audio>
</body></html>
"""
with open(os.path.join(out, "index.html"), "w") as f:
    f.write(page)

# dummy media files
with open(os.path.join(out, "clip.mp4"), "wb") as f:
    f.write(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 4096)
with open(os.path.join(out, "audio.mp3"), "wb") as f:
    f.write(b"ID3" + b"\x00" * 2048)

print("fixture written to", out)
