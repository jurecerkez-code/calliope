#!/usr/bin/env python3
"""Calliope — speak and draw on a real website, watch it change live.

Serves three things:
  /            the workspace (transcript on the left, the imported site on the right)
  /site        the imported, script-stripped HTML of meetjamie.ai
  /api/edit    transcript + drawn marks + DOM outline -> fast model -> DOM ops

Run:  python3 server.py     then open http://127.0.0.1:8899
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
SITE = os.path.join(HERE, "site")
OUT = os.path.join(HERE, "out")
PAGE = os.path.join(SITE, "page.html")
META = os.path.join(SITE, "meta.json")
PORT = int(os.environ.get("PORT", "8899"))

sys.path.insert(0, HERE)
from import_site import fetch, sanitize, normalize_url, title_of, text_weight  # noqa: E402

# --- models ---------------------------------------------------------------
# This workload asks for ~40 tokens of JSON. Time-to-first-token dominates, but
# Groq's inference is the fastest hosted option for small outputs, so it leads
# the chain when its key is present; OpenRouter/Grok stays as the fallback.
GROQ_URL = os.environ.get("CALLIOPE_GROQ_URL") or "https://api.groq.com/openai/v1/chat/completions"
OPENROUTER_URL = os.environ.get("CALLIOPE_OPENROUTER_URL") or "https://openrouter.ai/api/v1/chat/completions"

GROQ_MODEL = os.environ.get("CALLIOPE_GROQ_MODEL", "llama-3.3-70b-versatile")
OPENROUTER_MODEL = os.environ.get("CALLIOPE_MODEL", "x-ai/grok-4.20")
OPENROUTER_FALLBACK = os.environ.get("CALLIOPE_FALLBACK_MODEL", "x-ai/grok-4.7")

SYSTEM = """You are the edit engine behind a live webpage editor. A designer speaks and draws on a rendered website; you turn that into DOM operations that apply instantly.

Return ONLY minified JSON, no fences, no prose:
{"reasoning":"<=14 words","ops":[...]}

Ops (all target one existing cid):
  {"op":"style","cid":"e12","props":{"font-size":"64px","font-weight":"800","color":"#ff0066"}}
  {"op":"text","cid":"e12","text":"short new copy"}
  {"op":"html","cid":"e12","html":"<p>markup</p>"}
  {"op":"attr","cid":"e12","props":{"href":"https://...","src":"https://...","alt":"..."}}
  {"op":"cls","cid":"e12","add":"class-a class-b","remove":"class-c"}

