import { buildBundles } from './timeline.js';
import { classifyIntent, DEFAULT_WINDOW } from './lib/fusion.js';
import { isWebsiteMark } from './diagram.js';

export const MODES = ['recording', 'live'];
export const eventsForMode = (timeline, mode) => timeline.filter(event => event.mode === mode);

// Select one final turn at a time. Receipt order is irrelevant: capture time
// decides which sketches belong to the turn. A move may finish with an arrow
// just after speech, so retain that arrow and its source as one instruction.
export function nextLiveEvents(events, relations) {
  const live=eventsForMode(events,'live');
  const turn=live.find(e=>e.kind==='transcript');
  if(!turn)return live.filter(e=>e.kind==='stroke');
  const marks=live.filter(e=>e.kind==='stroke');
  const selected=new Set(marks.filter(e=>e.t <= (turn.t_end ?? turn.t) && (e.t_end ?? e.t) >= turn.t));
  if(classifyIntent(turn.text)==='move') {
    const next=live.find(e=>e.kind==='transcript'&&e!==turn);
    const sources=marks.filter(e=>isWebsiteMark(e.payload)&&
      e.t>=turn.t-DEFAULT_WINDOW.beforeMs&&
      e.t<=(turn.t_end??turn.t)+DEFAULT_WINDOW.afterMs&&
      (!next||e.t<next.t));
    if(sources.length){
      const during=sources.filter(e=>e.t>=turn.t&&e.t-turn.t<=5000);
      const eligible=relations.filter(r=>(r.kind==='move'||r.kind==='link')&&
        sources.some(e=>e.payload.strokes[0].id===r.from?.stroke)&&
        Math.abs((marks.find(e=>e.payload.id===r.arrow)?.t??Infinity)-turn.t)<=5000&&
        (!next||marks.find(e=>e.payload.id===r.arrow)?.t<next.t));
      const source=(eligible.length ? sources.filter(e=>eligible.some(r=>r.from.stroke===e.payload.strokes[0].id)) :
        during.length?during:sources).reduce((best,e)=>
        Math.abs(e.t-turn.t)<Math.abs(best.t-turn.t)?e:best);
      selected.add(source);
      const relation=eligible.find(r=>r.from?.stroke===source.payload.strokes[0].id);
      if(relation){const arrow=marks.find(e=>e.payload.id===relation.arrow);if(arrow)selected.add(arrow);}
    }
  }
  return [turn,...marks.filter(e=>selected.has(e))];
}

// An incomplete move may be sent as words alone; retain its source mark.
export const speechOnlyEvents = selected => selected.filter(e => e.kind === 'transcript');

// Keep a spoken move with its circled source until an arrow supplies the
// destination. Otherwise live speech APPLY consumes the circle before the
// following arrow can refer to it.
export function awaitingMoveArrow(events, relations) {
  const sources = events.filter(e => e.kind === 'stroke' && isWebsiteMark(e.payload));
  const strokes = new Map(events.filter(e => e.kind === 'stroke').map(e => [e.payload.id, e]));
  return events.some(turn => {
    if (turn.kind !== 'transcript' || classifyIntent(turn.text) !== 'move') return false;
    // A source drawn during recognition can settle after the spoken turn.
    if (!sources.length) return true;
    const during = sources.filter(e => e.t >= turn.t && e.t - turn.t <= 5000);
    const source = (during.length ? during : sources).reduce((best, e) =>
      Math.abs(e.t - turn.t) < Math.abs(best.t - turn.t) ? e : best);
    return !relations.some(r => (r.kind === 'move' || r.kind === 'link') &&
      r.from?.stroke === source.payload.strokes[0].id &&
      Math.abs((strokes.get(r.arrow)?.t ?? Infinity) - turn.t) <= 5000);
  });
}

const clock = ms => {
  const s = Math.floor(ms / 1000);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
};

// Recording mode: words and marks on one clock, as text a person can paste into any agent.
export function buildArtifact(timeline, {page = '', startedAt = ''} = {}) {
  const bundles = buildBundles(timeline);
  if (!bundles.length) return '';
  const lines = ['# Calliope recording', ''];
  if (page) lines.push('Page: ' + page);
  if (startedAt) lines.push('Started: ' + startedAt);
  lines.push('Times are mm:ss since the session started. Shapes are estimates; the spoken words carry the intent.', '');
  for (const b of bundles) {
    lines.push(`## [${clock(b.t_start)}] ${b.transcript}`);
    for (const mark of b.strokes) {
      lines.push(`- [${clock(mark.t)}-${clock(mark.t_end)}] ${mark.shape} mark (${mark.strokes.length} path${mark.strokes.length === 1 ? '' : 's'}):`);
      for (const s of mark.strokes) {
        const target = ['circle', 'square', 'triangle'].includes(s.shape) && s.enclosed_element
          ? 'around ' + s.enclosed_element
          : 'over ' + (s.elements.join(', ') || 'background');
        lines.push(`  - [${clock(s.t)}-${clock(s.t_end)}] ${s.tool} ${s.shape}, x ${s.bbox.x}-${s.bbox.x + s.bbox.width}, y ${s.bbox.y}-${s.bbox.y + s.bbox.height}, ${target}`);
      }
    }
    lines.push('');
  }
  const data = bundles.map(b => ({
    t_start: b.t_start, t_end: b.t_end, transcript: b.transcript,
    marks: b.strokes.map(mark => ({id:mark.id, shape:mark.shape, t:mark.t, t_end:mark.t_end,
      strokes:mark.strokes.map(s => ({id:s.id, tool:s.tool, shape:s.shape, t:s.t, t_end:s.t_end, bbox:s.bbox,
        enclosed_element:s.enclosed_element, elements:s.elements, viewBox:s.viewBox, path:s.path}))}))
  }));
  lines.push('```json', JSON.stringify({page, startedAt, bundles: data}, null, 2), '```', '');
  return lines.join('\n');
}

// Live mode: one agent call at a time. A request that arrives mid-flight runs once the current one ends.
export function createLiveQueue(run) {
  let running = false, again = false;
  return async function request() {
    if (running) { again = true; return; }
    running = true;
    try {
      do { again = false; await run(); } while (again);
    } finally { running = false; }
  };
}
