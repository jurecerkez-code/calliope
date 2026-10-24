# voicedraw

Speak to the agent while drawing on a website. It changes the website live.

Built at the Jamie Agentic AI Hack in Berlin, 24 October 2026. Team: Jure Cerkez, Simon van Laak.

## The idea

In meetings people talk and sketch at the same time. Text alone loses the sketch. This agent takes both: your words and the marks you draw directly on the website, tied to the same timestamps. Then it changes the website while the group keeps talking.

One feature that works great: talk and draw at once, watch the page change.

## How it works

1. The app opens a website in a preview pane. In the demo the website is a mock of the jamie.ai homepage, so we redesign the host's own site on stage.
2. You draw directly on the website with the mouse. While drawing, the app records which HTML element sits beneath each mark (elementFromPoint), and that element gets a dashed outline. The mark belongs to the element, not to the screen.
3. Your microphone streams to Reson8. Live words appear as dim lines (turn_end_candidate) and committed sentences as solid lines (turn_end), each with a timestamp.
4. Speech and sketches live in one timeline on one clock. When the agent is called, each transcript chunk carries the sketches from the same time window. A stroke that crosses a chunk boundary is sent whole, never cut in half.
5. The agent reasons first and executes second. Claude reads the words plus the sketch geometry and the elements under the marks, writes one short paragraph of reasoning (shown in the UI), then returns the updated HTML. The preview updates in place.
6. PUBLISH is explicit. It stages the page to staging/ and prints the deploy command. Nothing goes live from a meeting by accident. Unfinished ideas stay in the preview.

## Sponsor tech, and why

- Reson8 speech to text, turns endpoint (API client: calliope). Used for live voice transcription because it streams short turns with timestamps and server side turn detection, fast enough to react during a meeting. Audio is sent as 16 kHz mono PCM through a small local relay so the API key never reaches the browser.
- Anthropic Claude. Used for the reasoning step (words plus sketches plus target elements) and the execution step (writing the new HTML), because it understands the combination of spoken intent and drawing geometry in one call.

## Run it

Requirements: Python 3.11 or newer, uv, a microphone, Chrome.

1. Copy .env.example to .env and fill in the keys. Get a Reson8 key at console.reson8.dev and an Anthropic key at platform.claude.com.
2. uv run server.py
3. Open http://127.0.0.1:8800 in Chrome.
4. Press MIC ON and allow the microphone. The level bars move when you speak.
5. Talk while drawing on the website. Press APPLY. The agent reasoning appears in the feed, then the preview updates.

Open the app through the server URL. Opening index.html directly does not work: without the server there is no mic relay and no agent.

## Layout

- server.py. HTTP server, Reson8 audio relay (browser to wss turns endpoint), reasoning and execution loop against the Anthropic API, staged publish endpoint.
- index.html. The app. Injects a drawing overlay into the website preview, captures elements under marks, keeps the shared timeline, shows the equalizer and the agent reasoning.
- jamie-mock.html. A mock of the jamie.ai homepage with their real copy. This is the canvas in the demo.

## Status

Working: live voice transcript with interim and final turns, drawing on the website itself with element capture and anchored outlines, time aligned chunks of speech and sketches, Claude reasoning plus execution, staged publish.

Not built: auto deploy of agent changes. The preview is the website. Going live is one explicit command (vercel deploy staging --prod) that a human runs when the idea is ready.

## Demo

Two minute video from the hackathon: [link to be added]

## License

MIT
