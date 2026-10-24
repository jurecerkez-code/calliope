<script>
  // Three lanes on one clock: MARKS (drawn strokes), WORDS (spoken words, deictics amber),
  // LINKS (dotted line from each pointing word to the mark it binds to).
  let { data } = $props();
  const W = 320, H = 96, X0 = 34, X1 = 312;
  const Y = {marks: 22, words: 52, links: 78};
  function geometry() {
    const items = [
      ...data.marks.map(m => ({s: m.startMs, e: m.endMs})),
      ...data.words.map(w => ({s: w.startMs, e: w.startMs})),
      ...data.links.map(l => ({s: l.atMs, e: l.atMs}))
    ];
    const end = items.length ? Math.max(...items.map(i => i.e), ...items.map(i => i.s)) + 2000 : 60000;
    const start = Math.min(end - 5000, (items.length ? Math.min(...items.map(i => i.s)) : end - 60000));
    const span = Math.max(1000, end - start);
    const x = ms => X0 + ((ms - start) / span) * (X1 - X0);
    return {x, end, start};
  }
  let g = $derived(geometry());
</script>

<svg viewBox="0 0 {W} {H}" role="img" aria-label="Marks, words and links timeline">
  <text x="4" y="{Y.marks - 6}" class="lane-label">MARKS</text>
  <text x="4" y="{Y.words - 6}" class="lane-label">WORDS</text>
  <text x="4" y="{Y.links - 6}" class="lane-label">LINKS</text>
  <line x1="{X0}" y1="{Y.marks}" x2="{X1}" y2="{Y.marks}" class="lane" />
  <line x1="{X0}" y1="{Y.words}" x2="{X1}" y2="{Y.words}" class="lane" />
  <line x1="{X0}" y1="{Y.links}" x2="{X1}" y2="{Y.links}" class="lane" />
  {#each data.marks as m (m.label + m.startMs)}
    <rect x="{g.x(m.startMs)}" y="{Y.marks - 7}" width="{Math.max(2, g.x(m.endMs) - g.x(m.startMs))}" height="14" class="mark" />
    <text x="{g.x(m.startMs) + 3}" y="{Y.marks + 4}" class="mark-id">{m.label}</text>
  {/each}
  {#each data.words as w, i (i + '-' + w.startMs)}
    <line x1="{g.x(w.startMs)}" y1="{Y.words - 7}" x2="{g.x(w.startMs)}" y2="{Y.words + 7}" class="word" class:deictic={w.deictic} />
  {/each}
  {#each data.links as l, i (i + '-' + l.atMs)}
    {#if !l.unbound}
      <line x1="{g.x(l.atMs)}" y1="{Y.links}" x2="{g.x(l.atMs)}" y2="{Y.words + 7}" class="ref-link" />
    {/if}
    <circle cx="{g.x(l.atMs)}" cy="{Y.links}" r="3" class="ref" class:none={l.unbound} />
  {/each}
  <line x1="{X1}" y1="10" x2="{X1}" y2="{H - 6}" class="now" />
  <text x="{X1 - 2}" y="{H - 10}" class="tick-label" text-anchor="end">NOW</text>
</svg>

<style>
  svg{display:block;width:100%;height:auto;}
  .lane{stroke:#16302a;}
  .lane-label,.tick-label{fill:#6f8f84;font-size:8px;letter-spacing:.12em;}
  .mark{fill:#37ff8b;}
  .mark-id{fill:#040505;font-size:8px;font-weight:700;}
  .word{stroke:#4cc9f0;}
  .word.deictic{stroke:#ffd166;stroke-width:2;}
  .ref{fill:#ffd166;}
  .ref.none{fill:#6f8f84;}
  .ref-link{stroke:#ffd166;stroke-dasharray:2 2;opacity:.7;}
  .now{stroke:#ff3b30;}
</style>
