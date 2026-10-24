/* Calliope — transcript on the left, the imported site on the right.
   Talk, draw, apply. Every edit is a small set of DOM ops, so it lands fast. */

const $ = (s) => document.querySelector(s);

/* status line: 'ready · host', 'listening…', 'applying change…' */
function paintStatus(text) {
  $('#status').innerHTML = text || ('ready · <em>' + (pageHost || 'page') + '</em>');
}
const iframe = $('#site');
const canvas = $('#ink');
const ctx = canvas.getContext('2d');

let doc = null;             // iframe document
let cidSeq = 0;
let micOn = false;
let drawOn = false;
let applying = false;
let marks = [];            // drawings since the last apply
let history = [];          // reasoning strings already applied
let chunks = [];           // {t, text, final}
let appliedUpTo = 0;       // index into chunks already sent
let startedAt = 0;
let pageHost = '';
let pageUrl = '';

/* ---------------------------------------------------------------- iframe boot */

iframe.addEventListener('load', () => {
  doc = iframe.contentDocument;
  if (!doc) return;
  cidSeq = 0;
  sizeCanvas();
  stampCids();
  paintStatus();
  setTimeout(checkContent, 300);
});

/* A page that builds itself in the browser arrives as an empty shell. Say so out
   loud instead of letting someone talk to a blank screen. */
function checkContent() {
  const warn = $('#warn');
  if (!doc || !doc.body) return;
  const chars = (doc.body.innerText || '').replace(/\s+/g, ' ').trim().length;
  if (chars < 200) {
    warn.textContent = 'This page arrived almost empty — it builds itself in the browser, so there is no markup to edit here. Try a server-rendered site.';
    warn.classList.add('on');
  } else {
    warn.classList.remove('on');
  }
}

function sizeCanvas() {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}
window.addEventListener('resize', sizeCanvas);

const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'HEAD']);

function stampCids() {
  if (!doc || !doc.body) return;
  for (const el of doc.body.querySelectorAll('*')) {
    if (SKIP.has(el.tagName)) continue;
    if (el.classList && el.classList.contains('co-anchor')) continue;
    if (!el.dataset.cid) el.dataset.cid = 'e' + (++cidSeq);
  }
}

/* ------------------------------------------------------------------- outline */

const TEXT_TAGS = new Set(['H1','H2','H3','H4','H5','H6','P','A','BUTTON','LI','SPAN',
  'LABEL','INPUT','TEXTAREA','FIGCAPTION','BLOCKQUOTE','IMG','TD','TH','STRONG','EM']);
const BOX_TAGS = new Set(['SECTION','ARTICLE','HEADER','FOOTER','NAV','ASIDE','MAIN','FORM']);

function tagLabel(el) {
  const tag = el.tagName.toLowerCase();
  const cls = (el.className || '').toString().trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
  return cls ? tag + '.' + cls : tag;
}

