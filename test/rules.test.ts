import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check } from '../src/core/check.js';
import { initGit, issuesOf, lint, makeRepo, PKG } from './helpers.js';

describe('broken-reference', () => {
  it('flags a path to a missing file in an existing folder', () => {
    const issues = lint('broken-reference', {
      'CLAUDE.md': '- Use the logger in src/common/logger.ts\n',
      'src/app.ts': '',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ file: 'CLAUDE.md', line: 1, severity: 'error' });
    expect(issues[0]!.message).toContain('src/common/logger.ts');
  });

  it('accepts paths that exist, from the root or from the file', () => {
    expect(
      lint('broken-reference', {
        'CLAUDE.md': '- See docs/guide.md and `src/app.ts`\n',
        'docs/guide.md': '',
        'src/app.ts': '',
        'pkg/CLAUDE.md': '- Edit ./lib/x.ts or lib/x.ts\n',
        'pkg/lib/x.ts': '',
      }),
    ).toEqual([]);
  });

  it('ignores URLs, globs, placeholders, build output, other packages and code blocks', () => {
    expect(
      lint('broken-reference', {
        'CLAUDE.md': [
          '- Docs: https://example.com/docs/guide.md and github.com/org/repo/file.md',
          '- Tests live in src/**/*.test.ts',
          '- Create src/features/<name>/index.ts for each feature',
          '- The build writes dist/index.js',
          '- Import react/jsx-runtime.js only through the bundler',
          '- Run one test with `vitest run src/path/to/test.test.ts` or src/foo/bar.ts',
          '```',
          'cat src/not-real.ts',
          '```',
        ].join('\n'),
        'src/app.ts': '',
      }),
    ).toEqual([]);
  });

  it('suggests a similar file as a hint, without an automatic fix', () => {
    const [issue] = lint('broken-reference', {
      'CLAUDE.md': '- Follow docs/api-guide.md\n',
      'docs/api-patterns.md': '',
    });
    expect(issue!.hint).toContain('docs/api-patterns.md');
    expect(issue!.fix).toBeUndefined();
  });

  it('offers a safe fix when the only file with that name moved', () => {
    const [issue] = lint('broken-reference', {
      'CLAUDE.md': '- Use src/utils/format-date.ts\n',
      'src/lib/format-date.ts': '',
    });
    expect(issue!.fix).toEqual({
      file: 'CLAUDE.md',
      line: 1,
      column: 7,
      from: 'src/utils/format-date.ts',
      to: 'src/lib/format-date.ts',
    });
  });
});

