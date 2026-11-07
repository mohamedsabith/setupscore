import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
// eslint-disable-next-line n/no-unsupported-features/node-builtins -- available in every supported Node (22.12+); only labeled experimental before 22.17
import { createInterface } from 'node:readline/promises';
import pc from 'picocolors';
import { authStatus, endpointProblem, findClaude } from '../agent/claude.js';
import { check } from '../core/check.js';
import type { Config } from '../core/config.js';
import { estimateTokens } from '../core/cost.js';
import { displayPath } from '../core/paths.js';
import { NothingToDo, StoppedEarly, UsageError } from '../core/errors.js';
import { readTextSafely, stripBom, writeFileAtomic } from '../core/fsx.js';
import { enableGracefulStop, onCleanup, shutdown } from '../core/lifecycle.js';
import { redact } from '../core/redact.js';
import { renderRunHtml, renderRunMarkdown, renderRunTerminal, runJson } from '../report/run.js';
import {
  ASSUMED_ATTEMPT_COST_USD,
  executeRun,
  isFinal,
  MIN_ATTEMPT_USD,
  planAttempts,
  type RunEvent,
} from '../run/runner.js';
import { scoreRun, type RunScore } from '../run/score.js';
import { applySetup, snapshotSetup, type SetupSnapshot } from '../run/setups.js';
import {
  RunStore,
  RUN_SCHEMA_VERSION,
  type Attempt,
  type RunOptionsRecord,
  type RunRecord,
  type SetupRecord,
} from '../run/store.js';
import { suggest } from '../run/suggest.js';
import { EnvironmentError, openSandbox, type Sandbox, type SandboxMode } from '../sandbox/index.js';
import { buildTasks, type Task } from '../tasks/build.js';
import { tryGit } from '../tasks/git.js';
import { tempFolderProblem, Workspace } from '../tasks/workspace.js';
import { cacheDir } from '../sandbox/runtime.js';
import { VERSION } from '../version.js';
import { failUnder, type Log } from './report.js';
import { TASKS_SCHEMA_VERSION } from './tasks.js';
import { trimEndWhile } from '../core/text.js';

export interface RunFlags {
  tasks?: string;
  limit?: number;
  setupA: string;
  setupB?: string;
  baseline?: boolean;
  repeat: number;
  budget: number;
  attemptBudget: number;
  maxTurns: number;
  timeout: number;
  model?: string;
  concurrency: number;
  resume?: string;
  yes?: boolean;
  json?: boolean;
  failUnder?: number;
  claudeBin?: string;
  sandbox: SandboxMode;
  /** Options given on the command line (not defaults), to tell what a resume should change. */
  explicit?: Set<string>;
}

export type { Log } from './report.js';

const money = (x: number) => `$${x.toFixed(2)}`;
const secs = (ms: number) =>
  ms >= 60_000
    ? `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`
    : `${Math.round(ms / 1000)}s`;

