"""
Safari Ember preview server: the site and the booking API together, on this computer and on
your phone over your home Wi-Fi.

    python server.py            (from C:\\dev\\safari-ember)

Then open the "Phone" address it prints on a phone that's on the same Wi-Fi.
Stop it with Ctrl+C. Nothing is visible outside your own network.

It serves the site from ./frontend and forwards /api/... to the API on http://localhost:3000
(start that first: cd api, then npm run dev). That mirrors what Netlify does in production,
so the site behaves the same locally: one address, same paths, no extra settings.

Why not plain `python -m http.server`:
  * iPhones (Safari) only play video from a server that can send a file in pieces
    ("Range requests"). The built-in server always sends the whole file, so on an
    iPhone the hero would show just the poster. This one handles Range.
  * The built-in server answers one request at a time, so one big video download
    stalls the rest of the page. This one handles requests in parallel.
  * No caching, so a refresh always shows your latest edit.
"""
import http.client
import http.server
import mimetypes
import os
import re
import socket
import sys

PORT = 8000
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend")   # wherever it's run from
API_HOST, API_PORT = "localhost", 3000
SITE_ORIGIN = "http://localhost:8000"               # the API's SITE_URL in development
HOP_BY_HOP = {"connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer"}

# Windows reads file types from the registry, which is sometimes wrong (e.g. .js as text/plain).
# Pin the ones this site uses.
for ext, kind in {
    ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json",
    ".svg": "image/svg+xml", ".webp": "image/webp", ".avif": "image/avif", ".png": "image/png",
    ".jpg": "image/jpeg", ".mp4": "video/mp4", ".webm": "video/webm",
}.items():
    mimetypes.add_type(kind, ext)


class Handler(http.server.SimpleHTTPRequestHandler):
    # HTTP/1.1 keeps one connection open for many requests, instead of a new one each time.
    # It needs every reply to state its exact length (Content-Length), which all of them here do.
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        if not self.path.startswith("/api/"):        # the API sets its own caching headers
            self.send_header("Cache-Control", "no-store")
            self.send_header("Accept-Ranges", "bytes")   # tells the phone it may ask for pieces
        super().end_headers()

    # ── /api/... → the API (adapted from NURA's server.py) ──────────────────────────────────
    def _proxy(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_BY_HOP and k.lower() != "host"}
        # A phone opens http://192.168.x.x:8000, so its bookings carry that Origin, and the API's
        # cross-site check (which only knows http://localhost:8000) would refuse them. Translate
        # it, but ONLY when the Origin is this very server (the address the request came in on):
        # that is same-origin by definition. Any other Origin passes through untouched, so a
        # cross-site write is still refused, exactly as in production.
        # Header names are case-insensitive ("Origin", "origin"), so find it whatever its case.
        origin_key = next((k for k in headers if k.lower() == "origin"), None)
        if origin_key and headers[origin_key] == "http://" + (self.headers.get("Host") or ""):
            headers[origin_key] = SITE_ORIGIN
        try:
            conn = http.client.HTTPConnection(API_HOST, API_PORT, timeout=30)
            conn.request(self.command, self.path, body=body, headers=headers)
            res = conn.getresponse()
            data = res.read()
        except OSError:
            data = b'{"error":"API not running. Start it with: cd api, then npm run dev"}'
            self.send_response(502)                  # what Netlify answers when the API is down
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.send_response(res.status)
        for k, v in res.getheaders():
            if k.lower() not in HOP_BY_HOP and k.lower() != "content-length":
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        return self._proxy() if self.path.startswith("/api/") else super().do_GET()

    def do_HEAD(self):
        return self._proxy() if self.path.startswith("/api/") else super().do_HEAD()

    def do_POST(self):
        return self._proxy() if self.path.startswith("/api/") else self.send_error(405)

    def do_PATCH(self):
        return self._proxy() if self.path.startswith("/api/") else self.send_error(405)

    def do_PUT(self):
        return self._proxy() if self.path.startswith("/api/") else self.send_error(405)

    def do_DELETE(self):
        return self._proxy() if self.path.startswith("/api/") else self.send_error(405)

    def send_head(self):
        # No Range header (or a folder): the normal whole-file answer.
        rng = self.headers.get("Range")
        path = self.translate_path(self.path)
        if not rng or os.path.isdir(path):
            return super().send_head()

        m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip())
        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None
        size = os.fstat(f.fileno()).st_size

        # Work out which bytes were asked for: "a-b", "a-" (to the end) or "-n" (the last n).
        if not m or (m.group(1) == "" and m.group(2) == ""):
            start, end = None, None
        elif m.group(1) == "":
            n = int(m.group(2))
            start, end = max(0, size - n), size - 1
        else:
            start = int(m.group(1))
            end = int(m.group(2)) if m.group(2) else size - 1
            end = min(end, size - 1)
        if start is None or start > end or start >= size:
            f.close()
            self.send_response(416)                  # the range is outside the file
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None

        self.send_response(206)                      # "here's the piece you asked for"
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        f.seek(start)
        self._remaining = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        # For a piece, send only those bytes; otherwise the whole file as usual.
        remaining = getattr(self, "_remaining", None)
        if remaining is None:
            return super().copyfile(source, outputfile)
        self._remaining = None
        while remaining > 0:
            chunk = source.read(min(64 * 1024, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)

    def log_message(self, fmt, *args):
        pass                                         # quiet: phones fire many video requests


def lan_ip():
    # The address other devices on your Wi-Fi use to reach this computer. Opening a UDP
    # "connection" sends nothing; it just makes the system pick the right network card.
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    server = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    ip = lan_ip()
    print("Safari Ember is being served from", ROOT, "(API expected on http://localhost:3000)")
    print(f"  This computer:  http://localhost:{PORT}")
    print(f"  Phone:          http://{ip}:{PORT}   (same Wi-Fi)")
    print("Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        sys.exit(0)
