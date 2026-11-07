import { spawn } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTasks } from '../src/commands/run.js';
import { UsageError } from '../src/core/errors.js';
import { forEachLine, readTailSafely } from '../src/core/fsx.js';
import { redact } from '../src/core/redact.js';
import { planAttempts } from '../src/run/runner.js';
import {
  attemptKey,
  capOutput,
  MAX_TEST_OUTPUT,
  parseAttempt,
  RunStore,
  type Attempt,
  type RunRecord,
} from '../src/run/store.js';

const temp = () => mkdtempSync(join(tmpdir(), 'setupscore-store-'));

const task = (id: string) => ({
  id,
  hash: `${id}hash`,
  parent: `${id}parent`,
  title: `Task ${id}`,
  date: '',
  prompt: 'Do it.',
  testFiles: ['a.test.js'],
  sourceFiles: [],
  newTests: [],
  beforeMs: 1,
  afterMs: 1,
});
const setup = (label: string, files: Record<string, string> = { 'CLAUDE.md': '- Never use `console.log`\n' }) => ({
  label,
  source: label === 'baseline' ? 'none' : 'working',
  files,
  health: 9,
  startupTokens: 10,
  lintErrors: 0,
  lintWarnings: 0,
});
function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: 1,
    id: RunStore.newId(),
    createdAt: new Date().toISOString(),
    status: 'completed',
    head: null,
    tool: { version: '0.1.0' },
    options: {
      repeat: 2,
      budgetUsd: 5,
      maxTurns: 30,
      attemptBudgetUsd: 1.5,
      agentTimeoutMin: 15,
      concurrency: 1,
      sandbox: 'none',
    },
    tasks: [task('t1'), task('t2')],
    setups: [setup('A')],
    ...over,
  };
}
const attempt = (taskId: string, label: string, repeat: number, over: Partial<Attempt> = {}): Attempt => ({
  key: attemptKey(taskId, label, repeat),
  taskId,
  setup: label,
  repeat,
  status: 'passed',
  startedAt: '',
  finishedAt: '',
  ms: 1,
  retries: 0,
  metrics: { costUsd: 0.1 } as never,
  ...over,
});

/** A project with one run, made through the store itself; the store is unlocked as a finished run would be. */
function withRun(over: Partial<RunRecord> = {}) {
  const dir = temp();
  const store = RunStore.create(dir, record(over));
  store.unlock();
  return { dir, store, file: (name: string) => join(store.dir, name) };
}

const message = (fn: () => unknown) => {
  try {
    fn();
    return 'no error';
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError); // a plain message, never "this is a bug"
    return (err as Error).message;
  }
};

describe('damaged or hand-edited run.json gives a plain message (D10, R4-R29, fuzz)', () => {
  const cases: [string, string, RegExp][] = [
    ['null', 'null', /cannot be read: run\.json is empty/],
    ['empty object', '{}', /no format version/],
    ['empty file', '', /run\.json is empty/],
    ['schema only', '{"schemaVersion":1}', /no tasks, setups or options/],
    ['other version', '{"schemaVersion":7}', /different setupscore version \(format 7\)/],
    ['setups not a list', JSON.stringify({ ...record(), setups: 'x' }), /no tasks, setups or options/],
    [
      'setup without files',
      JSON.stringify({ ...record(), setups: [{ label: 'A', source: 'working' }] }),
      /a setup is incomplete/,
    ],
    ['null task', JSON.stringify({ ...record(), tasks: [null] }), /a task is incomplete/],
    ['duplicate task ids', JSON.stringify({ ...record(), tasks: [task('t1'), task('t1')] }), /listed twice/],
    [
      'duplicate setup labels',
      JSON.stringify({ ...record(), setups: [setup('A'), setup('A')] }),
      /setup A is listed twice/,
    ],
    [
      'budget is text',
      JSON.stringify({ ...record(), options: { ...record().options, budgetUsd: 'abc' } }),
      /options are incomplete/,
    ],
    ['repeat 1e9', JSON.stringify({ ...record(), options: { ...record().options, repeat: 1e9 } }), /repeat count/],
  ];
  for (const [name, text, expected] of cases) {
    // eslint-disable-next-line vitest/valid-title -- the names are the string literals in the table above
    it(name, () => {
      const { store, file } = withRun();
      writeFileSync(file('run.json'), text);
      expect(message(() => store.readRun())).toMatch(expected);
    });
  }

  it('cleans what it can use: a BOM, numbers written as text, a missing title, junk in setup files', () => {
    const { store, file } = withRun();
    const r = JSON.parse(readFileSync(file('run.json'), 'utf8'));
    r.options.repeat = '2';
    delete r.tasks[0].title;
    r.setups[0].files['bad.md'] = 42;
    r.setups[0].health = 'x';
    r.id = 'some-other-id';
    writeFileSync(file('run.json'), `\uFEFF${JSON.stringify(r)}`);
    const run = store.readRun();
    expect(run.options.repeat).toBe(2);
    expect(run.tasks[0]!.title).toBe('t1');
    expect(run.setups[0]!.files).not.toHaveProperty('bad.md');
    expect(run.setups[0]!.health).toBe(0);
    expect(run.id).toBe(store.id); // the folder name wins
  });

  it('a run left "running" by a process that is gone reads as stopped (D7, K06)', () => {
    const { store, file } = withRun();
    const r = JSON.parse(readFileSync(file('run.json'), 'utf8'));
    writeFileSync(file('run.json'), JSON.stringify({ ...r, status: 'running' }));
    writeFileSync(file('lock'), '999999999\n'); // no such process
    expect(store.readRun()).toMatchObject({ status: 'stopped', stopReason: expect.stringContaining('interrupted') });
  });
});

