import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StoppedEarly } from '../core/errors.js';
import { onCleanup, trackProcess } from '../core/lifecycle.js';
import { killTree } from './spawn.js';
import { EnvironmentError } from './types.js';

export type Runtime = typeof import('@anthropic-ai/sandbox-runtime');

/**
 * Anthropic's sandbox runtime: the same OS sandbox Claude Code uses (Seatbelt on macOS,
 * bubblewrap on Linux and WSL2, a sandbox user on Windows). Pinned, because its API is pre-1.0.
 * It is not a dependency of setupscore: `check` users never download it. It is installed once,
 * on first use, into setupscore's cache folder.
 */
export const RUNTIME_PACKAGE = '@anthropic-ai/sandbox-runtime';
export const RUNTIME_VERSION = '0.0.81';

/** How long installing the runtime may take before setupscore gives up. */
const INSTALL_TIMEOUT_MS = 5 * 60_000;

/** An environment variable that names a folder: only an absolute path counts (as the XDG spec says). */
const absoluteDir = (v: string | undefined): string | undefined => (v && isAbsolute(v) ? v : undefined);

export function cacheDir(): string {
  // Resolved once against the folder setupscore started in, so installing and finding agree.
  if (process.env.SETUPSCORE_CACHE_DIR) return resolve(process.env.SETUPSCORE_CACHE_DIR);
  if (process.platform === 'win32')
    return join(absoluteDir(process.env.LOCALAPPDATA) ?? join(homedir(), 'AppData', 'Local'), 'setupscore', 'Cache');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'setupscore');
  return join(absoluteDir(process.env.XDG_CACHE_HOME) ?? join(homedir(), '.cache'), 'setupscore');
}

export const runtimeDir = (): string => join(cacheDir(), 'sandbox-runtime', RUNTIME_VERSION);

/** Written into the cache copy once it has loaded correctly, so it is only checked once. */
const VERIFIED = '.setupscore-verified';

type Where = 'setupscore' | 'project' | 'cache';
interface Installed {
  main: string;
  where: Where;
}

/** Find an installed copy of the pinned version: next to setupscore, in the user's project, or in the cache. */
function findInstalled(cwd: string): Installed | null {
  const bases: [Where, string][] = [
    ['setupscore', import.meta.url],
    ['project', pathToFileURL(join(cwd, 'noop.js')).href],
    ['cache', pathToFileURL(join(runtimeDir(), 'noop.js')).href],
  ];
  for (const [where, base] of bases) {
    try {
      const entry = createRequire(base).resolve(`${RUNTIME_PACKAGE}/package.json`);
      const pkg = JSON.parse(readFileSync(entry, 'utf8')) as { version?: string; main?: string };
      if (pkg.version !== RUNTIME_VERSION) continue;
      const main = join(dirname(entry), pkg.main ?? 'dist/index.js');
      if (existsSync(main)) return { main, where };
    } catch {
      // not installed there
    }
  }
  return null;
}

let loaded: Runtime | null = null;

export interface LoadOptions {
  cwd: string;
  /** Install into the cache when missing, and repair a damaged copy in the cache. */
  install: boolean;
  /** Progress messages ("Installing the sandbox runtime…"). */
  onInstall?: (message: string) => void;
  /** Stops a running install (Ctrl+C). */
  signal?: AbortSignal;
}

const firstLine = (s: string): string =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(
      (l) =>
        l &&
        !/^at\s/.test(l) &&
        !/^Node\.js v\d/.test(l) &&
        !/^\^+$/.test(l) &&
        !l.startsWith('file://') &&
        !l.startsWith('node:'),
    )
    .find((l) => /error|cannot|not found|unexpected|invalid/i.test(l)) ??
  s.trim().split('\n')[0]?.trim() ??
  '';

/**
 * Load the sandbox runtime. A copy in setupscore's cache that cannot be loaded (half-installed,
 * damaged) is deleted and installed again, once. A copy elsewhere is never touched: the error
 * says how to fix it.
 */
