import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check } from '../src/core/check.js';
import { applyFixes } from '../src/core/fix.js';
import { issuesOf, makeRepo } from './helpers.js';

// agents-md-not-loaded follows code.claude.com/docs/en/memory#agents-md (Claude Code 2.1.277+):
// by default Claude reads AGENTS.md only when there is no CLAUDE.md, .claude/CLAUDE.md or
// CLAUDE.local.md, and a subfolder's AGENTS.md only when that folder has none of its own.

const RULE = 'agents-md-not-loaded';
const TEXT = '- Run the tests with pnpm test.\n';
const issues = (files: Record<string, string>) => issuesOf(makeRepo(files), RULE);
const flagged = (files: Record<string, string>) => issues(files).map((i) => i.file);
const posixOnly = process.platform === 'win32' ? it.skip : it;

describe('agents-md-not-loaded: an AGENTS.md hidden by a CLAUDE.md next to it', () => {
  it('flags CLAUDE.md that does not import AGENTS.md, on CLAUDE.md line 1', () => {
    const [i, ...rest] = issues({ 'CLAUDE.md': TEXT, 'AGENTS.md': TEXT });
    expect(rest).toEqual([]);
    expect(i).toMatchObject({ rule: RULE, severity: 'warning', file: 'CLAUDE.md', line: 1 });
    expect(i!.message).toContain('AGENTS.md is not read by Claude Code');
    expect(i!.hint).toContain('Add the line "@AGENTS.md" to CLAUDE.md');
    expect(i!.fix).toBeUndefined();
  });

  it('flags .claude/CLAUDE.md, and suggests the import path from its own folder', () => {
    const [i] = issues({ '.claude/CLAUDE.md': TEXT, 'AGENTS.md': TEXT });
    expect(i!.file).toBe('.claude/CLAUDE.md');
    expect(i!.hint).toContain('"@../AGENTS.md"');
  });

  it('flags a personal CLAUDE.local.md and offers the Project instructions setting', () => {
    const [i] = issues({ 'CLAUDE.local.md': TEXT, 'AGENTS.md': TEXT });
    expect(i!.file).toBe('CLAUDE.local.md');
    expect(i!.message).toContain('your personal CLAUDE.local.md');
    expect(i!.hint).toContain('claude-md-and-agents-md');
  });

  it('names CLAUDE.md first when CLAUDE.md and CLAUDE.local.md both exist, and reports once', () => {
    expect(flagged({ 'CLAUDE.md': TEXT, 'CLAUDE.local.md': TEXT, 'AGENTS.md': TEXT })).toEqual(['CLAUDE.md']);
  });

  it('names CLAUDE.md before .claude/CLAUDE.md', () => {
    expect(flagged({ 'CLAUDE.md': TEXT, '.claude/CLAUDE.md': TEXT, 'AGENTS.md': TEXT })).toEqual(['CLAUDE.md']);
  });

  it('flags .claude/AGENTS.md too, with its own import path', () => {
    const [i] = issues({ 'CLAUDE.md': TEXT, '.claude/AGENTS.md': TEXT });
    expect(i!.message).toContain('.claude/AGENTS.md is not read');
    expect(i!.hint).toContain('"@.claude/AGENTS.md"');
  });

  it('reports AGENTS.md and .claude/AGENTS.md separately', () => {
    const found = issues({ 'CLAUDE.md': TEXT, 'AGENTS.md': TEXT, '.claude/AGENTS.md': TEXT });
    expect(found.map((i) => i.message.split(' ')[0])).toEqual(['.claude/AGENTS.md', 'AGENTS.md']);
  });

  it('suggests "@AGENTS.md" from .claude/CLAUDE.md for .claude/AGENTS.md', () => {
    const [i] = issues({ '.claude/CLAUDE.md': TEXT, '.claude/AGENTS.md': TEXT });
    expect(i!.hint).toContain('"@AGENTS.md"');
  });

  it('flags a CLAUDE.md that only tells Claude in words to read AGENTS.md, and says so', () => {
    const [i] = issues({ 'CLAUDE.md': '- Read AGENTS.md first.\n', 'AGENTS.md': TEXT });
    expect(i!.hint).toContain('mentions AGENTS.md, but only an import makes Claude read it');
  });

  it('flags a mention in a code span: `AGENTS.md` is not an import', () => {
    expect(flagged({ 'CLAUDE.md': '- See `AGENTS.md`.\n', 'AGENTS.md': TEXT })).toEqual(['CLAUDE.md']);
  });

  it('flags "@AGENTS.md" written inside a code block, which Claude Code does not import', () => {
    expect(flagged({ 'CLAUDE.md': '```\n@AGENTS.md\n```\n', 'AGENTS.md': TEXT })).toEqual(['CLAUDE.md']);
  });

  it('flags a CLAUDE.md that imports a different file', () => {
    expect(flagged({ 'CLAUDE.md': '@docs/agents.md\n', 'docs/agents.md': TEXT, 'AGENTS.md': TEXT })).toEqual([
      'CLAUDE.md',
    ]);
  });

  it('keeps every message short and in plain words', () => {
    for (const i of issues({ 'CLAUDE.md': TEXT, 'AGENTS.md': TEXT, 'pkg/AGENTS.md': TEXT })) {
      expect(i.message.length).toBeLessThan(200);
      expect(i.hint!.length).toBeLessThan(200);
    }
  });
});

