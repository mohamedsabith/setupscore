import { posix } from 'node:path';
import { gitIgnored } from '../core/git.js';
import { dirOf, joinRel, normRel } from '../core/paths.js';
import { suggestPath, type PathSuggestion } from '../core/suggest.js';
import type { Context, Issue, Rule } from '../core/types.js';
import { DATE_PLACEHOLDER, pathMentions } from './path-mentions.js';
import { instructionFiles } from './util.js';

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

const DOMAIN = /^[\w-]+\.(?:com|org|net|io|dev|ai|co|app|me|sh|gg|so|xyz|cloud|in|uk|de|fr|jp|tech|info|biz)$/i;

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
      for (const { line: l, column, ref, path } of pathMentions(f)) {
        // A file name pattern (history/YYYY-MM.md) is not a file: file-name-pattern checks it.
        if (DATE_PLACEHOLDER.test(path)) continue;
        const backslashes = ref.includes('\\');
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
          if (s.safe && (relative || !to.startsWith('..'))) fix = { file: f.path, line: l.n, column, from: ref, to };
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
            column,
            message: `"${ref}" does not exist, so Claude cannot follow this.`,
            hint,
            fix,
          },
        });
      }
    }
    // Paths that .gitignore ignores are generated or local files (build output, reports): missing is normal.
    const ignored = gitIgnored(ctx.root, [...new Set(issues.map((i) => i.missing))]);
    return issues.filter((i) => !ignored.has(i.missing)).map((i) => i.issue);
  },
};
