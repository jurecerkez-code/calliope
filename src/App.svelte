<script>
  import { onMount } from 'svelte';
  import Loader from './Loader.svelte';
  import Button from './components/ui/button/Button.svelte';
  import Input from './components/ui/input/Input.svelte';
  import { attachDrawing } from './drawing.js';
  import { buildBundles, canApply } from './timeline.js';
  import { createAudio } from './audio.js';
  let feed, prev, eq;
  let status = $state('SPEAK WHILE YOU DRAW ON THE PAGE. THE AGENT SEES BOTH.');
  let rows = $state([]), tool = $state('pen'), typed = $state(''), busy = $state(false), micOn = $state(false);
  let secure = $state(false);
  const started = Date.now();
  let currentHtml = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:system-ui,sans-serif;padding:48px"><h1>Your website</h1><p>Speak and draw on me to change me.</p><button style="padding:12px 20px">Click me</button></body></html>';
  let timeline = [], deliveries = {}, drawing = null, audio = null;
  const elapsed = () => Date.now()-started;
  const fmt = ms => {const s=Math.floor(ms/1000);return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');};
  function addLine(cls,text){rows=[...rows,{key:cryptoId(),cls,text,clock:fmt(elapsed())}];scroll();}
  function cryptoId(){const bytes=new Uint8Array(8);crypto.getRandomValues(bytes);return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');}
  function scroll(){requestAnimationFrame(()=>{if(feed)feed.scrollTop=feed.scrollHeight;});}
  function rowText(stroke,state){const p=stroke.pts.at(-1);return `${stroke.summary?.text || stroke.tool.toUpperCase()+' '+p.x+', '+p.y+' · '+p.utc} · ${state}`;}
  function updateRow(stroke,state){rows=rows.map(row=>row.key===stroke.id?{...row,text:rowText(stroke,state)}:row);scroll();}
  async function deliver(stroke){
    if(deliveries[stroke.id]==='sending'||deliveries[stroke.id]==='accepted')return;
    deliveries[stroke.id]='sending';updateRow(stroke,'SENDING');
    try {
      const response=await fetch('/api/strokes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(stroke.payload)});
      const ack=await response.json();
      if(!response.ok||ack.status!=='accepted'||ack.id!==stroke.id)throw new Error(ack.error||'invalid receipt');
      deliveries[stroke.id]='accepted';updateRow(stroke,'ACCEPTED');
    }catch(err){deliveries[stroke.id]='failed';updateRow(stroke,'FAILED — CLICK TO RETRY');addLine('err','STROKE NOT DELIVERED: '+err.message);}
  }
  function retry(row){if(row.stroke && deliveries[row.stroke.id]==='failed')deliver(row.stroke);}
  function previewHtml(html){
    currentHtml=html;
    // CSP is applied before the untrusted document; no script permission in the iframe sandbox.
    prev.srcdoc=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'none'; form-action 'none'">`+html.slice(0,200000);
  }
  function previewLoaded(){drawing=attachDrawing(prev,{
    tool:()=>tool,elapsed,
    onStart:stroke=>{rows=[...rows,{key:stroke.id,cls:'coord',text:rowText(stroke,'DRAWING'),clock:fmt(elapsed()),stroke}];scroll();},
    onMove:stroke=>updateRow(stroke,'DRAWING'),
    onFinish:(stroke,payload,summary)=>{
      stroke.payload=payload;stroke.summary=summary;
      timeline.push({kind:'stroke',t:stroke.t,t_end:payload.t_end,payload});
      deliver(stroke);
    }
  });}
  function clearMarks(){drawing?.clear();addLine('fin','MARKS CLEARED');}
  async function toggleMic(){
    if(micOn){audio?.stop();micOn=false;return;}
    try{await audio.start();micOn=true;}catch(err){addLine('err','MIC FAILED: '+err.message);}
  }
  async function apply(){
    const bundles=buildBundles(timeline), strokes=timeline.filter(e=>e.kind==='stroke').map(e=>e.payload);
    if(!typed && !bundles.length){addLine('err','NOTHING TO APPLY. SPEAK, DRAW OR TYPE FIRST.');return;}
    if(!canApply(strokes,deliveries)){addLine('err','RETRY FAILED STROKES BEFORE APPLY');return;}
    status='ANTHROPIC IS REASONING...';busy=true;
    try{
      const response=await fetch('/api/apply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bundles:typed?[{t_start:0,t_end:0,transcript:typed,strokes}]:bundles,current_html:currentHtml})});
      const out=await response.json();
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
  onMount(()=>{
    fetch('/api/config').then(r=>{if(!r.ok)throw new Error('config unavailable');return r.json();}).then(config=>{
      audio=createAudio(eq,{port:config.audioPort,onLine:addLine,onTurn:text=>timeline.push({kind:'transcript',t:elapsed(),text})});
      secure=window.isSecureContext;
    }).catch(()=>addLine('err','AUDIO CONFIG UNAVAILABLE'));
    previewHtml(currentHtml);
    fetch('/jamie-mock.html').then(r=>{if(!r.ok)throw new Error('mock unavailable');return r.text();}).then(previewHtml).catch(()=>{});
    return ()=>audio?.destroy();
  });
</script>

<Loader />
<header>
  <div class="rec"><span class="dot"></span>REC</div>
  <div class="brand">CALLIOPE // SPEAK + DRAW ON THE WEBSITE</div>
  <div id="status" role="status">{status}</div>
</header>
<main>
  <section class="pane">
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
    <div id="eqWrap"><div id="eqLabel">VOICE LEVEL</div><canvas id="eq" bind:this={eq}></canvas></div>
    <div class="row">
      <Button id="btnMic" disabled={!secure} variant={micOn?'recording':'default'} onclick={toggleMic}>{secure?(micOn?'MIC OFF':'MIC ON'):'MIC: HTTPS REQUIRED'}</Button>
      <Button id="btnClear" variant="amber" onclick={clearMarks}>CLEAR MARKS</Button>
      <Button id="btnTool" onclick={() => tool=tool==='pen'?'highlighter':'pen'}>TOOL: {tool.toUpperCase()}</Button>
    </div>
    <div class="row"><Input id="instr" aria-label="Instruction" placeholder="...or type an instruction" bind:value={typed} /></div>
    <div class="row"><Button id="btnApply" variant="amber" disabled={busy} onclick={apply}>APPLY ▸</Button><Button id="btnPublish" disabled={busy} onclick={publish}>PUBLISH</Button></div>
    <div class="notice">APPLY = PREVIEW ONLY. PUBLISH STAGES LOCALLY; DEPLOY IS A SEPARATE COMMAND. MIC NEEDS A SECURE ORIGIN AND REACHABLE AUDIO RELAY.</div>
  </section>
  <section class="pane"><h3>LIVE WEBSITE // DRAW DIRECTLY ON IT</h3><div id="prevWrap"><iframe id="prev" bind:this={prev} onload={previewLoaded} sandbox="allow-same-origin" referrerpolicy="no-referrer" title="Website preview"></iframe></div></section>
</main>
