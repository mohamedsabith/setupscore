import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { agentEnv, classifyAgentFailure, stderrSummary } from '../src/agent/claude.js';
import { parseTranscript } from '../src/agent/transcript.js';
import { findViolations, forbiddenRules, lookedOutside, ranTests } from '../src/run/checks.js';
import { commandPaths, gitMetadata, projectFiles } from '../src/sandbox/env.js';
import { scoreRun, wilson } from '../src/run/score.js';
import type { Attempt, RunRecord } from '../src/run/store.js';
import { loadRuntime, probeOsSandbox } from '../src/sandbox/index.js';
import { git, initGit, makeRepo, writeFiles } from './helpers.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const fake = (mode: string, ...extra: string[]) => `node ${JSON.stringify(FAKE)} ${mode} ${extra.join(' ')}`.trim();

function cli(args: string[], env: Record<string, string | undefined> = {}) {
  const merged: Record<string, string | undefined> = {
    ...process.env,
    NO_COLOR: '1',
    ANTHROPIC_API_KEY: 'sk-ant-test-not-real',
    SETUPSCORE_RETRY_BASE_MS: '50',
    ...env,
  };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: merged as NodeJS.ProcessEnv,
    timeout: 240_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** A small project with two real tasks in its history and a setup with checkable rules. */
function project(): string {
  const root = makeRepo({
    'package.json': JSON.stringify({ name: 'shop', type: 'module', private: true, scripts: { test: 'node --test' } }),
    'src/cart.js': 'export const total = (items) => items.reduce((t, i) => t + i.price, 0);\n',
    'src/cart.test.js':
      "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { total } from './cart.js';\ntest('total adds prices', () => assert.strictEqual(total([{ price: 2 }, { price: 3 }]), 5));\n",
  });
  initGit(root);
  const commit = (files: Record<string, string>, msg: string) => {
    writeFiles(root, files);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', msg);
  };
  commit(
    {
      'src/cart.js':
        'export const total = (items) => items.reduce((t, i) => t + i.price, 0);\nexport const count = (items) => items.length;\n',
      'src/count.test.js':
        "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { count } from './cart.js';\ntest('count returns the number of items', () => assert.strictEqual(count([1, 2]), 2));\n",
    },
    'Add item count',
  );
  commit(
    {
      'src/tax.js': 'export const withTax = (amount) => Math.round(amount * 118) / 100;\n',
      'src/tax.test.js':
        "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { withTax } from './tax.js';\ntest('withTax adds 18% GST', () => assert.strictEqual(withTax(100), 118));\n",
    },
    'Add GST helper',
  );
  writeFiles(root, {
    'CLAUDE.md': '# Shop\n\n- Never use `console.log` in src/; use the logger.\n- Run `npm test` before you finish.\n',
  });
  return root;
}

describe('transcript parsing', () => {
  it('reads a real Claude Code transcript (not signed in) and treats it as fatal', () => {
    const text = readFileSync(new URL('./fixtures/transcripts/real-not-logged-in.jsonl', import.meta.url), 'utf8');
    const m = parseTranscript(text);
    expect(m.outcome).toBe('error');
    expect(m.errorCodes).toContain('authentication_failed');
    expect(m.claudeCodeVersion).toMatch(/\d/);
    expect(m.badLines).toBe(0);
    expect(classifyAgentFailure(m, '', 1, false)).toMatchObject({
      kind: 'fatal',
      message: expect.stringContaining('rejected'),
    });
  });

  it('counts tools, failed commands, edits and skills, and skips broken lines', () => {
    const lines = [
      { type: 'system', subtype: 'init', model: 'm', skills: ['db-migration'], memory_paths: ['CLAUDE.md'] },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'npm run nope' } }] },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'missing' }] },
      },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'b', name: 'Edit', input: { file_path: 'src/a.js' } },
            { type: 'tool_use', id: 'c', name: 'Skill', input: { skill: 'db-migration' } },
          ],
        },
      },
      'not json at all',
      {
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        total_cost_usd: 0.42,
        num_turns: 30,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ].map((l) => (typeof l === 'string' ? l : JSON.stringify(l)));
    const m = parseTranscript(lines.join('\n'));
    expect(m).toMatchObject({
      outcome: 'max_turns',
      costUsd: 0.42,
      turns: 30,
      failedCommands: ['npm run nope'],
      filesEdited: ['src/a.js'],
      skillsUsed: ['db-migration'],
      skillsAvailable: ['db-migration'],
      memoryPaths: ['CLAUDE.md'],
      badLines: 1,
    });
    expect(m.toolCalls).toEqual({ Bash: 1, Edit: 1, Skill: 1 });
    expect(classifyAgentFailure(m, '', 1, false)).toMatchObject({ kind: 'task' });
  });

  it('retries overload and network problems instead of scoring them', () => {
    const m = parseTranscript(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'API Error: 529 Overloaded',
      }),
    );
    expect(classifyAgentFailure(m, '', 1, false).kind).toBe('retry');
    expect(classifyAgentFailure(parseTranscript(''), 'sh: claude: command not found', 127, false).kind).toBe('fatal');
    expect(classifyAgentFailure(parseTranscript(''), 'Error: credit balance is too low', 1, false)).toMatchObject({
      kind: 'fatal',
      message: expect.stringContaining('credit'),
    });
  });
});

