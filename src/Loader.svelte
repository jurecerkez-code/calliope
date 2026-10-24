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
    setTimeout(() => visible = false, 850);
  }
  onMount(() => {
    const fallback = setTimeout(finish, 9000);
    const startedAt = performance.now();
    const barTimer = setInterval(() => {
      const t = Math.min(1, (performance.now() - startedAt) / 4500);
      advance(8 + 92 * (1 - (1 - t) * (1 - t)));
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
  <div id="vd-loader" class:vd-out={fading} onclick={finish} onkeydown={event => { if (['Enter', ' '].includes(event.key)) finish(); }} role="button" tabindex="0" aria-label="Skip Calliope loading screen">
    <div class="vd-stage">
      <div class="vd-tiles" aria-hidden="true">
        <div class="vd-tile"></div>
        <div class="vd-tile"></div>
        <div class="vd-tile"></div>
        <div class="vd-tile"></div>
      </div>
    </div>
    <h1 class="vd-title">CALLIOPE</h1>
    <p class="vd-sub">SPEAK + DRAW ON THE WEBSITE // THE AGENT SEES BOTH</p>
    <div class="vd-bar"><i id="vdProg" style="width:{progress}%"></i></div>
    <p class="vd-status">LOADING THE STUDIO</p>
    <p class="vd-skip">CLICK ANYWHERE TO SKIP</p>
  </div>
{/if}