export async function loadRuntime(options: LoadOptions): Promise<Runtime | null> {
  if (loaded) return loaded;
  let found = findInstalled(options.cwd);

  // A cache copy that was never loaded successfully is checked in a separate process first: a
  // failed import cannot be retried in this one (Node keeps the failure).
  if (found?.where === 'cache' && !existsSync(join(runtimeDir(), VERIFIED))) {
    const problem = await importProblem(found.main);
    if (problem) {
      if (!options.install) throw damaged(found, problem);
      options.onInstall?.(
        `The sandbox runtime in ${runtimeDir()} is damaged or half-installed (${problem}). Installing it again.`,
      );
      removeCacheCopy();
      found = findInstalled(options.cwd);
    } else {
      markVerified();
    }
  }

  if (!found && options.install) {
    await install(options);
    found = findInstalled(options.cwd);
    if (!found) {
      throw new EnvironmentError(
        `The sandbox runtime was installed into ${runtimeDir()}, but setupscore cannot find it there.`,
        [
          `Delete that folder and run the command again, or install it in this project: npm install -D ${RUNTIME_PACKAGE}@${RUNTIME_VERSION}`,
        ],
      );
    }
  }
  if (!found) return null;

  try {
    loaded = (await import(pathToFileURL(found.main).href)) as Runtime;
  } catch (err) {
    throw damaged(found, firstLine((err as Error).message ?? String(err)));
  }
  if (found.where === 'cache') markVerified();
  return loaded;
}

function damaged(found: Installed, problem: string): EnvironmentError {
  const where = dirname(dirname(found.main));
  if (found.where === 'cache') {
    return new EnvironmentError(`The sandbox runtime in setupscore's cache cannot be loaded: ${problem}`, [
      `Delete ${runtimeDir()} and run the command again: setupscore installs it again.`,
    ]);
  }
  if (found.where === 'project') {
    return new EnvironmentError(`The sandbox runtime in this project (${where}) cannot be loaded: ${problem}`, [
      `Install it again: npm install -D ${RUNTIME_PACKAGE}@${RUNTIME_VERSION}`,
    ]);
  }
  return new EnvironmentError(
    `The sandbox runtime installed next to setupscore (${where}) cannot be loaded: ${problem}`,
    ['Install setupscore again (npm install -g setupscore, or clear the npx cache), then run the command again.'],
  );
}

function markVerified(): void {
  try {
    writeFileSync(join(runtimeDir(), VERIFIED), `${RUNTIME_VERSION}\n`);
  } catch {
    // read-only cache: it is checked again next time
  }
}

function removeCacheCopy(): void {
  try {
    rmSync(runtimeDir(), { recursive: true, force: true });
  } catch (err) {
    throw cacheError(err, runtimeDir());
  }
}

/** Why the runtime cannot be imported, checked in a child process; null when it loads. */
async function importProblem(main: string): Promise<string | null> {
  const code = `await import(${JSON.stringify(pathToFileURL(main).href)});`;
  const r = await runProgram(process.execPath, ['--input-type=module', '-e', code], { timeoutMs: 60_000 });
  if (r.error) return null; // could not even start Node: let the in-process import decide
  if (r.timedOut) return 'loading it did not finish within 60 seconds';
  if (r.code === 0) return null;
  return firstLine(r.stderr) || `exit code ${r.code}`;
}

const CODE_TEXT: Record<string, string> = {
  EACCES: 'permission denied',
  EPERM: 'operation not permitted',
  EROFS: 'read-only file system',
  ENOSPC: 'the disk is full',
  ENOTDIR: 'part of the path is a file, not a folder',
  EEXIST: 'a file is in the way',
};

function cacheError(err: unknown, path: string): Error {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (!code) return err as Error;
  return new EnvironmentError(`Cannot write setupscore's cache folder ${path} (${CODE_TEXT[code] ?? code}).`, [
    'Check the permissions of that folder, or point SETUPSCORE_CACHE_DIR at a folder you can write to.',
  ]);
}

/**
 * The lines of npm's error output that say what went wrong ("code ECONNREFUSED", the request
 * that failed, the folder it could not write), not its advice or the path of its log file.
 */