describe('scoring', () => {
  it('computes 95% Wilson ranges', () => {
    const [lo, hi] = wilson(8, 10);
    expect(lo).toBeCloseTo(0.49, 1);
    expect(hi).toBeCloseTo(0.94, 1);
    expect(wilson(0, 0)).toEqual([0, 1]);
  });

  it('scores setups, leaves out what cannot be measured and names a winner only with clear evidence', () => {
    const task = (id: string) => ({
      id,
      hash: id,
      parent: 'p',
      title: id,
      date: '',
      prompt: '',
      testFiles: [],
      sourceFiles: [],
      newTests: [],
      beforeMs: 0,
      afterMs: 0,
    });
    const setup = (label: string, source: string) => ({
      label,
      source,
      files: source === 'none' ? {} : { 'CLAUDE.md': '- Never use `eval`' },
      health: 10,
      startupTokens: 10,
      lintErrors: 0,
      lintWarnings: 0,
    });
    const run = {
      schemaVersion: 1,
      id: 'r',
      createdAt: '',
      status: 'completed',
      head: null,
      tool: { version: '0' },
      options: {
        repeat: 10,
        budgetUsd: 5,
        maxTurns: 30,
        attemptBudgetUsd: 1,
        agentTimeoutMin: 15,
        concurrency: 1,
        sandbox: 'auto',
      },
      tasks: [task('t1'), task('t2')],
      setups: [setup('A', 'working'), setup('B', 'main'), setup('baseline', 'none')],
    } as RunRecord;
    const attempts: Attempt[] = [];
    for (const [label, passes] of [
      ['A', 20],
      ['B', 4],
      ['baseline', 2],
    ] as const) {
      for (let i = 0; i < 20; i++) {
        attempts.push({
          key: `${label}${i}`,
          taskId: i % 2 ? 't1' : 't2',
          setup: label,
          repeat: Math.floor(i / 2) + 1,
          status: i < passes ? 'passed' : 'failed',
          startedAt: '',
          finishedAt: '',
          ms: 1000,
          retries: 0,
          metrics: { costUsd: label === 'A' ? 0.1 : 0.2, turns: 5 } as never,
          checks: {
            testsPassed: i < passes,
            ruleViolations: [],
            filesChanged: [],
            ranTests: true,
            touchedSetup: false,
          },
        });
      }
    }
    attempts.push({
      key: 'err',
      taskId: 't1',
      setup: 'A',
      repeat: 99,
      status: 'error',
      failureKind: 'infra',
      startedAt: '',
      finishedAt: '',
      ms: 1,
      retries: 2,
    });
    const s = scoreRun(run, attempts);
    const [a, b, base] = s.setups;
    expect(a).toMatchObject({ attempts: 20, passed: 20, successRate: 1, liftPoints: 90, infraErrors: 1 });
    expect(b!.liftPoints).toBe(10);
    expect(a!.score).toBeGreaterThan(b!.score);
    expect(base!.parts.find((p) => p.name === 'rules')!.measured).toBe(false); // no rules to check
    expect(s.winner).toBe('A');
    expect(s.verdict).toContain('Setup A is better');
  });

  it('gives nothing for cheap or consistent failures, and says whether a lift over no instructions is real', () => {
    const task = (id: string) => ({
      id,
      hash: id,
      parent: 'p',
      title: id,
      date: '',
      prompt: '',
      testFiles: [],
      sourceFiles: [],
      newTests: [],
      beforeMs: 0,
      afterMs: 0,
    });
    const setup = (label: string, source: string) => ({
      label,
      source,
      files: source === 'none' ? {} : { 'CLAUDE.md': '# x' },
      health: 10,
      startupTokens: 10,
      lintErrors: 0,
      lintWarnings: 0,
    });
    const run = (repeat: number) =>
      ({
        schemaVersion: 1,
        id: 'r',
        createdAt: '',
        status: 'completed',
        head: null,
        tool: { version: '0' },
        options: {
          repeat,
          budgetUsd: 5,
          maxTurns: 30,
          attemptBudgetUsd: 1,
          agentTimeoutMin: 15,
          concurrency: 1,
          sandbox: 'auto',
        },
        tasks: [task('t1'), task('t2')],
        setups: [setup('A', 'working'), setup('baseline', 'none')],
      }) as RunRecord;
    const make = (repeat: number, passes: Record<string, number>) => {
      const list: Attempt[] = [];
      for (const label of ['A', 'baseline'])
        for (let i = 0; i < 2 * repeat; i++) {
          const ok = i < passes[label]!;
          // The failing baseline is cheaper per try than A, which must not earn it points.
          list.push({
            key: `${label}${i}`,
            taskId: i % 2 ? 't1' : 't2',
            setup: label,
            repeat: Math.floor(i / 2) + 1,
            status: ok ? 'passed' : 'failed',
            startedAt: '',
            finishedAt: '',
            ms: 1,
            retries: 0,
            metrics: { costUsd: label === 'A' ? 0.3 : 0.05, turns: 3 } as never,
            checks: { testsPassed: ok, ruleViolations: [], filesChanged: [], ranTests: true, touchedSetup: false },
          });
        }
      return list;
    };

    const clear = scoreRun(run(5), make(5, { A: 10, baseline: 0 }));
    const base = clear.setups[1]!;
    expect(base.score).toBe(0);
    expect(base.parts.find((p) => p.name === 'health')!.measured).toBe(false);
    expect(base.parts.find((p) => p.name === 'consistency')!.note).toContain('no task was solved');
    expect(clear.setups[0]!.score).toBe(100);
    expect(clear.verdict).toContain('clearly helps');

    const unclear = scoreRun(run(2), make(2, { A: 3, baseline: 1 }));
    expect(unclear.verdict).toContain('could still be chance');
  });
});

