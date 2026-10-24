<script>
  import { onMount } from 'svelte';
  import Loader from './Loader.svelte';
  import Button from './components/ui/button/Button.svelte';
  import Asterisk from './components/brand/Asterisk.svelte';
  import Timeline from './components/Timeline.svelte';
  import Icon from './components/brand/Icon.svelte';
  import { attachDrawing } from './drawing.js';
  import { buildBundles, canApply } from './timeline.js';
  import { createAudio } from './audio.js';
  import { attachBoard } from './board.js';
  import { buildDiagram, buildCanvasPacket, canvasPacketText, websiteRelations, describeRelation } from './diagram.js';
  import { simulateWords, MS_PER_WORD, fuse } from '../extension/lib/fusion.js';
  let prev, eq, boardEl;
  const STATUS = {website:'Draw where. Speak why.', canvas:'Draw the system. Name it out loud.'};
  let status = $state(STATUS.website);
  let busy = $state(false), micOn = $state(false);
  let secure = $state(false);
  // Blank canvas mode: draw and talk to explain a concept; the result is a diagram packet.
  let mode = $state('website'), nodes = $state([]), edges = $state([]);
  // Spoken turns, agent replies and problems, in order.
  let turns = $state([]), interim = $state(''), marks = $state([]), stream = $state([]), interpretationHistory = $state([]);
  let note = $state(''), museOn = $state(false), tab = $state('interpretation'), now = $state(0), page = $state('preview');
  let audioState = $state('idle'), handCursor = 'crosshair';
  let board = null, canvasUtts = [], nextUtt = 1, museTimer = 0, applies = 0;
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
  const currentInterpretations = $derived(fused.map(u => ({...u, mark: marks.find(m => m.id === u.target?.strokeId) || null})));
  const interpretations = $derived([...interpretationHistory, ...currentInterpretations]);
  const nameOf = id => marks.find(m => m.id === id)?.name || id;
  const markOf = id => marks.find(m => m.id === id);
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
    elapsed,cursor:handCursor,
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
      // An arrow from a circled element: say where it goes.
      const rel=websiteRelations(timeline.filter(e=>e.kind==='stroke').map(e=>e.payload)).find(r=>r.arrow===payload.id);
      if(rel) addLine('why',describeRelation(rel));
    }
  });}
  // Clear starts a fresh session: marks, words and the clock. The clock only resets while the mic
  // is off, because Reson8 word times are mapped onto it.
  function clearMarks(){drawing?.clear();marks=[];note='';timeline=[];turns=turns.filter(t=>t.mode!=='website');interpretationHistory=[];stream=[];if(!micOn)started=Date.now();now=elapsed();}
  async function toggleMic(){
    if(micOn){audio?.stop();micOn=false;interim='';audioState='idle';return;}
    try{await audio.start();micOn=true;audioState='connecting';}catch(err){audioState='error';addLine('err','Mic failed: '+err.message);}
  }
  function summonMuse(){museOn=true;clearTimeout(museTimer);museTimer=setTimeout(()=>museOn=false,4200);}
  async function apply(){
    const bundles=buildBundles(timeline), strokes=timeline.filter(e=>e.kind==='stroke').map(e=>e.payload);
    if(!bundles.length){addLine('err','Nothing to apply. Speak or draw first.');return;}
    if(!canApply(strokes,deliveries)){addLine('err','Retry failed strokes before apply.');return;}
    status='Reading your marks and your words…';busy=true;
    try{
      const response=await fetch('/api/apply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bundles,relations:websiteRelations(strokes),current_html:currentHtml})});
      const out=await response.json();
      if(!response.ok||out.error)throw new Error(out.error||'HTTP '+response.status);
      push({kind:'agent',text:out.reasoning||'Done.'});
      interpretationHistory=[...interpretationHistory,...currentInterpretations];
      previewHtml(out.html);timeline=[];marks=[];turns=turns.filter(t=>t.mode!=='website');
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
  // One spoken utterance on the session clock.
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
  function setMode(m){mode=m;tab='interpretation';status=STATUS[m];}
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
    board=attachBoard(boardEl,{elapsed,onStroke:onCanvasStroke});
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
  <span class="tool-label"><Icon name="pen" /><span>Draw</span></span>
  {#if mode==='canvas'}<button id="btnUndo" onclick={undoCanvas}><Icon name="undo" /><span>Undo</span></button>{/if}
  <button id="btnClear" onclick={mode==='canvas'?clearCanvas:clearMarks}><Icon name="erase" /><span>Clear</span></button>
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

  <footer class="foot">
    <span class="conn {audioState}"><i></i>{audioState==='live' ? 'Connected to Reson8' : audioState==='connecting' ? 'Connecting to Reson8…' : audioState==='error' ? 'Reson8 unavailable' : secure ? 'Reson8 ready' : 'Mic needs a secure origin'}</span>
    <span class="session">Session {fmt(now)}</span>
  </footer>
</main>

<aside class="panel">
  <div class="tabs" role="tablist" aria-label="Panel">
    {#each (mode==='website' ? [['interpretation','Interpretation'],['timeline','Timeline']] : [['interpretation','Interpretation']]) as [k, label]}
      <button role="tab" aria-selected={tab===k} onclick={() => tab=k}>{label}{#if k==='interpretation' && problems.some(p => p.kind==='error' || p.kind==='retry')}<i class="alert"></i>{/if}</button>
    {/each}
  </div>

  <div class="pane">
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
      {#if problems.length}
      <ul class="list">
        {#each problems as p (p.key)}
          <li class={p.kind}>
            {#if p.kind==='staged'}<b>Staged</b><span><code>{p.text}</code></span><pre>{p.command}</pre>
            {:else if p.kind==='retry'}<b>Not delivered</b><span>{p.text}</span><button class="retry" onclick={() => deliver(p.stroke)}>retry</button>
            {:else}<b>{p.kind==='agent' ? 'Agent' : p.kind==='error' ? 'Error' : 'Note'}</b><span>{p.text}</span>{/if}
          </li>
        {/each}
      </ul>
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
        <Button id="btnApply" variant="primary" disabled={busy} onclick={apply}>Apply <Asterisk size={13} weight={2.6} /></Button>
        <Button id="btnPublish" variant="ghost" disabled={busy} onclick={publish}>Publish</Button>
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
