/**
 * Vite config for the renderer. `vite build` writes the bundle to `dist/renderer/`, which the main
 * process loads in production. `vite` (dev server) also spawns Electron pointed at the server via
 * CASTCADE_RENDERER_URL, so `npm run dev` is one command; closing the window stops the server.
 */
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';

const companionDir = dirname(fileURLToPath(import.meta.url));

function launchElectron(): Plugin {
  return {
    name: 'castcade:launch-electron',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      server.httpServer?.once('listening', () => {
        const address = server.httpServer?.address();
        const port = typeof address === 'object' && address ? address.port : 5173;
        const url = `http://localhost:${port}/`;
        const child = spawn(String(electronPath), ['.'], {
          cwd: companionDir,
          stdio: 'inherit',
          env: { ...process.env, CASTCADE_RENDERER_URL: url },
        });
        child.on('exit', (code) => {
          void server.close().then(() => process.exit(code ?? 0));
        });
      });
    },
  };
}

export default defineConfig({
  root: 'renderer',
  base: './',
  plugins: [react(), launchElectron()],
  build: {
    outDir: '../dist/renderer',
    emptyOutDir: true,
    sourcemap: true,
    // The Arcaid look (2026-11-25): every font, carpet tile and icon is a file of its own, never a `data:` URL, which
    // the window's Content-Security-Policy (default-src 'self', renderer/index.html) would refuse.
    assetsInlineLimit: 0,
    rollupOptions: {
      // The kit's `.aw-screen` rule (renderer/src/aw-theme/aw-theme.css, verbatim) names the Arcaid Witness background
      // picture. Castcade never ships or shows it (its ground is the carpet): that one URL is left as it is.
      external: [/arcaid-witness-background/],
    },
  },
});