/** Load tasks from a tasks.json file, with clear messages when it is missing or from another version. */
export function loadTasks(file: string): Task[] {
  const again = ['Build tasks again with: npx setupscore tasks'];
  let data: unknown;
  try {
    const body = readTextSafely(file, 64 * 1024 * 1024);
    if (body === null) throw new Error('it is not a file');
    data = JSON.parse(stripBom(body));
  } catch (err) {
    throw new UsageError(`Cannot read ${file}: ${(err as Error).message}`, again);
  }
  const d = data as { schemaVersion?: unknown; tasks?: unknown } | null;
  if (!d || typeof d !== 'object' || Array.isArray(d))
    throw new UsageError(`${file} is not a setupscore task file.`, again);
  if (d.schemaVersion !== TASKS_SCHEMA_VERSION || !Array.isArray(d.tasks)) {
    throw new UsageError(
      d.schemaVersion === undefined
        ? `${file} is not a setupscore task file (it has no format version).`
        : `${file} was made by a different setupscore version.`,
      again,
    );
  }
  const isText = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
  const texts = (x: unknown) => (Array.isArray(x) ? x.filter(isText) : []);
  const ids = new Set<string>();
  return d.tasks.map((raw: unknown, i: number): Task => {
    const t = raw as Partial<Record<keyof Task, unknown>> | null;
    const ok =
      !!t &&
      typeof t === 'object' &&
      isText(t.id) &&
      isText(t.hash) &&
      isText(t.parent) &&
      isText(t.prompt) &&
      Array.isArray(t.testFiles) &&
      texts(t.testFiles).length > 0 &&
      (t.testCommand === undefined || isText(t.testCommand));
    if (!ok)
      throw new UsageError(
        `Task ${i + 1} in ${file} is incomplete or was edited by hand (it needs id, hash, parent, prompt and testFiles).`,
        again,
      );
    if (ids.has(t.id as string)) throw new UsageError(`Task ${t.id as string} is listed twice in ${file}.`, again);
    ids.add(t.id as string);
    const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);
    return {
      id: t.id as string,
      hash: t.hash as string,
      parent: t.parent as string,
      title: typeof t.title === 'string' ? t.title : (t.id as string),
      date: typeof t.date === 'string' ? t.date : '',
      prompt: t.prompt as string,
      testFiles: texts(t.testFiles),
      sourceFiles: texts(t.sourceFiles),
      newTests: texts(t.newTests),
      beforeMs: num(t.beforeMs),
      afterMs: num(t.afterMs),
      ...(isText(t.testCommand) ? { testCommand: t.testCommand } : {}),
    };
  });
}

/** End a reason with exactly one full stop. */
const sentence = (s: string | undefined) => `${trimEndWhile(s ?? 'unknown reason', (c) => c === '.' || /\s/.test(c))}.`;

