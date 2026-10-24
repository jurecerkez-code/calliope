# Calliope

Paste a link. Then talk to the page.

Calliope opens on a door: one field for a URL. Paste any server-rendered site and
its **raw HTML** is fetched, sanitized and rendered on the right. The left rail is a
live transcript. Draw on the page, say what you want, and it rewrites itself in
about a second.

```bash
cp .env.example .env   # add OPENROUTER_API_KEY (or use the repo root .env)
python3 server.py      # http://127.0.0.1:8899
# or: ./run.sh         # starts the server and opens Chrome
```

No `npm`, no `uv`, no build step, no port clash with the studio (8899 vs 8800) —
both can run at once.

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

Grok, measured on this exact workload on OpenRouter (streamed TTFT / total, warm):

| Grok model | TTFT | Total |
|---|---|---|
| **x-ai/grok-4.20** | **0.77s** | **1.04s** |
| x-ai/grok-4.7 | 1.57s | 4.08s |
| x-ai/grok-4.6 | 1.30s | 8.51s |
| x-ai/grok-4.3 | 1.45s | 8.67s |
| x-ai/grok-build-0.1 | 1.11s | 11.59s |
| x-ai/grok-4.5 | 15.70s | 75.84s |

Only `grok-4.20` fits the interactive budget — the rest are 4–76s, which is
rehearsal-killing on stage. Default is **`x-ai/grok-4.20`**, falling back to
`x-ai/grok-4.7` only if the primary errors. Override either with
`CALLIOPE_MODEL=` / `CALLIOPE_FALLBACK_MODEL=`.

Benchmarked against the alternatives, Gemini 3.1 flash-lite is still the fastest
thing available (0.52s / 0.67s) — Grok 4.20 costs ~0.4s more per edit and writes
slightly more conservative values, but it is the fastest Grok by a wide margin.

End-to-end, typed or spoken, in the running app: **0.81s – 1.5s** per edit including
network, model, and DOM patch.

## Speech

Browser-native `webkitSpeechRecognition` — interim results are dim and instant,
finals are solid, both timestamped on the same clock as your strokes. No audio
leaves the machine except to the browser's own recognizer; no API key needed.
Auto mode applies ~1.1s after each finished sentence.

If mic permission is blocked, type in the box at the bottom instead — same path.

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
| `server.py` | static host, `/api/import`, `/api/edit` (model), `/api/publish` |
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
