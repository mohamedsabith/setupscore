import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mdText, renderRunMarkdown } from '../src/report/run.js';
import { scoreRun } from '../src/run/score.js';
import { applySetup, snapshotSetup } from '../src/run/setups.js';
import type { RunRecord } from '../src/run/store.js';
import { applySuggestion, suggest, trimEnd, type Suggestion } from '../src/run/suggest.js';
import { Workspace } from '../src/tasks/workspace.js';
import { git, initGit, makeRepo, writeFiles } from './helpers.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const fake = (mode: string, ...extra: string[]) => `node ${JSON.stringify(FAKE)} ${mode} ${extra.join(' ')}`.trim();
const CACHE = process.env.SETUPSCORE_CACHE_DIR ?? join(tmpdir(), 'fix-setups-reports', 'cache');

function cli(args: string[], env: Record<string, string | undefined> = {}) {
  const merged: Record<string, string | undefined> = {
    ...process.env,
    NO_COLOR: '1',
    FORCE_COLOR: undefined,
    ANTHROPIC_API_KEY: 'sk-ant-test-not-real',
    SETUPSCORE_RETRY_BASE_MS: '20',
    SETUPSCORE_CACHE_DIR: CACHE,
    ...env,
  };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: merged as NodeJS.ProcessEnv,
    timeout: 400_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const commit = (root: string, files: Record<string, string>, msg: string) => {
  writeFiles(root, files);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', msg);
};

const quiet = () => {
  const warnings: string[] = [];
  return { warnings, warn: (m: string) => warnings.push(m) };
};

describe('what a setup holds (C3, C5)', () => {
  /** Old setup at the first commit; the current one has a skill with a reference file and a hook script. */
  function repo(): string {
    const root = makeRepo({
      'CLAUDE.md': '# Old\n',
      '.claude/skills/old/SKILL.md': '---\nname: old\ndescription: Old. Use when old.\n---\nOld\n',
      '.claude/skills/old/helper.md': 'old helper\n',
      '.claude/hooks/old-hook.sh': '#!/bin/sh\necho old\n',
      'CLAUDE.local.md': 'old personal\n',
      'src/a.js': 'export const a = 1;\n',
    });
    initGit(root);
    git(root, 'rm', '-rq', '.claude', 'CLAUDE.local.md');
    commit(
      root,
      {
        'CLAUDE.md': '# New\n',
        '.claude/settings.json': JSON.stringify({
          hooks: {
            PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: '.claude/hooks/check.sh' }] }],
          },
        }),
        '.claude/skills/testing/SKILL.md':
          '---\nname: testing\ndescription: Tests. Use when testing.\n---\nSee reference.md\n',
        '.claude/skills/testing/reference.md': 'the reference\n',
        '.claude/skills/testing/scripts/run.py': 'print(1)\n',
        '.claude/hooks/check.sh': '#!/bin/sh\necho check\n',
        '.mcp.json': '{"mcpServers":{}}\n',
        'scripts/build/CLAUDE.md': '# Build scripts\n',
        'vendor/lib/CLAUDE.md': '# Vendored\n',
        '.gitignore': 'dist/\n',
      },
      'New setup',
    );
    chmodSync(join(root, '.claude/hooks/check.sh'), 0o755);
    git(root, 'update-index', '--chmod=+x', '.claude/hooks/check.sh'); // Windows files have no executable bit
    git(root, 'commit', '-qm', 'Hook is executable');
    // Personal and ignored files that are not part of the setup.
    writeFiles(root, {
      '.claude/settings.local.json': '{}',
      'CLAUDE.local.md': 'mine\n',
      'dist/CLAUDE.md': '# built\n',
      'node_modules/pkg/CLAUDE.md': '# a package\n',
    });
    return root;
  }

  // Reads the executable bit from disk, which Windows does not have.
  posixOnly('copies whole skill folders and hook scripts (executable), never personal files', async () => {
    const root = repo();
    for (const source of ['working', 'HEAD']) {
      const s = await snapshotSetup(root, source, 'A', quiet().warn);
      expect(Object.keys(s.files)).toEqual(
        expect.arrayContaining([
          '.claude/skills/testing/reference.md',
          '.claude/skills/testing/scripts/run.py',
          '.claude/hooks/check.sh',
          '.claude/settings.json',
          '.mcp.json',
          'CLAUDE.md',
        ]),
      );
      expect(s.executable).toEqual(['.claude/hooks/check.sh']);
      expect(Object.keys(s.files).filter((f) => /local|node_modules|^dist\//.test(f))).toEqual([]);
    }
  });

  it('working and a ref agree, also for setup files inside build/ or vendor/ folders', async () => {
    const root = repo();
    const working = await snapshotSetup(root, 'working', 'A', quiet().warn);
    const head = await snapshotSetup(root, 'HEAD', 'B', quiet().warn);
    expect(Object.keys(working.files).sort()).toEqual(Object.keys(head.files).sort());
    expect(working.files['scripts/build/CLAUDE.md']).toBe('# Build scripts\n');
    expect(working.files['vendor/lib/CLAUDE.md']).toBe('# Vendored\n');
  });

  it("removes every kind of setup file the task's commit has before placing the setup", async () => {
    const root = repo();
    const setup = await snapshotSetup(root, 'working', 'A', quiet().warn);
    const ws = await Workspace.create(root);
    try {
      const first = git(root, 'rev-list', '--max-parents=0', 'HEAD').trim();
      await ws.checkout(first);
      writeFiles(ws.dir, { 'CLAUDE.local.md': 'committed personal\n' });
      expect(existsSync(join(ws.dir, '.claude/skills/old/helper.md'))).toBe(true);
      applySetup(ws.dir, setup);
      expect(existsSync(join(ws.dir, '.claude/skills/old/helper.md'))).toBe(false);
      expect(existsSync(join(ws.dir, '.claude/skills/old/SKILL.md'))).toBe(false);
      expect(existsSync(join(ws.dir, '.claude/hooks/old-hook.sh'))).toBe(false);
      expect(existsSync(join(ws.dir, 'CLAUDE.local.md'))).toBe(false);
      expect(readFileSync(join(ws.dir, '.claude/skills/testing/reference.md'), 'utf8')).toBe('the reference\n');
      expect(statSync(join(ws.dir, '.claude/hooks/check.sh')).mode & 0o111).not.toBe(0);
      expect(readFileSync(join(ws.dir, 'CLAUDE.md'), 'utf8')).toBe('# New\n');
      expect(readFileSync(join(ws.dir, 'src/a.js'), 'utf8')).toContain('a = 1');

      // "none" leaves no instructions at all.
      applySetup(ws.dir, { label: 'baseline', source: 'none', files: {} });
      expect(readdirSync(ws.dir).filter((f) => /CLAUDE|\.claude|\.mcp/.test(f))).toEqual([]);
    } finally {
      ws.close();
    }
  });

  it('never writes outside the repository or anything but setup files, whatever run.json says', async () => {
    const root = makeRepo({ 'a.txt': 'a\n' });
    initGit(root);
    const ws = await Workspace.create(root);
    try {
      await ws.checkout(ws.head!);
      applySetup(ws.dir, {
        label: 'A',
        source: 'x',
        files: { '../../evil/CLAUDE.md': 'x', 'src/index.js': 'x', '.git/hooks/pre-commit': 'x', 'CLAUDE.md': 'ok' },
      });
      expect(existsSync(join(ws.base, 'evil'))).toBe(false);
      expect(existsSync(join(ws.dir, 'src/index.js'))).toBe(false);
      expect(existsSync(join(ws.dir, '.git/hooks/pre-commit'))).toBe(false);
      expect(readFileSync(join(ws.dir, 'CLAUDE.md'), 'utf8')).toBe('ok');
    } finally {
      ws.close();
    }
  });
});

