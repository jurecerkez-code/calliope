# /// script
# requires-python = ">=3.11"
# dependencies = ["websockets>=12"]
# ///
"""Calliope server: Reson8 turns relay + Anthropic reasoning/execution loop.

Run:  uv run server.py          (keys read from .env next to this file)
Open: http://127.0.0.1:8800
"""
import asyncio
import json
import os
import re
import threading
import urllib.request
import math
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import websockets
from import_site import import_page

HERE = Path(__file__).parent
DIST = HERE / 'dist'
ASSETS = DIST / 'assets'
ASSET_NAME = re.compile(r'[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(?:js|css)\Z')

# load .env (so keys never sit in shell history)
_env_file = HERE / ".env"
if _env_file.exists():
    for _line in _env_file.read_text().splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            k, v = _line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

RESON8_KEY = os.environ.get("RESON8_API_KEY", "")
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
MODEL = os.environ.get("MODEL", "claude-sonnet-4-5")  # confirm exact id in the console
RESON8_TURNS = (
    "wss://api.reson8.dev/v1/speech-to-text/turns"
    "?encoding=pcm_s16le&sample_rate=16000&channels=1&language=en"
    "&include_timestamps=true&eager_turn_probability=0.5&final_turn_probability=0.92"
)
HTTP_PORT = int(os.environ.get('HTTP_PORT', '8800'))
AUDIO_PORT = int(os.environ.get('AUDIO_PORT', '8801'))
STROKES = {}
STROKES_LOCK = threading.Lock()
IMPORT_SLOTS = threading.BoundedSemaphore(4)

def valid_stroke(s):
    if not isinstance(s, dict) or not isinstance(s.get('id'), str) or not re.fullmatch(r'[\w-]{1,80}', s['id']):
        return False
    if s.get('tool') not in ('pen', 'highlighter') or not isinstance(s.get('pts'), list) or not 1 <= len(s['pts']) <= 3000:
        return False
    if 'shape' in s and s['shape'] not in ('circle', 'square', 'triangle', 'freehand', 'highlight'):
        return False
    if 'enclosed_element' in s and (not isinstance(s['enclosed_element'], str) or len(s['enclosed_element']) > 200 or any(ord(c) < 32 for c in s['enclosed_element'])):
        return False
    viewport = s.get('viewport')
    if not isinstance(viewport, dict) or any(not isinstance(viewport.get(k), (int, float)) or not math.isfinite(viewport[k]) or viewport[k] <= 0 for k in ('width', 'height')):
        return False
    if s.get('coordinate_space') != 'preview-document-css-pixels' or s.get('viewBox') != f"0 0 {viewport['width']} {viewport['height']}":
        return False
    style = s.get('style')
    if style != ({'color': '#00e05a', 'width': 3} if s['tool'] == 'pen' else {'color': '#ffd166', 'width': 18, 'opacity': 0.45}):
        return False
    for p in s['pts']:
        if not isinstance(p, dict) or not all(isinstance(p.get(k), (int, float)) and math.isfinite(p[k]) for k in ('x', 'y')):
            return False
        if not isinstance(p.get('utc'), str) or len(p['utc']) > 40 or not isinstance(p.get('selector'), str) or len(p['selector']) > 200:
            return False
        if not isinstance(p.get('text'), str) or len(p['text']) > 200:
            return False
        r = p.get('rect')
        if r is not None and (not isinstance(r, dict) or any(not isinstance(r.get(k), (int, float)) or not math.isfinite(r[k]) for k in ('x', 'y', 'width', 'height'))):
            return False
    pts = s['pts']
    path = 'M ' + ' L '.join(f"{p['x']} {p['y']}" for p in pts)
    if s.get('path') != path:
        return False
    bbox = {'x': min(p['x'] for p in pts), 'y': min(p['y'] for p in pts),
            'width': max(p['x'] for p in pts) - min(p['x'] for p in pts),
            'height': max(p['y'] for p in pts) - min(p['y'] for p in pts)}
    return s.get('bbox') == bbox


