# /// script
# requires-python = ">=3.11"
# dependencies = ["websockets>=12", "edge-tts>=6"]
# ///
"""Proof of the voice-to-agent path, in one run.

1. Generates real speech (text to speech).
2. Streams it through the Reson8 turns endpoint, the same endpoint the app uses,
   and prints every event the ears send back.
3. Takes that real transcript together with a sketch bundle and sends it to the
   agent loop (/api/apply), printing the reasoning and the executed HTML.

Run: uv run e2e_voice_test.py   (needs .env with RESON8_API_KEY and ANTHROPIC_API_KEY,
                                and `uv run server.py` running)
"""
import asyncio
import json
import os
import subprocess
import urllib.request
from pathlib import Path

import edge_tts
import websockets

HERE = Path(__file__).parent
for line in (HERE / ".env").read_text().splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

RESON8_KEY = os.environ["RESON8_API_KEY"]
TURNS_URL = (
    "wss://api.reson8.dev/v1/speech-to-text/turns"
    "?encoding=auto&language=en&include_timestamps=true"
)
SAY = ("Make the download button bright green, and move the headline to the top right corner.")
CURRENT_HTML = (
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head>'
    '<body style="font-family:sans-serif;padding:48px">'
    "<h1>The meeting intelligence platform you can trust.</h1>"
    '<button class="btn" style="padding:12px 22px">Download</button>'
    "</body></html>"
)


async def voice_to_text() -> list:
    """speech.mp3 -> Reson8 turns -> transcript events"""
    mp3 = HERE / "speech.mp3"
    if not mp3.exists():
        await edge_tts.Communicate(SAY, "en-US-JennyNeural").save(str(mp3))
        print(f"[1] speech generated: {mp3.name} ({mp3.stat().st_size} bytes)")
    else:
        print(f"[1] speech ready: {mp3.name}")

    events = []
    async with websockets.connect(
        TURNS_URL,
        additional_headers={"Authorization": f"ApiKey {RESON8_KEY}"},
        max_size=None,
    ) as ws:
        async def send_audio():
            with open(mp3, "rb") as f:
                while chunk := f.read(8192):
                    await ws.send(chunk)
                    await asyncio.sleep(0.05)  # roughly real time pacing
            await ws.send(json.dumps({"type": "flush_request"}))

        sender = asyncio.create_task(send_audio())
        try:
            async with asyncio.timeout(30):
                async for message in ws:
                    ev = json.loads(message)
                    events.append(ev)
                    t = ev.get("type", "?")
                    txt = ev.get("text", "")
                    print(f"[2] reson8 {t}: {txt[:110]}")
                    if t == "turn_end":
                        break
        finally:
            sender.cancel()
    return events


def text_to_agent(transcript: str) -> dict:
    """transcript + sketch bundle -> /api/apply -> reasoning + executed HTML"""
    # one real payload, built by the app's own makePayload, so the backend accepts it
    fixture = subprocess.run(
        ["node", "stroke_fixture.mjs"], capture_output=True, text=True, cwd=HERE
    )
    stroke = json.loads(fixture.stdout.strip().splitlines()[-1])
    # register the stroke with the backend first, like the app does (receipts)
    reg = urllib.request.Request(
        "http://127.0.0.1:8800/api/strokes",
        data=json.dumps(stroke).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    receipt = json.load(urllib.request.urlopen(reg, timeout=30))
    print(f"[3b] stroke receipt: {receipt}")
    bundles = [{
        "t_start": 0,
        "t_end": 3000,
        "transcript": transcript,
        "strokes": [stroke],
    }]
    req = urllib.request.Request(
        "http://127.0.0.1:8800/api/apply",
        data=json.dumps({"bundles": bundles, "current_html": CURRENT_HTML}).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        return json.load(urllib.request.urlopen(req, timeout=180))
    except urllib.error.HTTPError as e:
        body = e.read().decode() or '{"error": "unknown"}'
        return json.loads(body)


async def main():
    print("=== voice -> agent, end to end ===")
    events = await voice_to_text()
    finals = [e.get("text", "") for e in events if e.get("type") == "turn_end" and e.get("text")]
    cands = [e.get("text", "") for e in events if e.get("type") == "turn_end_candidate" and e.get("text")]
    all_txt = finals or cands
    transcript = all_txt[-1] if all_txt else ""
    print(f"\n[3] transcript the ears produced: {transcript!r}")
    if not transcript:
        print("no turn_end text, cannot continue")
        return
    out = text_to_agent(transcript)
    if "error" in out:
        print(f"\n[4] AGENT ERROR: {out['error'][:300]}")
        return
    print(f"\n[4] agent reasoning: {out.get('reasoning', '')[:400]}")
    print(f"\n[5] executed html head: {out.get('html', '')[:220]!r}")


if __name__ == "__main__":
    asyncio.run(main())