describe('rules from the instructions', () => {
  it('turns "never use X" into checks only for code-like words', () => {
    const rules = forbiddenRules({
      'CLAUDE.md':
        '- Never use `console.log` in src/\n- Do not call fetch() directly\n- Never use any outside tests\n- Avoid using magic numbers\n',
      'docs/x.md': '- Never use `eval`',
    });
    expect(rules.map((r) => r.token)).toEqual(['console.log', 'fetch']);
    const added = new Map([['src/a.js', ['const x = 1;', "console.log('hi')"]]]);
    expect(findViolations(rules, added)).toEqual([
      { rule: 'Never use `console.log` in src/', token: 'console.log', file: 'src/a.js' },
    ]);
    expect(findViolations(rules, new Map([['src/a.js', ['myconsole.logger()']]]))).toEqual([]);
  });

  it('notices when the agent ran the tests', () => {
    expect(ranTests(['ls', 'npm test'])).toBe(true);
    expect(ranTests(['npx vitest run src/a.test.ts'])).toBe(true);
    expect(ranTests(['cat package.json'])).toBe(false);
  });
});

describe('setupscore run with a fake Claude Code (no sandbox, runs on every OS)', () => {
  it('scores setup A against no instructions and writes the reports', () => {
    const root = project();
    const r = cli([
      'run',
      root,
      '--claude-bin',
      fake('needs-claude-md'),
      '--baseline',
      '--repeat',
      '2',
      '--sandbox',
      'none',
      '--yes',
      '--json',
    ]);
    expect(r.code, r.err).toBe(0);
    const json = JSON.parse(r.out);
    const [a, base] = json.setups;
    expect(a).toMatchObject({ label: 'A', successRate: 1, liftPoints: 100 });
    expect(base).toMatchObject({ label: 'baseline', successRate: 0 });
    expect(json.attempts).toHaveLength(8);
    expect(
      json.attempts.every((x: { setup: string; ranTests: boolean | null }) => x.setup === 'baseline' || x.ranTests),
    ).toBe(true);
    const dir = join(root, '.setupscore', 'runs', json.run.id);
    expect(readFileSync(join(dir, 'report.html'), 'utf8')).toContain('setupscore report');
    expect(readFileSync(join(dir, 'report.md'), 'utf8')).toContain('### setupscore');

    const md = cli(['report', root, '--format', 'markdown']);
    expect(md.out).toContain('| A |');
    expect(cli(['report', root, '--fail-under', '50']).code).toBe(0);
    expect(cli(['report', root, '--fail-under', '120']).code).toBe(2);
    const html = join(root, 'out.html');
    expect(cli(['report', root, '--format', 'html', '--output', html]).code).toBe(0);
    expect(existsSync(html)).toBe(true);

    // watch: same tasks and setups with another model
    const w = cli([
      'watch',
      root,
      '--model',
      'fake-model-2',
      '--claude-bin',
      fake('needs-claude-md'),
      '--sandbox',
      'none',
      '--yes',
    ]);
    expect(w.code, w.err).toBe(0);
    expect(w.out).toContain('No task got worse');
  });

  it('counts broken rules and suggests a fix; suggestions can be applied', () => {
    const root = project();
    const r = cli([
      'run',
      root,
      '--claude-bin',
      fake('break-rule'),
      '--repeat',
      '1',
      '--sandbox',
      'none',
      '--yes',
      '--json',
    ]);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).setups[0].ruleBreaks).toBe(2);
    const s = JSON.parse(cli(['suggest', root, '--json']).out);
    expect(s.suggestions.map((x: { id: string }) => x.id)).toContain('rule-console-log');

    const none = project();
    cli([
      'run',
      none,
      '--claude-bin',
      fake('solve'),
      '--setup-a',
      'none',
      '--repeat',
      '1',
      '--sandbox',
      'none',
      '--yes',
    ]);
    const list = JSON.parse(cli(['suggest', none, '--json']).out).suggestions;
    expect(list.map((x: { id: string }) => x.id)).not.toContain('protect-setup');
  });

  it('stops at the budget with exit code 4, and --resume finishes the run', () => {
    const root = project();
    const first = cli([
      'run',
      root,
      '--claude-bin',
      fake('solve', '--cost=0.6'),
      '--repeat',
      '2',
      '--budget',
      '1',
      '--concurrency',
      '1',
      '--sandbox',
      'none',
      '--yes',
    ]);
    expect(first.code, first.err).toBe(4);
    expect(first.err).toContain('budget');
    expect(first.err).toContain('--resume');
    const second = cli([
      'run',
      root,
      '--claude-bin',
      fake('solve', '--cost=0.6'),
      '--resume',
      'latest',
      '--budget',
      '10',
      '--sandbox',
      'none',
      '--yes',
      '--json',
    ]);
    expect(second.code, second.err).toBe(0);
    expect(JSON.parse(second.out).attempts.filter((a: { status: string }) => a.status === 'passed')).toHaveLength(4);
  });

  it('retries when the API is overloaded, without counting it against the setup', () => {
    const root = project();
    const counter = join(mkdtempSync(join(tmpdir(), 'setupscore-counter-')), 'n');
    const r = cli([
      'run',
      root,
      '--claude-bin',
      fake('overloaded-once', `--counter=${counter}`),
      '--repeat',
      '1',
      '--concurrency',
      '1',
      '--limit',
      '1',
      '--sandbox',
      'none',
      '--yes',
      '--json',
    ]);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).attempts[0]).toMatchObject({ status: 'passed' });
    expect(r.err).toContain('Trying again');
    rmSync(dirname(counter), { recursive: true, force: true });
  });

  it('stops with clear messages when Claude Code, the key or the sign-in is missing', () => {
    const root = project();
    const noBin = cli(['run', root, '--claude-bin', '/definitely/not/claude', '--sandbox', 'none', '--yes']);
    expect(noBin.code).toBe(3);
    expect(noBin.err).toContain('Claude Code was not found');

    const noKey = cli(['run', root, '--claude-bin', fake('solve'), '--sandbox', 'none', '--yes'], {
      ANTHROPIC_API_KEY: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
    });
    expect(noKey.code).toBe(3);
    expect(noKey.err).toContain('claude setup-token');

    const badKey = cli(['run', root, '--claude-bin', fake('auth-fail'), '--sandbox', 'none', '--yes']);
    expect(badKey.code).toBe(3);
    expect(badKey.err).toContain('rejected the API key');

    const noTerminal = cli(['run', root, '--claude-bin', fake('solve'), '--sandbox', 'none'], { CI: '1' });
    expect(noTerminal.code).toBe(2);
    expect(noTerminal.err).toContain('--yes');

    const badRef = cli([
      'run',
      root,
      '--claude-bin',
      fake('solve'),
      '--setup-b',
      'no-such-branch',
      '--sandbox',
      'none',
      '--yes',
    ]);
    expect(badRef.code).toBe(2);
    expect(badRef.err).toContain('not a branch, tag or commit');

    expect(cli(['report', makeRepo({ 'a.txt': '' })]).err).toContain('no runs');
  });
});

