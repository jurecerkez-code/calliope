# Draw and Talk

**The drawing says where, the voice says why, and the timestamps tie them together.**

Draw and Talk is the Chrome extension version of calliope. It lives in this `extension/` folder. You draw freehand on any web page while you speak. It records timestamped strokes and speech, works out which DOM elements each stroke points at, binds spoken words like "this" and "here" to the nearest stroke in time, and builds a context packet (JSON plus a PNG snapshot). You paste the packet into a coding agent so it can make the change.

Speech comes from [Reson8](https://reson8.dev) realtime speech-to-text with word-level timestamps. A Reson8 key and network connection are needed for voice capture.

---

## Install (about 1 minute, no build step)

Requirements: Chrome 116 or later (desktop).

1. Download this repository (green **Code** button, then **Download ZIP**) and unzip it, or `git clone` it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension` folder inside the repository (the folder that contains `manifest.json`).
4. Pin **Draw and Talk** from the puzzle-piece menu so the toolbar button is visible.

There are no dependencies and nothing to compile. `package.json` exists only so `npm test` can run the unit tests.

### Try it

1. Open any normal web page (or the demo page below) and set up voice as described below.
2. Click the **Draw and Talk** toolbar button. The side panel opens and the page gets a drawing overlay.
3. Press **Start drawing** (or `Alt+Shift+D`) and circle something.
4. Press **Start voice** and say "this button should be green".
5. The Results list shows the utterance with intent `modify`, the reference `"this" -> S1`, and the target element with its selector. The timeline shows the stroke, the words, and the link between them.
6. Press **Copy packet** and paste it anywhere. Press **Copy PNG** (or **Download PNG**) for the snapshot.

### Demo page

A small dashboard to draw on is included. From the `extension` folder, run:

```bash
python3 -m http.server 8765
```

Then open <http://localhost:8765/demo/dashboard.html>. (Content scripts cannot run on `file://` pages unless you enable "Allow access to file URLs" for the extension, so serve it over localhost.)

### Live voice (Reson8)

1. Create an account at [console.reson8.dev](https://console.reson8.dev), create a client, and generate an API key.
2. Open the extension's **Options** page (panel link **Options and API key**, or right-click the toolbar button, then **Options**). Paste the key, choose a language, press **Save**, then **Test key**.
3. In the Options page, press **Grant microphone** once. Chrome may not show a microphone prompt inside a side panel, so access is granted from this extension tab. The panel then shares that grant.
4. In the panel, press **Start voice** (or `Alt+Shift+V`). Interim text appears in italics; final utterances appear in Results and on the timeline with word ticks.

---

## How Reson8 auth works here

Browsers cannot set custom headers on a WebSocket. Reson8 documents a browser method for this ([Authentication](https://docs.reson8.dev/authentication/), "Token in Browser"):

1. The **background service worker** reads the API key from `chrome.storage.local` and exchanges it for a short-lived access token: `POST https://api.reson8.dev/v1/auth/token` with `Authorization: ApiKey <key>`. Tokens last 600 seconds; the worker caches one until 30 s before expiry.
2. The **side panel** opens the socket with the token as a sub-protocol: `new WebSocket(url, ["bearer", token])`, which sends `Sec-WebSocket-Protocol: bearer, <token>`.

The side panel never sees the API key, and the key is sent only to `api.reson8.dev`. The key is not in this repository. You enter it in Options and it stays in your browser profile. Reson8 advises against putting API keys in client apps; for a hackathon demo the key stays on your own machine, but a production version should mint tokens on a server.

Stream settings (`lib/reson8.js`): `wss://api.reson8.dev/v1/speech-to-text/realtime?encoding=pcm_s16le&sample_rate=16000&channels=1&include_timestamps=true&include_words=true&include_interim=true&language=<lang>`. Audio is captured with an `AudioContext` at 16 kHz and converted to 16-bit PCM in an AudioWorklet (`sidepanel/pcm-worklet.js`), sent in ~100 ms binary frames. **Stop voice** sends `{"type":"flush_request"}` so the last words come back before the socket closes.

Message fields used: `type`, `text`, `is_final`, `start_ms`, `duration_ms`, `words[].text`, `words[].start_ms`, `words[].duration_ms`, all taken from the [realtime API reference](https://docs.reson8.dev/api/speech-to-text/realtime/). The first five raw frames of each stream are logged to the panel's console as `[reson8 raw]` so the fields can be checked against a live stream. To see them, right-click inside the panel, choose **Inspect**, and open Console.

---

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Clicking the toolbar button (or a shortcut) grants temporary access to the current tab only: inject the overlay and capture the visible area. No standing access to your sites. |
| `scripting` | Inject the overlay script into that tab. |
| `sidePanel` | The panel that holds the timeline, results, microphone, and socket. |
| `storage` | `local`: API key and language. `session`: the current session, so reopening the panel keeps your strokes and speech. |
| Host `https://api.reson8.dev/*` | Request Reson8 access tokens from the service worker. |
| Optional hosts `http://*/*`, `https://*/*` | Requested only if you press **Allow on all sites** in the panel. This lets the panel follow you across tabs without clicking the toolbar button on each one. |

The microphone is requested by the browser's normal permission prompt, not by a manifest permission.

`web_accessible_resources` lists the overlay module and its two library files. Content scripts cannot be ES modules, so a small loader (`content/loader.js`) imports them by extension URL, and the page has to be allowed to load them.

---

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Alt+Shift+D` | Toggle drawing on the current tab (also opens the panel and grants access) |
| `Alt+Shift+V` | Start or stop live voice |
| `Alt+Shift+C` | Copy the packet |
| `Esc` | Stop drawing (while drawing on the page) |
| `Cmd/Ctrl+Z` | Undo the last stroke (while drawing) |

Change shortcuts at `chrome://extensions/shortcuts`.

---

## The packet

**Copy packet** produces a header line, the JSON in a fenced block, and a note to paste the PNG alongside. Example of the packet shape:

```json
{
  "session": { "elapsedMs": 6512, "base": "screenshot",
    "baseChanges": [{ "atMs": 0, "base": "live-dom" }, { "atMs": 5655, "base": "screenshot" }],
    "page": { "url": "http://localhost:8765/demo/dashboard.html", "title": "Acme Analytics (demo page)" } },
  "timeline": [
    { "startMs": 488, "endMs": 1504, "type": "drawing", "id": "S1", "label": "S1 closed-loop on button \"Export report\"" },
    { "startMs": 1873, "endMs": 3194, "type": "speech", "id": "U1", "label": "this button should be green and more prominent" },
    { "startMs": 1948, "endMs": 1948, "type": "reference", "id": "R1", "label": "\"this\" -> S1" }
  ],
  "strokes": [{
    "id": "S1", "startMs": 488, "endMs": 1504, "shape": "closed-loop",
    "bbox": { "x": 27.1, "y": 412.4, "w": 143.4, "h": 62.9 }, "anchor": { "x": 99, "y": 444 },
    "targets": [
      { "selector": "#export-report", "label": "Export report", "tag": "button", "confidence": 0.57 },
      { "selector": "#orders", "label": "Recent orders Order Customer ...", "tag": "section", "confidence": 0.4 },
      { "selector": "div.actions", "label": "Export report Filter", "tag": "div", "confidence": 0.38 }
    ]
  }],
  "utterances": [{
    "id": "U1", "startMs": 1873, "endMs": 3194, "text": "this button should be green and more prominent",
    "final": true, "source": "reson8", "intent": "modify",
    "references": [{ "word": "this", "atMs": 1948, "strokeId": "S1", "confidence": 0.96 }],
    "target": { "selector": "#export-report", "label": "Export report", "tag": "button", "confidence": 0.55, "strokeId": "S1", "anchor": { "x": 99, "y": 444 } },
    "instruction": "Modify button \"Export report\" (#export-report): \"this button should be green and more prominent\""
  }]
}
```

Times are milliseconds since the session started. Coordinates are page CSS pixels (client position plus scroll offset). The packet follows the brief's format and adds a few fields: `stroke.anchor` (arrow head for lines, box centre otherwise), `target.strokeId` and `target.anchor`, `reference.confidence`, `reference.implicit`, `session.baseChanges`, and `session.page`. Only final utterances go into the packet.

---

## How it works

```
manifest.json
background.js        service worker: toolbar click, shortcuts, captureVisibleTab, Reson8 token exchange
content/
  loader.js          classic script injected with chrome.scripting; imports overlay.js
  overlay.js         shadow-DOM canvas overlay, pointer capture, redraw on scroll, targets on stroke end
  overlay.css
sidepanel/
  panel.html/.css
  panel.js           session clock, mic + Reson8 socket, timeline, results, export
  pcm-worklet.js     float -> 16-bit PCM in 100 ms chunks
lib/
  strokes.js         Ramer-Douglas-Peucker simplification, bbox, shape classifier, shared stroke painter
  targets.js         elementsFromPoint scoring, selectorFor, labelFor
  reson8.js          WebSocket client, message adapter, close-code messages
  fusion.js          deictic binding, intent, packet builder
  export.js          PNG rendering, clipboard, download
options/             API key, language, one-time microphone grant
demo/dashboard.html  page to draw on
tests/               node:test unit tests for strokes, fusion, and the Reson8 adapter
```

**Session clock.** The panel owns the session start time (`Date.now()` epoch) and sends it to the overlay, so stroke times and speech times are on the same clock.

**Strokes.** Points are captured on `pointermove` (including coalesced events), stored in page coordinates, and redrawn on scroll. When a stroke ends it is simplified with Ramer-Douglas-Peucker and classified as `dot`, `closed-loop`, `underline`, `line`, or `scribble`. Arrows are classified as `line`, with the anchor at the end point.

**Targets.** Only on stroke end, never during a move: up to 40 points along the stroke (plus an interior grid for loops, a band just above underlines, and extra weight on a line's end point) go through `document.elementsFromPoint`. Each element is scored on coverage (how many samples hit it, discounted by stacking depth) and box fit (overlap between the stroke's box and the element's box, with shape-specific rules). Page-sized wrappers are penalised. The top three are kept, each with a stable selector (non-generated id, test attributes, or a short class/`nth-of-type` path checked for uniqueness) and a readable label (aria-label, alt, title, placeholder, or text).

**Fusion.** Each deictic word (`this`, `that`, `these`, `those`, `here`, `there`) binds to the stroke nearest in time, within 6 s before the word or 2.5 s after it (people tend to point just before they say "this"). A second deictic in the same utterance prefers a different stroke, so "move this here" can use two strokes. An utterance with no deictic falls back to the stroke closest to it in time, with lower confidence. Intent comes from keyword rules: `query`, `remove`, `move`, `add`, `modify`, `unknown`. The utterance target is the bound stroke's best element: the place word for `add`, the object word otherwise.

**Base modes.** *Live page* (default) draws over the real DOM. *Screenshot* captures the visible area with `chrome.tabs.captureVisibleTab` (the overlay is hidden for the capture) and shows it as a still image under the strokes, pinned to the scroll position at capture time. Strokes are still matched to the live DOM underneath. Every switch is logged in `session.baseChanges`.

**Export.** The PNG uses the screenshot in Screenshot mode, or a fresh capture of the page without the overlay in Live mode. Strokes and numbered badges are painted on it with the same painter as the overlay. Copy uses `navigator.clipboard.write` with an `image/png` item; if Chrome refuses, the PNG is downloaded instead.

---

## Known limitations

- **Visible area only.** `captureVisibleTab` captures only what is on screen. Strokes outside it are left out of the PNG, and the panel names them. They are still in the JSON.
- **Timestamp alignment is approximate.** Reson8 word times are relative to the audio stream. They are mapped to the session clock as `time first audio frame was sent - frame length (100 ms) + start_ms`. Microphone and audio pipeline latency before that first frame is not measured, so live word times can be early or late by roughly 50 to 150 ms.
- **Restricted pages.** Chrome does not let extensions script `chrome://` pages, the Chrome Web Store, other extensions' pages, and some PDF viewers. The panel shows a message on these. On `file://` pages, enable "Allow access to file URLs".
- **One tab per session.** A session belongs to one tab. If you switch tabs, the panel offers to go back or start a new session there.
- **Access per tab.** `activeTab` access ends when the tab navigates to another page. Click the toolbar button again, or use **Allow on all sites**.
- **Iframes.** Strokes over third-party iframes resolve to the `<iframe>` element, not its contents.
- **Copy shortcut.** `Alt+Shift+C` fires while the page has focus, so the panel cannot write the clipboard. The page writes it instead. If both are blocked, the panel shows the text to copy by hand.
- **Not built:** writing changes back to the page, multi-user sync, mobile.

---

## Tests

From the `extension` folder:

```bash
npm test
```

This runs Node's built-in test runner (Node 18+) over `tests/`: stroke simplification and shape classes, deictic binding, intent rules, packet validity and time ordering, and the Reson8 message adapter.

The voice-only panel still needs an end-to-end check with a real microphone and Reson8 stream.

---

## Demo script (2 minutes)

1. Open a page with a real layout (the demo dashboard works). Click the toolbar button. Press **Start voice**.
2. Press `Alt+Shift+D`, circle a button, and say "this button should be green and more prominent."
3. Draw an arrow from a card to empty space and say "put a summary chart here."
4. Show the timeline: the strokes, the words, and the "this" and "here" references linked to their strokes. Show Results: intents `modify` and `add`, each with a selector.
5. Press **Copy packet**, paste it into a coding agent, then press **Copy PNG** and paste the image too. Show the change the agent proposes.
6. Close: the drawing says where, the voice says why, and the timestamps tie them together.

Voice capture needs a Reson8 key and a working network connection.
