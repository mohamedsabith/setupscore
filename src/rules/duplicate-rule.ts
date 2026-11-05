import { normalizeRule, wordCount } from '../core/markdown.js';
import type { Context, Issue, Rule, SetupFile } from '../core/types.js';
import { instructionFiles, proseLines } from './util.js';

const MIN_WORDS = 4;

/** Text without its Markdown links: "Reference: [Engineering Blog](https://…)" -> "Reference:". */
const withoutLinks = (text: string): string => text.replace(/!?\[[^\]]{0,200}\]\([^)\s]{0,1000}\)/g, ' ');

/**
 * Lines that are not rules: a link footer ("Reference: [Blog](url)", "See [docs](url)") or a
 * lead-in that ends with a colon ("**Make it normal to challenge decisions:**"). Repeating
 * these in several files is normal.
 */
function notARule(text: string): boolean {
  const t = text.trim();
  if (/:(?:\*\*|__)?$/.test(t)) return true;
  if (!t.includes('](')) return false;
  return wordCount(withoutLinks(t).replace(/[-*+>#|]/g, ' ')) <= 2;
}

export const duplicateRule: Rule = {
  id: 'duplicate-rule',
  severity: 'warning',
  summary: 'The same rule is written twice.',
  why: 'Every copy is sent to the model on every message. Duplicates also drift apart over time and turn into contradictions.',
  check(ctx: Context): Issue[] {
    // Standing instructions only: skills, agents and commands often repeat steps on purpose (summaries, checklists).
    const files = instructionFiles(ctx).filter((f) => !['skill', 'agent', 'command'].includes(f.kind));
    // Everything loaded at start is one pool; every other file is checked on its own.
    const pools: SetupFile[][] = [
      files.filter((f) => f.loadsAtStart),
      ...files.filter((f) => !f.loadsAtStart).map((f) => [f]),
    ];
    const issues: Issue[] = [];
    for (const pool of pools) {
      const first = new Map<string, { file: string; line: number }>();
      for (const f of pool) {
        for (const l of proseLines(f)) {
          if (/^\s*(#|\||>)/.test(l.text) || notARule(l.text)) continue; // headings, tables, quotes, footers, lead-ins
          const key = normalizeRule(l.text);
          if (wordCount(key) < MIN_WORDS) continue;
          const seen = first.get(key);
          if (!seen) {
            first.set(key, { file: f.path, line: l.n });
            continue;
          }
          const where = seen.file === f.path ? `line ${seen.line}` : `${seen.file}:${seen.line}`;
          issues.push({
            rule: 'duplicate-rule',
            severity: 'warning',
            file: f.path,
            line: l.n,
            message: `Same rule as ${where}.`,
            hint: 'Delete one copy.',
          });
        }
      }
    }
    return issues;
  },
};
