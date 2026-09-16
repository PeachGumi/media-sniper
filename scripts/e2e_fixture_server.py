#!/usr/bin/env python3
"""Static E2E fixture server with one header-protected HLS path."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
import sys
import time

TOKEN = "Bearer media-sniper-e2e"
# A live HLS fixture: the playlist has no EXT-X-ENDLIST and its sliding window
# keeps growing, so a recording runs until the extension stops it.
LIVE_SEGMENT_SECONDS = 2
LIVE_WINDOW = 4
LIVE_START = time.time()


class Handler(SimpleHTTPRequestHandler):
    def live_segments(self):
        """Segments generated for the live fixture, in timeline order."""
        hls = os.path.join(os.getcwd(), "hls")
        try:
            names = [name for name in os.listdir(hls) if name.startswith("seg") and name.endswith(".ts")]
        except OSError:
            return []
        return sorted(names, key=lambda name: int(name[3:-3]))

    def live_playlist(self):
        available = self.live_segments()
        if not available:
            self.send_error(500, "live fixture has no segments")
            return
        # The window grows one segment per LIVE_SEGMENT_SECONDS and stops at the
        # end of the generated timeline, so the recording only finishes when the
        # extension interrupts ffmpeg.
        produced = min(len(available), int((time.time() - LIVE_START) // LIVE_SEGMENT_SECONDS) + 3)
        first = max(0, produced - LIVE_WINDOW)
        lines = [
            "#EXTM3U",
            "#EXT-X-VERSION:3",
            f"#EXT-X-TARGETDURATION:{LIVE_SEGMENT_SECONDS}",
            f"#EXT-X-MEDIA-SEQUENCE:{first}",
        ]
        for index in range(first, produced):
            lines.append(f"#EXTINF:{LIVE_SEGMENT_SECONDS}.0,")
            lines.append(f"live{index}.ts")
        body = ("\n".join(lines) + "\n").encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/vnd.apple.mpegurl")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/hls/live.m3u8":
            self.live_playlist()
            return
        if path.startswith("/hls/live") and path.endswith(".ts"):
            # live<N>.ts serves the Nth segment of the generated timeline, so the
            # timestamps keep advancing the way a real live stream does.
            available = self.live_segments()
            try:
                index = int(os.path.basename(path)[4:-3])
            except ValueError:
                self.send_error(404, "unknown live segment")
                return
            index = min(max(index, 0), len(available) - 1) if available else 0
            source = os.path.join(os.getcwd(), "hls", available[index] if available else "seg0.ts")
            size = os.path.getsize(source)
            self.send_response(200)
            self.send_header("Content-Type", "video/mp2t")
            self.send_header("Content-Length", str(size))
            self.end_headers()
            with open(source, "rb") as stream:
                self.wfile.write(stream.read())
            return
        if path == "/hls/slow-direct.mp4":
            source = os.path.join(os.getcwd(), "hls", "clip.mp4")
            size = os.path.getsize(source)
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(size))
            self.end_headers()
            with open(source, "rb") as stream:
                while True:
                    chunk = stream.read(512)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
                    time.sleep(.3)
            return
        if path in ("/hls/slowmanifest.m3u8", "/hls/slowaudio.aac"):
            # Keep the offscreen job alive beyond MV3's ordinary idle window.
            # The popup is closed immediately after starting this fixture.
            time.sleep(35)
        if path in ("/hls/auth.m3u8", "/hls/authseg0.ts"):
            if self.headers.get("Authorization") != TOKEN:
                self.send_response(403)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(b"missing fixture authorization")
                return
        super().do_GET()

    def log_message(self, format, *args):
        del format, args
        pass


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: e2e_fixture_server.py PORT ROOT")
    port = int(sys.argv[1])
    os.chdir(sys.argv[2])
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
