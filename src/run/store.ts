import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { forEachLine, mkdirPrivate, readTextSafely, stripBom, writeFileAtomic } from '../core/fsx.js';
import { redact } from '../core/redact.js';
import { emptyMetrics, type AgentMetrics } from '../agent/transcript.js';
import { UsageError } from '../core/errors.js';
import type { Task } from '../tasks/build.js';
import type { SetupSnapshot } from './setups.js';

/**
 * Results are plain JSON files, so they work on every Node.js version, survive crashes and are
 * easy to read or share:
 *   .setupscore/runs/<run-id>/run.json         what was run and how
 *   .setupscore/runs/<run-id>/attempts.jsonl   one finished attempt per line (append-only)
 *   .setupscore/runs/<run-id>/transcripts/     the agent's full stream-json output
 *   .setupscore/latest                         id of the newest run
 */
export const RUN_SCHEMA_VERSION = 1;

type AttemptStatus = 'passed' | 'failed' | 'error' | 'cancelled';
/** Why an attempt did not pass. Only "task" counts against the setup. */
type FailureKind = 'task' | 'infra';

export interface SetupRecord extends SetupSnapshot {
  /** Instruction health of this setup, 0-10 (from setupscore check). */
  health: number;
  /** Rough tokens sent with every message. */
  startupTokens: number;
  lintErrors: number;
  lintWarnings: number;
}

export interface RunOptionsRecord {
  repeat: number;
  budgetUsd: number;
  maxTurns: number;
  attemptBudgetUsd: number;
  agentTimeoutMin: number;
  model?: string;
  concurrency: number;
  sandbox: string;
}

export interface RunRecord {
  schemaVersion: typeof RUN_SCHEMA_VERSION;
  id: string;
  createdAt: string;
  finishedAt?: string;
  /** running, completed, stopped (budget or Ctrl+C), failed (could not continue). */
  status: 'running' | 'completed' | 'stopped' | 'failed';
  stopReason?: string;
  head: string | null;
  tool: { version: string; claudeCode?: string };
  options: RunOptionsRecord;
  tasks: Task[];
  setups: SetupRecord[];
  /** Set by "setupscore watch": the run this one is compared with. */
  comparedTo?: string;
  /** The model Claude Code reported using (it can differ from options.model, for example for an alias or a retired id). */
  modelUsed?: string;
}

export interface CheckResults {
  /** Did the hidden tests pass after the agent's change? null when they could not run. */
  testsPassed: boolean | null;
  testOutput?: string;
  /** Instructions from the setup that the agent's change broke. */
  ruleViolations: { rule: string; token: string; file: string }[];
  filesChanged: string[];
  /** The agent ran the project's tests itself before finishing. */
  ranTests: boolean;
  /** The agent changed setup files (CLAUDE.md, .claude/). */
  touchedSetup: boolean;
  /** Commands or paths that looked for the answer outside the task. The attempt then counts as failed. */
  lookedOutside?: string[];
}

export interface Attempt {
  /** task|setup|repeat: unique within a run, used by --resume. */
  key: string;
  taskId: string;
  setup: string;
  repeat: number;
  status: AttemptStatus;
  failureKind?: FailureKind;
  reason?: string;
  metrics?: AgentMetrics;
  checks?: CheckResults;
  startedAt: string;
  finishedAt: string;
  ms: number;
  /** How many times an infra problem made us try again. */
  retries: number;
}

export const attemptKey = (taskId: string, setup: string, repeat: number) => `${taskId}|${setup}|${repeat}`;

/** Run ids are file names inside .setupscore/runs: letters, digits, dots, dashes and underscores only. */
const RUN_ID = /^(?!\.)[\w.-]{1,80}$/;
const STATUSES = new Set(['passed', 'failed', 'error', 'cancelled']);

/** A number, also when written as a numeric string by hand ("0.05"); NaN otherwise. */
const asNumber = (x: unknown): number =>
  typeof x === 'number' ? x : typeof x === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(x) ? Number(x) : NaN;
const finiteCost = (x: unknown) => {
  const n = asNumber(x);
  return Number.isFinite(n) && n > 0 && n < 1e6 ? n : 0;
};

