import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { cacheDir } from '../sandbox/runtime.js';
import { secretPaths } from '../sandbox/env.js';
import type { ExecResult, Policy, Sandbox } from '../sandbox/types.js';
import { git } from './git.js';
import { findCandidates, type Candidate } from './mine.js';
import { cacheEnv, detectPm, installFailure, noTestsRan, registryDomains, type Pm, type PmOverrides } from './pm.js';
import { newTestNames } from './testnames.js';
import { Workspace } from './workspace.js';
import { restoreTestSetup } from './testsetup.js';
import { EnvironmentError } from '../sandbox/types.js';

export interface Task {
  /** Short commit hash; stable between runs. */
  id: string;
  hash: string;
  parent: string;
  title: string;
  date: string;
  /** What the agent is asked to do. */
  prompt: string;
  testFiles: string[];
  sourceFiles: string[];
  /** Names of tests added by the commit: the acceptance criteria. */
  newTests: string[];
  /** Test run times, before and after the change. */
  beforeMs: number;
  afterMs: number;
  /**
   * The command that proved the change: the commit's own way of running these test files.
   * `setupscore run` uses it for the hidden tests, so an agent cannot pass by editing the test script.
   * Missing in older tasks files; the command from package.json before the change is used then.
   */
  testCommand?: string;
}

interface Rejected {
  hash: string;
  title: string;
  reason: string;
  /** The last lines of output, to see why (saved in tasks.json). */
  details?: string;
}

export type Progress =
  | { type: 'scan'; candidates: number; scanned: number }
  | { type: 'install'; title: string }
  | { type: 'check'; index: number; total: number; candidate: Candidate }
  | { type: 'valid'; task: Task }
  | { type: 'rejected'; rejected: Rejected }
  /** Something the user should know about how tasks are built (a shallow clone, the whole test script used). */
  | { type: 'note'; message: string };

export interface BuildOptions {
  dir: string;
  sandbox: Sandbox;
  /** Stop after this many valid tasks. */
  limit: number;
  since?: string;
  /** Per test run. */
  timeoutMs: number;
  installTimeoutMs: number;
  /** Extra domains the install step may reach. */
  domains?: string[];
  overrides?: PmOverrides;
  onProgress?: (p: Progress) => void;
  /** Stop between commits and end running commands (Ctrl+C). */
  signal?: AbortSignal;
}

export interface BuildResult {
  tasks: Task[];
  rejected: Rejected[];
  scanned: number;
  candidates: number;
  /** Plain-English notes about how the tasks were built (also sent as 'note' progress events). */
  notes: string[];
}

/** The instruction given to the agent: the commit title, the files involved and the new test names. */
export function buildPrompt(c: Candidate, newTests: string[]): string {
  const lines = [`${c.title.replace(/\.$/, '')}.`, '', 'Change the code in this repository to do this.'];
  if (c.sourceFiles.length) lines.push(`Relevant files: ${c.sourceFiles.join(', ')}.`);
  if (newTests.length) {
    lines.push('', 'Acceptance criteria:');
    for (const t of newTests) lines.push(`- ${t}`);
  }
  lines.push('', 'Add or update tests next to the files you change.');
  return lines.join('\n');
}

/** The sandbox's own temp folder (the runtime points TMPDIR there). */
const runtimeTmp = (): string[] =>
  process.platform === 'win32' ? [] : [process.platform === 'darwin' ? '/private/tmp/claude' : '/tmp/claude'];

/**
 * What tests may touch: the throwaway workspace only (its .git read-only), no secrets, no network.
 * Exported for tests.
 */
export function policiesFor(ws: Workspace, userTop: string, pmCache: string) {
  for (const d of runtimeTmp()) mkdirSync(d, { recursive: true });
  const writable = [ws.base, ...runtimeTmp()];
  const testPolicy: Policy = { writable, readOnly: [ws.gitDir], hidden: secretPaths(userTop), domains: [] };
  // Test runners are called directly, so put the project's node_modules/.bin first on PATH, as npm does.
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const bins = [...new Set([join(ws.dir, 'node_modules', '.bin'), join(ws.root, 'node_modules', '.bin')])];
  const env = {
    TMPDIR: ws.tmp,
    TEMP: ws.tmp,
    TMP: ws.tmp,
    ...cacheEnv(pmCache),
    [pathKey]: [...bins, process.env[pathKey] ?? ''].join(delimiter),
  };
  return { writable, testPolicy, env };
}

