import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBundles, makePayload, canApply, lanes, adaptTurn } from './src/timeline.js';
import { describeSketch } from './src/shape.js';
import { makeMark, createMarkQueue, MARK_SETTLE_DELAY_MS } from './src/marks.js';
import { readFileSync } from 'node:fs';
import { createAudio } from './src/audio.js';

const pts = [[10,20], [25,30], [40,20]].map(([x,y]) => ({x,y,utc:'2026-10-24T12:00:00Z',selector:'button#download',text:'Download',rect:null}));

test('one complete immutable stroke per timeline event, with ordered points and UTC', () => {
  const first = makePayload({id:'a', tool:'pen', t:1, pts, elements:['button#download']}, 4, {width:949,height:2862}, 'button#download');
  const second = makePayload({id:'b', tool:'pen', t:5, pts, elements:['button#download']}, 8, {width:949,height:2862}, '');
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

test('session rows open the full text on demand, separate from their compact labels', () => {
  const app = readFileSync(new URL('./src/App.svelte', import.meta.url), 'utf8');
  assert.match(app, /copyText:agentMessage/);
  assert.match(app, /copyText:out\.agent_message/);
  assert.match(app, /state:response\.ok\?'SENT':'PREPARED \/ NOT SENT'/);
  assert.match(app, /<dialog[^>]*bind:this=\{detailDialog\}/);
  assert.match(app, /onclick=\{\(\) => openDetail\(row\)\}/);
  assert.match(app, /readonly[^>]*value=\{selectedRow\.copyText \?\? selectedRow\.text\}/);
  assert.match(app, /SELECT TEXT/);
  assert.doesNotMatch(app, /<Lanes\b/);
  assert.doesNotMatch(app, /<textarea[^>]*value=\{row\.copyText\}/);
});

test('a mark drawn during speech follows that utterance, including in the word lane', () => {
  const mark = makePayload({id:'during',tool:'pen',t:2600,pts,elements:['button#download']},2900,{width:949,height:2862},'');
  const timeline = [
    {kind:'transcript',t:1100,t_end:1400,text:'first sentence',words:[]},
    {kind:'stroke',t:2600,t_end:2900,payload:mark},
    {kind:'transcript',t:2300,t_end:3600,text:'make this green',words:[
      {text:'make',startMs:2300,endMs:2500},{text:'this',startMs:2700,endMs:2800},{text:'green',startMs:3100,endMs:3500}
    ]}
  ];
  const bundles = buildBundles(timeline);
  assert.deepEqual(bundles.map(b => b.transcript),['first sentence','make this green']);
  assert.deepEqual(bundles.map(b => b.strokes.map(s => s.id)),[[],['during']]);
  assert.equal(bundles[1].references[0].strokeId,'during');
  assert.equal(bundles[1].strokes[0],mark);
  assert.deepEqual(lanes(timeline).words.map(w => w.text),['make','this','green']);
});

test('the visible link ends at its actual mark, not below the pointing word', () => {
  const mark = makePayload({id:'during',tool:'pen',t:2600,pts,elements:['button#download']},2900,{width:949,height:2862},'');
  const data = lanes([
    {kind:'transcript',t:2100,t_end:3600,text:'make this green',words:[{text:'this',startMs:3200,endMs:3300}]},
    {kind:'stroke',t:2600,t_end:2900,payload:mark}
  ]);
  assert.equal(data.links[0].markAtMs, 2750);
  assert.notEqual(data.links[0].markAtMs, data.links[0].atMs);
  const component = readFileSync(new URL('./src/Lanes.svelte', import.meta.url), 'utf8');
  assert.match(component, /x2="\{g\.x\(l\.markAtMs\)\}"/);
});

test('the closer pointing turn owns a mark, without a dangling earlier reference', () => {
  const mark = makePayload({id:'shared',tool:'pen',t:1700,pts,elements:['button#download']},1800,{width:949,height:2862},'');
  const bundles = buildBundles([
    {kind:'transcript',t:500,t_end:1000,text:'make this red',words:[{text:'this',startMs:900,endMs:1000}]},
    {kind:'stroke',t:1700,t_end:1800,payload:mark},
    {kind:'transcript',t:1600,t_end:2100,text:'make this blue',words:[{text:'this',startMs:1700,endMs:1800}]}
  ]);
  assert.deepEqual(bundles.map(b => b.strokes.map(s => s.id)),[[],['shared']]);
  assert.equal(bundles[0].references[0].strokeId,null);
  assert.equal(bundles[1].references[0].strokeId,'shared');
});

test('a distant mark stays separate from an old instruction', () => {
  const mark=makePayload({id:'distant',tool:'pen',t:100000,pts,elements:['button#download']},100200,{width:949,height:2862},'');
  const bundles=buildBundles([
    {kind:'transcript',t:100,t_end:300,text:'change this',words:[{text:'this',startMs:200,endMs:300}]},
    {kind:'stroke',t:100000,t_end:100200,payload:mark}
  ]);
  assert.deepEqual(bundles.map(b=>b.strokes.map(s=>s.id)),[[],['distant']]);
  assert.equal(bundles[0].references[0].strokeId,null);
  assert.equal(bundles[1].transcript,'(sketch without nearby speech)');
});

test('unpointed marks respect the before and after association windows', () => {
  const mark=(id,t)=>makePayload({id,tool:'pen',t,pts,elements:['button#download']},t+100,{width:949,height:2862},'');
  const speech={kind:'transcript',t:10000,t_end:11000,text:'change the button',words:[]};
  const bundles=buildBundles([
    speech,
    {kind:'stroke',t:3800,t_end:3900,payload:mark('before-far',3800)},
    {kind:'stroke',t:4100,t_end:4200,payload:mark('before-near',4100)},
    {kind:'stroke',t:13400,t_end:13500,payload:mark('after-near',13400)},
    {kind:'stroke',t:13600,t_end:13700,payload:mark('after-far',13600)}
  ]);
  assert.deepEqual(bundles.find(b=>b.transcript==='change the button').strokes.map(s=>s.id),['before-near','after-near']);
  assert.deepEqual(bundles.find(b=>b.transcript==='(sketch without nearby speech)').strokes.map(s=>s.id),['before-far','after-far']);
  const between=buildBundles([
    {kind:'transcript',t:1000,t_end:2000,text:'earlier',words:[]},
    {kind:'stroke',t:5000,t_end:5100,payload:mark('between',5000)},
    {kind:'transcript',t:9000,t_end:10000,text:'later',words:[]}
  ]);
  assert.deepEqual(between.map(b=>b.strokes.map(s=>s.id)),[[],['between']]);
});

test('audio maps stream-relative word times independently of turn start, even with sparse finals', async () => {
  const saved = new Map();
  const set = (key,value) => {saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,value});};
  let socket, processor, received;
  class FakeSocket {constructor(){socket=this;this.readyState=1;}send(){}close(){}}
  try {
    set('window',{isSecureContext:true});set('location',{protocol:'http:',hostname:'127.0.0.1'});
    set('requestAnimationFrame',()=>1);set('cancelAnimationFrame',()=>{});
    set('navigator',{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})}});
    set('WebSocket',FakeSocket);
    set('AudioContext',class {
      sampleRate=16000;destination={};
      createMediaStreamSource(){return {connect(){}};}
      createAnalyser(){return {fftSize:0};}
      createScriptProcessor(){processor={connect(){}};return processor;}
      close(){}
    });
    const audio=createAudio({getContext:()=>({fillRect(){}})},{port:8801,elapsed:()=>5000,onLine:()=>{},onTurn:turn=>{received=turn;}});
    await audio.start();socket.onopen();
    processor.onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(4096)}});
    socket.onmessage({data:JSON.stringify({type:'turn_end_candidate',text:'make this green',start_ms:1000,duration_ms:1200,words:[
      {text:'make',start_ms:1000,duration_ms:200},{text:'this',start_ms:1300,duration_ms:200},{text:'green',start_ms:1700,duration_ms:300}
    ]})});
    socket.onmessage({data:JSON.stringify({type:'turn_end',text:'make this green',start_ms:null,duration_ms:null,words:[]})});
    assert.deepEqual([received.startMs,received.endMs],[5744,6944]);
    assert.deepEqual(received.words[1],{text:'this',startMs:6044,endMs:6244});
    audio.destroy();
  } finally {
    for(const [key,d] of saved){if(d)Object.defineProperty(globalThis,key,d);else delete globalThis[key];}
  }
});

