// Audio is an optional secure-origin input; only turn_end commits transcript events.
export function createAudio(canvas, {port, onLine, onTurn}) {
  const ctx = canvas.getContext('2d');
  let ws=null, audioCtx=null, analyser=null, stream=null, frame=0;
  function draw() {
    frame=requestAnimationFrame(draw);
    canvas.width=canvas.clientWidth||200; canvas.height=44;
    let data=null;
    if(analyser){ data=new Uint8Array(analyser.frequencyBinCount); analyser.getByteFrequencyData(data); }
    const w=canvas.width/32;
    for(let i=0;i<32;i++){
      const v=data?data[Math.floor(i*data.length/64)]/255:0.03;
      const h=Math.max(2,v*canvas.height);
      ctx.fillStyle=v>0.55?'#37ff8b':v>0.2?'#1b6b45':'#0d2119';
      ctx.fillRect(i*w+1,canvas.height-h,w-2,h);
    }
  }
  draw();
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
          if(type==='turn_end_candidate'){if(text) onLine('inter',text);return;}
          if(type==='turn_end'){if(text){onTurn(text);onLine('fin',text);}return;}
          if(type==='turn_start'){onLine('inter','(listening)');return;}
          if(text) onLine('inter',text);
        };
        ws.onopen=()=>onLine('fin','RESON8 LINK UP (calliope). SPEAK.');
        ws.onerror=()=>onLine('err','AUDIO CONNECTION FAILED');
        proc.onaudioprocess=e=>{
          if(ws?.readyState!==1)return;
          const f=e.inputBuffer.getChannelData(0),rate=audioCtx.sampleRate||16000;
          const n=rate===16000?f.length:Math.floor(f.length*16000/rate);
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
