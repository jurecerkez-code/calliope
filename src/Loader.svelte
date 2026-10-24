<script>
  import { onMount } from 'svelte';
  import './loader.css';
  let canvas = $state(null);
  let visible = $state(true);
  let fading = $state(false);
  let threeDimensional = $state(false);
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
      advance(Math.min(92, 8 + 84 * (1 - (1 - t) * (1 - t))));
    }, 120);
    const onKey = event => {
      if (['Enter', ' ', 'Escape'].includes(event.key)) finish();
    };
    window.addEventListener('keydown', onKey);
    const loaderUrl = '/loader3d.js';
    import(/* @vite-ignore */ loaderUrl).then(module => module.start(canvas, () => {
      threeDimensional = true;
      advance(100);
      finish();
    })).catch(() => {});
    return () => { clearTimeout(fallback); clearInterval(barTimer); window.removeEventListener('keydown', onKey); };
  });
</script>

{#if visible}
  <div id="vd-loader" class:vd-out={fading} class:vd-3d={threeDimensional} onclick={finish} onkeydown={event => { if (['Enter', ' '].includes(event.key)) finish(); }} role="button" tabindex="0" aria-label="Skip Calliope loading screen">
    <div class="vd-stage">
      <canvas id="vd3d" bind:this={canvas}></canvas>
      <div class="vd-tiles" aria-hidden="true">
        <div class="vd-tile"><img src="/assets/render-jamiej.png" alt=""></div>
        <div class="vd-tile"><img src="/assets/render-reson8.png" alt=""></div>
        <div class="vd-tile"><img src="/assets/render-techeurope.png" alt=""></div>
        <div class="vd-tile"><img src="/assets/render-anthropica.png" alt=""></div>
      </div>
    </div>
    <h1 class="vd-title">CALLIOPE</h1>
    <p class="vd-sub">SPEAK + DRAW ON THE WEBSITE // THE AGENT SEES BOTH</p>
    <div class="vd-bar"><i id="vdProg" style="width:{progress}%"></i></div>
    <p class="vd-status">LOADING THE STUDIO</p>
    <p class="vd-skip">CLICK ANYWHERE TO SKIP</p>
  </div>
{/if}
