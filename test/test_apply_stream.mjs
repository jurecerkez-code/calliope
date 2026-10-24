import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeApplyStream } from '../src/apply-stream.js';

const reply = (parts, {status = 200, contentType = 'application/x-ndjson; charset=utf-8'} = {}) =>
  new Response(new ReadableStream({start(controller) {
    for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
    controller.close();
  }}), {status, headers: {'content-type': contentType}});

const line = event => JSON.stringify(event) + '\n';

test('reports each complete edit before the final agent message, across split chunks', async () => {
  const edits = [];
  const result = await consumeApplyStream(reply([
    line({type:'edit', html:'<html>one</html>'}).slice(0, 17),
    line({type:'edit', html:'<html>one</html>'}).slice(17),
    line({type:'edit', html:'<html>two</html>'}),
    line({type:'done', html:'<html>two</html>', reasoning:'done', agent_message:'prompt'})
  ]), html => edits.push(html));
  assert.deepEqual(edits, ['<html>one</html>', '<html>two</html>']);
  assert.equal(result.html, '<html>two</html>');
});

test('a later failure rejects after previewing an edit, so caller can roll back', async () => {
  const edits = [];
  await assert.rejects(consumeApplyStream(reply([
    line({type:'edit', html:'<html>partial</html>'}),
    line({type:'error', error:'Pi rejected the edit batch'})
  ]), html => edits.push(html)), /Pi rejected/);
  assert.deepEqual(edits, ['<html>partial</html>']);
});

test('preview remains visible during correction; later error rejects for rollback', async () => {
  let stream;
  const response = new Response(new ReadableStream({start(controller) { stream = controller; }}),
    {headers: {'content-type': 'application/x-ndjson'}});
  const original = '<html>original</html>';
  let visible = original;
  const completion = consumeApplyStream(response, html => { visible = html; })
    .catch(error => { visible = original; throw error; });
  stream.enqueue(new TextEncoder().encode(line({type:'edit', html:'<html>preview</html>'})));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(visible, '<html>preview</html>');
  // No edit event accompanies a rejected batch while the provider corrects it.
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(visible, '<html>preview</html>');
  stream.enqueue(new TextEncoder().encode(line({type:'error', error:'correction exhausted'})));
  stream.close();
  await assert.rejects(completion, /correction exhausted/);
  assert.equal(visible, original);
});

test('a truncated stream is not a completed edit and rejects', async () => {
  await assert.rejects(consumeApplyStream(reply([line({type:'edit', html:'<html>partial</html>'})]), () => {}), /incomplete/i);
});

test('non-stream errors retain their normal HTTP reason', async () => {
  await assert.rejects(consumeApplyStream(reply([JSON.stringify({error:'key unavailable'})],
    {status:503, contentType:'application/json'}), () => {}), /key unavailable/);
});
