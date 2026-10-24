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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import websockets

HERE = Path(__file__).parent

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
HTTP_PORT = 8800
AUDIO_PORT = 8801


# ---------- Anthropic: REASON about the turn, then EXECUTE the website change ----------
def claude_apply(bundles: list, current_html: str) -> dict:
    """bundles: [{t_start, t_end, transcript, strokes:[{t,t_end,pts,elements}]}]
    Returns {"reasoning": str, "html": str}."""
    timeline_desc = []
    for b in bundles:
        timeline_desc.append(f"[{b.get('t_start', 0)}-{b.get('t_end', 0)}ms] SAID: {b.get('transcript', '')}")
        for s in b.get("strokes", []):
            els = ", ".join(s.get("elements", [])) or "background"
            pts = s.get("pts", [])
            box = ""
            if pts:
                xs = [p["x"] for p in pts]
                ys = [p["y"] for p in pts]
                box = f" box=({min(xs)},{min(ys)})-({max(xs)},{max(ys)})"
            timeline_desc.append(
                f"[{s.get('t', 0)}-{s.get('t_end', 0)}ms] SKETCH on: {els}{box}, {len(pts)} points"
            )
    prompt = (
        "You are a web design agent in a live meeting. The user SPEAKS while DRAWING on top "
        "of a website. Each transcript chunk carries the sketches drawn in the SAME PERIOD. "
        "Elements listed under a sketch are the HTML elements the marks were drawn on top of.\n\n"
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
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/jamie-mock.html":
            data = (HERE / "jamie-mock.html").read_bytes()
            self.send_response(200)
            self.send_header("content-type", "text/html")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        elif self.path in ("/", "/index.html"):
            data = (HERE / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("content-type", "text/html")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        try:
            payload = json.loads(self.rfile.read(n))
        except Exception as e:
            self._send(400, {"error": f"bad json: {e}"})
            return
        if self.path == "/api/apply":
            try:
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