# ---------- Anthropic: REASON about the turn, then EXECUTE the website change ----------
def claude_apply(bundles: list, current_html: str) -> dict:
    """bundles: [{t_start, t_end, transcript, strokes:[{t,t_end,pts,elements}]}]
    Returns {"reasoning": str, "html": str}."""
    timeline_desc = []
    for b in bundles:
        timeline_desc.append(f"[{b.get('t_start', 0)}-{b.get('t_end', 0)}ms] SAID: {b.get('transcript', '')}")
        for s in b.get("strokes", []):
            pts = s.get("pts", [])
            bounds = "unknown"
            if pts:
                xs = [p["x"] for p in pts]
                ys = [p["y"] for p in pts]
                bounds = f"x {min(xs)}–{max(xs)}, y {min(ys)}–{max(ys)}"
            shape = s.get('shape', 'unknown')
            name = {'freehand': 'Freehand mark', 'highlight': 'Highlight',
                    'circle': 'Circle', 'square': 'Square', 'triangle': 'Triangle'}.get(shape, 'Sketch')
            utc = pts[0].get('utc', 'unknown time') if pts else 'unknown time'
            center = s.get('enclosed_element', '')
            touched = ', '.join(s.get('elements', [])) or 'background'
            target = f"around {center}" if shape in ('circle', 'square', 'triangle') and center else f"over {touched}"

            description = (f"[{s.get('t', 0)}-{s.get('t_end', 0)}ms] "
                           f"{name} drawn at {utc}, coordinates {bounds}, {target}. "
                           "Shape is an estimate, not the user's intent.")
            if shape in ('freehand', 'unknown'):
                description += (f" Geometry fallback: <svg viewBox=\"{s.get('viewBox', '')}\" "
                                f"data-coordinate-space=\"{s.get('coordinate_space', '')}\">"
                                f"<path d=\"{s.get('path', '')}\" fill=\"none\" /></svg>; "
                                f"point-level JSON: {json.dumps(s, separators=(',', ':'))}")
            timeline_desc.append(description)
    prompt = (
        "You are a web design agent in a live meeting. The user SPEAKS while DRAWING on top "
        "of a website. Each transcript chunk carries the sketches drawn in the SAME PERIOD. "
        "Each sketch is summarized as a tentative shape, UTC timestamp, page coordinates and DOM target. "
        "A shape is not a command. Infer the requested change from the spoken words too.\n\n"
        "REASON FIRST: one short paragraph. What does the user want changed, combining words "
        "and sketches? Note conflicts between words and marks explicitly.\n"
        "THEN EXECUTE: return the COMPLETE updated HTML (single file, inline CSS, no external "
        "requests, no markdown fences). Apply exactly this turn's requested changes, keep the rest.\n\n"
        'Answer as JSON: {"reasoning": "...", "html": "<!DOCTYPE html>..."}\n\n'
        "TURN TIMELINE (words + sketches, one clock):\n"
        + "\n".join(timeline_desc)
        + f"\n\nCURRENT HTML:\n{current_html}"
    )
    body = {
        "model": MODEL,
        "max_tokens": 8192,
        "messages": [{"role": "user", "content": [{"type": "text", "text": prompt}]}],
    }
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(body).encode(),
        headers={
            "x-api-key": ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    resp = json.load(urllib.request.urlopen(req, timeout=120))
    text = "".join(b.get("text", "") for b in resp.get("content", [])).strip()
    # tolerant JSON parse: strip code fences if the model wrapped the answer
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return {"reasoning": text[:400], "html": current_html}
    try:
        out = json.loads(m.group(0))
        html = out.get("html", "").strip()
        if html.startswith("```"):
            html = re.sub(r"^```[a-z]*\n?|```$", "", html.strip())
        return {"reasoning": out.get("reasoning", ""), "html": html or current_html}
    except json.JSONDecodeError:
        return {"reasoning": text[:400], "html": current_html}


# ---------- HTTP ----------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code: int, payload: dict):
        data = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.send_header('cache-control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/api/config':
            self._send(200, {'audioPort': AUDIO_PORT})
        elif self.path.startswith('/assets/') and ASSET_NAME.fullmatch(self.path[len('/assets/'):]):
            file = ASSETS / self.path[len('/assets/'):]
            if not file.is_file() or file.is_symlink() or file.stat().st_size > 2_000_000 or file.resolve().parent != ASSETS.resolve():
                return self._send(404, {'error': 'not found'})
            data = file.read_bytes()
            self.send_response(200)
            self.send_header('content-type', 'text/javascript; charset=utf-8' if file.suffix == '.js' else 'text/css; charset=utf-8')
            self.send_header('cache-control', 'no-store')
            self.send_header('x-content-type-options', 'nosniff')
            self.send_header('content-length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        elif self.path == "/jamie-mock.html":
            data = (HERE / "jamie-mock.html").read_bytes()
            self.send_response(200)
            self.send_header("content-type", "text/html")
            self.send_header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'none'; form-action 'none'")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        elif self.path in ("/", "/index.html"):
            data = (DIST / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("content-type", "text/html")
            self.send_header("content-security-policy", "default-src 'none'; script-src 'self' 'sha256-y0joblgLTLFGhbj/xXhGS1SyGmxly/oZpyENyx9LBXI='; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src https:; connect-src 'self' ws: wss:; frame-src 'self' about:; object-src 'none'; base-uri https:; form-action 'none'")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        elif self.path == '/loader3d.js' or self.path.startswith('/vendor/') or self.path.startswith('/assets/'):
            relative = self.path.lstrip('/')
            if self.path.startswith('/assets/') and not re.fullmatch(r'assets/[\w.-]+\.(?:svg|png)', relative):
                return self._send(404, {'error': 'not found'})
            if self.path.startswith('/vendor/') and not re.fullmatch(r'vendor/[\w.-]+\.js', relative):
                return self._send(404, {'error': 'not found'})
            file = HERE / relative
            if not file.is_file() or file.is_symlink():
                return self._send(404, {'error': 'not found'})
            data = file.read_bytes()
            self.send_response(200)
            self.send_header('content-type', 'image/png' if file.suffix == '.png' else 'image/svg+xml' if file.suffix == '.svg' else 'text/javascript')
            self.send_header('content-length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        try:
            n = int(self.headers.get('content-length', 0))
        except ValueError:
            return self._send(400, {'error': 'invalid length'})
        if not 0 < n <= 512_000:
            return self._send(413, {'error': 'payload too large'})
        try:
            payload = json.loads(self.rfile.read(n))
        except Exception as e:
            self._send(400, {"error": f"bad json: {e}"})
            return
        if self.path == '/api/import':
            if not IMPORT_SLOTS.acquire(blocking=False):
                return self._send(429, {'error': 'too many imports in progress'})
            try:
                if not isinstance(payload, dict):
                    raise ValueError('invalid import request')
                self._send(200, import_page(payload.get('url')))
            except ValueError as e:
                self._send(400, {'error': str(e)})
            except Exception:
                self._send(502, {'error': 'could not fetch website'})
            finally:
                IMPORT_SLOTS.release()
        elif self.path == '/api/strokes':
            if not valid_stroke(payload):
                return self._send(400, {'error': 'invalid stroke'})
            with STROKES_LOCK:
                if len(STROKES) >= 500 and payload['id'] not in STROKES:
                    return self._send(507, {'error': 'stroke store full'})
                if payload['id'] in STROKES and STROKES[payload['id']] != payload:
                    return self._send(409, {'error': 'id conflict'})
                STROKES[payload['id']] = payload
            self._send(201, {'id': payload['id'], 'status': 'accepted'})
        elif self.path == '/api/strokes/readback':
            with STROKES_LOCK:
                stroke = STROKES.get(payload.get('id'))
            self._send(200, {'stroke': stroke}) if stroke else self._send(404, {'error': 'not found'})
        elif self.path == "/api/apply":
            try:
                if not ANTHROPIC_KEY:
                    return self._send(503, {'error': 'Agent APPLY unavailable: no API key configured'})
                strokes = [s for b in payload.get('bundles', []) for s in b.get('strokes', [])]
                with STROKES_LOCK:
                    if any(STROKES.get(s.get('id')) != s for s in strokes):
                        return self._send(409, {'error': 'stroke not accepted by backend; retry delivery'})
                out = claude_apply(payload.get("bundles", []), payload.get("current_html", ""))
                self._send(200, out)
            except Exception as e:  # surface the error to the UI, never crash the demo
                self._send(500, {"error": str(e)})
        elif self.path == "/api/publish":
            # explicit and staged: nothing goes live from the meeting
            stage = HERE / "staging"
            stage.mkdir(exist_ok=True)
            p = stage / "index.html"
            p.write_text(payload.get("html", ""))
            self._send(200, {"path": str(p), "command": "vercel deploy staging --prod"})
        else:
            self._send(404, {"error": "not found"})


def run_http():
    ThreadingHTTPServer(("127.0.0.1", HTTP_PORT), Handler).serve_forever()


# ---------- audio relay: browser <-> Reson8 turns ----------
async def audio_ws(websocket):
    if not RESON8_KEY:
        await websocket.send(json.dumps({"error": "RESON8_API_KEY not set"}))
        return
    try:
        await _relay(websocket)
    except Exception as e:
        # always tell the UI why the stream died
        try:
            await websocket.send(json.dumps({"error": f"reson8 relay: {e}"}))
        except Exception:
            pass


async def _relay(websocket):
    async with websockets.connect(
        RESON8_TURNS,
        additional_headers={"Authorization": f"ApiKey {RESON8_KEY}"},
        max_size=None,
    ) as r8:
        async def up():
            async for msg in websocket:
                await r8.send(msg)

        async def down():
            async for msg in r8:
                await websocket.send(msg)

        done, pending = await asyncio.wait(
            [asyncio.create_task(up()), asyncio.create_task(down())],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for p in pending:
            p.cancel()


async def main():
    threading.Thread(target=run_http, daemon=True).start()
    print(f"UI on http://127.0.0.1:{HTTP_PORT}  audio ws on :{AUDIO_PORT}")
    print(f"Reson8 key: {'set' if RESON8_KEY else 'MISSING'}  Anthropic key: {'set' if ANTHROPIC_KEY else 'MISSING'}")
    async with websockets.serve(audio_ws, "127.0.0.1", AUDIO_PORT, max_size=None):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
