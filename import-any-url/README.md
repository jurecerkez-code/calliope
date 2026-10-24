# Calliope

Paste a link. Then talk to the page.

Calliope opens on a door: one field for a URL. Paste any server-rendered site and
its **raw HTML** is fetched, sanitized and rendered on the right. The left rail is a
live transcript. Draw on the page, say what you want, and it rewrites itself in
about a second.

```bash
python3 -m pip install --user "websockets>=12"   # only for the Reson8 relay
cp .env.example .env   # GROQ_API_KEY, RESON8_API_KEY (OPENROUTER_API_KEY optional)
python3 server.py      # http://127.0.0.1:8899  (audio relay on :8900)
# or: ./run.sh         # starts the server and opens Chrome
```

No `npm`, no build step, no port clash with the studio (8899/8900 vs 8800/8801) —
both can run at once. Without `websockets` the page still works; the mic is
disabled and says why.

Open **http://127.0.0.1:8899** in Chrome (speech recognition needs Chrome), paste a
link, press **MIC**, talk, draw.

## Keys

| Key | Does |
|---|---|
| `M` | mic on/off |
| `D` | draw mode on/off |
| `A` | auto mode on/off |
| `⌘⏎` | apply now |
| `Esc` | leave the import screen (only if a page is already loaded) |

## How it works

**1. Import, don't proxy.** `POST /api/import` fetches the page, strips every
`<script>` (they would re-hydrate React and wipe our DOM edits), and injects
`<base href="https://origin/">` so the site's own stylesheet, fonts and images still
load from its CDN. Served from `site/page.html`.

**2. Two panes, one document.** The right pane is an iframe of that HTML. Because it
is same-origin, the app stamps every element with a `data-cid` and reaches into it
directly — no messaging layer, no rebuild.

**3. Drawing resolves to an element.** A stroke is sampled, classified
(circle / underline / line / dot / freeform), then `elementFromPoint` picks the
element under it. That element gets a dashed anchor box that scrolls with the page,
and the app sends the model the element's cid, its text and its outerHTML.

**4. Small ops, not a page rewrite.** The model never returns the whole document. It
returns 1–4 operations:

```json
{"reasoning":"make the CTA hot pink and bolder","ops":[
  {"op":"style","cid":"e39","props":{"background-color":"#ff0066","font-weight":"800"}},
  {"op":"text","cid":"e48","text":"AI meeting notes, not just meeting intelligence"}]}
```

Ops are `style` | `text` | `html` | `attr` | `cls`, applied straight to the live DOM.
That is why it lands in ~1s instead of ~30s.

**5. Context stays small.** The outline sent to the model is the visible viewport
(capped at 95 elements) plus the page's headings elsewhere — not the whole DOM.

## What imports and what doesn't

Server-rendered marketing pages come through whole — meetjamie.ai is 112 KB, 4,389
words, in ~150 ms. Client-rendered apps (`excalidraw.com`) arrive as an empty shell;
Calliope measures the rendered text after load and says so in a banner rather than
letting you talk to a blank page. There is no server-side guess to get wrong:
`example.com` is tiny but real, and imports fine.

Refused outright: non-`http(s)` schemes, unqualified hosts, private/loopback
addresses (SSRF), non-HTML content types, and pages over 6 MB.

The key is read from the environment first, then `import-any-url/.env`, the repo
root `.env`, or `~/.hermes/.env` — same convention as the studio server.

## Why this model

The chain is **Groq first, Grok second**, and it is built from measurements, not
brand preference. A single edit needs ~40 tokens of JSON, so the budget is
time-to-first-token.

Grok, measured on this exact workload through OpenRouter (streamed TTFT / total):

| Grok model | TTFT | Total |
|---|---|---|
| **x-ai/grok-4.20** | **0.77s** | **1.04s** |
| x-ai/grok-4.7 | 1.57s | 4.08s |
| x-ai/grok-4.6 | 1.30s | 8.51s |
| x-ai/grok-4.3 | 1.45s | 8.67s |
| x-ai/grok-4.5 | 15.70s | 75.84s |

Groq is the primary because its inference is the fastest hosted path for short
outputs, and the request shape is identical (both OpenAI-compatible). Default
`llama-3.3-70b-versatile`, overridable with `CALLIOPE_GROQ_MODEL`.

**Not yet benchmarked:** no Groq key was available while this was built, so the
Groq numbers are unmeasured. Run `python3 bench.py` with a key set to fill the
table in — it times TTFT and total for every configured model and prints the
winner. Until then, `history` shows which model actually answered each edit
(`0.41s · groq llama-3.3-70b-versatile`), so nobody has to guess.

If Groq errors, rate-limits, or returns unusable JSON, the request falls through
to Grok (`x-ai/grok-4.20`, then `x-ai/grok-4.7`) instead of failing the edit.

## Speech — Reson8, same as the studio

The mic is **not** the browser recognizer. The page captures 16 kHz mono PCM16
(`AudioContext` + `ScriptProcessor`), streams it over a websocket to
`ws://127.0.0.1:8900`, and that relay opens the Reson8 **turns** endpoint with the
key on the server side — identical shape to the studio's relay, same query
(`eager_turn_probability=0.5`, `final_turn_probability=0.92`,
`include_timestamps=true`). The browser never sees the key.

Events map straight onto the transcript:

| Reson8 event | In the UI |
|---|---|
| `turn_start` | clears the line, waveform rises |
| `turn_end_candidate` | dim italic — the live guess |
| `turn_end` | solid line — committed sentence, auto-apply fires ~1.1s later |

Verified against the live endpoint: `turn_end` arrives **without** a `text` field, so
the sentence to commit is the *last* `turn_end_candidate`. Reading `msg.text` off
`turn_end` (as the studio's `audio.js` does) silently commits nothing. This client
keeps the last candidate and commits it on `turn_end`, and still prefers `text` if
the API ever starts sending it.

Missing key or dead relay surfaces in the feed, not as a silent dead mic.

## Safety rails

- `PUBLISH` writes `out/published-<ts>.html` and serves it at `/published`. Nothing
  goes live on its own; a human decides.
- Model ops are validated server-side: cids must exist in the outline, style values
  are length- and scheme-checked, `<script>` and `on*` handlers are stripped from
  any `html` op.
- `RESET` reloads the imported original.

## Files

| File | What |
|---|---|
| `server.py` | static host, `/api/import`, `/api/edit` (model chain), `/api/publish`, Reson8 audio relay |
| `import_site.py` | fetch + sanitize a URL (also usable standalone) |
| `static/index.html` | entry door + two-pane workspace |
| `static/app.js` | importing, drawing, outline, transcript, ops application |
| `static/app.css` | workspace + engraved entry styling |
| `static/plate-muse.png` | the Calliope plate |
| `site/page.html` | the imported page (generated) |
| `site/meta.json` | what was imported, when (generated) |

## Demo script (2 min)

0. Paste `meetjamie.ai`, hit Import — 150 ms, the real page appears.
1. `D`, circle the headline, say *"make this much bigger and say AI meeting notes"*.
2. *(auto mode has already applied it — 1s)*
3. Circle the hero video, *"swap this for a warmer colour"*.
4. `↺ NEW LINK`, paste someone else's site, do it again.
5. `PUBLISH`, open `/published`: the whole page, edited, as one file.
