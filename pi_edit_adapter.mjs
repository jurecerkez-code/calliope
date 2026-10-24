// JSON stdin/stdout only. No Pi session, CLI, default tools, or filesystem operations.
import { createEditTool } from '@earendil-works/pi-coding-agent';
import { pathToFileURL } from 'node:url';

export const MAX_HTML_BYTES = 200_000;
const CWD = '/calliope-virtual';
const DOCUMENT = `${CWD}/index.html`;
const bytes = value => Buffer.byteLength(value, 'utf8');
const fail = message => { throw new Error(message); };

export async function adapt(request) {
  let current = request.current_html;
  let expected;
  const scope = path => { if (path !== DOCUMENT) fail('Only index.html is available'); };
  const tool = createEditTool(CWD, { operations: {
    access: async path => { scope(path); },
    readFile: async path => { scope(path); return Buffer.from(current, 'utf8'); },
    writeFile: async (path, content) => {
      scope(path);
      // Pi can normalize line endings / use fuzzy matching. Never accept collateral changes.
      if (content !== expected) fail('Pi edit was not an exact replacement');
      if (bytes(content) > MAX_HTML_BYTES) fail('Document too large');
      current = content;
    },
  } });
  if (request.action === 'describe') {
    return { type: 'function', function: {
      name: tool.name, description: tool.description, parameters: tool.parameters,
    } };
  }
  if (request.action !== 'edit' || typeof current !== 'string' || bytes(current) > MAX_HTML_BYTES)
    fail('Invalid document');
  if (!Array.isArray(request.calls) || !request.calls.length || request.calls.length > 8 ||
      bytes(JSON.stringify(request.calls)) > 32_768) fail('Invalid edit batch');
  const validated = request.calls.map(call => {
    if (call?.type !== 'function' || call.function?.name !== tool.name ||
        typeof call.id !== 'string' || !call.id || call.id.length > 200 ||
        typeof call.function.arguments !== 'string') fail('Invalid edit call');
    const args = JSON.parse(call.function.arguments);
    if (args?.path !== 'index.html' || Object.keys(args).some(k => !['path', 'edits'].includes(k)))
      fail('Only index.html is available');
    if (!Array.isArray(args.edits) || !args.edits.length || args.edits.length > 16)
      fail('Invalid replacements');
    for (const edit of args.edits) {
      if (!edit || Object.keys(edit).some(k => !['oldText', 'newText'].includes(k)) ||
          typeof edit.oldText !== 'string' || !edit.oldText || typeof edit.newText !== 'string' ||
          bytes(edit.oldText) + bytes(edit.newText) > 16_384) fail('Invalid replacement size');
    }
    return { call, args };
  });
  // Simulate the entire batch before executing Pi. A miss must not hide a
  // later ambiguous span, unsafe call, overlap, or oversized document.
  let preview = current;
  let missing = false;
  const planned = [];
  for (const { call, args } of validated) {
    const spans = [];
    for (const edit of args.edits) {
      const start = preview.indexOf(edit.oldText);
      if (start < 0) {
        missing = true;
        continue;
      }
      if (preview.indexOf(edit.oldText, start + 1) >= 0) fail('Exact span ambiguous');
      spans.push({ start, end: start + edit.oldText.length, text: edit.newText });
    }
    spans.sort((a, b) => a.start - b.start);
    for (let i = 1; i < spans.length; i++) {
      if (spans[i].start < spans[i - 1].end) fail('Overlapping edit spans');
    }
    expected = preview;
    for (const span of spans.toReversed()) {
      expected = expected.slice(0, span.start) + span.text + expected.slice(span.end);
    }
    if (bytes(expected) > MAX_HTML_BYTES) fail('Document too large');
    planned.push({ call, args, expected });
    preview = expected;
  }
  if (missing) fail('Exact span missing');
  const results = [];
  for (const plan of planned) {
    const { call, args } = plan;
    expected = plan.expected;
    await tool.execute(call.id, args);
    if (current !== expected) fail('Pi edit did not complete');
    // Do not send Pi's potentially large diff or the document back to the model.
    results.push({ role: 'tool', tool_call_id: call.id, content: 'Exact edit applied to index.html.' });
  }
  return { html: current, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let size = 0;
    const chunks = [];
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 1_500_000) fail('Adapter input too large');
      chunks.push(chunk);
    }
    process.stdout.write(JSON.stringify(await adapt(JSON.parse(Buffer.concat(chunks).toString('utf8')))));
  } catch (error) {
    // Never echo page text, tool arguments, or Pi diagnostics to the HTTP client.
    if (error?.message === 'Exact span missing') {
      process.stdout.write(JSON.stringify({ retryable_error: 'exact_span_missing' }));
    } else {
      process.stdout.write(JSON.stringify({ error: 'Pi rejected the edit batch' }));
      process.exitCode = 1;
    }
  }
}
