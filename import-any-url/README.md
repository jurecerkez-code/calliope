# Paste a link

The narrowest slice of Calliope: **you paste a URL, that site's real HTML appears.**
No model, no microphone, no drawing. This is the part that decides what "the website
we want to change" is, and gets the page onto the screen intact.

```bash
python3 server.py      # http://127.0.0.1:8899, no dependencies
```

Open it in a browser, paste a link, hit Import.

## Why it is not an iframe

Embedding `https://their-site.com` in an iframe would be one line. It fails for the
reason this project exists: the page would be cross-origin, unreachable from our
JavaScript, and impossible for anything downstream to edit.

So the HTML is fetched, cleaned and served from our own origin:

1. **Every `<script>` is stripped** — inline, external, bodies included — plus
   `rel=modulepreload`/`prefetch` links and any CSP `<meta>`. A hydrated React app
   re-renders from its own state and silently wipes anything applied to the DOM.
2. **`<base href="https://origin/">` is injected** so the site's own stylesheet,
   fonts and images still load from its CDN. Without it every relative asset
   resolves against localhost and the page arrives unstyled.
3. The result is written to `site/page.html` and served at `/site`, same-origin, so
   the page is inspectable and editable later. `meta.json` records what was imported.

Measured: meetjamie.ai 112 KB / 4,389 words in ~150 ms, basecamp.com in ~200 ms,
stripe.com 394 KB in ~725 ms.

## What it refuses, and why

`normalize_url` in `import_site.py` rejects non-`http(s)` schemes, unqualified
hosts, and any host that resolves to a private, loopback, reserved or link-local
address — a link field that will fetch arbitrary URLs on request is an SSRF
vector, not a feature. `fetch` additionally refuses non-HTML content types and
pages over 6 MB.

## Empty shells

Server-rendered marketing pages survive this completely. A client-rendered app
(`excalidraw.com` is the example that caught this) returns 5 KB of nothing. The
server cannot tell the difference reliably — `example.com` is tiny and perfectly
real — so the check happens **after render**: the client counts visible text in the
iframe and, below 200 characters, says the page came through empty rather than
showing a blank rectangle.

## Files

| File | What |
|---|---|
| `server.py` | serves the door, `/api/import`, `/site`, `/api/meta` |
| `import_site.py` | fetch, sanitize, URL normalization — usable standalone |
| `static/index.html` | the door and the frame |
| `static/app.js` | import call, iframe load, empty-shell detection |
| `static/app.css` | engraved entry, dark stage |
| `static/plate-muse.png` | the Calliope plate |

## Where this is going

This is layer one of a stack: the same page already has a version that adds a
transcript, drawing on the page, and DOM edits from a fast model, plus a Reson8
relay for speech. Those arrive as separate PRs so each can be reviewed on its own.
