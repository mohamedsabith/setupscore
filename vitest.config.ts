import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 300_000, // run tests drive whole runs; machines under load need room
    // `npm run coverage`. Tests that start dist/cli.js as a separate process are not counted,
    // so the numbers for the commands (cli, run, tasks, report) are lower than what is really tested.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
});
