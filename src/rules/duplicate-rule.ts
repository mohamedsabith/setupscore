import { normalizeRule, wordCount } from '../core/markdown.js';
import type { Context, Issue, Rule, SetupFile } from '../core/types.js';
import { loadContexts } from './contexts.js';
import { proseLines } from './util.js';

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
  // A line about the file itself ("This file provides guidance to Claude Code ...") is often copied on purpose.
  if (/\bthis (?:file|rule|document|guide)\b/i.test(t)) return true;
  if (/:(?:\*\*|__)?$/.test(t)) return true;
  if (!t.includes('](')) return false;
  return wordCount(withoutLinks(t).replace(/[-*+>#|]/g, ' ')) <= 2;
}

export const duplicateRule: Rule = {
  id: 'duplicate-rule',
  severity: 'warning',
  certainty: 'guess',
  summary: 'The same rule is written twice.',
  why: 'Every copy is sent to the model on every message. Duplicates also drift apart over time and turn into contradictions.',
  check(ctx: Context): Issue[] {
    const issues: Issue[] = [];
    const reported = new Set<string>();
    // Copies between files that only meet on demand: one finding per pair of files, with a count.
    const pairs = new Map<string, { issue: Issue; more: number; other: string }>();
    // The rules of each file, normalized once however many contexts the file is in.
    const keysOf = new Map<SetupFile, { n: number; key: string }[]>();
    const rulesOf = (f: SetupFile) => {
      let keys = keysOf.get(f);
      if (!keys) {
        keys = [];
        for (const l of proseLines(f)) {
          if (/^\s*[#|>]/.test(l.text) || notARule(l.text)) continue; // headings, tables, quotes, footers, lead-ins
          const key = normalizeRule(l.text);
          if (wordCount(key) >= MIN_WORDS) keys.push({ n: l.n, key });
        }
        keysOf.set(f, keys);
      }
      return keys;
    };
    // Standing instructions only: skills, agents and commands often repeat steps on purpose (summaries, checklists).
    const standing = (f: SetupFile) => !['skill', 'agent', 'command'].includes(f.kind);
    const contexts = loadContexts(ctx);
    // Where each rule of the start-up set is first written. Every other context is the start-up set
    // (or nothing) plus its own files, so only its own lines are read again (see loadContexts).
    const startFirst = new Map<string, { file: string; line: number }>();
    for (const context of contexts) {
      const isStart = context === contexts[0];
      const own = (isStart ? context.files : context.files.filter((f) => context.own.has(f))).filter(standing);
      const base: ReadonlyMap<string, { file: string; line: number }> =
        isStart || !context.files.some((f) => !context.own.has(f)) ? new Map() : startFirst;
      const first = isStart ? startFirst : new Map<string, { file: string; line: number }>();
      for (const f of own) {
        for (const { n, key } of rulesOf(f)) {
          const seen = base.get(key) ?? first.get(key);
          if (!seen) {
            first.set(key, { file: f.path, line: n });
            continue;
          }
          // Each copy is reported once, from the first context it is found in.
          if (reported.has(`${f.path}:${n}`)) continue;
          reported.add(`${f.path}:${n}`);
          const where = seen.file === f.path ? `line ${seen.line}` : `${seen.file}:${seen.line}`;
          const both = context.when && seen.file !== f.path ? ` (both load ${context.when})` : '';
          const pairKey = `${f.path}\0${seen.file}`;
          if (both) {
            const pair = pairs.get(pairKey);
            if (pair) {
              pair.more++;
              continue;
            }
          }
          const issue: Issue = {
            rule: 'duplicate-rule',
            severity: 'warning',
            file: f.path,
            line: n,
            message: `Same rule as ${where}${both}.`,
            hint: 'Delete one copy.',
          };
          issues.push(issue);
          if (both) pairs.set(pairKey, { issue, more: 0, other: seen.file });
        }
      }
    }
    for (const { issue, more, other } of pairs.values())
      if (more > 0)
        issue.message = `${issue.message.slice(0, -1)}, and ${more} more line${more === 1 ? '' : 's'} of this file repeat ${other}.`;
    return issues;
  },
};
