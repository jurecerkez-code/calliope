# /// script
# requires-python = ">=3.11"
# dependencies = ["websockets>=12"]
# ///
"""Calliope server: Reson8 turns relay + Lyceum reasoning/execution loop.

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
from urllib.parse import urlsplit

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
LYCEUM_KEY = os.environ.get("LYCEUM_API_KEY", "")
MODEL = os.environ.get("MODEL", "deepseek/deepseek-v4-flash-0731")
RESON8_TURNS = (
    "wss://api.reson8.dev/v1/speech-to-text/turns"
    "?encoding=pcm_s16le&sample_rate=16000&channels=1&language=en"
    "&include_timestamps=true&include_words=true&eager_turn_probability=0.5&final_turn_probability=0.92"
)
HTTP_PORT = int(os.environ.get('HTTP_PORT', '8800'))
AUDIO_PORT = int(os.environ.get('AUDIO_PORT', '8801'))
# Set this to the exact HTTPS origin only when the loopback server sits behind a trusted proxy.
STUDIO_ORIGIN = os.environ.get('STUDIO_ORIGIN', '')
STROKES = {}
STROKES_LOCK = threading.Lock()
IMPORT_SLOTS = threading.BoundedSemaphore(4)
MARKS = {}

def valid_stroke(s):
    if not isinstance(s, dict) or not isinstance(s.get('id'), str) or not re.fullmatch(r'[\w-]{1,80}', s['id']):
        return False
    if s.get('tool') != 'pen' or not isinstance(s.get('pts'), list) or not 1 <= len(s['pts']) <= 3000:
        return False
    if 'shape' in s and s['shape'] not in ('circle', 'square', 'triangle', 'freehand'):
        return False
    if 'enclosed_element' in s and (not isinstance(s['enclosed_element'], str) or len(s['enclosed_element']) > 200 or any(ord(c) < 32 for c in s['enclosed_element'])):
        return False
    elements = s.get('elements')
    if (not isinstance(elements, list) or len(elements) > 100 or
            any(not isinstance(element, str) or len(element) > 200 or
                any(ord(c) < 32 for c in element) for element in elements)):
        return False
    viewport = s.get('viewport')
    if not isinstance(viewport, dict) or any(not isinstance(viewport.get(k), (int, float)) or not math.isfinite(viewport[k]) or viewport[k] <= 0 for k in ('width', 'height')):
        return False
    if s.get('coordinate_space') != 'preview-document-css-pixels' or s.get('viewBox') != f"0 0 {viewport['width']} {viewport['height']}":
        return False
    style = s.get('style')
    if style != {'color': '#00e05a', 'width': 3}:
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

def valid_mark(mark):
    if not isinstance(mark, dict) or not isinstance(mark.get('strokes'), list) or not 1 <= len(mark['strokes']) <= 2:
        return False
    strokes = mark['strokes']
    if not all(valid_stroke(s) for s in strokes) or len({s['id'] for s in strokes}) != len(strokes):
        return False
    if mark.get('id') != strokes[0]['id'] or mark.get('t') != strokes[0].get('t') or mark.get('t_end') != strokes[-1].get('t_end'):
        return False
    if len(strokes) == 1:
        return mark.get('shape') == strokes[0].get('shape') and mark.get('enclosed_element') == strokes[0].get('enclosed_element')
    return (mark.get('shape') == 'x' and mark.get('enclosed_element') == ''
            and all(s['tool'] == 'pen' for s in strokes)
            and strokes[0]['viewBox'] == strokes[1]['viewBox'])


# ---------- Lyceum: REASON about the turn, then EXECUTE the website change ----------
def _clip(v, n=200) -> str:
    return re.sub(r"[\x00-\x1f]", " ", str(v if v is not None else ""))[:n]


def is_website_loop(stroke) -> bool:
    """Match the closed-loop cases in src/lib/strokes.js classifyShape()."""
    points = stroke['pts']
    box = stroke['bbox']
    diagonal = math.hypot(box['width'], box['height'])
    length = sum(math.hypot(b['x'] - a['x'], b['y'] - a['y']) for a, b in zip(points, points[1:]))
    if diagonal < 12 or length < 15:
        return False
    gap = math.hypot(points[-1]['x'] - points[0]['x'], points[-1]['y'] - points[0]['y'])

    # Same iterative Ramer-Douglas-Peucker reduction at epsilon=4, then the
    # sharp-reversal guard that keeps scribbles from becoming loop marks.
    keep = {0, len(points) - 1}
    stack = [(0, len(points) - 1)]
    while stack:
        start, end = stack.pop()
        a, b = points[start], points[end]
        dx, dy = b['x'] - a['x'], b['y'] - a['y']
        distance = math.hypot(dx, dy)
        def perpendicular(p):
            if not distance:
                return math.hypot(p['x'] - a['x'], p['y'] - a['y'])
            return abs(dy * p['x'] - dx * p['y'] + b['x'] * a['y'] - b['y'] * a['x']) / distance
        largest, index = 0, -1
        for i in range(start + 1, end):
            d = perpendicular(points[i])
            if d > largest:
                largest, index = d, i
        if largest > 4 and index != -1:
            keep.add(index)
            stack.extend([(start, index), (index, end)])
    simple = [points[i] for i in sorted(keep)]
    reversals = 0
    for a, b, c in zip(simple, simple[1:], simple[2:]):
        u = (b['x'] - a['x'], b['y'] - a['y'])
        v = (c['x'] - b['x'], c['y'] - b['y'])
        magnitude = math.hypot(*u) * math.hypot(*v)
        if magnitude and (u[0] * v[0] + u[1] * v[1]) / magnitude < -0.5:
            reversals += 1
    if reversals >= 3 and gap / length < 0.5:
        return False
    if gap < max(25, diagonal * .25) and length > diagonal * 1.6:
        return True
    return gap / length <= 0.8 and length > diagonal * 2


def valid_relations(relations, marks) -> bool:
    """Only describe arrows backed by accepted marks in this APPLY turn."""
    if not isinstance(relations, list) or len(relations) > 50:
        return False
    if not relations:
        return True
    if any(not isinstance(mark, dict) or not isinstance(mark.get('strokes'), list) for mark in marks):
        return False
    try:
        if any(isinstance(mark.get('t'), bool) or not isinstance(mark.get('t'), (int, float))
               or not math.isfinite(mark['t']) for mark in marks):
            return False
    except OverflowError:
        return False
    ordered = sorted(marks, key=lambda mark: mark['t'])
    by_id = {mark['id']: (i, mark) for i, mark in enumerate(ordered)}
    if len(by_id) != len(ordered):
        return False

    def node_at(prior, point):
        candidates = []
        for mark in prior:
            if len(mark['strokes']) != 1 or mark['shape'] == 'x':
                continue
            stroke = mark['strokes'][0]
            if stroke['shape'] not in ('circle', 'square', 'triangle') and not is_website_loop(stroke):
                continue
            box = stroke['bbox']
            if box['x'] - 28 <= point['x'] <= box['x'] + box['width'] + 28 and box['y'] - 28 <= point['y'] <= box['y'] + box['height'] + 28:
                candidates.append(stroke)
        return min(candidates, key=lambda stroke: stroke['bbox']['width'] * stroke['bbox']['height'], default=None)

    seen = set()
    for relation in relations:
        if not isinstance(relation, dict) or relation.get('kind') not in ('move', 'link', 'point'):
            return False
        arrow_id = relation.get('arrow')
        if not isinstance(arrow_id, str) or arrow_id in seen or arrow_id not in by_id:
            return False
        seen.add(arrow_id)
        arrow_index, item = by_id[arrow_id]
        if len(item['strokes']) != 1:
            return False
        arrow = item['strokes'][0]
        box = arrow['bbox']
        if (arrow['tool'] != 'pen' or arrow['shape'] in ('circle', 'square', 'triangle') or
                is_website_loop(arrow) or math.hypot(box['width'], box['height']) <= 40):
            return False
        start = arrow['pts'][0]
        tip = max(arrow['pts'], key=lambda p: (p['x'] - start['x']) ** 2 + (p['y'] - start['y']) ** 2)
        source = node_at(ordered[:arrow_index], start)
        target = node_at(ordered[:arrow_index], tip)
        if (source is None and target is None) or source is target and source is not None:
            return False
        kind = 'link' if source and target else 'move' if source else 'point'
        if kind != relation['kind']:
            return False
        def endpoint(stroke):
            if not stroke:
                return None
            name = (stroke['enclosed_element'] if stroke['shape'] in ('circle', 'square', 'triangle') else '') or (stroke['elements'] or [''])[0]
            return {'stroke': stroke['id'], 'target': name}
        if target:
            destination = {**(endpoint(target) or {}), 'x': tip['x'], 'y': tip['y']}
        else:
            destination = {'stroke': None, 'target': tip.get('selector', ''),
                           'text': ' '.join((tip.get('text') or '').split())[:80], 'x': tip['x'], 'y': tip['y']}
        if relation.get('from') != endpoint(source) or relation.get('to') != destination:
            return False
    return True


def relation_lines(relations) -> list:
    lines = []
    for relation in relations:
        source = relation.get('from') or {}
        destination = relation['to']
        at = f"({round(destination['x'])}, {round(destination['y'])})"
        if relation['kind'] == 'move':
            lines.append(f"ARROW from the mark on {_clip(source.get('target')) or 'an area'} to page point {at}"
                         f" over {_clip(destination.get('target')) or 'the page'}: the user most likely wants that element moved there.")
        elif relation['kind'] == 'link':
            lines.append(f"ARROW from the mark on {_clip(source.get('target')) or 'an area'} to the mark on {_clip(destination.get('target')) or 'another area'}: the user relates these two.")
        else:
            lines.append(f"ARROW pointing at the mark on {_clip(destination.get('target')) or 'an area'} at {at}.")
    return lines


def agent_sketch_message(item: dict) -> str:
    """The exact sketch line used in the agent prompt and returned in its receipt."""
    paths: list[dict] = item['strokes'] if isinstance(item.get('strokes'), list) else [item]
    points = [p for path in paths for p in path['pts']]
    bounds = f"x {min(p['x'] for p in points)}–{max(p['x'] for p in points)}, y {min(p['y'] for p in points)}–{max(p['y'] for p in points)}"
    first = paths[0]
    shape = item.get('shape', first.get('shape', 'unknown'))
    name = {'freehand': 'Freehand mark', 'circle': 'Circle',
            'square': 'Square', 'triangle': 'Triangle', 'x': 'X (tentative)'}.get(shape, 'Sketch')
    touched = ', '.join(dict.fromkeys(element for path in paths for element in path.get('elements', []))) or 'background'
    center = item.get('enclosed_element', first.get('enclosed_element', ''))
    target = f"around {center}" if shape in ('circle', 'square', 'triangle') and center else f"over {touched}"
    viewport = first['viewport']
    description = (f"[{item.get('t', 0)}-{item.get('t_end', 0)}ms] SKETCH {item['id']}: "
                   f"{name} drawn at {points[0]['utc']}, coordinates {bounds} "
                   f"in {first['coordinate_space']} (page {viewport['width']}×{viewport['height']}), "
                   f"{target}; touched {touched}. "
                   "Shape is an estimate, not the user's intent.")
    if len(paths) > 1:
        description += f" One mark made of {len(paths)} ordered original paths, not separate commands."
    return description

def build_agent_prompt(bundles: list, current_html: str, relations: list | None = None) -> str:
    """Build the complete text of the user message submitted to the agent."""
    timeline_desc = []
    for b in bundles:
        intent = f" (intent: {b['intent']})" if b.get("intent") else ""
        timeline_desc.append(f"[{b.get('t_start', 0)}-{b.get('t_end', 0)}ms] SAID: {b.get('transcript', '')}{intent}")
        for s in b.get("strokes", []):
            timeline_desc.append(agent_sketch_message(s))
        for r in b.get("references", []):
            word = f'"{r.get("word", "")}"' if r.get("word") else "(no pointing word)"
            timeline_desc.append(f"[{r.get('atMs', 0)}ms] REFERENCE {word} -> {r.get('strokeId') or 'no sketch'}")
    prompt = (
        "You are a web design agent in a live meeting. The user SPEAKS while DRAWING on top "
        "of a website. Each transcript chunk carries the sketches drawn in the SAME PERIOD. "
        "Each sketch is summarized as a tentative shape, UTC timestamp, page coordinates and DOM target. "
        "REFERENCE lines bind spoken pointing words (this/that/here) to the sketch they refer to; "
        "trust a REFERENCE over your own guess of which mark matters. "
        "A shape is not a command. Infer the requested change from the spoken words too.\n\n"
        "REASON FIRST: one short paragraph. What does the user want changed, combining words "
        "and sketches? Note conflicts between words and marks explicitly.\n"
        "THEN EXECUTE: return the COMPLETE updated HTML (single file, inline CSS, no external "
        "requests, no markdown fences). Apply exactly this turn's requested changes, keep the rest.\n\n"
        'Answer as JSON: {"reasoning": "...", "html": "<!DOCTYPE html>..."}\n\n'
        "TURN TIMELINE (words + sketches, one clock):\n"
        + "\n".join(timeline_desc)
        + ("\n\nARROWS BETWEEN MARKS (start and tip name the intended move or link):\n" + "\n".join(lines)
           if (lines := relation_lines(relations or [])) else "")
        + f"\n\nCURRENT HTML:\n{current_html}"
    )
    return prompt

class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never forward the provider bearer token to a redirected host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def lyceum_apply(bundles: list, current_html: str, prompt: str | None = None) -> dict:
    """Send the exact built message; return reasoning and updated HTML."""
    if prompt is None:
        prompt = build_agent_prompt(bundles, current_html)
    body = {
        "model": MODEL,
        "max_tokens": 8192,
        "reasoning_effort": "none",
        "messages": [{"role": "user", "content": prompt}],
    }
    req = urllib.request.Request(
        "https://api.lyceum.technology/openai/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {LYCEUM_KEY}",
            "content-type": "application/json",
        },
    )
    with urllib.request.build_opener(NoRedirect).open(req, timeout=120) as response:
        resp = json.load(response)
    choice = resp['choices'][0]
    if choice.get('finish_reason') != 'stop':
        raise ValueError('Lyceum returned no complete HTML answer')
    text = (choice['message'].get('content') or '').strip()
    # tolerant JSON parse: strip code fences if the model wrapped the answer
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        raise ValueError('Lyceum returned no complete HTML answer')
    try:
        out = json.loads(m.group(0))
        html = out.get("html", "")
        if not isinstance(html, str):
            raise ValueError('Lyceum returned no complete HTML answer')
        html = html.strip()
        if html.startswith("```"):
            html = re.sub(r"^```[a-z]*\n?|```$", "", html.strip())
        if not (re.search(r'<html(?:\s|>)', html, re.IGNORECASE) and
                re.search(r'</html\s*>\s*\Z', html, re.IGNORECASE)):
            raise ValueError('Lyceum returned no complete HTML answer')
        return {"reasoning": out.get("reasoning", ""), "html": html}
    except json.JSONDecodeError as e:
        raise ValueError('Lyceum returned no complete HTML answer') from e


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
            self._send(200, {'audioPort': AUDIO_PORT,
                             'publishEnabled': os.environ.get('CALLIOPE_REVIEW_MODE') != '1'})
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
        host = self.headers.get('Host', '')
        try:
            parsed_host = urlsplit('http://' + host)
            loopback = parsed_host.hostname in ('127.0.0.1', 'localhost', '::1') and parsed_host.port is not None
            local_origin = 'http://' + host if loopback else None
        except ValueError:
            local_origin = None
        allowed_origin = STUDIO_ORIGIN if STUDIO_ORIGIN and host == urlsplit(STUDIO_ORIGIN).netloc else local_origin
        if not allowed_origin or (self.headers.get('Origin') and self.headers['Origin'] != allowed_origin):
            return self._send(403, {'error': 'origin not allowed'})
        if self.headers.get('content-type', '').split(';', 1)[0].strip().lower() != 'application/json':
            return self._send(415, {'error': 'application/json required'})
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
        elif self.path == '/api/marks':
            if not valid_mark(payload):
                return self._send(400, {'error': 'invalid mark'})
            with STROKES_LOCK:
                if len(MARKS) >= 500 and payload['id'] not in MARKS:
                    return self._send(507, {'error': 'mark store full'})
                if payload['id'] in MARKS and MARKS[payload['id']] != payload:
                    return self._send(409, {'error': 'id conflict'})
                MARKS[payload['id']] = payload
            self._send(201, {'id': payload['id'], 'status': 'accepted',
                             'agent_message': agent_sketch_message(payload)})
        elif self.path == '/api/marks/readback':
            with STROKES_LOCK:
                mark = MARKS.get(payload.get('id'))
            self._send(200, {'mark': mark}) if mark else self._send(404, {'error': 'not found'})
        elif self.path == "/api/apply":
            prompt = None
            try:
                strokes = [s for b in payload.get('bundles', []) for s in b.get('strokes', [])]
                with STROKES_LOCK:
                    if any((MARKS if isinstance(s.get('strokes'), list) else STROKES).get(s.get('id')) != s for s in strokes):
                        return self._send(409, {'error': 'mark not accepted by backend; retry delivery'})
                if not valid_relations(payload.get('relations', []), strokes):
                    return self._send(400, {'error': 'invalid arrow relation for accepted marks'})
                bundles, html = payload.get('bundles', []), payload.get('current_html', '')
                prompt = build_agent_prompt(bundles, html, payload.get('relations', []))
                if not LYCEUM_KEY:
                    return self._send(503, {'error': 'Agent APPLY unavailable: no API key configured',
                                            'agent_message': prompt})
                out = lyceum_apply(bundles, html, prompt=prompt)
                out['agent_message'] = prompt
                self._send(200, out)
            except Exception as e:  # surface the error to the UI, never crash the demo
                self._send(500, {"error": str(e), 'agent_message': prompt})
        elif self.path == "/api/publish":
            if os.environ.get('CALLIOPE_REVIEW_MODE') == '1':
                return self._send(404, {'error': 'not available in review'})
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
    print(f"Reson8 key: {'set' if RESON8_KEY else 'MISSING'}  Lyceum key: {'set' if LYCEUM_KEY else 'MISSING'}")
    async with websockets.serve(audio_ws, "127.0.0.1", AUDIO_PORT, max_size=None):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
