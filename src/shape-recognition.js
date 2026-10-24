import ShapeDetector from 'shape-detector';

// Recognize a single ordered pen stroke; all processing uses private copies.
const detector = new ShapeDetector(ShapeDetector.defaultShapes, { threshold: 0.68 });
const freehand = () => ({ shape: 'freehand', confidence: 0 });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function resample(points, count) {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths.at(-1) + distance(points[i - 1], points[i]));
  const result = [];
  let segment = 1;
  for (let i = 0; i < count; i++) {
    const target = lengths.at(-1) * i / (count - 1);
    while (segment < lengths.length - 1 && lengths[segment] < target) segment++;
    const span = lengths[segment] - lengths[segment - 1];
    const t = span ? (target - lengths[segment - 1]) / span : 0;
    result.push({ x: points[segment - 1].x * (1 - t) + points[segment].x * t,
      y: points[segment - 1].y * (1 - t) + points[segment].y * t });
  }
  return result;
}
function intersections(points) {
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  let count = 0;
  for (let i = 0; i < points.length - 1; i++) {
    for (let j = i + 2; j < points.length - 1; j++) {
      if (i === 0 && j === points.length - 2) continue;
      const [a, b, c, d] = [points[i], points[i + 1], points[j], points[j + 1]];
      if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) count++;
    }
  }
  return count;
}
// A tail can run beyond the start. Use the last near-start visit, provided it
// leaves at least 82% of the stroke as one loop; never cut away a whole scribble.
function trimTail(points, perimeter, gap) {
  let walked = 0;
  let cut = points.length - 1;
  let closest = distance(points[0], points[cut]);
  for (let i = points.length - 1; i >= 1; i--) {
    if (walked > perimeter * 0.18) break;
    const current = distance(points[0], points[i]);
    if (current < closest) { closest = current; cut = i; }
    walked += distance(points[i], points[i - 1]);
  }
  return closest < gap * 0.55 ? points.slice(0, cut + 1) : points;
}

function recognizeLine(points) {
  const start = points[0], end = points.at(-1);
  const dx = end.x - start.x, dy = end.y - start.y;
  const span = Math.hypot(dx, dy);
  if (span < 28) return null;
  let length = 0, deviation = 0;
  for (let i = 1; i < points.length; i++) {
    length += distance(points[i - 1], points[i]);
    deviation = Math.max(deviation, Math.abs(dx * (points[i].y - start.y) - dy * (points[i].x - start.x)) / span);
  }
  if (length > span * 1.18 || deviation > Math.max(4, span * 0.06)) return null;
  // Canonicalize left-to-right so reversing the drawing gesture keeps the angle.
  // Screen y grows down; positive angles rise toward the right.
  const rise = dx === 0 ? Math.abs(dy) : dx < 0 ? dy : -dy;
  const run = Math.abs(dx);
  const angle_deg = Math.round(Math.atan2(rise, run) * 180 / Math.PI * 10) / 10;
  const direction = Math.abs(angle_deg) <= 12 ? 'horizontal'
    : Math.abs(angle_deg) >= 78 ? 'vertical'
    : angle_deg > 0 ? 'bottom-left to top-right' : 'top-left to bottom-right';
  return { shape: 'line', confidence: Math.max(0, 1 - deviation / span - (length / span - 1)), angle_deg, direction };
}

export function recognizeShape(points) {
  if (!Array.isArray(points) || points.length < 2 ||
      points.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return freehand();
  const input = points.map(p => ({ x: p.x, y: p.y }));
  const line = recognizeLine(input);
  if (line) return line;
  if (input.length < 8) return freehand();
  const xs = input.map(p => p.x), ys = input.map(p => p.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  if (width < 12 || height < 12) return freehand();
  let length = 0;
  for (let i = 1; i < input.length; i++) length += distance(input[i - 1], input[i]);
  const gap = Math.min(width, height) * 0.35;
  const loop = trimTail(input, length, gap);
  if (distance(loop[0], loop.at(-1)) > gap || length > 3.1 * (2 * (width + height))) return freehand();
  const sampled = resample(loop, 64);
  if (intersections(sampled) > 1) return freehand();
  // The dependency's templates suggest a candidate; its resampler mutates input.
  const match = detector.spot(sampled.map(p => ({ ...p })));
  if (!['circle', 'square', 'triangle'].includes(match.pattern) || match.score < 0.72) return freehand();
  return { shape: match.pattern, confidence: Math.min(1, match.score) };
}