// Readers for data that may have been damaged or edited by hand: each returns a value of the
// right type (or a safe default), so nothing that reads a run later can crash on a wrong type.
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const optText = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const texts = (v: unknown, max = 10_000): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max) : [];
const flag = (v: unknown): boolean => v === true;
/** A plain map (no prototype, so keys such as "constructor" or "__proto__" are just keys). */
const numberMap = (v: unknown): Record<string, number> => {
  const out = Object.create(null) as Record<string, number>;
  if (isObj(v))
    for (const [k, n] of Object.entries(v)) if (typeof n === 'number' && Number.isFinite(n) && n >= 0) out[k] = n;
  return out;
};
const OUTCOMES = new Set(['completed', 'max_turns', 'budget', 'error', 'no_result']);

function readMetrics(v: unknown): AgentMetrics | undefined {
  if (!isObj(v)) return undefined;
  return {
    ...emptyMetrics(),
    modelsUsed: texts(v.modelsUsed),
    resultCount: count(v.resultCount),
    ranTests: flag(v.ranTests),
    apiRetriesAtEnd: count(v.apiRetriesAtEnd),
    toolsRunningAtEnd: count(v.toolsRunningAtEnd),
    finalErrorCode: optText(v.finalErrorCode),
    apiErrorStatus:
      typeof v.apiErrorStatus === 'number' && Number.isFinite(v.apiErrorStatus) ? v.apiErrorStatus : undefined,
    apiErrorKind: optText(v.apiErrorKind),
    lastEventKind: optText(v.lastEventKind) as AgentMetrics['lastEventKind'],
    lastRetryError: optText(v.lastRetryError),
    lastProgressAt: optText(v.lastProgressAt),
    outcome: (OUTCOMES.has(v.outcome as string) ? v.outcome : 'no_result') as AgentMetrics['outcome'],
    resultSubtype: optText(v.resultSubtype),
    isError: flag(v.isError),
    result: optText(v.result),
    costUsd: finiteCost(v.costUsd),
    turns: count(v.turns),
    durationMs: count(v.durationMs),
    inputTokens: count(v.inputTokens),
    outputTokens: count(v.outputTokens),
    cacheReadTokens: count(v.cacheReadTokens),
    cacheWriteTokens: count(v.cacheWriteTokens),
    toolCalls: numberMap(v.toolCalls),
    bashCommands: texts(v.bashCommands),
    failedCommands: texts(v.failedCommands),
    filesEdited: texts(v.filesEdited),
    pathsRead: texts(v.pathsRead),
    textWritten: texts(v.textWritten),
    skillsUsed: texts(v.skillsUsed),
    subagentsUsed: texts(v.subagentsUsed),
    mcpServers: Array.isArray(v.mcpServers)
      ? v.mcpServers.filter(isObj).map((s) => ({ name: text(s.name, '?'), status: text(s.status, '?') }))
      : [],
    errorCodes: texts(v.errorCodes),
    apiRetries: count(v.apiRetries),
    model: optText(v.model),
    apiKeySource: optText(v.apiKeySource),
    sessionId: optText(v.sessionId),
    claudeCodeVersion: optText(v.claudeCodeVersion),
    skillsAvailable: texts(v.skillsAvailable),
    memoryPaths: texts(v.memoryPaths),
    terminalReason: optText(v.terminalReason),
    parsedLines: count(v.parsedLines),
    badLines: count(v.badLines),
  };
}

function readChecks(v: unknown): CheckResults | undefined {
  if (!isObj(v)) return undefined;
  const out: CheckResults = {
    testsPassed: typeof v.testsPassed === 'boolean' ? v.testsPassed : null,
    testOutput: typeof v.testOutput === 'string' ? capOutput(v.testOutput) : undefined,
    ruleViolations: Array.isArray(v.ruleViolations)
      ? v.ruleViolations
          .filter(isObj)
          .map((r) => ({ rule: text(r.rule), token: text(r.token), file: text(r.file) }))
          .filter((r) => r.token)
      : [],
    filesChanged: texts(v.filesChanged),
    ranTests: flag(v.ranTests),
    touchedSetup: flag(v.touchedSetup),
  };
  if (v.lookedOutside !== undefined) out.lookedOutside = texts(v.lookedOutside);
  return out;
}

/** What one attempt keeps of the test output and of reasons: enough to see what failed. */
export const MAX_TEST_OUTPUT = 8 * 1024;
const MAX_REASON = 1024;
const MAX_OUTPUT_LINE = 500;

