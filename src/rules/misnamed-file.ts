import type { Context, Issue, Rule } from '../core/types.js';

export const misnamedFile: Rule = {
  id: 'misnamed-file',
  severity: 'warning',
  certainty: 'sure',
  summary:
    'A setup file has a name or place Claude Code does not load: claude.md, .Claude/, skill.md, or a skill file outside its own folder.',
  why: 'Claude Code looks for exact names and places. On macOS and Windows the disk ignores letter case, so a wrongly cased file seems to work, but on Linux (CI, containers, teammates) Claude Code never loads it. A skill must be a folder with a SKILL.md file in it.',
  check(ctx: Context): Issue[] {
    return (ctx.misnamed ?? []).map((m) =>
      m.reason === 'layout'
        ? {
            rule: 'misnamed-file',
            severity: 'warning' as const,
            file: m.path,
            message: `Claude Code never loads this as a skill: a skill is a folder with a SKILL.md file in it (${m.expected}).`,
            hint: `Move it to ${m.expected} and give it a "description:" in frontmatter. If it is only a note, move it out of .claude/skills/.`,
          }
        : {
            rule: 'misnamed-file',
            severity: 'warning' as const,
            file: m.path,
            message: `Claude Code looks for "${m.expected}", not "${m.path}". On Linux it does not load this, and setupscore did not check it.`,
            hint: `Rename it to ${m.expected}. With git on macOS or Windows: git mv "${m.path}" "${m.expected}"`,
          },
    );
  },
};