test('a corrected final transcript never borrows candidate word positions by index', () => {
  const candidate={text:'make this green',start_ms:1000,duration_ms:1200,words:[
    {text:'make',start_ms:1000,duration_ms:200},
    {text:'this',start_ms:1300,duration_ms:200},
    {text:'green',start_ms:1700,duration_ms:300}
  ]};
  const unchanged=adaptTurn({text:'make this green'},candidate,5000,9000);
  assert.deepEqual(unchanged.words[1],{text:'this',startMs:6300,endMs:6500});
  const reordered=adaptTurn({text:'this make green'},candidate,5000,9000);
  assert.deepEqual([reordered.words[0].startMs,reordered.words[0].endMs],[6000,6360]);
  assert.equal(reordered.words[0].text,'this');
  const corrected=adaptTurn({text:'make that green'},candidate,5000,9000);
  assert.deepEqual([corrected.words[1].startMs,corrected.words[1].endMs],[6400,6760]);
  const fallback=adaptTurn({text:'change this'},null,null,9000);
  assert.deepEqual([fallback.startMs,fallback.endMs],[8240,9000]);
  const wordsOnly=adaptTurn({text:'make this green',words:candidate.words},null,5000,9000);
  assert.deepEqual([wordsOnly.startMs,wordsOnly.endMs],[6000,7000]);
  assert.deepEqual(wordsOnly.words[1],{text:'this',startMs:6300,endMs:6500});
  const startOnly=adaptTurn({text:'make this green',start_ms:1000},null,5000,9000);
  assert.deepEqual([startOnly.startMs,startOnly.endMs],[6000,7140]);
  assert.deepEqual([startOnly.words[1].startMs,startOnly.words[1].endMs],[6380,6722]);
  const correctedTimes=adaptTurn({text:'make this green',words:[
    {text:'make',start_ms:3000,duration_ms:200},
    {text:'this',start_ms:3300,duration_ms:200},
    {text:'green',start_ms:3700,duration_ms:300}
  ]},candidate,5000,9000);
  assert.deepEqual([correctedTimes.startMs,correctedTimes.endMs],[8000,9000]);
  assert.deepEqual(correctedTimes.words[1],{text:'this',startMs:8300,endMs:8500});
  const movedStart=adaptTurn({text:'make this green',start_ms:3000},candidate,5000,9000);
  assert.deepEqual([movedStart.startMs,movedStart.endMs],[8000,9140]);
  assert.deepEqual([movedStart.words[1].startMs,movedStart.words[1].endMs],[8380,8722]);
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
  assert.match(app, /\{#if publishEnabled\}<Button id="btnPublish" disabled=\{busy\}/);
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

test('both studio surfaces draw pen only, without a tool switch', () => {
  const app = readFileSync(new URL('./src/App.svelte', import.meta.url), 'utf8');
  const drawing = readFileSync(new URL('./src/drawing.js', import.meta.url), 'utf8');
  const board = readFileSync(new URL('./src/board.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /btnTool|highlighter/);
  assert.doesNotMatch(drawing, /highlighter/);
  assert.doesNotMatch(board, /highlighter/);
  assert.match(app, /btnClear/);
  assert.match(app, /btnUndo/);
  const pen = makePayload({id:'pen-only',tool:'pen',t:1,pts,elements:['button#download']},2,{width:949,height:2862},'');
  assert.deepEqual(pen.style,{color:'#00e05a',width:3});
});

test('startup offers website import or a blank canvas without loading a demo site', () => {
  const app = readFileSync(new URL('./src/App.svelte', import.meta.url), 'utf8');
  assert.match(app, /mode = \$state\('start'\)/);
  assert.match(app, /START BLANK CANVAS/);
  assert.match(app, /IMPORT WEBSITE/);
  assert.match(app, /mode='website';modeVersion\+\+;drawing\?\.clear\(\)/);
  assert.doesNotMatch(app, /fetch\('\/jamie-mock\.html'\)/);
});

test('recording artifact keeps words and marks on one clock, as markdown plus JSON', async () => {
  const { buildArtifact } = await import('./src/modes.js');
  assert.equal(buildArtifact([]), '');
  const stroke = makePayload({id:'s1', tool:'pen', t:2500, pts, elements:['button#download']}, 3100, {width:949,height:2862}, '');
  const mark = makeMark([stroke]);
  const text = buildArtifact([
    {kind:'transcript', t:2000, text:'make this button green'},
    {kind:'stroke', t:2500, t_end:3100, payload:mark}
  ], {page:'Demo', startedAt:'2026-10-24T12:00:00.000Z'});
  assert.match(text, /^# Calliope recording/);
  assert.match(text, /## \[00:02\] make this button green/);
  assert.match(text, /- \[00:02-00:03\] freehand mark \(1 path\):/);
  assert.match(text, /pen freehand, x 10-40, y 20-30, over button#download/);
  const json = JSON.parse(text.split('```json\n')[1].split('\n```')[0]);
  assert.equal(json.bundles[0].marks[0].strokes[0].path, 'M 10 20 L 25 30 L 40 20');
  assert.equal(json.bundles[0].marks[0].strokes[0].pts, undefined);
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
  assert.match(app, /if\(operation==='live'\)requestApply\(\)/);
});

test('studio has no text instruction entry; mode events remain separate', async () => {
  const app = readFileSync(new URL('./src/App.svelte', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /\btyped\b|saySimulated|id="instr"|id="said"|type a note|type an instruction/);
  assert.match(app, /modeVersion!==runModeVersion/);
  assert.match(app, /strokeModes\.set\(stroke\.id,operation\)/);
  assert.match(app, /kind:'stroke',mode:markMode/);
  assert.match(app, /if\(markMode==='live'&&mode==='website'&&operation==='live'\)return deliver\(mark\)/);
  const { eventsForMode } = await import('./src/modes.js');
  const live = {kind:'transcript',mode:'live',t:1,text:'change the page'};
  const recording = {kind:'transcript',mode:'recording',t:2,text:'just record this'};
  const events = [live, recording];
  assert.deepEqual(eventsForMode(events,'live'), [live]);
  assert.deepEqual(eventsForMode(events,'recording'), [recording]);
  assert.equal(events.length, 2);
});
