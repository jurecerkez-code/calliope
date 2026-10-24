#!/usr/bin/env python3
"""Paste a link. The site's raw HTML appears.

The smallest useful slice of Calliope: a URL goes in, the page is fetched,
sanitized and served back on the right. No model, no voice, no drawing — this
is only the part that decides what "the website we want to change" even is.

Run:  python3 server.py     then open http://127.0.0.1:8899
"""
import json
import os
import re
import sys
import time
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
SITE = os.path.join(HERE, "site")
PAGE = os.path.join(SITE, "page.html")
META = os.path.join(SITE, "meta.json")
PORT = int(os.environ.get("PORT", "8899"))

sys.path.insert(0, HERE)
from import_site import fetch, sanitize, normalize_url, title_of, text_weight  # noqa: E402

MIME = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8", ".png": "image/png",
        ".svg": "image/svg+xml", ".ico": "image/x-icon"}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            print("  %s" % (fmt % args))

    # ---- helpers
    def send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def j(self, code, obj):
        self.send(code, json.dumps(obj))

    def read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads((self.rfile.read(n) if n else b"{}").decode("utf-8") or "{}")

    def file(self, path):
        if not os.path.isfile(path):
            return self.send(404, "not found", "text/plain")
        with open(path, "rb") as f:
            data = f.read()
        self.send(200, data, MIME.get(os.path.splitext(path)[1], "application/octet-stream"))

    # ---- routes
    def do_GET(self):
        p = self.path.split("?")[0]
        if p in ("/", "/index.html"):
            return self.file(os.path.join(STATIC, "index.html"))
        if p == "/site":
            if not os.path.isfile(PAGE):
                return self.send(404, "nothing imported yet", "text/plain")
            return self.file(PAGE)
        if p == "/api/meta":
            if not os.path.isfile(META):
                return self.j(200, {"imported": False})
            try:
                with open(META, encoding="utf-8") as f:
                    m = json.load(f)
                m["imported"] = True
                return self.j(200, m)
            except Exception:
                return self.j(200, {"imported": False})
        if p == "/api/health":
            return self.j(200, {"ok": True, "site": os.path.isfile(PAGE)})
        if p.startswith("/static/"):
            fp = os.path.normpath(os.path.join(STATIC, p[len("/static/"):]))
            if not fp.startswith(STATIC):
                return self.send(403, "nope", "text/plain")
            return self.file(fp)
        return self.send(404, "not found", "text/plain")

    def do_POST(self):
        if self.path.split("?")[0] == "/api/import":
            return self.import_page()
        return self.send(404, "not found", "text/plain")

    def import_page(self):
        """Link in, sanitized HTML out."""
        try:
            payload = self.read_json()
        except Exception as e:
            return self.j(400, {"error": "bad json: %s" % e})

        try:
            url = normalize_url(payload.get("url"))
        except ValueError as e:
            return self.j(400, {"error": str(e)})

        t0 = time.time()
        try:
            raw = fetch(url)
        except ValueError as e:
            return self.j(400, {"error": str(e)})
        except urllib.error.HTTPError as e:
            return self.j(502, {"error": "the site answered %s for that link" % e.code})
        except Exception as e:
            return self.j(502, {"error": "could not reach that link (%s)" % type(e).__name__})

        clean = sanitize(raw, url)
        os.makedirs(SITE, exist_ok=True)
        with open(PAGE, "w", encoding="utf-8") as f:
            f.write(clean)

        meta = {
            "url": url,
            "title": title_of(raw),
            "host": re.sub(r"^www\.", "", re.match(r"https?://([^/]+)", url).group(1)),
            "bytes": len(clean),
            "words": text_weight(clean),      # the client measures the rendered result too
            "scripts_removed": len(re.findall(r"<script", raw, flags=re.I)),
            "imported_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "ms": int((time.time() - t0) * 1000),
        }
        with open(META, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
        meta["ok"] = True
        meta["imported"] = True
        return self.j(200, meta)


def main():
    print("calliope import  http://127.0.0.1:%d" % PORT)
    print("  paste a link in the browser; nothing else is wired up here")
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    srv.daemon_threads = True
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
