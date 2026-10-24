import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiagram, buildCanvasPacket, canvasPacketText, nameFrom, edgeLabelFrom, toMermaid } from './src/diagram.js';
import { simulateWords } from './src/lib/fusion.js';

// Strokes as a person would draw them: t in ms on the session clock.
function rect(id, x, y, w, h, t0) {
  const pts = [];
  const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y + 2]];
  for (let c = 0; c < 4; c++) {
    const [ax, ay] = corners[c], [bx, by] = corners[c + 1];
    for (let i = 0; i < 12; i++) pts.push({ x: ax + ((bx - ax) * i) / 12, y: ay + ((by - ay) * i) / 12 });
  }
  return { id, tool: 'pen', points: pts.map((p, i) => ({ ...p, t: t0 + i * 15 })) };
}
function circle(id, cx, cy, r, t0) {
  const pts = Array.from({ length: 50 }, (_, i) => ({ x: cx + r * Math.cos((i / 49) * Math.PI * 2), y: cy + r * Math.sin((i / 49) * Math.PI * 2) }));
  return { id, tool: 'pen', points: pts.map((p, i) => ({ ...p, t: t0 + i * 15 })) };
}
function line(id, x1, y1, x2, y2, t0, n = 20) {
  return { id, tool: 'pen', points: Array.from({ length: n + 1 }, (_, i) => ({ x: x1 + ((x2 - x1) * i) / n, y: y1 + ((y2 - y1) * i) / n, t: t0 + i * 15 })) };
}
const say = (id, text, startMs, endMs) => ({ id, text, startMs, endMs, final: true, source: 'simulated', words: simulateWords(text, startMs, endMs) });

test('names from speech', () => {
  assert.equal(nameFrom('this is the API gateway', 'this'), 'API gateway');
  assert.equal(nameFrom('this box is called auth service and it checks tokens', 'this'), 'auth service');
  assert.equal(nameFrom("here we have the queue for orders", 'here'), 'queue');
  assert.equal(nameFrom("here's the cache", 'here'), 'cache');
  assert.equal(nameFrom('call this the user DB', 'this'), 'user DB');
  assert.equal(nameFrom('make this bigger', 'this'), '');
  assert.equal(nameFrom('then it goes to auth', null), '');
  assert.equal(edgeLabelFrom('this sends the token, then waits', 'this'), 'sends the token');
});

test('shapes become nodes, a stroke between them an edge, speech names them', () => {
  const strokes = [
    rect('S1', 100, 100, 200, 100, 1000),
    circle('S2', 600, 150, 60, 4000),
    line('S3', 300, 150, 540, 150, 7000),
    line('S4', 525, 140, 540, 150, 7500, 4), // arrowhead tick at the tip
  ];
  const utterances = [
    say('U1', 'this is the API gateway', 1500, 3000),
    say('U2', 'and this is auth', 4500, 5800),
    say('U3', 'this sends the token', 7100, 8200),
  ];
  const d = buildDiagram(strokes, utterances);
  assert.deepEqual(d.nodes.map((n) => [n.id, n.shape, n.label]), [['N1', 'box', 'API gateway'], ['N2', 'circle', 'auth']]);
  assert.equal(d.edges.length, 1);
  assert.deepEqual([d.edges[0].from, d.edges[0].to, d.edges[0].label, d.edges[0].arrowhead], ['N1', 'N2', 'sends the token', 'S4']);
  assert.deepEqual(d.nodes[0].said, ['U1']);
  assert.equal(toMermaid(d), 'flowchart LR\n  N1["API gateway"]\n  N2(("auth"))\n  N1 -->|"sends the token"| N2');
});

test('a stroke that does not connect two nodes stays an annotation', () => {
  const d = buildDiagram([rect('S1', 100, 100, 200, 100, 0), line('S2', 150, 260, 260, 262, 2000)], []);
  assert.equal(d.edges.length, 0);
  assert.equal(d.annotations[0].kind, 'underline');
  assert.equal(d.annotations[0].node, null);
});

test('packet text carries mermaid and parseable JSON', () => {
  const p = buildCanvasPacket({ elapsedMs: 9000, strokes: [rect('S1', 0, 0, 120, 80, 100)], utterances: [say('U1', 'this is the database', 300, 1500)] });
  const text = canvasPacketText(p);
  assert.match(text, /```mermaid\nflowchart LR\n {2}N1\["database"\]/);
  const json = JSON.parse(text.slice(text.indexOf('```json') + 7, text.lastIndexOf('```')));
  assert.equal(json.nodes[0].label, 'database');
  assert.equal(json.utterances[0].references[0].element, 'N1');
});

// Website payloads as timeline.js makePayload builds them (pts carry the element under each point).
function payload(id, tool, shape, pts, extra = {}) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { id, tool, shape, pts, elements: [], enclosed_element: '', ...extra,
    bbox: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) } };
}
const ring = (cx, cy, r) => Array.from({ length: 40 }, (_, i) => ({ x: cx + r * Math.cos((i / 39) * 2 * Math.PI), y: cy + r * Math.sin((i / 39) * 2 * Math.PI), selector: 'button.btn' }));
const stroke = (x1, y1, x2, y2, endSelector) => Array.from({ length: 21 }, (_, i) => ({ x: x1 + ((x2 - x1) * i) / 20, y: y1 + ((y2 - y1) * i) / 20, selector: i === 20 ? endSelector : 'main' }));

test('website: arrow from a circled element to empty space is a move', async () => {
  const { websiteRelations } = await import('./src/diagram.js');
  const marks = [
    payload('a', 'pen', 'circle', ring(200, 200, 50), { enclosed_element: 'button.btn "Download"' }),
    payload('b', 'pen', 'freehand', stroke(210, 210, 700, 500, 'section.stat'), { elements: ['main'] }),
  ];
  const [r] = websiteRelations(marks);
  assert.equal(r.kind, 'move');
  assert.deepEqual(r.from, { stroke: 'a', target: 'button.btn "Download"' });
  assert.deepEqual([r.to.stroke, r.to.target, r.to.x, r.to.y], [null, 'section.stat', 700, 500]);
});

test('website: arrow between a highlight and a circle is a link; a stroke inside one mark is nothing', async () => {
  const { websiteRelations } = await import('./src/diagram.js');
  const hl = payload('h', 'highlighter', 'highlight', stroke(100, 100, 300, 100, 'h1'), { elements: ['h1'] });
  const circle = payload('c', 'pen', 'circle', ring(700, 300, 60), { enclosed_element: 'section.stat' });
  const arrow = payload('x', 'pen', 'freehand', stroke(200, 100, 690, 300, 'section.stat'));
  const inside = payload('y', 'pen', 'freehand', stroke(670, 280, 730, 320, 'section.stat'));
  const rels = websiteRelations([hl, circle, arrow, inside]);
  assert.equal(rels.length, 1);
  assert.deepEqual([rels[0].kind, rels[0].from.target, rels[0].to.target], ['link', 'h1', 'section.stat']);
});

test('website: an earlier arrow cannot acquire a mark drawn later', async () => {
  const { websiteRelations } = await import('./src/diagram.js');
  const arrow = payload('a', 'pen', 'freehand', stroke(210, 210, 700, 500, 'section.stat'));
  const later = payload('m', 'pen', 'circle', ring(200, 200, 50), { enclosed_element: 'button.btn "Download"' });
  assert.deepEqual(websiteRelations([arrow, later]), []);
  assert.equal(websiteRelations([later, arrow])[0].kind, 'move');
});
