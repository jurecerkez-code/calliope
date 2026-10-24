<script>
  import { onMount } from 'svelte';
  import Loader from './Loader.svelte';
  import Button from './components/ui/button/Button.svelte';
  import Input from './components/ui/input/Input.svelte';
  import { attachDrawing } from './drawing.js';
  import { buildBundles, canApply, withoutMarks } from './timeline.js';
  import { createMarkQueue, MARK_SETTLE_DELAY_MS } from './marks.js';
  import { createAudio } from './audio.js';
  import { attachBoard } from './board.js';
  import { buildDiagram, buildCanvasPacket, canvasPacketText, websiteRelations, describeRelation } from './diagram.js';
  import { simulateWords, MS_PER_WORD } from './lib/fusion.js';
  import Icon from './components/brand/Icon.svelte';
  import Asterisk from './components/brand/Asterisk.svelte';
  import Timeline from './components/Timeline.svelte';
  import { buildArtifact, createLiveQueue, eventsForMode, awaitingMoveArrow, nextLiveEvents, speechOnlyEvents } from './modes.js';
  const DEFAULT_WEBSITE_URL = 'https://www.meetjamie.ai/';
  let feed, prev, eq, boardEl, detailDialog;
  let detailField = $state(null);
  let selectedRow = $state(null);
  let status = $state('CHOOSE HOW TO START.');
  let manualAction = $state('');
  let rows = $state([]), url = $state(''), importError = $state(''), busy = $state(false), micOn = $state(false);
  let imported = $state(false);
  let secure = $state(false), publishEnabled = $state(true);
  // Blank canvas mode: draw and talk to explain a concept; the result is a diagram packet.
  let mode = $state('start'), operation = $state('live'), nodes = $state([]), edges = $state([]);
  let board = null, canvasUtts = [], nextUtt = 1, modeVersion = 0, speechCapture = null;
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const sessionId = cryptoId();
  let traceQueue = Promise.resolve(), traceWarned = false, traceFailed = false;
  let currentHtml = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:system-ui,sans-serif;padding:48px"><h1>Your website</h1><p>Speak and draw on me to change me.</p><button style="padding:12px 20px">Click me</button></body></html>';
  let timeline = [], deliveries = {}, pending = {}, strokeModes = new Map(), drawing = null, audio = null, activeStroke = false, strokeWaiters = [], providerFailed = false;
  const elapsed = () => Date.now()-started;
  // What the side panel shows. The live timeline drains as turns are applied; this keeps the
  // whole session so the lanes and the interpretation can show what was said and drawn.
  let history = $state.raw({marks:[],turns:[]}), lastAgent = $state(''), now = $state(0), menuOpen = $state(false);
  let strokeTargets = new Map(), strokeCount = 0, handCursor = 'crosshair';
  function remember(kind,item){history={...history,[kind]:[...history[kind],item]};}
  function forget(kind){history={...history,[kind]:[]};}
  const clock = ms => fmt(Math.max(0,ms))+'.'+String(Math.max(0,Math.round(ms))%1000).padStart(3,'0');
  // Pair each turn with the references buildBundles resolved for it (same order, same text).
  const lanes = $derived.by(() => {
    const events=[...history.marks.map(m=>({kind:'stroke',t:m.startMs,t_end:m.endMs,payload:{id:m.id,strokes:[]}})),
      ...history.turns.map(t=>({kind:'transcript',t:t.startMs,t_end:t.endMs,text:t.text,words:t.words}))];
    const bundles=buildBundles(events).filter(b=>b.words), used=new Set();
    const turns=history.turns.map(t=>{
      const b=bundles.find(x=>!used.has(x)&&x.transcript===t.text);
      if(b)used.add(b);
      return {...t,intent:b?.intent||'unknown',references:b?.references||[]};
    });
    return {marks:history.marks,turns};
  });
  // The latest sentence and the mark it points at, as four plain steps.
  const said = $derived(lanes.turns.at(-1) || null);
  const pointedRef = $derived(said?.references.find(r=>r.strokeId) || null);
  const pointed = $derived(pointedRef ? history.marks.find(m=>m.id===pointedRef.strokeId) : history.marks.at(-1) || null);
  const target = $derived(pointed?.target?.selector ? pointed.target : null);

  const fmt = ms => {const s=Math.floor(ms/1000);return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');};
  function addLine(cls,text,options={}){rows=[...rows,{key:cryptoId(),cls,text,clock:fmt(elapsed()),...options}];scroll();}
  function cryptoId(){const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');}
  function trace(event,data){
    traceQueue=traceQueue.then(async()=>{
      const response=await fetch('/api/trace',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({session_id:sessionId,event,data})});
      if(!response.ok)throw new Error('HTTP '+response.status);
    }).catch(err=>{
      traceFailed=true;
      if(!traceWarned){traceWarned=true;addLine('err','SESSION TRACE FAILED: '+err.message);}
    });
    return traceQueue;
  }
  function scroll(){requestAnimationFrame(()=>{if(feed)feed.scrollTop=feed.scrollHeight;});}
  function rowText(stroke,state){const p=stroke.pts.at(-1);return `${stroke.summary?.text || stroke.tool.toUpperCase()+' '+p.x+', '+p.y+' · '+p.utc} · ${state}`;}
  function updateRow(mark,state,message){rows=rows.map(row=>{
    if(row.key!==mark.id)return row;
    const agentMessage=message ?? row.agentMessage;
    return {...row,agentMessage,copyText:agentMessage,state,text:agentMessage
      ? `${state} · AGENT SKETCH CONTEXT (FOR APPLY)`
      : `${mark.shape.toUpperCase()} · ${mark.strokes.length} PATH${mark.strokes.length===1?'':'S'} · ${state}`};
  });scroll();}
  function deliver(mark){
    if(deliveries[mark.id]==='sending'||deliveries[mark.id]==='accepted')return pending[mark.id];
    return pending[mark.id]=send(mark);
  }
  async function send(mark){
    deliveries[mark.id]='sending';updateRow(mark,'SENDING');
    try {
      const response=await fetch('/api/marks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...mark,session_id:sessionId})});
      const ack=await response.json();
      if(!response.ok||ack.status!=='accepted'||ack.id!==mark.id||typeof ack.agent_message!=='string')throw new Error(ack.error||'invalid receipt');
      deliveries[mark.id]='accepted';updateRow(mark,'ACCEPTED',ack.agent_message);
    }catch(err){deliveries[mark.id]='failed';updateRow(mark,'FAILED — CLICK TO RETRY');addLine('err','MARK NOT DELIVERED: '+err.message);void trace('mark_failed',{mark,error:err.message});}
  }
  async function retry(row){
    if(row.mark && deliveries[row.mark.id]==='failed'){
      await deliver(row.mark);
      if(deliveries[row.mark.id]==='accepted' && !providerFailed)requestApply();
    }
  }
  function rowLabel(row){
    const mark=row.mark || row.stroke?.payload;
    if(mark)return `${mark.shape.toUpperCase()} · ${mark.enclosed_element || mark.elements?.[0] || mark.strokes?.[0]?.elements?.[0] || 'PAGE'}`;
    if(row.stroke)return 'DRAWING · PAGE';
    if(row.copyText)return 'FULL AGENT MESSAGE';
    return row.text;
  }
  function openDetail(row){
    selectedRow=row;
    detailDialog.showModal();
  }
  function selectMessage(){
    detailField.focus();detailField.select();
  }
  const markQueue=createMarkQueue({onSettled:mark=>{
    const markMode=strokeModes.get(mark.id);
    const first=mark.strokes[0], pts=mark.strokes.flatMap(s=>s.pts.map(p=>({x:p.x,y:p.y})));
    const xs=pts.map(p=>p.x), ys=pts.map(p=>p.y);
    remember('marks',{id:mark.id,name:strokeTargets.get(first.id)?.name||'stroke',startMs:mark.t,endMs:mark.t_end,shape:mark.shape,pts,
      bbox:{x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)},
      target:strokeTargets.get(first.id)?.target||null});
    void trace('mark_captured',{mode:markMode,mark});
    for(const stroke of mark.strokes)strokeModes.delete(stroke.id);
    timeline.push({kind:'stroke',mode:markMode,t:mark.t,t_end:mark.t_end,payload:mark});
    rows=rows.filter(row=>!mark.strokes.slice(1).some(stroke=>row.key===stroke.id))
      .map(row=>row.key===mark.id?{...row,mark}:row);
    if(markMode==='live'){
      const live=eventsForMode(timeline,'live');
      const relations=websiteRelations(live.filter(e=>e.kind==='stroke').map(e=>e.payload));
      const relation=relations.find(r=>r.arrow===mark.id);
      if(relation)addLine('why',describeRelation(relation));
      if(relation && mode==='website' && operation==='live' &&
          live.some(e=>e.kind==='transcript') && !awaitingMoveArrow(live,relations)){
        manualAction='';
        void deliver(mark).then(requestApply);
      }
    }
    if(markMode==='live'&&!providerFailed&&!timeline.some(e=>e.kind==='transcript'&&e.mode==='live'))manualAction='sketches';
    if(markMode==='live'&&mode==='website'&&operation==='live')return deliver(mark);
    updateRow(mark,markMode==='recording'?'RECORDED':'QUEUED FOR LIVE');
  }});
  function previewHtml(html){
    currentHtml=html;
    // CSP is applied before the untrusted document; no script permission in the iframe sandbox.
    prev.srcdoc=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https:; img-src data: https:; font-src https:; script-src 'none'; frame-src 'none'; form-action 'none'; base-uri https:">`+html;
  }
  function previewLoaded(){if(!prev)return;drawing=attachDrawing(prev,{
    elapsed,cursor:handCursor,
    onStart:stroke=>{stroke.name='stroke_'+String(++strokeCount).padStart(2,'0');if(strokeModes.size&&[...strokeModes.values()].some(m=>m!==operation))void markQueue.flush();markQueue.hold();strokeModes.set(stroke.id,operation);activeStroke=true;rows=[...rows,{key:stroke.id,cls:'coord',text:rowText(stroke,'DRAWING'),clock:fmt(elapsed()),stroke}];scroll();},
    onMove:stroke=>{rows=rows.map(row=>row.key===stroke.id?{...row,text:rowText(stroke,'DRAWING')}:row);scroll();},
    onFinish:(stroke,payload,summary,target)=>{
      stroke.payload=payload;stroke.summary=summary;strokeTargets.set(stroke.id,{name:stroke.name,target});
      activeStroke=false;
      rows=rows.map(row=>row.key===stroke.id?{...row,text:rowText(stroke,`WAITING UP TO ${MARK_SETTLE_DELAY_MS/1000}S FOR NEXT STROKE`)}:row);
      markQueue.add(payload);
      strokeWaiters.splice(0).forEach(resolve=>resolve());
    }
  });}
  function clearMarks(){
    if(busy||activeStroke)return;
    markQueue.clear();drawing?.clear();timeline=withoutMarks(timeline);deliveries={};pending={};strokeModes.clear();
    if(manualAction==='sketches')manualAction='';
    addLine('fin','MARKS CLEARED');
    forget('marks');lastAgent='';
  }
  async function importUrl(event){
    event.preventDefault();
    if(busy)return;
    busy=true;importError='';status='IMPORTING WEBSITE...';
    try{
      const response=await fetch('/api/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:url.trim() || DEFAULT_WEBSITE_URL,session_id:sessionId})});
      const out=await response.json();
      if(!response.ok||out.error)throw new Error(out.error||'HTTP '+response.status);
      await markQueue.flush();
      history={marks:[],turns:[]};lastAgent='';
      imported=true;mode='website';modeVersion++;drawing?.clear();timeline=[];deliveries={};pending={};strokeModes.clear();manualAction='';providerFailed=false;
      previewHtml(out.html);void trace('preview_updated',{source:'import',url:out.url,elapsedMs:elapsed()});
      addLine('fin','IMPORTED '+out.url);status='WEBSITE IMPORTED. DRAW OR SPEAK ON IT.';
    }catch(err){importError=err.message;addLine('err','IMPORT FAILED: '+err.message);status='IMPORT FAILED. PREVIEW UNCHANGED.';}
    finally{busy=false;}
  }
  async function toggleMic(){
    if(micOn){audio?.stop();micOn=false;speechCapture=null;return;}
    try{await audio.start();micOn=true;speechCapture={mode,operation};}catch(err){void trace('mic_error',{error:err.message});addLine('err','MIC FAILED: '+err.message);}
  }
  async function apply(force=false){
    if(mode!=='website'||operation!=='live'||busy||(!force&&providerFailed))return;
    const runModeVersion=modeVersion;
    if(activeStroke){
      if(force){addLine('err','FINISH DRAWING BEFORE APPLY');return;}
      await new Promise(resolve=>strokeWaiters.push(resolve));
    }
    if(mode!=='website'||operation!=='live'||modeVersion!==runModeVersion)return;
    busy=true;
    let invoked=false;
    try{
      await markQueue.flush();
      if(mode!=='website'||operation!=='live'||modeVersion!==runModeVersion)return;
      const live=eventsForMode(timeline,'live');
      const allRelations=websiteRelations(live.filter(e=>e.kind==='stroke').map(e=>e.payload));
      const selected=nextLiveEvents(live,allRelations);
      const speechOnly=force&&manualAction==='speech-only';
      const sent=speechOnly?speechOnlyEvents(selected):selected;
      if(!force&&!sent.some(e=>e.kind==='transcript'))return;
      const marks=sent.filter(e=>e.kind==='stroke').map(e=>e.payload);
      const turn=sent.find(e=>e.kind==='transcript');
      const bundle=turn ? buildBundles(sent).find(b=>b.transcript===turn.text) : buildBundles(sent)[0];
      const bundles=bundle?[{...bundle,strokes:marks}]:[];
      if(!bundles.length){status='NOTHING NEW FOR THE AGENT.';return;}
      const relations=allRelations.filter(r=>marks.some(mark=>mark.strokes.some(s=>s.id===r.from?.stroke))&&
        marks.some(mark=>mark.id===r.arrow)).slice(0,50);
      if(!force&&!relations.some(r=>r.kind==='move'||r.kind==='link')&&awaitingMoveArrow(sent,relations)){
        void trace('apply_blocked',{reason:'waiting_for_arrow',turn:turn?.text,mark_ids:marks.map(mark=>mark.id)});
        manualAction='speech-only';status='DRAW AN ARROW TO COMPLETE THE MOVE, OR SEND SPEECH ONLY.';return;
      }
      await Promise.all(marks.map(mark=>pending[mark.id]));
      if(mode!=='website'||operation!=='live'||modeVersion!==runModeVersion)return;
      if(!canApply(marks,deliveries)){void trace('apply_blocked',{reason:'marks_not_accepted',mark_ids:marks.map(mark=>mark.id)});addLine('err','RETRY FAILED MARKS BEFORE APPLY');return;}
      status='AGENT IS UPDATING PREVIEW...';
      manualAction='';
      await traceQueue;
      if(traceFailed)throw new Error('SESSION TRACE UNAVAILABLE — RELOAD BEFORE SENDING');
      invoked=true;
      const requestId=cryptoId();
      const response=await fetch('/api/apply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({session_id:sessionId,request_id:requestId,bundles,relations,current_html:currentHtml})});
      const out=await response.json();
      if(mode!=='website'||operation!=='live'||modeVersion!==runModeVersion)return;
      if(typeof out.agent_message==='string')addLine('coord',`${response.ok?'SENT':'PREPARED / NOT SENT'} · FULL AGENT MESSAGE`,{copyText:out.agent_message,state:response.ok?'SENT':'PREPARED / NOT SENT'});
      if(!response.ok||out.error)throw new Error(out.error||'HTTP '+response.status);
      if(out.reasoning){addLine('why','AGENT: '+out.reasoning);lastAgent=out.reasoning;}
      previewHtml(out.html);void trace('preview_updated',{source:'agent',request_id:requestId,elapsedMs:elapsed()});timeline=timeline.filter(e=>!sent.includes(e));
      providerFailed=false;
      addLine('fin','EXECUTED ON PREVIEW. NOTHING PUBLISHED.');status='PREVIEW UPDATED. KEEP TALKING.';
      if(!timeline.some(e=>e.kind==='transcript'&&e.mode==='live')&&timeline.some(e=>e.kind==='stroke'&&e.mode==='live'))manualAction='sketches';
      if(timeline.some(e=>e.kind==='transcript'&&e.mode==='live'))requestApply();
    }catch(err){if(mode==='website'&&operation==='live'&&modeVersion===runModeVersion){
      if(invoked){providerFailed=true;manualAction='retry';}
      addLine('err','APPLY FAILED: '+err.message);status='APPLY FAILED. RETRY.';
    }}
    finally{busy=false;}
  }
  const requestApply=createLiveQueue(apply);
  async function copyArtifact(){
    if(activeStroke){addLine('err','FINISH DRAWING BEFORE COPYING');return;}
    await markQueue.flush();
    const artifact=buildArtifact(eventsForMode(timeline,'recording'),{page:prev?.contentDocument?.title||'',startedAt});
    if(!artifact){addLine('err','NOTHING RECORDED YET. SPEAK OR DRAW FIRST.');return;}
    try{await navigator.clipboard.writeText(artifact);addLine('fin','ARTIFACT COPIED.');}
    catch(_){
      const link=document.createElement('a');
      link.href=URL.createObjectURL(new Blob([artifact],{type:'text/markdown'}));
      link.download='calliope-recording.md';link.click();URL.revokeObjectURL(link.href);
      addLine('err','CLIPBOARD BLOCKED. DOWNLOADED calliope-recording.md INSTEAD.');
    }
  }
  function recompute(){
    const d=buildDiagram(board.strokes(),canvasUtts);
    board.setLabels(d);nodes=d.nodes;edges=d.edges;
    return d;
  }
  const describe=(d,id)=>{
    const n=d.nodes.find(x=>x.id===id); if(n) return `${n.id} ${n.shape.toUpperCase()}${n.label?' "'+n.label+'"':''}`;
    const e=d.edges.find(x=>x.id===id); if(e) return `${e.id} ${e.from} → ${e.to}${e.label?' "'+e.label+'"':''}`;
    return id;
  };
  function onCanvasStroke(stroke){
    void trace('canvas_stroke',{stroke});
    const d=recompute();
    const n=d.nodes.find(x=>x.strokeId===stroke.id), e=d.edges.find(x=>x.strokeId===stroke.id||x.arrowhead===stroke.id);
    const a=d.annotations.find(x=>x.strokeId===stroke.id);
    addLine('st',`${stroke.id} → `+(n?describe(d,n.id):e?describe(d,e.id)+(e.arrowhead===stroke.id?' (ARROWHEAD)':''):`${a.kind.toUpperCase()}${a.node?' NEAR '+a.node:''}`));
  }
  function addCanvasUtterance(turn,source){
    let {text,startMs,endMs,words}=turn;
    if(startMs==null){ // no Reson8 timestamps: assume it was just said, at a normal pace
      endMs=elapsed();startMs=Math.max(0,endMs-text.split(/\s+/).length*MS_PER_WORD);words=[];
    }
    if(!words?.length) words=simulateWords(text,startMs,endMs);
    const u={id:'U'+nextUtt++,text,startMs,endMs,words,final:true,source};
    canvasUtts=[...canvasUtts,u];
    const d=recompute(), fu=d.utterances.find(x=>x.id===u.id);
    for(const r of fu?.references||[]){
      addLine('why',`${r.word?'"'+r.word.toUpperCase()+'"':'(NEAREST IN TIME)'} → ${r.element?describe(d,r.element):'NOTHING DRAWN NEARBY'}`);
    }
  }

  // The engraved hand from the brand board, keyed off its paper: the pointer on controls and canvases.
  function loadHandCursor(){
    const img=new Image();img.src='/assets/muse-hand.png';
    img.decode().then(()=>{
      const w=44,h=Math.round(img.height*w/img.width),c=document.createElement('canvas');c.width=w;c.height=h;
      const g=c.getContext('2d');g.drawImage(img,0,0,w,h);
      const px=g.getImageData(0,0,w,h);
      for(let i=0;i<px.data.length;i+=4){const l=(px.data[i]+px.data[i+1]+px.data[i+2])/3;px.data[i+3]=Math.max(0,Math.min(255,(226-l)*6));}
      g.putImageData(px,0,0);
      handCursor=`url(${c.toDataURL()}) ${w-1} 6, crosshair`;
      document.documentElement.style.setProperty('--hand-cursor',handCursor);drawing?.setCursor(handCursor);
    }).catch(()=>{});
  }
  function clearCanvas(){board.clear();canvasUtts=[];nextUtt=1;nodes=[];edges=[];addLine('fin','CANVAS CLEARED');}
  function undoCanvas(){const id=board.undo();if(id){recompute();addLine('fin',id+' UNDONE');}}
  const pngName=()=>'calliope-canvas-'+new Date().toISOString().replace(/[:.]/g,'-')+'.png';
  function download(blob){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=pngName();a.click();setTimeout(()=>URL.revokeObjectURL(a.href),10000);}
  async function copyForAgent(){
    const strokes=board.strokes();
    if(!strokes.length&&!canvasUtts.length){addLine('err','NOTHING TO COPY. DRAW OR SPEAK FIRST.');return;}
    const packet=buildCanvasPacket({elapsedMs:elapsed(),strokes,utterances:canvasUtts});
    try{await navigator.clipboard.writeText(canvasPacketText(packet));
      addLine('fin',`COPIED FOR AGENT: ${packet.nodes.length} NODES, ${packet.edges.length} EDGES, ${packet.utterances.length} SENTENCES. PASTE THE PNG ALONGSIDE.`);
    }catch(err){addLine('err','CLIPBOARD BLOCKED: '+err.message);}
  }
  async function copyPng(){
    const blob=await board.exportPng(); if(!blob){addLine('err','NOTHING DRAWN YET.');return;}
    try{await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);addLine('fin','PNG COPIED.');}
    catch(_){download(blob);addLine('fin','IMAGE CLIPBOARD BLOCKED. PNG DOWNLOADED INSTEAD.');}
  }
  async function downloadPng(){const blob=await board.exportPng();if(blob)download(blob);else addLine('err','NOTHING DRAWN YET.');}
  function setMode(m){
    menuOpen=false;
    if(m===mode||busy)return;
    if(micOn)speechCapture={mode:'website',operation:'recording'};
    mode=m;modeVersion++;
    status=m==='canvas'?'BLANK CANVAS. DRAW AND EXPLAIN OUT LOUD; NAME THINGS BY POINTING: "THIS IS THE API".':
      operation==='live'?'LIVE: SPOKEN TURNS CHANGE THE PREVIEW.':'RECORDING: COPY YOUR WORDS AND MARKS. NO AGENT CALL.';
    if(m==='website'&&operation==='live')resumeLive();
  }
  function resumeLive(){
    const marks=eventsForMode(timeline,'live').filter(e=>e.kind==='stroke').map(e=>e.payload);
    marks.filter(mark=>!deliveries[mark.id]).forEach(deliver);
    if(providerFailed)manualAction='retry';
    else if(!eventsForMode(timeline,'live').some(e=>e.kind==='transcript')&&marks.length)manualAction='sketches';
    if(eventsForMode(timeline,'live').length)requestApply();
  }
  function setOperation(next){
    if(next===operation||busy)return;
    if(micOn)speechCapture={mode:'website',operation:'recording'};
    const flushed=markQueue.flush();
    operation=next;modeVersion++;
    status=next==='live'?'LIVE: SPOKEN TURNS CHANGE THE PREVIEW.':'RECORDING: COPY YOUR WORDS AND MARKS. NO AGENT CALL.';
    const version=modeVersion;
    if(next==='live')void flushed.then(()=>{if(mode==='website'&&operation==='live'&&version===modeVersion)resumeLive();});
  }
  onMount(()=>{
    void trace('session_started',{startedAt});
    board=attachBoard(boardEl,{elapsed,onStroke:onCanvasStroke});
    fetch('/api/config').then(r=>{if(!r.ok)throw new Error('config unavailable');return r.json();}).then(config=>{
      audio=createAudio(eq,{port:config.audioPort,onLine:addLine,elapsed,onEvent:(name,data)=>trace(name,data),onTurnStart:()=>{
        speechCapture={mode,operation};
      },onTurn:turn=>{
        const origin=speechCapture ?? {mode,operation:'recording'};
        speechCapture={mode,operation};
        void trace('turn_final',{mode:origin.mode,operation:origin.operation,turn});
        if(origin.mode==='canvas') addCanvasUtterance(turn,'reson8');
        else if(origin.mode==='website'){
          timeline.push({kind:'transcript',mode:origin.operation,t:turn.startMs,t_end:turn.endMs,text:turn.text,words:turn.words});
          remember('turns',{id:cryptoId(),text:turn.text,startMs:turn.startMs,endMs:turn.endMs,words:turn.words});
          if(origin.operation==='live'&&mode==='website'&&operation==='live'){
            if(!providerFailed)manualAction='';
            requestApply();
          }
        }
      }});
      secure=window.isSecureContext;
      publishEnabled=config.publishEnabled;
    }).catch(()=>addLine('err','AUDIO CONFIG UNAVAILABLE'));
    loadHandCursor();
    const tick=setInterval(()=>now=elapsed(),250);
    const closeMenu=e=>{if(!e.target.closest?.('.surface'))menuOpen=false;};
    document.addEventListener('pointerdown',closeMenu);
    return ()=>{audio?.destroy();clearInterval(tick);document.removeEventListener('pointerdown',closeMenu);};
  });
</script>

<Loader />
<header class="top" class:starting={mode==='start'}>
  <img class="logo" src="/assets/calliope-logo.png" alt="Calliope" />
  {#if mode!=='start'}
    <div class="surface">
      <button type="button" class="surface-btn" aria-haspopup="menu" aria-expanded={menuOpen} onclick={() => menuOpen=!menuOpen}>
        <span class="dot" class:live={mode==='website'&&operation==='live'}></span>{mode==='canvas' ? 'Blank canvas' : 'Live DOM'}<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" /></svg>
      </button>
      {#if menuOpen}
        <div class="menu" role="menu" aria-label="Canvas">
          <button id="modeWebsite" role="menuitemradio" aria-checked={mode==='website'} onclick={() => setMode('website')}><b>Live DOM</b><span>Draw on the imported page.</span></button>
          <button id="modeCanvas" role="menuitemradio" aria-checked={mode==='canvas'} onclick={() => setMode('canvas')}><b>Blank canvas</b><span>Sketch a system and name it out loud.</span></button>
        </div>
      {/if}
    </div>
    {#if mode==='website'}
      <div class="seg" role="radiogroup" aria-label="Operation">
        <button type="button" role="radio" aria-checked={operation==='live'} class:on={operation==='live'} onclick={() => setOperation('live')}>Live</button>
        <button type="button" role="radio" aria-checked={operation==='recording'} class:on={operation==='recording'} onclick={() => setOperation('recording')}>Recording</button>
      </div>
      <form class="url" onsubmit={importUrl}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" /></svg>
        <Input id="url" aria-label="Website URL" placeholder="Paste a public website URL" bind:value={url} />
        <button type="submit" disabled={busy}>Import</button>
      </form>
    {/if}
  {/if}
</header>

{#if mode!=='start'}
  <nav class="rail" aria-label="Tools">
    <span class="tool on" title="Draw on the page"><Icon name="pen" /><span>Draw</span></span>
    {#if mode==='canvas'}<button id="btnUndo" onclick={undoCanvas}><Icon name="undo" /><span>Undo</span></button>{/if}
    <button id="btnClear" onclick={mode==='canvas'?clearCanvas:clearMarks}><Icon name="erase" /><span>Clear</span></button>
  </nav>
{/if}

<main class="work" class:starting={mode==='start'} aria-label="CALLIOPE // SPEAK + DRAW ON THE WEBSITE">
  <section class="startup" hidden={mode!=='start'} aria-label="Choose how to start">
    <img class="startup-muse" src="/assets/muse.png" alt="" />
    <div class="startup-body">
      <p class="kicker">New session</p>
      <h1>What are we working on?</h1>
      <p class="lede">Bring a public web page, or start with nothing but a canvas.</p>
      <div class="startup-options">
        <section class="option">
          <span class="option-n">01</span><h2>Start with a page</h2><p>Paste a public URL. Calliope brings a safe preview into the studio.</p>
          <form onsubmit={importUrl}><Input id="startUrl" aria-label="Website URL" placeholder={DEFAULT_WEBSITE_URL} bind:value={url} /><Button type="submit" variant="primary" disabled={busy}><span class="sc">IMPORT WEBSITE</span></Button></form>
          {#if importError}<p class="startup-error" role="alert">Import failed: {importError}</p>{/if}
        </section>
        <section class="option">
          <span class="option-n">02</span><h2>Start from blank</h2><p>Draw and explain a concept. No website needed.</p>
          <Button id="startBlank" variant="ghost" onclick={() => setMode('canvas')}><span class="sc">START BLANK CANVAS</span></Button>
        </section>
      </div>
    </div>
  </section>

  <section class="frame" hidden={mode==='start'}>
    <div class="chrome"><span class="lights"><i></i><i></i><i></i></span><p id="status" role="status"><span class="sc">{status}</span></p></div>
    <div class="sheet">
      <div id="prevWrap" hidden={mode!=='website'}><iframe id="prev" bind:this={prev} onload={previewLoaded} sandbox="allow-same-origin" referrerpolicy="no-referrer" title="Website preview"></iframe>{#if !imported}<p class="empty-preview">Paste a public URL above to begin.</p>{/if}</div>
      <div id="boardWrap" hidden={mode!=='canvas'}><svg id="board" bind:this={boardEl} role="img" aria-label="Drawing board"></svg></div>
      <div class="voice" class:on={micOn} class:off={!secure}>
        {#if secure}
          <button id="btnMic" class="mic" onclick={toggleMic} aria-label={micOn ? 'Stop listening' : 'Start listening'}><Icon name="mic" size={20} /></button>
        {/if}
        <canvas id="eq" bind:this={eq}></canvas>
        <span class="voice-state">{!secure ? 'Mic needs a secure origin' : micOn ? 'Listening' : 'Tap to speak'}</span>
        {#if mode==='website'&&operation==='live'}
          {#if manualAction}<Button id="btnApply" variant="primary" disabled={busy} onclick={() => apply(true)}><span class="sc">{manualAction==='retry'?'RETRY AGENT':manualAction==='speech-only'?'SEND SPEECH ONLY':'SEND SKETCHES'}</span></Button>{/if}
        {/if}
      </div>
    </div>
  </section>
</main>

{#if mode!=='start'}
  <aside class="panel">
    <h2 class="panel-title">Interpretation</h2>
    <div class="pane">
      {#if mode==='website'}
        <ol class="steps">
          <li class:done={said}>
            <span class="n">1</span><h3>The user said</h3>
            <div class="card">
              {#if said}
                <div class="said"><svg class="voice-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 10v4M9 7v10M13 4v16M17 8v8M21 11v2" /></svg><q>{said.text}</q><time>{clock(said.startMs)}</time></div>
                <dl class="kv"><dt>intent:</dt><dd>{said.intent}</dd>{#if pointedRef}<dt>{pointedRef.word ? `"${pointedRef.word}"` : 'nearest'}:</dt><dd>{pointed?.name}</dd>{/if}</dl>
              {:else}<p class="wait">Waiting for a sentence. Tap the mic and talk while you draw.</p>{/if}
            </div>
          </li>
          <li class:done={pointed}>
            <span class="n">2</span><h3>The user pointed</h3>
            <div class="card pointed">
              {#if pointed}
                {@const b = pointed.bbox}
                <svg class="thumb" viewBox="{b.x - 16} {b.y - 16} {b.width + 32} {b.height + 32}" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><polyline points={pointed.pts.map(p => p.x + ',' + p.y).join(' ')} /></svg>
                <dl class="kv"><dt>{pointed.name}</dt><dd>({pointed.shape})</dd><dt>bbox:</dt><dd>{b.width} × {b.height}</dd></dl>
              {:else}<p class="wait">Circle, underline or point at something on the page.</p>{/if}
            </div>
          </li>
          <li class:done={target}>
            <span class="n">3</span><h3>Target resolved</h3>
            <div class="card">
              {#if target}
                <dl class="kv"><dt>selector:</dt><dd>{target.selector}</dd><dt>tag:</dt><dd>{(target.tag || '—').toUpperCase()}</dd><dt>{target.basis==='shape' ? 'shape:' : 'tip:'}</dt><dd>{target.confidence.toFixed(2)}</dd></dl>
              {:else if pointed}<p class="wait">The mark didn't land on an element. Circle a little closer.</p>
              {:else}<p class="wait">Words and marks meet here, by time.</p>{/if}
            </div>
          </li>
          <li class:done={lastAgent || (said && target)}>
            <span class="n">4</span><h3>Action</h3>
            <div class="card">
              {#if said && target}<span class="pill">{said.intent.toUpperCase()}</span>{/if}
              {#if lastAgent}<p class="agent">{lastAgent}</p>
              {:else if operation==='live'}<p class="wait">Each finished sentence updates the preview by itself.</p>
              {:else}<p class="wait">Recording only. Nothing is sent to the agent.</p>{/if}
            </div>
          </li>
        </ol>
        <section class="block">
          <h2>Timeline</h2>
          <Timeline marks={lanes.marks} utterances={lanes.turns} {now} {fmt} />
        </section>
        {#if operation==='recording'}
          <div class="actions"><Button id="btnCopy" variant="primary" onclick={copyArtifact}><span class="sc">COPY ARTIFACT</span></Button></div>
          <p class="fine"><span class="sc">RECORDING: VOICE AND MARKS ARE KEPT ON ONE CLOCK AS MARKDOWN + JSON. NOTHING IS SENT TO THE AGENT.</span></p>
        {:else}
          <p class="fine"><span class="sc">LIVE: EACH COMPLETED SPOKEN TURN CHANGES THE PREVIEW AUTOMATICALLY.</span>{#if !publishEnabled}{' '}<span class="sc">REVIEW ONLY — CHANGES STAY IN THIS PREVIEW; PUBLISHING IS DISABLED.</span>{/if}</p>
        {/if}
      {:else}
        <ol class="steps"><li class:done={nodes.length}><span class="n">1</span><h3>The diagram so far</h3>
          <div class="card">
            {#each nodes as n (n.id)}<p class="kvline"><b>{n.id}</b> {n.shape} <span class="named">{n.label || '(unnamed)'}</span></p>{/each}
            {#each edges as e (e.id)}<p class="kvline"><b>{e.id}</b> {e.from} → {e.to} <span class="named">{e.label}</span></p>{/each}
            {#if !nodes.length && !edges.length}<p class="wait">Boxes become nodes, lines become edges, and your words name them.</p>{/if}
          </div></li></ol>
        <div class="actions">
          <Button id="btnCopyAgent" variant="primary" onclick={copyForAgent}>Copy for agent</Button>
          <Button id="btnCopyPng" variant="ghost" onclick={copyPng}>Copy PNG</Button>
          <Button id="btnDownloadPng" variant="ghost" onclick={downloadPng} aria-label="Download PNG">↓</Button>
        </div>
        <p class="fine">Copy for agent puts a Mermaid diagram, timed words and JSON on the clipboard. Paste it into any agent with the PNG.</p>
      {/if}

      <details class="log">
        <summary>Session log</summary>
        <button type="button" class="session-item" onclick={() => openDetail({text:sessionId,copyText:sessionId,state:'TRACE ID'})}><span class="session-title">Trace ID</span><span class="session-meta">{sessionId}</span></button>
        <div id="feed" bind:this={feed}>
          {#each rows as row (row.key)}
            <button type="button" class="session-item" onclick={() => openDetail(row)}>
              <span class:err={row.cls==='err'} class="session-title sc">{rowLabel(row)}</span>
              <span class="session-meta">{row.clock}{row.state ? ` · ${row.state}` : ''}{row.copyText ? ' · VIEW FULL TEXT' : ''}</span>
            </button>
          {/each}
        </div>
      </details>
    </div>
  </aside>
{/if}

<dialog bind:this={detailDialog} onclose={() => selectedRow=null} aria-labelledby="detail-title">
  {#if selectedRow}
    <div class="detail-head"><div><span class="t">{selectedRow.clock} · {selectedRow.state || 'SESSION EVENT'}</span><h2 id="detail-title">{rowLabel(selectedRow)}</h2></div><button type="button" onclick={() => detailDialog.close()} aria-label="Close full text">Close</button></div>
    <textarea bind:this={detailField} readonly value={selectedRow.copyText ?? selectedRow.text} aria-label={selectedRow.mark?'Sketch receipt text':selectedRow.copyText?'Full agent message text':'Full session event text'}></textarea>
    <div class="detail-actions"><button type="button" onclick={selectMessage}><span class="sc">SELECT TEXT</span></button>{#if selectedRow.state==='FAILED — CLICK TO RETRY'}<button type="button" onclick={() => {retry(selectedRow);detailDialog.close();}}>Retry mark</button>{/if}</div>
  {/if}
</dialog>
