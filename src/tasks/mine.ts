import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { UsageError } from '../core/errors.js';
import { shellArg } from '../core/paths.js';
import { git, tryGit } from './git.js';
import { TEST_SUPPORT } from './testsetup.js';

/** Test files: *.test.ts, *.spec.js, anything in __tests__/. */
export const TEST_FILE = /(^|\/)__tests__\/.+\.[cm]?[jt]sx?$|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/;
const NOT_SOURCE =
  /(?:^|\/)(?:docs?|examples?|\.github|\.claude|fixtures?(?:[-_.][\w.-]*)?|__fixtures__|__mocks__|__snapshots__)\//;
/** Type tests (tsd, vitest --typecheck) and test setup files belong to the tests, not to the change. */
const TEST_ONLY_FILE =
  /\.test-d\.[cm]?tsx?$|(?:^|\/)(?:vitest|jest)\.(?:setup|config)\.[cm]?[jt]sx?$|(?:^|\/)setup-?tests?\.[cm]?[jt]sx?$/i;
/**
 * Commits that only undo or redo another commit: the original commit is the task. Subjects that
 * git writes for merges are left out too (real merges have two parents and are skipped anyway);
 * feature work such as "Merge sort for the results list" is kept.
 */
const NOT_A_CHANGE = /^(?:revert\b|reapply "|merge (?:(?:remote-tracking )?branch(?:es)?|pull request|tag|commit)\b)/i;

export interface Candidate {
  hash: string;
  parent: string;
  title: string;
  date: string;
  /** Test files the commit added or changed (relative to the project folder). */
  testFiles: string[];
  /** Source files the commit added or changed. */
  sourceFiles: string[];
  /** Test files the commit renamed: new path -> path before the commit. */
  previousPaths?: Record<string, string>;
}

export interface FindOptions {
  /** Stop after this many candidates. */
  max: number;
  /** Only commits after this date (anything git accepts: 2026-01-01, "3 months ago"). */
  since?: string;
  /** How many commits to look through at most (default: 1,000, or 20,000 with `since`). */
  scan?: number;
  /** Refuse a folder that is not a JavaScript or TypeScript project (no package.json). */
  requirePackageJson?: boolean;
}

/** Commits looked through by default, and with --since (which bounds the history by date). */
const SCAN_DEFAULT = 1_000;
const SCAN_WITH_SINCE = 20_000;

export interface FindResult {
  candidates: Candidate[];
  scanned: number;
  /** The repository is a shallow clone: older history is missing. */
  shallow: boolean;
  /** The scan stopped at its limit: older commits were not looked at. */
  limitReached: boolean;
}

/** git status letters in `--name-status` output (A, M, D, R100, C075, T...). */
const STATUS = /^[ACDMRTUXB]\d*$/;

/**
 * Commits that changed both tests and source code are possible tasks: the source change is
 * what the agent must reproduce, and the tests check it. Newest first.
 */
export async function findCandidates(projectDir: string, o: FindOptions): Promise<FindResult> {
  // Also fails with a plain-English GitError when the folder is missing or not a repository.
  const [shallowFlag = 'false', bareFlag = 'false'] = (
    await git(projectDir, ['rev-parse', '--is-shallow-repository', '--is-bare-repository'])
  )
    .trim()
    .split('\n');
  if (bareFlag.trim() === 'true') {
    throw new UsageError('This is a bare repository: it has no working folder to check files out into.', [
      'Clone it first (git clone <repository> <folder>) and run setupscore inside the clone.',
    ]);
  }
  if ((await tryGit(projectDir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])) === null) {
    throw new UsageError('This repository has no commits yet.', [
      'Tasks are built from the commit history. Commit your work first, then run the command again.',
    ]);
  }
  if (o.requirePackageJson) await checkProjectFolder(projectDir);
  if (o.since) await checkSince(projectDir, o.since);

  // -z: file names exactly as they are (no quoting of unicode, quotes or spaces).
  const limit = o.scan ?? (o.since ? SCAN_WITH_SINCE : SCAN_DEFAULT);
  const args = [
    '-c',
    'core.quotePath=false',
    'log',
    '-z',
    '--no-merges',
    '-M',
    '--relative',
    '--name-status',
    '--format=%x1e%H%x1f%P%x1f%cI%x1f%s',
    `-n${limit}`,
  ];
  if (o.since) args.push(`--since=${o.since}`);
  args.push('--', '.');
  const out = await git(projectDir, args);

  const candidates: Candidate[] = [];
  const commits = parseLog(out);
  let scanned = 0;
  for (const commit of commits) {
    scanned++;
    const { hash, parents, date, title, files } = commit;
    if (parents.length !== 1 || NOT_A_CHANGE.test(title)) continue;

    const tests: string[] = [];
    const sources: string[] = [];
    const previousPaths: Record<string, string> = {};
    for (const f of files) {
      if (f.status.startsWith('D')) continue;
      // Examples, fixtures and docs often hold sample projects with their own dependencies:
      // they are not part of the project's own code or test suite.
      if (NOT_SOURCE.test(f.path)) continue;
      if (TEST_FILE.test(f.path)) {
        tests.push(f.path);
        if (f.from && f.from !== f.path) previousPaths[f.path] = f.from;
      } else if (TEST_SUPPORT.test(f.path) || TEST_ONLY_FILE.test(f.path)) {
        // Test helpers, mocks and snapshots belong to the tests, not to the change the agent makes.
        continue;
      } else if (SOURCE_FILE.test(f.path)) sources.push(f.path);
    }
    if (tests.length && sources.length) {
      candidates.push({
        hash,
        parent: parents[0]!,
        // An empty commit message still needs an instruction.
        title: title.trim() || `Update ${sources.join(', ')} so the new tests pass`,
        date,
        testFiles: tests,
        sourceFiles: sources,
        ...(Object.keys(previousPaths).length ? { previousPaths } : {}),
      });
      if (candidates.length >= o.max) break;
    }
  }
  return { candidates, scanned, shallow: shallowFlag.trim() === 'true', limitReached: commits.length >= limit };
}