const FAILURE_LINE = /^\s*(?:not ok\b|FAIL\b|[✕×✖●])|\b(?:AssertionError|Error:|ERR_[A-Z_]+|Cannot find module)/;

/**
 * The useful part of a failed run, without colour codes: a few lines around each failure
 * (node --test "not ok", Jest/Vitest "FAIL" and "✕", errors), then the last lines of the summary.
 */
const tail = (r: ExecResult): string => {
  const lines = `${r.stdout}\n${r.stderr}`
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .filter((l) => l.trim() && !/^\s+(?:at |duration_ms:|type: '(?:test|suite)')/.test(l));
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (FAILURE_LINE.test(l)) for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 8); j++) keep.add(j);
  });
  const failures = [...keep]
    .sort((a, b) => a - b)
    .slice(0, 80)
    .map((i) => lines[i]!);
  const summary = lines.slice(-8);
  return [...failures, ...(failures.length ? ['…'] : []), ...summary].join('\n');
};

const PROBLEM =
  /\b(?:error|fail(?:ed|ure)?|not ok|cannot|can't|missing|not found|ENOENT|EACCES|EPERM|timed? ?out)\b|✖|×/i;

/** The most useful lines of output: the last ones that mention a problem, else the last lines. */
const lastLines = (r: ExecResult, n = 2) => {
  const lines = `${r.stdout}\n${r.stderr}`
    .split('\n')
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
    .filter(Boolean);
  const problems = lines.filter((l) => PROBLEM.test(l) && !/^#\s*(?:fail|pass)\s+0$/i.test(l));
  return (problems.length ? problems : lines).slice(-n).join(' | ').slice(0, 240);
};

/**
 * Turn git history into tasks. For each candidate commit, inside the sandbox:
 *   1. check out the commit before it and add the commit's tests: they must FAIL,
 *   2. check out the commit itself: the same tests must PASS.
 * Only then is it a fair task: the tests really check the change.
 */
export async function buildTasks(o: BuildOptions): Promise<BuildResult> {
  const { candidates, scanned, shallow, limitReached } = await findCandidates(o.dir, {
    max: Math.max(o.limit * 10, 30),
    since: o.since,
    requirePackageJson: true,
  });
  o.onProgress?.({ type: 'scan', candidates: candidates.length, scanned });
  const result: BuildResult = { tasks: [], rejected: [], scanned, candidates: candidates.length, notes: [] };
  const note = (message: string) => {
    if (result.notes.includes(message)) return;
    result.notes.push(message);
    o.onProgress?.({ type: 'note', message });
  };
  if (shallow) {
    note(
      'This is a shallow clone, so older commits are missing. Fetch the full history to find more tasks: git fetch --unshallow (in GitHub Actions: actions/checkout with fetch-depth: 0).',
    );
  }
  // Only the newest commits were looked at: say how to look further back when tasks are missing.
  const scanNote = () => {
    if (limitReached && result.tasks.length < o.limit) {
      note(
        `Only the newest ${scanned} commits were looked at. To look further back, give a start date, for example --since "2 years ago" (up to 20,000 commits).`,
      );
    }
  };
  if (candidates.length === 0) {
    scanNote();
    return result;
  }

  const userTop = (await git(o.dir, ['rev-parse', '--show-toplevel'])).trim();
  const ws = await Workspace.create(o.dir);
  try {
    const pmCache = join(cacheDir(), 'pm-cache');
    mkdirSync(pmCache, { recursive: true });
    const { writable, testPolicy, env } = policiesFor(ws, userTop, pmCache);
    let installedHash: string | null = null;
    let lastInstallOutput: ExecResult | undefined;
    // An install that failed or hung fails the same way for every commit with the same dependencies.
    const failedInstalls = new Map<string, { reason: string; output?: ExecResult }>();

    const reject = (c: Candidate, reason: string, output?: ExecResult) => {
      const details = output ? tail(output) : undefined;
      const r: Rejected = { hash: c.hash, title: c.title, reason, ...(details ? { details } : {}) };
      result.rejected.push(r);
      o.onProgress?.({ type: 'rejected', rejected: r });
    };
    const exec = async (command: string, timeoutMs: number, policy: Policy) => {
      const r = await o.sandbox.exec(command, { cwd: ws.dir, timeoutMs, policy, env, signal: o.signal });
      sandboxStillWorks(r);
      return r;
    };

    /** Install dependencies when they changed since the last install. Returns an error reason or null. */
    const ensureDeps = async (pm: Pm): Promise<string | null> => {
      if (!pm.install) return null;
      // A package in a workspace is installed from the workspace root, into the root's node_modules.
      const inWorkspace = pm.installRoot !== '.';
      const installedDir = join(ws.dir, pm.installRoot, 'node_modules');
      if (pm.depsHash === installedHash && (inWorkspace ? existsSync(installedDir) : ws.hasDependencies())) return null;
      const known = failedInstalls.get(pm.depsHash);
      if (known) {
        lastInstallOutput = known.output;
        return known.reason;
      }
      // Parked installs are only the project's own node_modules: never reuse them in a workspace.
      if (installedHash && !inWorkspace) ws.parkDependencies(installedHash);
      installedHash = null;
      if (!inWorkspace && ws.restoreDependencies(pm.depsHash)) {
        installedHash = pm.depsHash;
        return null;
      }
      // Always a fresh install: packages left over from another commit could hide a missing dependency.
      rmSync(join(ws.dir, 'node_modules'), { recursive: true, force: true });
      if (inWorkspace) rmSync(installedDir, { recursive: true, force: true });
      o.onProgress?.({ type: 'install', title: pm.install });
      const policy: Policy = {
        writable: [...writable, pmCache],
        readOnly: [ws.gitDir],
        hidden: secretPaths(userTop, { allowNpmrc: true }), // private registries need their token
        domains: [...registryDomains(ws.dir), ...(o.domains ?? [])],
      };
      const r = await exec(pm.install, o.installTimeoutMs, policy);
      let reason: string | null = null;
      if (r.timedOut) reason = `installing dependencies took longer than ${Math.round(o.installTimeoutMs / 1000)}s`;
      else if (r.code !== 0)
        reason = `"${pm.install}" failed: ${installFailure(`${r.stdout}\n${r.stderr}`) ?? lastLines(r)}`;
      if (reason) {
        lastInstallOutput = r;
        if (!o.signal?.aborted) failedInstalls.set(pm.depsHash, { reason, output: r });
        return reason;
      }
      installedHash = pm.depsHash;
      return null;
    };

    for (const [i, c] of candidates.entries()) {
      if (result.tasks.length >= o.limit || o.signal?.aborted) break;
      o.onProgress?.({ type: 'check', index: i + 1, total: candidates.length, candidate: c });
      try {
        // 1. Before the change, with the commit's tests, test helpers and test settings added
        //    (the same way `setupscore run` judges an agent's change).
        await ws.checkout(c.parent);
        let pm = detectPm(ws.dir, o.overrides);
        if ('error' in pm) {
          reject(c, pm.error);
          continue;
        }
        let fail = await ensureDeps(pm);
        if (fail) {
          reject(c, fail, lastInstallOutput);
          continue;
        }
        const newTests: string[] = [];
        let unreadable: string | null = null;
        for (const f of c.testFiles) {
          const after = await ws.show(c.hash, f);
          if (after === null) {
            unreadable = f;
            break;
          }
          newTests.push(...newTestNames(await ws.show(c.parent, c.previousPaths?.[f] ?? f), after));
        }
        if (unreadable) {
          reject(c, `could not read ${unreadable} from the commit`);
          continue;
        }
        await restoreTestSetup(ws, c.hash, c.testFiles);
        const pmTests = detectPm(ws.dir, o.overrides);
        if ('error' in pmTests) {
          reject(c, pmTests.error);
          continue;
        }
        if (!pmTests.hasTestScript) {
          reject(c, 'package.json has no "test" script (set tasks.test in setupscore.yml to use another command)');
          continue;
        }
        const testCommand = pmTests.test(c.testFiles);
        if (pmTests.wholeScript) {
          note(
            'No known test runner was found in the "test" script, so the whole script runs for each task (every test must pass, and it is slower). To run only the task\'s test files, set tasks.test in setupscore.yml, for example "vitest run {files}".',
          );
        }
        const before = await exec(testCommand, o.timeoutMs, testPolicy);
        if (o.signal?.aborted) break;
        if (before.timedOut) {
          reject(
            c,
            `the tests took longer than ${Math.round(o.timeoutMs / 1000)}s before the change${watchHint(testCommand)}`,
            before,
          );
          continue;
        }
        if (noTestsRan(`${before.stdout}\n${before.stderr}`)) {
          reject(
            c,
            `no tests ran: "${testCommand}" did not find the commit's test files (set tasks.test in setupscore.yml if the test runner needs other arguments)`,
            before,
          );
          continue;
        }
        if (before.code === 0) {
          const why = pmTests.scriptWarning
            ? ` (${pmTests.scriptWarning}; set tasks.test in setupscore.yml to a command that fails when tests fail)`
            : '';
          reject(c, `the tests already pass before the change, so they do not check it${why}`);
          continue;
        }

        // 2. After the change, with the same command.
        await ws.checkout(c.hash);
        pm = detectPm(ws.dir, o.overrides);
        if ('error' in pm) {
          reject(c, pm.error);
          continue;
        }
        fail = await ensureDeps(pm);
        if (fail) {
          reject(c, fail, lastInstallOutput);
          continue;
        }
        const after = await exec(testCommand, o.timeoutMs, testPolicy);
        if (o.signal?.aborted) break;
        if (after.timedOut) {
          reject(
            c,
            `the tests took longer than ${Math.round(o.timeoutMs / 1000)}s after the change${watchHint(testCommand)}`,
            after,
          );
          continue;
        }
        if (after.code !== 0) {
          reject(
            c,
            `the tests fail even after the change (${lastLines(after, 1)}). See "details" in tasks.json`,
            after,
          );
          continue;
        }
        if (noTestsRan(`${after.stdout}\n${after.stderr}`)) {
          reject(c, `no tests ran after the change: "${testCommand}" did not find the commit's test files`, after);
          continue;
        }

        const unique = [...new Set(newTests)];
        const task: Task = {
          id: c.hash.slice(0, 7),
          hash: c.hash,
          parent: c.parent,
          title: c.title,
          date: c.date,
          prompt: buildPrompt(c, unique),
          testFiles: c.testFiles,
          sourceFiles: c.sourceFiles,
          newTests: unique,
          beforeMs: before.ms,
          afterMs: after.ms,
          testCommand,
        };
        result.tasks.push(task);
        o.onProgress?.({ type: 'valid', task });
      } catch (err) {
        if (err instanceof EnvironmentError) throw err;
        reject(c, `could not be checked: ${(err as Error).message}`);
      }
    }
  } finally {
    ws.close();
  }
  scanNote();
  return result;
}

/** A command that may be in watch mode never ends on its own; say so in the reason. */
const watchHint = (command: string) =>
  /\b(?:watch|--watchAll|--watch)\b/.test(command) ? ' (the test command may be in watch mode)' : '';

/** The sandbox itself failing is not the commit's fault: stop instead of rejecting every commit. */
function sandboxStillWorks(r: ExecResult): void {
  const line = r.stderr.split('\n').find((l) => /^(?:bwrap|sandbox-exec): /.test(l.trim()));
  if (line)
    throw new EnvironmentError(`The sandbox stopped working: ${line.trim()}`, [
      'Run "npx setupscore doctor" to check it, then try again.',
    ]);
}
