import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import pc from 'picocolors';
import { kindOf } from '../core/discover.js';
import { UsageError } from '../core/errors.js';
import { walk } from '../core/walk.js';
import { git, tryGit } from '../tasks/git.js';
import { trimEndWhile } from '../core/text.js';

/**
 * A "setup" is the set of files that tell Claude Code how to work in a repo: every CLAUDE.md,
 * every file under .claude/ (rules, skills with their other files, agents, commands, hook
 * scripts, settings.json) and .mcp.json. Personal files (CLAUDE.local.md, settings.local.json)
 * are never part of a setup.
 *
 * In a monorepo package, Claude Code also loads the CLAUDE.md files of the folders above it, so
 * the setup includes the setup files of every folder between the package and the repository
 * root. Paths are relative to the project folder; files above it start with "../".
 */
export interface SetupSnapshot {
  /** Short name shown in reports: A, B, baseline. */
  label: string;
  /** Where it came from: "working" (your files now), a git ref, or "none". */
  source: string;
  /** Path (relative to the project; "../" for folders above it in a monorepo) -> content. */
  files: Record<string, string>;
  /** Files that must be executable, such as hook scripts. Absent when there are none. */
  executable?: string[];
}

/** Personal or Claude Code's own working files: never part of a setup. */
const PERSONAL =
  /(^|\/)CLAUDE\.local\.md$|(^|\/)\.claude\/settings\.local\.json$|(^|\/)\.claude\/(?:worktrees|agent-memory-local)\//;
/** Installed packages and version control: their CLAUDE.md files belong to someone else. */
const FOREIGN = /(^|\/)(?:node_modules[^/]*|\.git|\.hg|\.svn|\.setupscore|\.pnpm-store)\//;
const IN_CLAUDE_DIR = /(^|\/)\.claude\//;
/** Files an operating system leaves in folders: never instructions. */
const OS_JUNK = /(^|\/)(?:\.DS_Store|\._[^/]*|Thumbs\.db|desktop\.ini)$/i;
const MAX_SETUP_FILE = 512 * 1024;
/** Folders never looked into when cleaning a checked-out commit (installed packages, version control). */
const CLEAN_SKIP = /^(?:node_modules.*|\.git|\.hg|\.svn|\.setupscore|\.pnpm-store)$/;

export const isSetupPath = (rel: string): boolean =>
  !PERSONAL.test(rel) && !FOREIGN.test(rel) && !OS_JUNK.test(rel) && (kindOf(rel) !== null || IN_CLAUDE_DIR.test(rel));

/**
 * Files that the commit may hold and that setupscore removes before placing a setup: setup files,
 * personal ones, and a .claude that is a link to a folder (the link is removed, never followed).
 */
const isInstructionPath = (rel: string): boolean =>
  !FOREIGN.test(rel) && (kindOf(rel) !== null || IN_CLAUDE_DIR.test(rel) || /(^|\/)\.claude$/.test(rel));

const toPosix = (p: string) => p.split(sep).join('/');
const depth = (dir: string) => (dir ? dir.split('/').length : 0);

/**
 * The folder a setup file belongs to: "a/b" for a/b/CLAUDE.md, a/b/.claude/... and a/b/.mcp.json.
 * Claude Code reads a folder's setup when it works in that folder or below it.
 */
function ownerOf(rootRel: string): string {
  const m = /(^|\/)\.claude\//.exec(rootRel);
  if (m) return rootRel.slice(0, m.index);
  const d = posix.dirname(rootRel);
  return d === '.' ? '' : d;
}

/**
 * The snapshot key for a path relative to the repository root, or null when the file is not part
 * of the project's setup: it must be inside the project folder, or belong to a folder above it.
 * `prefix` is the project folder relative to the root ("" or "packages/app").
 */
function keyFor(rootRel: string, prefix: string, isPart: (rel: string) => boolean = isSetupPath): string | null {
  if (!isPart(rootRel)) return null;
  if (!prefix) return rootRel;
  if (rootRel.startsWith(`${prefix}/`)) return rootRel.slice(prefix.length + 1);
  const owner = ownerOf(rootRel);
  if (owner && !prefix.startsWith(`${owner}/`)) return null; // a sibling folder: Claude does not load it here
  return `${'../'.repeat(depth(prefix) - depth(owner))}${owner ? rootRel.slice(owner.length + 1) : rootRel}`;
}