export function npmReason(output: string): string {
  const lines = output
    .split('\n')
    .map((l) => l.replace(/^npm (error|ERR!|warn|WARN|notice)\s?/, '').trim())
    .filter(Boolean);
  const code = output.match(/npm (?:error|ERR!) code (\S+)/)?.[1];
  const noise =
    /^(code|syscall|errno|path|dest|signal|command|cwd)\b|complete log of this run|If you are behind a proxy|'proxy' config is set|npm help config|Log files were not written|rerun the command with|verbose|^A complete log|^\s*$|^Run `npm|^npm notice/i;
  const useful = lines.filter((l) => !noise.test(l));
  const detail =
    useful.find((l) =>
      /error|failed|denied|not permitted|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|E40\d|404|403|certificate|reason/i.test(l),
    ) ??
    useful[0] ??
    '';
  const path = output.match(/npm (?:error|ERR!) path (\S+)/)?.[1];
  const parts = [
    code && !detail.includes(code) ? code : '',
    detail,
    path && !detail.includes(path) ? `(${path})` : '',
  ].filter(Boolean);
  return parts.join(': ').replace(/: \(/, ' (').slice(0, 400);
}

/**
 * Install the runtime into a temporary folder and move it into place when npm has finished, so
 * an interrupted install (Ctrl+C, a dropped connection) never leaves a half-installed copy.
 */
async function install(options: LoadOptions): Promise<void> {
  const final = runtimeDir();
  const parent = dirname(final);
  try {
    mkdirSync(parent, { recursive: true });
  } catch (err) {
    throw cacheError(err, parent);
  }
  const tmp = join(parent, `.${RUNTIME_VERSION}.installing-${process.pid}-${randomBytes(3).toString('hex')}`);
  const removeTmp = () => rmSync(tmp, { recursive: true, force: true });
  const forget = onCleanup(removeTmp);
  try {
    try {
      mkdirSync(tmp, { recursive: true });
    } catch (err) {
      throw cacheError(err, parent);
    }
    options.onInstall?.(
      `Downloading and installing the sandbox runtime (${RUNTIME_PACKAGE}@${RUNTIME_VERSION}, about 12 MB) into ${final}. This happens once.`,
    );
    const started = Date.now();
    const heartbeat = setInterval(() => {
      const s = Math.round((Date.now() - started) / 1000);
      options.onInstall?.(
        `  still installing the sandbox runtime (${s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`} so far)…`,
      );
    }, 30_000);
    heartbeat.unref();
    // No shell: a $, a quote or a space in the cache path stays part of the path.
    const args = [
      'install',
      '--prefix',
      tmp,
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      '--loglevel=error',
      `${RUNTIME_PACKAGE}@${RUNTIME_VERSION}`,
    ];
    let r: ProgramResult;
    try {
      r =
        process.platform === 'win32' // npm is npm.cmd there, which needs a shell
          ? await runProgram(`npm ${args.map((a) => `"${a}"`).join(' ')}`, 'shell', {
              timeoutMs: INSTALL_TIMEOUT_MS,
              cwd: tmp,
              signal: options.signal,
            })
          : await runProgram('npm', args, { timeoutMs: INSTALL_TIMEOUT_MS, cwd: tmp, signal: options.signal });
    } finally {
      clearInterval(heartbeat);
    }
    if (options.signal?.aborted) {
      throw new StoppedEarly('Stopped while installing the sandbox runtime. Nothing was installed or saved.', [
        'Run the command again to install it.',
      ]);
    }
    if (r.code !== 0 || r.error) {
      const npmMissing =
        r.error?.code === 'ENOENT' ||
        r.code === 127 ||
        /'npm' is not recognized|npm: (command )?not found/.test(r.stderr);
      if (npmMissing) {
        throw new EnvironmentError('Could not install the sandbox runtime: npm is not installed (or not on PATH).', [
          'npm comes with Node.js: install Node.js 22.12 or newer from https://nodejs.org, then open a new terminal.',
          `Or install the runtime yourself in this project: npm install -D ${RUNTIME_PACKAGE}@${RUNTIME_VERSION}`,
        ]);
      }
      const reason = r.timedOut
        ? `npm did not finish within ${INSTALL_TIMEOUT_MS / 60_000} minutes (the npm registry did not answer, or the connection is very slow)`
        : r.error
          ? `npm could not be started (${r.error.message})`
          : npmReason(`${r.stderr}\n${r.stdout}`) || `npm exited with code ${r.code ?? 'unknown'} and printed nothing`;
      const network =
        /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|network|proxy|did not answer|certificate|CERT_|SELF_SIGNED/i.test(
          reason,
        );
      const permission = /EACCES|EPERM|permission/i.test(reason);
      throw new EnvironmentError(`Could not install the sandbox runtime: ${reason}`, [
        permission
          ? 'npm could not write a folder it needs (often its cache, ~/.npm). Fix that folder\'s owner or permissions (for example: sudo chown -R "$(id -u)" ~/.npm), then run the command again.'
          : network
            ? 'Check your internet connection, proxy and npm registry settings (npm config get registry), then run the command again.'
            : 'Run the command again; if it fails the same way, check your npm settings (npm config list).',
        `Or install it yourself in this project: npm install -D ${RUNTIME_PACKAGE}@${RUNTIME_VERSION}`,
      ]);
    }
    try {
      renameSync(tmp, final);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Another setupscore installed it at the same time: use theirs.
      if (
        (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'EPERM') &&
        existsSync(join(final, 'node_modules', ...RUNTIME_PACKAGE.split('/'), 'package.json'))
      )
        return;
      try {
        rmSync(final, { recursive: true, force: true });
        renameSync(tmp, final);
      } catch (again) {
        throw cacheError(again, final);
      }
    }
  } finally {
    removeTmp();
    forget();
  }
}