describe('broken-import', () => {
  it('flags a missing @import and accepts a real one', () => {
    const issues = lint('broken-import', {
      'CLAUDE.md': 'See @README.md and @docs/missing.md\n',
      'README.md': '# hi',
      'docs/other.md': '',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('@docs/missing.md');
  });

  it('resolves imports from the importing file, ignores code spans, emails and npm scopes', () => {
    expect(
      lint('broken-import', {
        'CLAUDE.md': 'Read @docs/a.md. Mail me@example.com. Install `@types/node`. Write `@not/real.md` literally.\n',
        'docs/a.md': 'Then @b.md\n',
        'docs/b.md': 'end',
      }),
    ).toEqual([]);
  });
});

describe('deep-import', () => {
  it('warns when imports are nested more than four levels', () => {
    const issues = lint('deep-import', {
      'CLAUDE.md': '@a.md',
      'a.md': '@b.md',
      'b.md': '@c.md',
      'c.md': '@d.md',
      'd.md': '@e.md',
      'e.md': 'deep',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ file: 'd.md' });
  });
});

describe('missing-script', () => {
  it('flags npm run with an unknown script and suggests the closest one', () => {
    const issues = lint('missing-script', {
      'package.json': PKG,
      'CLAUDE.md': '- Run `npm run tset` then `pnpm run build`\n```bash\nyarn run test:e2e\n```\n',
    });
    expect(issues.map((i) => i.message)).toEqual([
      expect.stringContaining('"npm run tset"'),
      expect.stringContaining('"test:e2e"'),
    ]);
    expect(issues[0]!.hint).toContain('Did you mean "test"');
  });

  it('accepts scripts from other workspace packages and filtered commands', () => {
    expect(
      lint('missing-script', {
        'package.json': PKG,
        'apps/web/package.json': JSON.stringify({ scripts: { storybook: 'storybook dev' } }),
        'CLAUDE.md': '- `npm run storybook`\n- `pnpm --filter api run seed`\n- `npm test`\n',
      }),
    ).toEqual([]);
  });

  it('flags npm test when there is no test script', () => {
    const issues = lint('missing-script', {
      'package.json': JSON.stringify({ scripts: { build: 'tsc' } }),
      'CLAUDE.md': 'Always run npm test.\n',
    });
    expect(issues).toHaveLength(1);
  });

  it('does nothing in a project without package.json', () => {
    expect(lint('missing-script', { 'CLAUDE.md': 'npm run anything' })).toEqual([]);
  });
});

describe('vague-rule', () => {
  it('flags short vague rules but not specific ones', () => {
    const issues = lint('vague-rule', {
      'CLAUDE.md': [
        '- Write good code.',
        '- Be careful with errors.',
        '- Follow best practices',
        '- Wrap every database call in try/catch and log failures with logger.error, as in best practices doc',
        '- Use 2-space indentation',
        '# Best practices',
      ].join('\n'),
    });
    expect(issues.map((i) => i.line)).toEqual([1, 2, 3]);
  });

  it('skips labels and task prompts in skills, agents and commands', () => {
    expect(
      lint('vague-rule', {
        'CLAUDE.md': '**Best Practices:**\n- Clean code:\n',
        '.claude/commands/review.md': '- Be thorough in your analysis\n',
        '.claude/agents/a.md':
          '---\nname: a\ndescription: Reviews code for problems before every merge request\n---\n- Be careful\n',
      }),
    ).toEqual([]);
  });
});

describe('contradiction', () => {
  it('flags a rule that does what another rule forbids', () => {
    const issues = lint('contradiction', {
      'CLAUDE.md':
        '- Use Prisma for all queries. Never write raw SQL.\n- For reports, use raw SQL because it is faster.\n',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ line: 2 });
  });

  it('finds contradictions across files loaded at start', () => {
    const issues = lint('contradiction', {
      'CLAUDE.md': '- Never use axios.\n',
      '.claude/rules/http.md': '- Use axios with a 10s timeout.\n',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.file).toBe('.claude/rules/http.md');
  });

  it('ignores prose paragraphs, which often wrap a sentence across lines', () => {
    expect(
      lint('contradiction', {
        'CLAUDE.md':
          'Workflow jobs that call Claude run with three protections.\nThe publish jobs hold credentials and do not call Claude.\n',
      }),
    ).toEqual([]);
  });

  it('reads tool names written as code: never use `npm` (backticks)', () => {
    for (const [no, yes] of [
      ['- Never use `npm`.', '- Use `npm` for installs.'],
      ['- Never use `npm`.', '- Use npm for installs.'],
      ['- Never use npm.', '- Use `npm` for installs.'],
      ['- Never use `raw SQL`.', '- For reports, use `raw SQL`.'],
    ])
      expect(lint('contradiction', { 'CLAUDE.md': `${no}\n${yes}\n` }), `${no} / ${yes}`).toHaveLength(1);
    for (const [no, yes] of [
      ['- Never use `npm`.', '- Use `pnpm` for installs.'],
      ['- Never use `npm` in production.', '- Use `npm` for local installs.'],
      ['- Never run `rm -rf /`.', '- Run `rm` on temp files only.'],
      // Cut short inside a code span: build is not test.
      ['- In CI, do not run `npm exec nx build`.', '- Prefer `npm exec nx test <project>`.'],
      ["- DON'T call `p.nextToken()` BEFORE.", '- ALWAYS call `p.nextToken()` AFTER.'],
    ])
      expect(lint('contradiction', { 'CLAUDE.md': `${no}\n${yes}\n` }), `${no} / ${yes}`).toEqual([]);
  });

  it('does not read a list of mistakes or a ❌ example as an instruction', () => {
    expect(
      lint('contradiction', {
        'CLAUDE.md':
          '- Do not add a `# Release` heading.\n\n## Common mistakes\n\n- Adding a `# Release` heading: the tag has the version.\n',
      }),
    ).toEqual([]);
    expect(lint('contradiction', { 'CLAUDE.md': '- Never use axios.\n- ❌ Use axios for requests.\n' })).toEqual([]);
    expect(lint('contradiction', { 'CLAUDE.md': '- Never use axios.\n- Bad: use axios for requests.\n' })).toEqual([]);
    // Under any other heading it is still a clash.
    expect(
      lint('contradiction', { 'CLAUDE.md': '- Never use axios.\n\n## HTTP\n\n- Use axios for requests.\n' }),
    ).toHaveLength(1);
  });

  it('accepts a rule that states its own exception', () => {
    expect(
      lint('contradiction', {
        'CLAUDE.md':
          '- Never use axios.\n- Use fetch instead of axios.\n- Use axios only in legacy/, never elsewhere.\n',
      }),
    ).toEqual([]);
  });
});

describe('contradiction and duplicate-rule: files that load together (loadContexts)', () => {
  const ROOT = '- Never use raw SQL.\n';
  it('compares a nested CLAUDE.md with the root one, and says when they meet', () => {
    const [issue, ...rest] = lint('contradiction', {
      'CLAUDE.md': ROOT,
      'packages/api/CLAUDE.md': '- For reports, use raw SQL.\n',
    });
    expect(rest).toEqual([]);
    expect(issue).toMatchObject({ file: 'packages/api/CLAUDE.md', line: 1 });
    expect(issue!.message).toContain('contradicts CLAUDE.md:1');
    expect(issue!.message).toContain('(both load when Claude works in packages/api/)');
  });

  it('compares a rule in a nested .claude/rules/ and a nested .claude/CLAUDE.md the same way', () => {
    expect(
      lint('contradiction', { 'CLAUDE.md': ROOT, 'pkg/.claude/rules/db.md': '- Use raw SQL for reports.\n' }),
    ).toHaveLength(1);
    expect(
      lint('contradiction', { 'CLAUDE.md': ROOT, 'pkg/.claude/CLAUDE.md': '- Use raw SQL for reports.\n' }),
    ).toHaveLength(1);
  });

  it('compares a paths: rule with CLAUDE.md when a file matches it', () => {
    const files = {
      'CLAUDE.md': ROOT,
      '.claude/rules/api.md': '---\npaths: src/api/**\n---\n- Use raw SQL for reports.\n',
    };
    const [issue, ...rest] = lint('contradiction', { ...files, 'src/api/report.ts': '' });
    expect(rest).toEqual([]);
    expect(issue!.message).toContain('(both load when Claude works on src/api/report.ts)');
  });

  it('compares a skill, a command and a subagent with CLAUDE.md', () => {
    const skill = lint('contradiction', {
      'CLAUDE.md': ROOT,
      '.claude/skills/report/SKILL.md': '---\nname: report\ndescription: d\n---\n- Use raw SQL for reports.\n',
    });
    expect(skill).toHaveLength(1);
    expect(skill[0]!.message).toContain('(both load when /report runs)');
    expect(
      lint('contradiction', { 'CLAUDE.md': ROOT, '.claude/commands/report.md': '- Use raw SQL for reports.\n' }),
    ).toHaveLength(1);
    const agent = lint('contradiction', {
      'CLAUDE.md': ROOT,
      '.claude/agents/db.md': '---\nname: db-helper\ndescription: d\n---\n- Use raw SQL for reports.\n',
    });
    expect(agent[0]!.message).toContain('(both load in the db-helper subagent)');
  });

  it('compares a subagent with the skills it preloads, and not with CLAUDE.md when it sets omitClaudeMd', () => {
    expect(
      lint('contradiction', {
        'CLAUDE.md': ROOT,
        '.claude/agents/db.md': '---\nname: db\ndescription: d\nomitClaudeMd: true\n---\n- Use raw SQL for reports.\n',
      }),
    ).toEqual([]);
    const preload = lint('contradiction', {
      '.claude/agents/db.md': '---\nname: db\ndescription: d\nskills:\n  - sql\n---\n- Never use raw SQL.\n',
      '.claude/skills/sql/SKILL.md': '---\nname: sql\ndescription: d\n---\n- Use raw SQL for reports.\n',
    });
    expect(preload).toHaveLength(1);
    expect(preload[0]!.message).toContain('in the db subagent');
  });

  it('does not compare files that never load together', () => {
    // Two sibling packages.
    expect(
      lint('contradiction', {
        'packages/a/CLAUDE.md': ROOT,
        'packages/b/CLAUDE.md': '- Use raw SQL for reports.\n',
      }),
    ).toEqual([]);
    // Two paths: rules with no file in common.
    expect(
      lint('contradiction', {
        '.claude/rules/a.md': '---\npaths: a/**\n---\n' + ROOT,
        '.claude/rules/b.md': '---\npaths: b/**\n---\n- Use raw SQL for reports.\n',
        'a/x.ts': '',
        'b/y.ts': '',
      }),
    ).toEqual([]);
    // Two skills: only one runs at a time.
    expect(
      lint('contradiction', {
        '.claude/skills/a/SKILL.md': '---\nname: a\ndescription: d\n---\n' + ROOT,
        '.claude/skills/b/SKILL.md': '---\nname: b\ndescription: d\n---\n- Use raw SQL for reports.\n',
      }),
    ).toEqual([]);
  });

  it('reads a name in backticks exactly (code is case-sensitive) and skips descriptions', () => {
    // `plan` (a command) is not "Plan mode".
    expect(
      lint('contradiction', { 'CLAUDE.md': '- Never run `plan` or `apply`.\n- Use Plan mode for big changes.\n' }),
    ).toEqual([]);
    expect(lint('contradiction', { 'CLAUDE.md': '- Never run `plan`.\n- Run plan before apply.\n' })).toHaveLength(1);
    // A checklist of mistakes written as "Creating ..." describes, it does not ask.
    expect(
      lint('contradiction', {
        'CLAUDE.md': '- Never create wrapper functions that only delegate.\n',
        'pkg/CLAUDE.md': '1. Creating wrapper functions that only delegate\n',
      }),
    ).toEqual([]);
  });

  it('reports copies between two files that meet on demand once per pair, with a count', () => {
    const rules = [
      '- Run the linter before every commit.',
      '- Keep every handler under fifty lines.',
      '- Log errors with the request id.',
    ];
    const issues = lint('duplicate-rule', {
      'CLAUDE.md': rules.join('\n') + '\n',
      '.claude/rules/api.md': '---\npaths: api/**\n---\n' + rules.join('\n') + '\n',
      'api/x.ts': '',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toBe(
      'Same rule as CLAUDE.md:1 (both load when Claude works on api/x.ts), and 2 more lines of this file repeat CLAUDE.md.',
    );
    // A line about the file itself is not a rule.
    expect(
      lint('duplicate-rule', {
        'CLAUDE.md': '- This file provides guidance to Claude Code when working here.\n',
        'pkg/CLAUDE.md': '- This file provides guidance to Claude Code when working here.\n',
      }),
    ).toEqual([]);
  });

  it('reports a start-up clash once, however many nested files there are', () => {
    const files: Record<string, string> = { 'CLAUDE.md': ROOT + '- Use raw SQL for reports.\n' };
    for (const p of ['a', 'b', 'c/d']) files[`packages/${p}/CLAUDE.md`] = '- Keep functions short.\n';
    const issues = lint('contradiction', files);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).not.toContain('both load');
  });

  it('leaves out imports past four hops: Claude Code never loads them', () => {
    const chain = (depth: number): Record<string, string> => {
      const files: Record<string, string> = { 'CLAUDE.md': ROOT + '@d1.md\n' };
      for (let i = 1; i < depth; i++) files[`d${i}.md`] = `@d${i + 1}.md\n`;
      files[`d${depth}.md`] = '- Use raw SQL for reports.\n';
      return files;
    };
    expect(lint('contradiction', chain(4))).toHaveLength(1);
    expect(lint('contradiction', chain(5))).toEqual([]);
  });

  it('finds the same rule in a nested CLAUDE.md and the root one, once', () => {
    const issues = lint('duplicate-rule', {
      'CLAUDE.md': '- Run the linter before every commit.\n',
      'packages/api/CLAUDE.md': '- Run the linter before every commit.\n',
      'packages/api/src/x.ts': '',
      'packages/api/test/y.ts': '',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ file: 'packages/api/CLAUDE.md', line: 1 });
    expect(issues[0]!.message).toBe('Same rule as CLAUDE.md:1 (both load when Claude works in packages/api/).');
    expect(
      lint('duplicate-rule', {
        'packages/a/CLAUDE.md': '- Run the linter before every commit.\n',
        'packages/b/CLAUDE.md': '- Run the linter before every commit.\n',
      }),
    ).toEqual([]);
  });
});

describe('duplicate-rule', () => {
  it('flags the same rule twice, ignoring case and list style', () => {
    const issues = lint('duplicate-rule', {
      'CLAUDE.md': '- Put tests next to the file\n\n* put tests next to the file.\n- Short one\n- Short one\n',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ line: 3 });
  });

  it('leaves skills alone, where repeated steps are often on purpose', () => {
    expect(
      lint('duplicate-rule', {
        '.claude/skills/s/SKILL.md':
          '---\ndescription: x\n---\n- Returns DTOs to the API\n\n## Summary\n- Returns DTOs to the API\n',
      }),
    ).toEqual([]);
  });
});

describe('too-long', () => {
  it('flags CLAUDE.md over 200 lines and skills over 500', () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `- rule ${i}`).join('\n');
    const issues = lint('too-long', {
      'CLAUDE.md': lines(201),
      '.claude/skills/big/SKILL.md': `---\ndescription: A big skill that does many things for testing purposes\n---\n${lines(450)}`,
    });
    expect(issues.map((i) => i.file)).toEqual(['CLAUDE.md']);
  });
});

describe('secret', () => {
  it('finds known key formats and assigned passwords, and masks them', () => {
    const issues = lint('secret', {
      'CLAUDE.md': '- Test login with password=bakery123\n- Key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456\n',
    });
    expect(issues).toHaveLength(2);
    for (const i of issues) {
      expect(i.message).not.toContain('bakery123');
      expect(i.message).not.toContain('abcdefghijklmnopqrstuvwxyz');
    }
  });

  it('ignores placeholders, variables and code references', () => {
    expect(
      lint('secret', {
        'CLAUDE.md': [
          '- password=${DB_PASSWORD}',
          '- token: <your-token>',
          '- apiKey = process.env.API_KEY',
          '- password: changeme',
          '- Set API_KEY=xxxxxxxx in .env',
        ].join('\n'),
      }),
    ).toEqual([]);
  });

  it('checks env and headers blocks in .mcp.json', () => {
    const issues = lint('secret', {
      '.mcp.json': JSON.stringify(
        {
          mcpServers: {
            a: { command: 'x', env: { MY_API_KEY: 'live-abcdef123456', OK: '${MY_KEY}', WRONG: '$MY_KEY' } },
            b: { type: 'http', url: 'https://x.dev', headers: { Authorization: 'Bearer abcdef1234567890' } },
          },
        },
        null,
        2,
      ),
    });
    expect(issues.map((i) => i.message)).toEqual([
      expect.stringContaining('"MY_API_KEY"'),
      expect.stringContaining('"Authorization"'),
    ]);
  });
});

describe('invalid-config', () => {
  it('reports broken JSON with a line number, and broken frontmatter', () => {
    const issues = lint('invalid-config', {
      '.claude/settings.json': '{\n  "permissions": {\n    "allow": ["Bash(ls)",]\n  }\n}\n',
      '.claude/skills/x/SKILL.md': '---\n- just: [a list\n  bad: {\n---\nBody\n',
    });
    expect(issues).toHaveLength(2);
    expect(issues.find((i) => i.file === '.claude/settings.json')).toMatchObject({
      line: 3,
      message: expect.stringContaining('trailing comma'),
    });
  });

  it('reads frontmatter as leniently as Claude Code does ("description: Use when: x")', () => {
    expect(
      lint('invalid-config', {
        '.claude/agents/r.md':
          '---\nname: r\ndescription: Use this agent when: reviewing. Examples: user: "hi"\n---\nBody\n',
      }),
    ).toEqual([]);
    expect(
      lint('agent-frontmatter', {
        '.claude/agents/r.md':
          '---\nname: r\ndescription: Use this agent when: reviewing pull requests for security. Examples: user: "hi"\n---\nBody\n',
      }),
    ).toEqual([]);
  });
});

describe('skill-frontmatter', () => {
  it('flags missing, short and invalid fields', () => {
    const issues = lint('skill-frontmatter', {
      '.claude/skills/a/SKILL.md': '---\nname: a\ndescription: Migrations.\n---\nDo it\n',
      '.claude/skills/b/SKILL.md': 'No frontmatter at all\n',
      '.claude/skills/c/SKILL.md':
        '---\nname: Bad_Name\ndescription: Creates database migrations and runs them. Use when changing the schema.\n---\nSteps\n',
      '.claude/skills/d/SKILL.md':
        '---\nname: d\ndescription: Creates database migrations and runs them. Use when changing the schema.\n---\n',
      '.claude/skills/good/SKILL.md':
        '---\nname: good\ndescription: Creates database migrations and runs them. Use when changing the schema.\n---\nSteps\n',
    });
    expect(issues.map((i) => i.file)).toEqual([
      '.claude/skills/a/SKILL.md',
      '.claude/skills/b/SKILL.md',
      '.claude/skills/c/SKILL.md',
      '.claude/skills/d/SKILL.md',
    ]);
  });
});

describe('agent-frontmatter', () => {
  it('flags subagents without a usable description', () => {
    const issues = lint('agent-frontmatter', {
      '.claude/agents/a.md': '---\nname: a\ndescription: Reviews\n---\n',
      '.claude/agents/b.md':
        '---\nname: b\ndescription: Reviews pull requests for security problems. Use after every change to auth code.\n---\n',
    });
    expect(issues.map((i) => i.file)).toEqual(['.claude/agents/a.md']);
  });
});

describe('risky-permission', () => {
  it('flags allow-all Bash, dangerous commands and bypassPermissions', () => {
    const issues = lint('risky-permission', {
      '.claude/settings.json': JSON.stringify(
        {
          permissions: {
            allow: ['Bash', 'Bash(rm -rf:*)', 'Bash(npm run test:*)', 'Read(src/**)'],
            defaultMode: 'bypassPermissions',
          },
        },
        null,
        2,
      ),
    });
    expect(issues).toHaveLength(3);
  });
});

describe('env-not-denied', () => {
  it('warns about .env without a deny rule, and stops when one exists', () => {
    expect(lint('env-not-denied', { 'CLAUDE.md': 'x', '.env': 'A=1', '.env.example': 'A=' })).toHaveLength(1);
    expect(
      lint('env-not-denied', {
        'CLAUDE.md': 'x',
        '.env': 'A=1',
        '.claude/settings.json': JSON.stringify({ permissions: { deny: ['Read(./.env)'] } }),
      }),
    ).toEqual([]);
    expect(lint('env-not-denied', { 'CLAUDE.md': 'x', '.env.example': 'A=' })).toEqual([]);
  });

  it('skips .env files committed to git, which are public config', () => {
    const root = makeRepo({ 'CLAUDE.md': 'x', '.env.production': 'VITE_URL=https://app.example.com' });
    initGit(root);
    expect(issuesOf(root, 'env-not-denied')).toEqual([]);
  });
});

describe('mcp-config', () => {
  it('flags unpinned servers, $VAR and plain http', () => {
    const issues = lint('mcp-config', {
      '.mcp.json': JSON.stringify(
        {
          mcpServers: {
            gh: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { T: '$GITHUB_TOKEN' } },
            pinned: { command: 'npx', args: ['-y', 'some-mcp@1.2.3'] },
            win: { command: 'cmd', args: ['/c', 'npx', '-y', 'other-mcp@latest'] },
            py: { command: 'uvx', args: ['mcp-server-fetch'] },
            local: { type: 'http', url: 'http://localhost:3000/mcp' },
            remote: { type: 'http', url: 'http://mcp.example.com/mcp' },
          },
        },
        null,
        2,
      ),
    });
    const msgs = issues.map((i) => i.message).join('\n');
    expect(issues).toHaveLength(5);
    expect(msgs).toContain('server-github');
    expect(msgs).toContain('$GITHUB_TOKEN');
    expect(msgs).toContain('with "@latest"');
    expect(issues.find((i) => i.message.includes('@latest'))!.hint).toContain('"other-mcp@1.2.3"');
    expect(msgs).toContain('mcp-server-fetch');
    expect(msgs).toContain('"remote"');
  });

  it('flags a file without mcpServers', () => {
    expect(lint('mcp-config', { '.mcp.json': '{"servers":{}}' })).toHaveLength(1);
  });
});

describe('unused-path-rule', () => {
  it('flags path-scoped rules that match nothing', () => {
    const issues = lint('unused-path-rule', {
      '.claude/rules/api.md': '---\npaths:\n  - "src/api/**/*.ts"\n---\n- Validate input\n',
      '.claude/rules/ui.md': '---\npaths: "src/ui/**/*.{ts,tsx}"\n---\n- Use the design system\n',
      'src/ui/Button.tsx': '',
    });
    expect(issues.map((i) => i.file)).toEqual(['.claude/rules/api.md']);
  });
});

// ---------------------------------------------------------------------------
// Regressions from the e2e round (bug ids from the tracker).
// ---------------------------------------------------------------------------

describe('broken-reference: what it now finds', () => {
  it('checks dot folders, .claude/ paths and paths in _italics_ (B07, B08)', () => {
    const issues = lint('broken-reference', {
      'CLAUDE.md': [
        '- CI: .github/workflows/release.yml',
        '- Skill: `.claude/skills/deploy/SKILL.md`',
        '- Italic _src/missing6.ts_ here.',
      ].join('\n'),
      '.github/workflows/ci.yml': '',
      'src/a.ts': '',
    });
    expect(issues.map((i) => i.message)).toEqual([
      expect.stringContaining('.github/workflows/release.yml'),
      expect.stringContaining('.claude/skills/deploy/SKILL.md'),
      expect.stringContaining('"src/missing6.ts"'),
    ]);
  });

  it('accepts existing dot-folder paths, personal files and underscores in names', () => {
    expect(
      lint('broken-reference', {
        'CLAUDE.md': [
          '- CI: .github/workflows/ci.yml',
          '- Your own settings go in .claude/settings.local.json (not committed).',
          '- Python: src/pkg/__init__.py and src/my_module/core_utils.py',
          '- Escaped in Markdown: src/my\\_file.ts',
        ].join('\n'),
        '.github/workflows/ci.yml': '',
        '.claude/settings.json': '{}',
        'src/pkg/__init__.py': '',
        'src/my_module/core_utils.py': '',
      }),
    ).toEqual([]);
  });

  it('checks paths with letters from any language, and look-alike letters (M9)', () => {
    const issues = lint('broken-reference', {
      'CLAUDE.md': '- Read docs/menü.md\n- Edit src/\u0430pp.ts\n- Then docs/café.md\n',
      'docs/caf\u0065\u0301.md': '', // decomposed (NFD) on disk, composed (NFC) in the text: the same name
      'src/app.ts': '',
    });
    expect(issues.map((i) => i.line)).toEqual([1, 2]);
  });

  it('checks Windows paths with backslashes and keeps them in the fix (W13)', () => {
    const issues = lint('broken-reference', {
      'CLAUDE.md': '- Old: src\\utils\\old.ts\n- Fine: src\\utils\\a.ts\n',
      'src/utils/a.ts': '',
      'src/lib/old.ts': '',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('src\\utils\\old.ts');
    expect(issues[0]!.fix).toMatchObject({ from: 'src\\utils\\old.ts', to: 'src\\lib\\old.ts' });
  });

  it('reads a path in a nested CLAUDE.md from its own folder first (B10)', () => {
    const [issue] = lint('broken-reference', {
      'packages/api/CLAUDE.md': '- The handler lives in src/handler.ts\n',
      'packages/api/src/server.ts': '',
      'src/a.ts': '',
    });
    expect(issue!.message).toContain('src/handler.ts');
    expect(issue!.hint).toContain('packages/api/src/server.ts');
  });

  it('explains a wrong letter case and fixes it safely (M7)', () => {
    const [issue] = lint('broken-reference', { 'CLAUDE.md': '- Helpers: src/Utils.ts\n', 'src/utils.ts': '' });
    expect(issue!.hint).toContain('letter case');
    expect(issue!.fix).toMatchObject({ from: 'src/Utils.ts', to: 'src/utils.ts' });
  });

  it('reports the same missing path once per place it is written, each with its own column (B02)', () => {
    const issues = lint('broken-reference', {
      'CLAUDE.md': '- docs/twice.md then docs/twice.md\n',
      'guide/twice.md': '',
      'docs/a.md': '',
    });
    expect(issues.map((i) => [i.column, i.fix?.column, i.fix?.to])).toEqual([
      [3, 3, 'guide/twice.md'],
      [22, 22, 'guide/twice.md'],
    ]);
  });

  it('skips templates, examples and git-ignored output (real repos)', () => {
    const root = makeRepo({
      'CLAUDE.md': [
        '- **Create** packages/browser/src/index.bundle.{FEATURE_COMBO}.ts',
        '- Name decisions by date, e.g. "Implements contributing/decisions/2025-06-15-use-sqlite.md"',
        '- Step 1 writes output/framework-updates-raw.json',
        '- But contributing/missing.md is really missing',
      ].join('\n'),
      '.gitignore': 'output/\n',
      'packages/browser/src/index.ts': '',
      'contributing/README.md': '',
      'output/.keep': '',
    });
    initGit(root);
    expect(issuesOf(root, 'broken-reference').map((i) => i.line)).toEqual([4]);
  });

  it('ignores lines too long to be instructions', () => {
    expect(lint('broken-reference', { 'CLAUDE.md': `${'x '.repeat(6000)} src/missing.ts\n`, 'src/a.ts': '' })).toEqual(
      [],
    );
  });
});

describe('broken-import: npm packages, backslashes and case', () => {
  it('leaves file paths inside npm packages alone (B09)', () => {
    expect(
      lint('broken-import', {
        'CLAUDE.md':
          '- Types come from @types/node/index.d.ts.\n- The preset lives in @babel/preset-env/lib/index.js.\n',
      }),
    ).toEqual([]);
  });

  it('still flags a missing import whose folder is not an npm scope', () => {
    expect(lint('broken-import', { 'CLAUDE.md': 'See @docs/missing.md\n', 'docs/a.md': '' })).toHaveLength(1);
  });

  it('flags a backslash import with a fix to forward slashes (W13)', () => {
    const [issue] = lint('broken-import', { 'CLAUDE.md': 'Read @docs\\guide.md first\n', 'docs/guide.md': '# g' });
    expect(issue!.message).toContain('backslashes');
    expect(issue!.fix).toEqual({
      file: 'CLAUDE.md',
      line: 1,
      column: 6,
      from: '@docs\\guide.md',
      to: '@docs/guide.md',
    });
  });

  it('flags an import in the wrong letter case (M7)', () => {
    const [issue] = lint('broken-import', { 'CLAUDE.md': '@Docs/Guide.md\n', 'docs/guide.md': '# g' });
    expect(issue!.hint).toContain('letter case');
    expect(issue!.fix).toMatchObject({ to: '@docs/guide.md' });
  });
});

describe('missing-script: monorepos and prose', () => {
  const MONO = {
    'package.json': JSON.stringify({ name: 'mono', scripts: { build: 'turbo build' } }),
    'packages/api/package.json': JSON.stringify({ name: 'api', scripts: { migrate: 'prisma migrate deploy' } }),
    'packages/web/package.json': JSON.stringify({
      name: 'web',
      scripts: { test: 'vitest run', storybook: 'storybook dev' },
    }),
  };

  it('flags npm test when only another package has a test script (B11)', () => {
    const issues = lint('missing-script', {
      ...MONO,
      'CLAUDE.md': '- Run `npm test` from the root before pushing.\n',
      'packages/api/CLAUDE.md': '- Run `npm test` to test the API.\n',
    });
    expect(issues.map((i) => i.file)).toEqual(['CLAUDE.md', 'packages/api/CLAUDE.md']);
    expect(issues[0]!.message).toContain('packages/web/package.json');
  });

  it('accepts scripts of the package a line names, and workspace scripts listed in the root file', () => {
    expect(
      lint('missing-script', {
        ...MONO,
        'CLAUDE.md': '- Migrations: `pnpm run migrate` (in the api package).\n- Stories: `npm run storybook`.\n',
        'packages/web/CLAUDE.md': '- Run `pnpm test` for unit tests.\n',
      }),
    ).toEqual([]);
  });

  it('does not read English after "npm run" as a script name (B12)', () => {
    expect(
      lint('missing-script', {
        'package.json': PKG,
        'CLAUDE.md': '- Use npm run with the --silent flag to hide logs.\n',
      }),
    ).toEqual([]);
  });

  it('reads a package.json saved with a byte order mark (B13, W3)', () => {
    const issues = lint('missing-script', { 'package.json': `\uFEFF${PKG}`, 'CLAUDE.md': '- Run `npm run nope`\n' });
    expect(issues).toHaveLength(1);
  });

  it('flags script names that are also object properties, and ignores non-text scripts (fuzz)', () => {
    const issues = lint('missing-script', {
      'package.json': '{"scripts": {"__proto__": {"build": 1}, "lint": ["eslint"]}}',
      'CLAUDE.md': 'Run npm run build, npm run lint, npm run constructor and npm run toString\n',
    });
    expect(issues.map((i) => i.message.match(/no "([^"]+)"/)![1])).toEqual([
      'build',
      'lint',
      'constructor',
      'toString',
    ]);
  });
});

describe('secret: fewer false alarms, more real keys', () => {
  it('does not flag types, form docs or documented examples (B03, B05)', () => {
    expect(
      lint('secret', {
        'CLAUDE.md': [
          '- Config shape: `{ apiKey: string; timeout: number }`',
          '- Signup fields: email: required, password: required (min 8 chars)',
          '- AWS docs example: AKIAIOSFODNN7EXAMPLE',
          '- GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
          '- ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
          '- secret: ./config/secret.json',
          '- DATABASE_URL=postgres://postgres:postgres@localhost:5432/app',
          '```ts',
          'interface Config {',
          '  authToken: number;',
          '}',
          '```',
        ].join('\n'),
      }),
    ).toEqual([]);
  });

  it('finds prefixed names, cloud keys, webhooks, JWTs and URL passwords (B04)', () => {
    const issues = lint('secret', {
      'CLAUDE.md': [
        '- Local database: DB_PASSWORD=Tr0ub4dorAndHorse9',
        '- aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYzQ8rT2pL9a',
        '- Temporary key ASIAZ7Q3VXK2M4N8P5RT',
        '- Stripe test: sk_test_4eC39HqLyjWDarjtT1zdp7dc',
        '- Webhook https://hooks.slack.com/services/T0001/B0002/abcdefghijklmnopqrstuvwx',
        '- JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTQyIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        '- DATABASE_URL=postgres://admin:Xk9#pLm2Qz7Rt4@db.internal:5432/app',
        '- SendGrid SG.abcdefghijklmnopqrstuv.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
        '-----BEGIN ENCRYPTED PRIVATE KEY-----',
      ].join('\n'),
    });
    expect(issues.map((i) => i.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(issues.map((i) => i.message).join('\n')).not.toMatch(/Tr0ub4dor|wJalrX|pLm2Qz7Rt4|hijklmnopqrstuvwx/);
  });

  it('writes "an API key", not "a api key" (B06)', () => {
    const [issue] = lint('secret', { 'CLAUDE.md': '- api_key = 9f8e7d6c5b4a3f2e1d0c\n' });
    expect(issue!.message).toContain('Looks like an API key');
  });

  it('ignores placeholders and notes in settings env blocks, and %VAR% in .mcp.json (W8)', () => {
    const env = {
      A_TOKEN: '********',
      B_TOKEN: '[REDACTED]',
      C_TOKEN: '{{ secrets.DEPLOY_KEY }}',
      D_TOKEN: 'pk_live_51H8aBcDeFgHiJkLmNoPqRsT',
      E_TOKEN: 'is passed in the header',
      F_TOKEN: 'process.env.OPENAI_API_KEY',
      G_TOKEN: 'test_key_for_ci',
      H_TOKEN: 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    };
    expect(
      lint('secret', {
        '.claude/settings.json': JSON.stringify({ env }, null, 2),
        '.mcp.json': JSON.stringify({
          mcpServers: { gh: { command: 'gh-mcp', env: { GITHUB_TOKEN: '%GITHUB_TOKEN%' } } },
        }),
      }),
    ).toEqual([]);
  });

  it('never prints the body of a private key held in an env block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecretbodysecretbody\n-----END RSA PRIVATE KEY-----';
    const [issue] = lint('secret', { '.claude/settings.json': JSON.stringify({ env: { API_TOKEN: pem } }) });
    expect(issue!.message).toContain('-----BEGIN RSA PRIVATE KEY-----');
    expect(issue!.message).not.toContain('secretbody');
  });
});

describe('no rule prints a secret or a control character (X1)', () => {
  const KEY = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const ANT = 'sk-ant-api03-n9RErxqZ9Vm0JwUaAb4-RbkT_PCwC82YbBsphsF2SQL';

  it('masks secrets quoted by any rule, in messages and hints', () => {
    const root = makeRepo({
      'CLAUDE.md': [
        `- Be careful with token ${KEY}`,
        `- Never use ${ANT}`,
        `- Use ${ANT}`,
        `- Run npm run ${KEY}`,
        '- be careful \u001b[2J\u001b]0;pwned\u0007 now',
      ].join('\n'),
      'package.json': PKG,
      '.claude/skills/s/SKILL.md': `---\nname: ${KEY}\ndescription: token ${ANT}\n---\nSteps.\n`,
      '.claude/skills/y/SKILL.md': `---\nname: *${KEY}\ndescription: x\n---\nSteps.\n`,
      '.claude/agents/a.md': `---\nname: a\ndescription: use ${ANT}\n---\n`,
      '.claude/rules/r.md': `---\npaths: token=${KEY}\n---\n- x\n`,
      '.claude/settings.json': JSON.stringify({
        permissions: { allow: [`Bash(curl -H "Authorization: Bearer ${ANT}" https://api.example.com)`] },
      }),
      '.mcp.json': JSON.stringify({ mcpServers: { s: { command: 'npx', args: [ANT] } } }),
    });
    const issues = issuesOf(root);
    const text = issues.map((i) => `${i.message} ${i.hint ?? ''}`).join('\n');
    expect(issues.length).toBeGreaterThan(8);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(ANT);
    expect(text).not.toContain(ANT.slice(0, 24));
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
  });
});

describe('contradiction: scope and blowups', () => {
  it('does not treat a scoped ban as a contradiction (B14)', () => {
    expect(
      lint('contradiction', {
        'CLAUDE.md': '- Never run migrations in production.\n- Run migrations with the migrate script.\n',
      }),
    ).toEqual([]);
  });

  it('still flags a rule that does the banned thing in the same scope', () => {
    const issues = lint('contradiction', {
      'CLAUDE.md': '- Never run migrations in production.\n- Run migrations in production with care.\n',
    });
    expect(issues).toHaveLength(1);
  });

  it('reports a repeated contradiction once, with a count (fuzz: 160,001 issues before)', () => {
    const lines = [
      ...Array.from({ length: 400 }, () => '- Never use foo'),
      ...Array.from({ length: 400 }, () => '- Use foo'),
    ];
    const issues = lint('contradiction', { 'CLAUDE.md': lines.join('\n') });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('798 more lines');
  });
});

describe('vague-rule: a vague opener followed by the real rule', () => {
  it('accepts "Be careful: <concrete rule>" (B15) but flags "Be careful."', () => {
    const issues = lint('vague-rule', {
      'CLAUDE.md': '- Be careful: run migrations on staging first.\n- Be careful.\n',
    });
    expect(issues.map((i) => i.line)).toEqual([2]);
  });
});

describe('duplicate-rule: footers and lead-ins', () => {
  it('ignores repeated link footers and lead-ins that end with a colon', () => {
    expect(
      lint('duplicate-rule', {
        'CLAUDE.md': 'x',
        '.claude/rules/a.md':
          '- Keep handlers small\n\nReference: [Engineering Blog](https://example.com/blog/post)\n**Make it normal to challenge poor decisions, respectfully:**\n',
        '.claude/rules/b.md':
          '- Keep tests close\n\nReference: [Engineering Blog](https://example.com/blog/post)\n**Make it normal to challenge poor decisions, respectfully:**\n',
      }),
    ).toEqual([]);
  });

  it('still flags a real rule written twice', () => {
    expect(
      lint('duplicate-rule', {
        'CLAUDE.md':
          '- See [the guide](https://x.dev) before you change the public API\n- See [the guide](https://x.dev) before you change the public API\n',
      }),
    ).toHaveLength(1);
  });
});

describe('env-not-denied: nested files and real patterns', () => {
  it('finds .env files in package folders (B16) and suggests a pattern for every folder', () => {
    const [issue] = lint('env-not-denied', {
      'CLAUDE.md': 'x',
      'packages/api/.env': 'A=1',
      '.claude/settings.json': JSON.stringify({ permissions: { deny: ['Read(./.env)'] } }),
    });
    expect(issue!.message).toContain('packages/api/.env');
    expect(issue!.hint).toContain('**/.env');
  });

  it('accepts a deny pattern that covers every folder', () => {
    expect(
      lint('env-not-denied', {
        'CLAUDE.md': 'x',
        '.env': 'A=1',
        'packages/api/.env.local': 'A=1',
        '.claude/settings.json': JSON.stringify({ permissions: { deny: ['Read(**/.env)', 'Read(**/.env.*)'] } }),
      }),
    ).toEqual([]);
  });

  it('does not count backslash patterns or Bash rules as protection (W13)', () => {
    expect(
      lint('env-not-denied', {
        'CLAUDE.md': 'x',
        '.env': 'A=1',
        '.claude/settings.json': JSON.stringify({ permissions: { deny: ['Read(.\\.env)', 'Bash(cat .env)'] } }),
      }),
    ).toHaveLength(1);
  });
});

describe('mcp-config: Windows and shells', () => {
  const servers = (s: Record<string, unknown>) => ({ '.mcp.json': JSON.stringify({ mcpServers: s }, null, 2) });

  it('warns about %VAR% outside cmd.exe and names the right variable for $env:X (W8, W13)', () => {
    const issues = lint(
      'mcp-config',
      servers({
        a: { command: 'gh-mcp', env: { GITHUB_TOKEN: '%GITHUB_TOKEN%' } },
        b: { command: 'srv', args: ['--url', '%API_URL%'] },
        c: { command: 'gh-mcp', env: { TOKEN: '$env:TOKEN' } },
      }),
    );
    expect(issues.map((i) => i.hint)).toEqual([
      'Write "${GITHUB_TOKEN}" instead.',
      'Write "${API_URL}" instead.',
      'Write "${TOKEN}" instead.',
    ]);
  });

  it('accepts %VAR% in arguments that cmd.exe runs, and $VAR inside a shell command string', () => {
    expect(
      lint(
        'mcp-config',
        servers({
          a: { command: 'cmd', args: ['/c', 'my-server', '--token', '%TOKEN%'] },
          b: { command: 'bash', args: ['-c', 'my-server --token "$TOKEN"'] },
        }),
      ),
    ).toEqual([]);
  });

  it('finds unpinned npx behind cmd /d /s /c, npx.cmd, a full path and bash -c (W13)', () => {
    const issues = lint(
      'mcp-config',
      servers({
        a: { command: 'cmd', args: ['/c', 'npx.cmd', 'pkg-a'] },
        b: { command: 'C:\\Program Files\\nodejs\\npx.cmd', args: ['-y', 'pkg-b'] },
        c: { command: 'cmd', args: ['/d', '/s', '/c', 'npx', 'pkg-c'] },
        d: { command: 'bash', args: ['-lc', 'cd tools && npx -y pkg-d --port 3000'] },
        e: { command: 'bash', args: ['-c', 'npx -y pkg-e@1.2.3'] },
      }),
    );
    expect(issues.map((i) => i.message.match(/pkg-\w/)![0])).toEqual(['pkg-a', 'pkg-b', 'pkg-c', 'pkg-d']);
  });
});

describe('risky-permission: shells and slow patterns', () => {
  it('flags shells with a wildcard (W13)', () => {
    const issues = lint('risky-permission', {
      '.claude/settings.json': JSON.stringify({
        permissions: {
          allow: ['Bash(powershell:*)', 'Bash(cmd /c:*)', 'Bash(bash -c *)', 'Bash(Remove-Item:*)', 'Bash(rmdir /s:*)'],
        },
      }),
    });
    expect(issues).toHaveLength(5);
  });

  it('accepts exact commands and ordinary wildcards', () => {
    expect(
      lint('risky-permission', {
        '.claude/settings.json': JSON.stringify({
          permissions: {
            allow: ['Bash(npm run build:*)', 'Bash(bash scripts/check.sh)', 'Bash(shellcheck:*)', 'Bash(rmdir build)'],
          },
        }),
      }),
    ).toEqual([]);
  });

  it('checks "Bash(" followed by thousands of spaces quickly (fuzz: cubic regex)', () => {
    const started = Date.now();
    const issues = lint('risky-permission', {
      '.claude/settings.json': JSON.stringify({
        permissions: { allow: [`Bash(${' '.repeat(3000)}x`, `Bash(${' '.repeat(3000)})`] },
      }),
    });
    expect(issues).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 60_000);
});

describe('invalid-config: clear JSON messages and unreadable files', () => {
  it('names comments, newlines in strings and Windows backslashes, with the right line (B23)', () => {
    const issues = lint('invalid-config', {
      '.claude/settings.json': '{\n  // allow\n  "permissions": {}\n}',
      '.claude/settings.local.json': '{\n"a": "\u00e9\u00e9\u00e9\u00e9\u00e9\u{1F600}",\n"b": tru\n}',
      '.mcp.json': '{ "mcpServers": { "a": { "command": "C:\\Tools\\srv.exe" } } }',
    });
    const byFile = Object.fromEntries(issues.map((i) => [i.file, [i.line, i.message]]));
    expect(byFile['.claude/settings.json']).toEqual([2, expect.stringContaining('comments are not allowed')]);
    expect(byFile['.claude/settings.local.json']![0]).toBe(3);
    expect(byFile['.mcp.json']![1]).toContain('backslash');
  });

  it('says a UTF-16 file must be saved as UTF-8 (W13)', () => {
    const utf16 = (s: string) =>
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]).toString('latin1');
    const root = makeRepo({});
    writeFileSync(join(root, 'CLAUDE.md'), Buffer.from(utf16('- Use pnpm\n'), 'latin1'));
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude/settings.json'), Buffer.from(utf16('{"permissions":{}}'), 'latin1'));
    const issues = issuesOf(root, 'invalid-config');
    expect(issues.map((i) => i.file).sort()).toEqual(['.claude/settings.json', 'CLAUDE.md']);
    expect(issues[0]!.message).toContain('UTF-16');
  });
});

describe('too-long: files too big to read', () => {
  it('reports a setup file over 2 MB instead of skipping it (B18, F17)', () => {
    const issues = lint('too-long', { 'CLAUDE.md': `- rule\n${'x'.repeat(2.2 * 1024 * 1024)}` });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('too big');
  });
});

describe('unused-path-rule: odd globs', () => {
  it('does not crash on a 70,000-character glob, and still checks normal ones', () => {
    const issues = lint('unused-path-rule', {
      '.claude/rules/huge.md': `---\npaths: "${'a'.repeat(70_000)}"\n---\n- x\n`,
      '.claude/rules/file.md': '---\npaths: src/app.ts\n---\n- x\n',
      '.claude/rules/gone.md': '---\npaths: src/gone/**\n---\n- x\n',
      '.claude/rules/escaped.md': '---\npaths: "app/\\\\[id\\\\]/**"\n---\n- x\n',
      'src/app.ts': '',
      'app/[id]/page.tsx': '',
    });
    expect(issues.map((i) => i.file)).toEqual(['.claude/rules/gone.md']);
  });
});

// How Claude Code matches `paths:` (code.claude.com/docs/en/memory, "Path-specific rules"): a pattern
// without a slash matches a file name at any depth, a leading slash anchors it to the base folder,
// and any other slash anchors it too. The base folder is the one that holds the rule's .claude/.
describe('unused-path-rule: patterns match the way Claude Code matches them', () => {
  // [rule folder, paths value, files in the repo, flagged?]
  const cases: [string, string, string[], boolean][] = [
    // Patterns without a slash match a file name at any depth.
    ['', '*.mdx', ['docs/guide/a.mdx'], false],
    ['', '*.mdx', ['a.mdx'], false],
    ['', '*.mdx', ['src/a.ts'], true],
    ['', '*.test.ts', ['src/deep/a.test.ts'], false],
    ['', '*.test.ts', ['src/a.ts'], true],
    ['', '*.{ts,tsx}', ['web/app/b.tsx'], false],
    ['', '*.{ts,tsx}', ['web/app/b.js'], true],
    ['', 'Dockerfile', ['Dockerfile'], false],
    ['', 'Dockerfile', ['services/api/Dockerfile'], false],
    ['', 'Dockerfile', ['Dockerfile.dev'], true],
    ['', 'package.json', ['packages/a/package.json'], false],
    ['', '*.yml', ['.github/workflows/ci.yml'], false],
    ['', '*', ['a/b/c.txt'], false],
    ['', '**', ['a.txt'], false],
    // A leading slash anchors the pattern to the base folder.
    ['', '/*.mdx', ['a.mdx'], false],
    ['', '/*.mdx', ['docs/a.mdx'], true],
    ['', '/Dockerfile', ['services/api/Dockerfile'], true],
    ['', '/src/*.ts', ['src/a.ts'], false],
    ['', '/src/*.ts', ['x/src/a.ts'], true],
    // Any other slash anchors the pattern too.
    ['', 'src/*.ts', ['src/a.ts'], false],
    ['', 'src/*.ts', ['pkg/src/a.ts'], true],
    ['', 'src/*.ts', ['src/deep/a.ts'], true],
    ['', 'src/components/*.tsx', ['src/components/a.tsx'], false],
    ['', 'src/components/*.tsx', ['src/components/x/a.tsx'], true],
    ['', 'src/components/*.tsx', ['other/src/components/a.tsx'], true],
    ['', 'src/**/*', ['src/a/b.ts'], false],
    ['', 'src/**/*', ['lib/a.ts'], true],
    ['', '**/*.ts', ['a/b/c.ts'], false],
    ['', '**/*.ts', ['c.ts'], false],
    ['', '**/*.ts', ['c.js'], true],
    ['', 'src/api/**/*.ts', ['src/api/v1/a.ts'], false],
    ['', 'src/api/**/*.ts', ['src/api/a.ts'], false],
    ['', 'src/api/**/*.ts', ['src/server/a.ts'], true],
    ['', 'src/**/*.{ts,tsx}', ['src/x/y.tsx'], false],
    ['', '{src,lib}/*.ts', ['lib/a.ts'], false],
    ['', '{src,lib}/*.ts', ['app/a.ts'], true],
    ['', 'tests/**/*.test.ts', ['tests/unit/a.test.ts'], false],
    ['', '.github/**', ['.github/workflows/ci.yml'], false],
    ['', './src/*.ts', ['src/a.ts'], false],
    // Several patterns: the rule loads when any one matches.
    ['', 'src/gone/**, *.mdx', ['docs/a.mdx'], false],
    ['', 'src/gone/**, lib/gone/**', ['a.mdx'], true],
    // Folders setupscore does not walk cannot be checked, so they are never flagged.
    ['', 'node_modules/**', [], false],
    ['', '/node_modules/**', [], false],
    ['', 'dist/**', [], false],
    // A rule in pkg/.claude/rules/ is relative to pkg/.
    ['pkg/', '*.mdx', ['pkg/docs/a.mdx'], false],
    ['pkg/', '*.mdx', ['other/a.mdx'], true],
    ['pkg/', '*.mdx', ['a.mdx'], true],
    ['pkg/', '/*.mdx', ['pkg/a.mdx'], false],
    ['pkg/', '/*.mdx', ['pkg/docs/a.mdx'], true],
    ['pkg/', 'src/*.ts', ['pkg/src/a.ts'], false],
    ['pkg/', 'src/*.ts', ['src/a.ts'], true],
    ['pkg/', '**/*.ts', ['pkg/a/b.ts'], false],
    ['pkg/', '**/*.ts', ['other/b.ts'], true],
    ['pkg/', 'Dockerfile', ['pkg/deploy/Dockerfile'], false],
    ['pkg/', 'Dockerfile', ['deploy/Dockerfile'], true],
  ];
  it.each(cases)('rule in "%s.claude/rules", paths %s, files %j: flagged %s', (dir, paths, present, flagged) => {
    const files: Record<string, string> = { [`${dir}.claude/rules/r.md`]: `---\npaths: "${paths}"\n---\n- x\n` };
    for (const f of present) files[f] = '';
    expect(lint('unused-path-rule', files).length).toBe(flagged ? 1 : 0);
  });

  it('counts the rule file itself: "*.md" always matches its own .md file', () => {
    expect(lint('unused-path-rule', { '.claude/rules/r.md': '---\npaths: "*.md"\n---\n- x\n' })).toEqual([]);
  });
});

describe('skill-frontmatter: odd YAML', () => {
  it('survives a circular alias and shortens very long names', () => {
    const issues = lint('skill-frontmatter', {
      '.claude/skills/a/SKILL.md':
        '---\nname: &a [*a]\ndescription: Creates database migrations. Use when the schema changes in any way.\n---\nSteps.\n',
      '.claude/skills/b/SKILL.md': `---\nname: ${'X'.repeat(10_000)}\ndescription: Creates database migrations. Use when the schema changes in any way.\n---\nSteps.\n`,
    });
    expect(issues).toHaveLength(2);
    for (const i of issues) expect(i.message.length).toBeLessThan(300);
  });
});

describe('misnamed-file', () => {
  it('warns about wrong letter case and loose skill files (M10, W10)', () => {
    const found = (files: Record<string, string>) =>
      lint('misnamed-file', files).map((i) => [
        i.file,
        i.message.match(/"([^"]+)", not/)?.[1] ?? i.message.match(/\(([^()]+)\)/)?.[1],
      ]);
    // Two projects: on macOS and Windows .Claude/ and .claude/ would be the same folder.
    expect(found({ 'claude.md': '- rules', '.Claude/settings.json': '{}', '.Claude/rules/a.md': '- a' })).toEqual([
      ['.Claude', '.claude'],
      ['claude.md', 'CLAUDE.md'],
    ]);
    expect(
      found({
        '.claude/skills/deploy/skill.md': '---\ndescription: d\n---\n',
        '.claude/skills/release.md': '# Release',
      }),
    ).toEqual([
      ['.claude/skills/deploy/skill.md', '.claude/skills/deploy/SKILL.md'],
      ['.claude/skills/release.md', '.claude/skills/release/SKILL.md'],
    ]);
  });

  it('leaves correctly named files, notes about Claude and AppleDouble files alone (M8)', () => {
    const root = makeRepo({
      'CLAUDE.md': '- rules',
      'docs/claude.md': '# How we use the Claude API',
      '.claude/skills/deploy/SKILL.md':
        '---\ndescription: Deploys the app to staging. Use when asked to deploy.\n---\nSteps.\n',
      '.claude/skills/deploy/reference.md': '# ref',
      '.claude/skills/README.md': '# Skills',
      '.claude/rules/._style.md': '\u0000\u0005\u0016\u0007Mac OS X',
      '.claude/agents/._reviewer.md': '\u0000\u0005\u0016\u0007',
    });
    expect(issuesOf(root, 'misnamed-file')).toEqual([]);
    const files = check(root, { config: { rules: {}, ignore: [] } }).files.map((f) => f.path);
    expect(files.some((f) => f.includes('._'))).toBe(false);
  });
});

describe('unused-path-rule: Unicode names', () => {
  it('matches a composed name in paths: against a decomposed folder name on disk (macOS)', () => {
    expect(
      lint('unused-path-rule', {
        '.claude/rules/cafe.md': '---\npaths: "docs/café/**"\n---\n- x\n',
        'docs/café/menu.md': '',
      }),
    ).toEqual([]);
  });
});
