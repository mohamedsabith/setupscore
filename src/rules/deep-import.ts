import type { Context, Issue, Rule } from '../core/types.js';
import { MAX_IMPORT_HOPS } from './contexts.js';

/** Claude Code follows imports to a maximum depth of four hops (code.claude.com/docs/en/memory). */
const SAFE_DEPTH = MAX_IMPORT_HOPS;

export const deepImport: Rule = {
  id: 'deep-import',
  severity: 'warning',
  summary: 'An @import chain is so deep that Claude Code may stop following it.',
  why: 'Claude Code follows imports inside imports to a depth of four. Files past that never load.',
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