function outlineText() {
  stampCids();
  const vh = iframe.clientHeight || 800;
  const near = [];
  const far = [];
  const nodes = doc.body.querySelectorAll(
    'h1,h2,h3,h4,h5,p,a,button,img,li,label,input,section,article,header,footer,nav,figcaption,strong');

  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    const raw = (el.innerText || '').replace(/\s+/g, ' ').trim();
    const isMedia = el.tagName === 'IMG' || el.tagName === 'INPUT';
    const isBox = BOX_TAGS.has(el.tagName);
    if (!raw && !isMedia && !isBox) continue;

    const text = raw.slice(0, 82);
    const line = '[' + el.dataset.cid + '] ' + tagLabel(el) + ' :: "' + text + '"';
    const visible = r.bottom > -40 && r.top < vh * 1.6;
    if (visible) near.push(line);
    else if (/^H[1-3]$/.test(el.tagName)) far.push(line);
    if (near.length >= 95) break;
  }

  const out = ['viewport ' + iframe.clientWidth + 'x' + vh, '', 'IN VIEW:']
    .concat(near.length ? near : ['(empty)']);
  if (far.length) {
    out.push('', 'HEADINGS ELSEWHERE ON THE PAGE:');
    for (const line of far.slice(0, 28)) out.push(line);
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------ drawings */

let stroke = null;

canvas.addEventListener('pointerdown', (e) => {
  if (!drawOn || !doc) return;
  try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  const r = canvas.getBoundingClientRect();
  stroke = [{ x: e.clientX - r.left, y: e.clientY - r.top }];
  clearAnchors();
  ctx.strokeStyle = '#ff0066';
  ctx.lineWidth = 2.6;
  ctx.globalAlpha = 0.95;
  ctx.beginPath();
  ctx.moveTo(stroke[0].x, stroke[0].y);
});

canvas.addEventListener('pointermove', (e) => {
  if (!stroke) return;
  const r = canvas.getBoundingClientRect();
  const p = { x: e.clientX - r.left, y: e.clientY - r.top };
  const last = stroke[stroke.length - 1];
  if (Math.hypot(p.x - last.x, p.y - last.y) < 2) return;
  stroke.push(p);
  ctx.lineTo(p.x, p.y);
  ctx.stroke();
});

canvas.addEventListener('pointerup', (e) => {
  if (!stroke) return;
  const pts = stroke;
  stroke = null;
  stroke = null;
  if (pts.length < 3) { fadeInk(); return; }
  commitStroke(pts);
});

canvas.addEventListener('pointercancel', () => { stroke = null; fadeInk(); });

function fadeInk() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function classify(pts) {
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, len = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    if (i) len += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
  }
  const w = maxX - minX, h = maxY - minY;
  const gap = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
  const closed = len > 0 && gap < len * 0.32;
  const straight = gap > 0 && len / gap < 1.2;

  if (w < 12 && h < 12) return { shape: 'dot', box: { x: minX, y: minY, w, h } };
  if (closed && h < 45 && w / Math.max(h, 1) > 2.4) return { shape: 'underline', box: { x: minX, y: minY, w, h } };
  if (closed) return { shape: 'circle', box: { x: minX, y: minY, w, h } };
  if (straight) return { shape: 'line', box: { x: minX, y: minY, w, h } };
  return { shape: 'freeform', box: { x: minX, y: minY, w, h } };
}

const TAG_SCORE = { H1: 6, H2: 6, H3: 5, H4: 5, P: 4, A: 4, BUTTON: 4, IMG: 5, LI: 3, LABEL: 3, SPAN: 2, INPUT: 4 };

function pickElement(pts) {
  const step = Math.max(1, Math.floor(pts.length / 12));
  const seen = new Set();
  let best = null, bestScore = -1;

  for (let i = 0; i < pts.length; i += step) {
    const el = doc.elementFromPoint(pts[i].x, pts[i].y);
    if (!el) continue;
    let node = el;
    for (let depth = 0; node && depth < 3; depth++) {
      if (seen.has(node) || SKIP.has(node.tagName) ||
          (node.classList && node.classList.contains('co-anchor'))) { node = node.parentElement; continue; }
      seen.add(node);
      const r = node.getBoundingClientRect();
      const area = Math.max(r.width * r.height, 1);
      const own = (node.innerText || '').trim();
      let score = (TAG_SCORE[node.tagName] || 1) + (own ? 2 : 0);
      if (node.tagName === 'BODY' || node.tagName === 'HTML') score = -1;
      score -= Math.min(area / 900000, 2);      // prefer the more specific box
      if (score > bestScore) { bestScore = score; best = node; }
      node = node.parentElement;
      if (bestScore >= 8) break;
    }
  }
  return best;
}

function anchor(el, label) {
  const r = el.getBoundingClientRect();
  const box = doc.createElement('div');
  box.className = 'co-anchor';
  box.dataset.label = label;
  box.style.left = (r.left + doc.documentElement.scrollLeft) + 'px';
  box.style.top = (r.top + doc.documentElement.scrollTop) + 'px';
  box.style.width = r.width + 'px';
  box.style.height = r.height + 'px';
  if (!doc.body) return;
  doc.body.appendChild(box);
  setTimeout(() => { box.style.opacity = '0'; setTimeout(() => box.remove(), 400); }, 2600);
}

function clearAnchors() {
  if (!doc) return;
  doc.querySelectorAll('.co-anchor').forEach((n) => n.remove());
}

