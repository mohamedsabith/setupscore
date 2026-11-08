import { describe, expect, it } from 'vitest';
import { lint } from './helpers.js';

const RULE = 'file-name-pattern';

describe('file-name-pattern: a file name pattern with a date, checked against the files it describes', () => {
  const check = (pattern: string, files: Record<string, string>, from = 'CLAUDE.md') =>
    lint(RULE, { [from]: `- Add an entry to \`${pattern}\`.\n`, ...files });

  it('accepts a pattern that fits the files it describes, wherever they are and whatever their folders are called', () => {
    const ok: [string, Record<string, string>, string?][] = [
      // From a real project: the pattern is written in a skill, the folder is at the root.
      [
        'knowledge/history/YYYY-MM.md',
        { 'knowledge/history/2026-10.md': '', 'knowledge/history/README.md': '' },
        '.claude/skills/update-knowledge/SKILL.md',
      ],
      ['docs/changelog/YYYY-MM-DD.md', { 'docs/changelog/2026-11-08.md': '' }],
      ['notes/yyyy-mm-dd.md', { 'notes/2026-11-08.md': '' }],
      ['./logs/YYYYMMDD.log', { 'logs/20261108.log': '' }],
      ['memory/YYYY-MM-DD.md', { 'memory/2026-01-02.md': '', 'memory/2026-01-03.md': '' }],
      ['.karen/history/YYYY-MM-DD-HH-MM.md', { '.karen/history/2026-11-08-14-30.md': '' }],
      ['CHANGELOG/YYYY.M.PATCH.md', { 'CHANGELOG/2026.3.1.md': '' }],
      ['CHANGELOG/YYYY.M.P.md', { 'CHANGELOG/2026.1.10.md': '', 'CHANGELOG/2026.9.9.md': '' }],
      ['plans/YYYY-MM-DD-ENG-XXXX-description.md', { 'plans/2026-11-08-ENG-1234-fix-login.md': '' }],
      ['adr/YYYY-MM-DD-<title>.md', { 'adr/2026-11-08-use-postgres.md': '' }],
      ['reports/YYYY/MM.md', { 'reports/2026/10.md': '' }],
    ];
    for (const [pattern, files, from] of ok) expect(check(pattern, files, from), pattern).toEqual([]);
    // Written in a nested CLAUDE.md: the pattern is read from that folder.
    expect(
      lint(RULE, {
        'packages/api/CLAUDE.md': '- Log to `notes/YYYY-MM.md`.\n',
        'packages/api/notes/2026-10.md': '',
      }),
    ).toEqual([]);
  });

  it('reports a pattern that no file fits, and names the files', () => {
    const wrong: [string, Record<string, string>, string][] = [
      [
        'knowledge/history/YYYY-MM.md',
        { 'knowledge/history/2026_10.md': '', 'knowledge/history/2026_11.md': '' },
        '"2026_10.md" … "2026_11.md"',
      ],
      ['notes/YYYY-MM-DD.md', { 'notes/2026-11.md': '' }, '"2026-11.md"'],
      ['plans/YYYY-MM-DD-ENG-XXXX-description.md', { 'plans/ENG-1234-2026-11-08.md': '' }, '"ENG-1234-2026-11-08.md"'],
      ['logs/YYYYMMDD.log', { 'logs/08-11-2026.log': '' }, '"08-11-2026.log"'],
    ];
    for (const [pattern, files, shown] of wrong) {
      const issues = check(pattern, files);
      expect(issues, pattern).toHaveLength(1);
      expect(issues[0]!.message).toContain(`"${pattern}" is a file name pattern, but no file in`);
      expect(issues[0]!.message).toContain(`the files there look like ${shown}`);
      expect(issues[0]!.hint).toBe('Write the pattern the files use, or rename the files to fit it.');
    }
    // Written in a nested CLAUDE.md, about that package's own folder.
    const nested = lint(RULE, {
      'packages/api/CLAUDE.md': '- Log to `notes/YYYY-MM.md`.\n',
      'packages/api/notes/2026_10.md': '',
    });
    expect(nested).toHaveLength(1);
    expect(nested[0]!.message).toContain('no file in packages/api/notes/ is named that way');
  });

  it('says nothing when it cannot tell: no folder yet, no dated file yet, or files of another kind', () => {
    expect(check('knowledge/history/YYYY-MM.md', { 'src/a.ts': '' })).toEqual([]);
    expect(check('knowledge/history/YYYY-MM.md', { 'knowledge/history/README.md': '' })).toEqual([]);
    expect(check('knowledge/history/YYYY-MM.md', { 'knowledge/history/2026_10.txt': '' })).toEqual([]);
    expect(check('reports/YYYY/MM.md', { 'reports/2026-10.md': '' })).toEqual([]);
  });

  it('leaves a real dated file that is missing to broken-reference', () => {
    expect(
      lint('broken-reference', {
        'CLAUDE.md': '- Read `knowledge/history/2026-11.md`.\n',
        'knowledge/history/2026-10.md': '',
      }),
    ).toHaveLength(1);
  });

  it('finds the folder when it moved, but only when there is exactly one candidate', () => {
    const moved = check('knowledge/history/YYYY-MM.md', { 'docs/knowledge/history/2026-10.md': '' });
    expect(moved).toHaveLength(1);
    expect(moved[0]!.message).toBe(
      '"knowledge/history/YYYY-MM.md" is a file name pattern for knowledge/history/, which does not exist. Files named that way are in docs/knowledge/history/.',
    );
    expect(moved[0]!.hint).toBe('Write docs/knowledge/history/YYYY-MM.md if that is the folder you mean.');
    // Two folders of that name: it cannot tell which one is meant.
    expect(
      check('knowledge/history/YYYY-MM.md', { 'apps/a/history/2026-10.md': '', 'apps/b/history/2026-11.md': '' }),
    ).toEqual([]);
    // A folder of that name whose files do not fit is not the one meant.
    expect(
      check('knowledge/history/YYYY-MM.md', { 'docs/history/notes.md': '', 'docs/history/2026_10.md': '' }),
    ).toEqual([]);
  });

  it('works in any layout: a monorepo package, a .claude/ folder of a package, a skill, a deep folder', () => {
    const layouts: Record<string, string>[] = [
      { 'services/billing/CLAUDE.md': '- Log to `notes/YYYY-MM.md`.\n', 'services/billing/notes/2026_10.md': '' },
      { 'apps/web/.claude/rules/log.md': '- Log to `notes/YYYY-MM.md`.\n', 'apps/web/notes/2026_10.md': '' },
      {
        '.claude/skills/x/SKILL.md': '---\nname: x\ndescription: d\n---\n- Log to `a/b/c/d/YYYY-MM.md`.\n',
        'a/b/c/d/2026_10.md': '',
      },
    ];
    for (const files of layouts) expect(lint(RULE, files), Object.keys(files)[0]).toHaveLength(1);
  });

  it('is a warning, and leaves examples, placeholders and code blocks alone', () => {
    const [issue] = check('notes/YYYY-MM.md', { 'notes/2026_10.md': '' });
    expect(issue!.severity).toBe('warning');
    for (const text of ['- e.g. `notes/YYYY-MM.md`.\n', '```\nnotes/YYYY-MM.md\n```\n', '- `path/to/YYYY-MM.md`\n'])
      expect(lint(RULE, { 'CLAUDE.md': text, 'notes/2026_10.md': '' }), text).toEqual([]);
  });
});
