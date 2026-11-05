import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 300_000, // run tests drive whole runs; machines under load need room
  },
});
