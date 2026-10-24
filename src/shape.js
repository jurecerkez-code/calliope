import { recognizeShape } from './shape-recognition.js';
export function describeSketch(stroke) {
  const pts = stroke.pts;
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  const width = Math.max(...xs) - x, height = Math.max(...ys) - y;
  const isPage = selector => /^(html|body|main)([.#:]|$)/i.test(selector);
  let targets = [...new Set((stroke.elements || pts.map(p => p.selector)).filter(s => s && !isPage(s)))];
  const kind = recognizeShape(pts).shape;
  const first = pts[0];
  if (['circle', 'square', 'triangle'].includes(kind)) {
    targets = stroke.enclosed_element && !isPage(stroke.enclosed_element) ? [stroke.enclosed_element] : [];
  }
  const relation = ['circle', 'square', 'triangle'].includes(kind) ? ' around ' : ' over ';
  const text = kind.toUpperCase() + ' drawn at ' + (first.utc || 'unknown time')
    + ' · coordinates x ' + x + '–' + (x + width) + ', y ' + y + '–' + (y + height)
    + (targets.length ? relation + targets.join(', ') : '');
  return { kind, targets, text };
}
