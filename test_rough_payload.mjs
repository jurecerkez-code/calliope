import test from 'node:test';
import assert from 'node:assert/strict';
import { makePayload } from './src/timeline.js';
import { describeSketch } from './src/shape.js';

// Synthetic rough marks, not point samples extracted from a screenshot.
function oval(gap = 0, overshoot = 0) {
  return Array.from({ length: 73 }, (_, i) => {
    const a = 2 * Math.PI * (1 - gap + overshoot) * i / 72;
    const r = 1 + 0.035 * Math.sin(9 * a) + 0.021 * Math.sin(17 * a);
    return { x: 90 + 65 * r * Math.cos(a), y: 65 + 41 * r * Math.sin(a) };
  });
}
function polygon(corners, { gap = 0, overshoot = 0, jitter = 1.4, samples = 12 } = {}) {
  const path = [];
  for (let edge = 0; edge < corners.length; edge++) {
    const a = corners[edge], b = corners[(edge + 1) % corners.length];
    for (let i = 0; i < samples; i++) {
      const t = i / samples;
      const wobble = jitter * (Math.sin(i * 2.7 + edge * 4) + 0.35 * Math.sin(i * 6 + edge));
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      path.push({ x: a[0] + (b[0] - a[0]) * t - (b[1] - a[1]) / length * wobble,
        y: a[1] + (b[1] - a[1]) * t + (b[0] - a[0]) / length * wobble });
    }
  }
  path.push({ x: corners[0][0], y: corners[0][1] });
  if (gap) path.splice(-Math.ceil(gap * samples) - 1);
  if (overshoot) {
    const a = corners[0], b = corners[1];
    path.push({ x: a[0] + (b[0] - a[0]) * overshoot, y: a[1] + (b[1] - a[1]) * overshoot });
  }
  return path;
}
const box = [[20, 20], [144, 16], [150, 82], [17, 85]];
const triangle = [[60, 15], [137, 105], [13, 106]];
function payload(points) {
  const pts = points.map((p, i) => ({ ...p, utc: `2026-10-24T12:00:${String(i % 60).padStart(2, '0')}Z`, selector: 'button#outer', rect: { x: 0, y: 0, width: 200, height: 120 } }));
  const original = structuredClone(pts);
  const result = makePayload({ id: 'rough', tool: 'pen', t: 1, pts, elements: ['button#outer'] }, 2, { width: 300, height: 200 }, 'button#Inner');
  assert.deepEqual(pts, original, 'source points remain unchanged');
  assert.deepEqual(result.pts, original, 'full original path and metadata retained');
  assert.equal(result.path, 'M ' + pts.map(p => `${p.x} ${p.y}`).join(' L '));
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.pts) && Object.isFrozen(result.pts[0]));
  return result;
}
for (const [name, points, shape] of [
  ['squiggly oval with small gap', oval(0.08), 'circle'],
  ['oval with overshoot', oval(0, 0.07), 'circle'],
  ['rough box with gap', polygon(box, { gap: 0.22 }), 'square'],
  ['rough box with tail', polygon(box, { overshoot: 0.18 }), 'square'],
  ['rough triangle with gap', polygon(triangle, { gap: 0.14 }), 'triangle'],
  ['rough triangle with overshoot', polygon(triangle, { overshoot: 0.17 }), 'triangle'],
]) test(name, () => {
  const result = payload(points);
  assert.equal(result.shape, shape);
  assert.equal(result.enclosed_element, 'button#Inner');
  assert.match(describeSketch(result).text, new RegExp(`${shape.toUpperCase()} drawn at .* around button#Inner$`));
});
for (const [name, points] of [
  ['long line', Array.from({ length: 35 }, (_, i) => ({ x: 10 + i * 8, y: 35 + Math.sin(i) * 2 }))],
  ['L mark', [[10, 10], [10, 80], [115, 80]]],
  ['U mark', [[10, 10], [10, 75], [30, 86], [95, 86], [115, 75], [115, 10]]],
  ['missing box side', [[20, 20], [135, 20], [135, 90], [20, 90]]],
  ['open arc', oval(0.36)],
  ['repeated scribble', Array.from({ length: 100 }, (_, i) => ({ x: 80 + 40 * Math.cos(i * 0.27), y: 60 + 30 * Math.sin(i * 0.41) }))],
  ['crossing hourglass', polygon([[20, 20], [130, 90], [20, 90], [130, 20]], { jitter: 0 })],
  ['double traced oval', [...oval(), ...oval()]],
  ['loop with interior slash', [...polygon(box), { x: 83, y: 53 }, { x: 19, y: 21 }]],
  ['tiny loop', oval().map(p => ({ x: 15 + (p.x - 90) / 16, y: 20 + (p.y - 65) / 14 }))],
]) test(name, () => {
  const pts = Array.isArray(points[0]) ? points.map(([x, y]) => ({ x, y })) : points;
  const result = payload(pts);
  assert.equal(result.shape, 'freehand');
  assert.equal(result.enclosed_element, '');
});
