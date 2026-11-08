import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { agentDomains, claudeCommand, endpointProblem, isAllowableHost } from '../src/agent/claude.js';
import { startRun, type RunFlags } from '../src/commands/run.js';
import { NothingToDo } from '../src/core/errors.js';
import { forbiddenRules, lookedOutside } from '../src/run/checks.js';
import { agentPrompt, missingTool } from '../src/run/runner.js';
import { scoreRun } from '../src/run/score.js';
import type { RunRecord } from '../src/run/store.js';
import { commandPaths } from '../src/sandbox/env.js';
import { loadRuntime, probeOsSandbox } from '../src/sandbox/index.js';
import { git, initGit, makeRepo, writeFiles } from './helpers.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const fake = (mode: string, ...extra: string[]) => `node ${JSON.stringify(FAKE)} ${mode} ${extra.join(' ')}`.trim();
const KEY = 'sk-ant-api03-RECOVERYTESTKEY0123456789abcdef';

function cli(args: string[], env: Record<string, string | undefined> = {}, input = '') {
  const merged: Record<string, string | undefined> = {
    ...process.env,
    NO_COLOR: '1',
    ANTHROPIC_API_KEY: KEY,
    SETUPSCORE_RETRY_BASE_MS: '20',
    CI: undefined,
    ...env,
  };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: merged,
    timeout: 240_000,
    input,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Two tasks (count, tax), tasks.json built, CLAUDE.md in the working tree. `sub` puts the project in a monorepo package. */
function project(o: { sub?: string; dep?: boolean } = {}): string {
  const top = makeRepo({});
  const root = o.sub ? join(top, o.sub) : top;
  if (o.dep) {
    writeFiles(root, {
      'vendor/leftpad/package.json': JSON.stringify({
        name: 'leftpad',
        version: '1.0.0',
        type: 'module',
        main: 'index.js',
      }),
      'vendor/leftpad/index.js': 'export default (s, n) => String(s).padStart(n);\n',
    });
  }
  writeFiles(root, {
    'package.json': JSON.stringify({
      name: 'shop',
      type: 'module',
      private: true,
      scripts: { test: 'node --test' },
      ...(o.dep ? { dependencies: { leftpad: 'file:./vendor/leftpad' } } : {}),
    }),
    'src/cart.js': 'export const total = (items) => items.reduce((t, i) => t + i.price, 0);\n',
    'src/cart.test.js':
      "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { total } from './cart.js';\ntest('total', () => assert.strictEqual(total([{ price: 2 }, { price: 3 }]), 5));\n",
  });
  if (o.sub) writeFiles(top, { 'package.json': JSON.stringify({ name: 'mono', private: true }) });
  initGit(top);
  const commit = (files: Record<string, string>, msg: string) => {
    writeFiles(root, files);
    git(top, 'add', '-A');
    git(top, 'commit', '-qm', msg);
  };
  commit(
    {
      'src/cart.js':
        'export const total = (items) => items.reduce((t, i) => t + i.price, 0);\nexport const count = (items) => items.length;\n',
      'src/count.test.js':
        "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { count } from './cart.js';\ntest('count', () => assert.strictEqual(count([1, 2]), 2));\n",
    },
    'Add item count',
  );
  commit(
    {
      'src/tax.js': 'export const withTax = (amount) => Math.round(amount * 118) / 100;\n',
      'src/tax.test.js':
        "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { withTax } from './tax.js';\ntest('withTax', () => assert.strictEqual(withTax(100), 118));\n",
    },
    'Add GST helper',
  );
  writeFiles(root, { 'CLAUDE.md': '# Shop\n\n- Never use `console.log` in src/.\n' });
  const r = cli(['tasks', root, '--sandbox', 'none', '--yes']);
  expect(r.code, r.err).toBe(0);
  return root;
}

const NONE = ['--sandbox', 'none', '--yes', '--concurrency', '1'];
const runs = (root: string) =>
  existsSync(join(root, '.setupscore', 'runs')) ? readdirSync(join(root, '.setupscore', 'runs')) : [];
const latestDir = (root: string) =>
  join(root, '.setupscore', 'runs', readFileSync(join(root, '.setupscore', 'latest'), 'utf8').trim());
const runJson = (root: string) => JSON.parse(readFileSync(join(latestDir(root), 'run.json'), 'utf8'));
const lines = (root: string) =>
  readFileSync(join(latestDir(root), 'attempts.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const counter = () => join(mkdtempSync(join(tmpdir(), 'setupscore-calls-')), 'n');
const calls = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').length : 0);
/** A fake that counts its sessions (one byte each) before doing `mode`. */
const counted = (file: string, mode: string, ...extra: string[]) =>
  `sh -c 'case " $* " in *" --version "*) ;; *) printf x >> ${file} ;; esac; exec ${fake(mode, ...extra).replace(/'/g, `'\\''`)} "$@"' --`;

describe('a setup that solves nothing scores 0 (X2, C2, run-compare 1.21, 5.43, 11.32)', () => {
  it('whatever its rules and health', () => {
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
    const run = {
      schemaVersion: 1,
      id: 'r',
      createdAt: '',
      status: 'completed',
      head: null,
      tool: { version: '0' },
      options: {
        repeat: 1,
        budgetUsd: 5,
        maxTurns: 30,
        attemptBudgetUsd: 1,
        agentTimeoutMin: 15,
        concurrency: 1,
        sandbox: 'none',
      },
      tasks: [task('t1'), task('t2')],
      setups: [
        {
          label: 'A',
          source: 'working',
          files: { 'CLAUDE.md': '- Never use `eval`' },
          health: 10,
          startupTokens: 1,
          lintErrors: 0,
          lintWarnings: 0,
        },
      ],
    } as RunRecord;
    const failed = ['t1', 't2'].map((t) => ({
      key: `${t}|A|1`,
      taskId: t,
      setup: 'A',
      repeat: 1,
      status: 'failed' as const,
      startedAt: '',
      finishedAt: '',
      ms: 1,
      retries: 0,
      metrics: { costUsd: 0.1, turns: 1 } as never,
      checks: { testsPassed: false, ruleViolations: [], filesChanged: [], ranTests: true, touchedSetup: false },
    }));
    expect(scoreRun(run, failed).setups[0]!.score).toBe(0);
    const infra = failed.map((a) => ({ ...a, status: 'error' as const, failureKind: 'infra' as const }));
    expect(scoreRun(run, infra).setups[0]).toMatchObject({ score: 0, attempts: 0 });
  });
});

describe('nothing measured is never a pass (R4, C1, D2, F3, I04, I11, real-claude: retries stack)', () => {
  posixOnly(
    'an API that stays down stops the run after 3 sessions in a row, exit 3, every session paid for is counted, --json still prints',
    () => {
      const root = project();
      const n = counter();
      const r = cli([
        'run',
        root,
        '--claude-bin',
        counted(n, 'overloaded-always', '--cost=0.01'),
        '--repeat',
        '2',
        '--fail-under',
        '10',
        '--json',
        ...NONE,
      ]);
      expect(r.code, r.err).toBe(3);
      expect(r.err).toMatch(/Claude API could not be used: 3 Claude Code sessions in a row/);
      expect(r.err).toContain('--resume');
      expect(calls(n)).toBe(3);
      const json = JSON.parse(r.out); // the results reach stdout even when the run stops (R10, X6)
      expect(json.setups[0].attempts).toBe(0);
      expect(runJson(root).status).toBe('failed');
      const recorded = lines(root);
      expect(recorded).toHaveLength(1);
      expect(recorded[0].metrics.costUsd).toBeCloseTo(0.03);
    },
  );
});

describe('budget (R2, R6, R8, B01-B09, B25)', () => {
  it('a budget below the assumed cost still runs; a started attempt is never cut short; --json on a budget stop', () => {
    const root = project();
    const r = cli([
      'run',
      root,
      '--claude-bin',
      fake('solve', '--cost=0.06'),
      '--repeat',
      '2',
      '--budget',
      '0.1',
      '--json',
      ...NONE,
    ]);
    expect(r.code, r.err).toBe(4);
    expect(JSON.parse(r.out).attempts.filter((a: { status: string }) => a.status === 'passed')).toHaveLength(1);
    expect(r.err).toMatch(/--resume \S+ --budget \d+/);
  });

  it('once costs are known, an attempt that would not fit is not started', () => {
    const root = project();
    const r = cli([
      'run',
      root,
      '--claude-bin',
      fake('solve', '--cost=0.15'),
      '--repeat',
      '2',
      '--budget',
      '0.42',
      ...NONE,
    ]);
    expect(r.code, r.err).toBe(4);
    expect(lines(root).map((a) => a.status)).toEqual(['passed', 'passed']);
  });

  posixOnly('a resume keeps the budget unless --budget is given, asks first, and follows its own hint', () => {
    const root = project();
    expect(
      cli(['run', root, '--claude-bin', fake('solve', '--cost=0.15'), '--repeat', '2', '--budget', '0.3', ...NONE])
        .code,
    ).toBe(4);
    const n = counter();
    const kept = cli(['run', root, '--claude-bin', counted(n, 'solve', '--cost=0.15'), '--resume', 'latest', ...NONE]);
    expect(kept.code, kept.err).toBe(4);
    expect(kept.err).toMatch(/has used its budget.*Nothing more was spent/s);
    expect(calls(n)).toBe(0);
    expect(runJson(root).options.budgetUsd).toBe(0.3);

    const noYes = cli(
      ['run', root, '--claude-bin', counted(n, 'solve'), '--resume', 'latest', '--budget', '5', '--sandbox', 'none'],
      { CI: '1' },
    );
    expect(noYes.code).toBe(2);
    expect(noYes.err).toContain('--yes');
    expect(calls(n)).toBe(0);

    const hint = kept.err.match(/--budget (\d+)/)![1]!;
    const resumed = cli([
      'run',
      root,
      '--claude-bin',
      counted(n, 'solve', '--cost=0.15'),
      '--resume',
      'latest',
      '--budget',
      hint,
      '--repeat',
      '3',
      '--concurrency',
      '2',
      '--sandbox',
      'none',
      '--yes',
    ]);
    expect(resumed.code, resumed.err).toBe(0);
    expect(resumed.out).toMatch(/Ignored when resuming.*--repeat/);
    expect(resumed.out).toMatch(/Changed for the rest of this run: --budget \d+, --concurrency 2/);
    expect(calls(n)).toBe(2);
  });

  it('resuming a complete run changes nothing in it (B09)', () => {
    const root = project();
    expect(cli(['run', root, '--claude-bin', fake('solve'), '--repeat', '1', ...NONE]).code).toBe(0);
    const before = readFileSync(join(latestDir(root), 'run.json'), 'utf8');
    const r = cli(['run', root, '--claude-bin', fake('solve'), '--resume', 'latest', '--budget', '9', ...NONE]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('already complete');
    expect(readFileSync(join(latestDir(root), 'run.json'), 'utf8')).toBe(before);
  });
});

describe('resume safety (R7, R11, R12)', () => {
  it('refuses an empty run id instead of starting a new paid run', () => {
    const root = project();
    const r = cli(['run', root, '--claude-bin', fake('solve'), '--resume', '', ...NONE]);
    expect(r.code).toBe(2);
    expect(runs(root)).toEqual([]);
  });

  it('two resumes of the same run at once: the second is refused, nothing runs twice', async () => {
    const root = project();
    expect(
      cli(['run', root, '--claude-bin', fake('solve', '--cost=0.2'), '--repeat', '2', '--budget', '0.3', ...NONE]).code,
    ).toBe(4);
    const env = { ...process.env, NO_COLOR: '1', ANTHROPIC_API_KEY: KEY } as Record<string, string>;
    delete env['CI'];
    const args = [
      CLI,
      'run',
      root,
      '--claude-bin',
      fake('slow', '--ms=1500'),
      '--resume',
      'latest',
      '--budget',
      '5',
      ...NONE,
    ];
    const first = spawn(process.execPath, args, { env });
    const firstDone = new Promise<number | null>((r) => first.on('close', r));
    await new Promise((r) => setTimeout(r, 1500));
    const second = cli(args.slice(1));
    expect(second.code).toBe(2);
    expect(second.err).toMatch(/already being worked on by another setupscore process/);
    expect(await firstDone).toBe(0);
    const keys = lines(root)
      .filter((a) => a.status === 'passed')
      .map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  }, 120_000);

  it('when results can no longer be saved, the run stops and is not left "running"', () => {
    const root = project();
    expect(
      cli(['run', root, '--claude-bin', fake('solve', '--cost=0.2'), '--repeat', '2', '--budget', '0.3', ...NONE]).code,
    ).toBe(4);
    const file = join(latestDir(root), 'attempts.jsonl');
    rmSync(file);
    mkdirSync(file); // appending now fails
    const r = cli(['run', root, '--claude-bin', fake('solve'), '--resume', 'latest', '--budget', '5', ...NONE]);
    expect(r.code).not.toBe(0);
    expect(runJson(root).status).toBe('failed');
    expect(existsSync(join(latestDir(root), 'lock'))).toBe(false);
  });
});

describe('cheap checks happen before asking and before the run exists (W11, C9, A48)', () => {
  it('a wrong --setup-b, a sandbox refusal, a huge --repeat or a bad gateway leave no run behind', () => {
    const root = project();
    const badRef = cli(['run', root, '--claude-bin', fake('solve'), '--setup-b', 'no-such-branch', ...NONE]);
    expect(badRef.code).toBe(2);
    expect(badRef.err).toContain('not a branch, tag or commit');
    const refused = cli(['run', root, '--claude-bin', fake('solve'), '--sandbox', 'none']);
    expect([2, 3]).toContain(refused.code);
    const huge = cli(['run', root, '--claude-bin', fake('solve'), '--repeat', '3000000', ...NONE]);
    expect(huge.code).toBe(2);
    const single = cli(['run', root, '--claude-bin', fake('solve'), '--yes'], {
      ANTHROPIC_BASE_URL: 'http://litellm:4000',
    });
    expect(single.code).toBe(3);
    // Native Windows refuses `run` (no OS sandbox) before it looks at the gateway.
    expect(single.err).toMatch(process.platform === 'win32' ? /native Windows/ : /single name/);
    const notUrl = cli(['run', root, '--claude-bin', fake('solve'), ...NONE], { ANTHROPIC_BASE_URL: 'not a url' });
    expect(notUrl.code).toBe(3);
    const cacheFile = join(mkdtempSync(join(tmpdir(), 'setupscore-cachefile-')), 'file');
    writeFileSync(cacheFile, 'x');
    const badCache = cli(['run', root, '--claude-bin', fake('solve'), ...NONE], { SETUPSCORE_CACHE_DIR: cacheFile });
    expect(badCache.code).toBe(3);
    expect(badCache.err).toMatch(/cache folder .* cannot be used/);
    expect(runs(root)).toEqual([]);
  });

  it('no usable tasks is "nothing to do" (exit 1, X3), never a bug', async () => {
    const root = makeRepo({ 'a.txt': 'a' });
    initGit(root);
    mkdirSync(join(root, '.setupscore'));
    writeFileSync(join(root, '.setupscore', 'tasks.json'), JSON.stringify({ schemaVersion: 1, tasks: [] }));
    const flags = {
      setupA: 'working',
      repeat: 1,
      budget: 1,
      attemptBudget: 1,
      maxTurns: 5,
      timeout: 1,
      concurrency: 1,
      sandbox: 'none',
      yes: true,
      claudeBin: fake('solve'),
    } as RunFlags;
    const saved = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = KEY;
    try {
      await expect(startRun({ dir: root, flags, config: {} as never, log: () => {} })).rejects.toBeInstanceOf(
        NothingToDo,
      );
    } finally {
      process.env['ANTHROPIC_API_KEY'] = saved;
    }
    const r = cli(['run', root, '--claude-bin', fake('solve'), ...NONE]);
    expect(r.code).toBe(1);
    expect(r.err).not.toMatch(/bug/i);
  });

  it('shows the real per-session limit when --attempt-budget is raised to the minimum (real-claude C12)', () => {
    const root = project();
    const r = cli(['run', root, '--claude-bin', fake('solve'), '--repeat', '1', '--attempt-budget', '0.001', ...NONE]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/each session at \$0\.05 \(the smallest limit/);
  });
});

describe('the model Claude Code really used (real-claude C03)', () => {
  it('warns once when it differs from --model and stores it in run.json', () => {
    const root = project();
    const r = cli([
      'run',
      root,
      '--claude-bin',
      fake('model-used', '--model-used=claude-opus-5-5'),
      '--model',
      'claude-opus-4-1',
      '--repeat',
      '2',
      ...NONE,
    ]);
    expect(r.code, r.err).toBe(0);
    expect(r.out.match(/Claude Code used claude-opus-5-5/g)).toHaveLength(1);
    expect(runJson(root)).toMatchObject({ modelUsed: 'claude-opus-5-5', options: { model: 'claude-opus-4-1' } });
  });
});

describe('secrets never reach the disk or the terminal (D5, V06, V10)', () => {
  it('an agent that prints the key in its output, its message and the test output', () => {
    const root = project();
    const ok = cli(['run', root, '--claude-bin', fake('leak-key'), '--repeat', '1', ...NONE]);
    expect(ok.code, ok.err).toBe(0);
    const failed = lines(root);
    expect(failed.every((a) => a.status === 'failed')).toBe(true);
    const crash = cli(['run', root, '--claude-bin', fake('leak-key', '--crash'), '--repeat', '1', ...NONE]);
    expect(crash.code).toBe(3);
    for (const out of [ok.out, ok.err, crash.out, crash.err]) expect(out).not.toContain(KEY);
    const grep = spawnSync('grep', ['-rl', KEY, join(root, '.setupscore')], { encoding: 'utf8' });
    expect(grep.stdout).toBe('');
    expect(JSON.stringify(failed)).toContain('[redacted]'); // the test output was kept, without the key
  });
});

describe('the agent cannot use the web or hide its tracks', () => {
  it('web search is turned off, and an attempt that used it does not count', () => {
    expect(claudeCommand({ bin: 'claude', promptFile: '/p', maxTurns: 3, maxBudgetUsd: 1 })).toContain(
      '--disallowedTools WebSearch,WebFetch',
    );
    const root = project();
    const log = join(mkdtempSync(join(tmpdir(), 'setupscore-web-')), 'argv');
    const r = cli([
      'run',
      root,
      '--claude-bin',
      fake('web-search', `--log=${log}`),
      '--repeat',
      '1',
      '--json',
      ...NONE,
    ]);
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(log, 'utf8')).toContain('--disallowedTools WebSearch,WebFetch');
    const rows: { status: string; reason?: string }[] = JSON.parse(r.out).attempts;
    expect(rows.every((a) => a.status === 'failed' && /used WebSearch/.test(a.reason ?? ''))).toBe(true);
  });

  it('the prompt never points at setup files (every setup gets the same words)', () => {
    expect(
      agentPrompt(
        'Add count.\n\nChange the code in this repository to do this, following the project instructions (CLAUDE.md).\n',
      ),
    ).toBe('Add count.\n\nChange the code in this repository to do this.\n');
  });
});

describe('monorepo packages (real-repos)', () => {
  it('the fake agent solves tasks in a package folder', () => {
    const root = project({ sub: 'packages/shop' });
    const r = cli(['run', root, '--claude-bin', fake('solve'), '--repeat', '1', '--json', ...NONE]);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).attempts.map((a: { status: string }) => a.status)).toEqual(['passed', 'passed']);
  });
});

describe('a missing package manager stops the run once, with an install hint (linux-env T33)', () => {
  it('unit', () => {
    expect(missingTool('pnpm install --frozen-lockfile', { PATH: '/nonexistent' })).toMatchObject({
      message: expect.stringContaining('pnpm is not installed'),
      fix: expect.stringContaining('corepack enable'),
    });
    expect(missingTool('npm ci')).toBeNull();
    expect(missingTool('CI=1 weird install')).toBeNull();
    expect(missingTool(null)).toBeNull();
  });

  posixOnly('in a run', () => {
    const root = project();
    writeFileSync(join(root, 'setupscore.yml'), 'version: 1\ntasks:\n  install: nosuch-pm install\n');
    const n = counter();
    const r = cli(['run', root, '--claude-bin', counted(n, 'solve'), '--repeat', '2', ...NONE]);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/nosuch-pm is not installed/);
    expect(calls(n)).toBe(0);
  });
});

describe('gateways the sandbox cannot reach (real-claude F03, F18, A09)', () => {
  const env = (url: string) => ({ ANTHROPIC_BASE_URL: url });
  const check = (
    url: string,
    platform: NodeJS.Platform = 'linux',
    resolve = () => Promise.resolve(['93.184.216.34']),
  ) => endpointProblem({ sandboxed: true, env: env(url), platform, resolve });
  it('local, private and single-label hosts are refused before the run', async () => {
    expect((await check('http://127.0.0.1:9'))?.message).toMatch(/this machine/);
    expect((await check('http://localhost:4000'))?.message).toMatch(/localhost/);
    expect((await check('http://[::1]:4000'))?.message).toMatch(/this machine/);
    expect((await check('http://10.1.2.3'))?.message).toMatch(/private network/);
    expect((await check('http://192.168.1.5:8080'))?.message).toMatch(/private network/);
    expect((await check('http://169.254.169.254'))?.message).toMatch(/link-local/);
    expect((await check('http://litellm:4000'))?.message).toMatch(/single name/);
    expect((await check('http://gw.internal', 'linux', () => Promise.resolve(['127.0.0.1'])))?.message).toMatch(
      /resolves to 127\.0\.0\.1/,
    );
    expect(await check('https://gateway.example.com')).toBeNull();
    expect(await check('http://gw.corp.example', 'linux', () => Promise.resolve(['10.0.0.8']))).toBeNull(); // through the proxy
    expect(await check('http://127.0.0.1:4000', 'darwin')).toBeNull(); // Seatbelt allows localhost
    expect(await endpointProblem({ sandboxed: false, env: env('http://127.0.0.1:9') })).toBeNull();
    expect((await endpointProblem({ sandboxed: false, env: env('not a url') }))?.message).toMatch(/not a usable URL/);
  });
  it('the agent allow list never carries a name the runtime refuses', () => {
    expect(agentDomains({ ANTHROPIC_BASE_URL: 'http://litellm:4000' })).toEqual(['api.anthropic.com']);
    expect(agentDomains({ ANTHROPIC_BASE_URL: 'https://gw.example.com/v1' })).toContain('gw.example.com');
    expect(['a.b', 'localhost', '[::1]', '10.0.0.1'].every(isAllowableHost)).toBe(true);
    expect(['litellm', '', 'a..b', '-a.b'].some(isAllowableHost)).toBe(false);
  });
});

describe('looking outside the task, on every OS (W7, M6)', () => {
  it('Windows paths in any spelling', () => {
    const top = 'C:\\Users\\me\\shop';
    for (const t of [
      'type C:\\Users\\me\\shop\\src\\tax.js',
      'cat /c/Users/me/shop/src/tax.js',
      'cat /mnt/c/Users/me/shop/x',
      'import x from "c:/users/ME/shop/src"',
      'readFileSync("C:\\\\Users\\\\me\\\\shop\\\\src")',
    ]) {
      expect(lookedOutside([t], top), t).toHaveLength(1);
    }
    expect(lookedOutside(['type .git\\objects\\info\\alternates'], top)).toHaveLength(1);
    expect(lookedOutside(['cat C:\\Users\\me\\shopping\\list'], top)).toEqual([]);
    expect(lookedOutside(['cat /c/users/me/shop2/a'], top)).toEqual([]);
  });
  it('macOS case, Unicode and /private spellings', () => {
    expect(lookedOutside(['cat /private/var/folders/x/Shop/src'], '/var/folders/x/shop')).toHaveLength(1);
    expect(lookedOutside(['cat /Users/me/Cafe\u0301/src'], '/Users/me/Caf\u00e9')).toHaveLength(1);
  });
  it('rule matching stays fast on huge lines (fuzz: quadratic regex)', () => {
    const line = `- ${'never use `'.repeat(20_000)}`;
    const t = Date.now();
    forbiddenRules({ 'CLAUDE.md': `${line}\n- ${'never use x'.repeat(5000)}\n- Never use \`console.log\`\n` });
    expect(Date.now() - t).toBeLessThan(2000);
    expect(forbiddenRules({ 'CLAUDE.md': '- Never use `console.log`\n' }).map((r) => r.token)).toEqual(['console.log']);
  });
});

