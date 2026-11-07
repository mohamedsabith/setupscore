import { resolve } from 'node:path';
import pc from 'picocolors';
import { authStatus, findClaude } from '../agent/claude.js';
import {
  checkSandbox,
  loadRuntime,
  missingSandboxTools,
  runProgram,
  RUNTIME_PACKAGE,
  RUNTIME_VERSION,
  SANDBOX_CHECK_NAME,
  sandboxHint,
  type Check,
  type ProgramResult,
} from '../sandbox/index.js';
import { detectPm, type PmOverrides } from '../tasks/pm.js';

/** How long one tool may take to print its version. */
const TOOL_TIMEOUT_MS = 15_000;
let toolTimeoutMs = TOOL_TIMEOUT_MS;
const seconds = (ms: number) => `${+(ms / 1000).toFixed(1)} second${ms === 1000 ? '' : 's'}`;

const firstLine = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
    ?.slice(0, 200) ?? '';

/** What a tool's answer means, in words: its first line, or why there is none. */
function answer(
  name: string,
  r: ProgramResult,
  timeoutMs = toolTimeoutMs,
): { ok: true; text: string } | { ok: false; text: string; notFound: boolean } {
  if (r.error?.code === 'ENOENT') return { ok: false, text: 'not found', notFound: true };
  if (r.error) return { ok: false, text: `could not be started (${r.error.message})`, notFound: false };
  if (r.timedOut) return { ok: false, text: `did not answer within ${seconds(timeoutMs)}`, notFound: false };
  if (r.code === 127 || r.code === 9009) return { ok: false, text: 'not found', notFound: true };
  if (r.code !== 0) {
    const why = firstLine(r.stderr) || firstLine(r.stdout);
    return { ok: false, text: `${name} failed (exit code ${r.code})${why ? `: ${why}` : ''}`, notFound: false };
  }
  const text = firstLine(r.stdout);
  if (!text) return { ok: false, text: `${name} printed nothing`, notFound: false };
  return { ok: true, text };
}

/** `git` runs without a shell (paths with spaces stay one argument). Package managers on Windows are .cmd files and need one. */
function tool(cmd: string, args: string[], cwd?: string, timeoutMs = toolTimeoutMs): Promise<ProgramResult> {
  if (process.platform === 'win32' && cmd !== 'git')
    return runProgram([cmd, ...args].join(' '), 'shell', { timeoutMs, cwd });
  return runProgram(cmd, args, { timeoutMs, cwd });
}

export interface DoctorOptions {
  /** Path to Claude Code, as --claude-bin. */
  claudeBin?: string;
  /** Called with each check as soon as it is known, in the order they are shown. */
  onCheck?: (check: Check) => void;
  /** Time limit for each tool's answer (tests use a short one). */
  toolTimeoutMs?: number;
  /** tasks.test / tasks.install from setupscore.yml, so a custom test command counts. */
  overrides?: PmOverrides;
}

export interface GitRepoProblem {
  kind: 'dubious' | 'not-a-repo' | 'bare' | 'too-old' | 'other';
  /** For a check line: starts in lower case. */
  detail: string;
  fixes: string[];
}

/**
 * Why `git rev-parse --show-toplevel` failed, in words. A folder git refuses (another user's),
 * a bare repository or one too new for this git are not "not a git repository".
 */
export function gitRepoProblem(said: string, dir: string): GitRepoProblem {
  const dubious = said.match(/dubious ownership in repository at '([^']+)'/);
  if (dubious || /dubious ownership/.test(said)) {
    const path = dubious?.[1] ?? resolve(dir);
    return {
      kind: 'dubious',
      detail: 'git refuses to use this repository: it belongs to another user ("dubious ownership")',
      fixes: [
        `If you trust it, allow it:  git config --global --add safe.directory '${path}'`,
        'Or run setupscore as the user who owns the folder.',
      ],
    };
  }
  if (/must be run in a work tree/i.test(said)) {
    return {
      kind: 'bare',
      detail: 'this is a bare repository (it has no working folder with files)',
      fixes: ['Run setupscore in a clone that has files:  git clone <this repository> <folder>'],
    };
  }
  const extension = said.match(/unknown repository extension(?:s)? found:\s*(\S+)/i)?.[1];
  if (extension || /repo version is \d+, but v\d+ is expected/i.test(said)) {
    return {
      kind: 'too-old',
      detail: `this repository uses a format your git is too old to read${extension ? ` (${extension === 'refstorage' ? 'reftable' : extension})` : ''}`,
      fixes: ['Update git (reftable repositories need git 2.45 or newer), then try again.'],
    };
  }
  if (/not a git repository/i.test(said)) {
    return {
      kind: 'not-a-repo',
      detail: 'this folder is not inside a git repository',
      fixes: ['setupscore tasks builds tasks from git history. Run it inside a git repository.'],
    };
  }
  const line =
    said
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? 'git failed';
  return {
    kind: 'other',
    detail: `git cannot read this repository: ${line}`,
    fixes: ['Run "git status" in this folder to see what is wrong.'],
  };
}

