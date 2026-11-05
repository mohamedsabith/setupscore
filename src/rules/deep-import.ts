import type { Context, Issue, Rule } from '../core/types.js';

/** Sources disagree on whether Claude Code follows 4 or 5 hops, so warn from the 5th. */
const SAFE_DEPTH = 4;

export const deepImport: Rule = {
  id: 'deep-import',
  severity: 'warning',
  summary: 'An @import chain is so deep that Claude Code may stop following it.',
  why: 'Claude Code only follows a few levels of imports inside imports (4 to 5, depending on the version). Files past that never load.',
  check(ctx: Context): Issue[] {
    return ctx.imports
      .filter((i) => i.exists && i.depth > SAFE_DEPTH)
      .map((i) => ({
        rule: 'deep-import',
        severity: 'warning' as const,
        file: i.from,
        line: i.line,
        column: i.column,
        message: `@${i.raw} is ${i.depth} imports deep. Claude Code may stop before loading it.`,
        hint: 'Import it directly from CLAUDE.md, or flatten the chain.',
      }));
  },
};