describe('agents-md-not-loaded: a CLAUDE.md that is a link saved as a plain file', () => {
  it('flags CLAUDE.md whose whole text is "AGENTS.md", with a safe fix', () => {
    const [i] = issues({ 'CLAUDE.md': 'AGENTS.md\n', 'AGENTS.md': TEXT });
    expect(i!.message).toContain('only contains the text "AGENTS.md"');
    expect(i!.fix).toEqual({ file: 'CLAUDE.md', line: 1, from: 'AGENTS.md', to: '@AGENTS.md' });
  });

  it('handles the text without a final newline, and with Windows line endings', () => {
    expect(issues({ 'CLAUDE.md': 'AGENTS.md', 'AGENTS.md': TEXT })[0]!.fix).toBeDefined();
    expect(issues({ 'CLAUDE.md': 'AGENTS.md\r\n', 'AGENTS.md': TEXT })[0]!.fix).toBeDefined();
  });

  it('handles .claude/CLAUDE.md whose text is "../AGENTS.md"', () => {
    const [i] = issues({ '.claude/CLAUDE.md': '../AGENTS.md\n', 'AGENTS.md': TEXT });
    expect(i!.fix).toEqual({ file: '.claude/CLAUDE.md', line: 1, from: '../AGENTS.md', to: '@../AGENTS.md' });
  });

  it('--fix turns it into an import, after which nothing is reported', () => {
    const root = makeRepo({ 'CLAUDE.md': 'AGENTS.md\n', 'AGENTS.md': TEXT });
    const applied = applyFixes(root, issuesOf(root, RULE));
    expect(applied).toHaveLength(1);
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n');
    expect(issuesOf(root, RULE)).toEqual([]);
  });

  it('gives no fix when CLAUDE.md has other text too', () => {
    const [i] = issues({ 'CLAUDE.md': 'AGENTS.md\n- More rules.\n', 'AGENTS.md': TEXT });
    expect(i!.fix).toBeUndefined();
  });
});

