import { posix } from 'node:path';
import { gitIgnored } from '../core/git.js';
import { MAX_LINE } from '../core/markdown.js';
import { dirOf, joinRel, normRel } from '../core/paths.js';
import { suggestPath, type PathSuggestion } from '../core/suggest.js';
import type { Context, Issue, Rule } from '../core/types.js';
import { instructionFiles } from './util.js';

/** Letters and digits of any language, and `_`. */
const W = String.raw`\p{L}\p{M}\p{N}_`;
/** A folder separator: `/`, or `\` (Windows) when a name follows it. A `\` before punctuation is a Markdown escape. */
const SEP = String.raw`(?:\/|\\(?=[\p{L}\p{N}]))`;

/**
 * A path with at least one folder and a file extension: src/app.ts, ./docs/guide.md, ../shared/x.json,
 * .github/workflows/ci.yml, docs/menü.md, src\utils\old.ts.
 * The look-behind skips URLs, @imports, absolute paths and paths glued to other words.
 */
// eslint-disable-next-line security/detect-non-literal-regexp -- built from the fixed W and SEP character classes
const PATH = new RegExp(
  String.raw`(?<![${W}@$/.~\\:-])((?:\.{1,2}${SEP})*(?:\.?[${W}-][${W}.@-]*${SEP})+[${W}@-][${W}.@-]*\.[A-Za-z][A-Za-z0-9]{0,9})(?![${W}/\\{<$[-]|\.[${W}{<$[])`,
  'gu',
);

/** "e.g. src/x.ts", "for example docs/a.md", "files like a/b.ts": an example, not a real reference. */
const EXAMPLE_BEFORE =
  /(?:\be\.\s?g\.|\beg\.|\bi\.\s?e\.|\bfor example\b|\bfor instance\b|\bsuch as\b|\blike\b)[^.;!?]{0,80}$/i;

/** Folders that only exist after a build or install, or only on one machine, so a missing path there is normal. */
const GENERATED = new Set([
  'dist',
  'build',
  'out',
  'coverage',
  'node_modules',
  '.next',
  'tmp',
  'target',
  'logs',
  '.turbo',
  '.git',
  '.cache',
]);

/** Folders that always belong to the project, even before they exist. */
const PROJECT_DIRS = new Set(['.claude']);

/** Files that are personal and usually not committed, so they are often missing in a fresh clone. */
const LOCAL_ONLY = /(?:^|\/)[^/]*\.local(?:\.[^/]*)?$/;

const DOMAIN = /^[\w-]+\.(?:com|org|net|io|dev|ai|co|app|me|sh|gg|so|xyz|cloud|in|uk|de|fr|jp|tech|info|biz)$/i;

/** Example paths written to show a shape, not a real file: path/to/x.ts, src/foo/bar.ts, your-file.ts. */
const PLACEHOLDER =
  /(?:^|\/)(?:path\/to|to\/your|foo|bar|baz|qux|xxx+|your[-_][\w-]*|some[-_][\w-]*|my[-_]?(?:file|component|feature|module|test|page|thing)|example|placeholder)(?:\/|\.|$)/i;

const SPACE_BEFORE = /[\s([*]/;
const SPACE_AFTER = /[\s.,;:!?)\]*]/;

/** Turn `_italic text_` markers into spaces (positions kept), so a path in italics is still found. */
function stripItalics(text: string): string {
  if (!text.includes('_')) return text;
  const openers: number[] = [];
  const closers: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '_') continue;
    const prev = text[i - 1];
    const next = text[i + 1];
    if ((prev === undefined || SPACE_BEFORE.test(prev)) && next !== undefined && !/[\s_]/.test(next)) openers.push(i);
    if (prev !== undefined && !/[\s_]/.test(prev) && (next === undefined || SPACE_AFTER.test(next))) closers.push(i);
  }
  if (openers.length === 0 || closers.length === 0) return text;
  const chars = text.split('');
  let c = 0;
  let lastClose = -1;
  for (const o of openers) {
    if (o <= lastClose) continue;
    while (c < closers.length && closers[c]! <= o) c++;
    if (c >= closers.length) break;
    chars[o] = ' ';
    chars[closers[c]!] = ' ';
    lastClose = closers[c]!;
    c++;
  }
  return chars.join('');
}

