import pc from 'picocolors';

/**
 * One place that decides what happens when setupscore is asked to stop (Ctrl+C, SIGTERM from CI,
 * SIGHUP when the terminal closes) and when it exits.
 *
 * - The first signal aborts `shutdown.signal`: commands stop starting new work, running
 *   commands are stopped, results are saved and the run can be resumed.
 * - A second signal quits at once: every process setupscore started is killed and the clean-up
 *   steps run before exiting.
 * - On any exit, processes setupscore started are killed, so nothing keeps running (or keeps
 *   spending money) after setupscore is gone.
 */
export const shutdown = new AbortController();

/** Process groups (POSIX) or process ids (Windows) of commands that are still running. */
const running = new Set<number>();
const cleanups = new Set<() => void>();
let installed = false;
let graceful = false;

/**
 * Commands that can stop cleanly (run, tasks) call this. Other commands quit at the first
 * signal, as any command-line tool would.
 */
export function enableGracefulStop(): void {
  graceful = true;
}
let stderrWrite: (s: string) => void = (s) => process.stderr.write(s);

const EXIT_CODE: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

export function trackProcess(pid: number | undefined): () => void {
  if (!pid) return () => {};
  running.add(pid);
  return () => running.delete(pid);
}

/** Register a synchronous clean-up step (delete a temp folder, mark a run as stopped). */
export function onCleanup(fn: () => void): () => void {
  cleanups.add(fn);
  return () => cleanups.delete(fn);
}

function killAllProcesses(): void {
  for (const pid of running) {
    try {
      if (process.platform === 'win32') process.kill(pid, 'SIGKILL');
      else process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  running.clear();
}

function runCleanups(): void {
  for (const fn of [...cleanups]) {
    try {
      fn();
    } catch {
      // best effort: never fail while exiting
    }
  }
  cleanups.clear();
}

/** Call once at start-up. Safe to call again. */
export function installSignalHandlers(write?: (s: string) => void): void {
  if (installed) return;
  installed = true;
  if (write) stderrWrite = write;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    try {
      process.on(sig, () => {
        if (graceful && !shutdown.signal.aborted) {
          shutdown.abort(sig);
          if (sig === 'SIGINT')
            stderrWrite(pc.yellow('\nStopping after the current step… (press Ctrl+C again to quit now)\n'));
          return;
        }
        killAllProcesses();
        runCleanups();
        process.exit(EXIT_CODE[sig] ?? 1);
      });
    } catch {
      // SIGHUP is not supported everywhere
    }
  }
  process.on('exit', () => {
    killAllProcesses();
    runCleanups();
  });
}

/** Why the shutdown signal fired, for messages. */
export function stopReasonText(): string {
  const r: unknown = shutdown.signal.reason;
  return r === 'SIGTERM'
    ? 'setupscore was asked to stop (SIGTERM)'
    : r === 'SIGHUP'
      ? 'the terminal was closed (SIGHUP)'
      : 'you stopped the run (Ctrl+C)';
}