describe('agents-md-not-loaded: subfolders and monorepos', () => {
  it('flags a subfolder AGENTS.md hidden by the root CLAUDE.md, reported on CLAUDE.md', () => {
    const [i, ...rest] = issues({ 'CLAUDE.md': TEXT, 'packages/api/AGENTS.md': TEXT });
    expect(rest).toEqual([]);
    expect(i!.file).toBe('CLAUDE.md');
    expect(i!.message).toContain('packages/api/AGENTS.md is not read by Claude Code');
    expect(i!.hint).toContain('packages/api/CLAUDE.md');
  });

  it('groups many hidden subfolder files into one warning', () => {
    const files: Record<string, string> = { 'CLAUDE.md': TEXT };
    for (const p of ['a', 'b', 'c']) files[`packages/${p}/AGENTS.md`] = TEXT;
    const found = issues(files);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('packages/a/AGENTS.md and 2 more AGENTS.md files in subfolders are');
  });

  it('says "1 more AGENTS.md file" for two', () => {
    const [i] = issues({ 'CLAUDE.md': TEXT, 'a/AGENTS.md': TEXT, 'b/AGENTS.md': TEXT });
    expect(i!.message).toContain('and 1 more AGENTS.md file in subfolders are');
  });

  it('stays fast and gives one warning for a monorepo with 300 packages', () => {
    const files: Record<string, string> = { 'CLAUDE.md': TEXT };
    for (let n = 0; n < 300; n++) files[`packages/p${n}/AGENTS.md`] = TEXT;
    const root = makeRepo(files);
    const t = Date.now();
    expect(issuesOf(root, RULE)).toHaveLength(1);
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('flags only the subfolder when the root CLAUDE.md imports the root AGENTS.md', () => {
    const found = issues({ 'CLAUDE.md': '@AGENTS.md\n', 'AGENTS.md': TEXT, 'pkg/AGENTS.md': TEXT });
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('pkg/AGENTS.md');
  });

  it('flags a subfolder CLAUDE.md that hides the AGENTS.md next to it (no root files)', () => {
    expect(flagged({ 'pkg/CLAUDE.md': TEXT, 'pkg/AGENTS.md': TEXT })).toEqual(['pkg/CLAUDE.md']);
  });

  it("reports on the subfolder's own CLAUDE.md, not the root one, when both exist", () => {
    expect(flagged({ 'CLAUDE.md': TEXT, 'pkg/CLAUDE.md': TEXT, 'pkg/AGENTS.md': TEXT })).toEqual(['pkg/CLAUDE.md']);
  });

  it('flags a subfolder CLAUDE.local.md as personal', () => {
    const [i] = issues({ 'pkg/CLAUDE.local.md': TEXT, 'pkg/AGENTS.md': TEXT });
    expect(i!.message).toContain('your personal pkg/CLAUDE.local.md');
  });

  it('flags a subfolder .claude/CLAUDE.md, with "@../AGENTS.md"', () => {
    const [i] = issues({ 'pkg/.claude/CLAUDE.md': TEXT, 'pkg/AGENTS.md': TEXT });
    expect(i!.file).toBe('pkg/.claude/CLAUDE.md');
    expect(i!.hint).toContain('"@../AGENTS.md"');
  });

  it("flags a subfolder's .claude/AGENTS.md hidden by its CLAUDE.md", () => {
    const [i] = issues({ 'pkg/CLAUDE.md': TEXT, 'pkg/.claude/AGENTS.md': TEXT });
    expect(i!.hint).toContain('"@.claude/AGENTS.md"');
  });

  it('handles folder names with spaces and other letters', () => {
    const [i] = issues({ 'my pkg/café/CLAUDE.md': TEXT, 'my pkg/café/AGENTS.md': TEXT });
    expect(i!.file).toBe('my pkg/café/CLAUDE.md');
  });

  it('does not flag a subfolder AGENTS.md when there is no root CLAUDE.md (Claude reads it there)', () => {
    expect(flagged({ '.claude/settings.json': '{}', 'pkg/AGENTS.md': TEXT })).toEqual([]);
  });

  it("does not use a parent folder's CLAUDE.md: only the folder's own counts for a subfolder", () => {
    expect(flagged({ 'packages/CLAUDE.md': TEXT, 'packages/api/AGENTS.md': TEXT })).toEqual([]);
  });

  it('does not flag a subfolder AGENTS.md that the root CLAUDE.md imports', () => {
    expect(flagged({ 'CLAUDE.md': '@packages/api/AGENTS.md\n', 'packages/api/AGENTS.md': TEXT })).toEqual([]);
  });

  it('does not flag a subfolder AGENTS.md that its own CLAUDE.md imports', () => {
    expect(flagged({ 'CLAUDE.md': TEXT, 'pkg/CLAUDE.md': '@AGENTS.md\n', 'pkg/AGENTS.md': TEXT })).toEqual([]);
  });
});

describe('agents-md-not-loaded: what it must not flag', () => {
  it('a project with only AGENTS.md: Claude reads it, and check has nothing to look at', () => {
    const root = makeRepo({ 'AGENTS.md': TEXT });
    expect(issuesOf(root, RULE)).toEqual([]);
    expect(check(root).files).toEqual([]);
  });

  it('AGENTS.md with setup files that do not count: settings, rules, skills, agents, .mcp.json', () => {
    expect(
      flagged({
        'AGENTS.md': TEXT,
        '.claude/settings.json': '{}',
        '.claude/rules/style.md': '- Use tabs.\n',
        '.claude/skills/deploy/SKILL.md': '---\ndescription: Deploys. Use when asked to deploy.\n---\nSteps.\n',
        '.claude/agents/reviewer.md':
          '---\nname: reviewer\ndescription: Reviews code. Use for reviews.\n---\nReview.\n',
        '.mcp.json': '{"mcpServers":{}}',
      }),
    ).toEqual([]);
  });

  it.each([
    ['CLAUDE.md', '@AGENTS.md\n'],
    ['CLAUDE.md', '@./AGENTS.md\n'],
    ['CLAUDE.md', '# Project\n\n@AGENTS.md\n\n- Claude-only rule.\n'],
    ['CLAUDE.md', '- See @AGENTS.md for the shared rules.\n'],
    ['.claude/CLAUDE.md', '@../AGENTS.md\n'],
    ['CLAUDE.local.md', '@AGENTS.md\n'],
  ])('%s that imports AGENTS.md (%j)', (file, text) => {
    expect(flagged({ [file]: text, 'AGENTS.md': TEXT })).toEqual([]);
  });

  it('an AGENTS.md imported through another file (CLAUDE.md -> docs/shared.md -> AGENTS.md)', () => {
    expect(
      flagged({ 'CLAUDE.md': '@docs/shared.md\n', 'docs/shared.md': '@../AGENTS.md\n', 'AGENTS.md': TEXT }),
    ).toEqual([]);
  });

  it('CLAUDE.md that imports AGENTS.md, with a CLAUDE.local.md that does not', () => {
    expect(flagged({ 'CLAUDE.md': '@AGENTS.md\n', 'CLAUDE.local.md': TEXT, 'AGENTS.md': TEXT })).toEqual([]);
  });

  posixOnly('CLAUDE.md that is a link to AGENTS.md', () => {
    const root = makeRepo({ 'AGENTS.md': TEXT });
    symlinkSync('AGENTS.md', join(root, 'CLAUDE.md'));
    expect(issuesOf(root, RULE)).toEqual([]);
  });

  posixOnly('a subfolder CLAUDE.md that is a link to its AGENTS.md', () => {
    const root = makeRepo({ 'CLAUDE.md': TEXT, 'pkg/AGENTS.md': TEXT });
    symlinkSync('AGENTS.md', join(root, 'pkg/CLAUDE.md'));
    expect(issuesOf(root, RULE)).toEqual([]);
  });

  posixOnly('AGENTS.md that is a link to CLAUDE.md (the same text)', () => {
    const root = makeRepo({ 'CLAUDE.md': TEXT });
    symlinkSync('CLAUDE.md', join(root, 'AGENTS.md'));
    expect(issuesOf(root, RULE)).toEqual([]);
  });

  posixOnly('CLAUDE.md as a link to AGENTS.md, even with a CLAUDE.local.md next to it', () => {
    const root = makeRepo({ 'AGENTS.md': TEXT, 'CLAUDE.local.md': TEXT });
    symlinkSync('AGENTS.md', join(root, 'CLAUDE.md'));
    expect(issuesOf(root, RULE)).toEqual([]);
  });

  it.each([
    ['empty', ''],
    ['blank lines', '\n\n'],
    ['spaces and tabs', '  \t \n'],
  ])('an AGENTS.md with nothing in it (%s)', (_name, text) => {
    expect(flagged({ 'CLAUDE.md': TEXT, 'AGENTS.md': text })).toEqual([]);
  });

  it.each([
    'AGENTS.local.md',
    'AGENTS.override.md',
    'agents.md',
    'Agents.md',
    'docs/AGENTS.mdx',
    'AGENTS.md.bak',
    '.agents/AGENTS.md',
    'tools/.agents/AGENTS.md',
  ])('files Claude Code does not read as AGENTS.md: %s', (name) => {
    expect(flagged({ 'CLAUDE.md': TEXT, [name]: TEXT })).toEqual([]);
  });

  it.each(['node_modules/pkg/AGENTS.md', 'dist/AGENTS.md', '.git/AGENTS.md'])(
    'AGENTS.md in folders setupscore does not read: %s',
    (name) => {
      expect(flagged({ 'CLAUDE.md': TEXT, [name]: TEXT })).toEqual([]);
    },
  );

  it('AGENTS.md under a path ignored in setupscore.yml', () => {
    const root = makeRepo({ 'CLAUDE.md': TEXT, 'vendor/lib/AGENTS.md': TEXT });
    expect(issuesOf(root, RULE, { config: { rules: {}, ignore: ['vendor/**'] } })).toEqual([]);
  });

  it('the rule turned off in setupscore.yml', () => {
    const root = makeRepo({ 'CLAUDE.md': TEXT, 'AGENTS.md': TEXT });
    expect(issuesOf(root, RULE, { config: { rules: { [RULE]: 'off' }, ignore: [] } })).toEqual([]);
  });

  it('the rule turned off with a comment in CLAUDE.md', () => {
    expect(flagged({ 'CLAUDE.md': `<!-- setupscore-disable ${RULE} -->\n${TEXT}`, 'AGENTS.md': TEXT })).toEqual([]);
  });

  it('a CLAUDE.md that imports AGENTS.md, which is missing (broken-import reports that instead)', () => {
    const root = makeRepo({ 'CLAUDE.md': '@AGENTS.md\n' });
    expect(issuesOf(root, RULE)).toEqual([]);
    expect(issuesOf(root, 'broken-import')).toHaveLength(1);
  });
});

describe('agents-md-not-loaded: effect on the rest of check', () => {
  it('can be raised to an error in setupscore.yml', () => {
    const root = makeRepo({ 'CLAUDE.md': TEXT, 'AGENTS.md': TEXT });
    const run = check(root, { config: { rules: { [RULE]: 'error' }, ignore: [] } });
    expect(run.issues.filter((i) => i.rule === RULE).map((i) => i.severity)).toEqual(['error']);
  });

  it('costs 0.5 health as a warning, like every other warning', () => {
    const root = makeRepo({ 'CLAUDE.md': TEXT, 'AGENTS.md': TEXT });
    const run = check(root, { config: { rules: {}, ignore: [] } });
    expect(run.issues.map((i) => i.rule)).toEqual([RULE]);
    expect(run.health).toBe(9.5);
  });

  it('leaves other rules unchanged: CLAUDE.md issues are reported as before', () => {
    const root = makeRepo({
      'CLAUDE.md': '- Write good code.\n- See src/missing.ts\n',
      'AGENTS.md': TEXT,
      'src/a.ts': '',
    });
    const rules = check(root, { config: { rules: {}, ignore: [] } })
      .issues.map((i) => i.rule)
      .sort();
    expect(rules).toEqual([RULE, 'broken-reference', 'vague-rule'].sort());
  });

  it('adds nothing for a project without AGENTS.md', () => {
    const root = makeRepo({ 'CLAUDE.md': '- Use pnpm.\n' });
    expect(check(root, { config: { rules: {}, ignore: [] } }).issues).toEqual([]);
  });

  it('does not change a file when --fix runs on a warning without a fix', () => {
    const root = makeRepo({ 'CLAUDE.md': TEXT, 'AGENTS.md': TEXT });
    expect(applyFixes(root, issuesOf(root, RULE))).toEqual([]);
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe(TEXT);
  });

  it('notices an AGENTS.md added after the first check', () => {
    const root = makeRepo({ 'CLAUDE.md': TEXT });
    expect(issuesOf(root, RULE)).toEqual([]);
    writeFileSync(join(root, 'AGENTS.md'), TEXT);
    expect(issuesOf(root, RULE)).toHaveLength(1);
  });
});