interface LogEntry {
  hash: string;
  parents: string[];
  date: string;
  title: string;
  files: { status: string; path: string; from?: string }[];
}

/**
 * Read `git log -z --name-status --format=%x1e...` output. Fields are NUL-separated: each commit
 * is a header (starting with \x1e), then status letters and one path (two for renames and copies).
 */
function parseLog(out: string): LogEntry[] {
  const entries: LogEntry[] = [];
  const tokens = out.split('\0');
  let current: LogEntry | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!.replace(/^\n/, '');
    if (!token) continue;
    if (current && STATUS.test(token)) {
      if (/^[RC]/.test(token)) {
        const from = tokens[++i] ?? '';
        const to = tokens[++i] ?? '';
        current.files.push({ status: token, path: to, from });
      } else {
        current.files.push({ status: token, path: tokens[++i] ?? '' });
      }
      continue;
    }
    if (token.startsWith('\x1e')) {
      const [hash = '', parents = '', date = '', ...title] = token.slice(1).split('\x1f');
      current = { hash, parents: parents.split(' ').filter(Boolean), date, title: title.join('\x1f'), files: [] };
      entries.push(current);
    }
  }
  return entries;
}

const here = (dir: string) => (resolve(dir) === process.cwd() ? 'This folder' : dir);
/**
 * Tasks need a JavaScript or TypeScript project (a package.json). Without one, say what to do
 * instead of finding nothing: run on the project folder above ("setupscore tasks src" from inside
 * a project), on a package folder of a monorepo, or not at all for other languages.
 */
export async function checkProjectFolder(projectDir: string): Promise<void> {
  if (existsSync(join(projectDir, 'package.json'))) return;
  const top = (await tryGit(projectDir, ['rev-parse', '--show-toplevel']))?.trim();
  if (top) {
    let dir = resolve(projectDir);
    const root = resolve(top);
    while (dir !== root && dirname(dir) !== dir) {
      dir = dirname(dir);
      if (existsSync(join(dir, 'package.json'))) {
        const rel = relative(process.cwd(), dir) || '.';
        throw new UsageError(
          `${here(projectDir)} has no package.json: it is a folder inside the project at ${rel.startsWith('..') ? dir : rel}.`,
          [`Run it on the project root instead: setupscore tasks ${shellArg(rel)}`],
        );
      }
    }
  }
  // Package folders further down (a monorepo whose root has no package.json).
  const listed = (await tryGit(projectDir, ['ls-files', '-z', '--', '*package.json'])) ?? '';
  const packages = listed
    .split('\0')
    .filter(
      (f) =>
        /(?:^|\/)package\.json$/.test(f) &&
        !/(?:^|\/)(?:node_modules|examples?|fixtures?|docs?|test|tests|__tests__)\//.test(f),
    )
    .map((f) => dirname(f))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  if (packages.length) {
    const first = join(projectDir, packages[0]!);
    throw new UsageError(
      `${here(projectDir)} has no package.json. setupscore tasks works on one JavaScript or TypeScript package at a time.`,
      [`Run it on a package folder, for example: setupscore tasks ${shellArg(relative(process.cwd(), first) || '.')}`],
    );
  }
  throw new UsageError(
    `${here(projectDir)} has no package.json: setupscore tasks supports JavaScript and TypeScript projects for now.`,
    ['"setupscore check" works for any project: it checks the Claude Code setup files.'],
  );
}

/** git reads almost anything as a date and falls back to "now"; refuse what it did not understand. */
async function checkSince(projectDir: string, since: string): Promise<void> {
  const out = await tryGit(projectDir, ['rev-parse', `--since=${since}`]);
  const at = Number(out?.match(/--max-age=(\d+)/)?.[1]);
  if (!Number.isFinite(at)) return;
  const now = Date.now() / 1000;
  if (Math.abs(at - now) < 5 && !/^\s*(?:now|0+\s+\w+\s+ago)\s*$/i.test(since)) {
    throw new UsageError(`--since "${since}" is not a date git understands.`, [
      'Use a date such as 2026-01-01, or a relative one such as "6 months ago".',
    ]);
  }
}