describe.runIf(process.platform !== 'win32')('Ctrl+C', () => {
  it('stops cleanly with exit code 4, keeps finished attempts, and --resume completes the run', async () => {
    const root = project();
    // Build the tasks first so the run starts straight away.
    expect(cli(['tasks', root, '--sandbox', 'none', '--yes']).code).toBe(0);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      NO_COLOR: '1',
      ANTHROPIC_API_KEY: 'sk-ant-test-not-real',
    };
    const child = spawn(
      process.execPath,
      [
        CLI,
        'run',
        root,
        '--claude-bin',
        fake('slow', '--ms=4000'),
        '--repeat',
        '1',
        '--concurrency',
        '1',
        '--sandbox',
        'none',
        '--yes',
      ],
      { env },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    // Wait until the first attempt has finished, then press Ctrl+C during the second.
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (/\[1\/2\].*passed/.test(out)) {
          clearInterval(t);
          setTimeout(() => {
            child.kill('SIGINT');
            resolve();
          }, 1500);
        }
      }, 200);
    });
    const code = await new Promise<number | null>((r) => child.on('close', r));
    expect(code, out).toBe(4);
    expect(out).toContain('you stopped the run');
    const resumed = cli([
      'run',
      root,
      '--claude-bin',
      fake('solve'),
      '--resume',
      'latest',
      '--sandbox',
      'none',
      '--yes',
      '--json',
    ]);
    expect(resumed.code, resumed.err).toBe(0);
    expect(resumed.err).toContain('1 of 2 attempts already finished');
    expect(JSON.parse(resumed.out).attempts.filter((a: { status: string }) => a.status === 'passed')).toHaveLength(2);
  }, 120_000);
});

