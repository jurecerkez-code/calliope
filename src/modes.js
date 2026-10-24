import { buildBundles } from './timeline.js';

export const MODES = ['recording', 'live'];
export const eventsForMode = (timeline, mode) => timeline.filter(event => event.mode === mode);

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
