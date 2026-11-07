// Strict, type-aware lint rules for setupscore. Run with `npm run lint`.
// Based on reports/Setupscore code quality tooling plan.md (research, November 2026).
// Every change from a preset below is deliberate and explained; don't relax more without a reason.
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import js from '@eslint/js';
import vitest from '@vitest/eslint-plugin';
import { defineConfig } from 'eslint/config';
import { createNodeResolver, importX } from 'eslint-plugin-import-x';
import n from 'eslint-plugin-n';
import regexp from 'eslint-plugin-regexp';
import security from 'eslint-plugin-security';
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
  // Never suppress them: every finding must be fixed.
  regexp.configs['flat/recommended'],
  {
    rules: {
      'regexp/no-super-linear-backtracking': 'error',
      'regexp/no-super-linear-move': 'error',
      // setupscore removes colour codes and control characters from text on purpose. The rule exists to
      // catch control characters typed by accident; regexp/control-character-escape already makes every
      // one a visible escape (\x1b, \u0000), so it only reports deliberate ones.
      'no-control-regex': 'off',
    },
  },

  // Security: every rule of eslint-plugin-security is an error, except three that cannot tell
  // safe code from unsafe code in a tool like this one.
  {
    plugins: { security },
    rules: {
      ...Object.fromEntries(Object.keys(security.rules).map((r) => [`security/${r}`, 'error'])),
      // setupscore's job is reading the user's files, so almost every path comes from a variable.
      // Paths are checked where they enter (core/discover.ts, core/fsx.ts), not at each read.
      'security/detect-non-literal-fs-filename': 'off',
      // Reports every obj[key]; with noUncheckedIndexedAccess the types already make these safe.
      'security/detect-object-injection': 'off',
      // A rough guess (safe-regex) with false alarms and misses. regexp/no-super-linear-* above is exact.
      'security/detect-unsafe-regex': 'off',
    },
  },

  // Imports: no import loops, and the published code (src/) only imports packages listed in
  // "dependencies" (a devDependency is missing when users install setupscore).
  // Unknown or wrong imports are TypeScript's job, so the rules that repeat it are not used.
  {
    plugins: { 'import-x': importX },
    settings: {
      // Without these, .ts files are not read and import loops go unnoticed (tested: a planted loop is caught).
      'import-x/extensions': ['.ts', '.js', '.mjs'],
      'import-x/parsers': { '@typescript-eslint/parser': ['.ts'] },
      // Source files import each other as ./x.js while the file on disk is ./x.ts.
      'import-x/resolver-next': [
        createNodeResolver({ extensions: ['.ts', '.js', '.mjs'], extensionAlias: { '.js': ['.ts', '.js'] } }),
      ],
    },
    rules: {
      'import-x/no-cycle': 'error',
      'import-x/no-self-import': 'error',
      'import-x/no-duplicates': 'error',
      'import-x/no-useless-path-segments': 'error',
      'import-x/no-mutable-exports': 'error',
      'import-x/no-absolute-path': 'error',
      'import-x/no-relative-packages': 'error',
      'import-x/no-extraneous-dependencies': [
        'error',
        {
          devDependencies: ['test/**', 'scripts/**', 'action/**', '*.config.{js,ts}'],
          optionalDependencies: false,
          peerDependencies: false,
        },
      ],
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
      'vitest/expect-expect': ['error', { assertFunctionNames: ['expect', 'ok', 'allFailed', 'quiet'] }],
      // Tests read the CLI's JSON output (JSON.parse returns any) and build odd inputs on purpose.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // Some checks only make sense on one platform (if (process.platform !== 'win32') expect(...)),
      // and table-driven tests check an optional part of a case.
      'vitest/no-conditional-expect': 'off',
      // Tests set and unset environment variables, and an environment is a plain object.
      '@typescript-eslint/no-dynamic-delete': 'off',
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
