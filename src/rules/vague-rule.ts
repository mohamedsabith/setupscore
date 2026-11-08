import { isListItem, ruleText, wordCount } from '../core/markdown.js';
import type { Context, Issue, Rule } from '../core/types.js';
import { instructionFiles, proseLines, quote } from './util.js';

/** Phrases that sound like rules but give Claude nothing it can check or act on. */
const VAGUE = [
  /\bwrite (?:good|clean|nice|quality|better|proper) code\b/i,
  /\b(?:good|clean|quality|nice) code\b/i,
  /\bbe careful\b/i,
  /\b(?:follow|use|apply) (?:the )?best practices\b/i,
  /\bbest practices\b/i,
  /\bhigh[- ]quality\b/i,
  /\bdo (?:it|things) (?:right|properly|well)\b/i,
  /\bmake (?:it|sure it) (?:good|works?|nice|clean)\b/i,
  /\bbe (?:smart|thoughtful|thorough|professional)\b/i,
  /\buse (?:common sense|good judge?ment)\b/i,
  /\bkeep (?:it|code|things) (?:clean|simple|nice)\b/i,
  /\b(?:handle|manage) errors (?:properly|well|correctly|appropriately)\b/i,
];

/** A rule this short with a vague phrase has nothing concrete in it. Longer lines usually explain themselves. */
const MAX_WORDS = 10;

export const vagueRule: Rule = {
  id: 'vague-rule',
  severity: 'warning',
  certainty: 'guess',
  summary: 'A rule is too vague for Claude to act on, like "write good code" or "be careful".',
  why: 'Claude already tries to write good code. A vague rule costs tokens on every message and changes nothing. A concrete rule ("wrap DB calls in try/catch and log with logger.error") does.',
  check(ctx: Context): Issue[] {
    const issues: Issue[] = [];
    // Only standing instructions. Skill, agent and command bodies are task prompts,
    // where "be thorough" is a normal thing to say.
    for (const f of instructionFiles(ctx).filter((f) => !['skill', 'agent', 'command'].includes(f.kind))) {
      for (const l of proseLines(f)) {
        const t = l.text.trim();
        if (t.startsWith('#')) continue; // headings
        if (/^(\*\*|__)[^*_]+\1:?$/.test(t) || /:(?:\*\*)?$/.test(t) || /:[ \t]*\*\*$/.test(t)) continue; // labels like **Best practices:**
        const text = ruleText(l.text);
        if (!text || wordCount(text) > MAX_WORDS) continue;
        if (!isListItem(l.text) && wordCount(text) < 2) continue;
        if (!VAGUE.some((re) => re.test(text))) continue;
        // "Be careful: run migrations on staging first." The words after the colon are the concrete rule.
        const colon = text.search(/[:—–]|\s-\s/);
        if (colon >= 0 && wordCount(text.slice(colon + 1)) >= 3) continue;
        issues.push({
          rule: 'vague-rule',
          severity: 'warning',
          file: f.path,
          line: l.n,
          message: `${quote(text)} is too vague for Claude to act on.`,
          hint: 'Say exactly what to do and where, ideally with a short example.',
        });
      }
    }
    return issues;
  },
};
