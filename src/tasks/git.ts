import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { trackProcess } from '../core/lifecycle.js';

/** Why a git command failed, for callers that react to one case (no commits yet, a timeout...). */
export type GitErrorKind =
  | 'missing-git'
  | 'folder-not-found'
  | 'not-a-repo'
  | 'dubious-ownership'
  | 'no-commits'
  | 'bare-repo'
  | 'unsupported-repo'
  | 'transport-not-allowed'
  | 'timeout'
  | 'failed';

/**
 * A git command failed. `message` says what is wrong in plain English and `fixes` how to fix it.
 * `code` keeps the original system error code (ENOENT when git is not installed); `gitMessage` is
 * git's own first error line.
 */
export class GitError extends Error {
  readonly kind: GitErrorKind;
  readonly fixes: string[];
  readonly code?: string;
  readonly exitCode?: number;
  readonly gitMessage: string;

  constructor(
    message: string,
    o: { kind: GitErrorKind; fixes?: string[]; code?: string; exitCode?: number | undefined; gitMessage?: string },
  ) {
    super(message);
    this.name = 'GitError';
    this.kind = o.kind;
    this.fixes = o.fixes ?? [];
    if (o.code !== undefined) this.code = o.code;
    if (o.exitCode !== undefined) this.exitCode = o.exitCode;
    this.gitMessage = o.gitMessage ?? message;
  }
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT = 256 * 1024 * 1024;

/** Time limit for one git command: SETUPSCORE_GIT_TIMEOUT_MS, or 10 minutes. */
export function gitTimeoutMs(): number {
  const n = Number(process.env['SETUPSCORE_GIT_TIMEOUT_MS']);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/**
 * Variables that point git at another repository, work tree or index. Git sets them when it runs
 * a hook, and a hook may run setupscore: they would make every command below read the wrong
 * repository (or make the workspace clone fail). setupscore always says which folder it means.
 */
const REPO_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
];

/** The environment for a git command: this process's, without the variables above, and never prompting. */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- an environment is a plain object: delete is how a variable is unset
  for (const k of REPO_ENV) delete env[k];
  return env;
}

const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The first line of git's error output that says something (git prints hints after it). */
const firstLine = (stderr: string) =>
  stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !/^(?:hint|warning):/i.test(l)) ?? '';

/** Turn a failed git command into a GitError with a plain-English message and fixes. */
export function explainGitFailure(
  cwd: string,
  args: string[],
  o: {
    stderr?: string | undefined;
    code?: string | undefined;
    exitCode?: number | undefined;
    timedOut?: boolean | undefined;
    timeoutMs?: number | undefined;
  },
): GitError {
  const stderr = o.stderr ?? '';
  const line = firstLine(stderr);
  const what = `git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? ''}`.trim();
  if (o.timedOut) {
    const s = Math.round((o.timeoutMs ?? gitTimeoutMs()) / 1000);
    return new GitError(`"${what}" took longer than ${s}s and was stopped.`, {
      kind: 'timeout',
      code: 'ETIMEDOUT',
      gitMessage: line || 'timed out',
      fixes: [
        'The repository may be very large, on a slow network drive, or locked by another git command.',
        'Allow more time with SETUPSCORE_GIT_TIMEOUT_MS (in milliseconds), for example SETUPSCORE_GIT_TIMEOUT_MS=1800000.',
      ],
    });
  }
  if (o.code === 'ENOENT' || o.code === 'ENOTDIR') {
    // Node reports a missing working folder the same way as a missing program.
    const st = statSync(cwd, { throwIfNoEntry: false });
    if (!st)
      return new GitError(`Folder not found: ${cwd}`, {
        kind: 'folder-not-found',
        code: o.code,
        fixes: ['Check the path, or run the command inside your project folder.'],
      });
    if (!st.isDirectory()) {
      return new GitError(`Folder not found: ${cwd} is a file, not a folder.`, {
        kind: 'folder-not-found',
        code: 'ENOTDIR',
        fixes: ['Give the project folder instead of a file inside it.'],
      });
    }
    // Keep "spawn git ENOENT" in the message: the CLI recognises it as "git is not installed".
    return new GitError('git is not installed or not on PATH (spawn git ENOENT).', {
      kind: 'missing-git',
      code: 'ENOENT',
      fixes: ['Install git from https://git-scm.com and open a new terminal.'],
    });
  }
  if (o.code) {
    return new GitError(`git could not be started: ${o.code}.`, {
      kind: 'failed',
      code: o.code,
      gitMessage: line,
      fixes: ['Check that git works in this folder (git status), then try again.'],
    });
  }
  if (/dubious ownership/i.test(stderr)) {
    const repo = stderr.match(/repository at '([^'\n]+)'/)?.[1] ?? cwd;
    return new GitError(`git refuses to use ${repo}: the folder belongs to another user ("dubious ownership").`, {
      kind: 'dubious-ownership',
      exitCode: o.exitCode,
      gitMessage: line,
      fixes: [
        `If you trust this folder, mark it as safe: git config --global --add safe.directory ${quote(repo)}`,
        'Then run the command again.',
      ],
    });
  }
  if (/not a git repository/i.test(stderr)) {
    return new GitError(`Not a git repository: ${cwd}`, {
      kind: 'not-a-repo',
      exitCode: o.exitCode,
      gitMessage: line,
      fixes: ['"setupscore tasks" and "setupscore run" build tasks from git history. Run them inside a repository.'],
    });
  }
  if (
    /does not have any commits yet|ambiguous argument 'HEAD'|unknown revision or path not in the working tree.*HEAD|Needed a single revision/i.test(
      stderr,
    ) &&
    args.some((a) => /HEAD/.test(a) || a === 'log')
  ) {
    return new GitError('This repository has no commits yet.', {
      kind: 'no-commits',
      exitCode: o.exitCode,
      gitMessage: line,
      fixes: ['Tasks are built from the commit history. Commit your work first, then run the command again.'],
    });
  }
  if (/unknown repository extension|expected git repo version|repository format version/i.test(stderr)) {
    return new GitError(
      `This repository uses a format that the installed git does not support (${line.replace(/^fatal:\s*/, '')}).`,
      {
        kind: 'unsupported-repo',
        exitCode: o.exitCode,
        gitMessage: line,
        fixes: ['Update git to the newest version (check with git --version), then try again.'],
      },
    );
  }
  if (/transport '?file'? not allowed/i.test(stderr)) {
    return new GitError(
      'git is set up to refuse copying a repository from a local folder (protocol.file.allow), and setupscore works in a temporary copy of yours.',
      {
        kind: 'transport-not-allowed',
        exitCode: o.exitCode,
        gitMessage: line,
        fixes: [
          'Allow local copies for your own user: git config --global protocol.file.allow user',
          'Then run the command again.',
        ],
      },
    );
  }
  if (/must be run in a work tree|this operation must be run in a work tree/i.test(stderr)) {
    return new GitError('This is a bare repository: it has no working folder to check files out into.', {
      kind: 'bare-repo',
      exitCode: o.exitCode,
      gitMessage: line,
      fixes: ['Clone it first (git clone <repository> <folder>) and run setupscore inside the clone.'],
    });
  }
  return new GitError(line || `git exited with code ${o.exitCode ?? 'unknown'}`, {
    kind: 'failed',
    exitCode: o.exitCode,
    gitMessage: line,
  });
}

