import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simplify, bboxOf, classifyShape, makeStroke } from '../lib/strokes.js';

const pts = (arr) => arr.map(([x, y], i) => ({ x, y, t: i * 10 }));

function circle(cx, cy, r, n = 60, sweep = 2 * Math.PI) {
  return pts(Array.from({ length: n + 1 }, (_, i) => [cx + r * Math.cos((i / n) * sweep), cy + r * Math.sin((i / n) * sweep)]));
}

test('simplify keeps endpoints and drops collinear points', () => {
  const line = pts(Array.from({ length: 50 }, (_, i) => [i, i]));
  const out = simplify(line);
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].x, out[1].x], [0, 49]);
});

test('bbox', () => {
  assert.deepEqual(bboxOf(pts([[10, 20], [30, 5], [15, 40]])), { x: 10, y: 5, w: 20, h: 35 });
});

test('shape classes', () => {
  assert.equal(classifyShape(pts([[100, 100], [102, 101], [101, 103]])), 'dot');
  assert.equal(classifyShape(circle(200, 200, 60)), 'closed-loop');
  assert.equal(classifyShape(circle(200, 200, 60, 60, Math.PI * 1.8)), 'closed-loop');
  assert.equal(classifyShape(pts(Array.from({ length: 40 }, (_, i) => [100 + i * 5, 300 + (i % 2)]))), 'underline');
  assert.equal(classifyShape(pts(Array.from({ length: 40 }, (_, i) => [100 + i * 5, 100 + i * 4]))), 'line');
  const zig = pts(Array.from({ length: 30 }, (_, i) => [100 + (i % 2) * 60, 100 + i * 3]));
  assert.equal(classifyShape(zig), 'scribble');
});

test('makeStroke records times, anchor at the end of a line', () => {
  const s = makeStroke('S1', pts(Array.from({ length: 40 }, (_, i) => [100 + i * 5, 100 + i * 4])));
  assert.equal(s.shape, 'line');
  assert.equal(s.startMs, 0);
  assert.equal(s.endMs, 390);
  assert.deepEqual(s.anchor, { x: 295, y: 256 });
  assert.ok(s.points.length < 40);
});