describe('monorepo packages (C4)', () => {
  function mono(): { root: string; pkg: string } {
    const root = makeRepo({
      'CLAUDE.md': '- ROOT-OLD\n',
      '.claude/rules/old.md': 'old rule\n',
      'packages/app/package.json': '{"name":"app"}',
      'packages/app/src/x.js': 'x\n',
      'packages/other/CLAUDE.md': '- OTHER\n',
    });
    initGit(root);
    commit(root, { 'CLAUDE.md': '- ROOT-NEW\n', 'packages/app/CLAUDE.md': '- APP\n' }, 'New setup');
    git(root, 'rm', '-q', '.claude/rules/old.md');
    commit(root, { '.claude/rules/new.md': 'new rule\n' }, 'New rule');
    return { root, pkg: join(root, 'packages/app') };
  }

  it("includes the root's setup files, relative to the package", async () => {
    const { pkg } = mono();
    for (const source of ['working', 'HEAD']) {
      const s = await snapshotSetup(pkg, source, 'A', quiet().warn);
      expect(s.files).toMatchObject({
        'CLAUDE.md': '- APP\n',
        '../../CLAUDE.md': '- ROOT-NEW\n',
        '../../.claude/rules/new.md': 'new rule\n',
      });
      expect(Object.keys(s.files).some((f) => f.includes('other'))).toBe(false); // a sibling package is not loaded here
    }
  });

  it("replaces the root's setup files of the task's commit too", async () => {
    const { root, pkg } = mono();
    const setup = await snapshotSetup(pkg, 'working', 'A', quiet().warn);
    const ws = await Workspace.create(pkg);
    try {
      await ws.checkout(git(root, 'rev-list', '--max-parents=0', 'HEAD').trim());
      expect(readFileSync(join(ws.root, 'CLAUDE.md'), 'utf8').replaceAll('\r\n', '\n')).toBe('- ROOT-OLD\n'); // Windows git may check out CRLF
      applySetup(ws.dir, setup);
      expect(readFileSync(join(ws.root, 'CLAUDE.md'), 'utf8')).toBe('- ROOT-NEW\n');
      expect(existsSync(join(ws.root, '.claude/rules/old.md'))).toBe(false);
      expect(readFileSync(join(ws.root, '.claude/rules/new.md'), 'utf8')).toBe('new rule\n');
      expect(readFileSync(join(ws.dir, 'CLAUDE.md'), 'utf8')).toBe('- APP\n');
      expect(readFileSync(join(ws.root, 'packages/other/CLAUDE.md'), 'utf8')).toBe('- OTHER\n'); // untouched

      applySetup(ws.dir, { label: 'baseline', source: 'none', files: {} });
      expect(existsSync(join(ws.root, 'CLAUDE.md'))).toBe(false);
      expect(existsSync(join(ws.dir, 'CLAUDE.md'))).toBe(false);
    } finally {
      ws.close();
    }
  });
});