function commitStroke(pts) {
  const { shape, box } = classify(pts);
  const el = pickElement(pts);
  if (!el) { fadeInk(); return; }

  const text = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const label = tagLabel(el).split('.')[0] + ' · ' + shape;
  anchor(el, label);

  marks.push({
    cid: el.dataset.cid || '',
    tag: tagLabel(el),
    text,
    shape,
    html: el.outerHTML.slice(0, 1200),
    rect: { w: Math.round(box.w), h: Math.round(box.h) },
  });

  addChip(label + ' · ' + (text ? '“' + text.slice(0, 26) + '…”' : 'element'));
  $('#hint').classList.add('gone');
  setTimeout(fadeInk, 420);
}

/* ---------------------------------------------------------------- transcript */

function addChip(label) {
  const box = $('#chunks');
  const chip = document.createElement('div');
  chip.className = 'mark-chip';
  chip.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path d="M4 20l4-1 10-10-3-3L5 16l-4-1Z" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/></svg><span></span>';
  chip.querySelector('span').textContent = label;
  box.appendChild(chip);
  scrollDown();
}

function stamp() {
  if (!startedAt) startedAt = Date.now();
  const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

function pushChunk(text, final) {
  if (!text) return;
  const box = $('#chunks');
  const last = box.lastElementChild;
  if (!final && last && last.classList.contains('interim')) {
    last.querySelector('.txt').textContent = text;
    scrollDown();
    return;
  }
  $('#empty').style.display = 'none';
  const el = document.createElement('div');
  el.className = 'chunk' + (final ? '' : ' interim');
  el.innerHTML = '<div class="meta"><span class="t"></span></div><div class="txt"></div>';
  el.querySelector('.t').textContent = stamp();
  el.querySelector('.txt').textContent = text;
  box.appendChild(el);
  if (final) {
    chunks.push({ t: stamp(), text, final: true });
    scheduleAuto();
  }
  scrollDown();
}

function scrollDown() {
  const s = $('#scroll');
  s.scrollTop = s.scrollHeight;
}

/* ---------------------------------------------------------------------- mic */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

/* auto mode: apply shortly after each finished sentence, so the page moves with the talk */
let autoOn = true;
let autoTimer = null;

function scheduleAuto() {
  if (!autoOn) return;
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    if (!applying && pendingWords() && chunks.length > appliedUpTo) apply();
  }, 1100);
}

function setAuto(on) {
  autoOn = on;
  $('#auto').classList.toggle('on', on);
  if (!on) clearTimeout(autoTimer);
}

$('#auto').addEventListener('click', () => setAuto(!autoOn));

function buildWave() {
  const w = $('#wave');
  if (w.children.length) return;
  for (let i = 0; i < 22; i++) w.appendChild(document.createElement('i'));
}

function tickWave() {
  const bars = $('#wave').children;
  for (const b of bars) {
    const h = micOn ? 3 + Math.random() * 13 : 3;
    b.style.height = h.toFixed(1) + 'px';
  }
}

function setMic(on) {
  micOn = on;
  $('#mic').classList.toggle('on', on);
  $('#mictxt').textContent = on ? 'LISTENING' : 'MIC OFF';
  $('#pulse').classList.toggle('on', on);
  $('#wave').classList.toggle('on', on);
  paintStatus(on ? 'listening…' : '');
  if (on) { startedAt = startedAt || Date.now(); } else { startedAt = 0; }
}

async function startMic() {
  if (!SR) {
    feed('speech recognition needs Chrome', 'err');
    return;
  }
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    feed('mic permission denied', 'err');
    return;
  }
  rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-US';
  rec.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      const txt = r[0].transcript.trim();
      if (r.isFinal) { pushChunk(txt, true); } else { interim += txt + ' '; }
    }
    if (interim) pushChunk(interim.trim(), false);
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      setMic(false); feed('mic blocked by browser', 'err');
    }
  };
  rec.onend = () => { if (micOn) { try { rec.start(); } catch (_) {} } };
  rec.start();
  setMic(true);
  buildWave();
}

function stopMic() {
  micOn = false;
  try { rec && rec.stop(); } catch (_) {}
  setMic(false);
}

$('#mic').addEventListener('click', () => (micOn ? stopMic() : startMic()));

/* -------------------------------------------------------------------- apply */

function pendingWords() {
  const spoken = chunks.slice(appliedUpTo).map((c) => c.text).join(' ').trim();
  return spoken;
}

