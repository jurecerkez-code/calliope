// Audio is an optional secure-origin input; turn_end commits transcript events with
// real audio timing (Reson8 start_ms / words) so marks and words share one clock.
import { adaptTurn } from './timeline.js';

export function createAudio(canvas, {port, onLine, onTurn, onTurnStart, onEvent, elapsed}) {
  const ctx = canvas.getContext('2d');
  let ws=null, audioCtx=null, analyser=null, stream=null, frame=0;
  let lastCandidate=null, audioStartMs=null;
  const now = () => (typeof elapsed === 'function' ? elapsed() : Math.round(performance.now()));
  // A rolling amplitude trace, newest on the right, mirrored around a dotted baseline.
  const history=[];
  function draw() {
    frame=requestAnimationFrame(draw);
    const W=canvas.clientWidth||200, H=canvas.clientHeight||28, dpr=globalThis.devicePixelRatio||1;
    if(canvas.width!==Math.round(W*dpr)||canvas.height!==Math.round(H*dpr)){canvas.width=Math.round(W*dpr);canvas.height=Math.round(H*dpr);}
    ctx.setTransform?.(dpr,0,0,dpr,0,0); ctx.clearRect?.(0,0,W,H);
    const mid=H/2, step=4, bars=Math.floor(W/step);
    let level=0;
    if(analyser?.getByteTimeDomainData){
      const data=new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(data);
      let sum=0; for(const v of data){const d=(v-128)/128;sum+=d*d;}
      level=Math.min(1,Math.sqrt(sum/data.length)*4.5);
    }
    history.push(level); while(history.length>bars) history.shift();
    ctx.fillStyle='rgba(255,255,255,.35)';
    for(let x=0;x<W;x+=step) ctx.fillRect(x,mid-.5,1.5,1);
    const offset=bars-history.length;
    history.forEach((v,k)=>{
      if(v<0.02) return;
      const h=Math.max(2,v*(H-4));
      ctx.fillStyle=v>0.35?'#FFFFFF':'rgba(255,255,255,.55)';
      ctx.fillRect((offset+k)*step,mid-h/2,2,h);
    });
  }
  draw();
  function commit(msg){
    const text=(msg.text||lastCandidate?.text||'').trim();
    if(!text){ onEvent?.('turn_empty',{elapsedMs:now()});lastCandidate=null; return; }
    const utt=adaptTurn({...msg,text},lastCandidate,audioStartMs,now());
    lastCandidate=null;
    onTurn(utt);
    onLine('fin',text);
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
          if(msg.error){onEvent?.('mic_error',{error:msg.error});onLine('err','ERROR: '+msg.error);return;}
          const type=msg.type||'',text=msg.text||'';
          if(type==='turn_end_candidate'){if(text){lastCandidate=msg;onEvent?.('turn_candidate',{text,start_ms:msg.start_ms,duration_ms:msg.duration_ms,words:msg.words});onLine('inter',text);}return;}
          if(type==='turn_end'){commit(msg);return;}
          if(type==='turn_start'){lastCandidate=null;onEvent?.('turn_start',{elapsedMs:now()});onTurnStart?.();onLine('inter','(listening)');return;}
          if(text) onLine('inter',text);
        };
        ws.onopen=()=>{audioStartMs=null;lastCandidate=null;onLine('fin','RESON8 LINK UP (calliope). SPEAK.');};
        ws.onerror=()=>{onEvent?.('mic_error',{error:'audio connection failed'});onLine('err','AUDIO CONNECTION FAILED');};
        proc.onaudioprocess=e=>{
          if(ws?.readyState!==1)return;
          const f=e.inputBuffer.getChannelData(0),rate=audioCtx.sampleRate||16000;
          const n=rate===16000?f.length:Math.floor(f.length*16000/rate);
          if(audioStartMs===null) audioStartMs=now()-n/16; // frame duration at 16 kHz
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
    stop(){ws?.close();ws=null;analyser=null;lastCandidate=null;audioStartMs=null;stream?.getTracks().forEach(t=>t.stop());stream=null;audioCtx?.close();audioCtx=null;},
    destroy(){this.stop();cancelAnimationFrame(frame);}
  };
}
