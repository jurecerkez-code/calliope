import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
export default defineConfig({
  root: 'frontend',
  plugins: [svelte()],
  resolve: { alias: { '/src': new URL('./src', import.meta.url).pathname } },
  build: { outDir: '../dist', emptyOutDir: true, assetsDir: 'assets' }
});
