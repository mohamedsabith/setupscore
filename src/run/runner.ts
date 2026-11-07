import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTailSafely, readTextSafely } from '../core/fsx.js';
import { onCleanup, stopReasonText } from '../core/lifecycle.js';
import { redact } from '../core/redact.js';
import { agentDomains, agentEnv, classifyAgentFailure, claudeCommand, WEB_TOOLS } from '../agent/claude.js';
import { emptyMetrics, modelMismatch, parseTranscript, type AgentMetrics } from '../agent/transcript.js';
import { commandPaths, gitMetadata, projectFiles, secretPaths } from '../sandbox/env.js';
import { SandboxCommandError } from '../sandbox/os.js';
import { cacheDir } from '../sandbox/runtime.js';
import type { ExecResult, Policy, Sandbox } from '../sandbox/types.js';
import { policiesFor, type Task } from '../tasks/build.js';
import { git } from '../tasks/git.js';
import { cacheEnv, detectPm, noTestsRan, registryDomains, type Pm, type PmOverrides } from '../tasks/pm.js';
import { restoreTestSetup } from '../tasks/testsetup.js';
import { Workspace } from '../tasks/workspace.js';
import { addedSourceLines, changedFiles, findViolations, forbiddenRules, lookedOutside, ranTests } from './checks.js';
import { applySetup, isSetupPath } from './setups.js';
import {
  attemptKey,
  type Attempt,
  type CheckResults,
  type RunRecord,
  type RunStore,
  type SetupRecord,
} from './store.js';

/** Used to budget until real costs come in. An assumption, replaced by the measured average. */
export const ASSUMED_ATTEMPT_COST_USD = 0.4;
/** The smallest spending limit a session gets (--attempt-budget below it is raised to it). */
export const MIN_ATTEMPT_USD = 0.05;
const MAX_RETRIES = 2;
/**
 * Claude Code already retries an unreachable or overloaded API for minutes before it gives up.
 * After this many sessions in a row end that way (across the whole run), the run stops instead of
 * spending more time: the API, the network or the gateway is down, not the setup.
 */
const MAX_API_FAILURES_IN_A_ROW = 3;
/** Transcripts larger than this are read only at the start and the end. */
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

export interface PlannedAttempt {
  key: string;
  task: Task;
  setup: SetupRecord;
  repeat: number;
}

export type RunEvent =
  | { type: 'plan'; total: number; todo: number; done: number; estimateUsd: number }
  | { type: 'start'; planned: PlannedAttempt; index: number; total: number }
  | { type: 'install'; command: string }
  | { type: 'retry'; planned: PlannedAttempt; reason: string; waitMs: number }
  | { type: 'done'; attempt: Attempt; index: number; total: number; spentUsd: number }
  | { type: 'warning'; message: string };

export interface RunnerOptions {
  dir: string;
  store: RunStore;
  run: RunRecord;
  sandbox: Sandbox;
  claudeBin: string;
  /** Ctrl+C. */
  signal: AbortSignal;
  overrides?: PmOverrides;
  domains?: string[];
  testTimeoutMs?: number;
  installTimeoutMs?: number;
  onEvent?: (e: RunEvent) => void;
}

export interface RunOutcome {
  status: 'completed' | 'stopped' | 'failed';
  reason?: string;
  fix?: string;
  spentUsd: number;
  attempts: Attempt[];
}

/** Stops the whole run (bad key, no credit, Claude Code missing): retrying cannot help. */
class FatalRunError extends Error {
  constructor(
    message: string,
    readonly fix: string,
    /** The attempt it happened in, recorded (not scored) so its cost is counted. */
    readonly attempt?: Attempt,
  ) {
    super(message);
  }
}

/**
 * Every attempt, task by task: all setups and repeats of one task together. Stopping early still
 * leaves a fair comparison between setups (each started task has every setup), and a worker keeps
 * the same commit's dependencies installed instead of reinstalling for every attempt.
 */
export function planAttempts(run: RunRecord): PlannedAttempt[] {
  const out: PlannedAttempt[] = [];
  for (const task of run.tasks) {
    for (let r = 1; r <= run.options.repeat; r++) {
      for (const setup of run.setups) out.push({ key: attemptKey(task.id, setup.label, r), task, setup, repeat: r });
    }
  }
  return out;
}