export const runtimeInstallHint = `npm install -D ${RUNTIME_PACKAGE}@${RUNTIME_VERSION}  (or let "setupscore tasks" install it automatically)`;

export interface ProgramResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the program could not be started at all (ENOENT: not installed). */
  error?: NodeJS.ErrnoException;
}

export interface ProgramOptions {
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Stops the program and everything it started (Ctrl+C). */
  signal?: AbortSignal;
}

const MAX_OUTPUT = 256 * 1024;

/**
 * Run a program outside the sandbox (git, npm, claude --version) with a time limit. Without a
 * shell unless `args` is 'shell' (then `command` is a whole command line). On timeout, or when
 * the program ends, everything it started is killed too, so a stuck helper that keeps the output
 * open never makes setupscore wait.
 */
export function runProgram(command: string, args: string[] | 'shell', o: ProgramOptions): Promise<ProgramResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const shell = args === 'shell';
    let child;
    try {
      child = shell
        ? spawn(command, {
            cwd: o.cwd,
            env: o.env,
            shell: true,
            detached: !isWin,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        : spawn(command, args, {
            cwd: o.cwd,
            env: o.env,
            detached: !isWin,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, error: err as NodeJS.ErrnoException });
      return;
    }
    const untrack = trackProcess(child.pid);
    let stdout = '';
    let stderr = '';
    // Keep the end of long output: errors come last.
    const keep = (buf: string, chunk: Buffer) => {
      const next = buf + chunk.toString('utf8');
      return next.length > MAX_OUTPUT ? next.slice(-MAX_OUTPUT) : next;
    };
    child.stdout!.on('data', (c: Buffer) => (stdout = keep(stdout, c)));
    child.stderr!.on('data', (c: Buffer) => (stderr = keep(stderr, c)));
    let timedOut = false;
    let done = false;
    let grace: NodeJS.Timeout | undefined;
    const onAbort = () => killTree(child.pid);
    const finish = (code: number | null, error?: NodeJS.ErrnoException) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      o.signal?.removeEventListener('abort', onAbort);
      untrack();
      resolve({ code: timedOut ? null : code, stdout, stderr, timedOut, ...(error ? { error } : {}) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      // Give the streams a moment, then stop waiting whatever happens.
      grace = setTimeout(() => finish(null), 1_000);
    }, o.timeoutMs);
    if (o.signal?.aborted) onAbort();
    o.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => finish(null, err as NodeJS.ErrnoException));
    child.on('exit', (code) => {
      killTree(child.pid); // anything it left running in the background
      grace = setTimeout(() => finish(code), 1_000);
    });
    child.on('close', (code) => finish(code));
  });
}
