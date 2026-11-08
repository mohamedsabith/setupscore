import picomatch from 'picomatch';
import { CLAUDE_IMPORT_HOPS } from '../core/discover.js';
import { dirOf } from '../core/paths.js';
import type { Context, SetupFile } from '../core/types.js';
import { instructionFiles } from './util.js';

/** Claude Code follows imports "with a maximum depth of four hops" (code.claude.com/docs/en/memory). */
export const MAX_IMPORT_HOPS = CLAUDE_IMPORT_HOPS;

/** Split "a/**, b/*.{ts,tsx}" on commas that are not inside {braces}. */
function splitPatterns(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '{') depth++;
    if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** `paths:` may be a list or a comma-separated string. */
export const toPatterns = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' ? splitPatterns(v) : [])
    .filter((p): p is string => typeof p === 'string')
    .map((p) => p.trim().replace(/^\.\//, ''))
    .filter(Boolean);

/**
 * A `paths:` pattern of a rule whose base folder is `root` ("" or "pkg/"), read the way Claude Code
 * reads it, like .gitignore: one without a slash ("*.md") matches a file name at any depth, a leading
 * slash ("/*.md") anchors it to the base folder, and any other slash anchors it too ("src/*.ts").
 * `base` is the fixed folder every match is under ("" or "src/"). Null when picomatch cannot read it.
 */
export function compilePathPattern(
  root: string,
  pattern: string,
): { base: string; match: (p: string) => boolean } | null {
  try {
    const anywhere = !pattern.includes('/');
    const glob = root + pattern.replace(/^\/+/, '');
    let base = root.replace(/\/$/, '');
    if (!anywhere) {
      const scan = picomatch.scan(glob);
      base = scan.isGlob ? scan.base : glob.slice(0, Math.max(0, glob.lastIndexOf('/')));
    }
    if (base.includes('\\')) base = ''; // escaped characters: test every file
    const prefix = base ? `${base}/` : '';
    const match = anywhere
      ? (() => {
          const m = picomatch(pattern, { dot: true, basename: true });
          return (p: string) => p.startsWith(root) && m(p.slice(root.length));
        })()
      : picomatch(glob, { dot: true });
    return { base: prefix, match };
  } catch {
    return null;
  }
}

/** One set of instruction files that are in front of Claude at the same time. */
export interface LoadContext {
  files: SetupFile[];
  /**
   * The files this context adds to the start-up set. Report a pair only when one side is here:
   * pairs inside the start-up set belong to the start-up context, so they are reported once.
   */
  own: ReadonlySet<SetupFile>;
  /** When these files meet, for messages: "when Claude works in packages/api/". Empty for the start-up set. */
  when: string;
}

/**
 * The folder a nested CLAUDE.md or rules file is about, as "pkg/" ("" for the root): pkg/.claude/CLAUDE.md
 * and pkg/.claude/rules/x.md are about pkg/; any other CLAUDE.md (also one inside .claude/skills/x/) is
 * about its own folder.
 */
const folderOf = (f: SetupFile): string => {
  const parts = f.path.split('/');
  const at = parts.indexOf('.claude');
  const forParent =
    at >= 0 &&
    (parts[at + 1] === 'rules' || (parts.length === at + 2 && /^CLAUDE(?:\.local)?\.md$/.test(parts[at + 1]!)));
  const dir = forParent ? parts.slice(0, at).join('/') : dirOf(f.path);
  return dir ? `${dir}/` : '';
};

/** A skill's name is its folder: .claude/skills/deploy/SKILL.md -> "deploy". A command's is its file name. */
const nameOf = (f: SetupFile): string => {
  const parts = f.path.split('/');
  return f.kind === 'skill' ? parts[parts.length - 2]! : parts[parts.length - 1]!.replace(/\.md$/i, '');
};

/**
 * The sets of instruction files Claude has in front of it together (code.claude.com/docs/en/memory):
 * - at start-up: the root CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md, rules without `paths:`, and their imports;
 * - when Claude works on a file: also every CLAUDE.md, CLAUDE.local.md and unscoped rule in the folders
 *   above it (they load on demand), and every `paths:` rule that matches it;
 * - when a skill or command runs: its body; in a subagent: its body and its `skills:`, plus the
 *   start-up set unless it sets `omitClaudeMd: true` (code.claude.com/docs/en/sub-agents).
 * Files are added together, never overridden. Imports past four hops never load, so they are left out.
 * A file that is in none of these sets (a `paths:` rule that matches nothing) is checked on its own.
 */
export function loadContexts(ctx: Context): LoadContext[] {
  const files = instructionFiles(ctx).filter((f) => !(f.kind === 'import' && (f.importDepth ?? 0) > MAX_IMPORT_HOPS));
  // The imports of each file, all the way down.
  const children = new Map<string, SetupFile[]>();
  for (const f of files) if (f.importedBy) children.set(f.importedBy, [...(children.get(f.importedBy) ?? []), f]);
  const withImports = (list: SetupFile[]): SetupFile[] => {
    const out = new Set<SetupFile>();
    const queue = [...list];
    while (queue.length) {
      const f = queue.shift()!;
      if (out.has(f)) continue;
      out.add(f);
      queue.push(...(children.get(f.path) ?? []));
    }
    return [...out];
  };

  const start = files.filter((f) => f.loadsAtStart);
  const contexts: LoadContext[] = [{ files: start, own: new Set(start), when: '' }];
  const covered = new Set<SetupFile>(start);
  const add = (lazy: SetupFile[], extra: SetupFile[], when: string) => {
    const own = withImports(lazy).filter((f) => !start.includes(f));
    if (own.length === 0) return;
    own.forEach((f) => covered.add(f));
    contexts.push({ files: [...new Set([...extra, ...own])], own: new Set(own), when });
  };

  // Files that load when Claude works in a folder, and rules that load for matching files.
  const onDemand = files.filter(
    (f) =>
      !f.loadsAtStart &&
      (f.kind === 'claude-md' ||
        f.kind === 'claude-local-md' ||
        (f.kind === 'rule' && toPatterns(f.frontmatter?.data?.['paths']).length === 0)),
  );
  const scoped = files
    .filter((f) => f.kind === 'rule' && toPatterns(f.frontmatter?.data?.['paths']).length > 0)
    .map((f) => {
      const root = f.path.slice(0, f.path.indexOf('.claude/rules/'));
      const patterns = toPatterns(f.frontmatter?.data?.['paths'])
        .map((p) => compilePathPattern(root, p))
        .filter((p) => p !== null);
      return { file: f, patterns };
    });
  if (onDemand.length || scoped.length) {
    const chainCache = new Map<string, SetupFile[]>();
    const chain = (dir: string): SetupFile[] => {
      let c = chainCache.get(dir);
      if (!c) {
        const here = dir ? `${dir}/` : '';
        c = onDemand.filter((f) => here.startsWith(folderOf(f)));
        chainCache.set(dir, c);
      }
      return c;
    };
    // Paths with the same files in front of Claude form one context: thousands of paths, a handful of sets.
    const seen = new Map<string, { lazy: SetupFile[]; when: string }>();
    const visit = (path: string, dir: string) => {
      const rules = scoped
        .filter((s) => s.patterns.some((p) => path.startsWith(p.base) && p.match(path)))
        .map((s) => s.file);
      const lazy = [...chain(dir), ...rules];
      if (lazy.length === 0) return;
      const key = lazy.map((f) => f.path).join('\0');
      if (!seen.has(key))
        seen.set(key, {
          lazy,
          when: rules.length ? `when Claude works on ${path}` : `when Claude works in ${dir || '.'}/`,
        });
    };
    if (scoped.length === 0) {
      for (const dir of [...new Set(ctx.repoFiles().map(dirOf))].sort()) visit(`${dir}/`, dir);
    } else {
      // Name a project file in messages rather than one inside .claude/ when both give the same set.
      const inClaude = (p: string) => p.startsWith('.claude/') || p.includes('/.claude/');
      const paths = [...ctx.repoFiles()].sort();
      for (const path of [...paths.filter((p) => !inClaude(p)), ...paths.filter(inClaude)])
        visit(path.normalize('NFC'), dirOf(path));
    }
    for (const { lazy, when } of seen.values()) add(lazy, start, when);
  }

  for (const f of files.filter((f) => f.kind === 'skill' || f.kind === 'command'))
    add([f], start, `when /${nameOf(f)} runs`);
  for (const f of files.filter((f) => f.kind === 'agent')) {
    const fm = f.frontmatter?.data;
    const wanted = Array.isArray(fm?.['skills']) ? fm['skills'].filter((s) => typeof s === 'string') : [];
    const skills = files.filter((s) => s.kind === 'skill' && wanted.includes(nameOf(s)));
    const name = typeof fm?.['name'] === 'string' ? fm['name'] : nameOf(f);
    add([f, ...skills], fm?.['omitClaudeMd'] === true ? [] : start, `in the ${name} subagent`);
  }
  // A file that never meets the others (a paths: rule that matches nothing) is still checked on its own.
  for (const f of files) if (!covered.has(f)) contexts.push({ files: [f], own: new Set([f]), when: '' });
  return contexts;
}