/** The folders above the project, up to the root ("" is the root). */
function ancestorsOf(prefix: string): string[] {
  const out: string[] = [];
  let d = prefix;
  while (d) {
    d = posix.dirname(d) === '.' ? '' : posix.dirname(d);
    out.push(d);
  }
  return out;
}

/** Setup-like files that sit directly in a folder above the project: its CLAUDE.md, .mcp.json and .claude/. */
function ancestorFiles(top: string, dir: string, isPart: (rel: string) => boolean): string[] {
  const at = (name: string) => (dir ? `${dir}/${name}` : name);
  const out: string[] = [];
  for (const name of ['CLAUDE.md', 'CLAUDE.local.md', '.mcp.json']) {
    const st = lstatSync(join(top, at(name)), { throwIfNoEntry: false });
    if (st && !st.isDirectory() && isPart(at(name))) out.push(at(name));
  }
  const claudeDir = join(top, at('.claude'));
  const st = lstatSync(claudeDir, { throwIfNoEntry: false });
  if (st?.isSymbolicLink())
    out.push(at('.claude')); // a link in place of the folder: never followed
  else if (st?.isDirectory())
    for (const f of listAll(claudeDir)) if (isPart(at(`.claude/${f}`))) out.push(at(`.claude/${f}`));
  return out;
}

/** Every file under a folder (forward slashes), without following folder links or entering installed packages. */
function listAll(root: string): string[] {
  const out: string[] = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!CLEAN_SKIP.test(e.name)) stack.push(child);
      } else {
        out.push(child);
      }
      if (out.length >= 200_000) return out;
    }
  }
  return out;
}

/**
 * Files under a .claude folder of the working tree (root-relative), following links to folders that
 * stay inside the repository, as Claude Code does. Links that lead out of it are reported.
 */
function followLinkedFolders(root: string, dir: string, warnings: string[], shown: string): string[] {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [dir];
  while (stack.length && out.length < 200_000) {
    const rel = stack.pop()!;
    const abs = join(root, ...rel.split('/'));
    let real: string;
    try {
      real = realpathSync(abs);
      if (!statSync(abs).isDirectory()) continue;
    } catch {
      continue; // missing, or a broken link
    }
    const inside = real === realRoot || real.startsWith(`${realRoot}${sep}`);
    if (!inside) {
      warnings.push(
        `${rel === dir ? shown : `${shown}/${rel.slice(dir.length + 1)}`} is a link to a folder outside the repository (${real}), so its files are left out.`,
      );
      continue;
    }
    if (seen.has(real)) continue; // a loop of links
    seen.add(real);
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const child = `${rel}/${e.name}`;
      if (rel === dir && (e.name === 'worktrees' || e.name === 'agent-memory-local')) continue; // Claude Code's own working folders
      if (e.isDirectory()) {
        if (!CLEAN_SKIP.test(e.name)) stack.push(child);
      } else if (e.isSymbolicLink() && statSync(join(abs, e.name), { throwIfNoEntry: false })?.isDirectory()) {
        stack.push(child);
      } else {
        out.push(child);
      }
    }
  }
  return out;
}

/** Text content, or why a file cannot be part of a setup. */
function asText(buf: Buffer): string | { why: string } {
  if (buf.length > MAX_SETUP_FILE)
    return {
      why: `it is ${Math.round(buf.length / 1024)} KB, over the 512 KB limit for one setup file. Make it smaller to test it`,
    };
  if (buf.subarray(0, 8000).includes(0)) return { why: 'it is not a text file' };
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf); // keeps a byte order mark as it is
  } catch {
    return { why: 'it is not a text file (not UTF-8)' };
  }
}

const defaultWarn = (m: string) => process.stderr.write(`${pc.yellow(m)}\n`);

/** Warnings about left-out files: the first few in full, then a count, so a big .claude/ does not flood the screen. */
function flushWarnings(label: string, list: string[], warn: (m: string) => void): void {
  for (const w of list.slice(0, 5)) warn(`Setup ${label}: ${w}`);
  if (list.length > 5)
    warn(
      `Setup ${label}: ${list.length - 5} more file${list.length - 5 === 1 ? '' : 's'} left out for the same reasons.`,
    );
}

/**
 * Read a setup from:
 *   "working"  the files in your folder now, including changes you have not committed
 *   "none"     no instructions at all (the baseline)
 *   anything else: a git branch, tag or commit
 * Files that cannot be part of a setup (too big, not text, a link that leads out of the commit)
 * are left out with a warning, never silently.
 */
