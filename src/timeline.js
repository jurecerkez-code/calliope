import { describeSketch } from './shape.js';

export function makePayload(stroke, t_end, viewport, enclosed_element) {
  if (stroke.tool !== 'pen') throw new Error('Only pen strokes are supported');
  const pts = stroke.pts.map(p => Object.freeze({...p, rect: p.rect && Object.freeze({...p.rect})}));
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const bbox = {x:Math.min(...xs), y:Math.min(...ys), width:Math.max(...xs)-Math.min(...xs), height:Math.max(...ys)-Math.min(...ys)};
  const candidate = {
    id:stroke.id, tool:stroke.tool, t:stroke.t, t_end, pts, elements:[...stroke.elements],
    coordinate_space:'preview-document-css-pixels', viewport:{...viewport},
    viewBox:`0 0 ${viewport.width} ${viewport.height}`, bbox,
    style: {color:'#00e05a',width:3},
    path:'M '+pts.map(p => `${p.x} ${p.y}`).join(' L '), enclosed_element
  };
  const summary = describeSketch(candidate);
  candidate.shape = summary.kind;
  if (!['circle','square','triangle'].includes(summary.kind)) candidate.enclosed_element = '';
  Object.freeze(pts); Object.freeze(candidate.elements);
  Object.freeze(candidate.viewport); Object.freeze(bbox); Object.freeze(candidate.style);
  return Object.freeze(candidate);
}

export function canApply(strokes, deliveries) {
  return strokes.every(stroke => deliveries[stroke.id] === 'accepted');
}

export function buildBundles(timeline) {
  const events = timeline.slice().sort((a,b) => a.t - b.t);
  const out = []; let chunk = null;
  for (const e of events) {
    if (e.kind === 'transcript') {
      if (chunk) out.push(chunk);
      chunk = {t_start:e.t, t_end:e.t, transcript:e.text, strokes:[]};
    } else if (chunk) {
      chunk.strokes.push(e.payload);
      chunk.t_end = Math.max(chunk.t_end, e.t_end || e.t);
    } else {
      chunk = {t_start:e.t, t_end:e.t_end || e.t, transcript:'(sketch before any speech)', strokes:[e.payload]};
    }
  }
  if (chunk) out.push(chunk);
  return out;
}
