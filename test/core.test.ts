import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { check } from '../src/core/check.js';
import { ConfigError, loadConfig } from '../src/core/config.js';
import { estimateTokens } from '../src/core/cost.js';
import { applyFixes, type FixFailure } from '../src/core/fix.js';
import { readDisables, toLines } from '../src/core/markdown.js';
import { toJson } from '../src/report/json.js';
import { renderTerminal } from '../src/report/terminal.js';
import { RULE_IDS } from '../src/rules/index.js';
import { EnvironmentError } from '../src/sandbox/types.js';
import { git, initGit, issuesOf, makeRepo, writeFiles } from './helpers.js';

/**
 * Switches for the node:fs stand-in below: a case-insensitive disk (macOS, Windows), and
 * permission errors for chosen paths (tests run as root, where chmod 000 does not stop reads).
 */
const fsHooks = vi.hoisted(() => ({
  caseInsensitive: false,
  denyRead: null as RegExp | null,
  denyDir: null as RegExp | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const path = await import('node:path');
  /** The real path that a case-insensitive disk would open for `p`. */
  const fold = (p: string): string => {
    if (real.existsSync(p)) return p;
    const parent = path.dirname(p);
    if (parent === p) return p;
    const base = path.basename(p).toLowerCase();
    const folded = fold(parent);
    try {
      const hit = real.readdirSync(folded).find((n) => n.toLowerCase() === base);
      return hit ? path.join(folded, hit) : p;
    } catch {
      return p;
    }
  };
  const ci = (p: unknown) => (fsHooks.caseInsensitive && typeof p === 'string' ? fold(p) : (p as string));
  const denied = (re: RegExp | null, p: unknown) => {
    if (re && typeof p === 'string' && re.test(p.replaceAll('\\', '/'))) {
      throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES', path: p });
    }
  };
  return {
    ...real,
    existsSync: (p: string) => real.existsSync(ci(p)),
    statSync: ((p: string, o?: object) => real.statSync(ci(p), o)) as typeof real.statSync,
    openSync: ((p: string, flags?: string, mode?: number) => {
      if (flags === undefined || flags === 'r') denied(fsHooks.denyRead, p);
      return real.openSync(ci(p), flags ?? 'r', mode);
    }) as typeof real.openSync,
    readdirSync: ((p: string, o?: object) => {
      denied(fsHooks.denyDir, p);
      return real.readdirSync(ci(p), o as never);
    }) as typeof real.readdirSync,
  };
});

describe('discovery', () => {
  it('finds every kind of setup file and knows what loads at start', () => {
    const root = makeRepo({
      'CLAUDE.md': '@docs/style.md',
      'docs/style.md': 'Style rules',
      'CLAUDE.local.md': 'mine',
      'packages/api/CLAUDE.md': 'api rules',
      '.claude/rules/always.md': '- always',
      '.claude/rules/scoped.md': '---\npaths: ["src/**"]\n---\n- scoped',
      '.claude/skills/s/SKILL.md': '---\ndescription: d\n---\nbody',
      '.claude/agents/a.md': '---\nname: a\n---\n',
      '.claude/commands/c.md': 'command',
      '.claude/settings.json': '{}',
      '.mcp.json': '{"mcpServers":{}}',
      'node_modules/pkg/CLAUDE.md': 'ignored',
    });
    const run = check(root, { config: { rules: {}, ignore: [] } });
    const files = Object.fromEntries(run.files.map((f) => [f.path, [f.kind, f.loadsAtStart]]));
    expect(files).toEqual({
      'CLAUDE.md': ['claude-md', true],
      'CLAUDE.local.md': ['claude-local-md', true],
      'packages/api/CLAUDE.md': ['claude-md', false],
      'docs/style.md': ['import', true],
      '.claude/rules/always.md': ['rule', true],
      '.claude/rules/scoped.md': ['rule', false],
      '.claude/skills/s/SKILL.md': ['skill', false],
      '.claude/agents/a.md': ['agent', false],
      '.claude/commands/c.md': ['command', false],
      '.claude/settings.json': ['settings', false],
      '.mcp.json': ['mcp', false],
    });
    expect(run.files[0]!.path).toBe('CLAUDE.local.md');
  });

  it('survives circular imports', () => {
    const root = makeRepo({ 'CLAUDE.md': '@a.md', 'a.md': '@b.md', 'b.md': '@a.md' });
    expect(() => check(root, { config: { rules: {}, ignore: [] } })).not.toThrow();
  });

  it('returns a perfect score and no files for a project with no setup', () => {
    const run = check(makeRepo({ 'README.md': '# hi' }), { config: { rules: {}, ignore: [] } });
    expect(run.files).toEqual([]);
    expect(run.health).toBe(10);
  });

  it('throws a clear error for a missing folder', () => {
    expect(() => check('/definitely/not/here')).toThrow('Folder not found');
  });
});

describe('fixes', () => {
  it('follows git renames and rewrites the path in the same style', () => {
    const root = makeRepo({
      'docs/old.md': '# guide',
      'src/a.ts': '',
      'CLAUDE.md': 'x',
    });
    initGit(root);
    git(root, 'mv', 'docs/old.md', 'docs/new.md');
    git(root, 'commit', '-qm', 'rename');
    writeFiles(root, { 'CLAUDE.md': '@docs/old.md\n- Read docs/old.md first\r\n- Also ./docs/old.md\r\n' });

    const run = check(root, { config: { rules: {}, ignore: [] } });
    expect(run.fixable).toBe(3);
    const applied = applyFixes(root, run.issues);
    expect(applied).toHaveLength(3);
    const text = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    // Each line keeps its own line ending: only the fixed text changes.
    expect(text).toBe('@docs/new.md\n- Read docs/new.md first\r\n- Also ./docs/new.md\r\n');
    expect(check(root, { config: { rules: {}, ignore: [] } }).errors).toBe(0);
  });

  it('skips a fix whose text changed since the check', () => {
    const root = makeRepo({ 'CLAUDE.md': '- See src/old/x.ts', 'src/new/x.ts': '' });
    const run = check(root, { config: { rules: {}, ignore: [] } });
    writeFiles(root, { 'CLAUDE.md': '- Rewritten by hand' });
    expect(applyFixes(root, run.issues)).toEqual([]);
  });
});

describe('config', () => {
  it('turns rules off and changes severity', () => {
    const root = makeRepo({
      'setupscore.yml': 'version: 1\nrules:\n  vague-rule: off\n  duplicate-rule: error\n',
      'CLAUDE.md': '- Write good code.\n- Put tests next to the file\n- Put tests next to the file\n',
    });
    const run = check(root);
    expect(run.config.source).toBe('setupscore.yml');
    expect(run.issues.map((i) => [i.rule, i.severity])).toEqual([['duplicate-rule', 'error']]);
  });

  it('ignores folders listed in "ignore"', () => {
    const root = makeRepo({
      '.setupscore.yml': 'version: 1\nignore:\n  - "examples/**"\n',
      'CLAUDE.md': '- ok rule here',
      'examples/demo/CLAUDE.md': '- Write good code.',
    });
    expect(check(root).files.map((f) => f.path)).toEqual(['CLAUDE.md']);
  });

  it('explains unknown rules and keys with a suggestion', () => {
    const root = makeRepo({ 'setupscore.yml': 'version: 1\nrules:\n  vague-rules: off\n' });
    expect(() => loadConfig(root, RULE_IDS)).toThrow(/unknown rule "vague-rules" \(did you mean "vague-rule"\?\)/);
    const root2 = makeRepo({ 'setupscore.yml': 'version: 1\nrule:\n  x: off\n' });
    expect(() => loadConfig(root2, RULE_IDS)).toThrow(/did you mean "rules"/);
    const root3 = makeRepo({ 'setupscore.yml': 'rules: {}\n' });
    expect(() => loadConfig(root3, RULE_IDS)).toThrow(ConfigError);
  });

  it('honours disable comments for one line or a whole file', () => {
    const root = makeRepo({
      'CLAUDE.md': '<!-- setupscore-disable-next-line vague-rule -->\n- Write good code.\n- Be careful.\n',
      '.claude/rules/x.md': '<!-- setupscore-disable -->\n- Write good code.\n',
    });
    expect(issuesOf(root).map((i) => i.line)).toEqual([3]);
  });
});

describe('docs', () => {
  it('document every rule in docs/rules.md and the table in docs/reference.md', () => {
    const docs = readFileSync(new URL('../docs/rules.md', import.meta.url), 'utf8');
    const reference = readFileSync(new URL('../docs/reference.md', import.meta.url), 'utf8');
    for (const id of RULE_IDS) {
      expect(docs, `docs/rules.md is missing "## ${id}"`).toContain(`## ${id}\n`);
      expect(reference, `docs/reference.md table is missing ${id}`).toContain(`| \`${id}\` |`);
    }
  });
});

describe('health score', () => {
  it('is 10 minus 1 per error and 0.5 per warning, never below 0', () => {
    const root = makeRepo({ 'CLAUDE.md': '- Write good code.\n- See src/missing.ts\n', 'src/a.ts': '' });
    const run = check(root, { config: { rules: {}, ignore: [] } });
    expect([run.errors, run.warnings, run.health]).toEqual([1, 1, 8.5]);
  });
});

// ---------------------------------------------------------------------------
// Regressions from the e2e round (bug ids from the tracker).
// ---------------------------------------------------------------------------

const NO_CONFIG = { config: { rules: {}, ignore: [] } };

describe('exact-case existence (M7, W10)', () => {
  it('flags src/Utils.ts for src/utils.ts even on a disk that ignores case', () => {
    const root = makeRepo({
      'CLAUDE.md': '- Helpers: src/Utils.ts\n- Guide: @Docs/Guide.md\n',
      'src/utils.ts': '',
      'docs/guide.md': '# g',
    });
    fsHooks.caseInsensitive = true;
    try {
      const issues = issuesOf(root);
      expect(issues.map((i) => i.rule).sort()).toEqual(['broken-import', 'broken-reference']);
    } finally {
      fsHooks.caseInsensitive = false;
    }
  });
});

describe('files that cannot be read (B18, F17)', () => {
  it('reports an unreadable CLAUDE.md, @import and .claude/ folder instead of skipping them', () => {
    const root = makeRepo({
      'CLAUDE.md': '# X\n\n@docs/rules.md\n',
      'docs/rules.md': '- Never use eval.\n',
      'packages/api/CLAUDE.md': '- api\n',
      '.claude/rules/a.md': '- a\n',
    });
    fsHooks.denyRead = /(docs\/rules\.md|packages\/api\/CLAUDE\.md)$/;
    fsHooks.denyDir = /\.claude$/;
    try {
      const issues = issuesOf(root, 'invalid-config');
      expect(issues.map((i) => i.file).sort()).toEqual(['.claude', 'docs/rules.md', 'packages/api/CLAUDE.md']);
      expect(issues.every((i) => /could not (?:read|open)/.test(i.message))).toBe(true);
    } finally {
      fsHooks.denyRead = null;
      fsHooks.denyDir = null;
    }
  });

  it('says "no permission" for an unreadable project folder or setupscore.yml, not "no setup files"', () => {
    const root = makeRepo({ 'CLAUDE.md': '# X\n', 'setupscore.yml': 'version: 1\n' });
    fsHooks.denyRead = /setupscore\.yml$/;
    try {
      expect(() => check(root)).toThrow(expect.objectContaining({ code: 'EACCES' }));
    } finally {
      fsHooks.denyRead = null;
    }
    // eslint-disable-next-line security/detect-non-literal-regexp -- test only: the temp folder that makeRepo made
    fsHooks.denyDir = new RegExp(`${root.replaceAll('\\', '/')}$`);
    try {
      expect(() => check(root, NO_CONFIG)).toThrow(expect.objectContaining({ code: 'EACCES' }));
    } finally {
      fsHooks.denyDir = null;
    }
  });

  it('skips FIFOs and devices named like setup files without blocking (F5)', () => {
    const root = makeRepo({ 'CLAUDE.md': 'Run npm run build\n@pipe.md\n', 'sub/package.json': '{"scripts":{}}' });
    execFileSync('mkfifo', [join(root, 'package.json')]);
    execFileSync('mkfifo', [join(root, 'pipe.md')]);
    mkdirSync(join(root, '.claude/rules'), { recursive: true });
    execFileSync('mkfifo', [join(root, '.claude/rules/fifo.md')]);
    symlinkSync('/dev/zero', join(root, '.claude/rules/zero.md'));
    const run = check(root, NO_CONFIG);
    expect(run.files.map((f) => f.path)).toEqual(['CLAUDE.md']);
  }, 30_000);

  it('gives a clear error for a setupscore.yml that is a FIFO, a folder, UTF-16 or holds bad ignore patterns', () => {
    if (process.platform !== 'win32') {
      // mkfifo makes no real FIFO on Windows.
      const fifo = makeRepo({ 'CLAUDE.md': 'x' });
      execFileSync('mkfifo', [join(fifo, 'setupscore.yml')]);
      expect(() => loadConfig(fifo, RULE_IDS)).toThrow(/not a regular file/);
    }
    const dir = makeRepo({ 'setupscore.yml/x': '' });
    expect(() => loadConfig(dir, RULE_IDS)).toThrow(/is a folder/);
    const utf16 = makeRepo({});
    writeFileSync(
      join(utf16, 'setupscore.yml'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('version: 1\n', 'utf16le')]),
    );
    expect(() => loadConfig(utf16, RULE_IDS)).toThrow(/UTF-16/);
    const empty = makeRepo({ 'setupscore.yml': 'version: 1\nignore: [""]\n' });
    expect(() => loadConfig(empty, RULE_IDS)).toThrow(ConfigError);
    const huge = makeRepo({ 'setupscore.yml': `version: 1\nignore: ["${'a'.repeat(70_000)}"]\n` });
    expect(() => loadConfig(huge, RULE_IDS)).toThrow(ConfigError);
  }, 30_000);

  it('never prints YAML warnings (they quote the file, secrets included)', () => {
    const root = makeRepo({
      '.claude/skills/s/SKILL.md':
        '---\nname: x\ndescription: !secret ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 deploy helper\n---\nSteps.\n',
    });
    const warn = vi.spyOn(process, 'emitWarning');
    try {
      check(root, NO_CONFIG);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('symlinked setup folders (real repos)', () => {
  it('follows .claude/skills linked to a folder in the repo, and reads relative paths from where the file really is', () => {
    const root = makeRepo({
      'CLAUDE.md': '# X\n',
      'skills/deploy/SKILL.md': `---\ndescription: Deploys. Use when asked.\n---\nToken ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8\nSee ../../contributing/guide.md\n`,
      'contributing/guide.md': '# guide',
    });
    mkdirSync(join(root, '.claude'));
    symlinkSync('../skills', join(root, '.claude/skills'));
    symlinkSync('..', join(root, '.claude/loop')); // a link to a folder that contains it: never followed
    const run = check(root, NO_CONFIG);
    expect(run.files.map((f) => f.path)).toContain('.claude/skills/deploy/SKILL.md');
    expect(run.issues.map((i) => i.rule)).toContain('secret');
    expect(run.issues.filter((i) => i.rule === 'broken-reference')).toEqual([]);
  });

  it('does not follow a link that leaves the repository', () => {
    const outside = makeRepo({ 'skills/x/SKILL.md': '---\ndescription: d\n---\n' });
    const root = makeRepo({ 'CLAUDE.md': '# X\n' });
    mkdirSync(join(root, '.claude'));
    symlinkSync(join(outside, 'skills'), join(root, '.claude/skills'));
    expect(check(root, NO_CONFIG).files.map((f) => f.path)).toEqual(['CLAUDE.md']);
  });
});

describe('markdown parsing', () => {
  it('ignores a disable comment shown inside a code block (B17)', () => {
    const { lines } = toLines('```markdown\n<!-- setupscore-disable -->\n```\n- Be careful.\n', false);
    expect(readDisables(lines).file.size).toBe(0);
  });

  it('splits old Mac line endings (CR only) into lines', () => {
    expect(toLines('a\rb\rc', false).lines.map((l) => l.text)).toEqual(['a', 'b', 'c']);
  });
});

describe('--fix', () => {
  it('rewrites the flagged occurrence, every occurrence, and $ signs literally (B01, B02)', () => {
    const root = makeRepo({
      'CLAUDE.md':
        '- Vendored: lib/src/a.ts; ours: src/a.ts\n- Twice: docs/twice.md then docs/twice.md again\n- See src/util.ts\n',
      'lib/src/a.ts': '',
      'src/x.ts': '',
      'guide/twice.md': '',
      'docs/other.md': '',
      'lib/$$/util.ts': '',
    });
    initGit(root);
    git(root, 'mv', 'src/x.ts', 'src/b.ts');
    git(root, 'commit', '-qm', 'rename');
    writeFiles(root, {
      'CLAUDE.md':
        '- Vendored: lib/src/a.ts; ours: src/x.ts\n- Twice: docs/twice.md then docs/twice.md again\n- See src/util.ts\n',
    });
    const run = check(root, NO_CONFIG);
    applyFixes(root, run.issues);
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe(
      '- Vendored: lib/src/a.ts; ours: src/b.ts\n- Twice: guide/twice.md then guide/twice.md again\n- See lib/$$/util.ts\n',
    );
    expect(applyFixes(root, check(root, NO_CONFIG).issues)).toEqual([]);
  });

  it('keeps a symlinked CLAUDE.md a link and leaves no temp files', () => {
    const root = makeRepo({ 'AGENTS.md': '- See src/old/x.ts\n', 'src/new/x.ts': '' });
    symlinkSync('AGENTS.md', join(root, 'CLAUDE.md'));
    applyFixes(root, check(root, NO_CONFIG).issues);
    expect(lstatSync(join(root, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe('- See src/new/x.ts\n');
    expect(readdirSync(root).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('fixes what it can and says which file could not be fixed (F4)', () => {
    const root = makeRepo({
      'CLAUDE.md': '- See src/old/x.ts\n',
      '.claude/rules/r.md': '- See src/old/x.ts\n',
      'src/new/x.ts': '',
    });
    const run = check(root, NO_CONFIG);
    rmSync(join(root, '.claude/rules/r.md'));
    const failures: FixFailure[] = [];
    expect(applyFixes(root, run.issues, failures)).toHaveLength(1);
    expect(failures).toEqual([{ file: '.claude/rules/r.md', reason: expect.stringContaining('removed') }]);
    writeFiles(root, { 'CLAUDE.md': '- See src/old/x.ts\n' });
    let thrown: unknown;
    try {
      applyFixes(root, run.issues);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(EnvironmentError);
    expect((thrown as Error).message).toMatch(
      /Fixed 1 problem in CLAUDE\.md, but could not fix \.claude\/rules\/r\.md/,
    );
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('- See src/new/x.ts\n');
  });
});

describe('reports', () => {
  it('shows issues even when no setup file was found, so --strict and the output agree (B21)', () => {
    const run = check(makeRepo({ '.env': 'A=1' }), NO_CONFIG);
    expect(run.issues).toHaveLength(1);
    const text = renderTerminal(run);
    expect(text).toContain('Claude can read .env');
    expect(text).not.toContain('No Claude Code setup files found');
  });

  it('adds summary.truncated and ruleErrors to the JSON report', () => {
    const boom = {
      id: 'boom',
      severity: 'error' as const,
      summary: '',
      why: '',
      check: () => {
        throw new Error('token=hunter2hunter2 \u001b[2J');
      },
    };
    const run = check(makeRepo({ 'CLAUDE.md': 'x' }), { ...NO_CONFIG, rules: [boom] });
    const json = toJson(run);
    expect(json.summary.truncated).toBe(false);
    expect(json.ruleErrors).toEqual([{ rule: 'boom', message: expect.not.stringContaining('hunter2hunter2') }]);
    expect(json.ruleErrors[0]!.message).not.toContain('\u001b');
  });

  it('counts the same tokens for CRLF and LF files (W13)', () => {
    expect(estimateTokens('a line\r\nanother\r\n')).toBe(estimateTokens('a line\nanother\n'));
  });
});

describe('speed on hostile input (fuzz, perf)', () => {
  const timed = (files: Record<string, string>) => {
    const root = makeRepo(files);
    const started = Date.now();
    const run = check(root, NO_CONFIG);
    return { run, ms: Date.now() - started };
  };
  const N = 32_000;

  it('checks 32,000-character lines quickly', () => {
    const { ms } = timed({
      'CLAUDE.md': [
        `:${' '.repeat(N)}x`,
        `**a**${'\t'.repeat(N)}x`,
        `- ${'!'.repeat(N)}x`,
        `@a${'.'.repeat(N)}b`,
        `x:${'`'.repeat(N)}\u0000`,
        '<!--'.repeat(N / 4),
        '<!-- setupscore-disable '.repeat(N / 22),
        `- never use a${'.'.repeat(N)}x`,
        `@a${'\r'.repeat(N)}\u0000`,
        `- ${'a/'.repeat(N / 2)}`,
        `password=${'a_'.repeat(N / 2)}`,
      ].join('\n'),
      '.claude/settings.json': `{${'\n'.repeat(N)}/`,
      '.claude/settings.local.json': JSON.stringify({ permissions: { allow: [`Bash(${' '.repeat(N)}x`] } }),
      'src/a.ts': '',
    });
    expect(ms).toBeLessThan(5000);
  }, 120_000);

  it('handles thousands of broken paths, rules, servers, permissions and secrets', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 3000; i++) files[`src/file${i}.ts`] = '';
    const refs = Array.from({ length: 3000 }, (_, i) => `- See src/gone${i}.ts`);
    const contra = [
      ...Array.from({ length: 1500 }, () => '- Never use foo'),
      ...Array.from({ length: 1500 }, () => '- Use foo'),
    ];
    const secrets = Array.from({ length: 4000 }, (_, i) => `- password=Secret${i}Value${i}`);
    files['CLAUDE.md'] = [...refs, ...contra].join('\n');
    files['.claude/rules/secrets.md'] = secrets.join('\n');
    files['.mcp.json'] = JSON.stringify(
      {
        mcpServers: Object.fromEntries(
          Array.from({ length: 4000 }, (_, i) => [`s${i}`, { command: 'npx', args: [`pkg${i}`] }]),
        ),
      },
      null,
      2,
    );
    files['.claude/settings.json'] = JSON.stringify(
      { permissions: { allow: Array.from({ length: 4000 }, (_, i) => `Bash(rm -rf dir${i})`) } },
      null,
      2,
    );
    const { run, ms } = timed(files);
    expect(run.issues.filter((i) => i.rule === 'contradiction')).toHaveLength(1);
    expect(run.issues.filter((i) => i.rule === 'broken-reference')).toHaveLength(3000);
    expect(ms).toBeLessThan(15_000);
  }, 300_000);
});
