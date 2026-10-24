<!-- Local shadcn-svelte Button adaptation: https://www.shadcn-svelte.com/docs/components/button ; Bits UI Button.Root API https://bits-ui.com/docs/components/button -->
<script>
  import { Button as Primitive } from 'bits-ui';
  let { variant = 'default', children, ...rest } = $props();
</script>
<Primitive.Root {...rest} class={variant === 'amber' ? 'amber' : variant === 'recording' ? 'rec-on' : ''}>{@render children?.()}</Primitive.Root>
