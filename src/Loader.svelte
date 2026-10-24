<script>
  import { onMount } from 'svelte';
  import './loader.css';
  let visible = $state(true);
  let fading = $state(false);
  let progress = $state(8);
  const advance = to => { progress = Math.max(progress, to); };
  function finish() {
    if (fading) return;
    fading = true;
    setTimeout(() => visible = false, 700);
  }
  onMount(() => {
    const fallback = setTimeout(finish, 4500);
    const startedAt = performance.now();
    const barTimer = setInterval(() => {
      const t = Math.min(1, (performance.now() - startedAt) / 4500);
      advance(Math.min(100, 8 + 92 * (1 - (1 - t) * (1 - t))));
      if (t === 1) finish();
    }, 120);
    const onKey = event => {
      if (['Enter', ' ', 'Escape'].includes(event.key)) finish();
    };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(fallback); clearInterval(barTimer); window.removeEventListener('keydown', onKey); };
  });
</script>

{#if visible}
  <div id="vd-loader" class:vd-out={fading} onclick={finish} onkeydown={event => { if (['Enter', ' '].includes(event.key)) finish(); }} role="button" tabindex="0" aria-label="Skip the Calliope intro">
    <img class="vd-muse" src="/assets/muse.png" alt="" />
    <div class="vd-copy">
      <p class="vd-kicker">human → machine <span>/</span> open innovation 2026</p>
      <div class="vd-mark">
        <img class="vd-logo" src="/assets/calliope-logo.png" alt="Calliope" />
        <svg class="vd-circle" viewBox="0 0 200 90" aria-hidden="true"><path d="M152 17C118 3 44 5 17 31 1 47 26 76 98 79c66 3 101-17 90-44-8-19-40-27-74-23" /></svg>
      </div>
      <p class="vd-line">Draw where.<br />Speak why.</p>
      <p class="vd-sub">a muse for machines.</p>
      <p class="vd-credits">source: reson8 · reasoning: anthropic · {'{Tech: Europe}'}</p>
    </div>
    <div class="vd-bar" aria-hidden="true"><i style="width:{progress}%"></i></div>
    <p class="vd-skip">click anywhere to skip</p>
  </div>
{/if}