describe('Windows command lookup (W9)', () => {
  it('finds claude.cmd through PATHEXT and a Path spelled in mixed case', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'setupscore-win-')));
    writeFileSync(join(dir, 'claude.cmd'), '@echo off');
    expect(
      commandPaths('claude -p', { Path: dir, PATHEXT: '.COM;.EXE;.CMD' }, 'win32').map((p) => p.toLowerCase()),
    ).toEqual([join(dir, 'claude.cmd').toLowerCase()]);
    expect(commandPaths('claude -p', { PATH: dir }, 'linux')).toEqual([]);
  });
});

const rt = await loadRuntime({ cwd: process.cwd(), install: false });
const osSandbox = rt ? (await probeOsSandbox(rt)).ok : false;

describe.runIf(osSandbox)(
  'inside the OS sandbox the agent cannot reach what setupscore keeps aside (architecture review)',
  () => {
    it('kept node_modules, parked installs and git hooks cannot be changed: a planted `node` never reaches the hidden tests', () => {
      const root = project({ dep: true }); // installed dependencies, so there is an original kept aside
      const log = join('/tmp/claude', `pristine-${process.pid}-${Date.now()}`);
      const mark = join('/tmp/claude', `hook-${process.pid}-${Date.now()}`);
      const r = cli([
        'run',
        root,
        '--claude-bin',
        fake('cheat-pristine', `--log=${log}`, `--hook-mark=${mark}`),
        '--repeat',
        '2',
        '--concurrency',
        '1',
        '--yes',
        '--json',
      ]);
      expect(r.code, r.err).toBe(0);
      const rows: { status: string }[] = JSON.parse(r.out).attempts;
      expect(
        rows.every((a) => a.status === 'failed'),
        JSON.stringify(rows),
      ).toBe(true);
      expect(existsSync(log) ? readFileSync(log, 'utf8').trim() : '').toBe('');
      expect(existsSync(mark)).toBe(false);
    });

    it('an agent that rewrites its own transcript is still caught digging', () => {
      const root = project();
      const r = cli(['run', root, '--claude-bin', fake('cheat-erase'), '--repeat', '1', '--yes', '--json']);
      expect(r.code, r.err).toBe(0);
      const rows: { status: string; reason?: string }[] = JSON.parse(r.out).attempts;
      expect(rows.every((a) => a.status === 'failed' && /looked for the answer/.test(a.reason ?? ''))).toBe(true);
    });

    it('a gateway the runtime refuses is a clear error before the run, never a crash', () => {
      const root = project();
      const r = cli(['run', root, '--claude-bin', fake('solve'), '--yes'], { ANTHROPIC_BASE_URL: 'http://vm:18080' });
      expect(r.code).toBe(3);
      expect(r.err).not.toMatch(/Something went wrong/);
      expect(runs(root)).toEqual([]);
    });
  },
);
