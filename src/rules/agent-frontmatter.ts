import { wordCount } from '../core/markdown.js';
import type { Context, Issue, Rule } from '../core/types.js';
import { quote } from './util.js';

export const agentFrontmatter: Rule = {
  id: 'agent-frontmatter',
  severity: 'warning',
  summary: 'A subagent in .claude/agents/ has no name or no useful description.',
  why: 'Claude decides when to hand work to a subagent from its description. Without a clear one, the subagent is rarely used.',
  check(ctx: Context): Issue[] {
    const issues: Issue[] = [];
    for (const f of ctx.files.filter((f) => f.kind === 'agent')) {
      if (f.frontmatter?.error) continue;
      const data = f.frontmatter?.data;
      const add = (message: string, hint: string) =>
        issues.push({ rule: 'agent-frontmatter', severity: 'warning', file: f.path, line: 1, message, hint });
      if (!data) {
        add(
          'No frontmatter. Subagents need a name and a description.',
          'Add a --- block with name: and description: at the top.',
        );
        continue;
      }
      if (typeof data['name'] !== 'string' || !data['name'].trim())
        add('No name.', 'Add  name: code-reviewer  (lowercase and hyphens).');
      const desc = data['description'];
      if (typeof desc !== 'string' || !desc.trim())
        add(
          'No description, so Claude does not know when to use this subagent.',
          'Say what it does and when to use it.',
        );
      else if (wordCount(desc) < 6)
        add(
          `The description ${quote(desc, 60)} is too short to tell Claude when to use this subagent.`,
          'Say what it does and when to use it.',
        );
    }
    return issues;
  },
};
