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

test('recording artifact keeps words and marks on one clock, as markdown plus JSON', async () => {
  const { buildArtifact } = await import('./src/modes.js');
  assert.equal(buildArtifact([]), '');
  const stroke = makePayload({id:'s1', tool:'pen', t:2500, pts, elements:['button#download']}, 3100, {width:949,height:2862}, '');
  const text = buildArtifact([
    {kind:'transcript', t:2000, text:'make this button green'},
    {kind:'stroke', t:2500, t_end:3100, payload:stroke}
  ], {page:'Demo', startedAt:'2026-10-24T12:00:00.000Z'});
  assert.match(text, /^# Calliope recording/);
  assert.match(text, /## \[00:02\] make this button green/);
  assert.match(text, /- \[00:02-00:03\] pen freehand, x 10-40, y 20-30, over button#download/);
  const json = JSON.parse(text.split('```json\n')[1].split('\n```')[0]);
  assert.equal(json.bundles[0].strokes[0].path, 'M 10 20 L 25 30 L 40 20');
  assert.equal(json.bundles[0].strokes[0].pts, undefined);
});

test('live queue never runs two agent calls at once and re-runs once for requests made mid-flight', async () => {
  const { createLiveQueue } = await import('./src/modes.js');
  let calls = 0, active = 0, maxActive = 0, release;
  const request = createLiveQueue(async () => {
    calls++; active++; maxActive = Math.max(maxActive, active);
    await new Promise(r => { release = r; });
    active--;
  });
  const first = request();
  request(); request();
  release(); await new Promise(r => setTimeout(r));
  release(); await first;
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
});

test('studio offers a recording/live toggle', () => {
  const app = readFileSync(new URL('./src/App.svelte', import.meta.url), 'utf8');
  assert.match(app, /role="radiogroup"/);
  assert.match(app, /COPY ARTIFACT/);
  assert.match(app, /if\(mode==='live'\)requestApply\(\)/);
});

test('studio has no text instruction entry; mode events remain separate', async () => {
  const app = readFileSync(new URL('./src/App.svelte', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /\btyped\b|submitTyped|id="instr"|type a note|type an instruction/);
  assert.match(app, /modeVersion!==runModeVersion/);
  assert.match(app, /onStart:stroke=>\{stroke\.mode=mode/);
  assert.match(app, /kind:'stroke',mode:stroke\.mode/);
  assert.match(app, /if\(stroke\.mode==='live'&&mode==='live'\)deliver\(stroke\)/);
  assert.match(app, /row\.stroke\?\.mode==='live'&&row\.stroke\.payload&&!deliveries\[row\.stroke\.id\]/);
  const { eventsForMode } = await import('./src/modes.js');
  const live = {kind:'transcript',mode:'live',t:1,text:'change the page'};
  const recording = {kind:'transcript',mode:'recording',t:2,text:'just record this'};
  const events = [live, recording];
  assert.deepEqual(eventsForMode(events,'live'), [live]);
  assert.deepEqual(eventsForMode(events,'recording'), [recording]);
  assert.equal(events.length, 2);
});
