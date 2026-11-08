import { isListItem, ruleText } from '../core/markdown.js';
import type { Context, Issue, Line, Rule, SetupFile } from '../core/types.js';
import { loadContexts } from './contexts.js';
import { proseLines, quote } from './util.js';

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

/** An item that starts with "Using", "Creating" ...: it describes something, it does not ask for it. */
const DESCRIPTION = /^\W*(?:using|writing|calling|adding|importing|creating|running|installing)\b/i;

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
}
/** A rule that asks for something: "Use raw SQL for reports". */
interface Positive extends RuleLine {
  lower: string;
}
/** A ban, read once: "never write raw SQL in reports" -> subject "raw sql", scope ["reports"]. */
interface Negative {
  rule: RuleLine;
  /** Subject and scope: bans with the same key are one problem. */
  key: string;
  subject: string;
  scope: string[];
  /** The name in backticks, exactly: code is case-sensitive, so `plan` is not "Plan mode". */
  code: string | undefined;
}

/** The rules of one file, read once however many contexts the file is in. Only list items: rules are written as lists, and wrapped prose paragraphs give false matches. */
function readRules(file: SetupFile): { positives: Positive[]; negatives: Negative[] } {
  const under = headings(file);
  const positives: Positive[] = [];
  const negatives: Negative[] = [];
  for (const line of proseLines(file)) {
    if (!isListItem(line.text)) continue;
    const rule = { file, line, text: ruleText(line.text) };
    // A bad example is not an instruction to do it, and nor is a description ("Creating wrappers that ...").
    const bad = BAD_EXAMPLE.test(rule.text) || DONT_HEADING.test(under.get(line.n) ?? '');
    if (!bad && !NEGATION_WORDS.test(rule.text) && !DESCRIPTION.test(rule.text))
      positives.push({ ...rule, lower: rule.text.toLowerCase() });
    const m = rule.text.match(NEGATIVE);
    if (!m) continue;
    // An open code span: the name goes on past the words read ("never run `npm exec nx build`"), so it is cut short.
    if ((m[1]!.split('`').length - 1) % 2 === 1) continue;
    const s = subject(m[1]!, rule.text.slice(m.index! + m[0].length));
    if (!s) continue;
    negatives.push({
      rule,
      key: `${s.subject}|${s.scope.join(' ')}`,
      subject: s.subject,
      scope: s.scope,
      code: /`([^`]+)`/.exec(m[1]!)?.[1],
    });
  }
  return { positives, negatives };
}

/** Word -> the positive rules that contain it, so each subject only looks at a few candidates. */
function byWord(positives: Positive[]): Map<string, Positive[]> {
  const out = new Map<string, Positive[]>();
  for (const pos of positives) {
    for (const w of new Set(pos.lower.split(/[^\w.+#@/-]+/).map(trimPunct))) {
      if (!w) continue;
      const list = out.get(w);
      if (list) list.push(pos);
      else out.set(w, [pos]);
    }
  }
  return out;
}

export const contradiction: Rule = {
  id: 'contradiction',
  severity: 'warning',
  summary: 'Two rules seem to say opposite things, like "never write raw SQL" and "use raw SQL for reports".',
  why: 'When rules conflict Claude has to guess which one wins, and it will not guess the same way every time.',
  check(ctx: Context): Issue[] {
    // Compare rules that are in front of Claude together (see loadContexts). The start-up set comes
    // first and is compared there; every other context only adds pairs with one side in its own files.
    const issues: Issue[] = [];
    const reported = new Set<string>();
    const lineKey = (r: RuleLine) => `${r.file.path}:${r.line.n}`;
    const read = new Map<SetupFile, ReturnType<typeof readRules>>();
    const rulesOf = (f: SetupFile) => {
      let r = read.get(f);
      if (!r) read.set(f, (r = readRules(f)));
      return r;
    };
    const patterns = new Map<string, RegExp>();
    const contexts = loadContexts(ctx);
    const startIndex = byWord(contexts[0]!.files.flatMap((f) => rulesOf(f).positives));
    for (const context of contexts) {
      const isStart = context === contexts[0];
      // Every other context is the start-up set (or nothing) plus its own files.
      const own = isStart ? context.files : context.files.filter((f) => context.own.has(f));
      const base = isStart ? [] : context.files.filter((f) => !context.own.has(f));
      const ownIndex = isStart ? startIndex : byWord(own.flatMap((f) => rulesOf(f).positives));
      const baseIndex = base.length ? startIndex : new Map<string, Positive[]>();
      // One report per forbidden subject: 400 copies of "never use X" against 400 of "use X" is one problem.
      const bySubject = new Map<string, { neg: Negative; others: number; hasOwn: boolean }>();
      for (const [files, isOwn] of [
        [base, false],
        [own, true],
      ] as const) {
        for (const f of files) {
          for (const neg of rulesOf(f).negatives) {
            const seen = bySubject.get(neg.key);
            if (seen) {
              seen.others++;
              seen.hasOwn ||= isOwn;
            } else bySubject.set(neg.key, { neg, others: 0, hasOwn: isOwn });
          }
        }
      }
      for (const { neg: n, others, hasOwn } of bySubject.values()) {
        const { rule: neg, subject: subj, scope, code } = n;
        // Bans from the start-up set only meet this context's own rules here.
        const word = subj.split(' ')[0]!;
        const candidates = [...(hasOwn ? (baseIndex.get(word) ?? []) : []), ...(ownIndex.get(word) ?? [])];
        if (candidates.length === 0) continue;
        let positive = patterns.get(subj);
        if (!positive) {
          // eslint-disable-next-line security/detect-non-literal-regexp -- the subject from the file is escaped (escapeRe)
          positive = new RegExp(
            `\\b(?:${VERBS}|prefer|always use)\\s+(?:the\\s+|a\\s+|an\\s+)?\`?${escapeRe(subj)}\\b`,
            'i',
          );
          patterns.set(subj, positive);
        }
        // A scoped ban ("never ... in production") only clashes with a rule that mentions the same scope.
        const matches = candidates.filter(
          (pos) =>
            pos.line !== neg.line &&
            pos.lower.includes(subj) &&
            (code === undefined || pos.text.includes(code)) &&
            positive.test(pos.text) &&
            scope.every((w) => pos.lower.includes(w)),
        );
        const first = matches.find((p) => !reported.has(lineKey(p)));
        if (!first) continue;
        matches.forEach((p) => reported.add(lineKey(p)));
        const where = neg.file === first.file ? `line ${neg.line.n}` : `${neg.file.path}:${neg.line.n}`;
        const both = context.when && neg.file !== first.file ? ` (both load ${context.when})` : '';
        const more = matches.length - 1 + others;
        issues.push({
          rule: 'contradiction',
          severity: 'warning',
          file: first.file.path,
          line: first.line.n,
          message: `${quote(first.text, 60)} contradicts ${where}: ${quote(neg.text, 60)}${both}${more > 0 ? ` (${more} more line${more === 1 ? '' : 's'} say the same)` : ''}`,
          hint: 'Keep one rule, or write the exception into it: "Never use X, except in Y".',
        });
      }
    }
    return issues;
  },
};