describe('attempts.jsonl', () => {
  it('skips lines that are not attempts and makes every field the right type (A03-A22, fuzz)', () => {
    expect(parseAttempt('null')).toBeNull();
    expect(parseAttempt('[1]')).toBeNull();
    expect(parseAttempt('"x"')).toBeNull();
    expect(parseAttempt(JSON.stringify({ key: ['x'], taskId: 't1', setup: 'A', status: 'passed' }))).toBeNull();
    const a = parseAttempt(
      JSON.stringify({
        key: 't1|A|1',
        taskId: 't1',
        setup: 'A',
        repeat: 1,
        status: 'failed',
        ms: '12',
        metrics: { costUsd: '0.05', turns: 'x', toolCalls: { constructor: 2, Bash: 'many' }, bashCommands: [1, 'ls'] },
        checks: { ruleViolations: null, filesChanged: 'a.ts', testOutput: 'x'.repeat(1_000_000) },
      }),
    )!;
    expect(a.metrics!.costUsd).toBe(0.05); // a number written as text still counts
    expect(a.metrics!.turns).toBe(0);
    expect(a.metrics!.toolCalls.constructor).toBe(2);
    expect(a.metrics!.toolCalls).not.toHaveProperty('Bash');
    expect(a.metrics!.bashCommands).toEqual(['ls']);
    expect(a.checks).toMatchObject({ ruleViolations: [], filesChanged: [], testsPassed: null });
    expect(a.checks!.testOutput!.length).toBeLessThanOrEqual(MAX_TEST_OUTPUT);
    expect(a.ms).toBe(0);
    for (const bad of [-5, Number.MAX_VALUE * 10, 'abc', null, Infinity]) {
      expect(
        parseAttempt(
          JSON.stringify({ key: 'k', taskId: 't', setup: 'A', status: 'passed', metrics: { costUsd: bad } }),
        )!.metrics!.costUsd,
      ).toBe(0);
    }
  });

  it('a partial last line (crash mid-write) does not swallow the next attempt (R5, D1, G03)', () => {
    const { store, file } = withRun();
    appendFileSync(file('attempts.jsonl'), `${JSON.stringify(attempt('t1', 'A', 1))}\n{"key":"t1|A|2","taskId`);
    store.appendAttempt(attempt('t2', 'A', 1));
    const warnings: string[] = [];
    expect(
      store
        .readAttempts((m) => warnings.push(m))
        .map((a) => a.key)
        .sort(),
    ).toEqual(['t1|A|1', 't2|A|1']);
    expect(warnings).toHaveLength(1);
  });

  it('keeps only attempts the run planned, and keeps the cost of attempts that were run again (A11-A13, A23, D8)', () => {
    const { store } = withRun();
    store.appendAttempt(attempt('t1', 'A', 1, { status: 'error', metrics: { costUsd: 0.9 } as never }));
    store.appendAttempt(attempt('t1', 'A', 1, { metrics: { costUsd: 0.05 } as never })); // the re-run
    store.appendAttempt(attempt('t9', 'A', 1)); // a task the run does not have
    store.appendAttempt(attempt('t1', 'Z', 1)); // a setup the run does not have
    store.appendAttempt(attempt('t1', 'A', 3)); // beyond --repeat 2
    store.appendAttempt({ ...attempt('t2', 'A', 1), key: 't2|A|2' }); // key and fields disagree
    const list = store.readAttempts();
    expect(list.map((a) => a.key)).toEqual(['t1|A|1']);
    expect(list[0]!.status).toBe('passed');
    expect(list[0]!.metrics!.costUsd).toBeCloseTo(0.95);
    expect(store.spentUsd()).toBeCloseTo(0.95 + 0.1 * 4);
  });

  it('reads a BOM, and an attempts.jsonl that is a folder is just empty (A16, A19)', () => {
    const { store, file } = withRun();
    writeFileSync(file('attempts.jsonl'), `\uFEFF${JSON.stringify(attempt('t1', 'A', 1))}\n`);
    expect(store.readAttempts()).toHaveLength(1);
    rmSync(file('attempts.jsonl'));
    mkdirSync(file('attempts.jsonl'));
    expect(store.readAttempts()).toEqual([]);
  });

  it('caps what one attempt stores, and stores no secrets (D5, V06, perf)', () => {
    const key = 'sk-ant-api03-STORETESTKEY0123456789abcdef';
    process.env.ANTHROPIC_API_KEY_FOR_TEST = key;
    const { store, file } = withRun();
    store.appendAttempt(
      attempt('t1', 'A', 1, {
        status: 'failed',
        reason: `failed with ${key} ${'y'.repeat(5000)}`,
        checks: {
          testsPassed: false,
          testOutput: `${'line\n'.repeat(10_000)}${key}`,
          ruleViolations: [],
          filesChanged: [],
          ranTests: false,
          touchedSetup: false,
        },
      }),
    );
    const text = readFileSync(file('attempts.jsonl'), 'utf8');
    expect(text).not.toContain(key);
    expect(text.length).toBeLessThan(MAX_TEST_OUTPUT + 4000);
    const a = store.readAttempts()[0]!;
    expect(a.checks!.testOutput).toContain('[redacted]'); // the end of the output is kept
    delete process.env.ANTHROPIC_API_KEY_FOR_TEST;
  });

  it('reads files line by line, past what one string can hold, skipping lines that are too long', () => {
    const dir = temp();
    const f = join(dir, 'big.jsonl');
    writeFileSync(f, `a\n${'x'.repeat(3 * 1024 * 1024)}\nb\nc`);
    const lines: (string | null)[] = [];
    expect(forEachLine(f, (l) => lines.push(l), 1024 * 1024)).toBe(true);
    expect(lines).toEqual(['a', null, 'b', 'c']);
    expect(readTailSafely(f, 3)).toBe('b\nc');
    expect(forEachLine(dir, () => {})).toBe(false);
  });

  it('capOutput keeps the end and shortens long lines', () => {
    const out = capOutput(`${'start\n'.repeat(5000)}${'z'.repeat(2000)}\nthe end`);
    expect(out.length).toBeLessThanOrEqual(MAX_TEST_OUTPUT);
    expect(out.endsWith('the end')).toBe(true);
    expect(out).toContain('…');
  });
});

