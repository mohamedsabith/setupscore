import { readdirSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Folders that never hold a project's own setup and are slow to walk. */
export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.vercel',
  '.output',
  'vendor',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
  '.idea',
  '.terraform',
  'Pods',
  '.setupscore',
]);

export const MAX_FILES = 100_000;

export interface WalkResult {
  files: string[];
  truncated: boolean;
  /** Folders that could not be listed (no permission, I/O error), relative, forward slashes. */
  unreadable?: string[];
}

export interface WalkOptions {
  /**
   * Follow this folder symlink (relative path of the link). Only links whose target stays inside
   * the root are followed, and never one that points back up to a folder it is in (no loops).
   */
  followLink?: (rel: string) => boolean;
}

/** Folder symlinks that hold Claude Code setup: `.claude` itself, or anything inside a `.claude/` folder. */
export const isSetupLink = (rel: string): boolean => rel.split('/').includes('.claude');

/**
 * List every file under `root` as forward-slash relative paths.
 * Skips dependency and build folders. Folder symlinks are followed only when `followLink` allows
 * it and the target stays inside the root (repos often link .claude/skills to a shared folder).
 */
export function walk(
  root: string,
  skip: (rel: string) => boolean = () => false,
  options: WalkOptions = {},
): WalkResult {
  const files: string[] = [];
  const unreadable: string[] = [];
  let truncated = false;
  const stack: string[] = [''];
  let realRoot: string | undefined;
  const inside = (real: string, base: string) => {
    const r = relative(base, real);
    return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !r.startsWith(sep) && !/^[A-Za-z]:/.test(r));
  };
  /** True when a folder link may be followed: target inside the root, and not a folder that contains the link. */
  let followed = 0;
  const mayFollow = (childRel: string): boolean => {
    if (!options.followLink?.(childRel)) return false;
    // Links that point at each other (a -> b, b -> a) are not loops on their own; a depth and count limit stops them.
    if (followed >= 500 || childRel.split('/').length > 24) return false;
    try {
      realRoot ??= realpathSync(root);
      const target = realpathSync(join(root, childRel));
      const parent = realpathSync(join(root, childRel, '..'));
      if (!inside(target, realRoot) || inside(parent, target)) return false;
      followed++;
      return true;
    } catch {
      return false;
    }
  };

  while (stack.length > 0) {
    const rel = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch (err) {
      // The project folder itself must be readable: anything else would look like "no setup found".
      if (rel === '') throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') unreadable.push(rel); // deleted while walking is fine
      continue;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !skip(childRel + '/')) stack.push(childRel);
        continue;
      }
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try {
          const st = statSync(join(root, childRel));
          isFile = st.isFile();
          if (st.isDirectory()) {
            if (!SKIP_DIRS.has(e.name) && !skip(childRel + '/') && mayFollow(childRel)) stack.push(childRel);
            continue;
          }
        } catch {
          isFile = false; // broken link
        }
      }
      // FIFOs, sockets and devices are never setup files, and reading one could block forever.
      if (!isFile || skip(childRel)) continue;
      files.push(childRel);
      if (files.length >= MAX_FILES) {
        truncated = true;
        return { files: files.sort(), truncated, unreadable };
      }
    }
  }
  return { files: files.sort(), truncated, unreadable };
}

/**
 * Check that a path inside `root` exists with exactly this spelling, by comparing real folder
 * entries. On macOS and Windows the disk ignores letter case, so `existsSync("src/Utils.ts")` is
 * true for src/utils.ts; Claude Code on Linux (and CI) would not find it. Unicode composed and
 * decomposed forms (NFC/NFD) count as the same name, as on macOS.
 * Returns 'file', 'dir' or null. Results are cached for one check.
 */
export function exactLookup(root: string): (rel: string) => 'file' | 'dir' | null {
  const listings = new Map<string, Map<string, Dirent> | null>();
  const list = (dirRel: string): Map<string, Dirent> | null => {
    if (listings.has(dirRel)) return listings.get(dirRel)!;
    let out: Map<string, Dirent> | null = null;
    try {
      out = new Map();
      for (const e of readdirSync(join(root, dirRel), { withFileTypes: true })) out.set(e.name.normalize('NFC'), e);
    } catch {
      out = null;
    }
    listings.set(dirRel, out);
    return out;
  };
  return (rel: string) => {
    if (!rel || rel.startsWith('../') || rel === '..') return null;
    const parts = rel.split('/').filter((p) => p !== '' && p !== '.');
    let dir = '';
    for (let i = 0; i < parts.length; i++) {
      const entries = list(dir);
      const e = entries?.get(parts[i]!.normalize('NFC'));
      if (!e) return null;
      const childRel = dir ? `${dir}/${e.name}` : e.name;
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try {
          const st = statSync(join(root, childRel));
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          return null; // broken link
        }
      }
      if (i === parts.length - 1) return isDir ? 'dir' : isFile ? 'file' : null;
      if (!isDir) return null;
      dir = childRel;
    }
    return parts.length === 0 ? 'dir' : null;
  };
}
