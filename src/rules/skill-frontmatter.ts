import { wordCount } from '../core/markdown.js';
import type { Context, Issue, Rule, SetupFile } from '../core/types.js';
import { quote } from './util.js';

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MIN_DESCRIPTION_WORDS = 8;
const MAX_DESCRIPTION_CHARS = 1024;

const issue = (f: SetupFile, message: string, hint: string, line = 1): Issue => ({
  rule: 'skill-frontmatter',
  severity: 'warning',
  file: f.path,
  line,
  message,
  hint,
});

const DESCRIBE = 'Write it as "<What it does>. Use when <situation>." Claude picks skills by their description.';

export const skillFrontmatter: Rule = {
  id: 'skill-frontmatter',
  severity: 'warning',
  summary: 'A skill has a missing, short or invalid name or description.',
  why: 'Claude decides whether to load a skill from its description alone. A missing or one-word description means the skill is rarely or never used.',
  check(ctx: Context): Issue[] {
    const issues: Issue[] = [];
    for (const f of ctx.files.filter((f) => f.kind === 'skill')) {
      if (f.frontmatter?.error) continue; // reported by invalid-config
      const data = f.frontmatter?.data;
      if (!data) {
        issues.push(
          issue(
            f,
            'No frontmatter, so Claude only has the folder name and first paragraph to go on.',
            `Add a --- block at the top with a description. ${DESCRIBE}`,
          ),
        );
        continue;
      }
      const lineOfKey = (key: string) =>
        f.lines.find((l) => l.inFrontmatter && l.text.trimStart().startsWith(`${key}:`))?.n ?? 1;

      if (
        data['name'] !== undefined &&
        (typeof data['name'] !== 'string' || !NAME.test(data['name']) || data['name'].length > 64)
      ) {
        const what =
          typeof data['name'] === 'string' ? `name ${quote(data['name'], 60)} is not valid.` : 'name must be text.';
        issues.push(
          issue(
            f,
            `${what} Use lowercase letters, numbers and hyphens, at most 64 characters.`,
            'For example: name: db-migration',
            lineOfKey('name'),
          ),
        );
      }

      const desc = data['description'];
      if (desc === undefined || desc === null || (typeof desc === 'string' && desc.trim() === '')) {
        issues.push(
          issue(
            f,
            'No description, so Claude has to guess when this skill is useful.',
            DESCRIBE,
            lineOfKey('description'),
          ),
        );
      } else if (typeof desc !== 'string') {
        issues.push(issue(f, 'description must be text.', DESCRIBE, lineOfKey('description')));
      } else if (wordCount(desc) < MIN_DESCRIPTION_WORDS) {
        issues.push(
          issue(
            f,
            `The description ${quote(desc, 60)} is too short for Claude to know when to use this skill.`,
            DESCRIBE,
            lineOfKey('description'),
          ),
        );
      } else if (desc.length > MAX_DESCRIPTION_CHARS) {
        issues.push(
          issue(
            f,
            `The description is ${desc.length} characters; the limit is ${MAX_DESCRIPTION_CHARS}.`,
            'Keep the description short and move detail into the body.',
            lineOfKey('description'),
          ),
        );
      }

      const body = f.lines.filter((l) => !l.inFrontmatter && l.text.trim() !== '');
      if (body.length === 0)
        issues.push(
          issue(
            f,
            'The skill has no instructions after the frontmatter.',
            'Write the steps Claude should follow when it uses this skill.',
            f.frontmatter?.endLine ?? 1,
          ),
        );
    }
    return issues;
  },
};
