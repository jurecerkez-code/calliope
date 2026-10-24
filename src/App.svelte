<script>
  import { onMount } from 'svelte';
  import Loader from './Loader.svelte';
  import Button from './components/ui/button/Button.svelte';
  import Asterisk from './components/brand/Asterisk.svelte';
  import Timeline from './components/Timeline.svelte';
  import Icon from './components/brand/Icon.svelte';
  import Input from './components/ui/input/Input.svelte';
  import { attachDrawing } from './drawing.js';
  import { buildBundles, canApply, withoutMarks } from './timeline.js';
  import { createMarkQueue, MARK_SETTLE_DELAY_MS } from './marks.js';
  import { createAudio } from './audio.js';
  import { attachBoard } from './board.js';
  import { buildDiagram, buildCanvasPacket, canvasPacketText, websiteRelations, describeRelation } from './diagram.js';
  import { simulateWords, MS_PER_WORD, fuse } from './lib/fusion.js';
  import { buildArtifact, createLiveQueue, eventsForMode, awaitingMoveArrow, nextLiveEvents, speechOnlyEvents } from './modes.js';
  const DEFAULT_WEBSITE_URL = 'https://www.meetjamie.ai/';
  let feed, prev, eq, boardEl, detailDialog;
  let handCursor = 'crosshair', now = $state(0), page = $state('preview');
  let marks = $state([]), turns = $state([]), interpretationHistory = $state([]), tab = $state('interpretation');
  let note = $state(''), museOn = $state(false), museTimer = 0, applies = 0;
  let interim = $state(''), audioState = $state('idle');
  const MARGINALIA = ['good. keep it.', 'noted.', 'yes, that one.', 'better.'];
  let detailField = $state(null);
  let selectedRow = $state(null);
  let status = $state('CHOOSE HOW TO START.');
  let manualAction = $state('');
  let rows = $state([]), url = $state(''), importError = $state(''), busy = $state(false), micOn = $state(false);
  let imported = $state(false);
  let secure = $state(false), publishEnabled = $state(true);
  // Blank canvas mode: draw and talk to explain a concept; the result is a diagram packet.
  let mode = $state('start'), operation = $state('live'), nodes = $state([]), edges = $state([]);
  let board = null, canvasUtts = [], nextUtt = 1, modeVersion = 0, speechCapture = null, drawing = null, audio = null;
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const sessionId = cryptoId();
  let traceQueue = Promise.resolve(), traceWarned = false, traceFailed = false;
  let currentHtml = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:system-ui,sans-serif;padding:48px"><h1>Your website</h1><p>Speak and draw on me to change me.</p><button style="padding:12px 20px">Click me</button></body></html>';
  let timeline = [], deliveries = {}, pending = {}, strokeModes = new Map(), activeStroke = false, strokeWaiters = [], providerFailed = false;
  const elapsed = () => Date.now()-started;
  const fmt = ms => {const s=Math.floor(ms/1000);return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');};
  const clock = ms => fmt(ms)+'.'+String(Math.max(0,Math.round(ms))%1000).padStart(3,'0');
  const fused = $derived(fuse(turns.filter(t => t.mode === 'website'), marks));
  const currentInterpretations = $derived(fused.map(u => ({...u, mark: marks.find(m => m.id === u.target?.strokeId) || null})));
  const interpretations = $derived([...interpretationHistory, ...currentInterpretations]);
  const events = $derived.by(() => {
    const ev = [];
    for (const m of marks) ev.push({t:m.startMs, kind:'drawing', title:'Drawing', detail:`${m.name} (${m.shape})`});
    for (const u of fused) {
      ev.push({t:u.startMs, kind:'speech', title:'Speech', detail:`"${u.text}"`});
      for (const r of u.references.filter(r => r.strokeId)) ev.push({t:r.atMs, kind:'reference', title:'Reference', detail:`"${r.word || '…'}" → ${marks.find(m => m.id === r.strokeId)?.targets[0]?.selector || r.strokeId}`});
      if (u.target) {ev.push({t:u.endMs,kind:'target',title:'Target',detail:u.target.selector || 'marked area'});ev.push({t:u.endMs+1,kind:'action',title:'Action',detail:u.intent});}
    }
    return ev.sort((a,b) => b.t-a.t);
  });
  const problems = $derived(rows.filter(row=>row.cls==='err'));
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
    void trace('mark_captured',{mode:markMode,mark});
    for(const stroke of mark.strokes)strokeModes.delete(stroke.id);
    timeline.push({kind:'stroke',mode:markMode,t:mark.t,t_end:mark.t_end,payload:mark});
    const stroke=mark.strokes[0], b=stroke.bbox;
    marks=[...marks,{id:mark.id,name:'stroke_'+String(marks.length+1).padStart(2,'0'),startMs:mark.t,endMs:mark.t_end,shape:mark.shape,bbox:b,
      anchor:{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)},targets:stroke.enclosed_element?[{selector:stroke.enclosed_element,label:stroke.enclosed_element,confidence:1}]:[],
      pts:stroke.pts.map(p=>({x:p.x,y:p.y}))}];
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
  function previewLoaded(){if(!prev)return;page=(prev.contentDocument?.title||'preview').split(/[|·—-]/)[0].trim().toLowerCase()||'preview';drawing=attachDrawing(prev,{
    elapsed,cursor:handCursor,
    onStart:stroke=>{if(strokeModes.size&&[...strokeModes.values()].some(m=>m!==operation))void markQueue.flush();markQueue.hold();strokeModes.set(stroke.id,operation);activeStroke=true;rows=[...rows,{key:stroke.id,cls:'coord',text:rowText(stroke,'DRAWING'),clock:fmt(elapsed()),stroke}];scroll();},
    onMove:stroke=>{rows=rows.map(row=>row.key===stroke.id?{...row,text:rowText(stroke,'DRAWING')}:row);scroll();},
    onFinish:(stroke,payload,summary)=>{
      stroke.payload=payload;stroke.summary=summary;
      note='';
      activeStroke=false;
      rows=rows.map(row=>row.key===stroke.id?{...row,text:rowText(stroke,`WAITING UP TO ${MARK_SETTLE_DELAY_MS/1000}S FOR NEXT STROKE`)}:row);
      markQueue.add(payload);
      strokeWaiters.splice(0).forEach(resolve=>resolve());
    }
  });}
  function clearMarks(){
    if(busy||activeStroke)return;
    markQueue.clear();drawing?.clear();timeline=withoutMarks(timeline);deliveries={};pending={};strokeModes.clear();marks=[];note='';
    if(manualAction==='sketches')manualAction='';
    addLine('fin','MARKS CLEARED');
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
      imported=true;mode='website';modeVersion++;drawing?.clear();timeline=[];deliveries={};pending={};strokeModes.clear();manualAction='';providerFailed=false;marks=[];turns=[];interpretationHistory=[];
      previewHtml(out.html);void trace('preview_updated',{source:'import',url:out.url,elapsedMs:elapsed()});
      addLine('fin','IMPORTED '+out.url);status='WEBSITE IMPORTED. DRAW OR SPEAK ON IT.';
    }catch(err){importError=err.message;addLine('err','IMPORT FAILED: '+err.message);status='IMPORT FAILED. PREVIEW UNCHANGED.';}
    finally{busy=false;}
  }
  async function toggleMic(){
    if(micOn){audio?.stop();micOn=false;speechCapture=null;interim='';audioState='idle';return;}
    try{await audio.start();micOn=true;audioState='connecting';speechCapture={mode,operation};}catch(err){audioState='error';void trace('mic_error',{error:err.message});addLine('err','MIC FAILED: '+err.message);}
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
      const selectedMarks=sent.filter(e=>e.kind==='stroke').map(e=>e.payload);
      const turn=sent.find(e=>e.kind==='transcript');
      const bundle=turn ? buildBundles(sent).find(b=>b.transcript===turn.text) : buildBundles(sent)[0];
      const bundles=bundle?[{...bundle,strokes:selectedMarks}]:[];
      if(!bundles.length){status='NOTHING NEW FOR THE AGENT.';return;}
      const relations=allRelations.filter(r=>selectedMarks.some(mark=>mark.strokes.some(s=>s.id===r.from?.stroke))&&
        selectedMarks.some(mark=>mark.id===r.arrow)).slice(0,50);
      if(!force&&!relations.some(r=>r.kind==='move'||r.kind==='link')&&awaitingMoveArrow(sent,relations)){
        void trace('apply_blocked',{reason:'waiting_for_arrow',turn:turn?.text,mark_ids:selectedMarks.map(mark=>mark.id)});
        manualAction='speech-only';status='DRAW AN ARROW TO COMPLETE THE MOVE, OR SEND SPEECH ONLY.';return;
      }
      await Promise.all(selectedMarks.map(mark=>pending[mark.id]));
      if(mode!=='website'||operation!=='live'||modeVersion!==runModeVersion)return;
      if(!canApply(selectedMarks,deliveries)){void trace('apply_blocked',{reason:'marks_not_accepted',mark_ids:selectedMarks.map(mark=>mark.id)});addLine('err','RETRY FAILED MARKS BEFORE APPLY');return;}
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
      if(out.reasoning)addLine('why','AGENT: '+out.reasoning);
      interpretationHistory=[...interpretationHistory,...currentInterpretations];
      previewHtml(out.html);void trace('preview_updated',{source:'agent',request_id:requestId,elapsedMs:elapsed()});timeline=timeline.filter(e=>!sent.includes(e));
      marks=marks.filter(mark=>!sent.some(e=>e.kind==='stroke'&&e.payload.id===mark.id));turns=turns.filter(turn=>!sent.some(e=>e.kind==='transcript'&&e.text===turn.text));
      note=MARGINALIA[applies++%MARGINALIA.length];summonMuse();
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
  function summonMuse(){museOn=true;clearTimeout(museTimer);museTimer=setTimeout(()=>museOn=false,4200);}
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
    const n=d.nodes.find(x=>x.id===id); if(n) return `${n.id} ${n.shape}${n.label?' "'+n.label+'"':''}`;
    const e=d.edges.find(x=>x.id===id); if(e) return `${e.id} ${e.from} → ${e.to}${e.label?' "'+e.label+'"':''}`;
    return id;
  };
  function onCanvasStroke(stroke){
    void trace('canvas_stroke',{stroke});
    const d=recompute();
    const n=d.nodes.find(x=>x.strokeId===stroke.id), e=d.edges.find(x=>x.strokeId===stroke.id||x.arrowhead===stroke.id);
    const a=d.annotations.find(x=>x.strokeId===stroke.id);
    addLine('st',`${stroke.id} → `+(n?describe(d,n.id):e?describe(d,e.id)+(e.arrowhead===stroke.id?' (ARROWHEAD)':''):a?`${a.kind.toUpperCase()}${a.node?' NEAR '+a.node:''}`:'MARK'));
  }
  function timedUtterance(turn,source){
    let {text,startMs,endMs,words}=turn;
    if(startMs==null){ // no Reson8 timestamps: assume it was just said, at a normal pace
      endMs=elapsed();startMs=Math.max(0,endMs-text.split(/\s+/).length*MS_PER_WORD);words=[];
    }
    if(!words?.length) words=simulateWords(text,startMs,endMs);
    return {id:'U'+nextUtt++,text,startMs,endMs,words,final:true,source};
  }
  function addCanvasUtterance(turn,source){
    const u=timedUtterance(turn,source);
    canvasUtts=[...canvasUtts,u];
    const d=recompute(), fu=d.utterances.find(x=>x.id===u.id);
    const refs=(fu?.references||[]).map(r=>({word:r.word,selector:r.element?describe(d,r.element):'nothing drawn nearby',confidence:''}));
    turns=[...turns,{...u,mode:'canvas',refs}];
  }
  function clearCanvas(){board.clear();canvasUtts=[];nextUtt=1;nodes=[];edges=[];addLine('fin','CANVAS CLEARED');}
  function undoCanvas(){const id=board.undo();if(id){recompute();addLine('fin',id+' UNDONE');}}
  const pngName=()=>'calliope-canvas-'+new Date().toISOString().replace(/[:.]/g,'-')+'.png';
  function download(blob){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=pngName();a.click();setTimeout(()=>URL.revokeObjectURL(a.href),10000);}
  async function copyForAgent(){
    const strokes=board.strokes();
    if(!strokes.length&&!canvasUtts.length){addLine('err','Nothing to copy. Draw or speak first.');return;}
    const packet=buildCanvasPacket({elapsedMs:elapsed(),strokes,utterances:canvasUtts});
    try{await navigator.clipboard.writeText(canvasPacketText(packet));
      addLine('fin',`Copied: ${packet.nodes.length} nodes, ${packet.edges.length} edges, ${packet.utterances.length} sentences. Paste the PNG alongside.`);
    }catch(err){addLine('err','Clipboard blocked: '+err.message);}
  }
  async function copyPng(){
    const blob=await board.exportPng(); if(!blob){addLine('err','Nothing drawn yet.');return;}
    try{await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);addLine('fin','PNG copied.');}
    catch(_){download(blob);addLine('fin','Image clipboard blocked. PNG downloaded instead.');}
  }
  async function downloadPng(){const blob=await board.exportPng();if(blob)download(blob);else addLine('err','Nothing drawn yet.');}

  // The engraved hand from the brand board, keyed off its paper: the pointer everywhere, drawing included.
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
  function setMode(m){
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
    loadHandCursor();
    const tick=setInterval(()=>now=elapsed(),250);
    fetch('/api/config').then(r=>{if(!r.ok)throw new Error('config unavailable');return r.json();}).then(config=>{
      audio=createAudio(eq,{port:config.audioPort,onLine:(cls,text)=>{
        if(/LINK UP/.test(text))audioState='live';
        if(cls==='err')audioState='error';
        if(cls==='inter'){interim=text==='(listening)'?'':text;}else addLine(cls,text);
      },elapsed,onEvent:(name,data)=>trace(name,data),onTurnStart:()=>{
        speechCapture={mode,operation};
      },onTurn:turn=>{
        interim='';
        const origin=speechCapture ?? {mode,operation:'recording'};
        speechCapture={mode,operation};
        void trace('turn_final',{mode:origin.mode,operation:origin.operation,turn});
        if(origin.mode==='canvas') addCanvasUtterance(turn,'reson8');
        else if(origin.mode==='website'){
          timeline.push({kind:'transcript',mode:origin.operation,t:turn.startMs,t_end:turn.endMs,text:turn.text,words:turn.words});
          turns=[...turns,{...timedUtterance(turn,'reson8'),mode:'website'}];
          if(origin.operation==='live'&&mode==='website'&&operation==='live'){
            if(!providerFailed)manualAction='';
            requestApply();
          }
        }
      }});
      secure=window.isSecureContext;
      publishEnabled=config.publishEnabled;
    }).catch(()=>addLine('err','AUDIO CONFIG UNAVAILABLE'));
    return ()=>{audio?.destroy();clearTimeout(museTimer);clearInterval(tick);};
  });
