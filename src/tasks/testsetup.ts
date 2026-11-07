import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { readTextSafely, stripBom } from '../core/fsx.js';
import type { Workspace } from './workspace.js';

/** A file that is a test or belongs to the tests: helpers, mocks, fixtures, snapshots. */
export const TEST_SUPPORT =
  /(^|\/)(?:__tests__|tests?|spec|specs|__mocks__|__fixtures__|fixtures?|fixtures?-[^/]+|[^/]+-fixtures?|__snapshots__|testdata|test-utils?|test-helpers?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|\.test-d\.[cm]?tsx?$/;
/** Files at the project root that decide how tests run. They are put back to the commit's version (or removed). */
const TEST_CONFIG = [
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  'bunfig.toml',
  '.babelrc',
  '.babelrc.json',
  '.babelrc.js',
  'babel.config.js',
  'babel.config.cjs',
  'babel.config.mjs',
  'babel.config.json',
  '.mocharc',
  '.mocharc.js',
  '.mocharc.cjs',
  '.mocharc.mjs',
  '.mocharc.json',
  '.mocharc.jsonc',
  '.mocharc.yml',
  '.mocharc.yaml',
  '.taprc',
  '.c8rc',
  '.c8rc.json',
  '.nycrc',
  '.nycrc.json',
  '.nycrc.yml',
  '.nycrc.yaml',
  ...['js', 'cjs', 'mjs', 'ts', 'cts', 'mts', 'json'].flatMap((x) => [
    `jest.config.${x}`,
    `vitest.config.${x}`,
    `vitest.workspace.${x}`,
    `vite.config.${x}`,
    `ava.config.${x}`,
    `playwright.config.${x}`,
  ]),
];
/** package.json fields that decide how tests run. */
const TEST_FIELDS = ['scripts', 'jest', 'mocha', 'ava', 'c8', 'nyc', 'tap', 'babel', 'vitest'];

/**
 * Put the commit's tests and test settings in place, so the agent's change is judged the way the
 * commit was: an agent cannot pass by editing a test, a helper, the test script or the runner config.
 */
export async function restoreTestSetup(ws: Workspace, hash: string, testFiles: string[]): Promise<void> {
  const inCommit = await ws.listFiles(hash);
  const support = new Set([...testFiles, ...inCommit.filter((f) => TEST_SUPPORT.test(f.split(sep).join('/')))]);
  const configs = TEST_CONFIG.filter((f) => inCommit.includes(f) || existsSync(join(ws.dir, f)));
  const contents = await ws.readMany(hash, [...support, ...configs, 'package.json']);
  for (const f of support) {
    const text = contents.get(f);
    if (text) ws.writeSafely(f, text);
  }
  for (const f of configs) {
    const text = contents.get(f);
    if (text) ws.writeSafely(f, text);
    else ws.removeSafely(f);
  }
  const theirs = contents.get('package.json');
  if (theirs) {
    let mine: Record<string, unknown> | null;
    try {
      // Only a real file: a link the agent planted could point at a file outside the workspace
      // (its content would end up in the project the tests run in).
      const body = readTextSafely(join(ws.dir, 'package.json'), 8 * 1024 * 1024);
      const parsed: unknown = body === null ? null : JSON.parse(stripBom(body));
      mine =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      mine = null; // missing or broken: use the commit's
    }
    let commit: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(stripBom(theirs.toString('utf8')));
      commit =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      commit = {};
    }
    const merged = mine ?? { ...commit };
    for (const key of TEST_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(commit, key)) merged[key] = commit[key];
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- package.json is written back as a plain JSON object
      else delete merged[key];
    }
    ws.writeSafely('package.json', `${JSON.stringify(merged, null, 2)}\n`);
  }
  rmSync(ws.tmp, { recursive: true, force: true });
  mkdirSync(ws.tmp, { recursive: true });
}
