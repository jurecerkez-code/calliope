#!/usr/bin/env python3
"""Benchmark every configured model on the real edit workload.

Streams the request and times the first content token (what you feel) as well as
the total, then checks the reply parses as ops. Run it whenever you change a
model id or a provider — ids rot and latency regressions are invisible.

    python3 bench.py            # every provider in the chain
    python3 bench.py 2          # two reps each, report the best
"""
import json
import sys
import time
import urllib.request

import server as S

SAMPLE = {
    "instruction": "make this much bigger and bolder, and say AI meeting notes",
    "marks": [{
        "cid": "e48",
        "tag": "h1",
        "text": "The meeting intelligence platform you can trust.",
        "shape": "circle",
        "html": '<h1 class="text-marketing-heading-3">The meeting intelligence platform you can trust.</h1>',
    }],
    "outline": "\n".join([
        "viewport 884x529",
        "",
        "IN VIEW:",
        '[e42] a.text-marketing :: "Download"',
        '[e48] h1.text-marketing-heading-3 :: "The meeting intelligence platform you can trust."',
        '[e52] p.text-marketing-body-medium :: "Turn every meeting into knowledge you can act on."',
        '[e88] h2 :: "Trusted by leading firms across private equity, banking, M&A"',
    ]),
}


def stream(prov, url, model, key):
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": S.SYSTEM},
                     {"role": "user", "content": S.build_user_prompt(SAMPLE)}],
        "temperature": 0.15,
        "max_tokens": 700,
        "stream": True,
    }).encode()
    headers = {"Authorization": "Bearer " + key, "Content-Type": "application/json"}
    if prov == "openrouter":
        headers["X-Title"] = "Calliope bench"

    t0 = time.time()
    ttft = None
    out = []
    with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=headers),
                                timeout=90) as r:
        for raw in r:
            line = raw.decode().strip()
            if not line.startswith("data:"):
                continue
            chunk = line[5:].strip()
            if chunk == "[DONE]":
                break
            try:
                packet = json.loads(chunk)
            except ValueError:
                continue
            if "error" in packet:
                raise RuntimeError(str(packet["error"])[:120])
            piece = (packet.get("choices") or [{}])[0].get("delta", {}).get("content")
            if piece:
                if ttft is None:
                    ttft = time.time() - t0
                out.append(piece)
    return ttft, time.time() - t0, "".join(out)


def main():
    reps = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    chain = S.providers()
    if not chain:
        print("no keys configured — set GROQ_API_KEY and/or OPENROUTER_API_KEY")
        return 1

    print("workload: viewport outline + one circled heading -> JSON ops\n")
    rows = []
    for prov, url, model, key in chain:
        best = None
        for _ in range(reps):
            try:
                ttft, total, text = stream(prov, url, model, key)
                ok = S.extract_json(text) is not None
                if best is None or total < best[2]:
                    best = (ttft, total, total, ok)
            except Exception as e:
                best = (None, None, None, "%s: %s" % (type(e).__name__, str(e)[:60]))
                break
        rows.append((prov, model, best))

    print("%-11s %-30s %7s %7s  %s" % ("provider", "model", "ttft", "total", "json"))
    print("-" * 70)
    for prov, model, best in rows:
        ttft, _t, total, ok = best
        if ttft is None:
            print("%-11s %-30s %7s %7s  %s" % (prov, model, "-", "-", ok))
        else:
            print("%-11s %-30s %6.2fs %6.2fs  %s"
                  % (prov, model, ttft, total, "ok" if ok else "UNPARSEABLE"))

    usable = [r for r in rows if r[2][0] is not None and r[2][3] is True]
    if usable:
        prov, model, best = min(usable, key=lambda r: r[2][1])
        print("\nfastest: %s / %s at %.2fs" % (prov, model, best[1]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
