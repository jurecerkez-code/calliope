import { describeSketch } from './shape.js';
import { fuse, DEFAULT_WINDOW } from '../extension/lib/fusion.js';

export function makePayload(stroke, t_end, viewport, enclosed_element) {
  const pts = stroke.pts.map(p => Object.freeze({...p, rect: p.rect && Object.freeze({...p.rect})}));
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const bbox = {x:Math.min(...xs), y:Math.min(...ys), width:Math.max(...xs)-Math.min(...xs), height:Math.max(...ys)-Math.min(...ys)};
  const candidate = {
    id:stroke.id, tool:stroke.tool, t:stroke.t, t_end, pts, elements:[...stroke.elements],
    coordinate_space:'preview-document-css-pixels', viewport:{...viewport},
    viewBox:`0 0 ${viewport.width} ${viewport.height}`, bbox,
    style: stroke.tool === 'pen' ? {color:'#00e05a',width:3} : {color:'#ffd166',width:18,opacity:0.45},
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

function strokeRef(p) {
  return {
    id: p.id, startMs: p.t, endMs: p.t_end ?? p.t, shape: p.shape,
    anchor: p.bbox ? {x: Math.round(p.bbox.x + p.bbox.width/2), y: Math.round(p.bbox.y + p.bbox.height/2)} : null,
    targets: []
  };
}

// Deictic fusion over the naive chunks: "this/that/here/there" binds to the mark nearest
// in time, a stroke goes to the utterance whose word points at it, unpointed strokes go to
// the utterance nearest in time, and marks with no speech nearby keep their own bundle.
// Without word timings the legacy chunking is returned unchanged.
function fuseBundles(bundles) {
  const speech = bundles.filter(b => b.words && b.words.length);
  if (!speech.length) return bundles;
  const allStrokes = [];
  for (const b of bundles) for (const p of b.strokes) allStrokes.push(p);
  const refs = allStrokes.map(strokeRef);
  const utts = speech.map(b => ({
    id: 'u'+b.t_start, text: b.transcript, startMs: b.t_start, endMs: Math.max(b.t_end, b.t_start),
    words: b.words.map(w => typeof w === 'string' ? {text:w, startMs:b.t_start, endMs:b.t_end} : w)
  }));
  const fused = fuse(utts, refs);
  const assign = new Map();
  for (const u of fused) for (const r of u.references) {
    if (r.strokeId && !assign.has(r.strokeId)) assign.set(r.strokeId, u.id);
  }
  const win = DEFAULT_WINDOW, limit = Math.max(win.beforeMs, win.afterMs);
  for (const r of refs) {
    if (assign.has(r.id)) continue;
    let best = null;
    for (const u of fused) {
      const d = r.endMs < u.startMs ? u.startMs - r.endMs : (r.startMs > u.endMs ? r.startMs - u.endMs : 0);
      if (d <= limit && (!best || d < best.d)) best = {u, d};
    }
    if (best) assign.set(r.id, best.u.id);
  }
  const byUtt = new Map(fused.map(u => [u.id, {
    t_start: u.startMs, t_end: u.endMs, transcript: u.text, strokes: [],
    intent: u.intent, references: u.references, instruction: u.instruction
  }]));
  const orphan = [];
  for (const p of allStrokes) {
    const uid = assign.get(p.id);
    if (uid && byUtt.has(uid)) byUtt.get(uid).strokes.push(p); else orphan.push(p);
  }
  const out = [...byUtt.values()].sort((a,b) => a.t_start - b.t_start);
  if (orphan.length) out.unshift({
    t_start: Math.min(...orphan.map(p => p.t)), t_end: Math.max(...orphan.map(p => p.t_end ?? p.t)),
    transcript: '(sketch before any speech)', strokes: orphan
  });
  return out;
}

export function buildBundles(timeline) {
  const events = timeline.slice().sort((a,b) => a.t - b.t);
  const out = []; let chunk = null;
  for (const e of events) {
    if (e.kind === 'transcript') {
      if (chunk) out.push(chunk);
      chunk = {t_start:e.t, t_end:e.t_end ?? e.t, transcript:e.text, strokes:[], words:e.words || []};
    } else if (chunk) {
      chunk.strokes.push(e.payload);
      chunk.t_end = Math.max(chunk.t_end, e.t_end || e.t);
    } else {
      chunk = {t_start:e.t, t_end:e.t_end || e.t, transcript:'(sketch before any speech)', strokes:[e.payload], words:[]};
    }
  }
  if (chunk) out.push(chunk);
  return fuseBundles(out);
}

const DEICTIC = /^(this|that|these|those|here|there)$/;

// Three lanes for the on-page timeline: MARKS, WORDS, LINKS (word -> mark).
export function lanes(timeline) {
  const marks = [], words = [], links = [];
  for (const e of timeline) {
    if (e.kind === 'stroke' && e.payload) {
      marks.push({label: e.payload.id.slice(0,2).toUpperCase(), startMs: e.t, endMs: e.t_end ?? e.t});
    }
  }
  for (const b of buildBundles(timeline)) {
    for (const w of (b.words || [])) {
      const text = typeof w === 'string' ? w : w.text;
      words.push({text, startMs: typeof w === 'string' ? b.t_start : (w.startMs ?? b.t_start), deictic: DEICTIC.test((text || '').toLowerCase().replace(/[^a-z']/g,''))});
    }
    for (const r of (b.references || [])) {
      links.push({atMs: r.atMs, word: r.word, markId: (r.strokeId || '').slice(0,2).toUpperCase(), unbound: !r.strokeId});
    }
  }
  return {marks, words, links};
}