async function gitChecks(dir: string): Promise<Check[]> {
  const v = answer('git', await tool('git', ['--version']));
  const gitCheck: Check = {
    name: 'git',
    ok: v.ok,
    detail: v.ok ? v.text.replace(/^git version /, '') : v.text,
    fix:
      v.ok || !('notFound' in v) || v.notFound
        ? 'Install git from https://git-scm.com'
        : 'Run "git --version" yourself to see what is wrong, or install git again from https://git-scm.com',
    required: true,
  };
  if (!v.ok)
    return [
      gitCheck,
      { name: 'Git repository', ok: false, detail: 'not checked, because git does not work', required: false },
    ];

  const r = await tool('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
  const top = answer('git', r);
  if (top.ok) return [gitCheck, { name: 'Git repository', ok: true, detail: top.text, required: true }];
  const problem = r.timedOut ? null : gitRepoProblem(`${r.stderr}\n${r.stdout}`, dir);
  const repo: Check = problem
    ? { name: 'Git repository', ok: false, detail: problem.detail, fix: problem.fixes.join('\n'), required: true }
    : {
        name: 'Git repository',
        ok: false,
        detail: `git ${top.text}`,
        fix: 'Run "git status" in this folder to see what is wrong.',
        required: true,
      };
  return [gitCheck, repo];
}

async function sandboxCheck(dir: string, log: (m: string) => void): Promise<Check> {
  if (process.platform === 'win32') {
    // Refused before anything is downloaded: the runtime cannot be used here yet.
    return {
      name: SANDBOX_CHECK_NAME,
      ok: false,
      detail: 'native Windows is not supported yet',
      fix: sandboxHint(),
      required: true,
    };
  }
  const missing = missingSandboxTools();
  if (missing.length)
    return { name: SANDBOX_CHECK_NAME, ok: false, detail: missing.join('; '), fix: sandboxHint(), required: true };
  try {
    const rt = await loadRuntime({ cwd: dir, install: true, onInstall: log });
    if (!rt)
      return {
        name: SANDBOX_CHECK_NAME,
        ok: false,
        detail: `${RUNTIME_PACKAGE} is not installed`,
        fix: `npm install -D ${RUNTIME_PACKAGE}@${RUNTIME_VERSION}`,
        required: true,
      };
    return await checkSandbox(rt);
  } catch (err) {
    const e = err as Error & { fixes?: string[] };
    return {
      name: SANDBOX_CHECK_NAME,
      ok: false,
      detail: e.message,
      fix: e.fixes?.length ? e.fixes.join('\n') : sandboxHint(),
      required: true,
    };
  }
}

/** npm comes with Node. pnpm, yarn and bun may first download the version package.json names (Corepack). */
const PM_TIMEOUT_MS = 60_000;

async function packageManagerChecks(dir: string, overrides?: PmOverrides): Promise<Check[]> {
  const pm = detectPm(dir, overrides);
  if ('error' in pm) return [{ name: 'Package manager', ok: false, detail: pm.error, required: true }];
  const timeoutMs = pm.name === 'npm' ? toolTimeoutMs : Math.max(toolTimeoutMs, PM_TIMEOUT_MS);
  const v = answer(pm.name, await tool(pm.name, ['--version'], undefined, timeoutMs), timeoutMs);
  const notFound = 'notFound' in v && v.notFound;
  // Nothing to install, and the tests run without it (node --test, vitest…): it is not needed.
  const testCommand = pm.test([]);
  const needed =
    pm.install !== null ||
    // eslint-disable-next-line security/detect-non-literal-regexp -- pm.name is one of npm, pnpm, yarn, bun
    new RegExp(`(^|[\\s&;|(])${pm.name === 'npm' ? 'npx?' : pm.name}\\b`).test(testCommand);
  const checks: Check[] = [
    {
      name: 'Package manager',
      ok: v.ok,
      detail: v.ok
        ? `${pm.name} ${v.text}${pm.lockfile ? ` (${pm.lockfile})` : ''}`
        : notFound
          ? `${pm.name} not found (this project uses ${pm.lockfile ?? pm.name}${needed ? '' : '; it has no dependencies to install and its tests do not use it, so this is fine for now'})`
          : `${v.text.startsWith(pm.name) ? v.text : `${pm.name} ${v.text}`}${v.text.startsWith('did not answer') && pm.name !== 'npm' ? ` (it may be downloading the version that "packageManager" in package.json asks for)` : ''}`,
      fix: notFound
        ? pm.name === 'npm'
          ? 'npm comes with Node.js: install Node.js 22.12 or newer from https://nodejs.org'
          : `Install it: npm install -g ${pm.name}  (or: corepack enable)`
        : `Run "${pm.name} --version" yourself to see what is wrong.${pm.name === 'npm' ? ' npm comes with Node.js: installing Node.js again repairs it.' : ''}`,
      required: needed,
    },
  ];
  if (!pm.hasTestScript) {
    checks.push({
      name: 'Test command',
      ok: false,
      detail: 'package.json has no "test" script',
      fix: 'Add one, or set tasks.test in setupscore.yml (for example: "vitest run {files}").',
      required: true,
    });
  }
  return checks;
}

async function claudeCheck(claudeBin: string | undefined, timeoutMs?: number): Promise<Check> {
  const name = 'Claude Code';
  try {
    const claude = await findClaude(claudeBin, { timeoutMs });
    if (claude) return { name, ok: true, detail: claude.version, required: false };
    return {
      name,
      ok: false,
      detail: 'not found (needed for setupscore run)',
      fix: 'npm install -g @anthropic-ai/claude-code, or pass its path with --claude-bin',
      required: false,
    };
  } catch (err) {
    const e = err as Error & { fixes?: string[] };
    return {
      name,
      ok: false,
      detail: `${e.message.replace(/^Claude Code\s*/, '').replace(/\.$/, '')} (needed for setupscore run)`,
      fix: e.fixes?.join('\n'),
      required: false,
    };
  }
}

/**
 * Everything `setupscore tasks` and `run` need, checked up front. Docker is never one of them.
 * The checks run at the same time (a tool that hangs costs its time limit once, not once per
 * check) and are reported in a fixed order as soon as each is known.
 */
export async function runDoctor(dir: string, log: (m: string) => void, options: DoctorOptions = {}): Promise<Check[]> {
  toolTimeoutMs = options.toolTimeoutMs ?? TOOL_TIMEOUT_MS;
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const node: Check = {
    name: 'Node.js',
    ok: major > 22 || (major === 22 && minor >= 12),
    detail: process.versions.node,
    fix: 'Install Node.js 22.12 or newer from https://nodejs.org',
    required: true,
  };
  const auth = authStatus();
  const signIn: Check = {
    name: 'Claude sign-in',
    ok: auth.ok,
    detail: auth.ok ? `uses ${auth.via}` : 'no key or token in the environment (needed for setupscore run)',
    fix: auth.fix,
    required: false,
  };

  const groups: Promise<Check[]>[] = [
    Promise.resolve([node]),
    gitChecks(dir),
    sandboxCheck(dir, log).then((c) => [c]),
    packageManagerChecks(dir, options.overrides),
    claudeCheck(options.claudeBin, options.toolTimeoutMs).then((c) => [c]),
    Promise.resolve([signIn]),
  ];
  const checks: Check[] = [];
  for (const group of groups) {
    for (const c of await group) {
      checks.push(c);
      options.onCheck?.(c);
    }
  }
  return checks;
}

const NAMES = [
  'Node.js',
  'git',
  'Git repository',
  SANDBOX_CHECK_NAME,
  'Package manager',
  'Test command',
  'Claude Code',
  'Claude sign-in',
];
const WIDTH = Math.max(...NAMES.map((n) => n.length));

/** One check, with its fix under it when it failed. */
export function renderCheck(c: Check, width = WIDTH): string {
  const icon = c.ok ? pc.green('✔') : c.required ? pc.red('✖') : pc.yellow('⚠');
  const out = [`  ${icon} ${c.name.padEnd(width)}  ${c.ok ? c.detail : pc.dim(c.detail)}`];
  // Indented lines continue the line above (for example commands to copy), so they get no arrow.
  if (!c.ok && c.fix)
    for (const line of c.fix.split('\n'))
      out.push(`    ${' '.repeat(width)}  ${pc.dim(/^\s/.test(line) ? `    ${line.trimStart()}` : `→ ${line}`)}`);
  return out.join('\n');
}

export function renderDoctorSummary(checks: Check[]): string {
  const out = [''];
  out.push(pc.dim('  Docker is not needed: setupscore uses the sandbox built into your operating system.'));
  const failed = checks.filter((c) => c.required && !c.ok);
  const runReady = checks.every((c) => c.ok);
  out.push(
    failed.length
      ? pc.red(`✖ ${failed.length} problem${failed.length === 1 ? '' : 's'} to fix before "setupscore tasks".`)
      : runReady
        ? pc.green('✔ Ready for "setupscore tasks" and "setupscore run".')
        : pc.green('✔ Ready for "setupscore tasks".') + pc.yellow(' Fix the ⚠ items above before "setupscore run".'),
  );
  return out.join('\n');
}
