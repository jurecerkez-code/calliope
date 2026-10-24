<!-- Local shadcn-svelte Button adaptation: https://www.shadcn-svelte.com/docs/components/button ; Bits UI Button.Root API https://bits-ui.com/docs/components/button -->
<script>
  import { Button as Primitive } from 'bits-ui';
  let { variant = 'default', class: extra = '', children, ...rest } = $props();
  const VARIANTS = { amber: 'primary', primary: 'primary', recording: 'rec-on', ghost: 'ghost' };
</script>
<Primitive.Root {...rest} class={['btn', VARIANTS[variant] || '', extra].filter(Boolean).join(' ')}>{@render children?.()}</Primitive.Root>
