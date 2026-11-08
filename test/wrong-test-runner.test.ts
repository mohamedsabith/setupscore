import { describe, expect, it } from 'vitest';
import { scriptRunner } from '../src/rules/wrong-test-runner.js';
import { lint } from './helpers.js';

const RULE = 'wrong-test-runner';
const pkg = (test: string, deps: string[]) =>
  JSON.stringify({ name: 'demo', scripts: { test }, devDependencies: Object.fromEntries(deps.map((d) => [d, '*'])) });
const VITEST = pkg('vitest run', ['vitest']);

describe('wrong-test-runner: what it catches', () => {
  it('names a runner the project does not use, as a claim or as a command', () => {
    for (const line of [
      '- We use Jest for unit tests.',
      '- Tests are written with jest.',
      '- Run the tests with `npx jest`.',
      '- Testing: jest',
    ]) {
      const issues = lint(RULE, { 'package.json': VITEST, 'CLAUDE.md': `${line}\n` });
      expect(issues, line).toHaveLength(1);
      expect(issues[0]!.message).toContain(
        'this project tests with vitest ("test": "vitest run" in package.json, and jest is not installed)',
      );
    }
    expect(lint(RULE, { 'package.json': VITEST, 'CLAUDE.md': '```sh\njest --watch\n```\n' })).toHaveLength(1);
  });

  it('finds the runner of the "test" script only when it is one runner that is installed', () => {
    expect(scriptRunner('vitest run', new Set(['vitest']))).toBe('vitest');
    expect(scriptRunner('jest --coverage', new Set(['jest']))).toBe('jest');
    expect(scriptRunner('vitest run', new Set())).toBeNull(); // not installed: proves nothing
    expect(scriptRunner('vitest && mocha', new Set(['vitest', 'mocha']))).toBeNull();
    expect(scriptRunner('node --test', new Set())).toBeNull();
    expect(scriptRunner('jest-runner-x', new Set(['jest-runner-x']))).toBeNull();
    expect(scriptRunner(undefined, new Set())).toBeNull();
    // Part of another name: @vitest/... is not the vitest runner.
    expect(scriptRunner('jest --reporters=@vitest/x', new Set(['jest']))).toBe('jest');
  });
});

describe('wrong-test-runner: what it must not flag', () => {
  const quiet = (text: string, p = VITEST) => {
    expect(lint(RULE, { 'package.json': p, 'CLAUDE.md': text }), text).toEqual([]);
  };
  it('leaves alone the right runner, comparisons, contrast, helpers and installed runners', () => {
    quiet('- We use Vitest.\n');
    quiet('- Vitest has a Jest-compatible API.\n');
    quiet('- Use vitest, not jest.\n');
    quiet('- We migrated from jest last year.\n');
    quiet('- Use `@testing-library/jest-dom` matchers.\n');
    quiet('- Mock with `vi.fn()`, the same as `jest.fn()` works.\n');
    quiet('- E2E tests run in CI with mocha.\n');
    quiet('- We use Jest for the admin package.\n', pkg('vitest run', ['vitest', 'jest']));
    quiet('- Both work here: use jest or vitest.\n');
  });
  it('needs a "test" script that names one installed runner', () => {
    quiet('- We use Jest.\n', pkg('node --test', []));
    quiet('- We use Jest.\n', JSON.stringify({ name: 'x' }));
    expect(lint(RULE, { 'CLAUDE.md': '- We use Jest.\n' })).toEqual([]);
  });
});
