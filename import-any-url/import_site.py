#!/usr/bin/env python3
"""Import the raw HTML of a live site so Calliope can edit it in-place.

The page is downloaded, scripts and preloads are stripped (they would re-hydrate
React and wipe our DOM edits), and a <base> tag is injected so relative asset
URLs still resolve against the original origin.

Usage:  python3 import_site.py [url] [outfile]
"""
import re
import sys
import os
import urllib.request

DEFAULT_URL = "https://www.meetjamie.ai/"
DEFAULT_OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "site", "page.html")
MAX_BYTES = 6 * 1024 * 1024

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")

# Injected inside the iframe. Keeps the imported page from fighting our overlay
# and gives the edit-flash + anchor-box visuals a place to live.
OVERLAY_CSS = """
/* --- calliope injections --- */
html { scroll-behavior: auto !important; }
[data-cid].co-flash { animation: co-flash 900ms ease-out 1; }
@keyframes co-flash {
  0%   { box-shadow: 0 0 0 3px rgba(255,0,102,.95), 0 0 22px 6px rgba(255,0,102,.45); }
  100% { box-shadow: 0 0 0 3px rgba(255,0,102,0), 0 0 0 0 rgba(255,0,102,0); }
}
.co-anchor {
  position: absolute; pointer-events: none; z-index: 2147483600;
  border: 2px dashed #ff0066; border-radius: 8px;
  box-shadow: 0 0 0 1px rgba(255,255,255,.55) inset;
  transition: opacity .35s ease;
}
.co-anchor::after {
  content: attr(data-label); position: absolute; top: -22px; left: -2px;
  font: 600 11px/1.6 -apple-system, "SF Pro Text", system-ui, sans-serif;
  color: #fff; background: #ff0066; padding: 0 7px; border-radius: 5px;
  white-space: nowrap; letter-spacing: .02em;
}
"""


def fetch(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
    })
    with urllib.request.urlopen(req, timeout=45) as r:
        ctype = (r.headers.get("Content-Type") or "").lower()
        if ctype and "html" not in ctype and "xml" not in ctype:
            raise ValueError("that URL is not a web page (%s)" % ctype.split(";")[0])
        raw = r.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ValueError("page is larger than %d MB" % (MAX_BYTES // 1024 // 1024))
        charset = r.headers.get_content_charset() or "utf-8"
        return raw.decode(charset, "replace")


def normalize_url(raw):
    """'meetjamie.ai' -> 'https://meetjamie.ai/'. Rejects anything that isn't public http(s)."""
    from urllib.parse import urlparse
    import ipaddress
    import socket

    raw = (raw or "").strip()
    if not raw:
        raise ValueError("paste a link first")
    if not re.match(r"^https?://", raw, flags=re.I):
        raw = "https://" + raw
    p = urlparse(raw)
    host = (p.hostname or "").lower()
    if not host or "." not in host:
        raise ValueError("that doesn't look like a web address")
    if host in ("localhost", "localhost.localdomain") or host.endswith(".local"):
        raise ValueError("only public websites can be imported")
    try:
        for info in socket.getaddrinfo(host, None):
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_private or ip.is_loopback or ip.is_reserved or ip.is_link_local:
                raise ValueError("only public websites can be imported")
    except socket.gaierror:
        raise ValueError("could not resolve %s" % host)
    return p.geturl()


def title_of(html):
    m = re.search(r"<title[^>]*>(.*?)</title>", html, flags=re.S | re.I)
    return re.sub(r"\s+", " ", m.group(1)).strip()[:120] if m else ""


def text_weight(html):
    """Rough visible-text length; near zero means a client-rendered shell."""
    stripped = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", " ", html, flags=re.S | re.I)
    stripped = re.sub(r"<[^>]+>", " ", stripped)
    return len(re.sub(r"\s+", " ", stripped).strip())


def sanitize(html, url):
    """Strip anything that can re-render or re-hydrate the page under us."""
    # 1. scripts, inline and external, plus their bodies
    html = re.sub(r"<script\b[^>]*>.*?</script>", "", html, flags=re.S | re.I)
    html = re.sub(r"<script\b[^>]*/?>", "", html, flags=re.I)
    # 2. module preloads and speculative script looks
    html = re.sub(r"<link\b[^>]*rel=\"(?:modulepreload|prefetch)\"[^>]*>", "", html, flags=re.I)
    # 3. any CSP meta that would block our injected styles
    html = re.sub(r"<meta\b[^>]*http-equiv=\"Content-Security-Policy\"[^>]*>", "", html, flags=re.I)
    # 4. integrity/crossorigin on stylesheets (the origin differs, SRI still ok, but drop for safety)
    html = re.sub(r"\s+integrity=\"[^\"]*\"", "", html, flags=re.I)

    origin = re.match(r"(https?://[^/]+)", url).group(1)
    base = '<base href="%s/">' % origin
    style = "<style>%s</style>" % OVERLAY_CSS
    inject = base + style

    if re.search(r"<head[^>]*>", html, flags=re.I):
        html = re.sub(r"(<head[^>]*>)", lambda m: m.group(1) + inject, html, count=1, flags=re.I)
    else:
        html = inject + html
    return html


def main():
    url = normalize_url(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_URL)
    out = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT
    raw = fetch(url)
    clean = sanitize(raw, url)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write(clean)
    print("fetched  %s  %d bytes" % (url, len(raw)))
    print("written  %s  %d bytes" % (out, len(clean)))
    print("scripts stripped: %d" % len(re.findall(r"<script", raw, flags=re.I)))
    print("remaining script tags: %d" % len(re.findall(r"<script", clean, flags=re.I)))


if __name__ == "__main__":
    main()