</script>

<Loader />
<header class="top">
  <img class="logo" src="/assets/calliope-logo.png" alt="Calliope" />
  {#if mode!=='start'}<label class="mode"><span class="live-dot"></span>
    <select aria-label="Surface" value={mode} onchange={e => setMode(e.currentTarget.value)}>
      <option value="website">Live DOM</option><option value="canvas">Blank canvas</option>
    </select>
  </label>{/if}
  {#if mode==='website'}<div class="operations" role="radiogroup" aria-label="Operation">
    <button type="button" role="radio" aria-checked={operation==='recording'} class:on={operation==='recording'} onclick={() => setOperation('recording')}>Recording</button>
    <button type="button" role="radio" aria-checked={operation==='live'} class:on={operation==='live'} onclick={() => setOperation('live')}>Live</button>
  </div>{/if}
  <div class="url"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" /></svg>{mode==='start'?'a muse for machines':mode==='canvas' ? 'blank canvas' : page}</div>
  <div class="listen" class:on={micOn}>
    <canvas id="eq" bind:this={eq}></canvas>
    <button id="btnMic" class="mic" disabled={!secure||mode==='start'} onclick={toggleMic} aria-label={micOn ? 'Stop listening' : 'Start listening'} title={secure ? '' : 'The mic needs a secure origin'}><Icon name="mic" size={20} /></button>
  </div>
</header>

<nav class="rail" aria-label="Tools" hidden={mode==='start'}>
  <span class="tool-label"><Icon name="pen" /><span>Draw</span></span>
  {#if mode==='canvas'}<button id="btnUndo" onclick={undoCanvas}><Icon name="undo" /><span>Undo</span></button>{/if}
  <button id="btnClear" onclick={mode==='canvas'?clearCanvas:clearMarks}><Icon name="erase" /><span>Clear</span></button>
</nav>

<section class="startup" hidden={mode!=='start'} aria-label="Choose how to start">
  <div class="startup-heading"><span>NEW SESSION / 01</span><h1>WHAT ARE WE WORKING ON?</h1><p>BRING A PUBLIC WEB PAGE, OR START WITH NOTHING BUT A CANVAS.</p></div>
  <div class="startup-options">
    <section class="startup-option"><span class="option-number">01 / WEBSITE</span><h2>START WITH A PAGE</h2><p>PASTE A PUBLIC URL. WE'LL BRING A SAFE PREVIEW INTO THE STUDIO.</p>
      <form onsubmit={importUrl}><Input id="startUrl" aria-label="Website URL" placeholder={DEFAULT_WEBSITE_URL} bind:value={url} /><Button type="submit" variant="primary" disabled={busy}>IMPORT WEBSITE ↗</Button></form>
      {#if importError}<p class="startup-error" role="alert">IMPORT FAILED: {importError}</p>{/if}
    </section>
    <section class="startup-option"><span class="option-number">02 / CANVAS</span><h2>START FROM BLANK</h2><p>DRAW AND EXPLAIN A CONCEPT. NO WEBSITE NEEDED.</p><Button id="startBlank" onclick={() => setMode('canvas')}>START BLANK CANVAS ↗</Button></section>
  </div>
</section>
<main class="work" hidden={mode==='start'} aria-label="CALLIOPE // SPEAK + DRAW ON THE WEBSITE">
  <section class="frame">
    <div class="chrome"><span class="lights"><i></i><i></i><i></i></span><span class="addr">{mode==='canvas' ? 'blank canvas' : page}</span><span class="status" role="status" id="status">{status}</span></div>
    <div class="sheet">
      <div id="prevWrap" hidden={mode==='canvas'}><iframe id="prev" bind:this={prev} onload={previewLoaded} sandbox="allow-same-origin" referrerpolicy="no-referrer" title="Website preview"></iframe></div>
      <div id="boardWrap" hidden={mode!=='canvas'}><svg id="board" bind:this={boardEl} role="img" aria-label="Drawing board"></svg></div>
      {#if note}<p class="margin-note" aria-live="polite">{note}</p>{/if}
      {#if museOn}<img class="muse" src="/assets/muse-bust.png" alt="" />{/if}
    </div>
  </section>

  <footer class="foot">
    <span class="conn {audioState}"><i></i>{audioState==='live' ? 'Connected to Reson8' : audioState==='connecting' ? 'Connecting to Reson8…' : audioState==='error' ? 'Reson8 unavailable' : secure ? 'Reson8 ready' : 'Mic needs a secure origin'}</span>
    <span class="session">Session {fmt(now)}</span>
  </footer>
</main>

<aside class="panel" hidden={mode==='start'}>
  <div class="tabs" role="tablist" aria-label="Panel">
    {#each (mode==='website' ? [['interpretation','Interpretation'],['timeline','Timeline']] : [['interpretation','Interpretation']]) as [k, label]}
      <button role="tab" aria-selected={tab===k} onclick={() => tab=k}>{label}{#if k==='interpretation' && problems.length}<i class="alert"></i>{/if}</button>
    {/each}
  </div>

  <div class="pane">
    {#if mode==='website'}<form class="import-row" onsubmit={importUrl}><Input id="url" aria-label="Website URL" placeholder="Paste a public website URL" bind:value={url} /><Button type="submit" disabled={busy}>Import URL</Button></form>{/if}
    <div class="session-feed" id="feed" bind:this={feed}>
      <button type="button" class="session-item" onclick={() => openDetail({text:sessionId,copyText:sessionId,state:'TRACE ID'})}>TRACE ID: {sessionId}</button>
      {#each rows as row (row.key)}
        <button type="button" class="session-item" onclick={() => openDetail(row)}>
          <span class:err={row.cls==='err'} class="session-title">{rowLabel(row)}</span>
          <span class="session-meta">{row.clock}{row.state ? ` · ${row.state}` : ''}{row.copyText ? ' · VIEW FULL TEXT' : ''}</span>
        </button>
      {/each}
    </div>
    {#if tab==='interpretation'}
      {#if mode==='website'}
        <ol class="interpretations">
          {#each interpretations as u (u.id)}
            <li class="card">
              <div class="said"><span class="voice"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 10v4M9 7v10M13 4v16M17 8v8M21 11v2" /></svg></span><q>{u.text}</q><time>{clock(u.startMs)}</time></div>
              <dl class="kv"><dt>Intent:</dt><dd>{u.intent}</dd>
                {#if u.mark}<dt>Pointed:</dt><dd>{u.mark.name} ({u.mark.shape})</dd>{/if}
                {#if u.target?.selector}<dt>Target:</dt><dd>{u.target.selector}</dd><dt>Confidence:</dt><dd>{u.target.confidence.toFixed(2)}</dd>{/if}
              </dl>
              {#if u.target?.selector}<p class="instr">{u.instruction}</p>{/if}
            </li>
          {:else}<li class="wait">Waiting for a sentence. Start listening to speak.</li>{/each}
          {#if interim}<li class="wait"><i>{interim}</i></li>{/if}
        </ol>
      {:else}
        <ol class="steps"><li class:done={nodes.length}><span class="n">1</span><h3>The diagram so far</h3>
          <div class="card">
            {#each nodes as n (n.id)}<p class="kvline"><b>{n.id}</b> {n.shape} <span class="named">{n.label || '(unnamed)'}</span></p>{/each}
            {#each edges as e (e.id)}<p class="kvline"><b>{e.id}</b> {e.from} → {e.to} <span class="named">{e.label}</span></p>{/each}
            {#if !nodes.length && !edges.length}<p class="wait">Boxes become nodes, lines become edges, and your words name them.</p>{/if}
          </div></li></ol>
      {/if}

    {:else if tab==='timeline'}
      <Timeline {marks} utterances={fused} {now} {fmt} />
      <h2 class="sub">Recent events</h2>
      <ul class="events">
        {#each events as e, i (i)}<li class="ev {e.kind}"><i></i><time>{clock(e.t)}</time><div><b>{e.title}</b><span>{e.detail}</span></div></li>
        {:else}<li class="wait">Nothing yet. Draw on the page and say what should change.</li>{/each}
      </ul>
    {/if}
  </div>

  <div class="compose">
    {#if mode==='website'}
      <div class="actions">
        {#if operation==='live'}
          {#if manualAction}<Button id="btnApply" variant="primary" disabled={busy} onclick={() => apply(true)}>{manualAction==='retry'?'RETRY AGENT':manualAction==='speech-only'?'SEND SPEECH ONLY':'SEND SKETCHES'} <Asterisk size={13} weight={2.6} /></Button>{/if}
          <p class="notice">LIVE: EACH COMPLETED SPOKEN TURN CHANGES THE PREVIEW AUTOMATICALLY. SKETCHES WITHOUT SPEECH CAN BE SENT SEPARATELY. {#if !publishEnabled}REVIEW ONLY — CHANGES STAY IN THIS PREVIEW; PUBLISHING IS DISABLED.{/if}</p>
        {:else}<Button id="btnCopy" variant="primary" onclick={copyArtifact}>COPY ARTIFACT</Button><p class="notice">RECORDING: VOICE AND MARKS STAY ON ONE CLOCK. NOTHING IS SENT TO THE AGENT.</p>{/if}
      </div>
    {:else}
      <div class="actions">
        <Button id="btnCopyAgent" variant="primary" onclick={copyForAgent}>Copy for agent</Button>
        <Button id="btnCopyPng" variant="ghost" onclick={copyPng}>Copy PNG</Button>
        <Button id="btnDownloadPng" variant="ghost" onclick={downloadPng} aria-label="Download PNG">↓</Button>
      </div>
    {/if}
  </div>
</aside>
<dialog bind:this={detailDialog} onclose={() => selectedRow=null} aria-labelledby="detail-title">
  {#if selectedRow}
    <div class="detail-head"><div><span class="t">{selectedRow.clock} · {selectedRow.state || 'SESSION EVENT'}</span><h2 id="detail-title">{rowLabel(selectedRow)}</h2></div><button type="button" onclick={() => detailDialog.close()} aria-label="Close full text">CLOSE</button></div>
    <textarea bind:this={detailField} readonly value={selectedRow.copyText ?? selectedRow.text} aria-label={selectedRow.mark?'Sketch receipt text':selectedRow.copyText?'Full agent message text':'Full session event text'}></textarea>
    <div class="detail-actions"><button type="button" onclick={selectMessage}>SELECT TEXT</button>{#if selectedRow.state==='FAILED — CLICK TO RETRY'}<button type="button" onclick={() => {retry(selectedRow);detailDialog.close();}}>RETRY MARK</button>{/if}</div>
  {/if}
</dialog>