/**
 * setupscore clones only the user's own repository from a local folder (never its submodules).
 * Allow that even when the user's git config forbids local clones (protocol.file.allow=never).
 */
function withLocalClone(args: string[]): string[] {
  const at = args.findIndex((a, i) => !a.startsWith('-') && args[i - 1] !== '-c' && args[i - 1] !== '-C');
  return args[at] === 'clone' ? ['-c', 'protocol.file.allow=always', ...args] : args;
}

interface RunOptions {
  input?: string;
  timeoutMs?: number;
}

/**
 * Run git with a time limit. On POSIX git gets its own process group, so a timeout (or setupscore
 * exiting) stops git and anything it started, such as a credential helper or a pager.
 */
function runGit(cwd: string, args: string[], o: RunOptions = {}): Promise<string> {
  const timeoutMs = o.timeoutMs ?? gitTimeoutMs();
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn('git', withLocalClone(args), {
        cwd,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: [o.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        env: gitEnv(),
      });
    } catch (err) {
      reject(explainGitFailure(cwd, args, { code: (err as NodeJS.ErrnoException).code ?? 'EUNKNOWN' }));
      return;
    }
    const untrack = trackProcess(child.pid);
    const out: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let timedOut = false;
    let tooBig = false;
    let done = false;
    const kill = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    timer.unref?.();
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      untrack();
      fn();
    };
    child.stdout!.on('data', (d: Buffer) => {
      size += d.length;
      if (size > MAX_OUTPUT) {
        tooBig = true;
        kill();
        return;
      }
      out.push(d);
    });
    child.stderr!.on('data', (d: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += d.toString('utf8');
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(() => {
        reject(explainGitFailure(cwd, args, { code: err.code ?? 'EUNKNOWN' }));
      });
    });
    child.on('close', (code) => {
      finish(() => {
        if (timedOut) reject(explainGitFailure(cwd, args, { timedOut: true, timeoutMs, stderr }));
        else if (tooBig)
          reject(
            new GitError(`git ${args[0] ?? ''} printed more than ${MAX_OUTPUT / 1024 / 1024} MB.`, { kind: 'failed' }),
          );
        else if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
        else reject(explainGitFailure(cwd, args, { stderr, exitCode: code ?? undefined }));
      });
    });
    if (o.input !== undefined) {
      child.stdin!.on('error', () => {
        // git exited before reading everything: the exit code says why
      });
      child.stdin!.end(o.input);
    }
  });
}

/** Run git and return stdout. Throws a GitError that says what went wrong and how to fix it. */
export function git(cwd: string, args: string[], o: { timeoutMs?: number } = {}): Promise<string> {
  return runGit(cwd, args, o);
}

/** Like `git`, but null when the command fails (a missing file at a commit, a missing ref). */
export async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

/** Run git with text on stdin (for commands such as `update-ref --stdin`). */
export function gitWithInput(cwd: string, args: string[], input: string): Promise<string> {
  return runGit(cwd, args, { input });
}
