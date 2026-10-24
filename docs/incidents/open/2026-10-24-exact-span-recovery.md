# Incident: Exact-span rejection during a streamed provider edit

- Status: fixed and tested in isolated detached worktree; not committed or deployed
- Port target: `4605ae47dd0d7df1fcb8ebab0a5754ac22e93423`, then fast-forwarded to `dda0a7e4a19361dcea4311755aaff388cfeef7b9` without overlapping changes
- Source: dirty `961517789b1a00003cc43446091e11e5fe37fa60` candidate (read-only)
- Surface: `/api/apply` NDJSON and JSON responses, Pi adapter, client stream consumer

## Human-reported symptom and acceptance
A near-match `oldText` rejects an edit. The selected model should receive a short, content-free correction receipt for a *safe missing span* and may submit a new exact edit. An ambiguous/unsafe batch must not get that receipt. A successful batch streams a provisional edit immediately; a missing batch streams no edit. If correction stops, repeats, or errors, the server emits `error` and the existing client catch restores the original preview. A completed correction emits `done` matching the last edit. Normal provider-answer failures retain three independent attempts from the original input; exhausted miss is terminal.

## Forensics and canonical repro
The clean target `4605ae4` retains the agent/retry sections of the source base while changing the studio branding and retiring 3D asset routes. The old adapter classified matches while executing each call, so an early miss could mask a later unsafe or ambiguous edit; its subprocess returned only a generic rejection. The target already streams complete HTML snapshots after successful batches. Its frontend consumes `edit` immediately and restores `originalHtml` on a rejected or truncated stream. No private trace was read.

Repro with mocked provider transport and the real local adapter: send a valid edit, then an absent `oldText`, then a model stop. Inspect NDJSON: the first edit remains visible during correction, no second edit is emitted, and an `error` terminates the stream. The client consumer rejects so the application catch restores its original page. Conversely, send a corrected exact edit and stop; expect `edit`, `edit`, `done` with the last two HTML values equal. Test a missing span plus an ambiguous or unsafe call in both orders; expect rejection, never a typed-miss receipt.

## RED and fix
The original source candidate recorded RED before its implementation. In this port, after a fresh `npm ci`, `node --test --test-name-pattern='safe missing batch' test/test_pi_edit.mjs` failed on the unmodified target adapter: exit 1 and generic rejection rather than the typed receipt. The adapter now validates every call and simulates the entire batch before any Pi execution; only a safe miss yields a typed content-free receipt. The provider loop sends that receipt through the selected provider's native envelope, retains opaque OpenRouter reasoning, tracks unresolved misses, allows a fourth *completion-only* response for late recovery, and never emits an edit for a rejected batch. `MissingSpanExhausted` stops the outer retry, while other provider-answer errors still use the three-attempt policy. Nonzero adapter exits are terminal; any provider failure after a safe miss is terminal even if a correction succeeded first. No fuzzy match or raw page HTML enters error receipts.

The production and test patch lines for `server.py` and `test/test_studio.py` match the read-only source candidate exactly; `pi_edit_adapter.mjs`, `test/test_apply_stream.mjs`, and `test/test_pi_edit.mjs` match it byte-for-byte. The target's asset route and its removed-3D regression remain untouched. This reconciliation compares the local port to the supplied candidate, not to a moving remote branch.

## Verification on `4605ae4`
- Dependency install: `npm ci --no-audit --no-fund` succeeded in this worktree.
- Focused adapter: `node --test test/test_pi_edit.mjs` 9/9.
- Focused streamed/retry/asset regression selection: `python -m unittest` with nine named `StudioTest` cases 9/9.
- Broad Node: `npm test` 102/102 (the branded/3D-retirement frontend checks also passed).
- Isolated build: `npm run build` succeeded in this detached worktree; 692 modules transformed, output in its local `dist/`.
- Broad Python: `python -m unittest discover -s test -p 'test_*.py'` 71/71.
- `git diff --check` clean.
- After fast-forward to `dda0a7e`, independent re-run: `npm test` 102/102; isolated `npm run build -- --outDir /srv/clanker-hermes/cache/scratch/calliope-latest-dist-check` passed; Python unittest discovery 73/73; `git diff --check` clean. The new owner-gateway tests passed within that Python run.
- Python emitted three implicit-HTTPError-cleanup `ResourceWarning` lines; tests still passed. Node emitted module-type warnings. No paid provider or deployed service was exercised.

## Deployment state and residual risk
Only this detached worktree was changed. It was moved to `/home/simon/repos/calliope-edit-recovery` so the uncommitted candidate will not be pruned with scratch files. The intervening `dda0a7e` changes affect only the owner gateway and its tests; the recovery edits remain untouched. No source candidate, root checkout, live service, commit, push, or deployment was touched. Browser and actual HTTPS gateway streaming remain unverified; do not claim live behavior from this test suite. The preview deliberately remains provisional while correction is pending and rolls back if it ultimately fails.