/** Attempts that already have a final answer are skipped on --resume; errors and cancelled ones run again. */
export const isFinal = (a: Attempt) => a.status === 'passed' || a.status === 'failed';

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

const tail = (text: string, lines = 40) =>
  text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .filter((l) => l.trim())
    .slice(-lines)
    .join('\n');

interface Worker {
  ws?: Workspace;
  installedHash: string | null;
  n: number;
}

export async function executeRun(o: RunnerOptions): Promise<RunOutcome> {
  const previous = o.store.readAttempts((m) => o.onEvent?.({ type: 'warning', message: m }));
  const finished = new Map(previous.filter(isFinal).map((a) => [a.key, a]));
  const all = planAttempts(o.run);
  const todo = all.filter((p) => !finished.has(p.key));

  // Every session ever paid for counts, including earlier tries of attempts that are run again.
  const costs = o.store.readAllAttempts().map((a) => a.metrics?.costUsd ?? 0);
  let spent = costs.reduce((s, c) => s + c, 0);
  const average = () => {
    const real = costs.filter((c) => c > 0);
    return real.length ? real.reduce((s, c) => s + c, 0) / real.length : ASSUMED_ATTEMPT_COST_USD;
  };
  o.onEvent?.({
    type: 'plan',
    total: all.length,
    todo: todo.length,
    done: finished.size,
    estimateUsd: todo.length * average(),
  });

  const userTop = (await git(o.dir, ['rev-parse', '--show-toplevel'])).trim();
  const pmCache = join(cacheDir(), 'pm-cache');
  mkdirSync(pmCache, { recursive: true });

  // A fatal problem in one worker stops the others too, and so does the user (Ctrl+C).
  const stop = new AbortController();
  const onUserAbort = () => stop.abort();
  if (o.signal.aborted) stop.abort();
  o.signal.addEventListener('abort', onUserAbort, { once: true });
  let stopReason: { status: RunOutcome['status']; reason: string; fix?: string } | null = null;
  // The budget only stops new attempts from starting: attempts already running are paid for, so
  // they finish and count.
  let budgetReached = false;
  // Sessions in a row (across workers) that ended because the API could not be used.
  const apiTrouble = { inARow: 0, last: '' };
  // The model Claude Code says it used, checked against --model once.
  const modelCheck = { warned: new Set<string>(), stored: o.run.modelUsed };

  let next = 0;
  let index = finished.size;
  let reserved = 0;
  const results: Attempt[] = [...previous];

  const workers: Worker[] = Array.from(
    { length: Math.max(1, Math.min(o.run.options.concurrency, todo.length || 1)) },
    (_, n) => ({ installedHash: null, n }),
  );
  // If setupscore is made to quit at once (a second Ctrl+C), the workspaces are still deleted.
  const releaseWorkspaces = onCleanup(() => {
    for (const w of workers) w.ws?.close();
  });

  const record = (attempt: Attempt) => {
    const cost = attempt.metrics?.costUsd ?? 0;
    spent += cost;
    costs.push(cost);
    o.store.appendAttempt(attempt);
    results.push(attempt);
    index++;
    o.onEvent?.({ type: 'done', attempt, index, total: all.length, spentUsd: spent });
    checkModel(o, attempt, modelCheck);
  };

  const runWorker = async (w: Worker) => {
    while (!stop.signal.aborted && !budgetReached) {
      const planned = todo[next];
      if (!planned) return;
      // Budget: start only if there is money left after the attempts still running. Each session
      // is capped (--max-budget-usd) at what is left, so the run cannot run far past the budget.
      const left = o.run.options.budgetUsd - spent - reserved;
      // Once real costs are known, an attempt starts only if a typical one fits: a session cut
      // short by the run's budget proves nothing. Before that, the first ones measure the cost.
      const measured = costs.some((c) => c > 0);
      if (left < MIN_ATTEMPT_USD || (measured && left < Math.min(average(), o.run.options.attemptBudgetUsd) - 1e-9)) {
        budgetReached = true;
        return;
      }
      const estimate = Math.min(average(), left);
      next++;
      reserved += estimate;
      const attemptBudget = Math.max(MIN_ATTEMPT_USD, Math.min(o.run.options.attemptBudgetUsd, left));
      o.onEvent?.({ type: 'start', planned, index: index + 1, total: all.length });
      let attempt: Attempt;
      try {
        attempt = await runWithRetries(o, w, planned, attemptBudget, {
          userTop,
          pmCache,
          signal: stop.signal,
          apiTrouble,
        });
      } catch (err) {
        if (err instanceof FatalRunError) {
          reserved -= estimate;
          stopReason ??= { status: 'failed', reason: err.message, fix: err.fix };
          stop.abort();
          if (err.attempt) record(err.attempt);
          return;
        }
        // A full disk fails every attempt the same way: stop, and say so.
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ENOSPC' || code === 'EDQUOT') {
          reserved -= estimate;
          stopReason ??= {
            status: 'failed',
            reason: `the disk is full (${((err as Error).message ?? '').split('\n')[0]!.slice(0, 160)})`,
            fix: 'Free some space, then continue where it stopped.',
          };
          stop.abort();
          w.ws?.close();
          w.ws = undefined;
          return;
        }
        // Anything else is setupscore's problem, not the setup's: record it, start this worker on a
        // fresh workspace, and carry on with the other attempts.
        attempt = unexpectedError(planned, err);
        w.ws?.close();
        w.ws = undefined;
        w.installedHash = null;
      }
      reserved -= estimate;
      record(attempt);
      if (attempt.status === 'cancelled') return;
    }
  };

  let storeError: unknown = null;
  try {
    // Wait for every worker, also when one fails: none may keep a session running on its own.
    const settled = await Promise.allSettled(
      workers.map((w) =>
        runWorker(w).catch((err) => {
          stop.abort(); // for example results can no longer be saved: stop the others too
          throw err;
        }),
      ),
    );
    storeError = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason ?? null;
  } finally {
    o.signal.removeEventListener('abort', onUserAbort);
    for (const w of workers) w.ws?.close();
    releaseWorkspaces();
  }
  if (storeError) throw storeError;

  if (!stopReason && o.signal.aborted) {
    stopReason = {
      status: 'stopped',
      reason: stopReasonText(),
      fix: `Continue where it stopped: npx setupscore run --resume ${o.run.id}`,
    };
  }
  const leftToDo = todo.length - next;
  if (!stopReason && budgetReached && leftToDo > 0) {
    // Enough for what is left at the average cost so far, plus a margin, on top of what was spent.
    const needed = Math.ceil(spent + Math.max(leftToDo * average(), MIN_ATTEMPT_USD) * 1.2 + 1);
    stopReason = {
      status: 'stopped',
      reason: `the budget of $${o.run.options.budgetUsd.toFixed(2)} is used up ($${spent.toFixed(2)} spent, ${leftToDo} attempt${leftToDo === 1 ? '' : 's'} not started)`,
      fix: `Continue where it stopped with a bigger budget: npx setupscore run --resume ${o.run.id} --budget ${Math.max(needed, Math.ceil(o.run.options.budgetUsd) + 1)}`,
    };
  }
  const latest = new Map<string, Attempt>();
  for (const a of results) latest.set(a.key, a);
  const final = stopReason;
  return {
    status: final?.status ?? 'completed',
    reason: final?.reason,
    fix: final?.fix,
    spentUsd: spent,
    attempts: [...latest.values()],
  };
}

