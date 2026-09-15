#!/usr/bin/env python3
"""Static E2E fixture server with one header-protected HLS path."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
import sys
import time

TOKEN = "Bearer media-sniper-e2e"


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?", 1)[0]
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