/** Keep the end of a long text (where test summaries are), with long lines shortened. */
export function capOutput(s: string, max = MAX_TEST_OUTPUT): string {
  let lines = s.split('\n').map((l) => (l.length > MAX_OUTPUT_LINE ? `${l.slice(0, MAX_OUTPUT_LINE)}…` : l));
  let total = lines.reduce((t, l) => t + l.length + 1, 0);
  let dropped = false;
  while (total > max && lines.length > 1) {
    total -= lines[0]!.length + 1;
    lines = lines.slice(1);
    dropped = true;
  }
  const out = (dropped ? ['…', ...lines] : lines).join('\n');
  return out.length > max ? out.slice(-max) : out;
}

const capReason = (s: string | undefined): string | undefined =>
  s === undefined ? undefined : s.length > MAX_REASON ? `${s.slice(0, MAX_REASON)}…` : s;

/** Parse an attempts.jsonl line; null for anything that is not a usable attempt. */
export function parseAttempt(line: string): Attempt | null {
  let a: unknown;
  try {
    a = JSON.parse(line.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  if (!isObj(a)) return null;
  if (
    typeof a.key !== 'string' ||
    !a.key ||
    typeof a.taskId !== 'string' ||
    typeof a.setup !== 'string' ||
    !STATUSES.has(a.status as string)
  )
    return null;
  return {
    key: a.key,
    taskId: a.taskId,
    setup: a.setup,
    repeat: typeof a.repeat === 'number' && Number.isInteger(a.repeat) && a.repeat > 0 ? a.repeat : 1,
    status: a.status as AttemptStatus,
    failureKind: a.failureKind === 'task' || a.failureKind === 'infra' ? a.failureKind : undefined,
    reason: capReason(optText(a.reason)),
    metrics: readMetrics(a.metrics),
    checks: readChecks(a.checks),
    startedAt: text(a.startedAt),
    finishedAt: text(a.finishedAt),
    ms: count(a.ms),
    retries: count(a.retries),
  };
}

/** Check and clean a run.json; throws a plain message for anything that cannot be used. */
function readRunRecord(data: unknown): RunRecord {
  if (!isObj(data)) throw new Error('run.json is empty');
  if (data.schemaVersion !== RUN_SCHEMA_VERSION) throw new SchemaMismatch(data.schemaVersion);
  if (!Array.isArray(data.tasks) || !Array.isArray(data.setups) || !isObj(data.options))
    throw new Error('it has no tasks, setups or options');
  const o: Obj = { ...data.options };
  for (const k of ['repeat', 'concurrency', 'agentTimeoutMin', 'maxTurns', 'budgetUsd', 'attemptBudgetUsd'])
    o[k] = asNumber(o[k]);
  const positive = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x > 0;
  if (
    !positive(o.repeat) ||
    !positive(o.concurrency) ||
    !positive(o.agentTimeoutMin) ||
    !positive(o.maxTurns) ||
    !positive(o.budgetUsd) ||
    !positive(o.attemptBudgetUsd)
  ) {
    throw new Error('its options are incomplete');
  }
  if ((o.repeat as number) > 1000 || !Number.isInteger(o.repeat))
    throw new Error('its repeat count is not a whole number up to 1000');
  const ids = new Set<string>();
  const tasks: Task[] = data.tasks.map((t: unknown) => {
    if (
      !isObj(t) ||
      typeof t.id !== 'string' ||
      !t.id ||
      typeof t.hash !== 'string' ||
      typeof t.parent !== 'string' ||
      !Array.isArray(t.testFiles)
    )
      throw new Error('a task is incomplete');
    if (ids.has(t.id)) throw new Error(`task ${t.id} is listed twice`);
    ids.add(t.id);
    return {
      id: t.id,
      hash: t.hash,
      parent: t.parent,
      title: text(t.title, t.id),
      date: text(t.date),
      prompt: text(t.prompt),
      testFiles: texts(t.testFiles),
      sourceFiles: texts(t.sourceFiles),
      newTests: texts(t.newTests),
      beforeMs: count(t.beforeMs),
      afterMs: count(t.afterMs),
      ...(typeof t.testCommand === 'string' && t.testCommand ? { testCommand: t.testCommand } : {}),
    };
  });
  const labels = new Set<string>();
  const setups: SetupRecord[] = data.setups.map((s: unknown) => {
    if (!isObj(s) || typeof s.label !== 'string' || !s.label || typeof s.source !== 'string' || !isObj(s.files))
      throw new Error('a setup is incomplete');
    if (labels.has(s.label)) throw new Error(`setup ${s.label} is listed twice`);
    labels.add(s.label);
    const files: Record<string, string> = {};
    for (const [p, body] of Object.entries(s.files)) if (typeof body === 'string') files[p] = body;
    const health = typeof s.health === 'number' && Number.isFinite(s.health) ? Math.min(10, Math.max(0, s.health)) : 0;
    const executable = texts(s.executable).filter((f) => f in files);
    return {
      label: s.label,
      source: s.source,
      files,
      ...(executable.length ? { executable } : {}),
      health,
      startupTokens: count(s.startupTokens),
      lintErrors: count(s.lintErrors),
      lintWarnings: count(s.lintWarnings),
    };
  });
  const statuses = new Set(['running', 'completed', 'stopped', 'failed']);
  const tool = isObj(data.tool) ? data.tool : {};
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    id: text(data.id),
    createdAt: text(data.createdAt),
    finishedAt: optText(data.finishedAt),
    status: (statuses.has(data.status as string) ? data.status : 'stopped') as RunRecord['status'],
    stopReason: optText(data.stopReason),
    head: optText(data.head) ?? null,
    tool: {
      version: text(tool.version, '?'),
      ...(typeof tool.claudeCode === 'string' ? { claudeCode: tool.claudeCode } : {}),
    },
    options: {
      repeat: o.repeat as number,
      budgetUsd: o.budgetUsd as number,
      maxTurns: o.maxTurns as number,
      attemptBudgetUsd: o.attemptBudgetUsd as number,
      agentTimeoutMin: o.agentTimeoutMin as number,
      model: optText(o.model),
      concurrency: o.concurrency as number,
      sandbox: text(o.sandbox, 'auto'),
    },
    tasks,
    setups,
    comparedTo: optText(data.comparedTo),
    ...(typeof data.modelUsed === 'string' ? { modelUsed: data.modelUsed } : {}),
  };
}

class SchemaMismatch extends Error {
  constructor(readonly found: unknown) {
    super('different version');
  }
}

export class RunStore {
  readonly dir: string;
  private lockFile: string | null = null;
  private constructor(
    readonly root: string,
    readonly id: string,
  ) {
    this.dir = join(root, 'runs', id);
  }

  static base(projectDir: string): string {
    return join(projectDir, '.setupscore');
  }

  /** A new, sortable run id in UTC: 20261105-153012-a1b2. */
  static newId(): string {
    const d = new Date();
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${randomBytes(2).toString('hex')}`;
  }

  /** Refuse ids that could point outside .setupscore/runs (for example "../../x"). */
  static checkId(id: string): void {
    if (!RUN_ID.test(id) || id.includes('..')) {
      throw new UsageError(`"${id}" is not a valid run id.`, [
        'Run ids look like 20261105-153012-a1b2. List them with: ls .setupscore/runs',
      ]);
    }
  }

  static create(projectDir: string, record: RunRecord): RunStore {
    RunStore.checkId(record.id);
    const store = new RunStore(RunStore.base(projectDir), record.id);
    try {
      mkdirPrivate(store.root);
      mkdirSync(join(store.root, 'runs'), { recursive: true, mode: 0o700 });
      mkdirSync(store.dir, { mode: 0o700 }); // fails if this id is already taken
      mkdirSync(join(store.dir, 'transcripts'), { mode: 0o700 });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'EEXIST' && existsSync(join(store.dir)))
        throw new UsageError(`A run with id ${record.id} already exists. Try again.`);
      throw new UsageError(`Cannot create ${store.dir}: ${e.message}`, [
        'Check that you can write to this folder, and that .setupscore is a folder (not a file).',
      ]);
    }
    // Taken before run.json says "running", so a reader never sees a running run without an owner.
    store.lock();
    try {
      store.saveRun(record);
    } catch (err) {
      store.unlock();
      rmSync(store.dir, { recursive: true, force: true });
      throw err;
    }
    store.setLatest();
    return store;
  }

  /** Point .setupscore/latest at this run (replacing it, never writing through a link). */
  setLatest(): void {
    try {
      writeFileAtomic(join(this.root, 'latest'), `${this.id}\n`, 0o600);
    } catch {
      // only a convenience: "latest" falls back to the newest run folder
    }
  }

  /** Open an existing run. `id` may be "latest". */
  static open(projectDir: string, id = 'latest'): RunStore {
    const root = RunStore.base(projectDir);
    let runId = id.trim();
    if (!runId) throw new UsageError('No run id given.', ['Use a run id from .setupscore/runs, or "latest".']);
    if (runId === 'latest') {
      const pointer = readTextSafely(join(root, 'latest'), 256)?.trim() ?? '';
      const known = RunStore.list(projectDir);
      runId =
        pointer && RUN_ID.test(pointer) && !pointer.includes('..') && known.includes(pointer)
          ? pointer
          : (known.at(-1) ?? '');
      if (!runId)
        throw new UsageError('There are no runs in this project yet.', ['Start one with: npx setupscore run']);
    }
    RunStore.checkId(runId);
    const store = new RunStore(root, runId);
    if (!existsSync(join(store.dir, 'run.json'))) {
      const known = RunStore.list(projectDir);
      throw new UsageError(
        `No run with id "${runId}".`,
        known.length ? [`Runs in this project: ${known.slice(-5).join(', ')}`] : ['Start one with: npx setupscore run'],
      );
    }
    return store;
  }

  /** Run ids, oldest first (by the time they were created, which the id starts with). */
  static list(projectDir: string): string[] {
    const dir = join(RunStore.base(projectDir), 'runs');
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names.filter((d) => RUN_ID.test(d) && existsSync(join(dir, d, 'run.json'))).sort();
  }

  readRun(): RunRecord {
    const damaged = (why: string) =>
      new UsageError(`Run ${this.id} cannot be read: ${why}.`, [
        `The file is ${join(this.dir, 'run.json')}. Start a new run with: npx setupscore run`,
      ]);
    let raw: unknown;
    try {
      const body = readTextSafely(join(this.dir, 'run.json'));
      if (body === null) throw new Error('run.json is missing or is not a file');
      if (!body.trim()) throw new Error('run.json is empty');
      raw = JSON.parse(stripBom(body));
    } catch (err) {
      throw damaged((err as Error).message);
    }
    let data: RunRecord;
    try {
      data = readRunRecord(raw);
    } catch (err) {
      if (err instanceof SchemaMismatch) {
        const known = typeof err.found === 'number' || typeof err.found === 'string';
        if (err.found === undefined) throw damaged('it has no format version (it may be incomplete or edited by hand)');
        throw new UsageError(
          `Run ${this.id} was made by a different setupscore version${known ? ` (format ${String(err.found).slice(0, 20)})` : ''}.`,
          ['Start a new run with: npx setupscore run'],
        );
      }
      throw damaged((err as Error).message);
    }
    data.id = this.id;
    // A run left "running" by a setupscore that no longer exists (killed, crashed, machine restarted)
    // is shown as stopped, so it never looks like it is still going.
    if (data.status === 'running' && !this.lockedBy()) {
      data.status = 'stopped';
      data.stopReason ??= 'setupscore was interrupted before it could finish (the process is gone)';
    }
    return data;
  }

  /** Write run.json atomically: a crash mid-write never leaves a half file. */
  saveRun(record: RunRecord): void {
    // Credentials never reach the disk (a setup file or an error message could hold one).
    writeFileAtomic(join(this.dir, 'run.json'), redact(`${JSON.stringify(record, null, 2)}\n`), 0o600);
  }

  update(change: Partial<RunRecord>): RunRecord {
    const next = { ...this.readRun(), ...change };
    this.saveRun(next);
    return next;
  }

  /** Every attempt line in the file, including earlier tries of the same attempt. Damaged lines are skipped with a warning. */
  readAllAttempts(onWarning?: (m: string) => void): Attempt[] {
    const file = join(this.dir, 'attempts.jsonl');
    const out: Attempt[] = [];
    // Line by line: the file can grow beyond what one string can hold.
    const onLine = (line: string | null, n: number) => {
      if (line !== null && !line.trim()) return;
      const a = line === null ? null : parseAttempt(n === 1 ? stripBom(line) : line);
      if (a) out.push(a);
      else onWarning?.(`Skipped a damaged line (${n}) in ${file}.`);
    };
    forEachLine(file, onLine, 128 * 1024 * 1024);
    return out;
  }

  /** Attempts for the tasks and setups of this run; the newest record for a key wins. */
  readAttempts(onWarning?: (m: string) => void): Attempt[] {
    let run: RunRecord | null = null;
    try {
      run = this.readRun();
    } catch {
      run = null;
    }
    // Only attempts this run planned: a known task and setup, a repeat within --repeat, and a key
    // that says the same (hand-edited or foreign lines are left out).
    const planned = run
      ? new Set(
          run.tasks.flatMap((t) =>
            run.setups.flatMap((st) =>
              Array.from({ length: run.options.repeat }, (_, r) => attemptKey(t.id, st.label, r + 1)),
            ),
          ),
        )
      : null;
    const latest = new Map<string, Attempt>();
    for (const a of this.readAllAttempts(onWarning)) {
      if (a.key !== attemptKey(a.taskId, a.setup, a.repeat)) continue;
      if (planned && !planned.has(a.key)) continue;
      // An attempt run again (after an error or a stop) still cost its earlier sessions: the money
      // stays in the totals, carried by the newer record.
      const before = latest.get(a.key)?.metrics?.costUsd ?? 0;
      latest.set(
        a.key,
        before > 0
          ? { ...a, metrics: { ...(a.metrics ?? emptyMetrics()), costUsd: (a.metrics?.costUsd ?? 0) + before } }
          : a,
      );
    }
    return [...latest.values()];
  }

  /** Money spent by this run: every session ever started, including retried and re-run ones. */
  spentUsd(): number {
    return this.readAllAttempts().reduce((t, a) => t + finiteCost(a.metrics?.costUsd), 0);
  }

  appendAttempt(attempt: Attempt): void {
    // Big outputs stay in the transcript; the record keeps what a report shows.
    const a: Attempt = {
      ...attempt,
      reason: capReason(attempt.reason),
      // What the agent wrote is only needed while checking the attempt (it stays in the transcript).
      ...(attempt.metrics
        ? { metrics: { ...attempt.metrics, textWritten: [], result: capReason(attempt.metrics.result) } }
        : {}),
      ...(attempt.checks
        ? {
            checks: {
              ...attempt.checks,
              testOutput: attempt.checks.testOutput === undefined ? undefined : capOutput(attempt.checks.testOutput),
            },
          }
        : {}),
    };
    const file = join(this.dir, 'attempts.jsonl');
    // A crash or a full disk can leave half a line at the end; start on a new line so this
    // record is not glued onto it and lost.
    let prefix = '';
    try {
      const st = statSync(file);
      if (st.size > 0) {
        const fd = openSync(file, 'r');
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, st.size - 1);
        closeSync(fd);
        if (last[0] !== 10) prefix = '\n';
      }
    } catch {
      // no file yet
    }
    // Reasons, test output and commands can quote a key the agent or a test printed.
    appendFileSync(file, `${prefix}${redact(JSON.stringify(a))}\n`, { mode: 0o600 });
  }

  transcriptPath(key: string): string {
    const safe = key.replace(/[^\w.-]+/g, '_');
    const hash = createHash('sha1').update(key).digest('hex').slice(0, 8);
    return join(this.dir, 'transcripts', `${safe}-${hash}.jsonl`);
  }

  /** Save a session transcript with credentials removed. A problem here never fails the run. */
  saveTranscript(key: string, from: string): void {
    try {
      const text = readTextSafely(from);
      if (text === null) return;
      mkdirSync(join(this.dir, 'transcripts'), { recursive: true, mode: 0o700 });
      writeFileAtomic(this.transcriptPath(key), redact(text), 0o600);
    } catch {
      // A missing transcript never fails the run.
    }
  }

  writeFile(name: string, body: string): string {
    const p = join(this.dir, name);
    writeFileAtomic(p, redact(body), 0o600);
    return p;
  }

  /**
   * Make sure only one setupscore process works on this run. A lock left by a process that no
   * longer exists is taken over.
   */
  lock(): void {
    if (this.lockFile) return; // already ours
    const file = join(this.dir, 'lock');
    for (let tries = 0; tries < 2; tries++) {
      try {
        writeFileSync(file, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
        this.lockFile = file;
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const pid = Number(readTextSafely(file, 64)?.trim());
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid)) {
          throw new UsageError(
            `Run ${this.id} is already being worked on by another setupscore process (pid ${pid}).`,
            ['Wait for it to finish, or stop it first.'],
          );
        }
        rmSync(file, { force: true }); // stale
      }
    }
    throw new UsageError(`Could not lock run ${this.id}.`, ['Try again.']);
  }

  unlock(): void {
    if (this.lockFile) rmSync(this.lockFile, { force: true });
    this.lockFile = null;
  }

  /** The process id holding this run's lock, if that process is still alive. */
  lockedBy(): number | null {
    const pid = Number(readTextSafely(join(this.dir, 'lock'), 64)?.trim());
    return Number.isInteger(pid) && pid > 0 && isAlive(pid) ? pid : null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
