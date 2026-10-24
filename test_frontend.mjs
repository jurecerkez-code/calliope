import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBundles, makePayload, canApply } from './src/timeline.js';
import { describeSketch } from './src/shape.js';
import { makeMark, createMarkQueue, MARK_SETTLE_DELAY_MS } from './src/marks.js';
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
  assert.match(app, /disabled=\{busy\|\|!publishEnabled\}/);
  assert.match(app, /REVIEW ONLY/);
  assert.match(app, /ack\.agent_message/);
  assert.match(app, /AGENT SKETCH CONTEXT/);
  assert.match(app, /out\.agent_message/);
  assert.match(app, /FULL AGENT MESSAGE/);
});

const slash = (id, a, b, t) => makePayload({id,tool:'pen',t,
  pts:Array.from({length:25},(_,i)=>({x:a[0]+(b[0]-a[0])*i/24,y:a[1]+(b[1]-a[1])*i/24,
    utc:'2026-10-24T12:00:00Z',selector:'button#target',text:'Target',rect:null})),elements:['button#target']},
  t+50,{width:949,height:2862},'');

test('two crossing strokes settle as one X without losing either original path', () => {
  const first=slash('one',[10,10],[110,110],1), second=slash('two',[110,10],[10,110],100);
  const mark=makeMark([first,second]);
  assert.equal(mark.shape,'x');
  assert.deepEqual(mark.strokes,[first,second]);
  assert.equal(mark.id,'one');
  assert.equal(mark.t_end,second.t_end);
  assert.equal(makeMark([first,slash('far',[310,10],[410,110],100)]),null);
  assert.equal(makeMark([first,slash('parallel',[20,10],[120,110],100)]),null);
});

test('delivery waits for the recognition window and APPLY flushes it', async () => {
  const timers=new Map(), sent=[];
  let next=0;
  const queue=createMarkQueue({delay:600,onSettled:async mark=>sent.push(mark),
    setTimer:fn=>{timers.set(++next,fn);return next;},clearTimer:id=>timers.delete(id)});
  const first=slash('one',[10,10],[110,110],1), second=slash('two',[110,10],[10,110],100);
  queue.add(first);
  assert.equal(sent.length,0);
  queue.hold();
  assert.equal(timers.size,0);
  queue.add(second);
  await queue.flush();
  assert.equal(sent.length,1);
  assert.equal(sent[0].shape,'x');
  assert.deepEqual(sent[0].strokes,[first,second]);
  assert.equal(timers.size,0);
});

test('a natural pause between X strokes does not send the first one', async () => {
  const sent=[], scheduled=[];
  const queue=createMarkQueue({onSettled:mark=>sent.push(mark),
    setTimer:(fn,delay)=>{scheduled.push({fn,delay});return scheduled.length;},clearTimer:()=>{}});
  const first=slash('one',[10,10],[110,110],1), second=slash('two',[110,10],[10,110],900);
  queue.add(first);
  assert.equal(MARK_SETTLE_DELAY_MS,2000);
  assert.equal(scheduled[0].delay,2000);
  assert.equal(sent.length,0);
  queue.hold(); // pointerdown of the second stroke cancels the pending settlement
  queue.add(second);
  await queue.flush();
  assert.equal(sent.length,1);
  assert.equal(sent[0].shape,'x');
  assert.deepEqual(sent[0].strokes,[first,second]);
  assert.match(readFileSync(new URL('./src/App.svelte', import.meta.url),'utf8'),/WAITING UP TO.*NEXT STROKE/);
});

test('expiry sends a single mark; unrelated strokes remain separate messages', async () => {
  const timers=new Map(), sent=[];
  let next=0;
  const queue=createMarkQueue({delay:600,onSettled:async mark=>sent.push(mark),
    setTimer:fn=>{timers.set(++next,fn);return next;},clearTimer:id=>timers.delete(id)});
  const first=slash('one',[10,10],[110,110],1);
  queue.add(first);
  assert.equal(sent.length,0);
  const expire=timers.values().next().value;
  expire();
  await queue.flush();
  assert.equal(sent.length,1);
  assert.deepEqual(sent[0].strokes,[first]);
  const far=slash('far',[310,10],[410,110],100), nextStroke=slash('next',[510,10],[610,110],200);
  queue.add(far);
  queue.add(nextStroke);
  await queue.flush();
  assert.deepEqual(sent.map(mark=>mark.id),['one','far','next']);
});

test('studio exposes URL import in its existing preview', () => {
  const app = readFileSync(new URL('./src/App.svelte', import.meta.url), 'utf8');
  assert.match(app, /\/api\/import/);
  assert.match(app, /aria-label="Website URL"/);
  assert.match(app, /previewHtml\(out\.html\)/);
});
