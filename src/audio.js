import { adaptMessage } from '../extension/lib/reson8.js';

// Audio is an optional secure-origin input; only turn_end commits transcript events.
// onTurn receives {text, startMs, endMs, words:[{text,startMs,endMs}]} on the session
// clock. Times come from the last turn_end_candidate (start_ms, duration_ms, words);
// they are null when Reson8 sent no timestamps.
export function createAudio(canvas, {port, onLine, onTurn, elapsed = () => 0}) {
  const ctx = canvas.getContext('2d');
  let ws=null, audioCtx=null, analyser=null, stream=null, frame=0;
  let audioStartMs=null, lastCandidate=null; // session time of the first sample Reson8 got
  // A rolling amplitude trace, newest on the right, mirrored around a dotted baseline.
  const history=[];
  function draw() {
    frame=requestAnimationFrame(draw);
    const W=canvas.clientWidth||200, H=canvas.clientHeight||44, dpr=window.devicePixelRatio||1;
    if(canvas.width!==Math.round(W*dpr)||canvas.height!==Math.round(H*dpr)){canvas.width=Math.round(W*dpr);canvas.height=Math.round(H*dpr);}
    ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,W,H);
    const mid=H/2, step=4, bars=Math.floor(W/step);
    let level=0;
    if(analyser){
      const data=new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(data);
      let sum=0; for(const v of data){const d=(v-128)/128;sum+=d*d;}
      level=Math.min(1,Math.sqrt(sum/data.length)*4.5);
    }
    history.push(level); while(history.length>bars) history.shift();
    ctx.fillStyle='rgba(23,23,23,.28)';
    for(let x=0;x<W;x+=step) ctx.fillRect(x,mid-.5,1.5,1);
    const offset=bars-history.length;
    history.forEach((v,i)=>{
      if(v<0.02) return;
      const h=Math.max(2,v*(H-6));
      ctx.fillStyle=v>0.35?'#2F5FAE':'rgba(47,95,174,.4)';
      ctx.fillRect((offset+i)*step,mid-h/2,2,h);
    });
  }
  draw();
  function timedTurn(msg){
    if(msg.start_ms==null||audioStartMs===null) return {text:msg.text,startMs:null,endMs:null,words:[]};
    // turns and realtime share the timing fields, so the realtime adapter applies
    const t=adaptMessage({...msg,type:'transcript'},audioStartMs);
    return {text:t.text,startMs:t.startMs,endMs:t.endMs,words:t.words};
  }
  return {
    async start() {
      if(!window.isSecureContext) throw new Error('HTTPS REQUIRED');
      stream=await navigator.mediaDevices.getUserMedia({audio:true});
      try {
        audioCtx=new AudioContext({sampleRate:16000});
        const src=audioCtx.createMediaStreamSource(stream);
        analyser=audioCtx.createAnalyser(); analyser.fftSize=256; src.connect(analyser);
        const proc=audioCtx.createScriptProcessor(4096,1,1);
        ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.hostname||'127.0.0.1'}:${port}`);
        ws.binaryType='arraybuffer';
        ws.onmessage=ev=>{
          const msg=JSON.parse(ev.data);
          if(msg.error){onLine('err','ERROR: '+msg.error);return;}
          const type=msg.type||'',text=msg.text||'';
          if(type==='turn_end_candidate'){if(text){lastCandidate=msg;onLine('inter',text);}return;}
          if(type==='turn_end'){
            const cand=lastCandidate||{}, finalText=text||cand.text||'';
            lastCandidate=null;
            if(finalText){onTurn(timedTurn({...cand,text:finalText}));onLine('fin',finalText);}
            return;
          }
          if(type==='turn_start'){onLine('inter','(listening)');return;}
          if(text) onLine('inter',text);
        };
        ws.onopen=()=>{audioStartMs=null;onLine('fin','RESON8 LINK UP (calliope). SPEAK.');};
        ws.onerror=()=>onLine('err','AUDIO CONNECTION FAILED');
        proc.onaudioprocess=e=>{
          if(ws?.readyState!==1)return;
          const f=e.inputBuffer.getChannelData(0),rate=audioCtx.sampleRate||16000;
          const n=rate===16000?f.length:Math.floor(f.length*16000/rate);
          // Reson8 times count from the first sample it receives; this frame holds n
          // samples captured before now. Approximate: latency before it is not measured.
          if(audioStartMs===null) audioStartMs=elapsed()-n/16;
          const buf=new ArrayBuffer(n*2),dv=new DataView(buf);
          for(let i=0;i<n;i++){
            const s=rate===16000?f[i]:f[Math.floor(i*rate/16000)];
            dv.setInt16(i*2,Math.max(-1,Math.min(1,s))*32767,true);
          }
          ws.send(buf);
        };
        src.connect(proc);proc.connect(audioCtx.destination);
      } catch(err) { this.stop(); throw err; }
    },
    stop(){ws?.close();ws=null;analyser=null;stream?.getTracks().forEach(t=>t.stop());stream=null;audioCtx?.close();audioCtx=null;},
    destroy(){this.stop();cancelAnimationFrame(frame);}
  };
}
