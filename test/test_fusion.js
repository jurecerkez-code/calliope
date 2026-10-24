import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindReferences, classifyIntent, fuse, buildPacket, packetText, simulateWords } from '../src/lib/fusion.js';
import { adaptMessage } from '../src/lib/turn-timing.js';

const stroke = (id, startMs, endMs, label, extra = {}) => ({
  id, startMs, endMs, shape: 'closed-loop',
  bbox: { x: 0, y: 0, w: 10, h: 10 }, anchor: { x: 5, y: 5 },
  targets: [{ selector: `#${label}`, label, tag: 'button', confidence: 0.8 }],
  ...extra,
});

test('intent rules', () => {
  assert.equal(classifyIntent('this button should be green and more prominent'), 'modify');
  assert.equal(classifyIntent('put a summary chart here'), 'add');
  assert.equal(classifyIntent('move this over there'), 'move');
  assert.equal(classifyIntent('put the headline here'), 'move');
  assert.equal(classifyIntent('put the new chart here'), 'add');
  assert.equal(classifyIntent('remove that banner'), 'remove');
  assert.equal(classifyIntent('what does this do?'), 'query');
  assert.equal(classifyIntent('hmm'), 'unknown');
});

test('deictic binds to the nearest stroke inside the window', () => {
  const strokes = [stroke('S1', 1000, 2000, 'a'), stroke('S2', 9000, 9500, 'b')];
  const u = { words: simulateWords('this button should be green', 2500, 4500) };
  const refs = bindReferences(u, strokes);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].word, 'this');
  assert.equal(refs[0].strokeId, 'S1');
});

test('second deictic in one utterance prefers a different stroke', () => {
  const strokes = [stroke('S1', 1000, 1500, 'card'), stroke('S2', 2000, 2600, 'empty')];
  const u = { words: [{ text: 'move', startMs: 1600, endMs: 1700 }, { text: 'this', startMs: 1700, endMs: 1800 }, { text: 'here', startMs: 2300, endMs: 2400 }] };
  const refs = bindReferences(u, strokes);
  assert.deepEqual(refs.map((r) => r.strokeId), ['S1', 'S2']);
});

test('word outside the window stays unbound', () => {
  const refs = bindReferences({ words: [{ text: 'this', startMs: 20000, endMs: 20100 }] }, [stroke('S1', 0, 500, 'a')]);
  assert.equal(refs[0].strokeId, null);
});

test('add intent targets the place word', () => {
  const strokes = [stroke('S1', 1000, 1500, 'card'), stroke('S2', 3000, 3600, 'grid', { shape: 'line', anchor: { x: 900, y: 400 } })];
  const [u] = fuse([{ id: 'U1', text: 'put a summary chart here', startMs: 3000, endMs: 4000, final: true, words: simulateWords('put a summary chart here', 3000, 4000) }], strokes);
  assert.equal(u.intent, 'add');
  assert.equal(u.target.strokeId, 'S2');
  assert.match(u.instruction, /page \(900, 400\)/);
});

test('packet is valid JSON with the brief fields', () => {
  const strokes = [stroke('S1', 1000, 2000, 'save')];
  const utterances = [
    { id: 'U1', text: 'this button should be green', startMs: 2100, endMs: 3500, final: true, source: 'simulated', words: simulateWords('this button should be green', 2100, 3500) },
    { id: 'U2', text: 'interim', startMs: 4000, endMs: 4100, final: false, source: 'reson8', words: [] },
  ];
  const p = buildPacket({ elapsedMs: 5000, base: 'live-dom', strokes, utterances });
  const text = packetText(p);
  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  assert.equal(json.utterances.length, 1);
  assert.deepEqual(Object.keys(json.utterances[0]).sort(), ['endMs', 'final', 'id', 'instruction', 'intent', 'references', 'source', 'startMs', 'target', 'text'].sort());
  assert.equal(json.utterances[0].references[0].strokeId, 'S1');
  assert.equal(json.utterances[0].target.selector, '#save');
  assert.ok(json.timeline.some((t) => t.type === 'reference'));
  assert.ok(json.timeline.every((t, i, a) => i === 0 || a[i - 1].startMs <= t.startMs));
});

test('completed turn adapter maps provider times onto the session clock', () => {
  const raw = {
    type: 'turn_end', text: 'the patient', start_ms: 1200, duration_ms: 700,
    words: [{ text: 'the', start_ms: 1200, duration_ms: 200 }, { text: 'patient', start_ms: 1410, duration_ms: 450 }],
  };
  const a = adaptMessage(raw, 5000);
  assert.deepEqual([a.startMs, a.endMs], [6200, 6900]);
  assert.deepEqual(a.words[1], { text: 'patient', startMs: 6410, endMs: 6860 });
  assert.equal(adaptMessage({ type: 'turn_start' }, 0), null);
  assert.equal(adaptMessage({ type: 'turn_end', text: ' x ' }, 0).text, 'x');
});