/** Remember the model Claude Code really used, and say so once when it is not the one asked for. */
function checkModel(o: RunnerOptions, a: Attempt, state: { warned: Set<string>; stored?: string }): void {
  const m = a.metrics;
  if (!m) return;
  const used = (m.model && m.model !== '<synthetic>' ? m.model : m.modelsUsed?.[0])?.trim();
  if (!used || used.length > 200) return;
  if (used !== state.stored) {
    state.stored = used;
    try {
      o.store.update({ modelUsed: used });
    } catch {
      // only a note in run.json
    }
  }
  const other = modelMismatch(o.run.options.model, m);
  if (other && state.warned.size === 0) {
    state.warned.add(other);
    o.onEvent?.({
      type: 'warning',
      message: `Asked for --model ${o.run.options.model}, but Claude Code used ${other}. The results are for ${other}.`,
    });
  }
}

interface Shared {
  userTop: string;
  pmCache: string;
  signal: AbortSignal;
  apiTrouble: { inARow: number; last: string };
}

function unexpectedError(p: PlannedAttempt, err: unknown): Attempt {
  const now = new Date().toISOString();
  const message = (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 200);
  return {
    key: p.key,
    taskId: p.task.id,
    setup: p.setup.label,
    repeat: p.repeat,
    status: 'error',
    failureKind: 'infra',
    reason: err instanceof SandboxCommandError ? message : `setupscore hit an unexpected problem: ${message}`,
    startedAt: now,
    finishedAt: now,
    ms: 0,
    retries: 0,
  };
}