describe('run ids, latest and locks', () => {
  it('refuses ids that leave .setupscore/runs, and empty ones (D3, R11, L03, L04)', () => {
    const { dir } = withRun();
    for (const id of ['', '   ', '../x', '../../../../outside', '.hidden', 'a/b'])
      expect(message(() => RunStore.open(dir, id))).toMatch(/run id|No run id/);
  });

  it('"latest" falls back to the newest run when the pointer is empty, a folder, outside or wrong (G13, L02, L07, L08)', () => {
    const { dir, store } = withRun();
    const latest = join(dir, '.setupscore', 'latest');
    for (const damage of [
      () => {
        writeFileSync(latest, '');
      },
      () => {
        writeFileSync(latest, '../../../../etc\n');
      },
      () => {
        writeFileSync(latest, 'nope\n');
      },
      () => {
        mkdirSync(latest);
      },
    ]) {
      rmSync(latest, { recursive: true, force: true });
      damage();
      expect(RunStore.open(dir).id).toBe(store.id);
    }
  });

  it('files are private (V08), "latest" is replaced rather than written through a link (D4, L14)', () => {
    const dir = temp();
    const outside = join(temp(), 'target.txt');
    writeFileSync(outside, 'keep me');
    mkdirSync(join(dir, '.setupscore'));
    symlinkSync(outside, join(dir, '.setupscore', 'latest'));
    const store = RunStore.create(dir, record());
    store.unlock();
    expect(readFileSync(outside, 'utf8')).toBe('keep me');
    if (process.platform !== 'win32') {
      expect(statSync(join(store.dir, 'run.json')).mode & 0o777).toBe(0o600);
      expect(statSync(store.dir).mode & 0o777).toBe(0o700);
    }
  });

  it('one process per run: a second lock is refused while the owner lives, and taken over after (R7, D6)', async () => {
    const { store } = withRun();
    const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    writeFileSync(join(store.dir, 'lock'), `${owner.pid}\n`);
    expect(
      message(() => {
        store.lock();
      }),
    ).toMatch(/already being worked on/);
    owner.kill('SIGKILL');
    await new Promise((r) => owner.on('exit', r));
    store.lock();
    expect(readFileSync(join(store.dir, 'lock'), 'utf8').trim()).toBe(String(process.pid));
    store.unlock();
  });

  it('a run created while .setupscore is a file says so (D01)', () => {
    const dir = temp();
    writeFileSync(join(dir, '.setupscore'), 'hi');
    expect(message(() => RunStore.create(dir, record()))).toMatch(/Cannot create/);
  });
});

