/* Paste a link -> the site's real HTML appears. That is the whole file. */

const $ = (s) => document.querySelector(s);
const entry = $('#entry');
const iframe = $('#site');
const urlField = $('#url');
let pageUrl = '';

const entryOpen = () => !entry.classList.contains('gone');

function showEntry(prefill) {
  entry.classList.remove('gone');
  urlField.value = prefill || pageUrl || '';
  setTimeout(() => { urlField.focus(); urlField.select(); }, 80);
}

function hideEntry() {
  entry.classList.add('gone');
  $('#urlerr').textContent = '';
}

async function loadPage(raw) {
  const btn = $('#load');
  const err = $('#urlerr');
  const url = (raw || '').trim();
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

    pageUrl = data.url || url;
    $('#host').textContent = data.host;
    $('#stat').textContent =
      Math.round(data.bytes / 1024) + ' KB · ' + data.words + ' words · ' +
      data.scripts_removed + ' scripts stripped · ' + data.ms + 'ms';

    hideEntry();
    iframe.src = '/site?v=' + Date.now();
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.classList.remove('busy');
    btn.textContent = 'Import';
    $('.urlrow').classList.remove('busy');
  }
}

/* A page that builds itself in the browser arrives as an empty shell. Say so
   instead of showing a blank rectangle and letting the user blame the link. */
iframe.addEventListener('load', () => {
  const doc = iframe.contentDocument;
  if (!doc) return;
  setTimeout(() => {
    const chars = (doc.body ? doc.body.innerText : '').replace(/\s+/g, ' ').trim().length;
    const warn = $('#warn');
    if (chars < 120) {
      warn.textContent = 'This page arrived almost empty — it builds itself in the browser, so what came back is just a shell. Try a server-rendered site.';
      warn.classList.add('on');
    } else {
      warn.classList.remove('on');
    }
  }, 300);
});

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

document.addEventListener('keydown', (e) => {
  if (entryOpen()) {
    if (e.key === 'Escape' && pageUrl) hideEntry();
  }
});

/* If a page was imported on a previous run, go straight to it. */
(async function boot() {
  try {
    const meta = await (await fetch('/api/meta')).json();
    if (meta.imported) {
      pageUrl = meta.url || '';
      $('#host').textContent = meta.host || 'page';
      $('#stat').textContent =
        Math.round(meta.bytes / 1024) + ' KB · ' + meta.words + ' words · ' +
        (meta.scripts_removed || 0) + ' scripts stripped';
      hideEntry();
      iframe.src = '/site?v=' + Date.now();
    } else {
      showEntry();
    }
  } catch (_) {
    showEntry();
  }
})();
