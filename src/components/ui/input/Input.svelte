<!-- Local shadcn-svelte Input adaptation: https://www.shadcn-svelte.com/docs/components/input (Input is a styled native input in the registry). -->
<script>
  let { value = $bindable(''), ...rest } = $props();
</script>
<input bind:value {...rest} />
