import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { check } from '../src/core/check.js';
import { ConfigError, loadConfig } from '../src/core/config.js';
import { toJson } from '../src/report/json.js';
import { renderTerminal } from '../src/report/terminal.js';
import { RULES } from '../src/rules/index.js';
import { makeRepo } from './helpers.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const RULE_IDS = RULES.map((r) => r.id);

/** One project with a finding of each kind: sure, guess and advice, and an error that is a guess. */
const MIXED = {
  'CLAUDE.md': '- Never use axios.\n- Use axios for requests.\n',
  'AGENTS.md': '- Run the tests.\n', // agents-md-not-loaded: sure
  '.claude/settings.json': JSON.stringify(
    {
      permissions: { allow: ['Bash(git push*)'] }, // risky-permission: advice
      hooks: {
        PreToolUs: [{ hooks: [{ type: 'command', command: 'echo hi' }] }], // broken-hook typo: guess
        Stop: [{ hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/.claude/missing.py"' }] }], // sure
      },
    },
    null,
    2,
  ),
  '.mcp.json': JSON.stringify({ mcpServers: { a: { command: 'x', env: { MY_API_KEY: 'live-9f8e7d6c5b4a3210' } } } }), // secret: error
};
const levels = (config: Record<string, unknown>) => {
  const run = check(makeRepo(MIXED), { config: { rules: {}, ignore: [], ...config } });
  const of = (rule: string, text = '') =>
    run.issues.filter((i) => i.rule === rule && i.message.includes(text)).map((i) => `${i.severity}/${i.certainty}`);
  return { run, of };
};

describe('levels: every finding says how sure it is', () => {
  it('keeps each rule\'s level by default, and adds "certainty" to every finding', () => {
    const { run, of } = levels({});
    expect(of('agents-md-not-loaded')).toEqual(['warning/sure']);
    expect(of('contradiction')).toEqual(['warning/guess']);
    expect(of('risky-permission')).toEqual(['warning/advice']);
    expect(of('secret')).toEqual(['error/guess']);
    expect(of('broken-hook', 'PreToolUs')).toEqual(['warning/guess']);
    expect(of('broken-hook', 'missing.py')).toEqual(['warning/sure']);
    expect(run.hints).toBe(0);
    expect(run.issues.every((i) => i.certainty !== undefined)).toBe(true);
    expect(toJson(run).summary.hints).toBe(0);
  });

  it('with "levels: by-certainty": sure problems are errors, guesses hints, advice stays a warning, errors stay errors', () => {
    const { run, of } = levels({ levels: 'by-certainty' });
    expect(of('agents-md-not-loaded')).toEqual(['error/sure']);
    expect(of('broken-hook', 'missing.py')).toEqual(['error/sure']);
    expect(of('contradiction')).toEqual(['hint/guess']);
    expect(of('broken-hook', 'PreToolUs')).toEqual(['hint/guess']);
    expect(of('risky-permission')).toEqual(['warning/advice']);
    expect(of('secret')).toEqual(['error/guess']); // an error is never lowered
    expect(run.hints).toBe(2);
    expect(run.warnings).toBe(1);
    expect(run.errors).toBe(3);
    // Hints don't lower the health score: 10 - 3 errors - 1 warning x 0.5.
    expect(run.health).toBe(6.5);
  });

  it('lets a level in setupscore.yml win over the mode, and accepts "hint" as a level', () => {
    const { of } = levels({ levels: 'by-certainty', rules: { contradiction: 'warning', 'risky-permission': 'hint' } });
    expect(of('contradiction')).toEqual(['warning/guess']);
    expect(of('risky-permission')).toEqual(['hint/advice']);
    expect(levels({ rules: { 'agents-md-not-loaded': 'hint' } }).of('agents-md-not-loaded')).toEqual(['hint/sure']);
  });

  it('shows hints in the terminal, and --quiet hides them with the warnings', () => {
    const { run } = levels({ levels: 'by-certainty' });
    const text = renderTerminal(run);
    expect(text).toMatch(/hint\s+"Use axios for requests\."/);
    expect(text).toContain('3 errors, 1 warning, 2 hints in');
    expect(renderTerminal(run, { quiet: true })).toContain('(1 warning and 2 hints hidden by --quiet)');
  });

  it('reads "levels" from setupscore.yml and explains a wrong value or a misspelled key', () => {
    const cfg = (yml: string) => loadConfig(makeRepo({ 'setupscore.yml': yml }), RULE_IDS);
    expect(cfg('version: 1\nlevels: by-certainty\n').levels).toBe('by-certainty');
    expect(cfg('version: 1\n').levels).toBeUndefined();
    expect(() => cfg('version: 1\nlevels: strict\n')).toThrow(ConfigError);
    expect(() => cfg('version: 1\nlevels: strict\n')).toThrow('levels: use "default" or "by-certainty"');
    expect(() => cfg('version: 1\nlevel: by-certainty\n')).toThrow('unknown key "level" (did you mean "levels"?)');
    expect(() => cfg('version: 1\nrules:\n  contradiction: info\n')).toThrow('use "off", "hint", "warning" or "error"');
  });

  it('never fails a build on hints, even with --strict', () => {
    const root = makeRepo({
      'CLAUDE.md': '- Never use axios.\n- Use axios for requests.\n',
      'setupscore.yml': 'version: 1\nlevels: by-certainty\n',
    });
    const r = spawnSync(process.execPath, [CLI, 'check', root, '--strict', '--json'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).summary).toMatchObject({ errors: 0, warnings: 0, hints: 1 });
    const plain = makeRepo({ 'CLAUDE.md': '- Never use axios.\n- Use axios for requests.\n' });
    expect(spawnSync(process.execPath, [CLI, 'check', plain, '--strict'], { encoding: 'utf8' }).status).toBe(1);
  });

  it('treats a rule of your own without a certainty as advice: its level never changes', () => {
    const mine = {
      id: 'mine',
      severity: 'warning' as const,
      summary: '',
      why: '',
      check: () => [{ rule: 'mine', severity: 'warning' as const, file: 'CLAUDE.md', message: 'x' }],
    };
    const run = check(makeRepo({ 'CLAUDE.md': 'x' }), {
      config: { rules: {}, ignore: [], levels: 'by-certainty' },
      rules: [mine],
    });
    expect(run.issues.map((i) => `${i.severity}/${i.certainty}`)).toEqual(['warning/advice']);
  });

  it('gives every rule a certainty, and lists it in "setupscore rules --json"', () => {
    for (const r of RULES) expect(['sure', 'guess', 'advice'], r.id).toContain(r.certainty);
    const r = spawnSync(process.execPath, [CLI, 'rules', '--json'], { encoding: 'utf8' });
    const listed = JSON.parse(r.stdout) as { id: string; certainty: string }[];
    expect(listed.find((x) => x.id === 'contradiction')?.certainty).toBe('guess');
  });
});
