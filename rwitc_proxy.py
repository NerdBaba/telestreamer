#!/usr/bin/env python3
"""Local proxy for the RWITC live stream.

Serves the live HLS on http://127.0.0.1:8765/ with the CloudFront signed
cookies injected server-side, so any player (IINA, VLC, QuickTime, a browser)
can open a plain http:// URL with no auth, no cookies, no query params.

Why this instead of handing the player a signed URL or cookie file:
  * HLS clients resolve the playlist's RELATIVE segment URLs against the
    playlist URL, so query-string signing signs only the playlist and every
    .ts still 403s (observed).
  * Cookie files depend on each player's own parser and scoping; mpv's
    --cookies-file failed to attach for cfs.rwitc.com here.

The proxy re-signs on the fly, so it survives cookie expiry and the
per-meeting URL rotation with no restart.

Usage:
    python3 rwitc_proxy.py                 # serve on :8765, prints the URL
    python3 rwitc_proxy.py --port 9000
    python3 rwitc_proxy.py --open          # also launch IINA on the local URL
"""

from __future__ import annotations

import argparse
import importlib.util
import http.server
import os
import socketserver
import sys
import threading
import urllib.error
import urllib.request
from urllib.parse import unquote, urljoin, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))

# Load the resolver without executing its __main__ block.
_spec = importlib.util.spec_from_file_location("rwitc_live",
                                               os.path.join(HERE, "rwitc_live.py"))
rl = importlib.util.module_from_spec(_spec)
sys.modules["rwitc_live"] = rl
_spec.loader.exec_module(rl)


# --------------------------------------------------------------------------

class Relay:
    """Fetches remote URLs under cfs.rwitc.com with fresh signed cookies."""

    def __init__(self) -> None:
        self._stream: rl.LiveStream | None = None
        self._lock = threading.Lock()

    @property
    def stream(self) -> rl.LiveStream:
        with self._lock:
            if self._stream is None:
                self._stream = rl.LiveStream.fetch()
            return self._stream

    def invalidate(self) -> None:
        """Drop the cached stream so the next request re-resolves it."""
        with self._lock:
            self._stream = None

    def fetch(self, remote_url: str) -> tuple[int, bytes, str]:
        """Return (status, body, content_type) for a remote URL.

        Retries once after re-resolving the stream record, which covers both
        cookie expiry and the per-meeting URL rotation.
        """
        last: tuple[int, bytes, str] | None = None
        for attempt in (0, 1):
            try:
                st = self.stream
                req = urllib.request.Request(remote_url)
                req.add_header("Cookie", st.signing.cookie)
                with urllib.request.urlopen(req, timeout=20) as r:
                    return r.status, r.read(), (r.headers.get("Content-Type")
                                                or "application/octet-stream")
            except urllib.error.HTTPError as e:
                body = e.read()
                last = (e.code, body, e.headers.get("Content-Type")
                        or "application/octet-stream")
                # 403 = signature expired or URL rotated: re-resolve and retry
                self.invalidate()
            except Exception as e:  # network blip
                last = (502, str(e).encode(), "text/plain")
        return last or (502, b"unreachable", "text/plain")


RELAY = Relay()


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "RWITCProxy/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:  # keep console quiet
        if self.path.startswith("/healthz"):
            return
        sys.stderr.write("  %s\n" % (fmt % args))

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]

        if path == "/healthz":
            return self._send(200, b"ok\n", "text/plain")

        if path == "/index.m3u8":
            return self._index()

        return self._relay(path)

    # -- handlers ----------------------------------------------------------

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache, no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _index(self) -> None:
        st = RELAY.stream
        code, body, ctype = RELAY.fetch(st.master_url)
        if code != 200:
            return self._send(code, body, "text/plain")
        # Rewrite nothing: keep the variant path relative, so segments resolve
        # against this proxy and pick up auth server-side.
        self.send_response(200)
        self.send_header("Content-Type", ctype or "application/vnd.apple.mpegurl")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _relay(self, path: str) -> None:
        # Keep the path percent-encoded: the remote variant directory contains
        # literal spaces ("640 x 360"), and decoding them breaks urljoin.
        st = RELAY.stream
        remote = urljoin(st.master_url, path.lstrip("/"))
        code, body, ctype = RELAY.fetch(remote)
        if code != 200:
            return self._send(code, body, "text/plain")
        # Re-emit unchanged: playlist paths are already relative to the same
        # base as the master, so clients re-request them through this proxy.
        self.send_response(200)
        self.send_header("Content-Type",
                         ctype or ("application/vnd.apple.mpegurl"
                                   if path.endswith(".m3u8")
                                   else "video/mp2t"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def launch_iina(url: str) -> int:
    import shutil
    cli = "/Applications/IINA.app/Contents/MacOS/iina-cli"
    exe = cli if os.path.exists(cli) else shutil.which("iina-cli")
    if not exe:
        return 1
    return subprocess_run(exe, url)


def subprocess_run(exe: str, url: str) -> int:
    import subprocess
    try:
        return subprocess.Popen([exe, "--keep-running", "--no-stdin", url],
                                start_new_session=True).poll()
    except FileNotFoundError:
        return 127


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--open", action="store_true",
                    help="launch IINA on the local URL")
    args = ap.parse_args()

    # Resolve once up front so a bad day fails loudly here, not in the player.
    st = RELAY.stream
    variants = ", ".join(d for d, _ in st.variants())
    sys.stderr.write(f"RWITC live: venue stream active, variants: {variants}\n")
    sys.stderr.write(f"serving on http://127.0.0.1:{args.port}/index.m3u8\n")

    if args.open:
        launch_iina(f"http://127.0.0.1:{args.port}/index.m3u8")

    with Server(("127.0.0.1", args.port), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            sys.stderr.write("\nstopped\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
