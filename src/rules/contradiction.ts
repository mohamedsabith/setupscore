import { isListItem, ruleText } from '../core/markdown.js';
import type { Context, Issue, Line, Rule, SetupFile } from '../core/types.js';
import { instructionFiles, proseLines, quote } from './util.js';

const VERBS =
  'use|using|write|writing|call|calling|add|adding|import|importing|create|creating|run|running|install|installing';
const NEGATIVE = new RegExp(
  // Names are often written as code: "never use `npm`". The backticks are dropped from the subject.
  `\\b(?:never|don't|do not|dont|avoid|stop|no longer)\\s+(?:${VERBS})\\s+((?:the\\s+|a\\s+|an\\s+)?[\\w.+#@/\`-]+(?:\\s+[\\w.+#@/\`-]+){0,2})`,
  'i',
);
const NEGATION_WORDS = /\b(?:never|not|don't|dont|do not|avoid|no longer|instead of|rather than|except|unless|stop)\b/i;
const STOP = new Set([
  'the',
  'a',
  'an',
  'in',
  'on',
  'for',
  'to',
  'of',
  'and',
  'or',
  'with',
  'when',
  'because',
  'any',
  'it',
  'this',
  'that',
  'them',
  'these',
  'those',
  'here',
  'there',
  'anything',
  'everything',
]);
/** Words that limit where a rule applies: "never run migrations in production". */
const SCOPE = new Set([
  'in',
  'on',
  'for',
  'to',
  'of',
  'with',
  'when',
  'inside',
  'outside',
  'during',
  'from',
  'within',
  'without',
  'before',
  'after',
  'unless',
  'except',
  'while',
  'at',
  'under',
  'against',
  'into',
  'directly',
]);
const FILLER = new Set([...STOP, 'any', 'all', 'our', 'your', 'its', 'their', 'code', 'files', 'file']);
const TRAILING = new Set('.,;:!?)');

/** Drop punctuation at the end of a word, in linear time. */
function trimPunct(w: string): string {
  let e = w.length;
  while (e > 0 && TRAILING.has(w[e - 1]!)) e--;
  return w.slice(0, e);
}

/**
 * "write raw SQL in reports" -> subject "raw sql", scope ["reports"].
 * The subject drops articles and stops at the first stop word; what follows a scope word is the scope.
 */
function subject(phrase: string, rest: string): { subject: string; scope: string[] } | null {
  const words = phrase.replaceAll('`', '').toLowerCase().split(/\s+/).map(trimPunct).filter(Boolean);
  while (words.length && STOP.has(words[0]!)) words.shift();
  const out: string[] = [];
  let k = 0;
  for (; k < words.length; k++) {
    if (STOP.has(words[k]!)) break;
    out.push(words[k]!);
  }
  const s = out.join(' ').trim();
  if (s.length < 3) return null;
  // The scope: content words after "in", "on", "for" ... in the rest of the rule.
  const after = [
    ...words.slice(k),
    ...rest.replaceAll('`', '').toLowerCase().split(/\s+/).map(trimPunct).filter(Boolean),
  ].slice(0, 12);
  const scope: string[] = [];
  if (after.length && SCOPE.has(after[0]!)) {
    for (const w of after.slice(1)) {
      if (w === 'and' || w === 'or' || w === 'because' || w === 'but') break;
      if (!FILLER.has(w) && w.length >= 3) scope.push(w);
    }
  }
  return { subject: s, scope };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A heading over a list of what not to do: "Common mistakes", "Anti-patterns", "Avoid". */
const DONT_HEADING = /\b(?:mistakes?|anti-?patterns?|pitfalls?|avoid|don't|do not|never|wrong|bad)\b/i;
/** A list item marked as a bad example: "❌ ...", "Bad: ...", "Wrong: ...". */
const BAD_EXAMPLE = /^(?:\W*[❌🚫⛔✗✘]|\s*\**(?:bad|wrong|incorrect)\b)/iu;

/** Each line number of a file -> the text of the heading it is under. */
function headings(file: SetupFile): Map<number, string> {
  const out = new Map<number, string>();
  let current = '';
  for (const l of file.lines) {
    if (!l.inFence && !l.inFrontmatter && /^#{1,6}\s/.test(l.text)) current = l.text;
    out.set(l.n, current);
  }
  return out;
}

interface RuleLine {
  file: SetupFile;
  line: Line;
  text: string;
  /** Under a "mistakes" heading or marked ❌: it shows what not to do. */
  bad: boolean;
}

export const contradiction: Rule = {
  id: 'contradiction',
  severity: 'warning',
  summary: 'Two rules seem to say opposite things, like "never write raw SQL" and "use raw SQL for reports".',
  why: 'When rules conflict Claude has to guess which one wins, and it will not guess the same way every time.',
  check(ctx: Context): Issue[] {
    // Compare rules that are in front of Claude together: everything loaded at start, and each other file on its own.
    const groups: SetupFile[][] = [];
    const files = instructionFiles(ctx);
    groups.push(files.filter((f) => f.loadsAtStart));
    for (const f of files.filter((f) => !f.loadsAtStart)) groups.push([f]);

    const issues: Issue[] = [];
    for (const group of groups) {
      // Only list items: rules are written as lists, and wrapped prose paragraphs give false matches.
      const rules: RuleLine[] = group.flatMap((file) => {
        const under = headings(file);
        return proseLines(file)
          .filter((line) => isListItem(line.text))
          .map((line) => {
            const text = ruleText(line.text);
            return { file, line, text, bad: BAD_EXAMPLE.test(text) || DONT_HEADING.test(under.get(line.n) ?? '') };
          });
      });
      // A bad example is not an instruction to do it.
      const positives = rules
        .filter((r) => !r.bad && !NEGATION_WORDS.test(r.text))
        .map((r) => ({ ...r, lower: r.text.toLowerCase() }));
      // Word -> the positive rules that contain it, so each subject only looks at a few candidates.
      const byWord = new Map<string, typeof positives>();
      for (const pos of positives) {
        for (const w of new Set(pos.lower.split(/[^\w.+#@/-]+/).map(trimPunct))) {
          if (!w) continue;
          const list = byWord.get(w);
          if (list) list.push(pos);
          else byWord.set(w, [pos]);
        }
      }
      // One report per forbidden subject: 400 copies of "never use X" against 400 of "use X" is one problem.
      const bySubject = new Map<string, { neg: RuleLine; scope: string[]; others: number }>();
      for (const neg of rules) {
        const m = neg.text.match(NEGATIVE);
        if (!m) continue;
        // An open code span: the name goes on past the words read ("never run `npm exec nx build`"), so it is cut short.
        if ((m[1]!.split('`').length - 1) % 2 === 1) continue;
        const s = subject(m[1]!, neg.text.slice(m.index! + m[0].length));
        if (!s) continue;
        const key = `${s.subject}|${s.scope.join(' ')}`;
        const seen = bySubject.get(key);
        if (seen) seen.others++;
        else bySubject.set(key, { neg, scope: s.scope, others: 0 });
      }
      const reported = new Set<RuleLine>();
      for (const [key, { neg, scope, others }] of bySubject) {
        const subj = key.slice(0, key.indexOf('|'));
        // eslint-disable-next-line security/detect-non-literal-regexp -- the subject from the file is escaped (escapeRe)
        const positive = new RegExp(
          `\\b(?:${VERBS}|prefer|always use)\\s+(?:the\\s+|a\\s+|an\\s+)?\`?${escapeRe(subj)}\\b`,
          'i',
        );
        // A scoped ban ("never ... in production") only clashes with a rule that mentions the same scope.
        const candidates = byWord.get(subj.split(' ')[0]!) ?? [];
        const matches = candidates.filter(
          (pos) =>
            pos !== neg &&
            pos.lower.includes(subj) &&
            positive.test(pos.text) &&
            scope.every((w) => pos.lower.includes(w)),
        );
        const first = matches.find((p) => !reported.has(p));
        if (!first) continue;
        matches.forEach((p) => reported.add(p));
        const where = neg.file === first.file ? `line ${neg.line.n}` : `${neg.file.path}:${neg.line.n}`;
        const more = matches.length - 1 + others;
        issues.push({
          rule: 'contradiction',
          severity: 'warning',
          file: first.file.path,
          line: first.line.n,
          message: `${quote(first.text, 60)} contradicts ${where}: ${quote(neg.text, 60)}${more > 0 ? ` (${more} more line${more === 1 ? '' : 's'} say the same)` : ''}`,
          hint: 'Keep one rule, or write the exception into it: "Never use X, except in Y".',
        });
      }
    }
    return issues;
  },
};
