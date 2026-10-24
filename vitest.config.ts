import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@revlyra/core': r('./packages/core/src/index.ts'),
      revlyra: r('./packages/revlyra/src/index.ts'),
      '@revlyra/sdk': r('./packages/sdk/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/index.ts', '**/types.ts'],
    },
  },
});
