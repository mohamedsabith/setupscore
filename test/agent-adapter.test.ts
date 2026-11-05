import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyAgentFailure, stderrSummary, type FailureClass } from '../src/agent/claude.js';
import { emptyMetrics, modelMismatch, parseTranscript, runsTests, type AgentMetrics } from '../src/agent/transcript.js';
import { ranTests } from '../src/run/checks.js';

// Real transcripts of Claude Code 2.1.318 against a mock Anthropic API (see test/fixtures/transcripts).
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/transcripts/${name}.jsonl`, import.meta.url), 'utf8');
const parse = (name: string) => parseTranscript(fixture(name));
const lines = (...events: unknown[]) => events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n');
const classify = (
  m: AgentMetrics,
  o: { stderr?: string; exit?: number | null; timedOut?: boolean; endedAt?: number } = {},
): FailureClass =>
  classifyAgentFailure(
    m,
    o.stderr ?? '',
    o.exit === undefined ? (m.outcome === 'completed' ? 0 : 1) : o.exit,
    o.timedOut ?? false,
    o.endedAt === undefined ? {} : { endedAt: o.endedAt },
  );

describe('failure classes from real transcripts', () => {
  const cases: [string, FailureClass['kind'], RegExp?][] = [
    ['happy', 'ok'],
    ['transient-401-then-success', 'ok'],
    ['529-once-api-retry', 'ok'],
    ['background-subagent-two-results', 'ok'],
    ['subagent-nested-two-results', 'ok'],
    ['model-swapped', 'ok'],
    ['fake-api-key', 'fatal', /rejected the API key/],
    ['real-not-logged-in', 'fatal', /rejected the API key/],
    ['api-401-forever', 'fatal', /rejected the API key/],
    ['api-403', 'fatal', /rejected the API key/],
    ['billing-midrun', 'fatal', /no credit/],
    ['bad-model-404', 'fatal', /model claude-nope-1/],
    ['invalid-base-url', 'fatal', /not a valid URL/],
    ['sandbox-localhost-econnrefused', 'retry', /busy or unreachable.*ECONNREFUSED/i],
    ['api-enotfound', 'retry', /ENOTFOUND/],
    ['api-408', 'retry'],
    ['api-500', 'retry'],
    ['api-502-html', 'retry'],
    ['api-529-forever', 'retry'],
    ['api-429-forever', 'retry'],
    ['api-400-not-json', 'retry'],
    ['stream-cut-always', 'retry', /ECONNRESET/],
    ['connection-lost-midresponse', 'retry', /Connection lost/],
    ['max-turns', 'task', /turn limit/],
    ['budget-big-usage', 'task', /spending limit/],
    ['refusal', 'task', /can't help/],
    ['rate-limit-allowed-refusal', 'task', /can't help/],
    ['prompt-too-long', 'task', /Prompt is too long/],
  ];
  for (const [name, kind, message] of cases) {
    it(`${name} -> ${kind}`, () => {
      const m = parse(name);
      expect(m.badLines).toBe(0);
      const verdict = classify(m);
      expect(verdict.kind).toBe(kind);
      if (message) expect('message' in verdict ? verdict.message : '').toMatch(message);
    });
  }

  it('gives clear fixes for a bad model and a bad ANTHROPIC_BASE_URL', () => {
    expect(classify(parse('bad-model-404'))).toMatchObject({ kind: 'fatal', fix: expect.stringContaining('--model') });
    expect(classify(parse('invalid-base-url'))).toMatchObject({
      kind: 'fatal',
      fix: expect.stringContaining('ANTHROPIC_BASE_URL'),
    });
  });

  it('only the error that ended the session counts, not API retries Claude Code recovered from', () => {
    const m = parse('transient-401-then-success');
    expect(m.errorCodes).toContain('authentication_failed');
    expect(m.apiRetries).toBe(1);
    expect(m.finalErrorCode).toBeUndefined();
    // The same recovered 401, then the agent hits the turn limit: a task failure, not a bad key.
    const text = fixture('transient-401-then-success')
      .split('\n')
      .filter((l) => !l.includes('"type":"result"'));
    const maxTurns = JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      num_turns: 4,
      total_cost_usd: 0.01,
      terminal_reason: 'max_turns',
      errors: ['Reached maximum number of turns (3)'],
    });
    expect(classify(parseTranscript([...text, maxTurns].join('\n')))).toMatchObject({
      kind: 'task',
      message: 'the agent hit the turn limit',
    });
    // And with no result at all (killed): still not fatal.
    expect(classify(parseTranscript(text.join('\n')), { exit: 137 }).kind).toBe('retry');
  });

  it('treats an "allowed" rate-limit notice as information, not an error', () => {
    expect(parse('rate-limit-event').errorCodes).not.toContain('rate_limit');
    expect(parse('rate-limit-allowed-refusal').errorCodes).not.toContain('rate_limit');
    const rejected = parseTranscript(lines({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }));
    expect(rejected.errorCodes).toContain('rate_limit');
  });

  it('a session killed at --timeout while only waiting on the API is retried, not scored', () => {
    const retrying = parse('timeout-during-529');
    expect(retrying).toMatchObject({
      outcome: 'no_result',
      lastEventKind: 'api_retry',
      apiRetriesAtEnd: 7,
      lastRetryError: 'overloaded',
    });
    expect(classify(retrying, { timedOut: true, exit: null })).toEqual({
      kind: 'retry',
      message: 'the Claude API did not answer (Claude Code was retrying: overloaded)',
    });
    const silent = parse('api-never-answers-timeout');
    expect(silent.lastEventKind).toBe('init');
    expect(classify(silent, { timedOut: true, exit: null })).toEqual({
      kind: 'retry',
      message: 'the Claude API did not answer',
    });
  });

  it('a timeout with a command still running, or with recent progress, is the agent running out of time', () => {
    const all = fixture('happy').split('\n').filter(Boolean);
    const upTo = (pred: (e: Record<string, unknown>) => boolean) => {
      const i = all.findIndex((l) => pred(JSON.parse(l)));
      return parseTranscript(all.slice(0, i + 1).join('\n'));
    };
    // Killed while "npm test" was running.
    const testing = upTo((e) => JSON.stringify(e).includes('"command":"npm test"'));
    expect(testing).toMatchObject({ lastEventKind: 'tool_use', toolsRunningAtEnd: 1 });
    expect(classify(testing, { timedOut: true, exit: null, endedAt: Date.now() })).toEqual({
      kind: 'task',
      message: 'the agent ran out of time',
    });
    // Killed after a tool result: the model's next answer was due. Long silence -> the API stalled.
    const waiting = upTo((e) => e.type === 'user' && JSON.stringify(e).includes('updated successfully'));
    expect(waiting).toMatchObject({ lastEventKind: 'tool_result', toolsRunningAtEnd: 0 });
    const last = Date.parse(waiting.lastProgressAt!);
    expect(classify(waiting, { timedOut: true, exit: null, endedAt: last + 10 * 60_000 })).toMatchObject({
      kind: 'retry',
      message: 'the Claude API did not answer',
    });
    expect(classify(waiting, { timedOut: true, exit: null, endedAt: last + 30_000 })).toMatchObject({ kind: 'task' });
    expect(classify(waiting, { timedOut: true, exit: null })).toMatchObject({ kind: 'task' });
    // Nothing at all on stdout: no evidence it was the API.
    expect(classify(parseTranscript(''), { timedOut: true, exit: null })).toMatchObject({ kind: 'task' });
  });

  it('a main answer that arrived before the timeout is ok (a background subagent was cut)', () => {
    const m = parse('background-subagent-two-results');
    expect(classify(m, { timedOut: true, exit: null })).toEqual({ kind: 'ok' });
  });

  it('Claude Code that cannot be started is fatal, with the reason', () => {
    const stderr =
      '/tmp/e2e/real-claude/bins/claude-version-only.sh: line 3: /nonexistent/bin/claude: No such file or directory';
    const v = classify(emptyMetrics(), { stderr, exit: 127 });
    expect(v).toMatchObject({ kind: 'fatal', message: expect.stringContaining('could not be started') });
    expect(v.kind === 'fatal' && v.message).toContain('/nonexistent/bin/claude: No such file or directory');
    expect(classify(emptyMetrics(), { stderr: '', exit: 127 }).kind).toBe('fatal');
    expect(
      classify(emptyMetrics(), { stderr: 'bwrap: execvp /opt/claude: No such file or directory', exit: 1 }).kind,
    ).toBe('fatal');
    expect(stderrSummary(`${stderr}\n`)).toContain('No such file or directory');
    // Claude Code did start (it wrote its init event): a later exit 127 is not "missing".
    expect(classify(parse('api-never-answers-timeout'), { exit: 127 }).kind).toBe('retry');
  });
});

describe('metrics from real transcripts', () => {
  it('reads the happy path', () => {
    const m = parse('happy');
    expect(m).toMatchObject({
      outcome: 'completed',
      turns: 5,
      costUsd: 0.01875,
      inputTokens: 5000,
      outputTokens: 250,
      resultCount: 1,
      ranTests: true,
      model: 'claude-sonnet-4-5',
      modelsUsed: ['claude-sonnet-4-5'],
      terminalReason: 'completed',
      lastEventKind: 'result',
      toolsRunningAtEnd: 0,
    });
    expect({ ...m.toolCalls }).toEqual({ Bash: 2, Read: 1, Edit: 1 });
    expect(m.filesEdited).toEqual([expect.stringMatching(/\/price\.js$/)]);
    expect(m.memoryPaths).toEqual([expect.stringMatching(/\/memory\/$/)]); // the auto-memory folder, not CLAUDE.md
  });

  it('combines result events when a background subagent outlives the main answer', () => {
    const m = parse('background-subagent-two-results');
    expect(m).toMatchObject({
      resultCount: 2,
      outcome: 'completed',
      result: 'Done.',
      turns: 3 + 1,
      costUsd: 0.0225,
      inputTokens: 6000,
      outputTokens: 300,
      subagentsUsed: ['general-purpose'],
      ranTests: true,
    });
    const nested = parse('subagent-nested-two-results');
    expect(nested).toMatchObject({
      resultCount: 2,
      costUsd: 0.06375000000000003,
      inputTokens: 17000,
      outputTokens: 850,
    });
    expect(nested.turns).toBe(4 + 1);
  });

  it('takes the outcome from the main answer, the cost from the last result', () => {
    const m = parseTranscript(
      lines(
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Done.',
          num_turns: 3,
          total_cost_usd: 0.1,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: true,
          terminal_reason: 'api_error',
          result: 'API Error: 529 Overloaded',
          num_turns: 1,
          total_cost_usd: 0.12,
          origin: { kind: 'task-notification' },
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      ),
    );
    expect(m).toMatchObject({
      outcome: 'completed',
      result: 'Done.',
      costUsd: 0.12,
      turns: 4,
      inputTokens: 15,
      outputTokens: 2,
    });
    expect(classify(m).kind).toBe('ok');
  });

  it('counts subagent and final-turn tokens from modelUsage', () => {
    expect(parse('background-subagent')).toMatchObject({ inputTokens: 7000, outputTokens: 350 });
    expect(parse('budget-big-usage')).toMatchObject({
      outcome: 'budget',
      inputTokens: 450_000,
      outputTokens: 12_000,
      costUsd: 1.53,
    });
    expect(parse('agent-no-type')).toMatchObject({ inputTokens: 5000, subagentsUsed: ['general-purpose'] });
  });

  it('documents turns as Claude Code counts them', () => {
    expect(parse('parallel-tools')).toMatchObject({ turns: 7 });
    expect({ ...parse('parallel-tools').toolCalls }).toEqual({ Bash: 5, Read: 1 });
    expect(parse('max-turns')).toMatchObject({
      outcome: 'max_turns',
      turns: 4,
      result: 'Reached maximum number of turns (3)',
    });
  });

  it('records the model Claude Code really used', () => {
    const m = parse('model-swapped');
    expect(m).toMatchObject({ model: 'claude-opus-5-5', modelsUsed: ['claude-opus-5-5'] });
    expect(modelMismatch('claude-opus-4-1', m)).toBe('claude-opus-5-5');
    expect(modelMismatch('claude-opus-5-5', m)).toBeUndefined();
    expect(modelMismatch('opus', m)).toBeUndefined();
    expect(modelMismatch('sonnet', m)).toBe('claude-opus-5-5');
    expect(modelMismatch('default', m)).toBeUndefined();
    expect(modelMismatch(undefined, m)).toBeUndefined();
    expect(modelMismatch('claude-sonnet-4-5', { model: 'claude-sonnet-4-5-20250929', modelsUsed: [] })).toBeUndefined();
    expect(parse('bad-model-404').modelsUsed).toEqual([]);
  });

  it('only counts edits and skills that worked', () => {
    for (const name of ['write-refused', 'multiedit-refused', 'notebook-refused']) {
      const m = parse(name);
      expect(m.filesEdited).toEqual([]);
      expect(m.pathsRead.some((p) => /\/(price\.js|nb\.ipynb)$/.test(p))).toBe(true); // still looked at for "looked outside"
    }
    const skill = parse('skill-missing');
    expect(skill.skillsUsed).toEqual([]);
    expect(skill.toolCalls.Skill).toBe(1);
    const synthetic = parseTranscript(
      lines(
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'a.js' } },
              { type: 'tool_use', id: 'e2', name: 'Edit', input: { file_path: 'b.js' } },
              { type: 'tool_use', id: 's1', name: 'Skill', input: { skill: '/deploy' } },
            ],
          },
        },
        {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'e1', is_error: true },
              { type: 'tool_result', tool_use_id: 'e2' },
              { type: 'tool_result', tool_use_id: 's1', is_error: false },
            ],
          },
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'e3', name: 'Edit', input: { file_path: 'a.js' } },
              { type: 'tool_use', id: 't1', name: 'Task', input: { description: 'x' } },
            ],
          },
        },
        {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'e3' },
              { type: 'tool_result', tool_use_id: 't1' },
            ],
          },
        },
      ),
    );
    expect([...synthetic.filesEdited].sort()).toEqual(['a.js', 'b.js']); // a.js failed once, then worked
    expect(synthetic.skillsUsed).toEqual(['deploy']);
    expect(synthetic.subagentsUsed).toEqual(['general-purpose']);
  });
});

describe('ranTests', () => {
  const yes = [
    'npm test',
    'npm t',
    'npm tst',
    'npm run test',
    'npm run-script test',
    'npm run test:unit',
    'npm test -- --test-reporter=spec',
    'pnpm test || true',
    'pnpm --filter api test',
    'pnpm vitest run',
    'yarn test || true',
    'yarn workspace api test',
    'bun test || true',
    'node --test',
    'node --test price.test.js',
    'node --experimental-vm-modules --test',
    'node --test-reporter spec --test',
    'node tax.test.js || node price.test.js',
    'node test/price.test.mjs',
    'npx vitest run',
    'npx --no-install vitest run || true',
    'npx --no-install jest || true',
    'npx mocha',
    'npx -y jest --coverage',
    './node_modules/.bin/vitest run',
    'vitest run src/a.test.ts',
    'cd . && npm test',
    'NODE_ENV=test npm test',
    'CI=1 timeout 120 npm test',
    'npm test 2>&1 | tail -20',
    'bash -c "npm test"',
    'echo start; npm test',
    'echo "$(npm test)" > out.txt',
    "cat > price.js <<'SFEOF'\nexport const a = 1;\nSFEOF\nnpm test",
    `echo ${'x'.repeat(320)} && npm test`,
  ];
  const no = [
    'ls',
    'echo "npm test"',
    'echo "remember to run npm test"',
    "echo 'npm test'",
    'echo npm test',
    'grep -n test package.json',
    'cat package.json | grep "\\"test\\""',
    'ls # npm test',
    '# npm test',
    "cat > README.md <<'EOF'\nRun npm test before you push.\nEOF",
    'git commit -m "make npm test pass"',
    'npm install',
    'npm run lint',
    'npm run build && npm run typecheck',
    'npx vitest --version',
    'jest --help',
    'node index.js',
    'node -e "console.log(1)"',
    '"npm test"',
    'cat test/fixtures/a.json',
  ];
  for (const c of yes) it(`counts: ${c.slice(0, 60).replace(/\n/g, '\\n')}`, () => expect(runsTests(c)).toBe(true));
  for (const c of no)
    it(`does not count: ${c.slice(0, 60).replace(/\n/g, '\\n')}`, () => expect(runsTests(c)).toBe(false));

  it('is not fooled by the 300-character cut or the 200-command cap', () => {
    const long = parseTranscript(
      lines({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'a', name: 'Bash', input: { command: `echo ${'x'.repeat(320)} && npm test` } },
          ],
        },
      }),
    );
    expect(long.bashCommands[0]!.length).toBe(300);
    expect(ranTests(long.bashCommands)).toBe(false);
    expect(long.ranTests).toBe(true);
    expect(ranTests(long)).toBe(true);
    const many = Array.from({ length: 222 }, (_, i) => ({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: `b${i}`, name: 'Bash', input: { command: i === 221 ? 'npm test' : `echo c${i}` } },
        ],
      },
    }));
    const capped = parseTranscript(lines(...many));
    expect(capped.bashCommands.length).toBe(200);
    expect(capped.toolCalls.Bash).toBe(222);
    expect(ranTests(capped)).toBe(true);
    expect(ranTests({ bashCommands: ['npm test'] } as AgentMetrics)).toBe(true); // metrics saved before the flag existed
  });

  it('counts tests a subagent ran', () => {
    expect(ranTests(parse('background-subagent-two-results'))).toBe(true);
  });
});

describe('parser robustness', () => {
  it('handles the fuzz findings', () => {
    const m = parseTranscript('{"type":"result","errors":[{"toString":1}]}');
    expect(typeof m.result).toBe('string');
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      const t = parseTranscript(
        lines({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name },
              { type: 'tool_use', name },
            ],
          },
        }),
      );
      expect(t.toolCalls[name]).toBe(2);
      expect(Object.keys(t.toolCalls)).toEqual([name]);
      expect(Object.getPrototypeOf(t.toolCalls)).toBe(Object.prototype);
      expect(JSON.parse(JSON.stringify(t)).toolCalls[name]).toBe(2);
    }
    expect(parseTranscript(lines({ type: 'result', errors: [1, null, { a: 1 }, { message: 'boom' }] })).result).toBe(
      '1; null; {"a":1}; boom',
    );
  });

  it('never throws, and keeps numbers numbers, for mangled transcripts', () => {
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const special = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'];
    const value = (d = 0): unknown =>
      pick<() => unknown>([
        () => null,
        () =>
          pick([
            true,
            false,
            0,
            -1,
            1e308,
            0.5,
            '',
            'x',
            '1e400',
            'success',
            'error_max_turns',
            'api_error',
            'Bash',
            ...special,
          ]),
        () => ({ toString: pick([1, 'x', null, {}]), valueOf: pick([1, {}, null]) }),
        () => (d > 3 ? [] : [value(d + 1), value(d + 1)]),
        () =>
          d > 3
            ? {}
            : Object.fromEntries([
                [
                  pick([
                    ...special,
                    'type',
                    'name',
                    'id',
                    'input',
                    'content',
                    'message',
                    'error',
                    'usage',
                    'modelUsage',
                    'timestamp',
                  ]),
                  value(d + 1),
                ],
              ]),
      ])();
    const base = ['happy', 'background-subagent-two-results', 'timeout-during-529', 'refusal', 'skill-missing'].flatMap(
      (n) =>
        fixture(n)
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as unknown),
    );
    const mutate = (ev: unknown): unknown => {
      const clone = JSON.parse(JSON.stringify(ev)) as unknown;
      const paths: (string | number)[][] = [];
      const walk = (o: unknown, p: (string | number)[]) => {
        if (o && typeof o === 'object')
          for (const k of Object.keys(o)) (paths.push([...p, k]), walk((o as Record<string, unknown>)[k], [...p, k]));
      };
      walk(clone, []);
      for (let n = 1 + Math.floor(rand() * 3); n > 0 && paths.length; n--) {
        const p = pick(paths);
        let o = clone as Record<string | number, unknown>;
        for (const k of p.slice(0, -1)) o = (o?.[k] ?? {}) as Record<string | number, unknown>;
        if (o && typeof o === 'object') o[p.at(-1)!] = value();
      }
      if (rand() < 0.1 && clone && typeof clone === 'object')
        (clone as Record<string, unknown>)[pick(special)] = value();
      return clone;
    };
    for (let round = 0; round < 1500; round++) {
      const events = Array.from({ length: 1 + Math.floor(rand() * 12) }, () =>
        rand() < 0.5 ? mutate(pick(base)) : value(),
      );
      const text = events
        .map((e) => (rand() < 0.05 ? JSON.stringify(e).slice(0, 20) : JSON.stringify(e)))
        .join(rand() < 0.1 ? '\r\n' : '\n');
      const m = parseTranscript(text);
      expect(m.parsedLines + m.badLines).toBe(text.split('\n').filter((l) => l.trim()).length);
      for (const k of [
        'costUsd',
        'turns',
        'durationMs',
        'inputTokens',
        'outputTokens',
        'cacheReadTokens',
        'cacheWriteTokens',
        'apiRetries',
        'apiRetriesAtEnd',
        'toolsRunningAtEnd',
        'resultCount',
      ] as const) {
        expect(Number.isFinite(m[k]) && m[k] >= 0, `${k} = ${m[k]}`).toBe(true);
      }
      for (const v of Object.values(m.toolCalls)) expect(typeof v).toBe('number');
      for (const list of [
        m.bashCommands,
        m.filesEdited,
        m.pathsRead,
        m.skillsUsed,
        m.subagentsUsed,
        m.errorCodes,
        m.modelsUsed,
        m.memoryPaths,
        m.skillsAvailable,
      ]) {
        expect(list.every((x) => typeof x === 'string')).toBe(true);
      }
      expect(() => classifyAgentFailure(m, '', 1, rand() < 0.5, { endedAt: Date.now() })).not.toThrow();
    }
  });
});
