import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pc from 'picocolors';
import type { Config } from '../core/config.js';
import { StoppedEarly } from '../core/errors.js';
import { writeFileAtomic } from '../core/fsx.js';
import { enableGracefulStop, shutdown } from '../core/lifecycle.js';
import { displayPath } from '../core/paths.js';
import { openSandbox, type SandboxMode } from '../sandbox/index.js';
import { buildTasks, type BuildResult, type Progress } from '../tasks/build.js';
import { tryGit } from '../tasks/git.js';
import { VERSION } from '../version.js';

export const TASKS_SCHEMA_VERSION = 1;

export interface TasksFlags {
  limit: number;
  since?: string;
  sandbox: SandboxMode;
  timeout: number;
  yes?: boolean;
  json?: boolean;
}

export interface TasksOutcome {
  result: BuildResult;
  file: string;
  sandbox: string;
}

const short = (h: string) => h.slice(0, 7);

function progressPrinter(log: (m: string) => void): (p: Progress) => void {
  return (p) => {
    switch (p.type) {
      case 'scan':
        log(pc.dim(`Looked at ${p.scanned} commits: ${p.candidates} changed both tests and code.`));
        break;
      case 'install':
        log(pc.dim(`  installing dependencies in the sandbox: ${p.title}`));
        break;
      case 'check':
        log(pc.dim(`[${p.index}/${p.total}] ${short(p.candidate.hash)} ${p.candidate.title}`));
        break;
      case 'valid':
        log(
          `  ${pc.green('✔ task')}  tests fail before, pass after${p.task.newTests.length ? ` · ${p.task.newTests.length} new test${p.task.newTests.length === 1 ? '' : 's'}` : ''}`,
        );
        break;
      case 'rejected':
        log(`  ${pc.yellow('✖ skipped')}  ${pc.dim(p.rejected.reason)}`);
        break;
      case 'note':
        log(pc.cyan(`  note: ${p.message}`));
        break;
    }
  };
}

/** How many tasks an existing tasks.json holds (0 when missing or unreadable). */
function existingTaskCount(file: string): number {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { tasks?: unknown };
    return Array.isArray(data.tasks) ? data.tasks.length : 0;
  } catch {
    return 0;
  }
}

/** Why setupscore was asked to stop, for messages. */
function stopReason(): string {
  const r: unknown = shutdown.signal.reason;
  return r === 'SIGTERM'
    ? 'setupscore was asked to stop (SIGTERM)'
    : r === 'SIGHUP'
      ? 'the terminal was closed (SIGHUP)'
      : 'you pressed Ctrl+C';
}

function stopped(): StoppedEarly {
  return new StoppedEarly(
    `Stopped before all commits were checked: ${stopReason()}. Nothing was saved, and .setupscore/tasks.json was not changed.`,
    ['Build the tasks again when you are ready: npx setupscore tasks'],
  );
}

export async function runTasks(
  dir: string,
  flags: TasksFlags,
  config: Config,
  log: (m: string) => void,
): Promise<TasksOutcome> {
  // Ctrl+C, SIGTERM and SIGHUP stop the sandboxed commands and end with exit code 4.
  enableGracefulStop();
  const sandbox = await openSandbox({ mode: flags.sandbox, cwd: dir, yes: flags.yes, log, signal: shutdown.signal });
  try {
    if (shutdown.signal.aborted) throw stopped();
    log(
      `${pc.bold('setupscore tasks')} ${pc.dim(`· sandbox: ${sandbox.label}${sandbox.kind === 'none' ? pc.yellow(' (no isolation)') : ''}`)}`,
    );
    const result = await buildTasks({
      dir,
      sandbox,
      limit: flags.limit,
      since: flags.since,
      timeoutMs: flags.timeout * 1000,
      installTimeoutMs: 10 * 60_000,
      domains: config.sandbox?.domains,
      overrides: config.tasks,
      onProgress: flags.json ? undefined : progressPrinter(log),
      signal: shutdown.signal,
    });
    // Results checked while stopping are incomplete (commands were killed): keep nothing.
    if (shutdown.signal.aborted) throw stopped();
    const out = join(dir, '.setupscore');
    mkdirSync(out, { recursive: true, mode: 0o700 });
    const file = join(out, 'tasks.json');
    // Never replace tasks that work with an empty list (for example after a too-narrow --since).
    if (result.tasks.length === 0) {
      const kept = existingTaskCount(file);
      if (kept > 0) {
        log(
          pc.yellow(
            `No new tasks were found, so the existing ${kept} task${kept === 1 ? '' : 's'} in .setupscore/tasks.json ${kept === 1 ? 'was' : 'were'} kept.`,
          ),
        );
        return { result, file: displayPath(file), sandbox: sandbox.label };
      }
    }
    const head = (await tryGit(dir, ['rev-parse', 'HEAD']))?.trim() ?? null;
    // Written to a temp file and renamed: a full disk or Ctrl+C never leaves half a file.
    writeFileAtomic(
      file,
      `${JSON.stringify(
        {
          schemaVersion: TASKS_SCHEMA_VERSION,
          tool: { name: 'setupscore', version: VERSION },
          createdAt: new Date().toISOString(),
          head,
          sandbox: sandbox.kind,
          tasks: result.tasks,
          rejected: result.rejected,
        },
        null,
        2,
      )}\n`,
    );
    return { result, file: displayPath(file), sandbox: sandbox.label };
  } finally {
    await sandbox.close();
  }
}

export function renderTasksSummary(o: TasksOutcome): string {
  const { tasks, rejected, candidates } = o.result;
  const out = [''];
  if (candidates === 0) {
    out.push(pc.yellow('No commits changed both tests and source code, so there is nothing to turn into a task.'));
    out.push(pc.dim('  Try a longer history with --since, or check that test files are named *.test.* or *.spec.*.'));
    return out.join('\n');
  }
  if (tasks.length) {
    out.push(
      pc.green(`✔ ${tasks.length} task${tasks.length === 1 ? '' : 's'} ready`) +
        pc.dim(` (${rejected.length} skipped) · saved to ${o.file}`),
    );
    for (const t of tasks)
      out.push(
        `  ${pc.bold(t.id)}  ${t.title}${t.newTests.length ? pc.dim(`  (${t.newTests.length} new test${t.newTests.length === 1 ? '' : 's'})`) : ''}`,
      );
    out.push('');
    out.push(
      pc.dim(
        '  Add .setupscore/ to .gitignore. Next: setupscore run gives each task to Claude Code and scores your setup.',
      ),
    );
  } else {
    out.push(
      pc.yellow(`No usable tasks: all ${rejected.length} candidates were skipped.`) + pc.dim(` Details in ${o.file}.`),
    );
  }
  return out.join('\n');
}