const rt = await loadRuntime({ cwd: process.cwd(), install: false });
const osSandbox = rt ? (await probeOsSandbox(rt)).ok : false;

describe('keeping the answer out of reach', () => {
  it('hides the real project files but keeps .git, node_modules, symbolic links and needed folders', () => {
    const top = mkdtempSync(join(tmpdir(), 'setupscore-real-'));
    for (const d of ['.git', 'node_modules', 'src', 'tools/claude']) mkdirSync(join(top, d), { recursive: true });
    writeFileSync(join(top, 'package.json'), '{}');
    symlinkSync(tmpdir(), join(top, 'shared'));
    const hidden = projectFiles(top, [join(top, 'tools', 'claude')])
      .map((p) => p.slice(top.length + 1))
      .sort();
    expect(hidden).toEqual(['package.json', 'src']);
    rmSync(top, { recursive: true, force: true });
  });

  it('finds the files a command line runs', () => {
    expect(commandPaths(`node ${JSON.stringify(process.execPath)} x`)).toContain(process.execPath);
    expect(commandPaths('node --version').length).toBeGreaterThan(0); // node from PATH
  });

  it('flags commands that dig for the answer, and nothing else', () => {
    const real = '/home/me/shop';
    expect(lookedOutside(['git log --oneline', 'npm test', 'cat src/a.js'], real)).toEqual([]);
    expect(lookedOutside(['cat /home/me/shop/src/tax.js'], real)).toHaveLength(1);
    expect(
      lookedOutside(['cat .git/objects/info/alternates', 'git cat-file --batch-all-objects --batch-check'], real),
    ).toHaveLength(2);
  });

  it('passes AWS credentials to Claude Code only when it uses Bedrock', () => {
    const env = { ANTHROPIC_API_KEY: 'k', AWS_SECRET_ACCESS_KEY: 's', AWS_REGION: 'eu-west-1' };
    expect(agentEnv('/c', env)).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(agentEnv('/c', { ...env, CLAUDE_CODE_USE_BEDROCK: '1' })).toMatchObject({ AWS_SECRET_ACCESS_KEY: 's' });
  });

  it('hides the real repository metadata but not its objects', () => {
    const top = mkdtempSync(join(tmpdir(), 'setupscore-gitmeta-'));
    writeFiles(top, { 'a.txt': 'x' });
    initGit(top);
    const hidden = gitMetadata(top).map((p) => p.slice(top.length + 1));
    expect(hidden).toContain('.git/HEAD');
    expect(hidden).toContain('.git/refs');
    expect(hidden).not.toContain('.git/objects');
    rmSync(top, { recursive: true, force: true });
  });

  it('flags /proc lookups and shows where the match is', () => {
    expect(lookedOutside(['const p = readFileSync("/proc/1/cmdline")'], '/x')[0]).toContain('/proc/1/cmdline');
    expect(lookedOutside(['cat /proc/self/mountinfo'], '/x')).toHaveLength(1);
    expect(lookedOutside(['ls /proc/cpuinfo'], '/x')).toEqual([]);
  });

  it('picks the useful line out of a crash', () => {
    const stderr =
      "file:///x/fake.mjs:9\nError: ENOENT: no such file or directory, open 'lib/a.js'\n    at Object.writeFileSync (node:fs:1)\n\nNode.js v22.23.4\n";
    expect(stderrSummary(stderr)).toBe("Error: ENOENT: no such file or directory, open 'lib/a.js'");
    expect(stderrSummary('')).toBe('');
  });
});

