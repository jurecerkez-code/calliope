import { describeSketch } from './shape.js';
import { makePayload } from './timeline.js';

const NS = 'http://www.w3.org/2000/svg';
const sel = el => {
  if (!el) return null;
  let s = el.tagName.toLowerCase();
  if (el.id) s += '#' + el.id;
  if (typeof el.className === 'string' && el.className.trim()) s += '.' + el.className.trim().split(/\s+/).slice(0,2).join('.');
  return s;
};
function domRef(el) {
  if (!el || ['html','body'].includes(el.tagName.toLowerCase())) return '';
  const parts = []; let node = el;
  while (node?.tagName && node.tagName.toLowerCase() !== 'html' && parts.length < 6) {
    let part = sel(node);
    if (node.parentElement && !node.id) {
      const siblings = Array.from(node.parentElement.children).filter(e => e.tagName === node.tagName);
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node)+1) + ')';
    }
    parts.unshift(part);
    if (node.id || node.tagName.toLowerCase() === 'body') break;
    node = node.parentElement;
  }
  const label = /^(button|a|h[1-6]|span|p)$/i.test(el.tagName) ? (el.textContent || '').trim().replace(/\s+/g,' ').slice(0,50) : '';
  return (parts.join(' > ') + (label ? ' "'+label+'"' : '')).slice(0,200);
}
const pathFor = pts => 'M ' + pts.map(p => `${p.x} ${p.y}`).join(' L ');

// Imperative drawing lives in the inert same-origin iframe; Svelte never re-renders its contents.
export function attachDrawing(iframe, {elapsed, onStart, onMove, onFinish}) {
  const doc = iframe.contentDocument;
  if (!doc?.body) return {clear() {}};
  const overlay = doc.createElement('canvas');
  overlay.style.cssText = 'position:absolute;left:0;top:0;width:100%;z-index:2147483647;cursor:crosshair;touch-action:none;';
  doc.body.appendChild(overlay);
  overlay.width = doc.documentElement.clientWidth;
  overlay.height = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight, doc.documentElement.clientHeight);
  overlay.style.height = overlay.height + 'px';
  const svg = doc.createElementNS(NS,'svg');
  svg.setAttribute('viewBox', `0 0 ${overlay.width} ${overlay.height}`);
  svg.style.cssText = `position:absolute;left:0;top:0;width:100%;height:${overlay.height}px;z-index:2147483647;pointer-events:none;overflow:visible;`;
  doc.body.appendChild(svg);
  let cur = null;
  const hit = (x,y) => (doc.elementsFromPoint(x,y) || []).find(el => el !== overlay && el !== svg) || null;
  const point = e => {
    const r = overlay.getBoundingClientRect(), el = hit(e.clientX,e.clientY), box = el?.getBoundingClientRect();
    return {x:Math.round(e.clientX-r.left),y:Math.round(e.clientY-r.top),utc:new Date().toISOString(),
      selector:sel(el)||'',text:(el?.textContent||'').trim().slice(0,200),
      rect:box ? {x:Math.round(box.x),y:Math.round(box.y),width:Math.round(box.width),height:Math.round(box.height)} : null};
  };
  overlay.addEventListener('pointerdown', e => {
    if (cur) return;
    try { overlay.setPointerCapture(e.pointerId); } catch (_) {}
    const p = point(e), s = sel(hit(e.clientX,e.clientY));
    const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
    cur = {id:Array.from(bytes,b => b.toString(16).padStart(2,'0')).join(''),tool:'pen',t:elapsed(),pts:[p],elements:s?[s]:[]};
    cur.pathEl = doc.createElementNS(NS,'path');
    for (const [k,v] of Object.entries({'fill':'none','stroke':'#00e05a',
      'stroke-width':'3','stroke-opacity':'1',
      'stroke-linecap':'round','stroke-linejoin':'round','d':`M ${p.x} ${p.y} L ${p.x} ${p.y}`})) cur.pathEl.setAttribute(k,v);
    svg.appendChild(cur.pathEl);
    onStart(cur); e.preventDefault();
  });
  overlay.addEventListener('pointermove', e => {
    if (!cur) return;
    const p = point(e); cur.pts.push(p);
    const s = sel(hit(e.clientX,e.clientY));
    if (s && !cur.elements.includes(s)) cur.elements.push(s);
    cur.pathEl.setAttribute('d',pathFor(cur.pts));
    onMove(cur); e.preventDefault();
  });
  const finish = () => {
    if (!cur) return;
    const stroke = cur; cur = null;
    const xs=stroke.pts.map(p=>p.x), ys=stroke.pts.map(p=>p.y);
    const r=overlay.getBoundingClientRect();
    const enclosed=domRef(hit(r.left+(Math.min(...xs)+Math.max(...xs))/2,r.top+(Math.min(...ys)+Math.max(...ys))/2));
    const payload=makePayload(stroke,elapsed(),{width:overlay.width,height:overlay.height},enclosed);
    onFinish(stroke,payload,describeSketch(payload));
  };
  overlay.addEventListener('pointerup',finish);
  overlay.addEventListener('pointercancel',finish);
  return {clear(){svg.replaceChildren();}};
}