export async function snapshotSetup(
  projectDir: string,
  source: string,
  label: string,
  warn: (m: string) => void = defaultWarn,
): Promise<SetupSnapshot> {
  const files: Record<string, string> = {};
  const executable: string[] = [];
  const warnings: string[] = [];
  const done = (src: string): SetupSnapshot => {
    flushWarnings(label, warnings, warn);
    return { label, source: src, files, ...(executable.length ? { executable: executable.sort() } : {}) };
  };
  if (source === 'none') return { label, source, files };

  const top = (await tryGit(projectDir, ['rev-parse', '--show-toplevel']))?.trim() || null;
  const prefix = top
    ? trimEndWhile(((await tryGit(projectDir, ['rev-parse', '--show-prefix'])) ?? '').trim(), (c) => c === '/')
    : '';

  if (source === 'working') {
    const root = top ?? projectDir;
    // The same files a commit of this folder would hold (tracked or new, also inside build/, dist/
    // or vendor/ folders), plus local files git ignores, as Claude Code reads those too.
    const paths = new Set<string>();
    const listed = top ? await tryGit(top, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']) : null;
    for (const p of (listed ?? '').split('\0')) if (p) paths.add(p);
    for (const f of walk(projectDir).files) paths.add(prefix ? `${prefix}/${f}` : f);
    for (const dir of ancestorsOf(prefix)) for (const f of ancestorFiles(root, dir, isSetupPath)) paths.add(f);
    // Folders under .claude/ that are links (.claude/skills -> ../agents/skills, or .claude itself):
    // Claude Code follows them, so the setup holds what is behind them when it stays in the repository.
    const claudeDirs = new Set<string>([
      prefix ? `${prefix}/.claude` : '.claude',
      ...ancestorsOf(prefix).map((d) => (d ? `${d}/.claude` : '.claude')),
    ]);
    for (const p of paths) {
      const m = /(^|\/)\.claude(?:\/|$)/.exec(p);
      if (m) claudeDirs.add(p.slice(0, m.index + m[1]!.length + '.claude'.length));
    }
    for (const d of claudeDirs)
      if (keyFor(`${d}/x.md`, prefix) !== null)
        for (const f of followLinkedFolders(root, d, warnings, keyFor(d, prefix, () => true) ?? d)) paths.add(f);

    for (const rootRel of [...paths].sort()) {
      const key = keyFor(rootRel, prefix);
      if (key === null) continue;
      const abs = join(root, rootRel);
      try {
        const st = statSync(abs); // follows a link to a file, as Claude Code does
        if (!st.isFile()) continue;
        if (st.size > MAX_SETUP_FILE) {
          warnings.push(
            `${key} is ${Math.round(st.size / 1024)} KB, over the 512 KB limit for one setup file, so it is left out. Make it smaller to test it.`,
          );
          continue;
        }
        const text = asText(readFileSync(abs));
        if (typeof text !== 'string') {
          warnings.push(`${key} is left out: ${text.why}.`);
          continue;
        }
        files[key] = text;
        if (process.platform !== 'win32' && st.mode & 0o111) executable.push(key);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue; // deleted while reading, or a broken link
        warnings.push(`${key} cannot be read (${code ?? (err as Error).message}), so it is left out.`);
      }
    }
    return done('working');
  }

  const resolved = (await tryGit(projectDir, ['rev-parse', '--verify', '--quiet', `${source}^{commit}`]))?.trim();
  if (!resolved || !top) {
    throw new UsageError(`Setup ${label}: "${source}" is not a branch, tag or commit in this repository.`, [
      'Use "working" for your current files, "none" for no instructions, or a git ref such as main, HEAD~3 or a commit hash.',
    ]);
  }
  // Every file in the commit, with its mode (links, executables) and size, paths from the root.
  const tree = new Map<string, { mode: string; type: string; oid: string; size: number; at?: string }>();
  const listing = await git(top, ['ls-tree', '-r', '-z', '-l', '--full-tree', resolved]);
  for (const entry of listing.split('\0')) {
    const m = /^(\d+) (\w+) ([0-9a-f]+) +(-|\d+)\t(.*)$/s.exec(entry);
    if (m) tree.set(m[5]!, { mode: m[1]!, type: m[2]!, oid: m[3]!, size: m[4] === '-' ? 0 : Number(m[4]) });
  }
  const at = `in ${source}`;
  // A link inside a .claude folder (or .claude itself) can point to a folder: .claude/skills -> ../agents/skills.
  const inClaudeTree = (p: string) => /(^|\/)\.claude(?:\/|$)/.test(p) && keyFor(`${p}/x.md`, prefix) !== null;
  // Link texts of every link that may matter, read in one git process (a .claude/ with many linked skills stays fast).
  const linkTexts = await blobs(top, [
    ...new Set(
      [...tree]
        .filter(([p, e]) => e.mode === '120000' && (inClaudeTree(p) || keyFor(p, prefix) !== null))
        .map(([, e]) => e.oid),
    ),
  ]);
  const linkTarget = async (
    path: string,
    oid: string,
  ): Promise<{ next: string; link: string } | { outside: string }> => {
    if (!linkTexts.has(oid)) for (const [k, v] of await blobs(top, [oid])) linkTexts.set(k, v); // a link to a link elsewhere
    const link = linkTexts.get(oid)?.toString('utf8') ?? '';
    const next = posix.normalize(posix.join(posix.dirname(path), link));
    return posix.isAbsolute(link) || next === '..' || next.startsWith('../') ? { outside: link } : { next, link };
  };
  /** Paths under a folder of the commit, found by binary search in the sorted list. */
  let sorted = [...tree.keys()].sort();
  const under = (dir: string): string[] => {
    const from = `${dir}/`;
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! < from) lo = mid + 1;
      else hi = mid;
    }
    const out: string[] = [];
    for (let i = lo; i < sorted.length && sorted[i]!.startsWith(from); i++) out.push(sorted[i]!);
    return out;
  };
  // The files behind a folder link count as if they were in the linked folder (links inside them resolve from where they really are).
  const followed = new Set<string>();
  for (let pass = 0; pass < 4; pass++) {
    let added = false;
    for (const [rootRel, entry] of [...tree]) {
      if (entry.mode !== '120000' || followed.has(rootRel) || !inClaudeTree(rootRel)) continue;
      const t = await linkTarget(entry.at ?? rootRel, entry.oid);
      if ('outside' in t) continue; // reported below, as a file left out
      const inside = under(t.next);
      if (!inside.length) continue; // a link to a file: handled below
      followed.add(rootRel);
      for (const p of inside) {
        const mapped = `${rootRel}/${p.slice(t.next.length + 1)}`;
        if (!tree.has(mapped)) {
          tree.set(mapped, { ...tree.get(p)!, at: tree.get(p)!.at ?? p });
          added = true;
        }
      }
    }
    if (!added) break;
    sorted = [...tree.keys()].sort();
  }
  const wanted = new Map<string, { key: string; oid: string; mode: string }>();
  for (const [rootRel, entry] of tree) {
    const key = keyFor(rootRel, prefix);
    if (key === null || entry.type !== 'blob' || followed.has(rootRel)) continue; // submodules are not setup files
    // A link (often CLAUDE.md -> AGENTS.md): use the content of the file it points to in that commit.
    let target = entry.at ?? rootRel;
    let e = entry;
    let problem: string | null = null;
    for (let hops = 0; e.mode === '120000' && !problem; hops++) {
      if (hops === 8) {
        problem = 'is a chain of links that does not end';
        break;
      }
      const t = await linkTarget(target, e.oid);
      if ('outside' in t) {
        problem = `is a link to ${t.outside}, outside the repository`;
      } else if (!tree.has(t.next)) {
        problem = under(t.next).length
          ? `is a link to a folder (${t.link}), which setupscore does not follow`
          : `is a link to ${t.link}, which is not in that commit`;
      } else {
        e = tree.get(t.next)!;
        target = e.at ?? t.next;
      }
    }
    if (problem) {
      warnings.push(`${key} ${at} ${problem}, so it is left out.`);
      continue;
    }
    if (e.size > MAX_SETUP_FILE) {
      warnings.push(
        `${key} ${at} is ${Math.round(e.size / 1024)} KB, over the 512 KB limit for one setup file, so it is left out. Make it smaller to test it.`,
      );
      continue;
    }
    wanted.set(rootRel, { key, oid: e.oid, mode: e.mode });
  }
  const contents = await blobs(top, [...new Set([...wanted.values()].map((w) => w.oid))]);
  for (const { key, oid, mode } of [...wanted.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    const buf = contents.get(oid);
    if (!buf) {
      warnings.push(`${key} ${at} cannot be read from git, so it is left out.`);
      continue;
    }
    const text = asText(buf);
    if (typeof text !== 'string') {
      warnings.push(`${key} ${at} is left out: ${text.why}.`);
      continue;
    }
    files[key] = text;
    if (mode === '100755') executable.push(key);
  }
  return done(`${source} (${resolved.slice(0, 7)})`);
}

