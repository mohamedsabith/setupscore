import type { Context, Issue, Rule } from '../core/types.js';
import { instructionFiles } from './util.js';

const MAX_LINES = 200; // Anthropic's guidance for CLAUDE.md
const MAX_SKILL_LINES = 500; // Anthropic's guidance for SKILL.md

/** Lines in a file, not counting blank lines at the end. trimEnd() is linear, unlike a /\s+$/ regex. */
const countLines = (text: string): number => {
  const t = text.trimEnd();
  let n = 1;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 10 || (c === 13 && t.charCodeAt(i + 1) !== 10)) n++;
  }
  return n;
};

const mb = (bytes: string): string => `${(Number(bytes) / 1024 / 1024).toFixed(1)} MB`;

export const tooLong: Rule = {
  id: 'too-long',
  severity: 'warning',
  certainty: 'advice',
  summary: 'An instruction file is longer than Anthropic recommends (200 lines for CLAUDE.md, 500 for a skill).',
  why: 'Files loaded at start are sent with every message. Long files cost more and Claude follows each rule less reliably.',
  check(ctx: Context): Issue[] {
    const issues: Issue[] = [];
    for (const s of ctx.skipped ?? []) {
      if (s.problem !== 'too-big') continue;
      issues.push({
        rule: 'too-long',
        severity: 'warning',
        file: s.path,
        message: `${mb(s.detail)}: too big for setupscore to check (the limit is 2 MB), so nothing in it was checked.`,
        hint:
          s.kind === 'settings' || s.kind === 'settings-local' || s.kind === 'mcp'
            ? 'A config file this big is almost certainly a mistake. Keep it small.'
            : "A file this big fills Claude's context. Keep instructions short and move reference material into separate files.",
      });
    }
    for (const f of instructionFiles(ctx)) {
      const lines = countLines(f.text);
      const limit = f.kind === 'skill' ? MAX_SKILL_LINES : MAX_LINES;
      if (f.kind === 'agent' || f.kind === 'command' || lines <= limit) continue;
      issues.push({
        rule: 'too-long',
        severity: 'warning',
        file: f.path,
        message: `${lines} lines. The recommended maximum is ${limit}.`,
        hint:
          f.kind === 'skill'
            ? 'Move reference material into separate files next to SKILL.md and link to them.'
            : 'Move rules that only apply to some files into .claude/rules/ with "paths:", and procedures into skills.',
      });
    }
    return issues;
  },
};