async function apply(override) {
  if (applying) return;
  const typed = (override || $('#typed').value || '').trim();
  const instruction = typed || pendingWords();
  if (!instruction && !marks.length) {
    feed('nothing to apply yet — speak, draw, or type', 'err');
    return;
  }

  if (typed) pushChunk(typed, true);   // typed instructions join the transcript
  applying = true;
  $('#apply').disabled = true;
  $('#pulse').classList.add('on');
  const t0 = performance.now();
  $('#latency').textContent = 'thinking…';
  paintStatus('applying change…');

  try {
    const res = await fetch('/api/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instruction,
        marks: marks.map((m) => ({ cid: m.cid, tag: m.tag, text: m.text, shape: m.shape, html: m.html })),
        outline: outlineText(),
        history: history.slice(-4),
      }),
    });
    const data = await res.json();
    const ms = Math.round(performance.now() - t0);

    if (!res.ok || data.error) throw new Error(data.error || 'model error');

    const n = applyOps(data.ops || []);
    const secs = (ms / 1000).toFixed(2);
    const who = (data.provider === 'groq' ? 'groq' : data.provider || '') +
                ' ' + shortModel(data.model);
    $('#latency').textContent = secs + 's · ' + who.trim();
    if (data.reasoning) history.push(data.reasoning);
    feed('<b>→</b> ' + (data.reasoning || '(no reasoning)') +
         ' <span class="ok">' + n + ' op' + (n === 1 ? '' : 's') + ' · ' + secs + 's · ' +
         who.replace('&', '&amp;') + '</span>');

    marks = [];
    clearAnchors();
    $('#hint').classList.add('gone');
    appliedUpTo = chunks.length;
    if (typed) $('#typed').value = '';
    stampCids();
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    $('#latency').textContent = (ms / 1000).toFixed(2) + 's · failed';
    feed((err.message || 'failed').toString().slice(0, 160), 'err');
  } finally {
    applying = false;
    $('#apply').disabled = false;
    $('#pulse').classList.remove('on');
    paintStatus(micOn ? 'listening…' : '');
  }
}

function shortModel(m) {
  return (m || '').replace('google/', '').replace('anthropic/', '').replace('-preview', '');
}

const CAMEL = /[A-Z]/;

function toKebab(k) {
  return CAMEL.test(k) ? k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()) : k;
}

function applyOps(ops) {
  let n = 0;
  let first = null;
  for (const op of ops) {
    const el = doc && doc.querySelector('[data-cid="' + op.cid + '"]');
    if (!el) continue;
    if (!first) first = el;
    try {
      if (op.op === 'style' && op.props) {
        for (const k in op.props) el.style.setProperty(toKebab(k), op.props[k]);
      } else if (op.op === 'text' && typeof op.text === 'string') {
        el.textContent = op.text;
      } else if (op.op === 'html' && typeof op.html === 'string') {
        el.innerHTML = op.html;
        stampCids();
      } else if (op.op === 'attr' && op.props) {
        for (const k in op.props) el.setAttribute(k, op.props[k]);
      } else if (op.op === 'cls') {
        if (op.add) op.add.split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
        if (op.remove) op.remove.split(/\s+/).filter(Boolean).forEach((c) => el.classList.remove(c));
      } else { continue; }
      n++;
      el.classList.add('co-flash');
      setTimeout(() => el.classList.remove('co-flash'), 950);
    } catch (_) {}
  }
  // bring the changed element into view so the audience sees what moved
  try {
    if (first) {
      const r = first.getBoundingClientRect();
      const vh = iframe.clientHeight;
      if (r.bottom < 60 || r.top > vh - 40) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  } catch (_) {}
  return n;
}

function feed(html, cls) {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.innerHTML = html;
  $('#feed').appendChild(d);
  $('#feed').scrollTop = $('#feed').scrollHeight;
}

$('#apply').addEventListener('click', () => apply());
$('#typed').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); apply(); }
});
document.addEventListener('keydown', (e) => {
  if (entryOpen()) {
    if (e.key === 'Escape' && pageHost) hideEntry();
    return;                       // typing a URL must not toggle the mic
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); apply(); }
  if (e.target === $('#typed')) return;
  if (e.key === 'd' || e.key === 'D') toggleDraw();
  if (e.key === 'm' || e.key === 'M') (micOn ? stopMic() : startMic());
  if (e.key === 'a' || e.key === 'A') setAuto(!autoOn);
});

/* ---------------------------------------------------------- toolbar actions */

