import test from 'node:test';
import assert from 'node:assert/strict';
import { adapt, MAX_HTML_BYTES } from '../pi_edit_adapter.mjs';

const original = '<!DOCTYPE html><html><body><h1>Old</h1><p>Keep</p></body></html>';
const call = (edits, path = 'index.html', name = 'edit') => ({
  id: 'edit-1', type: 'function', function: { name, arguments: JSON.stringify({ path, edits }) },
});
const edit = (oldText = 'Old', newText = 'Updated') => ({ oldText, newText });
const apply = (calls, current_html = original) => adapt({ action: 'edit', current_html, calls });

test('published Pi schema exposes only its edit parameters', async () => {
  const schema = await adapt({ action: 'describe' });
  assert.equal(schema.function.name, 'edit');
  assert.deepEqual(schema.function.parameters.required, ['path', 'edits']);
});

test('Pi applies disjoint edits against original and returns only short tool receipts', async () => {
  const result = await apply([call([edit(), edit('Keep', 'Old')])]);
  assert.equal(result.html, original.replace('Old', 'Updated').replace('Keep', 'Old'));
  assert.deepEqual(result.results, [{ role: 'tool', tool_call_id: 'edit-1', content: 'Exact edit applied to index.html.' }]);
});

test('all alternate paths and tools are rejected', async () => {
  for (const path of ['/etc/passwd', '../index.html', '/calliope-virtual/index.html', './index.html',
                      'index.html/../index.html', 'index.html\0', 'https://example.org', '.env']) {
    await assert.rejects(apply([call([edit()], path)]));
  }
  for (const name of ['bash', 'write', 'read', 'ls', 'mcp']) {
    await assert.rejects(apply([call([edit()], 'index.html', name)]));
  }
});

test('missing, ambiguous, overlapping, and fuzzy spans fail', async () => {
  await assert.rejects(apply([call([edit('missing')])]), /missing/);
  await assert.rejects(apply([call([edit('Old')])], original.replace('Keep', 'Old')), /ambiguous/);
  await assert.rejects(apply([call([edit('aa')])], '<html>aaa</html>'), /ambiguous/);
  await assert.rejects(apply([call([edit('Old'), edit('<h1>Old</h1>')])]), /Overlapping/);
  await assert.rejects(apply([call([edit('Old ')])]), /missing/);
  await assert.rejects(apply([call([edit('"Old"')])], original.replace('Old', '“Old”')), /missing/);
});

test('malformed arguments and bounded sizes fail', async () => {
  for (const edits of [null, [], [edit('')], [edit('Old', null)], [edit('Old', 'x'.repeat(16_384))],
                       Array(17).fill(edit())]) {
    await assert.rejects(apply([call(edits)]));
  }
  await assert.rejects(apply(Array(9).fill(call([edit()]))));
  await assert.rejects(apply([call([edit()])], 'é'.repeat(MAX_HTML_BYTES / 2 + 1)));
  const full = '<html>Old' + 'x'.repeat(MAX_HTML_BYTES - 16) + '</html>';
  assert.equal(Buffer.byteLength(full), MAX_HTML_BYTES);
  await assert.rejects(apply([call([edit()])], full), /too large/);
  await assert.rejects(apply([{ ...call([edit()]), function: { name: 'edit', arguments: '{' } }]));
});

test('Unicode, BOM and CRLF survive exact edits; mixed newline normalization fails closed', async () => {
  const page = '\ufeff<html>\r\n<h1>Old</h1>\r\n<p>é 🎈</p>\r\n</html>\r\n';
  assert.equal((await apply([call([edit()])], page)).html, page.replace('Old', 'Updated'));
  const mixed = '<html>\r\n<h1>Old</h1>\n</html>';
  await assert.rejects(apply([call([edit()])], mixed), /exact replacement/);
});

test('a late failing call returns no partially edited document; next request starts fresh', async () => {
  await assert.rejects(apply([call([edit()]), call([edit('missing')])]), /missing/);
  assert.equal((await apply([call([edit()])])).html, original.replace('Old', 'Updated'));
});