async function runWithRetries(
  o: RunnerOptions,
  w: Worker,
  p: PlannedAttempt,
  attemptBudget: number,
  s: Shared,
): Promise<Attempt> {
  const startedAt = new Date();
  let last: Attempt | null = null;
  let earlierCost = 0; // sessions that were retried were still paid for
  const withEarlierCost = (a: Attempt): Attempt =>
    earlierCost > 0
      ? { ...a, metrics: { ...(a.metrics ?? emptyMetrics()), costUsd: (a.metrics?.costUsd ?? 0) + earlierCost } }
      : a;
  const envBase = Number(process.env.SETUPSCORE_RETRY_BASE_MS);
  const base =
    Number.isFinite(envBase) && envBase >= 0 && process.env.SETUPSCORE_RETRY_BASE_MS !== '' ? envBase : 5_000; // shorter in tests
  for (let tryNo = 0; tryNo <= MAX_RETRIES; tryNo++) {
    let r: { attempt: Attempt; retry?: string };
    try {
      r = await runAttemptOnce(o, w, p, attemptBudget, s, startedAt, tryNo);
    } catch (err) {
      // A fatal stop still records this attempt, with every session it paid for.
      if (err instanceof FatalRunError && err.attempt)
        throw new FatalRunError(err.message, err.fix, withEarlierCost(err.attempt));
      throw err;
    }
    if (r.retry && tryNo < MAX_RETRIES && !s.signal.aborted) {
      const waitMs = Math.min(60_000, base * 3 ** tryNo);
      o.onEvent?.({ type: 'retry', planned: p, reason: r.retry, waitMs });
      earlierCost += r.attempt.metrics?.costUsd ?? 0;
      await sleep(waitMs, s.signal);
      last = r.attempt;
      continue;
    }
    return withEarlierCost(r.attempt);
  }
  return last!; // not reached: the last try always returns above
}

const INSTALL_HINT: Record<string, string> = {
  pnpm: 'Install pnpm (npm install -g pnpm, or: corepack enable), then resume the run.',
  yarn: 'Install Yarn (npm install -g yarn, or: corepack enable), then resume the run.',
  bun: 'Install Bun (npm install -g bun, or see https://bun.sh), then resume the run.',
};

/**
 * The install command's program is not on this machine: every attempt would fail the same way,
 * so the run stops instead of retrying each one.
 */
export function missingTool(
  install: string | null,
  env: NodeJS.ProcessEnv = process.env,
): { message: string; fix: string } | null {
  const bin = install?.trim().split(/\s+/)[0];
  if (!bin || !/^[\w.-]+$/.test(bin)) return null; // VAR=value prefixes, paths: leave to the shell
  if (commandPaths(bin, env).length) return null;
  return {
    message: `This project installs its dependencies with ${bin} ("${install}"), and ${bin} is not installed on this machine`,
    fix: INSTALL_HINT[bin] ?? `Install ${bin} (or set tasks.install in setupscore.yml), then resume the run.`,
  };
}

/**
 * The task as the agent sees it. Every setup gets the same words, so the prompt never points at
 * setup files (older task files said "following the project instructions (CLAUDE.md)", which
 * would tilt a run with no instructions).
 */
