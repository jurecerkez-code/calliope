# Running Calliope

Build the studio with `npm ci && npm run build`, then start the loopback server with `uv run server.py`. Configure the keys in a private `.env` copied from `.env.example`; do not commit it. The microphone needs a secure origin and a working WebSocket audio relay. An HTTPS page alone does not prove voice works.

## Preview and publication

Live APPLY changes only the in-browser preview. The server has no `/api/publish` route or staged-output API. A POST to that path returns 404 and does not write a file. Publishing a site, if wanted, is a separate human-controlled deployment process; do not treat the preview as a deploy artifact.

## Receipt lifetime

The server keeps accepted strokes and grouped marks in separate, process-local stores. Each holds at most 500 entries. An entry expires after one hour without a successful registration, readback, or APPLY using it. Expired entries are removed on the next receipt or APPLY request, not by a background worker. An active, full store still returns HTTP 507 instead of silently discarding a mark. A missing or expired mark returns 404 on readback and HTTP 409 on APPLY, before any provider call. The studio resends selected marks after that 409 and offers **RETRY AGENT**; if delivery itself fails, retry the failed mark before the agent. A server restart resets the in-memory stores; a browser reload does not.

Private session traces are separate: see the README's **Session diagnostic trace** section. Receipt expiry does not erase trace files or the user's preview. Trace storage has its own limits and must remain owner-only.
