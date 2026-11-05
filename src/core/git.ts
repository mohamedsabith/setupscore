import { execFileSync } from 'node:child_process';

const run = (cwd: string, args: string[], timeout = 15_000): string | null => {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
  } catch {
    return null; // git not installed, not a repository, or too slow
  }
};

/**
 * The paths (relative to `root`) that .gitignore rules ignore, such as generated output.
 * Empty without git or when none are ignored.
 */
export function gitIgnored(root: string, paths: string[]): Set<string> {
  if (paths.length === 0) return new Set();
  try {
    const out = execFileSync('git', ['check-ignore', '-z', '--stdin'], {
      cwd: root,
      input: paths.join('\0') + '\0',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5000,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return new Set(out.split('\0').filter(Boolean));
  } catch (err) {
    // Exit code 1 means "nothing is ignored"; anything else (no git, not a repo) means we cannot tell.
    const out = (err as { stdout?: string }).stdout;
    return new Set(typeof out === 'string' ? out.split('\0').filter(Boolean) : []);
  }
}

/** Files git tracks under `root` matching a pathspec, relative to `root`. Null without git. */
export function gitTracked(root: string, pathspec: string): Set<string> | null {
  const out = run(root, ['ls-files', '-z', '--', pathspec]);
  if (out === null) return null;
  return new Set(out.split('\0').filter(Boolean));
}

/**
 * Files renamed in git history, as old path -> newest path, relative to `root`.
 * Follows chains (a -> b -> c gives a -> c). Returns an empty map without git.
 */
/** How far back `check` looks for renames, and how long it may wait for git. */
const RENAME_COMMITS = 2000;
const RENAME_TIMEOUT_MS = 5000;

export function gitRenames(root: string, exists: (rel: string) => boolean): Map<string, string> {
  const out = new Map<string, string>();
  const prefix = run(root, ['rev-parse', '--show-prefix'], RENAME_TIMEOUT_MS)?.trim();
  if (prefix === undefined) return out;

  // Walk only the newest commits: rename detection costs time on every commit walked, and a
  // limit on the number of renames found (git log -n with --diff-filter) still walks all history.
  const boundary = run(
    root,
    ['rev-list', '--max-count=1', `--skip=${RENAME_COMMITS}`, 'HEAD'],
    RENAME_TIMEOUT_MS,
  )?.trim();
  const range = boundary ? [`${boundary}..HEAD`] : ['HEAD'];
  const log = run(
    root,
    [
      '-c',
      'core.quotepath=off',
      'log',
      ...range,
      '--diff-filter=R',
      '--name-status',
      '-z',
      '-M',
      '--format=',
      '--',
      '.',
    ],
    RENAME_TIMEOUT_MS,
  );
  if (!log) return out;

  const direct = new Map<string, string>();
  // git log lists newest first, so the first rename seen for a path is its latest one.
  // With -z each entry is "R100", old path, new path, separated by NUL bytes.
  const tokens = log.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i]!.replace(/^\n+/, '');
    if (!/^R\d*$/.test(status) || i + 2 >= tokens.length) continue;
    let from = tokens[i + 1]!;
    let to = tokens[i + 2]!;
    i += 2;
    if (prefix) {
      if (!from.startsWith(prefix) || !to.startsWith(prefix)) continue;
      from = from.slice(prefix.length);
      to = to.slice(prefix.length);
    }
    if (!direct.has(from)) direct.set(from, to);
  }

  for (const from of direct.keys()) {
    let to = direct.get(from)!;
    for (let i = 0; i < 20 && direct.has(to) && direct.get(to) !== from; i++) to = direct.get(to)!;
    if (to !== from && exists(to)) out.set(from, to);
  }
  return out;
}