/** Like project(), but with a dependency (a local package, so no network) and a custom test runner script. */
function projectWithDepAndScript(): string {
  const root = project();
  writeFiles(root, {
    'vendor/leftpad/package.json': JSON.stringify({
      name: 'leftpad',
      version: '1.0.0',
      type: 'module',
      main: 'index.js',
    }),
    'vendor/leftpad/index.js': 'export default (s, n) => String(s).padStart(n);\n',
    'scripts/test.mjs':
      "import { spawnSync } from 'node:child_process';\nconst files = process.argv.slice(2);\nprocess.exit(spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' }).status ?? 1);\n",
  });
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  pkg.dependencies = { leftpad: 'file:./vendor/leftpad' };
  pkg.scripts = { test: 'node scripts/test.mjs src/*.test.js' };
  writeFiles(root, { 'package.json': JSON.stringify(pkg) });
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'Use a test script and a local dependency');
  // One more task on top, so at least one task uses the custom script.
  writeFiles(root, {
    'src/discount.js': 'export const discount = (amount, pct) => amount - (amount * pct) / 100;\n',
    'src/discount.test.js':
      "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { discount } from './discount.js';\ntest('discount takes a percentage off', () => assert.strictEqual(discount(200, 10), 180));\n",
  });
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'Add discount helper');
  return root;
}