/** Many blobs' contents in one git process. */
function blobs(cwd: string, oids: string[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  if (!oids.length) return Promise.resolve(out);
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.on('error', reject);
    child.stdin.on('error', () => {}); // git exited early; the close handler reports it
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`git cat-file exited with code ${code}`));
      const data = Buffer.concat(chunks);
      let pos = 0;
      for (const oid of oids) {
        const nl = data.indexOf(10, pos);
        if (nl < 0) break;
        const m = /^([0-9a-f]+) (\w+) (\d+)$/.exec(data.subarray(pos, nl).toString('utf8'));
        pos = nl + 1;
        if (!m) continue; // "<oid> missing"
        const size = Number(m[3]);
        out.set(oid, data.subarray(pos, pos + size));
        pos += size + 1;
      }
      resolve(out);
    });
    child.stdin.end(oids.map((o) => `${o}\n`).join(''));
  });
}

/** The git top level that holds this folder (the workspace clone), or the folder itself. */
function repoRootOf(dir: string): string {
  let d = dir;
  for (;;) {
    if (existsSync(join(d, '.git'))) return d;
    const up = dirname(d);
    if (up === d) return dir;
    d = up;
  }
}

/**
 * Write a file under `root` without following anything the commit planted: a link or a file in
 * place of a parent folder is replaced by a folder, and whatever is at the file's path is removed.
 */
