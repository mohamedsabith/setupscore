import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readdirSync, readFileSync, writeSync } from 'node:fs';
import { onCleanup, trackProcess } from '../core/lifecycle.js';
import type { ExecResult } from './types.js';

const MAX_OUTPUT = 1024 * 1024; // keep the last 1 MB of each stream

/**
 * Run a shell command asynchronously. Asynchronous is required: the sandbox's network
 * filter runs inside this process and must keep answering while the command runs.
 * On timeout the whole process tree is killed.
 */
export interface OutputFiles {
  /** Also write the whole of stdout here (from setupscore's side, so the command cannot change it). */
  stdoutFile?: string;
  /** Also write the whole of stderr here. */
  stderrFile?: string;
}

export function runShell(
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
  files: OutputFiles = {},
): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    // A mark every process this command starts inherits, to find the ones that left its process
    // group (setsid, a detached child) after it ends. Inside the OS sandbox its process namespace
    // already ends them all; without a sandbox this is what does.
    const job = randomBytes(9).toString('hex');
    const child = spawn(command, {
      cwd,
      env: { ...env, [JOB_VAR]: job },
      shell: true,
      detached: !isWin,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Killed if setupscore exits or is stopped, so nothing keeps running after us.
    const untrack = trackProcess(child.pid);
    const unmark = onCleanup(() => killJob(job));
    const killAll = () => {
      killTree(child.pid);
      killJob(job);
    };
    // The last MAX_OUTPUT bytes of each stream, kept as a list of chunks (no copy per chunk).
    const tailOf = () => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      return {
        add(c: Buffer) {
          chunks.push(c);
          bytes += c.length;
          while (bytes - chunks[0]!.length >= MAX_OUTPUT) bytes -= chunks.shift()!.length;
        },
        text() {
          const all = Buffer.concat(chunks, bytes);
          return (all.length > MAX_OUTPUT ? all.subarray(all.length - MAX_OUTPUT) : all).toString('utf8');
        },
      };
    };
    const out = tailOf();
    const err = tailOf();
    let extraErr = '';
    const sinks = [files.stdoutFile, files.stderrFile].map((f) => (f ? openSink(f) : null));
    // After the command has exited, output still arriving (the last of a big transcript) keeps
    // the wait going; only a silent pipe held open by a leftover process ends it.
    let rearm = () => {};
    child.stdout.on('data', (c: Buffer) => {
      out.add(c);
      sinks[0]?.write(c);
      rearm();
    });
    child.stderr.on('data', (c: Buffer) => {
      err.add(c);
      sinks[1]?.write(c);
      rearm();
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killAll();
    }, timeoutMs);
    // Ctrl+C or a budget stop: end the whole process tree now.
    const onAbort = () => killAll();
    if (signal?.aborted) onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });

    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      untrack();
      unmark();
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener('abort', onAbort);
      const result = { code, stdout: out.text(), stderr: err.text() + extraErr, timedOut, ms: Date.now() - started };
      // The files are complete before the caller reads them.
      void Promise.all(sinks.map((k) => k?.close())).then(() => resolve(result));
    };
    child.on('error', (e) => {
      extraErr += `\n${e.message}`;
      finish(null);
    });
    // When the command itself ends, end anything it left running in the background too (macOS
    // has no process namespace to do it for us). Then wait briefly for the output to drain: a
    // leftover process holding stdout open must not keep us waiting until the timeout.
    let grace: NodeJS.Timeout | undefined;
    child.on('exit', (code) => {
      killAll();
      const exitedAt = Date.now();
      rearm = () => {
        if (grace && Date.now() - exitedAt > 30_000) return; // a writer that escaped: stop waiting
        clearTimeout(grace);
        grace = setTimeout(() => finish(timedOut ? null : code), 2_000);
      };
      rearm();
    });
    child.on('close', (code) => finish(timedOut ? null : code));
  });
}

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL'); // the whole process group
    }
  } catch {
    // already gone
  }
}

const JOB_VAR = 'SETUPSCORE_JOB';

/**
 * Kill every process that carries this command's mark (Linux: read from /proc). Catches
 * background processes that left the process group, for example with setsid or nohup.
 */
export function killJob(job: string): void {
  if (process.platform !== 'linux') return;
  let pids: string[];
  try {
    pids = readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return;
  }
  const mark = Buffer.from(`${JOB_VAR}=${job}`);
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${pid}/environ`).includes(mark)) process.kill(Number(pid), 'SIGKILL');
    } catch {
      // gone, or not ours
    }
  }
}

/** A file that output chunks are appended to synchronously (so nothing is lost when the process ends). */
function openSink(file: string): { write(c: Buffer): void; close(): Promise<void> } | null {
  let fd: number | null;
  try {
    fd = openSync(file, 'w', 0o600);
  } catch {
    return null;
  }
  return {
    write(c: Buffer) {
      if (fd === null) return;
      try {
        let at = 0;
        while (at < c.length) at += writeSync(fd, c, at, c.length - at);
      } catch {
        // disk full: keep the in-memory tail at least
      }
    },
    async close() {
      if (fd === null) return;
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
      fd = null;
    },
  };
}
