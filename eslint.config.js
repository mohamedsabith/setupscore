// Strict, type-aware lint rules for setupscore. Run with `npm run lint`.
// Based on reports/Setupscore code quality tooling plan.md (research, November 2026).
// Every change from a preset below is deliberate and explained; don't relax more without a reason.
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import js from '@eslint/js';
import vitest from '@vitest/eslint-plugin';
import { defineConfig } from 'eslint/config';
import n from 'eslint-plugin-n';
import regexp from 'eslint-plugin-regexp';
import { fileURLToPath } from 'node:url';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/', 'coverage/', 'node_modules/', 'examples/', 'research_notes/', 'reports/'] },
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  js.configs.recommended,

  // Every eslint-disable comment must say why ("-- reason").
  comments.recommended,
  {
    rules: {
      '@eslint-community/eslint-comments/require-description': 'error',
      // A file-wide exception (with its reason at the top) needs no matching enable comment.
      '@eslint-community/eslint-comments/disable-enable-pair': ['error', { allowWholeFile: true }],
    },
  },

  // Regular expressions: setupscore runs hundreds of them on users' files. The two
  // "super-linear" rules catch ReDoS (a crafted file that makes a regex run for minutes).
  // Never add them to eslint-suppressions.json: every finding must be fixed.
  regexp.configs['flat/recommended'],
  {
    rules: {
      'regexp/no-super-linear-backtracking': 'error',
      'regexp/no-super-linear-move': 'error',
    },
  },

  // Node.js: no APIs newer than the "engines" range in package.json allows.
  n.configs['flat/recommended-module'],
  {
    settings: {
      // The published files are dist/*.js, built from src/*.ts.
      n: { convertPath: { 'src/**/*.ts': ['^src/(.+)\\.ts$', 'dist/$1.js'] }, tryExtensions: ['.ts', '.js'] },
    },
    rules: {
      // Imports are checked by TypeScript (it knows the .js -> .ts mapping and the types).
      'n/no-missing-import': 'off',
      'n/no-unpublished-import': 'off',
    },
  },
  {
    // The CLI entry point and the signal handler exit on purpose, with the documented exit codes.
    files: ['src/cli.ts', 'src/core/lifecycle.ts'],
    rules: { 'n/no-process-exit': 'off' },
  },

  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: fileURLToPath(new URL('.', import.meta.url)) },
    },
    rules: {
      // tsconfig has noUncheckedIndexedAccess, so every list[i] is "maybe undefined" and code uses `!`
      // right after it has checked the index. Rewriting those reads adds branches, not safety.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Numbers and booleans in messages ("3 warnings") are intended; objects and undefined stay errors.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      // Types describe well-formed data, but setupscore reads users' files, which can be anything.
      // Checks that the types call "unnecessary" guard against damaged input, so they stay.
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },

  {
    files: ['test/**/*.ts'],
    ...vitest.configs.recommended,
    rules: {
      ...vitest.configs.recommended.rules,
      // expect(value, 'what failed') is how these tests explain a failure.
      'vitest/valid-expect': ['error', { maxArgs: 2 }],
      // Tests are also written with these wrappers (posixOnly = it, but skipped on Windows)...
      'vitest/no-standalone-expect': [
        'error',
        { additionalTestBlockFunctions: ['posixOnly', 'it.runIf', 'it.skipIf'] },
      ],
      // ...and assert through helpers that call expect() themselves.
      'vitest/expect-expect': ['error', { assertFunctionNames: ['expect', 'ok', 'allFailed'] }],
      // Tests read the CLI's JSON output (JSON.parse returns any) and build odd inputs on purpose.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
    settings: { vitest: { typecheck: false } },
  },

  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Small command-line programs of their own (not part of the package): they exit with a code and start with #!.
    files: ['scripts/**', 'action/**', 'test/fixtures/**'],
    rules: { 'n/no-process-exit': 'off', 'n/hashbang': 'off' },
  },
);