function writeInside(root: string, rootRel: string, text: string, executable: boolean): void {
  const parts = rootRel.split('/');
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    dir = join(dir, part);
    const st = lstatSync(dir, { throwIfNoEntry: false });
    if (st && !st.isDirectory()) rmSync(dir, { recursive: true, force: true });
    if (!st || !st.isDirectory()) mkdirSync(dir);
  }
  const abs = join(root, ...parts);
  if (lstatSync(abs, { throwIfNoEntry: false })) rmSync(abs, { recursive: true, force: true });
  writeFileSync(abs, text, { flag: 'wx', mode: executable ? 0o755 : 0o644 });
  if (executable) chmodSync(abs, 0o755);
}

/**
 * Replace whatever setup the checked-out commit has with this one: every setup file of the
 * commit in the project folder, and in the folders above it up to the repository root, is
 * removed first (including skill files, hook scripts and personal files the commit may hold).
 */
export function applySetup(projectDir: string, setup: SetupSnapshot): void {
  const root = repoRootOf(projectDir);
  const rel = toPosix(relative(root, projectDir));
  const prefix = rel === '' || rel.startsWith('..') || isAbsolute(rel) ? '' : rel;
  const base = prefix ? join(root, prefix) : root;

  const old = listAll(base).map((f) => (prefix ? `${prefix}/${f}` : f));
  for (const dir of ancestorsOf(prefix)) old.push(...ancestorFiles(root, dir, isInstructionPath));
  const emptied = new Set<string>();
  for (const rootRel of old) {
    if (keyFor(rootRel, prefix, isInstructionPath) === null) continue;
    rmSync(join(root, ...rootRel.split('/')), { recursive: true, force: true });
    for (let d = posix.dirname(rootRel); d !== '.' && IN_CLAUDE_DIR.test(`${d}/`); d = posix.dirname(d)) emptied.add(d);
  }
  // Folders left empty under .claude/ (an old skill's folder) go too; deepest first.
  for (const d of [...emptied].sort((a, b) => b.length - a.length)) {
    try {
      rmdirSync(join(root, ...d.split('/')));
    } catch {
      // not empty
    }
  }

  const exec = new Set(setup.executable ?? []);
  for (const [key, text] of Object.entries(setup.files)) {
    const rootRel = posix.normalize(prefix ? `${prefix}/${key}` : key);
    // Only setup files, and only inside the repository, whatever run.json says.
    if (
      typeof text !== 'string' ||
      posix.isAbsolute(rootRel) ||
      rootRel === '..' ||
      rootRel.startsWith('../') ||
      !isSetupPath(rootRel)
    )
      continue;
    if (keyFor(rootRel, prefix) === null) continue;
    writeInside(root, rootRel, text, exec.has(key));
  }
}
