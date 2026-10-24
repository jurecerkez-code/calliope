<script>
  import { onMount } from 'svelte';
  import Loader from './Loader.svelte';
  import Button from './components/ui/button/Button.svelte';
  import Input from './components/ui/input/Input.svelte';
  import Asterisk from './components/brand/Asterisk.svelte';
  import Timeline from './components/Timeline.svelte';
  import Icon from './components/brand/Icon.svelte';
  import { attachDrawing } from './drawing.js';
  import { buildBundles, canApply } from './timeline.js';
  import { createAudio } from './audio.js';
  import { attachBoard } from './board.js';
  import { buildDiagram, buildCanvasPacket, canvasPacketText, websiteRelations, describeRelation } from './diagram.js';
  import { simulateWords, MS_PER_WORD, fuse } from '../extension/lib/fusion.js';
  let feed, prev, eq, boardEl;
  const STATUS = {website:'Draw where. Speak why.', canvas:'Draw the system. Name it out loud.'};
  let status = $state(STATUS.website);
  let tool = $state('pen'), typed = $state(''), busy = $state(false), micOn = $state(false);
  let secure = $state(false);
  // Blank canvas mode: draw and talk to explain a concept; the result is a diagram packet.
  let mode = $state('website'), said = $state(''), nodes = $state([]), edges = $state([]);
  // The panel is one stream: spoken (or typed) turns, agent replies and problems, in order.
  let turns = $state([]), interim = $state(''), marks = $state([]), stream = $state([]);
  let note = $state(''), museOn = $state(false), copied = $state(false), tab = $state('interpretation'), now = $state(0), page = $state('preview');
  let audioState = $state('idle'), handCursor = 'crosshair';
  let board = null, canvasUtts = [], nextUtt = 1, typingStart = null, museTimer = 0, applies = 0;
  let started = Date.now();
  let currentHtml = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:system-ui,sans-serif;padding:48px"><h1>Your website</h1><p>Speak and draw on me to change me.</p><button style="padding:12px 20px">Click me</button></body></html>';
  let timeline = [], deliveries = {}, drawing = null, audio = null;
  const elapsed = () => Date.now()-started;
  const fmt = ms => {const s=Math.floor(Math.max(0,ms)/1000);return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');};
  const clock = ms => fmt(ms)+'.'+String(Math.max(0,Math.round(ms))%1000).padStart(3,'0');
  // Dry, short, never more than one per apply.
  const MARGINALIA = ['good. keep it.', 'noted.', 'yes, that one.', 'better.'];

  // Website fusion: each spoken "this" / "that" / "here" bound to the mark drawn nearest in time.
  const fused = $derived(fuse(turns.filter(t => t.mode === 'website'), marks));
  const lastFused = $derived([...fused].reverse().find(u => u.target) || fused.at(-1) || null);
  const nameOf = id => marks.find(m => m.id === id)?.name || id;
  const markOf = id => marks.find(m => m.id === id);
  // a target only counts when the mark actually landed on an element
  const hit = $derived(lastFused?.target?.selector ? lastFused.target : null);
  const lastRef = $derived(lastFused?.references.find(r => r.strokeId === lastFused.target?.strokeId) || null);
  const lastMark = $derived(lastFused?.target ? markOf(lastFused.target.strokeId) : marks.at(-1));
  // Everything that happened, newest first: what was drawn, said, pointed at, resolved, proposed.
  const events = $derived.by(() => {
    const ev = [];
    for (const m of marks) ev.push({t:m.startMs, kind:'drawing', title:'Drawing', detail:`${m.name} (${m.shape})`});
    for (const u of fused) {
      ev.push({t:u.startMs, kind:'speech', title:'Speech', detail:`"${u.text}"`});
      for (const r of u.references.filter(r => r.strokeId)) ev.push({t:r.atMs, kind:'reference', title:'Reference', detail:`"${r.word || '…'}" → ${markOf(r.strokeId)?.targets[0]?.selector || nameOf(r.strokeId)}`});
      if (u.target) { ev.push({t:u.endMs, kind:'target', title:'Target', detail:u.target.selector || 'marked area'}); ev.push({t:u.endMs+1, kind:'action', title:'Action', detail:u.intent}); }
    }
    return ev.sort((a,b) => b.t - a.t);
  });
  const problems = $derived(stream.filter(i => i.kind !== 'turn'));
  const packetJson = $derived(lastFused?.target ? JSON.stringify({
    stroke_id: nameOf(lastFused.target.strokeId), target: lastFused.target.selector || null,
    intent: lastFused.intent, confidence: lastFused.target.confidence, start_ms: lastFused.startMs
  }, null, 2) : '');
  // Log lines become stream entries only when a person needs them; the rest stays quiet.
  function addLine(cls,text){
    if(cls==='err') push({kind:'error',text});
    else if(cls==='why') push({kind:'note',text});
  }
  function push(item){stream=[...stream,{key:cryptoId(),...item}];}
  function cryptoId(){const bytes=new Uint8Array(8);crypto.getRandomValues(bytes);return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');}
  async function deliver(stroke){
    if(deliveries[stroke.id]==='sending'||deliveries[stroke.id]==='accepted')return;
    deliveries[stroke.id]='sending';stream=stream.filter(i=>i.stroke!==stroke);
    try {
      const response=await fetch('/api/strokes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(stroke.payload)});
      const ack=await response.json();
      if(!response.ok||ack.status!=='accepted'||ack.id!==stroke.id)throw new Error(ack.error||'invalid receipt');
      deliveries[stroke.id]='accepted';
    }catch(err){deliveries[stroke.id]='failed';push({kind:'retry',stroke,text:`${stroke.name} not delivered: ${err.message}`});}
  }
  function previewHtml(html){
    currentHtml=html;
    // CSP is applied before the untrusted document; no script permission in the iframe sandbox.
    prev.srcdoc=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'none'; form-action 'none'">`+html.slice(0,200000);
  }
  function previewLoaded(){if(!prev)return;page=(prev.contentDocument?.title||'preview').split(/[|·—-]/)[0].trim().toLowerCase()||'preview';drawing=attachDrawing(prev,{
    tool:()=>tool,elapsed,cursor:handCursor,
    onStart:()=>{},onMove:()=>{},
    onFinish:(stroke,payload,summary,target)=>{
      stroke.payload=payload;stroke.summary=summary;
      timeline.push({kind:'stroke',t:stroke.t,t_end:payload.t_end,payload});
      deliver(stroke);
      const b=payload.bbox;
      const mark={id:payload.id,name:stroke.name,startMs:payload.t,endMs:payload.t_end,shape:payload.shape,bbox:b,
        anchor:{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)},
        targets:target?[{selector:target.selector,label:target.label,tag:target.tag,confidence:target.confidence}]:[],
        pts:payload.pts.map(p=>({x:p.x,y:p.y})),stroke};
      marks=[...marks,mark];note='';
      // an arrow from a circled/highlighted element: say where it goes
      const rel=websiteRelations(timeline.filter(e=>e.kind==='stroke').map(e=>e.payload)).find(r=>r.arrow===payload.id);
      if(rel) addLine('why',describeRelation(rel));
    }
  });}
  // Clear starts a fresh session: marks, words and the clock. The clock only resets while the mic
  // is off, because Reson8 word times are mapped onto it.
  function clearMarks(){drawing?.clear();marks=[];note='';timeline=[];turns=turns.filter(t=>t.mode!=='website');stream=[];if(!micOn)started=Date.now();now=elapsed();}
  async function toggleMic(){
    if(micOn){audio?.stop();micOn=false;interim='';audioState='idle';return;}
    try{await audio.start();micOn=true;audioState='connecting';}catch(err){audioState='error';addLine('err','Mic failed: '+err.message);}
  }
  function summonMuse(){museOn=true;clearTimeout(museTimer);museTimer=setTimeout(()=>museOn=false,4200);}
  async function apply(){
    const bundles=buildBundles(timeline), strokes=timeline.filter(e=>e.kind==='stroke').map(e=>e.payload);
    if(!typed && !bundles.length){addLine('err','Nothing to apply. Speak, draw or type first.');return;}
    if(!canApply(strokes,deliveries)){addLine('err','Retry failed strokes before apply.');return;}
    status='Reading your marks and your words…';busy=true;
    try{
      const response=await fetch('/api/apply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bundles:typed?[{t_start:0,t_end:0,transcript:typed,strokes}]:bundles,relations:websiteRelations(strokes),current_html:currentHtml})});
      const out=await response.json();
      if(!response.ok||out.error)throw new Error(out.error||'HTTP '+response.status);
      push({kind:'agent',text:out.reasoning||'Done.'});
      previewHtml(out.html);timeline=[];typed='';marks=[];turns=turns.filter(t=>t.mode!=='website');
      status='Preview updated. Nothing published.';
      note=MARGINALIA[applies++%MARGINALIA.length];summonMuse();
    }catch(err){addLine('err','Apply failed: '+err.message);status='Apply failed. Try again.';}
    finally{busy=false;}
  }
  async function publish(){
    status='Staging…';busy=true;
    try{
      const response=await fetch('/api/publish',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({html:currentHtml})});
      const out=await response.json();
      if(!response.ok||out.error)throw new Error(out.error||'HTTP '+response.status);
      push({kind:'staged',text:out.path,command:out.command});
      status='Staged. The deploy command is yours to run.';
    }catch(err){addLine('err','Publish failed: '+err.message);status='Staging failed.';}
    finally{busy=false;}
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
  function onCanvasStroke(){recompute();}
  // One utterance on the session clock, whether Reson8 heard it or someone typed it.
  function timedUtterance(turn,source){
    let {text,startMs,endMs,words}=turn;
    if(startMs==null){ // no Reson8 timestamps: assume it was just said, at a normal pace
      endMs=elapsed();startMs=Math.max(0,endMs-text.split(/\s+/).length*MS_PER_WORD);words=[];
    }
    if(!words?.length) words=simulateWords(text,startMs,endMs);
    return {id:'U'+nextUtt++,text,startMs,endMs,words,final:true,source};
  }
  function addTurn(turn,source){
    const u=timedUtterance(turn,source);
    interim='';
    if(mode==='canvas'){
      canvasUtts=[...canvasUtts,u];
      const d=recompute(), fu=d.utterances.find(x=>x.id===u.id);
      const notes=(fu?.references||[]).map(r=>({word:r.word,selector:r.element?describe(d,r.element):'nothing drawn nearby',confidence:''}));
      turns=[...turns,{...u,mode,refs:notes}];push({kind:'turn',id:u.id});
    }else{
      timeline.push({kind:'transcript',t:elapsed(),text:u.text});
      turns=[...turns,{...u,mode}];push({kind:'turn',id:u.id});
    }
  }
  function noteTyping(value){ if(value.trim()&&typingStart===null) typingStart=elapsed(); if(!value.trim()) typingStart=null; }
  // typed words count as spoken over the time spent typing, ending now
  function typedTurn(text){
    const endMs=elapsed();
    const startMs=typingStart!==null&&typingStart<endMs?typingStart:Math.max(0,endMs-text.split(/\s+/).length*MS_PER_WORD);
    typingStart=null;
    return {text,startMs,endMs,words:simulateWords(text,startMs,endMs)};
  }
  function saySimulated(){
    const text=said.trim(); if(!text) return;
    addTurn(typedTurn(text),'typed');said='';
  }
  function sayInstruction(){
    const text=typed.trim(); if(!text) return;
    addTurn(typedTurn(text),'typed');typed='';
  }
  function clearCanvas(){board.clear();canvasUtts=[];nodes=[];edges=[];turns=turns.filter(t=>t.mode!=='canvas');}
  function undoCanvas(){if(board.undo())recompute();}
  const pngName=()=>'calliope-canvas-'+new Date().toISOString().replace(/[:.]/g,'-')+'.png';
  function download(blob){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=pngName();a.click();setTimeout(()=>URL.revokeObjectURL(a.href),10000);}
  async function copyForAgent(){
    const strokes=board.strokes();
    if(!strokes.length&&!canvasUtts.length){addLine('err','Nothing to copy. Draw or speak first.');return;}
    const packet=buildCanvasPacket({elapsedMs:elapsed(),strokes,utterances:canvasUtts});
    try{await navigator.clipboard.writeText(canvasPacketText(packet));
      push({kind:'note',text:`Copied: ${packet.nodes.length} nodes, ${packet.edges.length} edges, ${packet.utterances.length} sentences. Paste the PNG alongside.`});
    }catch(err){addLine('err','Clipboard blocked: '+err.message);}
  }
  async function copyPng(){
    const blob=await board.exportPng(); if(!blob){addLine('err','Nothing drawn yet.');return;}
    try{await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);push({kind:'note',text:'PNG copied.'});}
    catch(_){download(blob);push({kind:'note',text:'Image clipboard blocked. PNG downloaded instead.'});}
  }
  async function downloadPng(){const blob=await board.exportPng();if(blob)download(blob);else addLine('err','Nothing drawn yet.');}
  async function copyJson(){
    try{await navigator.clipboard.writeText(packetJson);copied=true;setTimeout(()=>copied=false,1400);}
    catch(err){addLine('err','Clipboard blocked: '+err.message);}
  }
  function setMode(m){mode=m;status=STATUS[m];}
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
  onMount(()=>{
    board=attachBoard(boardEl,{tool:()=>tool,elapsed,onStroke:onCanvasStroke});
    fetch('/api/config').then(r=>{if(!r.ok)throw new Error('config unavailable');return r.json();}).then(config=>{
      audio=createAudio(eq,{port:config.audioPort,elapsed,
        onLine:(cls,text)=>{
          if(/LINK UP/.test(text))audioState='live';
          if(cls==='err')audioState='error';
          if(cls==='inter'&&text!=='(listening)')interim=text;else addLine(cls,text);},
        onTurn:turn=>addTurn(turn,'reson8')});
      secure=window.isSecureContext;
    }).catch(()=>addLine('err','Audio config unavailable.'));
    previewHtml(currentHtml);
    fetch('/jamie-mock.html').then(r=>{if(!r.ok)throw new Error('mock unavailable');return r.text();}).then(previewHtml).catch(()=>{});
    loadHandCursor();
    const tick=setInterval(()=>now=elapsed(),250);
    return ()=>{audio?.destroy();clearTimeout(museTimer);clearInterval(tick);};
  });
</script>

{#snippet steps()}
  <ol class="steps">
    <li class:done={lastFused}>
      <span class="n">1</span><h3>The user said</h3>
      <div class="card">
        {#if lastFused}
          <div class="said"><span class="voice"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 10v4M9 7v10M13 4v16M17 8v8M21 11v2" /></svg></span><q>{lastFused.text}</q><time>{clock(lastFused.startMs)}</time></div>
          <dl class="kv"><dt>Intent:</dt><dd>{lastFused.intent}</dd>{#if hit}<dt>Confidence:</dt><dd>{hit.confidence.toFixed(2)}</dd>{/if}</dl>
        {:else if interim}<p class="wait"><i>{interim}</i></p>
        {:else}<p class="wait">Waiting for a sentence. Speak, or type one below.</p>{/if}
      </div>
    </li>
    <li class:done={lastMark}>
      <span class="n">2</span><h3>The user pointed</h3>
      <div class="card pointed">
        {#if lastMark}
          {@const b = lastMark.bbox}
          <svg class="thumb" viewBox="{b.x - 16} {b.y - 16} {b.width + 32} {b.height + 32}" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><polyline points={lastMark.pts.map(p => p.x + ',' + p.y).join(' ')} /></svg>
          <dl class="kv"><dt>{lastMark.name}</dt><dd>({lastMark.shape})</dd><dt>bbox:</dt><dd>{b.width} × {b.height}</dd>{#if lastRef}<dt>confidence:</dt><dd>{lastRef.confidence.toFixed(2)}</dd>{/if}</dl>
        {:else}<p class="wait">Circle, underline or point at something on the page.</p>{/if}
      </div>
    </li>
    <li class:done={hit}>
      <span class="n">3</span><h3>Target resolved</h3>
      <div class="card">
        {#if hit}
          <dl class="kv"><dt>selector:</dt><dd>{hit.selector}</dd><dt>tag:</dt><dd>{(hit.tag || '—').toUpperCase()}</dd><dt>confidence:</dt><dd>{hit.confidence.toFixed(2)}</dd></dl>
          <button class="corner" onclick={copyJson} aria-label="Copy JSON" title="Copy JSON"><Icon name="copy" size={15} /></button>
        {:else if lastFused?.target}<p class="wait">The mark didn't land on an element. Circle a little closer.</p>
        {:else}<p class="wait">Words and marks meet here, by time.</p>{/if}
      </div>
    </li>
    <li class:done={hit}>
      <span class="n">4</span><h3>Action suggested</h3>
      <div class="card">
        {#if hit}
          <span class="pill">{lastFused.intent.toUpperCase()}</span>
          <p class="instr">{lastFused.instruction}</p>
        {:else}<p class="wait">Apply sends the page, your marks and your words to the agent.</p>{/if}
        {#each problems.filter(i => i.kind === 'agent').slice(-1) as a}<p class="agent"><b>Agent</b> {a.text}</p>{/each}
      </div>
    </li>
  </ol>
{/snippet}

<Loader />
<header class="top">
  <img class="logo" src="/assets/calliope-logo.png" alt="Calliope" />
  <label class="mode"><span class="live-dot"></span>
    <select aria-label="Surface" value={mode} onchange={e => setMode(e.currentTarget.value)}>
      <option value="website">Live DOM</option><option value="canvas">Blank canvas</option>
    </select>
  </label>
  <div class="url"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" /></svg>{mode==='canvas' ? 'blank canvas' : page}</div>
  <div class="listen" class:on={micOn}>
    <canvas id="eq" bind:this={eq}></canvas>
    <button id="btnMic" class="mic" disabled={!secure} onclick={toggleMic} aria-label={micOn ? 'Stop listening' : 'Start listening'} title={secure ? '' : 'The mic needs a secure origin'}><Icon name="mic" size={20} /></button>
  </div>
</header>

<nav class="rail" aria-label="Tools">
  <button id="toolPen" class:on={tool==='pen'} aria-pressed={tool==='pen'} onclick={() => tool='pen'}><Icon name="pen" /><span>Draw</span></button>
  <button id="btnTool" class:on={tool==='highlighter'} aria-pressed={tool==='highlighter'} onclick={() => tool='highlighter'}><Icon name="mark" /><span>Highlights</span></button>
  {#if mode==='canvas'}<button id="btnUndo" onclick={undoCanvas}><Icon name="undo" /><span>Undo</span></button>{/if}
  <button id="btnClear" onclick={mode==='canvas'?clearCanvas:clearMarks}><Icon name="erase" /><span>Clear</span></button>
  <div class="observer" aria-hidden="true">
    <svg viewBox="0 0 60 120"><path d="M14 112c-14-30-10-70 12-96M20 20l6-6 5 8M46 104c10-24 8-52-6-74M36 100l10 6 3-10" /></svg>
    <img src="/assets/muse-hand.png" alt="" />
  </div>
</nav>

<main class="work" aria-label="CALLIOPE // SPEAK + DRAW ON THE WEBSITE">
  <section class="frame">
    <div class="chrome"><span class="lights"><i></i><i></i><i></i></span><span class="addr">{mode==='canvas' ? 'blank canvas' : page}</span><span class="status" role="status" id="status">{status}</span></div>
    <div class="sheet">
      <div id="prevWrap" hidden={mode==='canvas'}><iframe id="prev" bind:this={prev} onload={previewLoaded} sandbox="allow-same-origin" referrerpolicy="no-referrer" title="Website preview"></iframe></div>
      <div id="boardWrap" hidden={mode!=='canvas'}><svg id="board" bind:this={boardEl} role="img" aria-label="Drawing board"></svg></div>
      {#if note}<p class="margin-note" aria-live="polite">{note}</p>{/if}
      {#if museOn}<img class="muse" src="/assets/muse-bust.png" alt="" />{/if}
    </div>
  </section>

  {#if mode==='website'}
    <section class="timeline">
      <h2>Timeline</h2>
      <Timeline {marks} utterances={fused} {now} {fmt} />
      <h2 class="sub">Recent events</h2>
      <div class="cards">
        {#each events.slice(0, 5) as e, i (i)}
          <div class="ev {e.kind}"><span class="ev-head"><i></i><time>{clock(e.t)}</time><b>{e.title}</b></span><span class="ev-detail">{e.detail}</span></div>
        {:else}<p class="wait">Nothing yet. Draw on the page and say what should change.</p>{/each}
      </div>
    </section>
  {/if}

  <footer class="foot">
    <span class="conn {audioState}"><i></i>{audioState==='live' ? 'Connected to Reson8' : audioState==='connecting' ? 'Connecting to Reson8…' : audioState==='error' ? 'Reson8 unavailable' : secure ? 'Reson8 ready' : 'Mic needs a secure origin'}</span>
    <span class="session">Session {fmt(now)}</span>
  </footer>
</main>

<aside class="panel">
  <div class="tabs" role="tablist" aria-label="Panel">
    {#each [['interpretation','Interpretation'],['strokes','Strokes'],['targets','Targets'],['details','Details']] as [k, label]}
      <button role="tab" aria-selected={tab===k} onclick={() => tab=k}>{label}{#if k==='details' && problems.some(p => p.kind==='error' || p.kind==='retry')}<i class="alert"></i>{/if}</button>
    {/each}
  </div>

  <div class="pane" bind:this={feed}>
    {#if tab==='interpretation'}
      {#if mode==='website'}
        {@render steps()}
        <h2 class="sub">Recent events</h2>
        <ul class="events">
          {#each events.slice(0, 4) as e, i (i)}<li class="ev {e.kind}"><i></i><time>{clock(e.t)}</time><div><b>{e.title}</b><span>{e.detail}</span></div></li>{/each}
        </ul>
        <p class="motto" aria-hidden="true">Human intent.<br />Machine context.</p>
      {:else}
        <ol class="steps"><li class:done={nodes.length}><span class="n">1</span><h3>The diagram so far</h3>
          <div class="card">
            {#each nodes as n (n.id)}<p class="kvline"><b>{n.id}</b> {n.shape} <span class="named">{n.label || '(unnamed)'}</span></p>{/each}
            {#each edges as e (e.id)}<p class="kvline"><b>{e.id}</b> {e.from} → {e.to} <span class="named">{e.label}</span></p>{/each}
            {#if !nodes.length && !edges.length}<p class="wait">Boxes become nodes, lines become edges, and your words name them.</p>{/if}
          </div></li></ol>
      {/if}
    {:else if tab==='strokes'}
      <ul class="list">
        {#each marks as m (m.id)}
          <li><b>{m.name}</b><span>{m.shape} · {m.bbox.width} × {m.bbox.height} · {clock(m.startMs)}</span>
            {#if deliveries[m.id]==='failed'}<button class="retry" onclick={() => deliver(m.stroke)}>retry</button>{/if}</li>
        {:else}<li class="wait">No strokes yet.</li>{/each}
      </ul>
    {:else if tab==='targets'}
      <ul class="list">
        {#each marks.filter(m => m.targets.length) as m (m.id)}
          <li><b>{m.targets[0].selector}</b><span>{m.targets[0].tag.toUpperCase()} · {m.name} · {m.targets[0].confidence.toFixed(2)}</span></li>
        {:else}<li class="wait">No targets resolved yet.</li>{/each}
      </ul>
    {:else}
      {#if packetJson}<div class="json"><div class="json-head"><b>JSON</b><button onclick={copyJson}><Icon name="copy" size={14} />{copied ? 'Copied' : 'Copy'}</button></div><pre>{packetJson}</pre></div>{/if}
      <ul class="list">
        {#each problems as p (p.key)}
          <li class={p.kind}>
            {#if p.kind==='staged'}<b>Staged</b><span><code>{p.text}</code></span><pre>{p.command}</pre>
            {:else if p.kind==='retry'}<b>Not delivered</b><span>{p.text}</span><button class="retry" onclick={() => deliver(p.stroke)}>retry</button>
            {:else}<b>{p.kind==='agent' ? 'Agent' : p.kind==='error' ? 'Error' : 'Note'}</b><span>{p.text}</span>{/if}
          </li>
        {:else}<li class="wait">Agent replies, staged builds and errors appear here.</li>{/each}
      </ul>
    {/if}
  </div>

  <div class="compose">
    {#if mode==='website'}
      <Input id="instr" aria-label="Instruction" placeholder="Or type what should change" bind:value={typed} oninput={() => noteTyping(typed)} onkeydown={e => {if(e.key==='Enter'){e.preventDefault();sayInstruction();}}} />
      <div class="actions">
        <Button id="btnApply" variant="primary" disabled={busy} onclick={apply}>Apply <Asterisk size={13} weight={2.6} /></Button>
        <Button id="btnPublish" variant="ghost" disabled={busy} onclick={publish}>Publish</Button>
      </div>
    {:else}
      <Input id="said" aria-label="Type what you would say" placeholder="Or type what you would say" bind:value={said} oninput={() => noteTyping(said)} onkeydown={e => {if(e.key==='Enter'){e.preventDefault();saySimulated();}}} />
      <div class="actions">
        <Button id="btnCopyAgent" variant="primary" onclick={copyForAgent}>Copy for agent</Button>
        <Button id="btnCopyPng" variant="ghost" onclick={copyPng}>Copy PNG</Button>
        <Button id="btnDownloadPng" variant="ghost" onclick={downloadPng} aria-label="Download PNG">↓</Button>
      </div>
    {/if}
  </div>
</aside>