Rules:
- 1 to 4 ops, each cid must come from the outline. Never invent markup hierarchies.
- Style props in kebab-case with concrete values: px, rem, %, hex, rgb(). Never "auto" for sizing.
- When you change font-size, always set line-height with it (1.02-1.1 for display type, 1.35-1.5 for body) or the text will collide.
- Match the page's existing aesthetic: premium B2B SaaS, neutral palette, generous whitespace, system font stack. Every section is one row of a landing page. Do not invent logos, testimonials, or customer names.
- Prefer the smallest change that satisfies the words. If the instruction is vague, pick the most likely marked element.
- If the spoken words and the drawn marks disagree, follow the marks and say so in reasoning.
- Nothing to change: {"reasoning":"why","ops":[]}
"""

# ---------------------------------------------------------------- key handling

def secret(name):
    """Environment first, then .env files — the same order the studio uses."""
    v = os.environ.get(name)
    if v:
        return v.strip()
    for path in (os.path.join(HERE, ".env"),                    # import-any-url/.env
                 os.path.join(HERE, os.pardir, ".env"),          # repo root .env
                 os.path.expanduser("~/.hermes/.env")):
        if not os.path.isfile(path):
            continue
        try:
            for line in open(path, encoding="utf-8", errors="replace"):
                s = line.strip()
                if not s or s.startswith("#") or "=" not in s:
                    continue
                k, val = s.split("=", 1)
                if k.strip() == name:
                    return val.strip().strip("\"'")
        except OSError:
            continue
    return ""


GROQ_KEY = secret("GROQ_API_KEY")
OPENROUTER_KEY = secret("OPENROUTER_API_KEY")


def providers():
    """(provider, url, model, key) in the order we try them.

    Groq leads: it is the fastest hosted inference for a 40-token reply. Grok
    stays behind it so an empty Groq key, a rate limit, or a bad response costs
    one fallback hop instead of the demo.
    """
    chain = []
    if GROQ_KEY:
        chain.append(("groq", GROQ_URL, GROQ_MODEL, GROQ_KEY))
    if OPENROUTER_KEY:
        chain.append(("openrouter", OPENROUTER_URL, OPENROUTER_MODEL, OPENROUTER_KEY))
        chain.append(("openrouter", OPENROUTER_URL, OPENROUTER_FALLBACK, OPENROUTER_KEY))
    return chain

# ------------------------------------------------------------- model plumbing

class ModelError(Exception):
    """Upstream provider said no: carries the status and the body it sent."""

    def __init__(self, code, detail):
        self.code = code
        self.detail = detail
        super().__init__("http %s: %s" % (code, detail))


def build_user_prompt(payload):
    outline = (payload.get("outline") or "").strip()[:9000]
    instruction = (payload.get("instruction") or "").strip()[:1200]
    marks = payload.get("marks") or []
    history = payload.get("history") or []

    parts = ["PAGE OUTLINE (cid / tag :: visible text):", outline or "(empty)"]

    if marks:
        parts.append("\nDRAWN MARKS:")
        for m in marks[:6]:
            cid = m.get("cid") or "?"
            line = '- [%s] %s :: "%s"  shape=%s' % (
                cid, m.get("tag", ""), (m.get("text") or "")[:110], m.get("shape", "mark"))
            parts.append(line)
            snip = (m.get("html") or "").strip()
            if snip:
                parts.append("    markup: " + snip[:1200])
    else:
        parts.append("\nDRAWN MARKS: none (voice only)")

    if history:
        done = [h for h in history[-4:] if h]
        if done:
            parts.append("\nALREADY APPLIED IN THIS SESSION: " + " | ".join(done)[:600])

    parts.append("\nSPOKEN INSTRUCTION: %s" % (instruction or "(none)"))
    parts.append("\nReply with the JSON object only.")
    return "\n".join(parts)


def call_model(prov, model, key, url, system, user, timeout=12, json_mode=True):
    """Both Groq and OpenRouter speak the OpenAI chat-completions shape."""
    payload = {
        "model": model,
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": user}],
        "temperature": 0.15,
        "max_tokens": 700,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    headers = {"Authorization": "Bearer " + key, "Content-Type": "application/json"}
    if prov == "openrouter":
        headers["HTTP-Referer"] = "http://127.0.0.1:%d" % PORT
        headers["X-Title"] = "Calliope"
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        # some models reject response_format; retry plainly, we parse tolerantly
        if json_mode and e.code in (400, 422) and "response_format" in detail:
            return call_model(prov, model, key, url, system, user, timeout, json_mode=False)
        raise ModelError(e.code, detail) from None


def extract_json(text):
    """Tolerant parse: handles fences, leading prose, and trailing junk."""
    if not text:
        return None
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    start = text.find("{")
    if start < 0:
        return None
    try:
        obj, _ = json.JSONDecoder().raw_decode(text[start:])
        return obj
    except ValueError:
        return None


BAD_VALUE = re.compile(r"(javascript|expression\s*\(|url\s*\(\s*['\"]?\s*javascript)", re.I)
PROP_OK = re.compile(r"^[a-zA-Z-]{2,32}$")


def sanitize_ops(ops, allowed_cids):
    clean, dropped = [], 0
    if not isinstance(ops, list):
        return clean, 1
    for op in ops[:6]:
        if not isinstance(op, dict):
            dropped += 1
            continue
        kind = str(op.get("op") or "").lower()
        cid = str(op.get("cid") or "")
        if cid not in allowed_cids:
            dropped += 1
            continue
        out = {"op": kind, "cid": cid}
        if kind == "style":
            props = op.get("props") or {}
            safe = {}
            for k, v in props.items():
                if not PROP_OK.match(str(k)):
                    continue
                v = str(v)[:120]
                if BAD_VALUE.search(v):
                    continue
                safe[str(k)] = v
            if not safe:
                dropped += 1
                continue
            out["props"] = safe
        elif kind == "text":
            out["text"] = str(op.get("text") or "")[:600]
        elif kind == "html":
            h = str(op.get("html") or "")[:4000]
            h = re.sub(r"<script\b[^>]*>.*?</script>", "", h, flags=re.S | re.I)
            h = re.sub(r"\son[a-z]+\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", "", h, flags=re.I)
            out["html"] = h
        elif kind == "attr":
            props = op.get("props") or {}
            safe = {}
            for k, v in props.items():
                v = str(v)[:400]
                if BAD_VALUE.search(v) or not PROP_OK.match(str(k)):
                    continue
                safe[str(k)] = v
            if not safe:
                dropped += 1
                continue
            out["props"] = safe
        elif kind == "cls":
            out["add"] = str(op.get("add") or "")[:200]
            out["remove"] = str(op.get("remove") or "")[:200]
        else:
            dropped += 1
            continue
        clean.append(out)
    return clean, dropped

# ------------------------------------------------------------------- handler

MIME = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8", ".svg": "image/svg+xml",
        ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon"}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if "api/edit" in (self.path or ""):
            print("  edit -> %s" % (fmt % args))

    # ---- helpers
    def send(self, code, body, ctype="application/json; charset=utf-8", cache="no-store"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def j(self, code, obj):
        self.send(code, json.dumps(obj))

    def read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    def file(self, path, ctype=None):
        if not os.path.isfile(path):
            return self.send(404, "not found", "text/plain")
        ext = os.path.splitext(path)[1]
        with open(path, "rb") as f:
            data = f.read()
        self.send(200, data, ctype or MIME.get(ext, "application/octet-stream"))

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
        if p == "/published":
            files = sorted(f for f in os.listdir(OUT) if f.endswith(".html")) if os.path.isdir(OUT) else []
            if not files:
                return self.send(404, "nothing published yet", "text/plain")
            return self.file(os.path.join(OUT, files[-1]))
        if p.startswith("/static/"):
            fp = os.path.normpath(os.path.join(STATIC, p[len("/static/"):]))
            if not fp.startswith(STATIC):
                return self.send(403, "nope", "text/plain")
            return self.file(fp)
        if p == "/api/health":
            chain = providers()
            return self.j(200, {
                "ok": True,
                "site": os.path.isfile(PAGE),
                "chain": [{"provider": c[0], "model": c[2]} for c in chain],
            })
        return self.send(404, "not found", "text/plain")

    def do_POST(self):
        p = self.path.split("?")[0]
        if p == "/api/import":
            return self.import_page()
        if p == "/api/edit":
            return self.edit()
        if p == "/api/publish":
            return self.publish()
        return self.send(404, "not found", "text/plain")

    def import_page(self):
        """Paste a link -> fetch the raw HTML -> sanitize -> serve it at /site."""
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
        words = text_weight(clean)   # reported to the client, which warns after render

        os.makedirs(SITE, exist_ok=True)
        with open(PAGE, "w", encoding="utf-8") as f:
            f.write(clean)
        meta = {
            "url": url,
            "title": title_of(raw),
            "host": re.sub(r"^www\.", "", re.match(r"https?://([^/]+)", url).group(1)),
            "bytes": len(clean),
            "words": words,
            "elements_hint": clean.count("<"),
            "imported_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "ms": int((time.time() - t0) * 1000),
        }
        with open(META, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
        meta["imported"] = True
        meta["ok"] = True
        return self.j(200, meta)

    def edit(self):
        t0 = time.time()
        try:
            payload = self.read_json()
        except Exception as e:
            return self.j(400, {"error": "bad json: %s" % e})

        allowed = set(re.findall(r"\[([A-Za-z0-9_-]+)\]", payload.get("outline") or ""))
        user = build_user_prompt(payload)
        last_err = None
        chain = providers()
        if not chain:
            return self.j(503, {"error": "no model configured — set GROQ_API_KEY or OPENROUTER_API_KEY"})
        for prov, url, model, key in chain:
            try:
                t_call = time.time()
                data = call_model(prov, model, key, url, SYSTEM, user)
                msg = data["choices"][0]["message"]["content"]
                obj = extract_json(msg)
                if obj is None:
                    last_err = "unparseable model output: %s" % (msg or "")[:160]
                    continue
                ops, dropped = sanitize_ops(obj.get("ops"), allowed)
                usage = data.get("usage") or {}
                return self.j(200, {
                    "reasoning": str(obj.get("reasoning") or "")[:300],
                    "ops": ops,
                    "dropped": dropped,
                    "provider": prov,
                    "model": data.get("model", model),
                    "tokens": usage.get("completion_tokens"),
                    "upstream_ms": int((time.time() - t_call) * 1000),
                    "ms": int((time.time() - t0) * 1000),
                })
            except ModelError as e:
                last_err = str(e)[:220]
            except Exception as e:
                last_err = "%s: %s" % (type(e).__name__, str(e)[:200])
        return self.j(502, {"error": last_err or "model failed", "ms": int((time.time() - t0) * 1000)})

    def publish(self):
        try:
            payload = self.read_json()
            html = payload.get("html") or ""
            if not html.strip():
                return self.j(400, {"error": "empty html"})
            os.makedirs(OUT, exist_ok=True)
            name = "published-%s.html" % time.strftime("%Y%m%d-%H%M%S")
            path = os.path.join(OUT, name)
            with open(path, "w", encoding="utf-8") as f:
                f.write(html)
            return self.j(200, {"ok": True, "file": path, "url": "/published"})
        except Exception as e:
            return self.j(500, {"error": str(e)})


def main():
    os.makedirs(OUT, exist_ok=True)
    chain = providers()
    print("calliope  http://127.0.0.1:%d" % PORT)
    print("  model chain: %s" % (" -> ".join("%s/%s" % (p, m) for p, _u, m, _k in chain) or "NONE (set GROQ_API_KEY)"))
    print("  imported page: %s" % ("ok" if os.path.isfile(PAGE) else "none yet — paste a link in the app"))
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    srv.daemon_threads = True
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