describe('the agent cannot fake a pass', () => {
  type Row = { status: string; reason?: string };
  const allFailed = (r: { code: number | null; out: string; err: string }) => {
    expect(r.code, r.err).toBe(0);
    const rows: Row[] = JSON.parse(r.out).attempts;
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.filter((a) => a.status !== 'failed'),
      JSON.stringify(rows),
    ).toEqual([]);
    return rows;
  };

  it('a fake node or npm in node_modules/.bin is thrown away (no dependencies, and with dependencies)', () => {
    allFailed(
      cli([
        'run',
        project(),
        '--claude-bin',
        fake('cheat-shim'),
        '--repeat',
        '1',
        '--sandbox',
        'none',
        '--yes',
        '--json',
      ]),
    );
    allFailed(
      cli([
        'run',
        projectWithDepAndScript(),
        '--claude-bin',
        fake('cheat-shim'),
        '--repeat',
        '1',
        '--sandbox',
        'none',
        '--yes',
        '--json',
      ]),
    );
  });

  it('test files replaced by links to /dev/null are put back', () => {
    allFailed(
      cli([
        'run',
        project(),
        '--claude-bin',
        fake('cheat-symlink'),
        '--repeat',
        '1',
        '--sandbox',
        'none',
        '--yes',
        '--json',
      ]),
    );
  });

  it('a tests folder replaced by a link fails that attempt only, and the run goes on', () => {
    const rows = allFailed(
      cli([
        'run',
        project(),
        '--claude-bin',
        fake('cheat-dir'),
        '--repeat',
        '1',
        '--concurrency',
        '1',
        '--sandbox',
        'none',
        '--yes',
        '--json',
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it('an edited test script or an .npmrc preload does not count (custom test runner)', () => {
    allFailed(
      cli([
        'run',
        projectWithDepAndScript(),
        '--claude-bin',
        fake('cheat-script'),
        '--repeat',
        '1',
        '--sandbox',
        'none',
        '--yes',
        '--json',
      ]),
    );
  });

  it('the real fix still passes with a custom test runner and a dependency', () => {
    const r = cli([
      'run',
      projectWithDepAndScript(),
      '--claude-bin',
      fake('solve'),
      '--repeat',
      '1',
      '--sandbox',
      'none',
      '--yes',
      '--json',
    ]);
    expect(r.code, r.err).toBe(0);
    const rows: Row[] = JSON.parse(r.out).attempts;
    expect(
      rows.every((a) => a.status === 'passed'),
      JSON.stringify(rows),
    ).toBe(true);
  });

  it('source that imports the answer from the real folder is caught', () => {
    const root = project();
    const rows = allFailed(
      cli([
        'run',
        root,
        '--claude-bin',
        fake('cheat-import', `--peek=${root}`),
        '--repeat',
        '1',
        '--sandbox',
        'none',
        '--yes',
        '--json',
      ]),
    );
    expect(rows.every((a) => a.reason?.includes('looked for the answer'))).toBe(true);
  });

  it.runIf(osSandbox)('in the OS sandbox too', () => {
    allFailed(
      cli(['run', projectWithDepAndScript(), '--claude-bin', fake('cheat-shim'), '--repeat', '1', '--yes', '--json']),
    );
    allFailed(cli(['run', project(), '--claude-bin', fake('cheat-symlink'), '--repeat', '1', '--yes', '--json']));
  });
});

describe('dependencies the agent adds', () => {
  it('are installed fresh before the hidden tests, as CI would', () => {
    const root = project();
    const r = cli([
      'run',
      root,
      '--claude-bin',
      fake('add-dep'),
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
    const rows: { status: string; reason?: string }[] = JSON.parse(r.out).attempts;
    expect(rows.map((a) => a.status)).toEqual(['passed', 'passed']);
  });
});

describe('the agent cannot see the answer', () => {
  type Row = { status: string; reason?: string };
  it('finds no later commit with any normal git command in the workspace', () => {
    const root = project();
    const r = cli([
      'run',
      root,
      '--claude-bin',
      fake('cheat-refs'),
      '--repeat',
      '1',
      '--sandbox',
      'none',
      '--yes',
      '--json',
    ]);
    expect(r.code, r.err).toBe(0);
    const rows: Row[] = JSON.parse(r.out).attempts;
    expect(rows).toHaveLength(2);
    expect(rows.every((a) => a.status === 'failed')).toBe(true);
  });

  it('does not count an attempt that digs through the shared git objects', () => {
    const root = project();
    const r = cli([
      'run',
      root,
      '--claude-bin',
      fake('cheat-alternates'),
      '--repeat',
      '1',
      '--sandbox',
      'none',
      '--yes',
      '--json',
    ]);
    expect(r.code, r.err).toBe(0);
    const rows: Row[] = JSON.parse(r.out).attempts;
    expect(
      rows.every((a) => a.status === 'failed' && a.reason?.includes('looked for the answer outside the task')),
    ).toBe(true);
  });

  it('without a sandbox, copying from the real project folder works (so the next test proves something)', () => {
    const root = project();
    const r = cli([
      'run',
      root,
      '--claude-bin',
      fake('cheat-folder', `--peek=${root}`),
      '--repeat',
      '1',
      '--sandbox',
      'none',
      '--yes',
      '--json',
    ]);
    expect(r.code, r.err).toBe(0);
    const rows: Row[] = JSON.parse(r.out).attempts;
    expect(rows.every((a) => a.status === 'passed')).toBe(true);
  });

  it.runIf(osSandbox)('the OS sandbox hides the real project folder from the agent', () => {
    const root = project();
    const r = cli([
      'run',
      root,
      '--claude-bin',
      fake('cheat-folder', `--peek=${root}`),
      '--repeat',
      '1',
      '--yes',
      '--json',
    ]);
    expect(r.code, r.err).toBe(0);
    const rows: Row[] = JSON.parse(r.out).attempts;
    expect(rows.every((a) => a.status === 'failed')).toBe(true);
  });
});

describe.runIf(osSandbox)('setupscore run inside the OS sandbox', () => {
  it('runs the fake agent and the hidden tests in the sandbox', () => {
    const root = project();
    const r = cli([
      'run',
      root,
      '--claude-bin',
      fake('needs-claude-md'),
      '--baseline',
      '--repeat',
      '1',
      '--yes',
      '--json',
    ]);
    expect(r.code, r.err).toBe(0);
    const json = JSON.parse(r.out);
    expect(json.run.options.sandbox).toBe('auto');
    expect(json.setups.map((s: { successRate: number }) => s.successRate)).toEqual([1, 0]);
  });
});
