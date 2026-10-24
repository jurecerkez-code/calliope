import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBundles, makePayload, canApply } from './src/timeline.js';
import { describeSketch } from './src/shape.js';
import { readFileSync } from 'node:fs';

const pts = [[10,20], [25,30], [40,20]].map(([x,y]) => ({x,y,utc:'2026-10-24T12:00:00Z',selector:'button#download',text:'Download',rect:null}));

test('one complete immutable stroke per timeline event, with ordered points and UTC', () => {
  const first = makePayload({id:'a', tool:'pen', t:1, pts, elements:['button#download']}, 4, {width:949,height:2862}, 'button#download');
  const second = makePayload({id:'b', tool:'highlighter', t:5, pts, elements:['button#download']}, 8, {width:949,height:2862}, '');
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.pts[0]), true);
  assert.equal(first.path, 'M 10 20 L 25 30 L 40 20');
  assert.equal(first.pts[2].utc, '2026-10-24T12:00:00Z');
  assert.equal(first.viewBox, '0 0 949 2862');
  assert.equal(first.shape, 'freehand');
  assert.deepEqual(buildBundles([{kind:'stroke', t:1,t_end:4,payload:first},{kind:'stroke',t:5,t_end:8,payload:second}])[0].strokes, [first,second]);
  assert.equal(canApply([first,second], {a:'accepted',b:'failed'}), false);
  assert.equal(canApply([first,second], {a:'accepted',b:'accepted'}), true);
});

test('bundled shape interpreter keeps the enclosed DOM target and natural-language hint', () => {
  const circle = Array.from({length:25}, (_,i) => {
    const a = i * Math.PI * 2 / 24;
    return {x:Math.round(150+45*Math.cos(a)), y:Math.round(120+40*Math.sin(a)), utc:'2026-10-24T12:18:56.822Z',selector:'body',text:'',rect:null};
  });
  const payload = makePayload({id:'circle',tool:'pen',t:1,pts:circle,elements:['body']},10,{width:949,height:2862},'button#Download');
  assert.equal(payload.shape, 'circle');
  assert.equal(payload.enclosed_element, 'button#Download');
  assert.match(describeSketch(payload).text, /CIRCLE drawn at .* around button#Download$/);
  assert.equal(payload.pts.length,25);
});

test('Calliope retains its brand and staged publish control in the migrated studio', () => {
  const app = readFileSync(new URL('./src/App.svelte', import.meta.url), 'utf8');
  assert.match(app, /CALLIOPE \/\/ SPEAK \+ DRAW/);
  assert.match(app, /\/api\/publish/);
  assert.match(app, /PUBLISH/);
});

test('studio exposes URL import in its existing preview', () => {
  const app = readFileSync(new URL('./src/App.svelte', import.meta.url), 'utf8');
  assert.match(app, /\/api\/import/);
  assert.match(app, /aria-label="Website URL"/);
  assert.match(app, /previewHtml\(out\.html\)/);
});

test('startup offers website import or a blank canvas without loading a demo site', () => {
  const app = readFileSync(new URL('./src/App.svelte', import.meta.url), 'utf8');
  assert.match(app, /mode = \$state\('start'\)/);
  assert.match(app, /START BLANK CANVAS/);
  assert.match(app, /IMPORT WEBSITE/);
  assert.match(app, /mode='website';drawing\?\.clear\(\)/);
  assert.doesNotMatch(app, /fetch\('\/jamie-mock\.html'\)/);
});
