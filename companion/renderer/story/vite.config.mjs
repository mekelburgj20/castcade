// I11.4.1 (2026-11-16): the dev server for the story pages in this folder (watch.html: the 3D watch card in each of its
// states). Unlike companion/vite.config.ts it starts no Electron, and it listens on 127.0.0.1 only. Never part of a
// build: `vite build` reads companion/vite.config.ts, whose only input is renderer/index.html.
//
//   cd companion && npx vite --config renderer/story/vite.config.mjs
//   http://127.0.0.1:5199/story/watch.html?state=idle   (the states: watch-story.tsx, STATES)
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(here, '..'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5199, strictPort: true, open: false },
});
