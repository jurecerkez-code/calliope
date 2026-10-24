<!-- One clock, three lanes. Every mark, word and reference sits where it happened. -->
<script>
  import Asterisk from './brand/Asterisk.svelte';
  let { marks = [], utterances = [], now = 0, fmt } = $props();
  const STEPS = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000];
  // the scale covers every mark and word, so nothing said or drawn falls off the end
  const latest = $derived(Math.max(now, ...marks.map(m => m.endMs), ...utterances.map(u => u.endMs)));
  const span = $derived(Math.max(10000, Math.ceil((latest + 500) / 1000) * 1000));
  const step = $derived(STEPS.find(s => span / s <= 6) || STEPS.at(-1));
  const ticks = $derived(Array.from({ length: Math.floor(span / step) + 1 }, (_, i) => i * step));
  const pct = ms => Math.min(100, Math.max(0, ms / span * 100));
  const refs = $derived(utterances.flatMap(u => u.references));
  const lastRef = $derived(refs.findLast(r => r.strokeId));
  const last = $derived(utterances.at(-1));
  // a deterministic little waveform per word, so speech reads as sound, not as a bar
  const bars = text => { let h = 7; for (const c of text) h = (h * 31 + c.charCodeAt(0)) % 9973; return [0, 1, 2, 3, 4].map(i => 25 + ((h >> (i * 2)) % 8) * 10); };
</script>

<div class="tl">
  <div class="axis"><span></span><div class="scale">{#each ticks as t}<span style="left:{pct(t)}%">{fmt(t)}</span>{/each}</div></div>
  <div class="lane">
    <span class="name"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l4.2-.9L19 8.3a2.1 2.1 0 0 0-3-3L5.2 16.1 4 20z" /></svg>Drawing</span>
    <div class="track draw">
      {#each marks as m (m.id)}
        <i class="span" style="left:{pct(m.startMs)}%;width:{Math.max(.4, pct(m.endMs) - pct(m.startMs))}%"></i>
        <i class="dot" style="left:{pct(m.startMs)}%"></i><i class="dot" style="left:{pct(m.endMs)}%"></i>
      {/each}
      {#if lastRef}<span class="star" style="left:{pct(lastRef.atMs)}%"><Asterisk size={18} weight={2.6} /></span>{/if}
    </div>
  </div>
  <div class="lane">
    <span class="name"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 10v4M9 7v10M13 4v16M17 8v8M21 11v2" /></svg>Speech</span>
    <div class="track speech">
      {#each utterances as u (u.id)}
        {#each u.words as w}
          <span class="word" style="left:{pct(w.startMs)}%;width:{Math.max(.5, pct(w.endMs) - pct(w.startMs))}%">{#each bars(w.text) as h}<b style="height:{h}%"></b>{/each}</span>
        {/each}
      {/each}
      {#if last}<span class="bubble" style="left:{pct((last.startMs + last.endMs) / 2)}%">"{last.text}"</span>{/if}
    </div>
  </div>
  <div class="lane">
    <span class="name"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>References</span>
    <div class="track refs">{#each refs as r, i (i)}<i class="dot" class:bound={r.strokeId} style="left:{pct(r.atMs)}%" title={r.word || 'nearest in time'}></i>{/each}</div>
  </div>
  <i class="head" style="left:calc(96px + (100% - 96px) * {pct(now) / 100})"></i>
</div>

<style>
  .tl { position: relative; display: grid; gap: 4px; }
  .axis, .lane { display: grid; grid-template-columns: 96px 1fr; align-items: center; }
  .scale { position: relative; height: 18px; font: 11px var(--mono); color: var(--muted); }
  .scale span { position: absolute; transform: translateX(-50%); }
  .scale span:first-child { transform: none; }
  .name { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink); }
  .name svg { width: 16px; height: 16px; fill: none; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .lane:nth-of-type(2) svg { stroke: var(--red); }
  .lane:nth-of-type(3) svg { stroke: var(--blue); }
  .lane:nth-of-type(4) svg { stroke: var(--muted); }
  .track { position: relative; height: 38px; }
  .track::before { content: ''; position: absolute; left: 0; right: 0; top: 50%; border-top: 1px dotted var(--rule-2); }
  .draw::before { border-top-color: rgba(254, 42, 0, .35); }
  .speech::before { border-top-color: rgba(47, 95, 174, .35); }
  .span { position: absolute; top: calc(50% - 1px); height: 2px; background: var(--red); }
  .dot { position: absolute; top: 50%; width: 8px; height: 8px; margin: -4px 0 0 -4px; border-radius: 50%; background: var(--red); }
  .refs .dot { background: var(--muted); width: 6px; height: 6px; margin: -3px 0 0 -3px; }
  .refs .dot.bound { background: var(--red); }
  .star { position: absolute; top: 50%; transform: translate(-50%, -50%); width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; color: var(--red); border: 1.5px solid var(--red); background: var(--panel); }
  .word { position: absolute; top: 15%; height: 70%; display: flex; align-items: center; justify-content: space-around; gap: 1px; }
  .word b { width: 2px; border-radius: 1px; background: var(--blue); }
  .bubble { position: absolute; top: 50%; transform: translate(-50%, -50%); max-width: 70%; padding: 3px 10px; border-radius: 999px; background: var(--panel); border: 1px solid var(--blue); color: var(--blue); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .head { position: absolute; top: 18px; bottom: 0; width: 1px; background: var(--ink); opacity: .25; }
</style>
