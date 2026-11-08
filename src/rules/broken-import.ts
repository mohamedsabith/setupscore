import { posix } from 'node:path';
import { dirOf } from '../core/paths.js';
import { suggestPath } from '../core/suggest.js';
import type { Context, Issue, Rule } from '../core/types.js';

export const brokenImport: Rule = {
  id: 'broken-import',
  severity: 'error',
  certainty: 'sure',
  summary: 'An @path import in CLAUDE.md points to a file that does not exist.',
  why: 'Claude Code silently skips imports it cannot find, so whatever that file was meant to teach Claude never reaches it.',
  check(ctx: Context): Issue[] {
    const issues: Issue[] = [];
    for (const i of ctx.imports) {
      const backslashes = i.raw.includes('\\');
      if (i.exists && !backslashes) continue;
      const base = { rule: 'broken-import', severity: 'error' as const, file: i.from, line: i.line, column: i.column };
      if (i.exists) {
        // The file is there, but only Windows reads "\" as a folder separator.
        const to = i.raw.replaceAll('\\', '/');
        issues.push({
          ...base,
          message: `@${i.raw} uses backslashes. On macOS and Linux Claude Code reads them as part of the file name, so this import only works on Windows.`,
          hint: `Write @${to} instead: forward slashes work everywhere.`,
          fix: { file: i.from, line: i.line, column: i.column, from: `@${i.raw}`, to: `@${to}` },
        });
        continue;
      }
      const fileDir = dirOf(i.from);
      const inside = !i.target.startsWith('../');
      const s = inside ? suggestPath(ctx, i.target) : undefined;
      let fix: Issue['fix'];
      let hint = `Imports are resolved from the folder of ${i.from}. Fix the path or remove the import.`;
      if (s) {
        let to = posix.relative(fileDir || '.', s.path);
        if (/^\.{1,2}[/\\]/.test(i.raw) && !to.startsWith('.')) to = `./${to}`;
        hint =
          s.reason === 'renamed'
            ? `It was renamed to ${s.path} (git history).`
            : s.reason === 'moved'
              ? `It looks like it moved to ${s.path}.`
              : s.reason === 'case'
                ? `The file is ${s.path}: only the letter case differs. That works on macOS and Windows, but not on Linux.`
                : `Did you mean @${to}?`;
        if (s.safe) fix = { file: i.from, line: i.line, column: i.column, from: `@${i.raw}`, to: `@${to}` };
      }
      issues.push({
        ...base,
        message: `@${i.raw} imports a file that does not exist (${i.target}).`,
        hint,
        fix,
      });
    }
    return issues;
  },
};
