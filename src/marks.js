// A mark is one settled recognition over one or more immutable stroke payloads.
export const MARK_SETTLE_DELAY_MS = 2000;
function crossing(a, b) {
  if (a.tool !== 'pen' || b.tool !== 'pen' || a.viewBox !== b.viewBox) return false;
  const ends = s => [s.pts[0], s.pts.at(-1)];
  const [p, q] = ends(a), [r, s] = ends(b);
  const u = [q.x-p.x, q.y-p.y], v = [s.x-r.x, s.y-r.y];
  const len = w => Math.hypot(...w);
  if (Math.min(len(u), len(v)) < 28 || Math.min(Math.abs(u[0]), Math.abs(u[1]), Math.abs(v[0]), Math.abs(v[1])) < 18) return false;
  const straight = (stroke, from, to) => {
    let length = 0;
    for (let i=1;i<stroke.pts.length;i++) length += Math.hypot(stroke.pts[i].x-stroke.pts[i-1].x,stroke.pts[i].y-stroke.pts[i-1].y);
    return length / Math.hypot(to.x-from.x,to.y-from.y) < 1.3;
  };
  if (!straight(a,p,q) || !straight(b,r,s)) return false;
  const cross = (x,y) => x[0]*y[1]-x[1]*y[0];
  const determinant = cross(u,v);
  if (Math.abs(determinant) / (len(u)*len(v)) < 0.5 || u[0]*u[1]*v[0]*v[1] >= 0) return false;
  const delta=[r.x-p.x,r.y-p.y], t=cross(delta,v)/determinant, k=cross(delta,u)/determinant;
  return t > .25 && t < .75 && k > .25 && k < .75;
}

export function makeMark(strokes) {
  if (!strokes.length || strokes.length > 2 || (strokes.length === 2 && !crossing(...strokes))) return null;
  const first=strokes[0], last=strokes.at(-1);
  return Object.freeze({id:first.id,t:first.t,t_end:last.t_end,
    shape:strokes.length === 2 ? 'x' : first.shape,
    ...(strokes.length === 1 && first.shape === 'line' ? {angle_deg:first.angle_deg, direction:first.direction} : {}),
    enclosed_element:strokes.length === 2 ? '' : first.enclosed_element,
    strokes:Object.freeze([...strokes])});
}

export function createMarkQueue({delay=MARK_SETTLE_DELAY_MS,onSettled,setTimer=setTimeout,clearTimer=clearTimeout}) {
  let pending=[], timer=null;
  const inFlight=new Set();
  function cancel() { if (timer !== null) clearTimer(timer); timer=null; }
  function settle() {
    cancel();
    if (!pending.length) return Promise.resolve();
    const mark=makeMark(pending); pending=[];
    const promise=Promise.resolve().then(()=>onSettled(mark));
    inFlight.add(promise);promise.finally(()=>inFlight.delete(promise));
    return promise;
  }
  function schedule() { cancel();timer=setTimer(()=>{void settle();},delay); }
  return {
    hold:cancel,
    clear() { cancel(); pending=[]; },
    add(stroke) {
      if (pending.length && makeMark([pending[0],stroke])) {
        pending.push(stroke);void settle();return;
      }
      if (pending.length) void settle();
      pending=[stroke];schedule();
    },
    async flush() { await settle();await Promise.all([...inFlight]); }
  };
}
