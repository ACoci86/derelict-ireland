// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
// Deployed to GitHub Pages under https://acoci86.github.io/derelict-ireland/,
// so the site is served from the "/derelict-ireland" base path.
export default defineConfig({
  site: 'https://acoci86.github.io',
  base: '/derelict-ireland',
});
