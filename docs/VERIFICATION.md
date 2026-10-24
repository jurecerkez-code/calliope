# Verification and demo limits

Run the local checks from a clean, built checkout:

```sh
npm ci
npm test
npm run build
uv run --with websockets python -m unittest test/test_studio.py test/test_gate_stream.py
```

The Node tests cover the Svelte event logic, drawing and turn selection, stream consumption, and virtual Pi edit adapter. The Python tests cover backend receipts, expiry, import, provider protocol with mocked HTTP replies, and the tailnet gate's origin and streaming behavior. A green suite does **not** prove a real microphone, Reson8 transcription, paid provider edit, or deployment.

For a release demo, open the exact served HTTPS build in a microphone-capable browser. Import a public page, draw a mark and verify its receipt, speak a completed Live instruction, and check that the same turn and mark lead to a changed preview. Check the private trace by its displayed ID for turn, accepted mark, provider response, and apply result. Do not paste the trace into an issue: it can contain meeting speech, page HTML, and prompts. Check the two-visitor boundary separately before opening anonymous access.

`test/e2e_voice_test.py` is an optional older generated-speech proof of the Reson8-to-agent API chain. It uses a synthetic stroke and a direct `/api/apply` call; it does not exercise the browser microphone or the Live turn queue. It requires live credentials and a running server, so treat its result separately from the local suite. If those are unavailable, report the browser Live path as **unverified**, not passed.