describe('the run record never holds a credential (D5, V07)', () => {
  it('redacts known variables and key shapes in run.json, attempts and reports', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant-api03-REDACTTEST000000000000' };
    expect(redact('key=sk-ant-api03-REDACTTEST000000000000', env)).toBe('key=[redacted]');
    for (const secret of [
      'ghp_PRIVACYTESTTOKEN0123456789abcdefABCD',
      'sk-proj-PRIVACYTESTOPENAI0123456789',
      'xoxb-1234567890-abcdefghij',
      'AKIAIOSFODNN7EXAMPLE',
      '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
    ]) {
      expect(redact(`x ${secret} y`, {})).toBe('x [redacted] y');
    }
    const { store, file } = withRun({
      setups: [setup('A', { '.mcp.json': '{"env":{"GITHUB_TOKEN":"ghp_PRIVACYTESTTOKEN0123456789abcdefABCD"}}' })],
    });
    store.saveRun(store.readRun());
    store.writeFile('report.md', 'token ghp_PRIVACYTESTTOKEN0123456789abcdefABCD');
    expect(readFileSync(file('run.json'), 'utf8')).not.toContain('ghp_PRIVACY');
    expect(readFileSync(file('report.md'), 'utf8')).not.toContain('ghp_PRIVACY');
  });
});

describe('tasks.json (fuzz: tasks-json-null, T05-T18)', () => {
  const write = (body: string) => {
    const f = join(temp(), 'tasks.json');
    writeFileSync(f, body);
    return f;
  };
  it('gives a plain message for anything that is not a task file', () => {
    for (const body of [
      'null',
      '[]',
      '"x"',
      '{}',
      '{"schemaVersion":1,"tasks":[null]}',
      '{"schemaVersion":1,"tasks":"x"}',
      'not json',
    ]) {
      expect(message(() => loadTasks(write(body)))).toMatch(
        /task file|Cannot read|incomplete|different setupscore version/,
      );
    }
    expect(
      message(() => loadTasks(write(JSON.stringify({ schemaVersion: 1, tasks: [task('t1'), task('t1')] })))),
    ).toMatch(/listed twice/);
    expect(message(() => loadTasks(temp()))).toMatch(/Cannot read/);
  });
  it('reads a BOM and fills a missing title', () => {
    const t: Partial<ReturnType<typeof task>> = task('t1');
    delete t.title;
    expect(loadTasks(write(`\uFEFF${JSON.stringify({ schemaVersion: 1, tasks: [t] })}`))[0]).toMatchObject({
      id: 't1',
      title: 't1',
    });
  });
});

describe('the plan', () => {
  it('goes task by task (all setups and repeats of a task together), so installs are reused', () => {
    const run = record({ setups: [setup('A'), setup('baseline', {})] });
    expect(planAttempts(run).map((p) => p.key)).toEqual([
      't1|A|1',
      't1|baseline|1',
      't1|A|2',
      't1|baseline|2',
      't2|A|1',
      't2|baseline|1',
      't2|A|2',
      't2|baseline|2',
    ]);
  });
});

it.runIf(process.platform !== 'win32')('an unreadable run folder is reported, not a crash', () => {
  if (process.getuid?.() === 0) return; // root reads everything
  const { store, file } = withRun();
  chmodSync(file('run.json'), 0);
  expect(() => store.readRun()).toThrow(UsageError);
  expect(existsSync(file('run.json'))).toBe(true);
});
