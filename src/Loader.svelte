<script>
  import { onMount } from 'svelte';
  import './loader.css';
  let visible = $state(true);
  let fading = $state(false);
  function finish() {
    if (fading) return;
    fading = true;
    setTimeout(() => visible = false, 700);
  }
  onMount(() => {
    const auto = setTimeout(finish, 2600);
    const onKey = event => {
      if (['Enter', ' ', 'Escape'].includes(event.key)) finish();
    };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(auto); window.removeEventListener('keydown', onKey); };
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
    <p class="vd-skip">click anywhere to skip</p>
  </div>
{/if}
