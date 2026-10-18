import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against sources, so no build step is needed before `vitest`.
    alias: {
      '@castcade/protocol': src('./protocol/src/index.ts'),
      '@castcade/companion': src('./companion/src/index.ts'),
    },
  },
  test: {
    include: ['protocol/**/*.test.ts', 'companion/**/*.test.ts', 'fakeclient/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**'],
    testTimeout: 20_000,
  },
});
