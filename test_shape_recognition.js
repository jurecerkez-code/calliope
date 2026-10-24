const test = require('node:test');
const assert = require('node:assert/strict');
const recognizer = import('./src/shape-recognition.js');

// Synthetic strokes inspired by the visible marks, not traced screenshot coordinates.
function jaggedPolygon(corners, { gap = 0, overshoot = 0, jitter = 1.4, samples = 12 } = {}) {
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
    path.push({ x: a[0] + (b[0] - a[0]) * overshoot,
      y: a[1] + (b[1] - a[1]) * overshoot });
  }
  return path;
}
function oval(cx, cy, rx, ry, { gap = 0, overshoot = 0 } = {}) {
  const points = [];
  const end = 2 * Math.PI * (1 - gap + overshoot);
  for (let i = 0; i <= 72; i++) {
    const a = end * i / 72;
    const r = 1 + 0.035 * Math.sin(9 * a) + 0.021 * Math.sin(17 * a);
    points.push({ x: cx + rx * r * Math.cos(a), y: cy + ry * r * Math.sin(a) });
  }
  return points;
}
const box = [[20, 20], [144, 16], [150, 82], [17, 85]];
const triangle = [[60, 15], [137, 105], [13, 106]];
const positives = [
  ['squiggly oval, 8% open', oval(90, 65, 65, 41, { gap: 0.08 }), 'circle'],
  ['oval, 7% past starting point', oval(90, 65, 65, 41, { overshoot: 0.07 }), 'circle'],
  ['rough rectangular loop, incomplete last edge', jaggedPolygon(box, { gap: 0.22 }), 'square'],
  ['rough rectangular loop with tail', jaggedPolygon(box, { overshoot: 0.18 }), 'square'],
  ['rough triangle, small gap', jaggedPolygon(triangle, { gap: 0.14 }), 'triangle'],
  ['rough triangle with overshot corner', jaggedPolygon(triangle, { overshoot: 0.17 }), 'triangle'],
];
for (const [name, points, expected] of positives) {
  test(name, async () => {
    const { recognizeShape } = await recognizer;
    const before = JSON.stringify(points);
    const result = recognizeShape(points);
    assert.equal(result.shape, expected, JSON.stringify(result));
    assert.ok(result.confidence >= 0.7 && result.confidence <= 1, JSON.stringify(result));
    assert.equal(JSON.stringify(points), before, 'input stroke must remain unchanged');
  });
}
const negatives = [
  ['long open line', Array.from({ length: 35 }, (_, i) => ({ x: 10 + i * 8, y: 35 + Math.sin(i) * 2 }))],
  ['L mark', [[10, 10], [10, 80], [115, 80]]],
  ['U mark', [[10, 10], [10, 75], [30, 86], [95, 86], [115, 75], [115, 10]]],
  ['three sides of box', [[20, 20], [135, 20], [135, 90], [20, 90]]],
  ['open arc', oval(90, 65, 65, 41, { gap: 0.36 })],
  ['tight repeated scribble', Array.from({ length: 100 }, (_, i) => ({ x: 80 + 40 * Math.cos(i * 0.27), y: 60 + 30 * Math.sin(i * 0.41) }))],
  ['crossing hourglass', jaggedPolygon([[20, 20], [130, 90], [20, 90], [130, 20]], { jitter: 0 })],
  ['double-traced circle', [...oval(90, 65, 65, 41), ...oval(90, 65, 65, 41)]],
  ['loop with a large interior slash', [...jaggedPolygon(box), { x: 83, y: 53 }, { x: 19, y: 21 }]],
  ['tiny accidental loop', oval(15, 20, 4, 3)],
  ['invalid point', [{ x: 10, y: 20 }, { x: NaN, y: 25 }, { x: 30, y: 20 }]],
];
for (const [name, coords] of negatives) {
  const points = Array.isArray(coords[0]) ? coords.map(([x, y]) => ({ x, y })) : coords;
  test(name, async () => {
    const { recognizeShape } = await recognizer;
    const before = JSON.stringify(points);
    const result = recognizeShape(points);
    assert.deepEqual(result, { shape: 'freehand', confidence: 0 });
    assert.equal(JSON.stringify(points), before);
  });
}

test('production ESM recognizer is importable by the frontend', async () => {
  const { recognizeShape } = await recognizer;
  const result = recognizeShape(oval(90, 65, 65, 41, { gap: 0.08 }));
  assert.equal(result.shape, 'circle');
});