function toggleDraw() {
  drawOn = !drawOn;
  $('#draw').classList.toggle('on', drawOn);
  canvas.classList.toggle('armed', drawOn);
  $('#hint').classList.toggle('gone', drawOn || marks.length > 0);
  if (!drawOn) fadeInk();
}

$('#draw').addEventListener('click', toggleDraw);

function resetWorkspace() {
  marks = [];
  history = [];
  chunks = [];
  appliedUpTo = 0;
  startedAt = 0;
  $('#chunks').innerHTML = '';
  $('#feed').innerHTML = '';
  $('#latency').textContent = '';
  $('#clock').textContent = '00:00';
  const e = $('#empty');
  if (e) e.style.display = '';
}

$('#reset').addEventListener('click', () => {
  resetWorkspace();
  iframe.src = '/site?v=' + Date.now();
  feed('page reset to the imported original');
});

function serialize() {
  const clone = doc.documentElement.cloneNode(true);
  clone.querySelectorAll('.co-anchor').forEach((n) => n.remove());
  clone.querySelectorAll('[data-cid]').forEach((n) => {
    n.removeAttribute('data-cid');
    n.classList.remove('co-flash');
  });
  return '<!DOCTYPE html>\n' + clone.outerHTML;
}

$('#export').addEventListener('click', () => {
  const blob = new Blob([serialize()], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'calliope-' + (pageHost || 'page') + '.html';
  a.click();
  URL.revokeObjectURL(a.href);
  feed('exported the edited page');
});

$('#publish').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: serialize() }),
    });
    const data = await res.json();
    if (data.ok) feed('staged → <span class="ok">' + data.file + '</span> · view at /published');
    else feed(data.error || 'publish failed', 'err');
  } catch (e) {
    feed('publish failed', 'err');
  }
});

/* ------------------------------------------------------------------ importing */

const entry = $('#entry');
const urlField = $('#url');

function entryOpen() { return !entry.classList.contains('gone'); }

function showEntry(prefill) {
  entry.classList.remove('gone');
  urlField.value = prefill || pageUrl || '';
  setTimeout(() => { urlField.focus(); urlField.select(); }, 80);
}

function hideEntry() {
  entry.classList.add('gone');
  $('#urlerr').textContent = '';
}

async function loadPage(rawUrl) {
  const btn = $('#load');
  const err = $('#urlerr');
  const url = (rawUrl || '').trim();
  err.textContent = '';
  if (!url) { err.textContent = 'paste a link first'; urlField.focus(); return; }

  btn.classList.add('busy');
  btn.textContent = 'Importing…';
  $('.urlrow').classList.add('busy');

  try {
    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'import failed');

    pageHost = data.host || '';
    pageUrl = data.url || url;
    paintStatus();
    hideEntry();
    resetWorkspace();
    iframe.src = '/site?v=' + Date.now();
    feed('imported <b>' + pageHost + '</b> · ' +
         Math.round(data.bytes / 1024) + ' KB · ' + data.words + ' words · ' + data.ms + 'ms');
  } catch (e) {
    err.textContent = e.message;
    btn.classList.remove('busy');
    btn.textContent = 'Import';
    $('.urlrow').classList.remove('busy');
    return;
  }

  btn.classList.remove('busy');
  btn.textContent = 'Import';
  $('.urlrow').classList.remove('busy');
}

$('#urlform').addEventListener('submit', (e) => {
  e.preventDefault();
  loadPage(urlField.value);
});

document.querySelectorAll('.chip').forEach((c) => {
  c.addEventListener('click', () => {
    urlField.value = c.dataset.url;
    loadPage(c.dataset.url);
  });
});

$('#newlink').addEventListener('click', () => showEntry());

/* ------------------------------------------------------------------ ambient */

setInterval(tickWave, 110);
setInterval(() => {
  if (micOn) $('#clock').textContent = stamp();
}, 500);

buildWave();
sizeCanvas();
setAuto(true);

(async function boot() {
  try {
    const meta = await (await fetch('/api/meta')).json();
    if (meta.imported) {
      pageHost = meta.host || '';
      pageUrl = meta.url || '';
      paintStatus();
      hideEntry();
      iframe.src = '/site?v=' + Date.now();
    } else {
      showEntry();
    }
  } catch (_) {
    showEntry();
  }
})();

setTimeout(() => $('#hint').classList.add('gone'), 6000);
