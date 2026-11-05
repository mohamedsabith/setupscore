import picomatch from 'picomatch';
import type { Context, Issue, Rule } from '../core/types.js';
import { SKIP_DIRS } from '../core/walk.js';
import { quote } from './util.js';

/** A glob longer than this cannot be a real path (picomatch refuses over 65,536 characters). */
const MAX_PATTERN = 4096;

/** The index of the first file >= prefix in a sorted list. */
function lowerBound(files: readonly string[], prefix: string): number {
  let lo = 0;
  let hi = files.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (files[mid]! < prefix) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

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
const toPatterns = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' ? splitPatterns(v) : [])
    .filter((p): p is string => typeof p === 'string')
    .map((p) => p.trim().replace(/^\.\//, ''))
    .filter(Boolean);

export const unusedPathRule: Rule = {
  id: 'unused-path-rule',
  severity: 'warning',
  summary: 'A file in .claude/rules/ has "paths:" that match no file, so it never loads.',
  why: 'Path-scoped rules only load when Claude touches a matching file. If nothing matches, often after a folder was renamed, the rule is dead.',
  check(ctx: Context): Issue[] {
    const issues: Issue[] = [];
    // Compare names in composed Unicode form: macOS may store "café" decomposed (NFD) on disk.
    const files = ctx.repoFiles().map((f) => f.normalize('NFC'));
    const sorted = files.every((p, i) => i === 0 || files[i - 1]! <= p) ? files : [...files].sort();
    const compiled = new Map<string, { base: string; match: (p: string) => boolean } | null>();
    /** True when some file matches the glob. Only files under the glob's fixed folder are tested. */
    const anyMatch = (glob: string): boolean => {
      let c = compiled.get(glob);
      if (c === undefined) {
        try {
          const scan = picomatch.scan(glob);
          let base = scan.isGlob ? scan.base : glob.slice(0, Math.max(0, glob.lastIndexOf('/')));
          if (base.includes('\\')) base = ''; // escaped characters: test every file
          c = { base: base ? `${base}/` : '', match: picomatch(glob, { dot: true }) };
        } catch {
          c = null; // not a glob picomatch can read: cannot check it
        }
        compiled.set(glob, c);
      }
      if (c === null) return true;
      for (let i = lowerBound(sorted, c.base); i < sorted.length && sorted[i]!.startsWith(c.base); i++) {
        if (c.match(sorted[i]!)) return true;
      }
      return false;
    };
    for (const f of ctx.files.filter((f) => f.kind === 'rule')) {
      const patterns = toPatterns(f.frontmatter?.data?.paths);
      if (patterns.length === 0 || patterns.some((p) => p.length > MAX_PATTERN)) continue;
      // Folders we do not walk (node_modules, dist, ...) cannot be checked.
      if (patterns.some((p) => SKIP_DIRS.has(p.split('/')[0]!))) continue;
      // Rules in pkg/.claude/rules/ are relative to pkg/.
      const base = f.path.slice(0, f.path.indexOf('.claude/rules/'));
      if (patterns.some((p) => anyMatch((base + p).normalize('NFC')))) continue;
      const line = f.lines.find((l) => l.inFrontmatter && /^\s*paths\s*:/.test(l.text))?.n ?? 1;
      const shown =
        patterns
          .slice(0, 5)
          .map((p) => quote(p, 60))
          .join(', ') + (patterns.length > 5 ? ` and ${patterns.length - 5} more` : '');
      issues.push({
        rule: 'unused-path-rule',
        severity: 'warning',
        file: f.path,
        line,
        message: `No file matches paths ${shown}, so this rule never loads.`,
        hint: 'Update the patterns to the current folder names.',
      });
    }
    return issues;
  },
};
