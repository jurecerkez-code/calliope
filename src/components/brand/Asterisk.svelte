<!-- The primary brand signal: six arms, round ends. -->
<script>
  let { size = 16, color = 'currentColor', weight = 2.4, label = '' } = $props();
</script>
<svg class="asterisk" width={size} height={size} viewBox="0 0 24 24" role={label ? 'img' : undefined} aria-label={label || undefined} aria-hidden={label ? undefined : 'true'}>
  <path d="M12 2.5v19M3.8 7.25l16.4 9.5M3.8 16.75l16.4-9.5" fill="none" stroke={color} stroke-width={weight} stroke-linecap="round" />
</svg>

<style>
  .asterisk { display: inline-block; vertical-align: middle; flex: none; }
</style>
