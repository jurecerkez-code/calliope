<script>
  import { onMount } from 'svelte';
  import Loader from './Loader.svelte';
  import Button from './components/ui/button/Button.svelte';
  import Input from './components/ui/input/Input.svelte';
  import { attachDrawing } from './drawing.js';
  import { buildBundles, canApply, lanes, withoutMarks } from './timeline.js';
  import Lanes from './Lanes.svelte';
  import { createMarkQueue, MARK_SETTLE_DELAY_MS } from './marks.js';
  import { createAudio } from './audio.js';
  import { attachBoard } from './board.js';
  import { buildDiagram, buildCanvasPacket, canvasPacketText, websiteRelations, describeRelation } from './diagram.js';
  import { simulateWords, MS_PER_WORD } from './lib/fusion.js';
  let feed, prev, eq, boardEl;
  let status = $state('CHOOSE HOW TO START.');
  let rows = $state([]), tool = $state('pen'), typed = $state(''), url = $state(''), importError = $state(''), busy = $state(false), micOn = $state(false);
  let imported = $state(false);
  let secure = $state(false), publishEnabled = $state(true);
  // Blank canvas mode: draw and talk to explain a concept; the result is a diagram packet.
  let mode = $state('start'), said = $state(''), nodes = $state([]), edges = $state([]);
  let board = null, canvasUtts = [], nextUtt = 1, typingStart = null;
  const started = Date.now();
  let currentHtml = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:system-ui,sans-serif;padding:48px"><h1>Your website</h1><p>Speak and draw on me to change me.</p><button style="padding:12px 20px">Click me</button></body></html>';
  let timeline = [], deliveries = {}, drawing = null, audio = null, activeStroke = false;
  const elapsed = () => Date.now()-started;
  let lanesData = $state({marks:[],words:[],links:[]});
  function refreshLanes(){lanesData=lanes(timeline);}
  const fmt = ms => {const s=Math.floor(ms/1000);return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');};
  function addLine(cls,text){rows=[...rows,{key:cryptoId(),cls,text,clock:fmt(elapsed())}];scroll();}
  function cryptoId(){const bytes=new Uint8Array(8);crypto.getRandomValues(bytes);return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');}
  function scroll(){requestAnimationFrame(()=>{if(feed)feed.scrollTop=feed.scrollHeight;});}
  function rowText(stroke,state){const p=stroke.pts.at(-1);return `${stroke.summary?.text || stroke.tool.toUpperCase()+' '+p.x+', '+p.y+' · '+p.utc} · ${state}`;}
  function updateRow(mark,state,message){rows=rows.map(row=>{
    if(row.key!==mark.id)return row;
    const agentMessage=message ?? row.agentMessage;
    return {...row,agentMessage,text:agentMessage
      ? `${state} · AGENT SKETCH CONTEXT (FOR APPLY):\n${agentMessage}`
      : `${mark.shape.toUpperCase()} · ${mark.strokes.length} PATH${mark.strokes.length===1?'':'S'} · ${state}`};
  });scroll();}
  async function deliver(mark){
    if(deliveries[mark.id]==='sending'||deliveries[mark.id]==='accepted')return;
    deliveries[mark.id]='sending';updateRow(mark,'SENDING');
    try {
      const response=await fetch('/api/marks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(mark)});
      const ack=await response.json();
      if(!response.ok||ack.status!=='accepted'||ack.id!==mark.id||typeof ack.agent_message!=='string')throw new Error(ack.error||'invalid receipt');
      deliveries[mark.id]='accepted';updateRow(mark,'ACCEPTED',ack.agent_message);
    }catch(err){deliveries[mark.id]='failed';updateRow(mark,'FAILED — CLICK TO RETRY');addLine('err','MARK NOT DELIVERED: '+err.message);}
  }
  function retry(row){if(row.mark && deliveries[row.mark.id]==='failed')deliver(row.mark);}
  const markQueue=createMarkQueue({onSettled:mark=>{
    timeline.push({kind:'stroke',t:mark.t,t_end:mark.t_end,payload:mark});
    refreshLanes();
    rows=rows.filter(row=>!mark.strokes.slice(1).some(stroke=>row.key===stroke.id))
      .map(row=>row.key===mark.id?{...row,mark}:row);
    updateRow(mark,'SENDING');
    const relation=websiteRelations(timeline.filter(e=>e.kind==='stroke').map(e=>e.payload)).find(r=>r.arrow===mark.id);
    if(relation)addLine('why',describeRelation(relation));
    return deliver(mark);
  }});
  function previewHtml(html){
    currentHtml=html;
    // CSP is applied before the untrusted document; no script permission in the iframe sandbox.
    prev.srcdoc=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https:; img-src data: https:; font-src https:; script-src 'none'; frame-src 'none'; form-action 'none'; base-uri https:">`+html;
  }
  function previewLoaded(){drawing=attachDrawing(prev,{
    tool:()=>tool,elapsed,
    onStart:stroke=>{markQueue.hold();activeStroke=true;rows=[...rows,{key:stroke.id,cls:'coord',text:rowText(stroke,'DRAWING'),clock:fmt(elapsed()),stroke}];scroll();},
    onMove:stroke=>{rows=rows.map(row=>row.key===stroke.id?{...row,text:rowText(stroke,'DRAWING')}:row);scroll();},
    onFinish:(stroke,payload,summary)=>{
      stroke.payload=payload;stroke.summary=summary;
      activeStroke=false;
      rows=rows.map(row=>row.key===stroke.id?{...row,text:rowText(stroke,`WAITING UP TO ${MARK_SETTLE_DELAY_MS/1000}S FOR NEXT STROKE`)}:row);
      markQueue.add(payload);
    }
  });}
  function clearMarks(){
    if(busy||activeStroke)return;
    markQueue.clear();drawing?.clear();timeline=withoutMarks(timeline);deliveries={};refreshLanes();
    addLine('fin','MARKS CLEARED');
  }
  async function importUrl(event){
    event.preventDefault();
    if(busy)return;
    busy=true;importError='';status='IMPORTING WEBSITE...';
    try{
      const response=await fetch('/api/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url})});
      const out=await response.json();
      if(!response.ok||out.error)throw new Error(out.error||'HTTP '+response.status);
      await markQueue.flush();
      imported=true;mode='website';drawing?.clear();timeline=[];deliveries={};typed='';
      previewHtml(out.html);
      addLine('fin','IMPORTED '+out.url);status='WEBSITE IMPORTED. DRAW OR SPEAK ON IT.';
    }catch(err){importError=err.message;addLine('err','IMPORT FAILED: '+err.message);status='IMPORT FAILED. PREVIEW UNCHANGED.';}
    finally{busy=false;}
  }
  async function toggleMic(){
    if(micOn){audio?.stop();micOn=false;return;}
    try{await audio.start();micOn=true;}catch(err){addLine('err','MIC FAILED: '+err.message);}
  }
  async function apply(){
    if(busy)return;
    if(activeStroke){addLine('err','FINISH DRAWING BEFORE APPLY');return;}
    busy=true;
    try{
      await markQueue.flush();
      const bundles=buildBundles(timeline), marks=timeline.filter(e=>e.kind==='stroke').map(e=>e.payload);
      if(!typed && !bundles.length){addLine('err','NOTHING TO APPLY. SPEAK, DRAW OR TYPE FIRST.');return;}
      if(!canApply(marks,deliveries)){addLine('err','RETRY FAILED MARKS BEFORE APPLY');return;}
      status='ANTHROPIC IS REASONING...';
      const response=await fetch('/api/apply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bundles:typed?[{t_start:0,t_end:0,transcript:typed,strokes:marks}]:bundles,relations:websiteRelations(marks).slice(0,50),current_html:currentHtml})});
      const out=await response.json();
      if(typeof out.agent_message==='string')addLine('coord',`${response.ok?'SENT':'PREPARED / NOT CONFIRMED SENT'} · FULL AGENT MESSAGE:\n${out.agent_message}`);
      if(!response.ok||out.error)throw new Error(out.error||'HTTP '+response.status);
      if(out.reasoning)addLine('why','AGENT: '+out.reasoning);
      previewHtml(out.html);timeline=[];typed='';addLine('fin','EXECUTED ON PREVIEW. NOTHING PUBLISHED.');status='PREVIEW UPDATED. KEEP TALKING.';
    }catch(err){addLine('err','APPLY FAILED: '+err.message);status='APPLY FAILED. RETRY.';}
    finally{busy=false;}
  }
  async function publish(){
    status='STAGING...';busy=true;
    try{
      const response=await fetch('/api/publish',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({html:currentHtml})});
      const out=await response.json();
      if(!response.ok||out.error)throw new Error(out.error||'HTTP '+response.status);
      addLine('fin','STAGED: '+out.path);
      addLine('fin','DEPLOY WHEN READY: '+out.command);
      status='STAGED. RUN THE COMMAND TO GO LIVE.';
    }catch(err){addLine('err','PUBLISH FAILED: '+err.message);status='STAGING FAILED.';}
    finally{busy=false;}
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
  function onSaidInput(){ if(said.trim()&&typingStart===null) typingStart=elapsed(); if(!said.trim()) typingStart=null; }
  function saySimulated(){
    const text=said.trim(); if(!text) return;
    const endMs=elapsed();
    // typed words count as spoken over the time spent typing, ending now
    const startMs=typingStart!==null&&typingStart<endMs?typingStart:Math.max(0,endMs-text.split(/\s+/).length*MS_PER_WORD);
    addLine('fin',text);
    addCanvasUtterance({text,startMs,endMs,words:simulateWords(text,startMs,endMs)},'typed');
    said='';typingStart=null;
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
  function setMode(m){mode=m;status=m==='canvas'?'BLANK CANVAS. DRAW AND EXPLAIN OUT LOUD; NAME THINGS BY POINTING: "THIS IS THE API".':'SPEAK WHILE YOU DRAW ON THE PAGE. THE AGENT SEES BOTH.';}
  onMount(()=>{
    board=attachBoard(boardEl,{tool:()=>tool,elapsed,onStroke:onCanvasStroke});
    fetch('/api/config').then(r=>{if(!r.ok)throw new Error('config unavailable');return r.json();}).then(config=>{
      audio=createAudio(eq,{port:config.audioPort,onLine:addLine,elapsed,onTurn:turn=>{
        if(mode==='canvas') addCanvasUtterance(turn,'reson8');
        else {timeline.push({kind:'transcript',t:turn.startMs,t_end:turn.endMs,text:turn.text,words:turn.words});refreshLanes();}
      }});
      secure=window.isSecureContext;
      publishEnabled=config.publishEnabled;
    }).catch(()=>addLine('err','AUDIO CONFIG UNAVAILABLE'));
    const laneTimer=setInterval(refreshLanes,500);
    return ()=>{clearInterval(laneTimer);audio?.destroy();};
  });
</script>

<Loader />
<header>
  {#if mode!=='start'}<div class="rec"><span class="dot"></span>REC</div>{/if}
  <div class="brand">CALLIOPE // SPEAK + DRAW {mode==='start'?'':mode==='canvas'?'TO EXPLAIN':'ON THE WEBSITE'}</div>
  {#if mode!=='start'}<div class="modes" role="group" aria-label="Canvas">
    <Button id="modeWebsite" aria-pressed={mode==='website'} variant={mode==='website'?'amber':'default'} onclick={() => setMode('website')}>WEBSITE</Button>
    <Button id="modeCanvas" aria-pressed={mode==='canvas'} variant={mode==='canvas'?'amber':'default'} onclick={() => setMode('canvas')}>BLANK CANVAS</Button>
  </div>{/if}
  <div id="status" role="status">{status}</div>
</header>
<main class:starting={mode==='start'}>
  <section class="startup" hidden={mode!=='start'} aria-label="Choose how to start">
    <div class="startup-heading"><span>NEW SESSION / 01</span><h1>WHAT ARE WE WORKING ON?</h1><p>BRING A PUBLIC WEB PAGE, OR START WITH NOTHING BUT A CANVAS.</p></div>
    <div class="startup-options">
      <section class="startup-option"><span class="option-number">01 / WEBSITE</span><h2>START WITH A PAGE</h2><p>PASTE A PUBLIC URL. WE'LL BRING A SAFE PREVIEW INTO THE STUDIO.</p>
        <form onsubmit={importUrl}><Input id="startUrl" aria-label="Website URL" placeholder="https://example.com" bind:value={url} /><Button type="submit" variant="amber" disabled={busy}>IMPORT WEBSITE ↗</Button></form>
        {#if importError}<p class="startup-error" role="alert">IMPORT FAILED: {importError}</p>{/if}
      </section>
      <section class="startup-option"><span class="option-number">02 / CANVAS</span><h2>START FROM BLANK</h2><p>DRAW AND EXPLAIN A CONCEPT. NO WEBSITE NEEDED.</p>
        <Button id="startBlank" onclick={() => setMode('canvas')}>START BLANK CANVAS ↗</Button>
      </section>
    </div>
  </section>
  <section class="pane" hidden={mode==='start'}>
    <h3>TRANSCRIPT + SKETCH LOG // ONE CLOCK</h3>
    <div id="feed" bind:this={feed}>
      {#each rows as row (row.key)}
        {#if row.stroke}
          <button type="button" class="coord" onclick={() => retry(row)}>{row.text}</button>
        {:else}
          <div><span class="t">[{row.clock}] </span><span class={row.cls}>{row.text}</span></div>
        {/if}
      {/each}
    </div>
    <Lanes data={lanesData} />
    <div id="eqWrap"><div id="eqLabel">VOICE LEVEL</div><canvas id="eq" bind:this={eq}></canvas></div>
    <div class="row">
      <Button id="btnMic" disabled={!secure} variant={micOn?'recording':'default'} onclick={toggleMic}>{secure?(micOn?'MIC OFF':'MIC ON'):'MIC: HTTPS REQUIRED'}</Button>
      {#if mode==='canvas'}
        <Button id="btnClear" variant="amber" onclick={clearCanvas}>CLEAR CANVAS</Button>
        <Button id="btnUndo" onclick={undoCanvas}>UNDO</Button>
      {:else}
        <Button id="btnClear" variant="amber" onclick={clearMarks}>CLEAR MARKS</Button>
      {/if}
      <Button id="btnTool" onclick={() => tool=tool==='pen'?'highlighter':'pen'}>TOOL: {tool.toUpperCase()}</Button>
    </div>
    {#if mode==='canvas'}
      <div class="row"><Input id="said" aria-label="Type what you would say" placeholder="...or type what you would say" bind:value={said} oninput={onSaidInput} onkeydown={e => {if(e.key==='Enter'){e.preventDefault();saySimulated();}}} /><Button id="btnSay" onclick={saySimulated}>SAY</Button></div>
      <div class="diagram" aria-label="Diagram so far">
        {#each nodes as n (n.id)}<div><span class="t">{n.id}</span> {n.shape} <span class="fin">{n.label || '(unnamed)'}</span></div>{/each}
        {#each edges as e (e.id)}<div><span class="t">{e.id}</span> {e.from} → {e.to} <span class="why">{e.label}</span></div>{/each}
        {#if !nodes.length && !edges.length}<div class="t">DRAW BOXES OR CIRCLES, CONNECT THEM WITH LINES, AND NAME THEM OUT LOUD.</div>{/if}
      </div>
      <div class="row"><Button id="btnCopyAgent" variant="amber" onclick={copyForAgent}>COPY FOR AGENT</Button><Button id="btnCopyPng" onclick={copyPng}>COPY PNG</Button><Button id="btnDownloadPng" onclick={downloadPng}>DOWNLOAD PNG</Button></div>
      <div class="notice">COPY FOR AGENT = MERMAID DIAGRAM + TIMED WORDS + JSON. PASTE INTO ANY AGENT WITH THE PNG.</div>
    {:else}
      <div class="row"><Input id="instr" aria-label="Instruction" placeholder="...or type an instruction" bind:value={typed} /></div>
      <div class="row"><Button id="btnApply" variant="amber" disabled={busy} onclick={apply}>APPLY ▸</Button><Button id="btnPublish" disabled={busy||!publishEnabled} onclick={publish}>{publishEnabled?'PUBLISH':'PUBLISH DISABLED'}</Button></div>
      <div class="notice">{publishEnabled?'APPLY = PREVIEW ONLY. PUBLISH STAGES LOCALLY; DEPLOY IS A SEPARATE COMMAND.':'REVIEW ONLY — PUBLISH IS DISABLED.'} MIC NEEDS A SECURE ORIGIN AND REACHABLE AUDIO RELAY.</div>
    {/if}
  </section>
  <section class="pane" hidden={mode!=='canvas'}><h3>BLANK CANVAS // DRAW AND EXPLAIN</h3><div id="boardWrap"><svg id="board" bind:this={boardEl} role="img" aria-label="Drawing board"></svg></div></section>
  <section class="pane" hidden={mode!=='website'}><h3>LIVE WEBSITE // DRAW DIRECTLY ON IT</h3><form class="row" onsubmit={importUrl}><Input id="url" aria-label="Website URL" placeholder="Paste a public website URL" bind:value={url} /><Button type="submit" disabled={busy}>IMPORT URL</Button></form><div id="prevWrap"><iframe id="prev" bind:this={prev} onload={previewLoaded} sandbox="allow-same-origin" referrerpolicy="no-referrer" title="Website preview"></iframe>{#if !imported}<p class="empty-preview">PASTE A PUBLIC URL ABOVE TO BEGIN.</p>{/if}</div></section>
</main>
