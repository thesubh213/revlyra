import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/server/index.ts', 'src/cli/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node22',
  platform: 'node',
  splitting: false,
  treeshake: true,
  external: ['@revlyra/core', 'pg', 'mysql2', 'mongodb', 'sharp'],
});