function hintFor(s: PathSuggestion): string {
  switch (s.reason) {
    case 'renamed':
      return `It was renamed to ${s.path} (git history).`;
    case 'moved':
      return `It looks like it moved to ${s.path}.`;
    case 'case':
      return `The file is ${s.path}: only the letter case differs. That works on macOS and Windows, but not on Linux, where CI and many Claude Code sessions run.`;
    default:
      return `Did you mean ${s.path}?`;
  }
}

export const brokenReference: Rule = {
  id: 'broken-reference',
  severity: 'error',
  summary: 'A file path in your instructions points to a file that does not exist.',
  why: 'Claude looks for the file, finds nothing, and has to guess. Old paths are the most common way instructions rot after a refactor.',
  check(ctx: Context): Issue[] {
    const issues: { issue: Issue; missing: string }[] = [];
    for (const f of instructionFiles(ctx)) {
      const fileDir = dirOf(f.path);
      // A file reached through a folder link: relative paths may be written from where it really is.
      const realDir = f.realPath !== undefined ? dirOf(f.realPath) : undefined;
      for (const l of f.lines) {
        if (l.inFence || l.inFrontmatter || l.text.length > MAX_LINE) continue;
        for (const m of stripItalics(l.text).matchAll(PATH)) {
          const ref = m[1]!;
          const backslashes = ref.includes('\\');
          const path = backslashes ? ref.replaceAll('\\', '/') : ref;

          if (PLACEHOLDER.test(path) || LOCAL_ONLY.test(path)) continue;
          if (EXAMPLE_BEFORE.test(l.text.slice(Math.max(0, m.index - 100), m.index))) continue;
          const relative = /^\.{1,2}\//.test(path);
          const first = normRel(path).split('/')[0]!;
          if (!relative && (GENERATED.has(first) || DOMAIN.test(first))) continue;

          const fromRoot = normRel(path);
          const fromFile = joinRel(fileDir, path);
          if (ctx.existsRel(fromRoot) || ctx.existsRel(fromFile)) continue;
          if (realDir !== undefined && ctx.existsRel(joinRel(realDir, path))) continue;

          // Only flag paths that clearly point into this project, to avoid false alarms on
          // package paths, examples or other repositories.
          const firstFromFile = fromFile.split('/')[0]!;
          const inRootDir = ctx.isDir(first) || PROJECT_DIRS.has(first);
          const inFileDir = fileDir !== '' && ctx.isDir(joinRel(fileDir, first));
          if (!relative && !inRootDir && !inFileDir) continue;
          if (relative && firstFromFile.startsWith('..')) continue; // points outside the project

          // A nested CLAUDE.md usually means its own folder: packages/api/CLAUDE.md saying src/x.ts means packages/api/src/x.ts.
          const base = relative || inFileDir ? fileDir : '';
          const missing = base ? fromFile : fromRoot;
          const s = suggestPath(ctx, missing);
          let hint: string;
          let fix: Issue['fix'];
          if (s) {
            let to = s.path;
            if (relative) {
              to = posix.relative(fileDir || '.', s.path);
              if (!to.startsWith('.')) to = `./${to}`;
            } else if (base) to = posix.relative(base, s.path);
            hint = hintFor(s);
            if (backslashes) to = to.replaceAll('/', '\\');
            // A path written from the project root must stay inside it.
            if (s.safe && (relative || !to.startsWith('..')))
              fix = { file: f.path, line: l.n, column: m.index + 1, from: ref, to };
          } else {
            hint = 'Update the path, or delete the line if the file is gone for good.';
          }
          issues.push({
            missing,
            issue: {
              rule: 'broken-reference',
              severity: 'error',
              file: f.path,
              line: l.n,
              column: m.index + 1,
              message: `"${ref}" does not exist, so Claude cannot follow this.`,
              hint,
              fix,
            },
          });
        }
      }
    }
    // Paths that .gitignore ignores are generated or local files (build output, reports): missing is normal.
    const ignored = gitIgnored(ctx.root, [...new Set(issues.map((i) => i.missing))]);
    return issues.filter((i) => !ignored.has(i.missing)).map((i) => i.issue);
  },
};
