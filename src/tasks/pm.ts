import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import picomatch from 'picomatch';
import { parse as parseYaml } from 'yaml';
import { trimEndWhile } from '../core/text.js';

type PmName = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface Pm {
  name: PmName;
  lockfile: string | null;
  /** Install command, or null when the project has no dependencies. */
  install: string | null;
  /**
   * Where the install runs, relative to the project folder: "." normally, or the workspace root
   * (for example "../..") for a package inside an npm, pnpm, Yarn or Bun workspace.
   */
  installRoot: string;
  /** Yarn Plug'n'Play: there is no node_modules, so test runners are started through yarn. */
  pnp: boolean;
  hasTestScript: boolean;
  /** Changes whenever dependencies change, so installs can be reused between tasks. */
  depsHash: string;
  test(files: string[]): string;
  /** No known test runner in the "test" script: `test()` runs the whole script, for every test file. */
  wholeScript: boolean;
  /** Something in the "test" script that can hide failing tests (`|| true`, a pipe), in plain English. */
  scriptWarning?: string;
}

export interface PmOverrides {
  /** Custom test command. `{files}` is replaced by the test files; otherwise they are appended. */
  test?: string;
  install?: string;
}

const LOCKFILES: [string, PmName][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];
const PM_NAMES: PmName[] = ['npm', 'pnpm', 'yarn', 'bun'];

