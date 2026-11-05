import { spawn, spawnSync } from 'node:child_process';
import {
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { onCleanup, trackProcess } from '../core/lifecycle.js';
import { git, gitEnv, gitTimeoutMs, gitWithInput, tryGit } from './git.js';

const OWNER = 'owner.pid';

/**
 * Problems with the temp folder that would make every attempt fail in a confusing way: a folder
 * the sandbox cannot see (/dev/shm: bubblewrap mounts a fresh /dev), or one where programs may not
 * run (mounted noexec: tests fail with "Permission denied"). Null when it is fine.
 */
export function tempFolderProblem(
  o: { sandboxed: boolean; dirs?: { label: string; path: string; fix: string }[] } = { sandboxed: true },
): { message: string; fixes: string[] } | null {
  if (process.platform === 'win32') return null;
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const fix =
    'Point TMPDIR at a folder on a normal disk, for example: mkdir -p ~/.cache/tmp && TMPDIR=~/.cache/tmp npx setupscore run';
  if (o.sandboxed && process.platform === 'linux') {
    for (const d of [{ label: 'The temp folder (TMPDIR)', path: tmpdir(), fix }, ...(o.dirs ?? [])]) {
      const r = real(d.path);
      if (r === '/dev' || r.startsWith('/dev/')) {
        return {
          message: `${d.label} is ${r}, under /dev, which the sandbox cannot see (it gets its own /dev).`,
          fixes: [d.fix],
        };
      }
    }
  }
  // Programs must be able to run from the temp folder: the workspace (and its test runners) lives there.
  let probe: string | null = null;
  try {
    probe = mkdtempSync(join(tmpdir(), 'setupscore-exec-'));
    const script = join(probe, 'probe.sh');
    writeFileSync(script, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const r = spawnSync(script, [], { stdio: 'ignore', timeout: 10_000 });
    const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'EACCES' || code === 'EPERM') {
      return {
        message: `Programs cannot run from the temp folder ${tmpdir()} (it is mounted noexec), so test runners and installs would fail with "Permission denied".`,
        fixes: [fix],
      };
    }
  } catch {
    // cannot even create a folder there: Workspace.create reports that with its own message
  } finally {
    if (probe) rmSync(probe, { recursive: true, force: true });
  }
  return null;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * A throwaway clone of the user's repository. Tasks are checked out and run here, never in
 * the user's own folder, so untracked files (.env, local notes) are simply not present.
 * `--shared` reads git objects from the original without copying them; the sandbox keeps
 * the original read-only.
 *
 * The clone keeps no branches, tags, remote or reflog. Each task checks out the commit
 * *before* a change, and the agent must not find the answer with `git log --all` or
 * `git show origin/main:file`. Commits are always checked out by hash.
 */
export class Workspace {
  /**
   * Layout of the temporary folder (`outer`):
   *   w/repo, w/tmp, ...  `base`: the only part sandboxed commands may write to
   *   no-hooks/           core.hooksPath for git on the host: never writable from the sandbox,
   *                       or a planted hook would run outside it on the next checkout
   *   deps/, pristine/    installed dependencies kept aside: an agent or a test must not edit them
   *   host/               setupscore's own files for an attempt (prompt, transcript, stderr)
   */
  private constructor(
    /** Temporary folder holding everything; deleted on close. */
    readonly outer: string,
    /** The part of the workspace sandboxed commands may write to. */
    readonly base: string,
    /** An empty folder used as core.hooksPath. */
    private readonly hooks: string,
    /** The clone (git top level). */
    readonly root: string,
    /** The project folder inside the clone (differs from root in monorepo packages). */
    readonly dir: string,
    /** A private temp folder for the commands. */
    readonly tmp: string,
    /** The commit the user's repository was at (its HEAD), or null for a repository with no commits. */
    readonly head: string | null,
  ) {}

  /** A folder for setupscore's own files, readable but never writable inside the sandbox. */
  get hostDir(): string {
    return join(this.outer, 'host');
  }

  static async create(projectDir: string): Promise<Workspace> {
    const top = (await git(projectDir, ['rev-parse', '--show-toplevel'])).trim();
    const prefix = (await git(projectDir, ['rev-parse', '--show-prefix'])).trim();
    Workspace.sweepLeftovers();
    const outer = mkdtempSync(join(tmpdir(), 'setupscore-ws-'));
    const base = join(outer, 'w');
    const root = join(base, 'repo');
    const hooks = join(outer, 'no-hooks');
    const tmp = join(base, 'tmp');
    let head: string | null = null;
    try {
      // Who owns this folder, so a later setupscore can remove it if this process is killed (kill -9).
      writeFileSync(join(outer, OWNER), `${process.pid}\n`);
      mkdirSync(hooks);
      mkdirSync(base);
      mkdirSync(tmp);
      mkdirSync(join(outer, 'host'));
      // No hooks while cloning either (a global reference-transaction hook would run here).
      await git(base, [
        '-c',
        `core.hooksPath=${hooks}`,
        '-c',
        'core.fsmonitor=false',
        'clone',
        '--quiet',
        '--shared',
        '--no-checkout',
        top,
        root,
      ]);
      // Never run git hooks in the workspace.
      await git(root, ['config', 'core.hooksPath', hooks]);
      head = (await tryGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']))?.trim() || null;
      await Workspace.forgetHistoryPointers(root);
    } catch (err) {
      rmSync(outer, { recursive: true, force: true });
      throw err;
    }
    const ws = new Workspace(outer, base, hooks, root, prefix ? join(root, prefix) : root, tmp, head);
    // Deleted even if setupscore is made to quit at once (a second Ctrl+C, SIGTERM twice, exit).
    ws.releaseCleanup = onCleanup(() => ws.close());
    return ws;
  }

  private releaseCleanup: () => void = () => {};

  private static swept = false;

  /**
   * Delete workspaces left behind by a setupscore that was killed before it could clean up
   * (kill -9, a crash, a machine restart). Only folders whose owner process is gone are touched;
   * folders from older versions (no owner file) only when they are more than a day old.
   */
  static sweepLeftovers(dir = tmpdir()): void {
    if (Workspace.swept && dir === tmpdir()) return;
    Workspace.swept = true;
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => /^setupscore-ws-[\w]{6}$/.test(n));
    } catch {
      return;
    }
    for (const name of names) {
      const base = join(dir, name);
      try {
        const st = lstatSync(base);
        if (!st.isDirectory() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) continue;
        let pid = NaN;
        try {
          pid = Number(readFileSync(join(base, OWNER), 'utf8').trim());
        } catch {
          // no owner file
        }
        const gone =
          Number.isInteger(pid) && pid > 0
            ? pid !== process.pid && !processAlive(pid)
            : Date.now() - st.mtimeMs > 24 * 3600_000;
        if (gone) new Workspace(base, base, '', '', '', '', null).close();
      } catch {
        // someone else's or already gone
      }
    }
  }

  /**
   * Remove everything that points at later commits: the remote (which also names the user's
   * real folder), every branch and tag, and the reflog. Turn the reflog off so checkouts of
   * other tasks leave no trace either.
   */
  private static async forgetHistoryPointers(root: string): Promise<void> {
    await git(root, ['config', 'core.logAllRefUpdates', 'false']);
    await tryGit(root, ['remote', 'remove', 'origin']);
    const refs = (await git(root, ['for-each-ref', '--format=%(refname)'])).split('\n').filter(Boolean);
    if (refs.length)
      await gitWithInput(root, ['update-ref', '--no-deref', '--stdin'], refs.map((r) => `delete ${r}\n`).join(''));
    for (const name of ['logs', 'FETCH_HEAD', 'ORIG_HEAD', 'packed-refs'])
      rmSync(join(root, '.git', name), { recursive: true, force: true });
  }

  /**
   * git on the host, with settings that could run commands forced off. The clone's .git is
   * read-only inside the sandbox; this is a second layer in case that ever fails.
   */
  private safe(args: string[]): string[] {
    return [
      '-c',
      'core.fsmonitor=false',
      '-c',
      `core.hooksPath=${this.hooks}`,
      '-c',
      'core.sshCommand=false',
      '-c',
      'protocol.allow=never',
      ...args,
    ];
  }

  /** The clone's .git folder, kept read-only for sandboxed commands. */
  get gitDir(): string {
    return join(this.root, '.git');
  }

  /**
   * Check out a commit with a clean tree, on a branch called "main" so the agent sees a normal
   * repository. Installed dependencies are kept to save time.
   */
  async checkout(hash: string): Promise<void> {
    await git(this.root, this.safe(['checkout', '--quiet', '--force', '-B', 'main', hash]));
    this.returnDependencies(); // in case an earlier attempt stopped before it could
    await git(this.root, this.safe(['clean', '-fdxq', '-e', 'node_modules', '-e', '.pnpm-store', '-e', '.yarn/cache']));
  }

  /** A file's content at a commit, or null if it did not exist then. Path is relative to the project. */
  async show(hash: string, rel: string): Promise<string | null> {
    return tryGit(this.dir, this.safe(['show', `${hash}:./${rel}`]));
  }

  /** Write a file's content from another commit into the working tree. */
  async writeFrom(hash: string, rel: string): Promise<string | null> {
    const text = await this.show(hash, rel);
    if (text === null) return null;
    this.writeSafely(rel, text);
    return text;
  }

  /**
   * Write a file inside the project folder without following anything the agent planted:
   * a symbolic link or a folder at the file's path, or a symbolic link in place of a parent
   * folder, is removed first. Paths that leave the project are refused.
   */
  writeSafely(rel: string, content: string | Buffer): void {
    const norm = normalize(rel);
    if (!norm || isAbsolute(norm) || norm === '..' || norm.startsWith(`..${sep}`))
      throw new Error(`refusing to write outside the project: ${rel}`);
    const root = lstatSync(this.dir);
    if (!root.isDirectory()) throw new Error('the project folder was replaced');
    const parts = norm.split(sep);
    let dir = this.dir;
    for (const part of parts.slice(0, -1)) {
      dir = join(dir, part);
      const st = lstatSync(dir, { throwIfNoEntry: false });
      if (st && !st.isDirectory()) rmSync(dir, { recursive: true, force: true }); // a symlink or a file in the way
      if (!st || !st.isDirectory()) mkdirSync(dir);
    }
    const abs = join(this.dir, norm);
    if (lstatSync(abs, { throwIfNoEntry: false })) rmSync(abs, { recursive: true, force: true });
    writeFileSync(abs, content, { flag: 'wx' });
  }

  /** Remove a file from the project folder if it is there (never follows a symbolic link). */
  removeSafely(rel: string): void {
    const norm = normalize(rel);
    if (!norm || isAbsolute(norm) || norm.startsWith('..')) return;
    rmSync(join(this.dir, norm), { recursive: true, force: true });
  }

  /** Paths of files at a commit, relative to the project folder. */
  async listFiles(hash: string): Promise<string[]> {
    const out = await tryGit(this.dir, this.safe(['ls-tree', '-r', '-z', '--name-only', hash, '--', '.']));
    return out ? out.split('\0').filter(Boolean) : [];
  }

  /** Many files' contents at a commit in one git process. Missing files map to null. */
  async readMany(hash: string, rels: string[]): Promise<Map<string, Buffer | null>> {
    const out = new Map<string, Buffer | null>();
    if (!rels.length) return out;
    const prefix = (await git(this.dir, ['rev-parse', '--show-prefix'])).trim();
    const data = await new Promise<Buffer>((resolve, reject) => {
      // Its own process group, so a hang (a lock, a slow disk) is ended with everything git started.
      const child = spawn('git', this.safe(['cat-file', '--batch']), {
        cwd: this.root,
        env: gitEnv(),
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      const untrack = trackProcess(child.pid);
      const timer = setTimeout(() => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, gitTimeoutMs());
      const chunks: Buffer[] = [];
      child.stdout.on('data', (d: Buffer) => chunks.push(d));
      child.stdin.on('error', () => {
        // git ended early: the exit code says why
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        untrack();
        reject(err);
      });
      child.on('close', (code, sig) => {
        clearTimeout(timer);
        untrack();
        if (code === 0) resolve(Buffer.concat(chunks));
        else
          reject(new Error(sig === 'SIGKILL' ? 'git cat-file took too long' : `git cat-file exited with code ${code}`));
      });
      child.stdin.end(rels.map((r) => `${hash}:${prefix}${r.split(sep).join('/')}\n`).join(''));
    });
    let at = 0;
    for (const rel of rels) {
      const nl = data.indexOf(10, at);
      const header = data.subarray(at, nl).toString('utf8');
      at = nl + 1;
      const m = header.match(/^[0-9a-f]+ (\w+) (\d+)$/);
      if (!m) {
        out.set(rel, null); // "<name> missing"
        continue;
      }
      const size = Number(m[2]);
      out.set(rel, m[1] === 'blob' ? data.subarray(at, at + size) : null);
      at += size + 1;
    }
    return out;
  }

  hasDependencies(): boolean {
    return existsSync(join(this.dir, 'node_modules'));
  }

  /** node_modules folders that commands in the project use (the project's, the workspace root's and the repository root's in a monorepo). */
  private dependencyDirs(): string[] {
    return [...new Set([join(this.dir, 'node_modules'), join(this.root, 'node_modules'), ...this.extraDependencyDirs])];
  }

  private extraDependencyDirs: string[] = [];

  private lending = false;

  /**
   * Give the agent its own copy of the installed dependencies and keep the original aside.
   * Whatever the agent does to node_modules (a fake `node` in .bin, an edited package, a new
   * node_modules where there was none) is thrown away by `returnDependencies` before the
   * hidden tests run. Copies use copy-on-write where the file system supports it.
   */
  lendDependencies(extra: string[] = []): void {
    // Only folders inside the clone (a package manager's install root, for example).
    this.extraDependencyDirs = extra.filter((d) => d.startsWith(`${this.root}${sep}`));
    this.lending = true;
    // The original goes outside the writable part of the workspace, where the agent cannot edit it.
    const aside = join(this.outer, 'pristine');
    mkdirSync(aside, { recursive: true });
    this.dependencyDirs().forEach((d, i) => {
      const kept = join(aside, String(i));
      rmSync(kept, { recursive: true, force: true });
      if (!existsSync(d)) return;
      renameSync(d, kept);
      cpSync(kept, d, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    });
  }

  /** Throw away the agent's node_modules and put the original back. Does nothing unless lent. */
  returnDependencies(): void {
    if (!this.lending) return;
    this.dependencyDirs().forEach((d, i) => {
      const kept = join(this.outer, 'pristine', String(i));
      rmSync(d, { recursive: true, force: true });
      if (existsSync(kept)) renameSync(kept, d);
    });
    this.lending = false;
    this.extraDependencyDirs = [];
  }

  private parked: string[] = [];

  /** Move the installed node_modules aside under a key, keeping the 3 most recent. Renames are instant. */
  parkDependencies(key: string): void {
    const from = join(this.dir, 'node_modules');
    if (!existsSync(from)) return;
    const to = join(this.outer, 'deps', key);
    mkdirSync(join(this.outer, 'deps'), { recursive: true });
    rmSync(to, { recursive: true, force: true });
    renameSync(from, to);
    this.parked = [key, ...this.parked.filter((k) => k !== key)];
    for (const old of this.parked.splice(3)) rmSync(join(this.outer, 'deps', old), { recursive: true, force: true });
  }

  /** Bring back node_modules parked under this key. False when there is none. */
  restoreDependencies(key: string): boolean {
    const from = join(this.outer, 'deps', key);
    if (!existsSync(from)) return false;
    rmSync(join(this.dir, 'node_modules'), { recursive: true, force: true });
    renameSync(from, join(this.dir, 'node_modules'));
    this.parked = this.parked.filter((k) => k !== key);
    return true;
  }

  /**
   * Delete the workspace. Never throws: a command may have made files immutable (chflags uchg on
   * macOS, chattr +i on Linux), so those flags are cleared and the delete is tried again; if it
   * still fails, the folder is left behind and its path returned so the caller can mention it.
   */
  close(): string | null {
    const attempt = () => {
      try {
        rmSync(this.outer, { recursive: true, force: true, maxRetries: 3 });
        return true;
      } catch {
        return false;
      }
    };
    this.releaseCleanup();
    if (attempt()) return null;
    const unlock =
      process.platform === 'darwin'
        ? ['chflags', ['-R', 'nouchg', this.outer]]
        : process.platform === 'linux'
          ? ['chattr', ['-R', '-i', '-a', this.outer]]
          : null;
    if (unlock) spawnSync(unlock[0] as string, unlock[1] as string[], { stdio: 'ignore', timeout: 30_000 });
    if (process.platform !== 'win32')
      spawnSync('chmod', ['-R', 'u+rwX', this.outer], { stdio: 'ignore', timeout: 30_000 });
    return attempt() ? null : this.outer;
  }
}
