<script>
  import { onMount } from 'svelte';
  import Loader from './Loader.svelte';
  import Button from './components/ui/button/Button.svelte';
  import Input from './components/ui/input/Input.svelte';
  import { attachDrawing } from './drawing.js';
  import { buildBundles, canApply, lanes } from './timeline.js';
  import Lanes from './Lanes.svelte';
  import { createMarkQueue, MARK_SETTLE_DELAY_MS } from './marks.js';
  import { createAudio } from './audio.js';
  let feed, prev, eq;
  let status = $state('SPEAK WHILE YOU DRAW ON THE PAGE. THE AGENT SEES BOTH.');
  let rows = $state([]), tool = $state('pen'), typed = $state(''), url = $state(''), busy = $state(false), micOn = $state(false);
  let imported = false;
  let secure = $state(false), publishEnabled = $state(true);
  const started = Date.now();
  let currentHtml = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:system-ui,sans-serif;padding:48px"><h1>Your website</h1><p>Speak and draw on me to change me.</p><button style="padding:12px 20px">Click me</button></body></html>';
  let timeline = [], deliveries = {}, drawing = null, audio = null, activeStroke = false;
  const elapsed = () => Date.now()-started;
  let lanesData = $state({marks:[],words:[],links:[]});
  function refreshLanes(){lanesData=lanes(timeline);}
  const fmt = ms => {const s=Math.floor(ms/1000);return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');};
  function addLine(cls,text,options={}){rows=[...rows,{key:cryptoId(),cls,text,clock:fmt(elapsed()),...options}];scroll();}
  function cryptoId(){const bytes=new Uint8Array(8);crypto.getRandomValues(bytes);return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');}
  function scroll(){requestAnimationFrame(()=>{if(feed)feed.scrollTop=feed.scrollHeight;});}
  function rowText(stroke,state){const p=stroke.pts.at(-1);return `${stroke.summary?.text || stroke.tool.toUpperCase()+' '+p.x+', '+p.y+' · '+p.utc} · ${state}`;}
  function updateRow(mark,state,message){rows=rows.map(row=>{
    if(row.key!==mark.id)return row;
    const agentMessage=message ?? row.agentMessage;
    return {...row,agentMessage,copyText:agentMessage,state,text:agentMessage
      ? `${state} · AGENT SKETCH CONTEXT (FOR APPLY)`
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
  function selectMessage(event){
    const field=event.currentTarget.closest('.message-row').querySelector('textarea');
    field.focus();field.select();
  }
  const markQueue=createMarkQueue({onSettled:mark=>{
    timeline.push({kind:'stroke',t:mark.t,t_end:mark.t_end,payload:mark});
    refreshLanes();
    rows=rows.filter(row=>!mark.strokes.slice(1).some(stroke=>row.key===stroke.id))
      .map(row=>row.key===mark.id?{...row,mark}:row);
    updateRow(mark,'SENDING');
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
  function clearMarks(){drawing?.clear();addLine('fin','MARKS CLEARED');}
  async function importUrl(event){
    event.preventDefault();
    if(busy)return;
    busy=true;status='IMPORTING WEBSITE...';
    try{
      const response=await fetch('/api/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url})});
      const out=await response.json();
      if(!response.ok||out.error)throw new Error(out.error||'HTTP '+response.status);
      await markQueue.flush();
      imported=true;drawing?.clear();timeline=[];deliveries={};typed='';
      previewHtml(out.html);
      addLine('fin','IMPORTED '+out.url);status='WEBSITE IMPORTED. DRAW OR SPEAK ON IT.';
    }catch(err){addLine('err','IMPORT FAILED: '+err.message);status='IMPORT FAILED. PREVIEW UNCHANGED.';}
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
      const response=await fetch('/api/apply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bundles:typed?[{t_start:0,t_end:0,transcript:typed,strokes:marks}]:bundles,current_html:currentHtml})});
      const out=await response.json();
      if(typeof out.agent_message==='string')addLine('coord',`${response.ok?'SENT':'PREPARED / NOT CONFIRMED SENT'} · FULL AGENT MESSAGE`,{copyText:out.agent_message});
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
      audio=createAudio(eq,{port:config.audioPort,onLine:addLine,elapsed,onTurn:utt=>{timeline.push({kind:'transcript',t:utt.startMs,t_end:utt.endMs,text:utt.text,words:utt.words});refreshLanes();}});
      secure=window.isSecureContext;
      publishEnabled=config.publishEnabled;
    }).catch(()=>addLine('err','AUDIO CONFIG UNAVAILABLE'));
    previewHtml(currentHtml);
    fetch('/jamie-mock.html').then(r=>{if(!r.ok)throw new Error('mock unavailable');return r.text();}).then(html=>{if(!imported)previewHtml(html);}).catch(()=>{});
    const laneTimer=setInterval(refreshLanes,500);
    return ()=>{clearInterval(laneTimer);audio?.destroy();};
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
        {#if row.copyText}
          <div class="message-row">
            <div class="message-head"><span class={row.cls}>{row.text}</span><button type="button" onclick={selectMessage}>SELECT TEXT</button></div>
            <textarea readonly value={row.copyText} aria-label={row.stroke?'Sketch receipt text':'Full agent message text'}></textarea>
            {#if row.state==='FAILED — CLICK TO RETRY'}<button type="button" onclick={() => retry(row)}>RETRY MARK</button>{/if}
          </div>
        {:else if row.stroke}
          {#if row.state==='FAILED — CLICK TO RETRY'}<button type="button" class="coord" onclick={() => retry(row)}>{row.text}</button>
          {:else}<div class="coord">{row.text}</div>{/if}
        {:else}
          <div><span class="t">[{row.clock}] </span><span class={row.cls}>{row.text}</span></div>
        {/if}
      {/each}
    </div>
    <Lanes data={lanesData} />
    <div id="eqWrap"><div id="eqLabel">VOICE LEVEL</div><canvas id="eq" bind:this={eq}></canvas></div>
    <div class="row">
      <Button id="btnMic" disabled={!secure} variant={micOn?'recording':'default'} onclick={toggleMic}>{secure?(micOn?'MIC OFF':'MIC ON'):'MIC: HTTPS REQUIRED'}</Button>
      <Button id="btnClear" variant="amber" onclick={clearMarks}>CLEAR MARKS</Button>
      <Button id="btnTool" onclick={() => tool=tool==='pen'?'highlighter':'pen'}>TOOL: {tool.toUpperCase()}</Button>
    </div>
    <div class="row"><Input id="instr" aria-label="Instruction" placeholder="...or type an instruction" bind:value={typed} /></div>
    <div class="row"><Button id="btnApply" variant="amber" disabled={busy} onclick={apply}>APPLY ▸</Button><Button id="btnPublish" disabled={busy||!publishEnabled} onclick={publish}>{publishEnabled?'PUBLISH':'PUBLISH DISABLED'}</Button></div>
    <div class="notice">{publishEnabled?'APPLY = PREVIEW ONLY. PUBLISH STAGES LOCALLY; DEPLOY IS A SEPARATE COMMAND.':'REVIEW ONLY — PUBLISH IS DISABLED.'} MIC NEEDS A SECURE ORIGIN AND REACHABLE AUDIO RELAY.</div>
  </section>
  <section class="pane"><h3>LIVE WEBSITE // DRAW DIRECTLY ON IT</h3><form class="row" onsubmit={importUrl}><Input id="url" aria-label="Website URL" placeholder="Paste a public website URL" bind:value={url} /><Button type="submit" disabled={busy}>IMPORT URL</Button></form><div id="prevWrap"><iframe id="prev" bind:this={prev} onload={previewLoaded} sandbox="allow-same-origin" referrerpolicy="no-referrer" title="Website preview"></iframe></div></section>
</main>