describe('links and big files (C6, C8)', () => {
  it('a CLAUDE.md that links to AGENTS.md gives the linked content from a git ref too', async () => {
    const root = makeRepo({ 'AGENTS.md': '- SYMLINKED-CONTENT\n', 'shared/rules/a.md': 'shared rule\n' });
    symlinkSync('AGENTS.md', join(root, 'CLAUDE.md'));
    symlinkSync('shared', join(root, '.claude'));
    initGit(root);
    for (const source of ['working', 'HEAD']) {
      const s = await snapshotSetup(root, source, 'B', quiet().warn);
      expect(s.files['CLAUDE.md']).toBe('- SYMLINKED-CONTENT\n');
      expect(s.files['.claude/rules/a.md']).toBe('shared rule\n');
    }
  });

  it('follows .claude/skills and .claude/rules linked to another folder in the repository, and a setup removes those links', async () => {
    const root = makeRepo({
      'CLAUDE.md': '# Cal\n',
      'agents/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: Deploys. Use when deploying.\n---\nDeploy\n',
      'agents/skills/deploy/reference.md': 'how to deploy\n',
      'agents/rules/api.md': 'api rule\n',
    });
    mkdirSync(join(root, '.claude'));
    symlinkSync('../agents/skills', join(root, '.claude/skills'));
    symlinkSync('../agents/rules', join(root, '.claude/rules'));
    initGit(root);
    const outside = mkdtempSync(join(tmpdir(), 'setupscore-outside-'));
    writeFiles(outside, { 'x.md': 'outside\n' });
    symlinkSync(outside, join(root, '.claude/commands')); // not committed: working only
    for (const source of ['working', 'HEAD']) {
      const q = quiet();
      const s = await snapshotSetup(root, source, 'A', q.warn);
      expect(s.files).toMatchObject({
        '.claude/skills/deploy/SKILL.md': expect.stringContaining('Deploy'),
        '.claude/skills/deploy/reference.md': 'how to deploy\n',
        '.claude/rules/api.md': 'api rule\n',
      });
      expect(Object.keys(s.files).some((f) => f.startsWith('agents/'))).toBe(false);
      if (source === 'working')
        expect(q.warnings.join('\n')).toMatch(/\.claude\/commands is a link to a folder outside the repository/);
    }
    const ws = await Workspace.create(root);
    try {
      await ws.checkout(ws.head!);
      expect(lstatSync(join(ws.dir, '.claude/skills')).isSymbolicLink()).toBe(true);
      applySetup(ws.dir, { label: 'baseline', source: 'none', files: {} });
      expect(existsSync(join(ws.dir, '.claude/skills'))).toBe(false);
      expect(existsSync(join(ws.dir, '.claude/rules'))).toBe(false);
      expect(existsSync(join(ws.dir, 'agents/skills/deploy/SKILL.md'))).toBe(true); // the real folder is just code
      applySetup(ws.dir, await snapshotSetup(root, 'HEAD', 'A', quiet().warn));
      expect(lstatSync(join(ws.dir, '.claude/skills')).isDirectory()).toBe(true);
      expect(readFileSync(join(ws.dir, '.claude/skills/deploy/reference.md'), 'utf8')).toBe('how to deploy\n');
    } finally {
      ws.close();
    }
  });

  // Symbolic links need extra rights on Windows.
  posixOnly('a link that leads out of the repository is left out with a warning', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'setupscore-outside-'));
    writeFileSync(join(outside, 'x.md'), 'outside\n');
    const root = makeRepo({ 'a.txt': 'a\n' });
    symlinkSync(join(outside, 'x.md'), join(root, 'CLAUDE.md'));
    initGit(root);
    const q = quiet();
    const s = await snapshotSetup(root, 'HEAD', 'B', q.warn);
    expect(s.files['CLAUDE.md']).toBeUndefined();
    expect(q.warnings.join('\n')).toMatch(
      /Setup B: CLAUDE\.md in HEAD is a link to .*outside the repository, so it is left out/,
    );
  });

  posixOnly('reads a setup from a git ref with a few git processes, however many files and links it has', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 300; i++) {
      files[`.claude/skills/s${i}/SKILL.md`] =
        `---\nname: s${i}\ndescription: Skill ${i}. Use when ${i}.\n---\nBody ${i}\n`;
      files[`.claude/skills/s${i}/reference.md`] = `ref ${i}\n`;
      files[`shared/r${i}.md`] = `rule ${i}\n`;
    }
    const root = makeRepo(files);
    mkdirSync(join(root, '.claude/rules'));
    for (let i = 0; i < 100; i++) symlinkSync(`../../shared/r${i}.md`, join(root, `.claude/rules/r${i}.md`));
    initGit(root);
    // Count git processes with a stand-in that logs and runs the real git.
    const bin = mkdtempSync(join(tmpdir(), 'setupscore-gitlog-'));
    const log = join(bin, 'calls.log');
    const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\necho "$1" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(real)} "$@"\n`,
    );
    chmodSync(join(bin, 'git'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const s = await snapshotSetup(root, 'HEAD', 'B', quiet().warn);
      expect(Object.keys(s.files)).toHaveLength(700);
      expect(s.files['.claude/rules/r7.md']).toBe('rule 7\n');
    } finally {
      process.env.PATH = path;
    }
    expect(readFileSync(log, 'utf8').trim().split('\n').length).toBeLessThanOrEqual(8);
  });

  it('a setup file over 512 KB is reported, not dropped silently', async () => {
    const big = `# Big\n${'- a rule that goes on and on\n'.repeat(20_000)}`;
    const root = makeRepo({ 'CLAUDE.md': big, '.claude/skills/x/logo.png': '\u0000PNG' });
    initGit(root);
    for (const source of ['working', 'HEAD']) {
      const q = quiet();
      const s = await snapshotSetup(root, source, 'A', q.warn);
      expect(s.files['CLAUDE.md']).toBeUndefined();
      expect(q.warnings.join('\n')).toMatch(/Setup A: CLAUDE\.md .*is \d+ KB, over the 512 KB limit/);
      expect(q.warnings.join('\n')).toMatch(/logo\.png .*not a text file/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Reports and suggestions on a stored run (no Claude needed).

const task = (id: string, title = id) => ({
  id,
  hash: id,
  parent: 'p',
  title,
  date: '',
  prompt: 'x',
  testFiles: ['a.test.js'],
  sourceFiles: [],
  newTests: [],
  beforeMs: 0,
  afterMs: 0,
});
const setupRec = (label: string, source: string, files: Record<string, string>) => ({
  label,
  source,
  files,
  health: 10,
  startupTokens: 10,
  lintErrors: 0,
  lintWarnings: 0,
});
function attempt(
  taskId: string,
  setup: string,
  repeat: number,
  passed: boolean,
  ruleViolations: { rule: string; token: string; file: string }[] = [],
) {
  return {
    key: `${taskId}|${setup}|${repeat}`,
    taskId,
    setup,
    repeat,
    status: passed ? 'passed' : 'failed',
    startedAt: '',
    finishedAt: '',
    ms: 1000,
    retries: 0,
    metrics: { costUsd: 0.1, turns: 3, outcome: 'success', failedCommands: [], skillsUsed: [], bashCommands: [] },
    checks: { testsPassed: passed, ruleViolations, filesChanged: [], ranTests: false, touchedSetup: false },
  };
}

/** A project with a stored run: A = none, B = working (with a CLAUDE.md), two tasks, tests never run by Claude. */
function storedRun(claudeMd = '# Shop\n', extra: Partial<RunRecord> = {}): { root: string; run: RunRecord } {
  const root = makeRepo({ 'CLAUDE.md': claudeMd, 'package.json': '{"name":"shop","scripts":{"test":"node --test"}}' });
  const id = '20261105-120000-abcd';
  const rule = {
    rule: 'Never use `console.log` </details><script>alert(2)</script> | pipe',
    token: 'console.log',
    file: 'CLAUDE.md',
  };
  const run = {
    schemaVersion: 1,
    id,
    createdAt: new Date().toISOString(),
    status: 'completed',
    head: null,
    tool: { version: '0.0.0' },
    options: {
      repeat: 2,
      budgetUsd: 5,
      maxTurns: 30,
      attemptBudgetUsd: 1,
      agentTimeoutMin: 15,
      concurrency: 1,
      sandbox: 'none',
    },
    tasks: [task('t1', 'Add <script>alert(1)</script> | parser'), task('t2')],
    setups: [
      setupRec('A', 'none', {}),
      setupRec('B', 'x<img/src=y/onerror=alert(3)>|pipe`tick', { 'CLAUDE.md': claudeMd }),
    ],
    ...extra,
  } as RunRecord;
  const attempts = [
    attempt('t1', 'A', 1, false),
    attempt('t1', 'A', 2, false),
    attempt('t2', 'A', 1, false),
    attempt('t2', 'A', 2, false),
    attempt('t1', 'B', 1, true, [rule]),
    attempt('t1', 'B', 2, true, [rule]),
    attempt('t2', 'B', 1, false),
    attempt('t2', 'B', 2, false),
  ];
  const dir = join(root, '.setupscore', 'runs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2));
  writeFileSync(join(dir, 'attempts.jsonl'), `${attempts.map((a) => JSON.stringify(a)).join('\n')}\n`);
  writeFileSync(join(root, '.setupscore', 'latest'), id);
  return { root, run };
}

describe('the Markdown report is escaped (C7)', () => {
  it('keeps the table, the <details> block and code spans intact whatever the names and rules hold', () => {
    const { root, run } = storedRun();
    const attempts = readFileSync(join(root, '.setupscore/runs', run.id, 'attempts.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const score = scoreRun(run, attempts);
    const md = renderRunMarkdown(run, score, suggest(run, attempts, score, root));
    const rows = md.split('\n').filter((l) => l.startsWith('| '));
    const cells = (l: string) => l.replace(/\\\|/g, '').split('|').length;
    expect(new Set(rows.map(cells)).size).toBe(1);
    expect(md).not.toMatch(/<script|<img/i);
    expect(md.match(/<\/details>/g)).toHaveLength(1);
    expect(md).toContain('`console.log`'); // a plain code span stays code
    expect(mdText('a `<b>` c')).toBe('a \\`&lt;b&gt;\\` c');
    expect(mdText('line\nbreak | *x* [l](u) &amp;')).toBe('line break \\| \\*x\\* \\[l\\](u) \\&amp;');
  });
});

describe('report, suggest and --fail-under on a stored run (C8, C9, F4)', () => {
  it('report --output with the terminal format writes no colour codes, even when colours are forced on', () => {
    const { root } = storedRun();
    const file = join(root, 'out.txt');
    const r = cli(['report', root, '--output', file], { NO_COLOR: undefined, FORCE_COLOR: '1' });
    expect(r.code).toBe(0);
    expect(readFileSync(file, 'utf8')).not.toContain('\u001b[');
  });

  it('--fail-under judges the first setup with instruction files when A is "none", and says so', () => {
    const { root } = storedRun();
    const ok = cli(['report', root, '--fail-under', '20']);
    expect(ok.out).toContain('--fail-under checks setup B');
    expect(ok.code).toBe(0); // B solved half the tasks; A (none) solved nothing
    const below = cli(['report', root, '--fail-under', '99']);
    expect(below.code).toBe(1);
    expect(below.out).toContain('Setup B scored');
  });

  it('counts attempts, not commands, when a command in CLAUDE.md keeps failing', () => {
    const root = makeRepo({ 'CLAUDE.md': '- Lint with `npm run lint:all`.\n' });
    const failing = Array.from({ length: 159 }, (_, i) => `npm run lint:all -- --part ${i}`);
    const attempts = [1, 2].map((r) => ({
      ...attempt('t1', 'A', r, false),
      metrics: {
        costUsd: 0.1,
        turns: 3,
        outcome: 'success',
        failedCommands: failing,
        skillsUsed: [],
        bashCommands: [],
      },
    }));
    const run = {
      schemaVersion: 1,
      id: 'r',
      createdAt: '',
      status: 'completed',
      head: null,
      tool: { version: '0' },
      options: {
        repeat: 2,
        budgetUsd: 5,
        maxTurns: 30,
        attemptBudgetUsd: 1,
        agentTimeoutMin: 15,
        concurrency: 1,
        sandbox: 'none',
      },
      tasks: [task('t1')],
      setups: [setupRec('A', 'working', { 'CLAUDE.md': '- Lint with `npm run lint:all`.\n' })],
    } as RunRecord;
    const list = suggest(run, attempts as never, scoreRun(run, attempts as never), root);
    expect(list.find((s) => s.id === 'command-npm-run-lint-all')?.evidence).toBe('It failed in 2 of 2 attempts.');
  });

  it('suggest does not offer a suggestion again once it is applied', () => {
    const { root } = storedRun();
    const before = JSON.parse(cli(['suggest', root, '--json']).out).suggestions as Suggestion[];
    expect(before.find((s) => s.id === 'run-tests')?.applied).toBeUndefined();
    expect(cli(['suggest', root, '--apply', 'run-tests']).code).toBe(0);
    const after = JSON.parse(cli(['suggest', root, '--json']).out).suggestions as Suggestion[];
    expect(after.find((s) => s.id === 'run-tests')?.applied).toBe(true);
    const text = cli(['suggest', root]).out;
    expect(text).not.toContain('--apply run-tests');
    expect(text).toContain('Already added to CLAUDE.md');
  });

  it('suggest --apply keeps CRLF line endings and writes through a CLAUDE.md link', () => {
    const { root } = storedRun('# Shop\r\n\r\n- Use pnpm.\r\n');
    expect(cli(['suggest', root, '--apply', 'run-tests']).code).toBe(0);
    const text = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(text).toContain('## Before you finish\r\n');
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');

    const linked = storedRun('# Shop\n').root;
    writeFileSync(join(linked, 'AGENTS.md'), '# Agents\n');
    rmSync(join(linked, 'CLAUDE.md'));
    symlinkSync('AGENTS.md', join(linked, 'CLAUDE.md'));
    expect(cli(['suggest', linked, '--apply', 'run-tests']).code).toBe(0);
    expect(lstatSync(join(linked, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(linked, 'AGENTS.md'), 'utf8')).toContain('## Before you finish');
  });

  it('suggest --apply on a CLAUDE.md with a 100k-character line finishes quickly', () => {
    const line = `- x${' '.repeat(100_000)}y\n`;
    const { root } = storedRun(`# Shop\n${line}`);
    const started = Date.now();
    const r = cli(['suggest', root, '--apply', 'run-tests']);
    expect(r.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(15_000); // was minutes (a quadratic regex)
    expect(trimEnd(`a${' '.repeat(200_000)}b${' '.repeat(10)}\n`)).toBe(`a${' '.repeat(200_000)}b`);
    writeFileSync(join(root, 'CLAUDE.md'), `${' '.repeat(100_000)}x\n`);
    const t = Date.now();
    applySuggestion(root, { id: 'x', title: '', evidence: '', action: '', append: '\n- added\n' });
    expect(Date.now() - t).toBeLessThan(2000);
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8').endsWith('x\n\n- added\n')).toBe(true);
  });
});

/** A Node preload that makes writes to matching paths fail like the OS would (after part of the data). */
function faultPreload(): string {
  const dir = mkdtempSync(join(tmpdir(), 'setupscore-fault-'));
  const file = join(dir, 'fault.mjs');
  writeFileSync(
    file,
    `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const re = new RegExp(process.env.FAULT_PATH);
const code = process.env.FAULT_CODE;
const fail = (p) => Object.assign(new Error(code + ': injected, open ' + JSON.stringify(String(p))), { code, path: String(p), syscall: 'write' });
const fds = new Set();
const { openSync, writeSync, writeFileSync } = fs;
fs.openSync = function (p, ...rest) {
  if (code !== 'ENOSPC' && re.test(String(p)) && String(rest[0] ?? 'r') !== 'r') throw fail(p);
  const fd = openSync.call(this, p, ...rest);
  if (re.test(String(p))) fds.add(fd);
  return fd;
};
fs.writeSync = function (fd, buf, off, len, ...rest) {
  if (fds.has(fd)) { writeSync.call(this, fd, buf, off ?? 0, Math.min(len ?? buf.length, 5)); throw fail('fd ' + fd); }
  return writeSync.call(this, fd, buf, off, len, ...rest);
};
fs.writeFileSync = function (p, data, ...rest) {
  if (re.test(String(p))) { if (code === 'ENOSPC') writeFileSync.call(this, p, String(data).slice(0, 5)); throw fail(p); }
  return writeFileSync.call(this, p, data, ...rest);
};
syncBuiltinESMExports();
`,
  );
  return file;
}

describe('saving files the user asked for (F4)', () => {
  const withFault = (path: string, code: string) => ({
    NODE_OPTIONS: `--import ${pathToFileURL(faultPreload()).href}`, // a URL: --import rejects C:\ paths
    FAULT_PATH: path,
    FAULT_CODE: code,
  });

  it('suggest --apply on a full disk leaves CLAUDE.md as it was and exits 3', () => {
    const { root } = storedRun('# Shop\n\n- Use pnpm.\n');
    const r = cli(['suggest', root, '--apply', 'run-tests'], withFault('CLAUDE\\.md', 'ENOSPC'));
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/disk is full/i);
    expect(r.err).not.toMatch(/bug/);
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('# Shop\n\n- Use pnpm.\n');
    expect(readdirSync(root).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('report --output on a full disk keeps the old file; without permission it exits 3 too', () => {
    const { root } = storedRun();
    const file = join(root, 'report.md');
    writeFileSync(file, 'the old report\n');
    const full = cli(['report', root, '--format', 'markdown', '--output', file], withFault('report\\.md', 'ENOSPC'));
    expect(full.code).toBe(3);
    expect(full.err).toMatch(/disk is full/i);
    expect(readFileSync(file, 'utf8')).toBe('the old report\n');
    const denied = cli(['report', root, '--format', 'markdown', '--output', file], withFault('report\\.md', 'EACCES'));
    expect(denied.code).toBe(3);
    expect(denied.err).toMatch(/No permission to write/);
    expect(readFileSync(file, 'utf8')).toBe('the old report\n');
    // Wrong paths are the user's to fix: exit 2.
    expect(cli(['report', root, '--output', join(root, 'no/such/dir/r.txt')]).code).toBe(2);
    expect(cli(['report', root, '--output', root]).code).toBe(2);
  });

  it('suggest --apply on a CLAUDE.md that is a folder explains it (exit 2, not a bug)', () => {
    const { root } = storedRun();
    rmSync(join(root, 'CLAUDE.md'));
    mkdirSync(join(root, 'CLAUDE.md'));
    const r = cli(['suggest', root, '--apply', 'run-tests']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/CLAUDE\.md is not a file/);
  });
});

// ---------------------------------------------------------------------------------------------
// watch, end to end with the fake Claude Code.

function project(): string {
  const root = makeRepo({
    'package.json': JSON.stringify({ name: 'shop', type: 'module', private: true, scripts: { test: 'node --test' } }),
    'src/cart.js': 'export const total = (items) => items.reduce((t, i) => t + i.price, 0);\n',
    'src/cart.test.js':
      "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { total } from './cart.js';\ntest('total adds prices', () => assert.strictEqual(total([{ price: 2 }, { price: 3 }]), 5));\n",
  });
  initGit(root);
  commit(
    root,
    {
      'src/tax.js': 'export const withTax = (amount) => Math.round(amount * 118) / 100;\n',
      'src/tax.test.js':
        "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { withTax } from './tax.js';\ntest('withTax adds 18% GST', () => assert.strictEqual(withTax(100), 118));\n",
    },
    'Add GST helper',
  );
  writeFiles(root, { 'CLAUDE.md': '# Shop\n\n- Run `npm test` before you finish.\n' });
  return root;
}

/** A Claude Code stand-in whose API is always down. */
function apiDown(): string {
  const dir = mkdtempSync(join(tmpdir(), 'setupscore-down-'));
  const file = join(dir, 'down.mjs');
  writeFileSync(
    file,
    `if (process.argv.includes('--version')) { console.log('9.9.9 (Fake Claude Code)'); process.exit(0); }
const out = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
out({ type: 'system', subtype: 'init', session_id: 'f', model: 'm', apiKeySource: 'ANTHROPIC_API_KEY', claude_code_version: '9.9.9', skills: [], memory_paths: [], mcp_servers: [] });
out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: fetch failed', num_turns: 0, total_cost_usd: 0, duration_ms: 10 });
process.exit(1);
`,
  );
  return `node ${JSON.stringify(file)}`;
}

describe("a run with a setup that replaces the commit's own (C3)", () => {
  it("does not count the commit's old setup files, removed by setupscore, as changed by Claude", () => {
    const root = makeRepo({
      'package.json': JSON.stringify({ name: 'shop', type: 'module', private: true, scripts: { test: 'node --test' } }),
      'src/cart.js': 'export const total = (items) => items.reduce((t, i) => t + i.price, 0);\n',
      'CLAUDE.md': '# Old\n',
      '.claude/skills/old/SKILL.md': '---\nname: old\ndescription: Old. Use when old.\n---\nOld\n',
      '.claude/skills/old/helper.md': 'old helper\n',
    });
    initGit(root);
    commit(
      root,
      {
        'src/tax.js': 'export const withTax = (amount) => Math.round(amount * 118) / 100;\n',
        'src/tax.test.js':
          "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { withTax } from './tax.js';\ntest('withTax adds 18% GST', () => assert.strictEqual(withTax(100), 118));\n",
      },
      'Add GST helper',
    );
    git(root, 'rm', '-rq', '.claude');
    commit(root, { 'CLAUDE.md': '# New\n\n- Run `npm test` before you finish.\n' }, 'New setup');
    const r = cli([
      'run',
      root,
      '--claude-bin',
      fake('solve'),
      '--baseline',
      '--repeat',
      '1',
      '--concurrency',
      '1',
      '--sandbox',
      'none',
      '--yes',
      '--json',
    ]);
    expect(r.code, r.err).toBe(0);
    const json = JSON.parse(r.out);
    expect(
      json.attempts
        .flatMap((a: { filesChanged: string[] }) => a.filesChanged)
        .filter((f: string) => /CLAUDE|\.claude/.test(f)),
    ).toEqual([]);
    expect(json.suggestions.map((s: { id: string }) => s.id)).not.toContain('protect-setup');
  });
});

describe('watch (C8, F3)', () => {
  const base = ['--sandbox', 'none', '--yes', '--repeat', '1', '--concurrency', '1'];

  it('prints JSON with --json, and refuses when the API is down or the history was rewritten', () => {
    const root = project();
    expect(cli(['run', root, '--claude-bin', fake('solve'), ...base]).code).toBe(0);

    const json = cli(['watch', root, '--model', 'other-model', '--claude-bin', fake('solve'), ...base, '--json']);
    expect(json.code).toBe(0);
    const doc = JSON.parse(json.out);
    expect(doc.schemaVersion).toBe(1);
    expect(doc.watch).toMatchObject({ modelAfter: 'other-model', worse: [] });
    expect(doc.watch.compared).toBeGreaterThan(0);

    const down = cli([
      'watch',
      root,
      '--run',
      doc.watch.comparedTo,
      '--model',
      'down-model',
      '--claude-bin',
      apiDown(),
      ...base,
    ]);
    expect(down.code).toBe(3);
    expect(down.out + down.err).not.toContain('No task got worse');

    // Rewrite the history: the commits of the reference run's tasks are gone.
    const branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    git(root, 'checkout', '-q', '--orphan', 'fresh');
    git(root, 'commit', '-qm', 'Squashed');
    git(root, 'branch', '-q', '-D', branch);
    git(root, 'reflog', 'expire', '--expire=now', '--all');
    git(root, 'gc', '-q', '--prune=now');
    const gone = cli([
      'watch',
      root,
      '--run',
      doc.watch.comparedTo,
      '--model',
      'third-model',
      '--claude-bin',
      fake('solve'),
      ...base,
    ]);
    expect(gone.code).toBe(2);
    expect(gone.err).toMatch(/no longer in this repository/);
    expect(gone.out + gone.err).not.toContain('No task got worse');
  });
});