export function agentPrompt(prompt: string): string {
  // Same result as prompt.replace(/,?\s*following the project instructions \(CLAUDE\.md\)/g, ''),
  // in linear time: remove each phrase with the spaces and the one comma right before it.
  const phrase = 'following the project instructions (CLAUDE.md)';
  let out = '';
  let from = 0;
  for (let at = prompt.indexOf(phrase); at !== -1; at = prompt.indexOf(phrase, at + phrase.length)) {
    let start = at;
    while (start > from && /\s/.test(prompt[start - 1]!)) start--;
    if (start > from && prompt[start - 1] === ',') start--;
    out += prompt.slice(from, start);
    from = at + phrase.length;
  }
  return out + prompt.slice(from);
}

/** Install dependencies when they changed; reuse parked installs. Returns an error reason or null. */
async function ensureDeps(
  o: RunnerOptions,
  w: Worker,
  ws: Workspace,
  pm: Pm,
  policy: Policy,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<string | null> {
  if (!pm.install) return null;
  // A package in a workspace is installed from the workspace root, into the root's node_modules.
  const inWorkspace = pm.installRoot !== '.';
  const installed = inWorkspace ? existsSync(join(ws.dir, pm.installRoot, 'node_modules')) : ws.hasDependencies();
  if (pm.depsHash === w.installedHash && installed) return null;
  // Parked installs are only the project's own node_modules: never reused in a workspace.
  if (w.installedHash && !inWorkspace) ws.parkDependencies(w.installedHash);
  w.installedHash = null;
  if (!inWorkspace && ws.restoreDependencies(pm.depsHash)) {
    w.installedHash = pm.depsHash;
    return null;
  }
  // A fresh install: packages left from another commit could hide a missing dependency.
  for (const d of new Set([join(ws.dir, 'node_modules'), join(ws.dir, pm.installRoot, 'node_modules')]))
    rmSync(d, { recursive: true, force: true });
  o.onEvent?.({ type: 'install', command: pm.install });
  const r = await o.sandbox.exec(pm.install, {
    cwd: ws.dir,
    timeoutMs: o.installTimeoutMs ?? 10 * 60_000,
    policy,
    env,
    signal,
  });
  if (r.code !== 0)
    return `"${pm.install}" failed${r.timedOut ? ' (took too long)' : ''}: ${tail(r.stderr || r.stdout, 2)}`;
  w.installedHash = pm.depsHash;
  return null;
}

/** True when a setup file in the workspace differs from what setupscore placed there. */
function setupFileChanged(dir: string, rel: string, placed: Record<string, string>): boolean {
  if (!(rel in placed)) return existsSync(join(dir, rel)); // the commit's own copy, removed by setupscore: only a new one counts
  try {
    return readFileSync(join(dir, rel), 'utf8') !== placed[rel];
  } catch {
    return true;
  }
}

async function runAttemptOnce(
  o: RunnerOptions,
  w: Worker,
  p: PlannedAttempt,
  attemptBudget: number,
  s: Shared,
  startedAt: Date,
  retries: number,
): Promise<{ attempt: Attempt; retry?: string }> {
  const base = {
    key: p.key,
    taskId: p.task.id,
    setup: p.setup.label,
    repeat: p.repeat,
    startedAt: startedAt.toISOString(),
    retries,
  };
  const finish = (rest: Omit<Attempt, keyof typeof base | 'finishedAt' | 'ms'>): Attempt => ({
    ...base,
    ...rest,
    finishedAt: new Date().toISOString(),
    ms: Date.now() - startedAt.getTime(),
  });
  const infra = (reason: string, metrics?: AgentMetrics) => ({
    attempt: finish({ status: 'error', failureKind: 'infra', reason, metrics }),
    retry: reason,
  });

  try {
    w.ws ??= await Workspace.create(o.dir);
  } catch (err) {
    return infra(`could not prepare a workspace: ${(err as Error).message}`);
  }
  const ws = w.ws;
  const { writable, testPolicy, env: baseEnv } = policiesFor(ws, s.userTop, s.pmCache);

  // 1. The commit before the task, with the setup under test.
  try {
    await ws.checkout(p.task.parent);
    applySetup(ws.dir, p.setup);
  } catch (err) {
    // The workspace may be damaged (for example files made immutable): start the retry on a new one.
    ws.close();
    w.ws = undefined;
    w.installedHash = null;
    return infra(`could not check out ${p.task.parent.slice(0, 7)}: ${(err as Error).message}`);
  }
  const pm = detectPm(ws.dir, o.overrides);
  if ('error' in pm) return { attempt: finish({ status: 'error', failureKind: 'infra', reason: pm.error }) };
  const missing = missingTool(pm.install);
  if (missing) throw new FatalRunError(missing.message, missing.fix);

  // The user's real project is at a later commit, so it holds the answer: its files and git metadata
  // (branches, HEAD, reflog) are hidden in every phase. Only its git objects stay readable, because
  // the workspace clone reads them from there.
  const keepVisible = [ws.outer, s.pmCache, cacheDir(), process.execPath, ...commandPaths(o.claudeBin)];
  const realProject = [...projectFiles(s.userTop, keepVisible), ...gitMetadata(s.userTop)];
  const registries = [...registryDomains(ws.dir), ...(o.domains ?? [])];
  const installPolicy: Policy = {
    writable: [...writable, s.pmCache],
    readOnly: [ws.gitDir],
    hidden: [...secretPaths(s.userTop, { allowNpmrc: true }), ...realProject],
    domains: registries,
  };
  const hiddenTestPolicy: Policy = { ...testPolicy, hidden: [...testPolicy.hidden, ...realProject] };
  const depsError = await ensureDeps(o, w, ws, pm, installPolicy, baseEnv, s.signal);
  if (s.signal.aborted) return { attempt: finish({ status: 'cancelled', reason: 'stopped before the agent started' }) };
  if (depsError) return infra(depsError);
  // The agent works on a copy of node_modules; the original comes back before the hidden tests.
  try {
    ws.lendDependencies([join(ws.dir, pm.installRoot, 'node_modules')]);
  } catch (err) {
    return infra(`could not copy node_modules for the agent: ${(err as Error).message}`);
  }

  // 2. The agent, in the sandbox, with a fresh Claude Code config folder.
  const runDir = join(ws.base, 'attempt');
  rmSync(runDir, { recursive: true, force: true });
  const configDir = join(runDir, 'claude-config');
  mkdirSync(configDir, { recursive: true });
  // setupscore's own files (prompt, transcript, stderr) are outside the writable part of the
  // workspace, and Claude Code's output is written to them from outside the sandbox: the agent
  // cannot rewrite or erase the record of what it did.
  const hostDir = join(ws.hostDir, 'attempt');
  rmSync(hostDir, { recursive: true, force: true });
  mkdirSync(hostDir, { recursive: true });
  const promptFile = join(hostDir, 'prompt.txt');
  const transcriptFile = join(hostDir, 'transcript.jsonl');
  const stderrFile = join(hostDir, 'stderr.txt');
  writeFileSync(promptFile, agentPrompt(p.task.prompt));
  // The agent gets its own package cache, so it cannot poison the shared one that later installs use,
  // and no ~/.npmrc (registry tokens).
  const agentCache = join(runDir, 'pm-cache');
  mkdirSync(agentCache, { recursive: true });
  const agentPolicy: Policy = {
    writable,
    readOnly: [ws.gitDir],
    hidden: [...secretPaths(s.userTop), ...realProject],
    domains: [...agentDomains(), ...registries],
  };
  const command = claudeCommand({
    bin: o.claudeBin,
    promptFile,
    maxTurns: o.run.options.maxTurns,
    maxBudgetUsd: attemptBudget,
    model: o.run.options.model,
  });
  const run: ExecResult = await o.sandbox.exec(command, {
    cwd: ws.dir,
    timeoutMs: o.run.options.agentTimeoutMin * 60_000,
    policy: agentPolicy,
    env: { ...baseEnv, ...cacheEnv(agentCache), ...agentEnv(configDir) },
    signal: s.signal,
    stdoutFile: transcriptFile,
    stderrFile,
  });
  // Read with care: the agent could have replaced these files with a folder, a link or something huge.
  const transcript = readTextSafely(transcriptFile, MAX_TRANSCRIPT_BYTES) ?? '';
  const stderr = (readTailSafely(stderrFile, 1024 * 1024) ?? run.stderr).trim();
  const metrics = transcript ? parseTranscript(transcript) : emptyMetrics();
  // A cost no session can have (1e308, a typo in a gateway) would wreck the budget and the
  // reports: count the session as having spent its whole limit instead.
  if (!(metrics.costUsd >= 0 && metrics.costUsd < 10_000)) metrics.costUsd = attemptBudget;
  o.store.saveTranscript(p.key, transcriptFile);
  ws.returnDependencies();

  if (s.signal.aborted)
    return { attempt: finish({ status: 'cancelled', reason: 'stopped while the agent was working', metrics }) };

  const verdict = classifyAgentFailure(metrics, stderr, run.code, run.timedOut, { endedAt: Date.now() });
  if (verdict.kind === 'fatal') {
    throw new FatalRunError(
      redact(verdict.message),
      verdict.fix,
      finish({ status: 'error', failureKind: 'infra', reason: redact(verdict.message), metrics }),
    );
  }
  if (verdict.kind === 'retry') {
    s.apiTrouble.inARow++;
    s.apiTrouble.last = verdict.message;
    if (s.apiTrouble.inARow >= MAX_API_FAILURES_IN_A_ROW) {
      const message = `the Claude API could not be used: ${s.apiTrouble.inARow} Claude Code sessions in a row ended with "${redact(verdict.message).slice(0, 160)}"`;
      throw new FatalRunError(
        message,
        'Check your internet connection, the API status (status.anthropic.com) or your gateway (ANTHROPIC_BASE_URL).',
        finish({ status: 'error', failureKind: 'infra', reason: redact(verdict.message), metrics }),
      );
    }
    return infra(verdict.message, metrics);
  }
  s.apiTrouble.inARow = 0;

  // 3. Checks: what changed, which instructions were broken, then the hidden tests with no network.
  // Setup files were placed by setupscore; only count them when the agent changed them afterwards.
  const files = (await changedFiles(ws.dir, p.task.parent)).filter(
    (f) => !isSetupPath(f) || setupFileChanged(ws.dir, f, p.setup.files),
  );
  const removedSetup = Object.keys(p.setup.files).filter((f) => !existsSync(join(ws.dir, f)));
  const added = await addedSourceLines(ws.dir, p.task.parent, files);
  const checks: CheckResults = {
    testsPassed: null,
    ruleViolations: findViolations(forbiddenRules(p.setup.files), added),
    filesChanged: [...files, ...removedSetup],
    ranTests: ranTests(metrics),
    touchedSetup: files.some(isSetupPath) || removedSetup.length > 0,
  };
  const peeked = lookedOutside(
    [...metrics.bashCommands, ...metrics.pathsRead, ...metrics.filesEdited, ...metrics.textWritten],
    s.userTop,
  );
  // The web (searched or fetched on Anthropic's side, outside the sandbox) could hold the real commit.
  const web = WEB_TOOLS.filter((t) => (metrics.toolCalls[t] ?? 0) > 0).map((t) => `used ${t}`);
  if (web.length || peeked.length) checks.lookedOutside = [...web, ...peeked].slice(0, 5);

  // The hidden tests run the commit's way: its test files and test helpers, its test settings
  // (package.json scripts and runner config, .npmrc, runner config files) and untouched dependencies.
  try {
    await restoreTestSetup(ws, p.task.hash, p.task.testFiles);
  } catch (err) {
    const reason = `the agent's change left the project in a state where the hidden tests cannot be put back (${(err as Error).message})`;
    return {
      attempt: finish({
        status: 'failed',
        failureKind: 'task',
        reason,
        metrics,
        checks: { ...checks, testsPassed: false },
      }),
    };
  }

  // The agent changed the dependencies: judge the change as CI would, with a fresh install.
  const pmAfter = detectPm(ws.dir, o.overrides);
  if ('error' in pmAfter) {
    return {
      attempt: finish({
        status: 'failed',
        failureKind: 'task',
        reason: `the agent's change broke package.json: ${pmAfter.error}`,
        metrics,
        checks: { ...checks, testsPassed: false },
      }),
    };
  }
  const depsChanged = pmAfter.depsHash !== pm.depsHash;
  const dependencyFolders = [
    ...new Set([
      join(ws.dir, 'node_modules'),
      join(ws.dir, pm.installRoot, 'node_modules'),
      join(ws.dir, pmAfter.installRoot, 'node_modules'),
    ]),
  ];
  if (depsChanged) {
    if (w.installedHash && pm.installRoot === '.') ws.parkDependencies(w.installedHash);
    for (const d of dependencyFolders) rmSync(d, { recursive: true, force: true });
    w.installedHash = null;
  }
  if (depsChanged && pmAfter.install) {
    o.onEvent?.({ type: 'install', command: pmAfter.install });
    const r = await o.sandbox.exec(pmAfter.install, {
      cwd: ws.dir,
      timeoutMs: o.installTimeoutMs ?? 10 * 60_000,
      policy: installPolicy,
      env: baseEnv,
      signal: s.signal,
    });
    if (s.signal.aborted)
      return { attempt: finish({ status: 'cancelled', reason: 'stopped during the checks', metrics }) };
    if (r.code !== 0) {
      for (const d of dependencyFolders) rmSync(d, { recursive: true, force: true });
      const reason = `the agent changed the dependencies, and "${pmAfter.install}" then failed: ${tail(r.stderr || r.stdout, 1)}`;
      return {
        attempt: finish({
          status: 'failed',
          failureKind: 'task',
          reason,
          metrics,
          checks: { ...checks, testsPassed: false },
        }),
      };
    }
  }

  const testCommand = p.task.testCommand ?? pm.test(p.task.testFiles);
  const tests = await o.sandbox.exec(testCommand, {
    cwd: ws.dir,
    timeoutMs: o.testTimeoutMs ?? 5 * 60_000,
    policy: hiddenTestPolicy,
    env: baseEnv,
    signal: s.signal,
  });
  if (s.signal.aborted)
    return { attempt: finish({ status: 'cancelled', reason: 'stopped during the checks', metrics }) };
  // Zero tests says nothing about the change (a test file the runner no longer finds, for example).
  const noTests = tests.code === 0 && !tests.timedOut && noTestsRan(`${tests.stdout}\n${tests.stderr}`);
  checks.testsPassed = tests.code === 0 && !tests.timedOut && !noTests;
  if (!checks.testsPassed) checks.testOutput = tail(`${tests.stdout}\n${tests.stderr}`);

  // Never let the agent's dependencies leak into the next attempt.
  if (depsChanged) {
    for (const d of dependencyFolders) rmSync(d, { recursive: true, force: true });
    w.installedHash = null;
  }

  if (checks.lookedOutside) {
    const reason = `looked for the answer outside the task (${checks.lookedOutside[0]!}), so it does not count as solved`;
    return { attempt: finish({ status: 'failed', failureKind: 'task', reason, metrics, checks }) };
  }
  // The session hit a spending limit lower than --attempt-budget because the run's budget was
  // nearly used up: that says nothing about the setup, so it is not scored (--resume runs it again).
  if (!checks.testsPassed && metrics.outcome === 'budget' && attemptBudget < o.run.options.attemptBudgetUsd - 0.005) {
    const reason = `the run's budget ran out during this attempt (the session was limited to $${attemptBudget.toFixed(2)}), so it is not counted`;
    return { attempt: finish({ status: 'error', failureKind: 'infra', reason, metrics, checks }) };
  }
  if (checks.testsPassed) {
    return {
      attempt: finish({
        status: 'passed',
        metrics,
        checks,
        reason: verdict.kind === 'task' ? `${verdict.message}, but the hidden tests pass` : undefined,
      }),
    };
  }
  const reason = noTests
    ? 'no tests ran (the hidden tests were not found or ran zero tests)'
    : verdict.kind === 'task'
      ? verdict.message
      : tests.timedOut
        ? 'the hidden tests took too long'
        : "the hidden tests fail after the agent's change";
  return { attempt: finish({ status: 'failed', failureKind: 'task', reason, metrics, checks }) };
}