/** Ask a yes/no question. Without a terminal (CI), the answer must come from --yes. */
async function confirm(question: string, yes: boolean | undefined): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new UsageError(
      'This run calls Claude and costs money, so setupscore asks first, but there is no terminal to ask in.',
      ['Add --yes to start without a question (for CI), and use --budget to cap the spend.'],
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // Ctrl+C at the question means "no".
    const answer = await new Promise<string>((resolve) => {
      rl.once('SIGINT', () => resolve('n'));
      rl.question(`${question} ${pc.dim('[y/N]')} `).then(resolve, () => resolve('n'));
    });
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

/** Instruction health and start-up tokens for each setup, measured on the current commit. */
async function measureSetups(dir: string, snapshots: SetupSnapshot[], config: Config): Promise<SetupRecord[]> {
  const ws = await Workspace.create(dir);
  try {
    if (!ws.head)
      throw new UsageError('This repository has no commits yet, so there is nothing to test.', [
        'Commit your work first, then run setupscore again.',
      ]);
    await ws.checkout(ws.head);
    const out: SetupRecord[] = [];
    for (const s of snapshots) {
      applySetup(ws.dir, s);
      const r = check(ws.dir, { config: { rules: config.rules ?? {}, ignore: config.ignore ?? [] } });
      const startup = Object.entries(s.files)
        // CLAUDE.md here and in the folders above (monorepo: "../CLAUDE.md"), and rules without paths:.
        .filter(
          ([p]) =>
            /^(?:\.\.\/)*(\.claude\/)?CLAUDE\.md$/.test(p) ||
            (/^\.claude\/rules\//.test(p) && !/^---[\s\S]*?\bpaths\s*:/m.test(s.files[p]!)),
        )
        .reduce((t, [, text]) => t + estimateTokens(text), 0);
      out.push({
        ...s,
        health: s.source === 'none' ? 10 : r.health,
        lintErrors: r.errors,
        lintWarnings: r.warnings,
        startupTokens: startup,
      });
    }
    return out;
  } finally {
    ws.close();
  }
}

function printEvent(e: RunEvent, log: Log, concurrency: number): void {
  switch (e.type) {
    case 'plan':
      if (e.done) log(pc.dim(`Resuming: ${e.done} of ${e.total} attempts already finished, ${e.todo} to go.`));
      break;
    case 'start':
      if (concurrency === 1)
        log(
          pc.dim(
            `[${e.index}/${e.total}] ${e.planned.task.id} · setup ${e.planned.setup.label} · repeat ${e.planned.repeat} · Claude is working…`,
          ),
        );
      break;
    case 'install':
      log(pc.dim(`  installing dependencies in the sandbox: ${e.command}`));
      break;
    case 'retry':
      log(
        pc.yellow(
          `  ${e.planned.task.id} · ${e.planned.setup.label}: ${e.reason}. Trying again ${e.waitMs <= 0 ? 'now' : `in ${e.waitMs < 10_000 ? String(Math.round(e.waitMs / 10) / 100) : Math.round(e.waitMs / 1000)}s`} (not counted against the setup).`,
        ),
      );
      break;
    case 'warning':
      log(pc.yellow(`  ${e.message}`));
      break;
    case 'done': {
      const a = e.attempt;
      const icon =
        a.status === 'passed'
          ? pc.green('✔ passed')
          : a.status === 'failed'
            ? pc.red('✖ failed')
            : a.status === 'cancelled'
              ? pc.yellow('■ stopped')
              : pc.yellow('! not scored');
      const m = a.metrics;
      const stats = m ? pc.dim(`$${m.costUsd.toFixed(2)} · ${m.turns} turns · ${secs(a.ms)}`) : pc.dim(secs(a.ms));
      const why = a.status !== 'passed' && a.reason ? pc.dim(` · ${a.reason}`) : '';
      log(
        `[${e.index}/${e.total}] ${a.taskId} · setup ${a.setup} · repeat ${a.repeat}  ${icon}  ${stats}${why}  ${pc.dim(`(total $${e.spentUsd.toFixed(2)})`)}`,
      );
      break;
    }
  }
}

export interface RunResult {
  run: RunRecord;
  score: RunScore;
  attempts: Attempt[];
  exitCode: number;
}

export interface StartOptions {
  dir: string;
  flags: RunFlags;
  config: Config;
  log: Log;
  /** For `watch`: reuse these tasks and setups instead of reading them. */
  reuse?: { tasks: Task[]; setups: SetupSnapshot[]; comparedTo: string };
  /** With --json: where the results go, also when the run stops early. */
  emitJson?: (text: string) => void;
}

/** Command-line names of the options a resume can be told about. */
const OPTION_FLAGS: Record<string, string> = {
  '--budget': 'budget',
  '--concurrency': 'concurrency',
  '--timeout': 'timeout',
  '--setup-a': 'setupA',
  '--setup-b': 'setupB',
  '--baseline': 'baseline',
  '--repeat': 'repeat',
  '--max-turns': 'maxTurns',
  '--attempt-budget': 'attemptBudget',
  '--model': 'model',
  '--tasks': 'tasks',
  '--limit': 'limit',
};
const flagName = (k: string) => Object.entries(OPTION_FLAGS).find(([, v]) => v === k)?.[0] ?? `--${k}`;

/**
 * Options given on the command line (not defaults). The caller says so in `flags.explicit`;
 * without it they are read from the command line itself.
 */
function explicitOptions(flags: RunFlags, argv: string[] = process.argv.slice(2)): Set<string> {
  if (flags.explicit) return flags.explicit;
  const out = new Set<string>();
  for (const a of argv) {
    if (a === '--') break;
    const key = OPTION_FLAGS[a.split('=')[0]!];
    if (key) out.add(key);
  }
  return out;
}

/** Most attempts one run may plan (repeat x tasks x setups); more is a typo, not a plan. */
const MAX_PLANNED_ATTEMPTS = 10_000;

/**
 * `setupscore run`: check everything first, ask before spending, run every attempt in the sandbox,
 * then score, save reports and print the summary. Partial results are always saved.
 *
 * Everything that can be checked cheaply (git, Claude Code, the sign-in, the gateway address, the
 * setups' git refs, the sandbox) is checked before asking and before the run folder is created,
 * so a problem or a "no" leaves nothing behind.
 */
export async function startRun(o: StartOptions): Promise<RunResult> {
  const { dir, flags, config } = o;
  const log: Log = (m) => o.log(redact(m));
  enableGracefulStop();
  const top = (await tryGit(dir, ['rev-parse', '--show-toplevel']))?.trim();
  if (!top)
    throw new UsageError('This folder is not inside a git repository.', [
      'setupscore run builds tasks from git history, so run it inside a repository.',
    ]);
  if (!(await tryGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']))?.trim()) {
    throw new UsageError('This repository has no commits yet, so there is nothing to test.', [
      'Commit your work first, then run setupscore again.',
    ]);
  }
  const given = explicitOptions(flags);

  // 1. Claude Code, its sign-in, and the address it will call.
  const claude = await findClaude(flags.claudeBin ?? config.agent?.bin);
  if (!claude) {
    const bin = flags.claudeBin ?? config.agent?.bin;
    throw new EnvironmentError(
      bin
        ? `Claude Code was not found: "${bin} --version" did not run, failed or printed nothing.`
        : 'Claude Code was not found.',
      [
        'Install it: npm install -g @anthropic-ai/claude-code   (or see https://docs.claude.com/en/docs/claude-code)',
        bin
          ? 'Check the path given to --claude-bin (or agent.bin in setupscore.yml).'
          : 'If it is installed somewhere else, pass the path: --claude-bin /path/to/claude',
      ],
    );
  }
  const auth = authStatus();
  if (!auth.ok)
    throw new EnvironmentError('Claude Code has no key or token to use inside the sandbox.', auth.fix!.split('\n'));
  const endpoint = await endpointProblem({ sandboxed: flags.sandbox !== 'none' });
  if (endpoint) throw new EnvironmentError(endpoint.message, endpoint.fixes);
  const folders = tempFolderProblem({
    sandboxed: flags.sandbox !== 'none',
    dirs: [
      {
        label: 'The project',
        path: top,
        fix: 'Move the project to a folder on disk (not under /dev/shm), or run without the sandbox on a throwaway machine: --sandbox none --yes',
      },
      {
        label: "setupscore's cache folder",
        path: cacheDir(),
        fix: 'Point SETUPSCORE_CACHE_DIR at a folder on disk, or unset it.',
      },
    ],
  });
  if (folders) throw new EnvironmentError(folders.message, folders.fixes);
  // The cache holds the package cache every install uses: it must be a folder setupscore can write.
  try {
    mkdirSync(join(cacheDir(), 'pm-cache'), { recursive: true });
  } catch (err) {
    throw new EnvironmentError(
      `setupscore's cache folder ${cacheDir()} cannot be used (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}).`,
      [
        process.env.SETUPSCORE_CACHE_DIR
          ? 'Point SETUPSCORE_CACHE_DIR at a folder you can write to, or unset it.'
          : 'Check that you can write to it, or set SETUPSCORE_CACHE_DIR to another folder.',
      ],
    );
  }
  if (flags.repeat > 1000)
    throw new UsageError(`--repeat ${flags.repeat} is too many.`, [
      'Use --repeat 1 to 10; 3 to 5 is usually enough to see a difference.',
    ]);

  let store: RunStore | undefined;
  let run: RunRecord;
  let sandbox: Sandbox | undefined;
  let nothingLeft = false;
  try {
    // 2. The run: resumed, or new with tasks and setups.
    if (flags.resume !== undefined) {
      store = RunStore.open(dir, flags.resume);
      run = store.readRun();
      // One setupscore process per run: a second resume of the same run stops here, before spending.
      store.lock();
      run = store.readRun();
      if (run.tool.version !== VERSION) {
        log(
          pc.yellow(
            `Run ${run.id} was made by a different setupscore version (${run.tool.version}; this is ${VERSION}). Its results will mix attempts from both versions.`,
          ),
        );
      }
      // A resumed run keeps its settings. Only the budget, concurrency and time limit can change.
      const ignored = [
        'setupA',
        'setupB',
        'baseline',
        'repeat',
        'maxTurns',
        'attemptBudget',
        'model',
        'tasks',
        'limit',
      ].filter((k) => given.has(k));
      if (ignored.length) {
        log(
          pc.yellow(
            `Ignored when resuming (a resumed run keeps its settings): ${ignored.map(flagName).join(', ')}. Start a new run to change them.`,
          ),
        );
      }
      const change: Partial<RunOptionsRecord> = {};
      if (given.has('budget')) change.budgetUsd = flags.budget;
      if (given.has('concurrency')) change.concurrency = flags.concurrency;
      if (given.has('timeout')) change.agentTimeoutMin = flags.timeout;
      const options = { ...run.options, ...change };

      const damaged: string[] = []; // shown here only when nothing runs (the run itself shows them otherwise)
      const left =
        planAttempts(run).length -
        new Set(
          store
            .readAttempts((m) => damaged.push(m))
            .filter(isFinal)
            .map((a) => a.key),
        ).size;
      const spent = store.spentUsd();
      if (left === 0) {
        // Nothing to run: the run and its settings stay exactly as they are.
        nothingLeft = true;
        for (const m of damaged) log(pc.yellow(m));
        log(pc.green(`Run ${run.id} is already complete.`) + pc.dim(' Showing its results.'));
      } else {
        const remaining = options.budgetUsd - spent;
        if (remaining < MIN_ATTEMPT_USD) {
          const needed = Math.ceil(spent + left * ASSUMED_ATTEMPT_COST_USD + 1);
          throw new StoppedEarly(
            `Run ${run.id} has used its budget (${money(spent)} of ${money(options.budgetUsd)} spent, ${left} attempt${left === 1 ? '' : 's'} left). Nothing more was spent.`,
            [`Continue with a bigger budget: npx setupscore run --resume ${run.id} --budget ${needed}`],
          );
        }
        sandbox = await openSandbox({ mode: flags.sandbox, cwd: dir, yes: flags.yes, log });
        log(
          `${pc.bold('Resume')}: run ${run.id}, ${left} attempt${left === 1 ? '' : 's'} left, about ${money(left * ASSUMED_ATTEMPT_COST_USD)}. ${money(spent)} spent so far; the run stops at ${money(options.budgetUsd)}.`,
        );
        const changed = [
          given.has('budget') && `--budget ${options.budgetUsd}`,
          given.has('concurrency') && `--concurrency ${options.concurrency}`,
          given.has('timeout') && `--timeout ${options.agentTimeoutMin}`,
        ].filter(Boolean);
        if (changed.length) log(pc.dim(`Changed for the rest of this run: ${changed.join(', ')}.`));
        if (!(await confirm('Continue the run?', flags.yes)))
          throw new UsageError('Resume cancelled. Nothing more was spent.');
        if (Object.keys(change).length) run = store.update({ options });
      }
    } else {
      // Setups first: a wrong --setup-b is reported before anything slow happens.
      const warn = (m: string) => log(pc.yellow(m));
      const snapshots = o.reuse?.setups ?? [
        await snapshotSetup(dir, flags.setupA, 'A', warn),
        ...(flags.setupB ? [await snapshotSetup(dir, flags.setupB, 'B', warn)] : []),
        ...(flags.baseline ? [await snapshotSetup(dir, 'none', 'baseline', warn)] : []),
      ];
      let tasks = o.reuse?.tasks;
      if (!tasks) {
        const file = flags.tasks ?? join(dir, '.setupscore', 'tasks.json');
        if (existsSync(file)) tasks = loadTasks(file);
        else if (flags.tasks)
          throw new UsageError(`Task file not found: ${flags.tasks}`, ['Build tasks with: npx setupscore tasks']);
      }
      sandbox = await openSandbox({ mode: flags.sandbox, cwd: dir, yes: flags.yes, log });
      if (!tasks) {
        log(pc.dim('No tasks yet: building them from your git history first (the same as "setupscore tasks").'));
        const built = await buildTasks({
          dir,
          sandbox,
          limit: flags.limit ?? 10,
          timeoutMs: 120_000,
          installTimeoutMs: 600_000,
          domains: config.sandbox?.domains,
          overrides: config.tasks,
          signal: shutdown.signal,
        });
        if (shutdown.signal.aborted) throw new StoppedEarly('Stopped while building tasks. Nothing was spent.');
        tasks = built.tasks;
        log(
          pc.dim(
            `Built ${tasks.length} task${tasks.length === 1 ? '' : 's'} (${built.rejected.length} commit${built.rejected.length === 1 ? '' : 's'} skipped).`,
          ),
        );
        // Save them, as "setupscore tasks" does, so the next run does not build them again.
        try {
          mkdirSync(join(dir, '.setupscore'), { recursive: true, mode: 0o700 });
          writeFileAtomic(
            join(dir, '.setupscore', 'tasks.json'),
            `${JSON.stringify({ schemaVersion: TASKS_SCHEMA_VERSION, tasks: built.tasks, rejected: built.rejected }, null, 2)}\n`,
          );
        } catch {
          // only a cache
        }
      }
      if (flags.limit) tasks = tasks.slice(0, flags.limit);
      if (!tasks.length) {
        throw new NothingToDo('There are no usable tasks to run.', [
          'setupscore needs commits that changed both code and tests, where the tests fail before and pass after.',
          'Try more history: npx setupscore tasks --since "1 year ago" --limit 20',
        ]);
      }
      const planned = tasks.length * snapshots.length * flags.repeat;
      if (planned > MAX_PLANNED_ATTEMPTS) {
        throw new UsageError(
          `That is ${planned} Claude Code sessions, more than the ${MAX_PLANNED_ATTEMPTS} one run can hold.`,
          ['Use fewer repeats (--repeat) or tasks (--limit).'],
        );
      }
      for (const s of snapshots) {
        if (s.source !== 'none' && Object.keys(s.files).length === 0) {
          log(
            pc.yellow(
              `Setup ${s.label} (${s.source}) has no CLAUDE.md, .claude/ or .mcp.json, so it is the same as no instructions.`,
            ),
          );
        }
      }
      const setups = await measureSetups(dir, snapshots, config);
      const head = (await tryGit(dir, ['rev-parse', 'HEAD']))?.trim() ?? null;
      run = {
        schemaVersion: RUN_SCHEMA_VERSION,
        id: RunStore.newId(),
        createdAt: new Date().toISOString(),
        status: 'running',
        head,
        tool: { version: VERSION, claudeCode: claude.version },
        options: {
          repeat: flags.repeat,
          budgetUsd: flags.budget,
          maxTurns: flags.maxTurns,
          attemptBudgetUsd: flags.attemptBudget,
          agentTimeoutMin: flags.timeout,
          model: flags.model ?? config.agent?.model,
          concurrency: flags.concurrency,
          sandbox: flags.sandbox,
        },
        tasks,
        setups,
        comparedTo: o.reuse?.comparedTo,
      };

      // 3. Show the plan and the likely cost, then ask.
      const attempts = planned;
      const estimate = attempts * ASSUMED_ATTEMPT_COST_USD;
      const perSession = Math.max(MIN_ATTEMPT_USD, flags.attemptBudget);
      log('');
      log(
        `${pc.bold('Plan')}: ${tasks.length} task${tasks.length === 1 ? '' : 's'} × ${setups.length} setup${setups.length === 1 ? '' : 's'} (${setups.map((s) => `${s.label} = ${s.source}`).join(', ')}) × ${flags.repeat} repeat${flags.repeat === 1 ? '' : 's'} = ${attempts} Claude Code session${attempts === 1 ? '' : 's'}`,
      );
      log(
        `${pc.bold('Cost')}: about ${money(estimate)} (assuming ~${money(ASSUMED_ATTEMPT_COST_USD)} per session; the real cost is measured as it runs). The run stops at ${money(flags.budget)}, and each session at ${money(perSession)}${perSession > flags.attemptBudget ? ` (the smallest limit; --attempt-budget ${flags.attemptBudget} is raised to it)` : ''}.`,
      );
      if (estimate > flags.budget) {
        const n = Math.max(1, Math.floor(flags.budget / ASSUMED_ATTEMPT_COST_USD));
        log(
          pc.yellow(
            `  The budget will probably stop the run after about ${n} session${n === 1 ? '' : 's'}. Results so far are kept, and --resume continues.`,
          ),
        );
      }
      log(
        pc.dim(
          `Claude Code ${claude.version} · signs in with ${auth.via} · model ${run.options.model ?? 'default'} · sandbox: ${sandbox.label}`,
        ),
      );
      if (shutdown.signal.aborted) throw new StoppedEarly('Stopped before the run started. Nothing was spent.');
      if (!(await confirm('Start the run?', flags.yes))) {
        throw new UsageError('Run cancelled. Nothing was spent.');
      }
      // A .setupscore that links out of the project (a cloned repository could commit one) is used,
      // but the results then land elsewhere: say where.
      const stash = join(dir, '.setupscore');
      try {
        if (lstatSync(stash).isSymbolicLink()) {
          const target = realpathSync(stash);
          const rel = relative(realpathSync(top), target);
          if (rel.startsWith('..') || isAbsolute(rel))
            log(pc.yellow(`.setupscore is a link to ${target}, outside the project: the results are written there.`));
        }
      } catch {
        // no .setupscore yet
      }
      // Only now does the run exist on disk (and it is locked to this process from the start).
      store = RunStore.create(dir, run);
    }
  } catch (err) {
    store?.unlock();
    await sandbox?.close().catch(() => {});
    // Ctrl+C (or SIGTERM) before the run started also stops what was running (git, the task
    // build), and that can surface as their error: it is a stop, not a problem.
    if (shutdown.signal.aborted && !(err instanceof UsageError) && !(err instanceof StoppedEarly)) {
      throw new StoppedEarly('Stopped before the run started. Nothing was spent.');
    }
    throw err;
  }

  // 4. Run. Ctrl+C, SIGTERM or SIGHUP stop it gracefully (see core/lifecycle.ts); one process per run.
  const s = store;
  const releaseOnExit = onCleanup(() => {
    // setupscore is quitting before the end (a second Ctrl+C): never leave the run marked "running".
    try {
      if (s.readRun().status === 'running')
        s.update({
          status: 'stopped',
          stopReason: 'setupscore was stopped before it could finish',
          finishedAt: new Date().toISOString(),
        });
    } catch {
      // best effort
    }
    s.unlock();
  });
  let outcome: Awaited<ReturnType<typeof executeRun>> | undefined;
  try {
    if (!nothingLeft) {
      log(pc.dim(`Run ${run.id} · sandbox: ${sandbox!.label} · results in ${displayPath(s.dir)}`));
      run = s.update({ status: 'running', stopReason: undefined, finishedAt: undefined });
      outcome = await executeRun({
        dir,
        store: s,
        run,
        sandbox: sandbox!,
        claudeBin: claude.bin,
        signal: shutdown.signal,
        overrides: config.tasks,
        domains: config.sandbox?.domains,
        onEvent: (e) => printEvent(e, log, run.options.concurrency),
      });
      run = s.update({ status: outcome.status, stopReason: outcome.reason, finishedAt: new Date().toISOString() });
    } else if (run.status === 'running') {
      // Left "running" by a setupscore that stopped after its last attempt: it is complete.
      run = s.update({ status: 'completed', stopReason: undefined, finishedAt: new Date().toISOString() });
    }
  } catch (err) {
    // Whatever went wrong, the run must not stay "running": mark it and keep what finished.
    try {
      s.update({
        status: 'failed',
        stopReason: (err as Error)?.message ?? String(err),
        finishedAt: new Date().toISOString(),
      });
    } catch {
      // the store itself may be what failed
    }
    throw err;
  } finally {
    await sandbox?.close().catch(() => {});
    s.unlock();
    releaseOnExit();
  }

  // 5. Score and reports. Writing a report never hides the results.
  const attempts = s.readAttempts();
  const score = scoreRun(run, attempts);
  const suggestions = suggest(run, attempts, score, dir);
  let htmlPath: string | undefined;
  try {
    if (!nothingLeft) {
      htmlPath = displayPath(s.writeFile('report.html', renderRunHtml(run, score, attempts, suggestions)));
      const md = renderRunMarkdown(run, score, suggestions);
      s.writeFile('report.md', md);
      // For CI (the GitHub Action): a copy of this run's Markdown summary at a path the caller chose,
      // so it never posts an older run's report.
      if (process.env.SETUPSCORE_REPORT_FILE) writeFileAtomic(process.env.SETUPSCORE_REPORT_FILE, redact(md));
      s.writeFile('results.json', `${JSON.stringify(runJson(run, score, attempts, suggestions), null, 2)}\n`);
    } else if (existsSync(join(s.dir, 'report.html'))) {
      htmlPath = displayPath(join(s.dir, 'report.html'));
    }
  } catch (err) {
    log(pc.yellow(`Could not save the report files: ${(err as Error).message}`));
  }
  const status = outcome?.status ?? 'completed';
  const scored = attempts.filter(isFinal).length;
  const ending = status !== 'completed' || scored === 0;
  const json = () => redact(JSON.stringify(runJson(run, score, attempts, suggestions), null, 2));
  if (flags.json) {
    // The results always reach stdout with --json, also when the run stops early (exit 3 or 4):
    // CI tools read them there. On success the caller prints them.
    if (o.emitJson) o.emitJson(json());
    else if (ending) process.stdout.write(`${json()}\n`);
  } else {
    log('');
    log(renderRunTerminal(run, score, suggestions, { html: htmlPath }));
  }

  if (outcome?.status === 'failed') {
    throw new EnvironmentError(`The run stopped: ${sentence(redact(outcome.reason ?? ''))}`, [
      ...(outcome.fix ? [outcome.fix] : []),
      `Finished attempts are saved. After fixing it: npx setupscore run --resume ${run.id}`,
    ]);
  }
  if (outcome?.status === 'stopped') {
    throw new StoppedEarly(
      `The run stopped early: ${sentence(redact(outcome.reason ?? ''))} The results above are partial.`,
      outcome.fix ? [outcome.fix] : [],
    );
  }
  // Nothing could be measured (for example the API was down the whole time): that is not a pass.
  if (scored === 0) {
    const reason = score.setups.find((x) => x.infraReason)?.infraReason;
    throw new EnvironmentError(`No attempt could be scored${reason ? `: ${sentence(redact(reason))}` : '.'}`, [
      "Nothing here is the setup's fault. Fix the problem above, then try the same attempts again:",
      `  npx setupscore run --resume ${run.id}`,
    ]);
  }
  // The same rule as "setupscore report --fail-under": the first setup with instruction files.
  const exitCode = flags.failUnder !== undefined ? failUnder(run, score, flags.failUnder, log) : 0;
  return { run, score, attempts, exitCode };
}
