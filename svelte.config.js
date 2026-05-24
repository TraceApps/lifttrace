import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess(),
  // Svelte 5 compat shim — keep treating the codebase as Svelte 4.
  // `componentApi: 4` makes `new App({...})` work (Svelte 5's new default
  // is to expect mount() instead of `new`). `runes: false` forces every
  // file into legacy reactive mode regardless of script content.
  compilerOptions: {
    runes: false,
    compatibility: { componentApi: 4 },
  },
};
