import { describeSketch } from './shape.js';
import { bindReferences, classifyIntent, simulateWords, MS_PER_WORD, DEFAULT_WINDOW } from '../extension/lib/fusion.js';
import { adaptMessage } from '../extension/lib/reson8.js';

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

export function adaptTurn(final, candidate, audioStartMs, nowMs) {
  const text = (final.text || candidate?.text || '').trim();
  const sameWords = (a, b) => a.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(' ') ===
    b.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(' ');
  const finalWords = final.words?.length > 0;
  const sameTurnStart = final.start_ms == null || final.start_ms === candidate?.start_ms;
  const msg = {
    ...candidate, ...final,
    // Final word times supersede candidate bounds when final turn bounds are absent.
    start_ms:final.start_ms ?? (finalWords ? null : candidate?.start_ms),
    duration_ms:final.duration_ms ?? (finalWords || !sameTurnStart ? null : candidate?.duration_ms),
    // A corrected final transcript can reorder words without changing its length.
    words:finalWords ? final.words :
      sameTurnStart && sameWords(text, candidate?.text || '') ? candidate?.words : []
  };
  const timed = audioStartMs != null && (msg.start_ms != null || msg.words?.length > 0);
  const turn = adaptMessage({...msg, type:'transcript', text}, audioStartMs);
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!timed) {
    turn.endMs = nowMs;
    turn.startMs = Math.max(0, nowMs - tokens.length * MS_PER_WORD);
  } else if (turn.endMs <= turn.startMs && tokens.length) {
    turn.endMs = turn.startMs + tokens.length * MS_PER_WORD;
  }
  turn.words = timed && turn.words.length === tokens.length
    ? turn.words.map((word, i) => ({...word, text:tokens[i]}))
    : simulateWords(text, turn.startMs, turn.endMs);
  return turn;
}

export function buildBundles(timeline) {
  const turns = timeline.filter(e => e.kind === 'transcript').map(e => ({
    ...e, startMs:e.startMs ?? e.t, endMs:e.endMs ?? e.t_end ?? e.t,
    words:e.words || []
  }));
  const marks = timeline.filter(e => e.kind === 'stroke').map(e => ({
    id:e.payload.id, startMs:e.t, endMs:e.t_end ?? e.t, payload:e.payload
  }));
  const references = turns.map(turn => bindReferences(turn, marks));
  const owner = new Map();
  const markById = new Map(marks.map(mark => [mark.id, mark]));
  const wordGap = (at, mark) => Math.max(0, mark.startMs - at, at - mark.endMs);
  // A pointing word beats mere turn proximity. If two turns point at the same
  // mark, the closer word wins rather than the earlier transcript arrival.
  references.forEach((refs, i) => refs.forEach(ref => {
    if (!ref.strokeId) return;
    const distance = wordGap(ref.atMs, markById.get(ref.strokeId));
    const previous = owner.get(ref.strokeId);
    if (!previous || distance < previous.distance) owner.set(ref.strokeId, {index:i,distance});
  }));
  references.forEach((refs, i) => refs.forEach(ref => {
    if (ref.strokeId && owner.get(ref.strokeId).index !== i) ref.strokeId = null;
  }));
  const gap = (turn, mark) => Math.max(0, turn.startMs - mark.endMs, mark.startMs - turn.endMs);
  for (const mark of marks) {
    if (owner.has(mark.id) || !turns.length) continue;
    let best = null;
    for (let i = 0; i < turns.length; i++) {
      const distance = gap(turns[i], mark);
      const limit = mark.endMs < turns[i].startMs ? DEFAULT_WINDOW.beforeMs : DEFAULT_WINDOW.afterMs;
      if (distance <= limit && (best === null || distance < gap(turns[best], mark))) best = i;
    }
    if (best !== null) owner.set(mark.id, {index:best});
  }
  const bundles = turns.map((turn, i) => {
    const mine = marks.filter(mark => owner.get(mark.id)?.index === i);
    return {
      t_start:Math.min(turn.startMs, ...mine.map(mark => mark.startMs)),
      t_end:Math.max(turn.endMs, ...mine.map(mark => mark.endMs)),
      transcript:turn.text, words:turn.words, intent:classifyIntent(turn.text),
      references:references[i].map(({word,atMs,strokeId}) => ({word,atMs,strokeId})),
      strokes:mine.map(mark => mark.payload)
    };
  });
  const orphan = marks.filter(mark => !owner.has(mark.id));
  if (orphan.length) bundles.push({
    t_start:Math.min(...orphan.map(mark => mark.startMs)),
    t_end:Math.max(...orphan.map(mark => mark.endMs)),
    transcript:'(sketch without nearby speech)', strokes:orphan.map(mark => mark.payload)
  });
  return bundles.sort((a,b) => a.t_start - b.t_start);
}

const DEICTIC = /^(this|that|these|those|here|there)$/;

// Three lanes for the on-page timeline: MARKS, WORDS, LINKS (word -> mark).
export function lanes(timeline) {
  const marks = [], words = [], links = [];
  const markById = new Map(timeline.filter(e => e.kind === 'stroke' && e.payload)
    .map(e => [e.payload.id, {startMs:e.t, endMs:e.t_end ?? e.t}]));
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
      const mark = markById.get(r.strokeId);
      links.push({atMs: r.atMs, word: r.word, markId: (r.strokeId || '').slice(0,2).toUpperCase(),
        markAtMs: mark ? (mark.startMs + mark.endMs) / 2 : null, unbound: !mark});
    }
  }
  return {marks, words, links};
}
