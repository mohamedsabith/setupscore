import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli.ts', index: 'src/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  dts: { entry: { index: 'src/index.ts' } },
  sourcemap: false,
  clean: true,
  splitting: true,
  shims: false,
  // Installed on first use into setupscore's cache, never bundled (see src/sandbox/runtime.ts).
  external: ['@anthropic-ai/sandbox-runtime'],
});
