<!-- Line icons, 24px grid. The trumpet is the voice: Calliope's herald, not a generic mic. -->
<script>
  let { name, size = 20 } = $props();
  const PATHS = {
    pen: 'M4 20l4.2-.9L19 8.3a2.1 2.1 0 0 0-3-3L5.2 16.1 4 20z M14.5 6.8l2.9 2.9',
    mark: 'M7 14.5l6.8-10 5 3.4-6.8 10z M7 14.5l-1.6 3.3 3.9.6 2.6-1.4 M4 21h16',
    mic: 'M12 3.5a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0v-5a3 3 0 0 0-3-3z M5.5 11a6.5 6.5 0 0 0 13 0 M12 17.5v3',
    erase: 'M20 20H9.5L4.6 15.1a1.6 1.6 0 0 1 0-2.2l8.3-8.3a1.6 1.6 0 0 1 2.2 0l4.3 4.3a1.6 1.6 0 0 1 0 2.2L12 18.6 M8 11.5l5.5 5.5',
    undo: 'M9 14L4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
    copy: 'M9 9h10.5v11H9z M15 9V4H4.5v11H9',
    trumpet: 'M2.5 12h2.5 M5 10.6v2.8 M5 12h8.5 M7.6 12V8.9 M10.2 12V8.9 M6.6 8.9h2 M9.2 8.9h2 M13.5 10.9c3-.3 5.2-2 7.5-4.6v11.4c-2.3-2.6-4.5-4.3-7.5-4.6z',
    dom: 'M8 7l-5 5 5 5 M16 7l5 5-5 5 M13.5 5l-3 14',
    canvas: 'M4 4.5h16v15H4z M7.5 15.5c2.5-5 5-5 9-7'
  };
</script>
<svg class="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
  <path d={PATHS[name]} fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
</svg>

<style>
  .icon { display: block; flex: none; }
</style>