/** `nodeLinker: pnp` in .yarnrc.yml. A line-start pattern that can't run across blank lines (linear time). */
const NODE_LINKER = /^[^\S\n\r\u2028\u2029]*nodeLinker\s*:\s*["']?([\w-]+)/m;

/** Quote a file name for the shell. */
export const shellQuote = (s: string): string =>
  process.platform === 'win32' ? JSON.stringify(s) : `'${s.replace(/'/g, `'\\''`)}'`;

type Read = { ok: true; data: Buffer } | { ok: false; why: 'missing' | 'not-a-file' | 'too-big' | 'unreadable' };

/**
 * Read a small file without ever blocking: a FIFO, a device (/dev/zero) or a folder in place of
 * the file is refused instead of read. The file is opened non-blocking and checked before reading.
 */
function readRegularFile(path: string, maxBytes = 64 * 1024 * 1024): Read {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      why: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : code === 'EISDIR' ? 'not-a-file' : 'unreadable',
    };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, why: 'not-a-file' };
    if (st.size > maxBytes) return { ok: false, why: 'too-big' };
    return { ok: true, data: readFileSync(fd) };
  } catch {
    return { ok: false, why: 'unreadable' };
  } finally {
    closeSync(fd);
  }
}

const readText = (path: string, max?: number): string | null => {
  const r = readRegularFile(path, max);
  return r.ok ? r.data.toString('utf8') : null;
};

const isRegularFile = (path: string) => {
  const r = readRegularFile(path, 0);
  return r.ok || r.why === 'too-big';
};

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  packageManager?: string;
  workspaces?: unknown;
  jest?: Record<string, unknown>;
}

/** package.json as an object, or a plain-English reason why it cannot be used. */
function readPackageJson(dir: string): PackageJson | { error: string } {
  const r = readRegularFile(join(dir, 'package.json'), 16 * 1024 * 1024);
  if (!r.ok) {
    if (r.why === 'missing')
      return { error: 'no package.json. setupscore tasks supports JavaScript and TypeScript projects for now' };
    if (r.why === 'not-a-file')
      return { error: 'package.json is not a regular file (it is a folder, a pipe or a device)' };
    if (r.why === 'too-big') return { error: 'package.json is larger than 16 MB' };
    return { error: 'package.json could not be read' };
  }
  try {
    // Editors on Windows often save a byte order mark at the start; JSON.parse rejects it.
    const pkg = JSON.parse(r.data.toString('utf8').replace(/^﻿/, '')) as unknown;
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg))
      return { error: 'package.json does not hold a JSON object' };
    return pkg;
  } catch {
    return { error: 'package.json is not valid JSON' };
  }
}

/** Folders from `dir` up to the top of its git repository (or only `dir` outside a repository). */
function foldersUp(dir: string): string[] {
  const out: string[] = [];
  let d = resolve(dir);
  for (;;) {
    out.push(d);
    if (existsSync(join(d, '.git'))) return out;
    const parent = dirname(d);
    if (parent === d) return [resolve(dir)];
    d = parent;
  }
}

/** Workspace patterns of a folder: package.json "workspaces" (array or { packages }) or pnpm-workspace.yaml. */
function workspacePatterns(dir: string, pkg: PackageJson | null): string[] {
  const out: string[] = [];
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) out.push(...ws.filter((p): p is string => typeof p === 'string'));
  else if (ws && typeof ws === 'object' && Array.isArray((ws as { packages?: unknown }).packages)) {
    out.push(...(ws as { packages: unknown[] }).packages.filter((p): p is string => typeof p === 'string'));
  }
  const yaml = readText(join(dir, 'pnpm-workspace.yaml'), 1024 * 1024);
  if (yaml !== null) {
    try {
      const doc = parseYaml(yaml) as { packages?: unknown } | null;
      if (Array.isArray(doc?.packages)) out.push(...doc.packages.filter((p): p is string => typeof p === 'string'));
    } catch {
      // a broken pnpm-workspace.yaml: pnpm reports it during the install
    }
  }
  return out;
}

/** The workspace root that lists `dir` as one of its packages, or null. */
function findWorkspaceRoot(dir: string): { root: string; pkg: PackageJson | null } | null {
  const self = resolve(dir);
  for (const up of foldersUp(dir).slice(1)) {
    const read = readPackageJson(up);
    const pkg = 'error' in read ? null : read;
    const patterns = workspacePatterns(up, pkg);
    if (!patterns.length) continue;
    const rel = relative(up, self).split(sep).join('/');
    const yes = patterns
      .filter((p) => !p.startsWith('!'))
      .map((p) => trimEndWhile(p.replace(/^\.\//, ''), (c) => c === '/'));
    const no = patterns
      .filter((p) => p.startsWith('!'))
      .map((p) => trimEndWhile(p.slice(1).replace(/^\.\//, ''), (c) => c === '/'));
    if (!yes.length) continue;
    if (picomatch.isMatch(rel, yes, { dot: true }) && !(no.length && picomatch.isMatch(rel, no, { dot: true })))
      return { root: up, pkg };
  }
  return null;
}

const depFields = (pkg: PackageJson | null) => [pkg?.dependencies, pkg?.devDependencies, pkg?.optionalDependencies];
const countDeps = (pkg: PackageJson | null) =>
  depFields(pkg).reduce((n, d) => n + (d && typeof d === 'object' ? Object.keys(d).length : 0), 0);
const lockfileIn = (dir: string) => LOCKFILES.find(([file]) => isRegularFile(join(dir, file)));
const declaredPm = (pkg: PackageJson | null): PmName | undefined => {
  const name = typeof pkg?.packageManager === 'string' ? pkg.packageManager.split('@')[0] : undefined;
  return PM_NAMES.find((n) => n === name);
};

/** Major version of a dependency: from package.json, else from the installed copy. */
function majorOf(name: string, pkgs: (PackageJson | null)[], dirs: string[]): number | null {
  for (const pkg of pkgs) {
    for (const deps of depFields(pkg)) {
      const range = deps?.[name];
      const m = typeof range === 'string' ? range.match(/^\D{0,3}(\d+)/) : null;
      if (m) return Number(m[1]);
    }
  }
  for (const d of dirs) {
    const text = readText(join(d, 'node_modules', name, 'package.json'), 1024 * 1024);
    const m = text?.match(/"version"\s*:\s*"(\d+)/);
    if (m) return Number(m[1]);
  }
  return null;
}

export function detectPm(dir: string, overrides: PmOverrides = {}): Pm | { error: string } {
  const read = readPackageJson(dir);
  if ('error' in read) return read;
  const pkg = read;

  // A package inside a workspace is installed from the workspace root, with the root's lockfile.
  const own = lockfileIn(dir);
  const workspace = own ? null : findWorkspaceRoot(dir);
  const installDir = workspace?.root ?? resolve(dir);
  const installRoot = workspace ? relative(resolve(dir), workspace.root).split(sep).join('/') || '.' : '.';
  const rootPkg = workspace?.pkg ?? null;
  const found = own ?? (workspace ? lockfileIn(workspace.root) : undefined);
  const hasPnpmWorkspace = isRegularFile(join(installDir, 'pnpm-workspace.yaml'));
  const name: PmName = found?.[1] ?? declaredPm(rootPkg) ?? declaredPm(pkg) ?? (hasPnpmWorkspace ? 'pnpm' : 'npm');
  const lockfile = found?.[0] ?? null;
  const yarnrc = name === 'yarn' ? readText(join(installDir, '.yarnrc.yml'), 1024 * 1024) : null;
  const berry = yarnrc !== null;
  const linker = yarnrc?.match(NODE_LINKER)?.[1];
  const pnp = berry && (linker === undefined || linker === 'pnp');

  // A workspace root, or a package in one, always needs an install: it links the packages together.
  const hasDeps = countDeps(pkg) > 0 || !!pkg.workspaces || hasPnpmWorkspace || !!workspace;
  const hash = createHash('sha1');
  hash.update(
    JSON.stringify([
      name,
      installRoot,
      ...depFields(pkg),
      pkg.workspaces,
      ...depFields(rootPkg),
      rootPkg?.workspaces,
      linker ?? null,
    ]),
  );
  if (lockfile) {
    const lock = readRegularFile(join(installDir, lockfile), 1024 * 1024 * 1024);
    if (lock.ok) hash.update(lock.data);
  }
  if (hasPnpmWorkspace) hash.update(readText(join(installDir, 'pnpm-workspace.yaml'), 1024 * 1024) ?? '');

  const command = {
    npm: lockfile ? 'npm ci' : 'npm install --no-package-lock',
    pnpm: 'pnpm install --frozen-lockfile',
    yarn: berry ? 'yarn install --immutable' : 'yarn install --frozen-lockfile --non-interactive',
    bun: 'bun install --frozen-lockfile',
  }[name];
  const install =
    overrides.install ??
    (!hasDeps ? null : installRoot === '.' ? command : `cd ${shellQuote(installRoot)} && ${command}`);

  const runScript = { npm: 'npm test --silent', pnpm: 'pnpm test', yarn: 'yarn test', bun: 'bun run test' }[name];
  const script = typeof pkg.scripts?.test === 'string' ? pkg.scripts.test : undefined;
  // npm, pnpm, Yarn 1 and Bun run "pretest" before "test"; Yarn 2+ does not. "posttest" is left
  // out on purpose: like the checks after the runner (lint, coverage reports), it is not the tests.
  const pretest =
    typeof pkg.scripts?.pretest === 'string' && !(name === 'yarn' && berry)
      ? { npm: 'npm run pretest --silent', pnpm: 'pnpm run pretest', yarn: 'yarn run pretest', bun: 'bun run pretest' }[
          name
        ]
      : null;
  const ctx: RunnerContext = {
    pretest,
    pnp,
    scripts: pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {},
    runScript:
      name === 'yarn' && berry
        ? null
        : { npm: 'npm run --silent', pnpm: 'pnpm run', yarn: 'yarn run', bun: 'bun run' }[name],
    jestCoverage: jestCoverageConfigured(dir, pkg),
    vitestCoverage: vitestCoverageConfigured(dir),
    tapMajor: majorOf('tap', [pkg, rootPkg], [resolve(dir), installDir]),
    tsxMajor: majorOf('tsx', [pkg, rootPkg], [resolve(dir), installDir]),
  };
  const wholeScript = !overrides.test && !!script && runnerCommand(script, ['x.test.js'], ctx) === null;
  const test = (files: string[]) => {
    if (overrides.test) {
      const list = files.map(shellQuote).join(' ');
      return overrides.test.includes('{files}')
        ? overrides.test.replaceAll('{files}', list)
        : `${overrides.test} ${list}`;
    }
    const direct = script ? runnerCommand(script, files, ctx) : null;
    // No recognisable runner: run the whole test script, without file names.
    return direct ?? runScript;
  };

  return {
    name,
    lockfile,
    install,
    installRoot,
    pnp,
    hasTestScript: !!script || !!overrides.test,
    depsHash: hash.digest('hex'),
    test,
    wholeScript,
    ...(script && !overrides.test ? withWarning(script) : {}),
  };
}

/** Parts of a test script that make it report success even when tests fail. */
function withWarning(script: string): { scriptWarning?: string } {
  if (script.length > MAX_SCRIPT) return {};
  if (/\|\|/.test(script))
    return { scriptWarning: 'the "test" script uses "||", so it reports success even when the tests fail' };
  if (/(^|[^|])\|(?!\|)/.test(script))
    return {
      scriptWarning:
        'the "test" script pipes the output into another command ("|"), which hides whether the tests failed',
    };
  if (/(?:;|&&)\s*(?:exit\s+0|true)\s*$/.test(script))
    return { scriptWarning: 'the "test" script ends with a command that always succeeds, so it never fails' };
  return {};
}

const JEST_CONFIGS = ['js', 'cjs', 'mjs', 'ts', 'cts', 'mts', 'json'].map((x) => `jest.config.${x}`);
const VITEST_CONFIGS = ['js', 'cjs', 'mjs', 'ts', 'cts', 'mts'].flatMap((x) => [
  `vitest.config.${x}`,
  `vite.config.${x}`,
  `vitest.workspace.${x}`,
]);

function jestCoverageConfigured(dir: string, pkg: PackageJson): boolean {
  if (pkg.jest && typeof pkg.jest === 'object' && ('collectCoverage' in pkg.jest || 'coverageThreshold' in pkg.jest))
    return true;
  return JEST_CONFIGS.some((f) => /collectCoverage|coverageThreshold/.test(readText(join(dir, f), 1024 * 1024) ?? ''));
}

function vitestCoverageConfigured(dir: string): boolean {
  return VITEST_CONFIGS.some((f) => /\bcoverage\b/.test(readText(join(dir, f), 1024 * 1024) ?? ''));
}

export interface RunnerContext {
  /** Command that runs the "pretest" script, when there is one. */
  pretest?: string | null;
  /** Yarn Plug'n'Play: start binaries through yarn. */
  pnp?: boolean;
  /** Jest or Vitest config turns coverage on (thresholds would fail for a few test files). */
  jestCoverage?: boolean;
  vitestCoverage?: boolean;
  tapMajor?: number | null;
  tsxMajor?: number | null;
  /** package.json scripts, to follow "npm run test:unit" to the script that starts the runner. */
  scripts?: Record<string, unknown>;
  /** How this package manager runs a script ("npm run"), or null when it skips pre/post hooks (Yarn 2+). */
  runScript?: string | null;
}

/** Scripts longer than this are run as they are (and never analysed with regular expressions). */
const MAX_SCRIPT = 10_000;

type Runner = 'jest' | 'vitest' | 'mocha' | 'ava' | 'tap' | 'uvu' | 'node' | 'tsx' | 'bun' | 'playwright';

/** Options of `node` that take the next word as their value. */
const NODE_VALUE_OPTIONS = new Set([
  '--import',
  '--require',
  '-r',
  '--loader',
  '--experimental-loader',
  '--conditions',
  '-C',
  '--input-type',
  '--title',
  '--env-file',
  '--env-file-if-exists',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-concurrency',
  '--test-timeout',
  '--test-shard',
  '--watch-path',
  '--test-coverage-include',
  '--test-coverage-exclude',
]);
const NPX_OPTIONS = new Set(['--no-install', '--no', '-y', '--yes', '-q', '--quiet']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface Parsed {
  runner: Runner;
  /** Words before the runner that stay: environment assignments, `env`, `cross-env`. */
  prefix: string[];
  /** The runner and its arguments. */
  words: string[];
}

/** Recognise a test runner at the start of one `&&` step. Null when there is none. */
function parseRunner(segment: string, ctx: RunnerContext): Parsed | null {
  const words = segment.split(/\s+/).filter(Boolean);
  const prefix: string[] = [];
  let i = 0;
  // Environment first: FOO=1, env FOO=1, cross-env FOO=1 (npx is dropped: the runner is on PATH).
  for (; i < words.length; i++) {
    const w = words[i]!;
    if (ASSIGNMENT.test(w) || w === 'env' || w === 'cross-env') prefix.push(w);
    else break;
  }
  if (words[i] === 'npx' || words[i] === 'bunx') {
    i++;
    while (i < words.length && NPX_OPTIONS.has(words[i]!)) i++;
  } else if ((words[i] === 'yarn' || words[i] === 'pnpm') && words[i + 1] === 'exec') {
    i += 2;
  } else if (
    (words[i] === 'yarn' || words[i] === 'pnpm') &&
    !Object.hasOwn(ctx.scripts ?? {}, words[i + 1] ?? '') &&
    runnerAt(words, i + 1)
  ) {
    i += 1; // "yarn jest", "pnpm vitest run": the binary, not a script of that name
  }
  const runner = runnerAt(words, i);
  if (runner) return { runner, prefix, words: words.slice(i) };
  // Coverage wrappers (c8, nyc) around a runner: run the runner alone. Their thresholds fail
  // when only a few test files run, and coverage is not what a task checks.
  if (words[i] === 'c8' || words[i] === 'nyc') {
    for (let j = i + 1; j < words.length; j++) {
      const inner = runnerAt(words, j);
      if (inner) return { runner: inner, prefix, words: words.slice(j) };
    }
  }
  return null;
}

function runnerAt(all: string[], from = 0): Runner | null {
  const words = from ? all.slice(from, from + 2) : all;
  const [w, next] = words;
  if (w === 'jest' || w === 'vitest' || w === 'mocha' || w === 'ava' || w === 'tap' || w === 'uvu') return w;
  if (w === 'tsx' && next === '--test') return 'tsx';
  if (w === 'bun' && next === 'test') return 'bun';
  if (w === 'playwright' && next === 'test') return 'playwright';
  if (w === 'node') {
    for (let j = from + 1; j < all.length; j++) {
      const o = all[j]!;
      if (o === '--test') return 'node';
      if (!o.startsWith('-')) return null; // a script file: not the built-in test runner
      if (NODE_VALUE_OPTIONS.has(o)) j++;
    }
  }
  return null;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `node --test` reads its arguments as glob patterns, and Node's globs have no escape character:
 * put [ * ? in a character class, and the "(" of an extglob such as @(x) too. Braces cannot be
 * escaped at all: "?" (exactly one character) stands in for them.
 */
export const nodeGlobLiteral = (file: string): string =>
  file
    .replace(/[[*?]/g, (c) => `[${c}]`)
    .replace(/[{}]/g, '?')
    .replace(/([!@+])\(/g, '$1[(]');

/** Remove watch mode: a test command in watch mode never ends. */
function withoutWatch(runner: Runner, words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (runner === 'vitest' && i === 1 && (w === 'watch' || w === 'dev')) {
      out.push('run');
      continue;
    }
    if (
      /^--watch(?:All)?(?:=(?:true|1))?$/.test(w) ||
      ((runner === 'mocha' || runner === 'ava' || runner === 'tap' || runner === 'vitest') && w === '-w')
    )
      continue;
    if (/^--watch-(?:path|files|ignore|extensions)$/.test(w)) {
      i++; // and its value
      continue;
    }
    if (/^--watch-(?:path|files|ignore|extensions)=/.test(w)) continue;
    out.push(w);
  }
  return out;
}

/** Turn coverage off for runners that would enforce thresholds on a handful of test files. */
function withoutCoverage(runner: Runner, words: string[], ctx: RunnerContext): string[] {
  if (runner === 'jest') {
    const mentioned = words.some((w) => /^--(?:coverage|collectCoverage)(?:=true)?$/.test(w));
    const out = words.filter((w) => !/^--(?:coverage|collectCoverage)(?:=true)?$/.test(w));
    return ctx.jestCoverage || mentioned ? [...out, '--coverage=false'] : out;
  }
  if (runner === 'vitest') {
    const mentioned = words.some((w) => /^--coverage(?:\.enabled)?(?:=true)?$/.test(w));
    const out = words.filter((w) => !/^--coverage(?:\.enabled)?(?:=true)?$/.test(w));
    return ctx.vitestCoverage || mentioned ? [...out, '--coverage.enabled=false'] : out;
  }
  if (runner === 'node' || runner === 'tsx')
    return words.filter((w) => !/^--test-coverage-(?:lines|branches|functions)=/.test(w));
  if (runner === 'bun') return words.filter((w) => w !== '--coverage');
  if (runner === 'tap') {
    // tap 15 and later check coverage by default (tap 18+: 100%).
    const out = words.filter((w) => !/^--(?:100|check-coverage|coverage|cov)$/.test(w));
    const major = ctx.tapMajor ?? 18;
    if (major >= 18) return [...out, '--disable-coverage'];
    if (major >= 15) return [...out, '--no-check-coverage'];
    return out;
  }
  return words;
}

/**
 * uvu takes `uvu [dir] [pattern]`, not file names: keep its options, look in the project folder
 * and match exactly the given files with the pattern.
 */
function uvuWords(words: string[], files: string[]): string[] | null {
  const out = [words[0]!];
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (/^["']/.test(w)) return null;
    if (w === '-C' || w === '--cwd' || w.startsWith('--cwd=')) return null; // paths would be relative to another folder
    if (!w.startsWith('-')) continue; // the script's own dir and pattern
    out.push(w);
    if ((w === '-r' || w === '--require' || w === '-i' || w === '--ignore') && words[i + 1] !== undefined)
      out.push(words[++i]!);
  }
  const pattern = `^(?:${files.map((f) => escapeRegex(f).replaceAll('/', '[\\\\/]')).join('|')})$`;
  return [...out, '.', shellQuote(pattern)];
}

/** The runner step with its file arguments, ready to run. Null when the files cannot be passed safely. */
function runnerStep(p: Parsed, files: string[], ctx: RunnerContext): string | null {
  let words = withoutCoverage(p.runner, withoutWatch(p.runner, p.words), ctx);
  if (p.runner === 'tsx') {
    // tsx --test opens a local socket, which the sandbox does not allow; Node with tsx's loader
    // runs the same tests without one.
    const loader = (ctx.tsxMajor ?? 4) >= 4 ? '--import' : '--loader';
    words = ['node', loader, 'tsx', ...words.slice(1)];
  }
  let args: string[];
  if (p.runner === 'uvu') {
    const u = uvuWords(words, files);
    if (!u) return null;
    words = u;
    args = [];
  } else if (p.runner === 'jest' || p.runner === 'playwright') {
    args = files.map((f) => shellQuote(escapeRegex(f))); // arguments are regular expressions
  } else if (p.runner === 'node' || p.runner === 'tsx') {
    args = files.map((f) => shellQuote(nodeGlobLiteral(f))); // arguments are glob patterns
  } else {
    args = files.map(shellQuote);
  }
  // Yarn Plug'n'Play has no node_modules/.bin: start the runner through yarn.
  let prefix = p.prefix;
  if (ctx.pnp) {
    const envEnd = prefix.findIndex((w) => w === 'cross-env');
    if (envEnd >= 0) {
      prefix = [...prefix.slice(0, envEnd), 'yarn', ...prefix.slice(envEnd)];
    } else {
      words = ['yarn', ...words];
    }
  }
  return [...prefix, ...words, ...args].join(' ');
}

/**
 * The command line a script reference runs: "npm run test:unit -- --bail" becomes the
 * "test:unit" script with "--bail" at the end, after its "pre" script. Null for anything else.
 */
function expandScript(segment: string, ctx: RunnerContext): string | null {
  const scripts = ctx.scripts;
  if (!scripts) return null;
  const words = segment.split(/\s+/).filter(Boolean);
  const tool = words[0];
  if (tool !== 'npm' && tool !== 'pnpm' && tool !== 'yarn' && tool !== 'bun') return null;
  let i = 1;
  const silent = () => {
    while (words[i] === '--silent' || words[i] === '-s') i++;
  };
  silent();
  if (words[i] === 'run' || words[i] === 'run-script') i++;
  else if (tool === 'bun' || (tool === 'npm' && words[i] !== 'test' && words[i] !== 't')) return null;
  silent();
  const name = words[i] === 't' && tool === 'npm' ? 'test' : words[i];
  if (!name || name.startsWith('-') || !Object.hasOwn(scripts, name)) return null;
  const body = scripts[name];
  if (typeof body !== 'string' || !body.trim()) return null;
  let args = words.slice(i + 1);
  if (tool === 'npm' && args.length && args[0] !== '--') return null; // npm reads those as its own options
  if (args[0] === '--') args = args.slice(1);
  const pre = `pre${name}`;
  const hook = name !== 'test' && ctx.runScript && typeof scripts[pre] === 'string' ? `${ctx.runScript} ${pre}` : null;
  return [...(hook ? [hook] : []), [body.trim(), ...args].join(' ')].join(' && ');
}

/** Steps that may run before the runner without yarn under Plug'n'Play. */
const PLAIN_COMMANDS = new Set([
  'cd',
  'echo',
  'rm',
  'mkdir',
  'cp',
  'mv',
  'cat',
  'touch',
  'true',
  'false',
  'exit',
  'export',
  'set',
  'test',
  'sleep',
  'printf',
  'npm',
  'npx',
  'yarn',
  'pnpm',
  'bun',
  'git',
  'sh',
  'bash',
  'env',
]);

/**
 * Turn a package.json test script into a command that runs only the given files.
 * "npm run build && vitest run --coverage && eslint ." becomes "npm run build && vitest run 'a.test.ts'":
 * setup steps before the runner are kept, checks after it (lint, typecheck) are dropped, and so
 * are watch mode and coverage thresholds. A "pretest" script runs first, as `npm test` would.
 * Returns null when no known runner is found, or the script is too complex to split safely.
 */
export function runnerCommand(
  script: string,
  files: string[],
  ctx: RunnerContext = {},
  budget = { expansions: 16 },
): string | null {
  if (script.length > MAX_SCRIPT) return null;
  if (/[;|`$()]/.test(script.replaceAll('&&', ''))) return null; // pipes, subshells, ||, ; — run the script as is
  const segments = script.split('&&').map((s) => s.trim());
  let at = -1;
  let parsed: Parsed | null = null;
  for (let i = 0; i < segments.length && !parsed; i++) {
    parsed = parseRunner(segments[i]!, ctx);
    if (parsed) at = i;
  }
  if (!parsed) {
    // "npm run test:unit", "yarn test:app": follow the script it runs (a few levels deep).
    for (let i = 0; i < segments.length && budget.expansions > 0; i++) {
      const expanded = expandScript(segments[i]!, ctx);
      if (expanded === null) continue;
      budget.expansions--;
      const found = runnerCommand(
        [...segments.slice(0, i), expanded, ...segments.slice(i + 1)].join(' && '),
        files,
        ctx,
        budget,
      );
      if (found !== null) return found;
    }
    return null;
  }

  // "cd test && node --test": the file names must be relative to the folder the runner starts in.
  let cwd = '.';
  const before: string[] = [];
  for (const s of segments.slice(0, at)) {
    const words = s.split(/\s+/).filter(Boolean);
    if (words[0] === 'cd') {
      if (words.length !== 2 || /["'~\\]/.test(words[1]!) || posix.isAbsolute(words[1]!)) return null;
      cwd = posix.normalize(posix.join(cwd, words[1]!));
      if (cwd === '..' || cwd.startsWith('../')) return null;
    }
    if (ctx.pnp && words.length && !PLAIN_COMMANDS.has(words.find((w) => !ASSIGNMENT.test(w)) ?? '')) {
      const k = words.findIndex((w) => !ASSIGNMENT.test(w));
      before.push([...words.slice(0, k), 'yarn', ...words.slice(k)].join(' '));
    } else before.push(s);
  }
  const relFiles = files.map((f) => (cwd === '.' ? f : posix.relative(cwd, f.split(sep).join('/'))));
  const step = runnerStep(parsed, relFiles, ctx);
  if (step === null) return null;
  return [...(ctx.pretest ? [ctx.pretest] : []), ...before, step].join(' && ');
}

/**
 * True when the output says the runner found no tests at all (and nothing says tests ran).
 * A run of zero tests says nothing about the change: it is neither a failure before nor a pass after.
 */
export function noTestsRan(output: string): boolean {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '');
  const none =
    /^[^\S\n\r\u2028\u2029]*(?:#|ℹ)\s*tests 0\s*$/m.test(text) || // node --test (TAP and spec reporters)
    /^1\.\.0\b/m.test(text) || // TAP plan with no tests
    /\bNo tests? (?:files? )?found\b/i.test(text) || // jest, vitest, mocha ("No test files found")
    /\bNo valid test files found\b/i.test(text) || // tap
    /couldn[’']?t find any files to test/i.test(text) || // ava
    /^[^\S\n\r\u2028\u2029]*Ran 0 tests\b/m.test(text) || // bun
    /\bhad no matches\b/.test(text) || // bun test with a filter
    /^[^\S\n\r\u2028\u2029]*Total:\s+0\s*$/m.test(text); // uvu
  if (!none) return false;
  const some =
    /^[^\S\n\r\u2028\u2029]*(?:#|ℹ)\s*tests [1-9]/m.test(text) ||
    /^[^\S\n\r\u2028\u2029]*Tests?:?(?=(\s+))\1.*\b[1-9]\d* (?:passed|failed|total)\b/m.test(text) ||
    /\b[1-9]\d* (?:passing|failing|pass|fail|tests? (?:passed|failed))\b/.test(text) ||
    /^[^\S\n\r\u2028\u2029]*Ran [1-9]\d* tests?\b/m.test(text) ||
    /^[^\S\n\r\u2028\u2029]*Total:\s+[1-9]/m.test(text) ||
    /# \{ total: [1-9]/.test(text);
  return !some;
}

/** Lines that every failed npm command prints and that say nothing about the cause. */
const BOILERPLATE =
  /A complete log of this run can be found|Run "npm help \w+" for more info|^npm (?:error|ERR!) (?:code|errno|syscall|path|dest|signal|command|cwd)\b|^npm (?:error|ERR!)\s*$|^npm (?:error|ERR!) (?:Usage|Options|aliases|Clean install a project|Run `npm|\s{2,})|For a full report see|^info Visit https:\/\/yarnpkg\.com/i;
const CAUSE =
  /\b(?:error|ERR!|ERR_[A-Z_]+|failed|fatal|not found|404|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|EINTEGRITY|outdated|not up to date|in sync|frozen)\b/i;

/**
 * Why an install failed, from its output: the first lines that name the cause (npm prints the
 * cause first and boilerplate after it). Null when no line looks like a cause.
 */
export function installFailure(output: string): string | null {
  const lines = output
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !BOILERPLATE.test(l) && CAUSE.test(l));
  if (!lines.length) return null;
  return lines
    .slice(0, 2)
    .map((l) => l.replace(/^npm (?:error|ERR!)\s*/i, ''))
    .join(' | ')
    .slice(0, 300);
}

/** Registry hosts the install step may reach: the public registries plus any in the project's (or workspace root's) .npmrc. */
export function registryDomains(dir: string): string[] {
  const domains = new Set(['registry.npmjs.org', 'registry.yarnpkg.com', 'repo.yarnpkg.com']);
  for (const folder of foldersUp(dir)) {
    for (const file of ['.npmrc', '.yarnrc.yml', '.yarnrc']) {
      const text = readText(join(folder, file), 1024 * 1024);
      if (text === null) continue;
      for (const m of text.matchAll(/registry\w*\s*[=:]\s*["']?(https?:\/\/[^\s"']+)/gi)) {
        try {
          domains.add(new URL(m[1]!).hostname);
        } catch {
          // not a URL
        }
      }
    }
  }
  return [...domains];
}

/** Environment that points every package manager's cache at a folder the sandbox may write. */
export function cacheEnv(cacheRoot: string): Record<string, string> {
  return {
    npm_config_cache: join(cacheRoot, 'npm'),
    // pnpm: its store (pnpm 10 reads npm_config_*, pnpm 11+ only pnpm_config_*), and PNPM_HOME, where
    // pnpm downloads the version pinned in "packageManager" before it installs anything.
    npm_config_store_dir: join(cacheRoot, 'pnpm-store'),
    pnpm_config_store_dir: join(cacheRoot, 'pnpm-store'),
    PNPM_HOME: join(cacheRoot, 'pnpm-home'),
    COREPACK_HOME: join(cacheRoot, 'corepack'),
    XDG_DATA_HOME: join(cacheRoot, 'xdg-data'),
    XDG_CACHE_HOME: join(cacheRoot, 'xdg-cache'),
    XDG_STATE_HOME: join(cacheRoot, 'xdg-state'),
    YARN_CACHE_FOLDER: join(cacheRoot, 'yarn'),
    YARN_GLOBAL_FOLDER: join(cacheRoot, 'yarn-global'),
    BUN_INSTALL_CACHE_DIR: join(cacheRoot, 'bun'),
  };
}
