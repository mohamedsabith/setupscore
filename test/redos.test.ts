/* eslint-disable regexp/no-super-linear-backtracking, regexp/no-super-linear-move -- this file keeps the slow regexes of 1.0.3 on purpose: they are the reference the new, fast code must match */
import { describe, expect, it } from 'vitest';
import { withoutTrailingTag } from '../src/agent/transcript.js';
import { check } from '../src/core/check.js';
import { isPlaceholder } from '../src/core/secrets.js';
import { trimEndWhile } from '../src/core/text.js';
import { agentPrompt } from '../src/run/runner.js';
import { noTestsRan } from '../src/tasks/pm.js';
import { makeRepo } from './helpers.js';

// 1.0.4 security fix: 20 regular expressions could take quadratic (or worse) time on crafted input
// (ReDoS), found by eslint-plugin-regexp's no-super-linear-backtracking and no-super-linear-move.
// Each was replaced by code that must give exactly the old answer. These tests compare the old
// regex (copied here as written in 1.0.3) with the new code on many generated strings, and check
// that the new code stays fast on the inputs that made the old one slow.

/** A small seeded generator, so a failing case can be reproduced. */
function strings(alphabet: string[], count: number, maxLength: number, seed = 1): string[] {
  let x = seed;
  const next = () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x / 0x7fffffff;
  };
  const out: string[] = [''];
  for (let i = 0; i < count; i++) {
    let s = '';
    for (let n = Math.floor(next() * maxLength); n > 0; n--) s += alphabet[Math.floor(next() * alphabet.length)]!;
    out.push(s);
  }
  return out;
}
/** Milliseconds a call takes. */
const time = (fn: () => unknown) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

describe('trimEndWhile: the same result as replace(/[...]+$/, "")', () => {
  const cases: [string, RegExp, (c: string) => boolean, string[]][] = [
    [
      'dots and spaces (run.ts reasons)',
      /[.\s]+$/,
      (c) => c === '.' || /\s/.test(c),
      ['.', ' ', '\t', '\n', '\u00a0', '\u2028', 'a', 'é', '😀'],
    ],
    ['punctuation (forbidden rules)', /[.,;:]+$/, (c) => '.,;:'.includes(c), ['.', ',', ';', ':', 'x', ' ', '`']],
    ['slashes (paths)', /\/+$/, (c) => c === '/', ['/', 'a', '.', '\\', ' ']],
  ];
  for (const [name, old, drop, alphabet] of cases) {
    it(`matches the old regex for ${name} on 3000 generated strings`, () => {
      for (const s of strings(alphabet, 3000, 12))
        expect(trimEndWhile(s, drop), JSON.stringify(s)).toBe(s.replace(old, ''));
    });
  }

  it('returns the same string object when nothing is trimmed, and handles empty input', () => {
    const s = 'abc';
    expect(trimEndWhile(s, (c) => c === '/')).toBe(s);
    expect(trimEndWhile('', () => true)).toBe('');
    expect(trimEndWhile('////', (c) => c === '/')).toBe('');
  });

  it('is fast on the input that made the regex quadratic (1,000,000 characters)', () => {
    const attack = '.'.repeat(1_000_000) + 'x';
    expect(time(() => trimEndWhile(attack, (c) => c === '.'))).toBeLessThan(200);
  });
});

describe('isPlaceholder: <[^<>]*> instead of <[^>]*>', () => {
  const OLD = /EXAMPLE|x{5,}|X{5,}|\.{3}|…|0{8,}|<[^>]*>|\$\{|\{\{/;
  const NEW = /EXAMPLE|x{5,}|X{5,}|\.{3}|…|0{8,}|<[^<>]*>|\$\{|\{\{/;

  it('gives the same yes/no answer on 5000 generated strings', () => {
    for (const s of strings(['<', '>', 'a', 'x', '0', '.', '$', '{', ' '], 5000, 16)) {
      expect(NEW.test(s), JSON.stringify(s)).toBe(OLD.test(s));
    }
  });

  it('still treats <placeholders> as placeholders and real-looking values as real', () => {
    for (const v of ['<your-api-key>', 'sk-<KEY>', 'a<b<c>', '<<x>']) expect(isPlaceholder(v), v).toBe(true);
    for (const v of ['hunter2-correct-horse', 'a<b', 'a>b<c']) expect(isPlaceholder(v), v).toBe(false);
  });

  it('treats a prefix followed by one letter in mixed case as a placeholder (the "i" flag lint wrongly calls useless)', () => {
    expect(isPlaceholder('ghp_xXxXxXxXxXxXxXxXxXxX')).toBe(true);
    expect(isPlaceholder('sk-ant-aAaAaAaAaAaAaAaA')).toBe(true);
    expect(isPlaceholder('ghp_xYxYxYxYxYxYxYxY')).toBe(false);
  });

  it('is fast on 1,000,000 "<" characters without a ">"', () => {
    expect(time(() => isPlaceholder('a' + '<'.repeat(1_000_000)))).toBeLessThan(500);
  });

  it('check stays fast on a CLAUDE.md line that took 11.6 s in 1.0.3 (200,000 characters)', () => {
    const root = makeRepo({ 'CLAUDE.md': `- password=a${'<'.repeat(200_000)}\n` });
    expect(time(() => check(root, { config: { rules: {}, ignore: [] } }))).toBeLessThan(3000);
  });
});

describe('withoutTrailingTag: the same result as replace(/\\[[^\\]]*\\]$/, "")', () => {
  it('matches the old regex on 5000 generated strings', () => {
    for (const s of strings(['[', ']', 'a', '1', '-', ' '], 5000, 14)) {
      expect(withoutTrailingTag(s), JSON.stringify(s)).toBe(s.replace(/\[[^\]]*\]$/, ''));
    }
  });

  it('removes a model tag like the old code', () => {
    expect(withoutTrailingTag('claude-opus-5[1m]')).toBe('claude-opus-5');
    expect(withoutTrailingTag('claude-opus-5')).toBe('claude-opus-5');
    expect(withoutTrailingTag('a[b]c]')).toBe('a[b]c]'.replace(/\[[^\]]*\]$/, ''));
  });

  it('is fast on many "[" with a "]" in the middle and at the end', () => {
    const attack = '['.repeat(500_000) + ']x]';
    expect(time(() => withoutTrailingTag(attack))).toBeLessThan(200);
  });
});

describe('the shell -c flag test: /^-[a-z]+$/ and includes("c") instead of /^-[a-z]*c[a-z]*$/', () => {
  const OLD = (w: string) => /^-[a-z]*c[a-z]*$/.test(w);
  const NEW = (w: string) => /^-[a-z]+$/.test(w) && w.includes('c');
  it('gives the same answer on 5000 generated words', () => {
    for (const w of strings(['-', 'c', 'e', 'x', 'C', '1', ' '], 5000, 8))
      expect(NEW(w), JSON.stringify(w)).toBe(OLD(w));
    for (const w of ['-c', '-ec', '-xce', '-e', 'c', '--c', '-', '-C']) expect(NEW(w), w).toBe(OLD(w));
  });
  it('is fast on a long word of c characters with a bad ending', () => {
    expect(time(() => NEW('-' + 'c'.repeat(1_000_000) + '1'))).toBeLessThan(200);
  });
});

describe('commander invalid argument message: trimStart() instead of \\.\\s*([\\s\\S]*)$', () => {
  const OLD = /^option '([^']+)' argument '([\s\S]*)' is invalid\.\s*([\s\S]*)$/;
  const NEW = /^option '([^']+)' argument '([\s\S]*)' is invalid\.([\s\S]*)$/;
  it('gives the same three parts on generated messages', () => {
    const tails = strings([' ', '\n', '\t', 'a', '.', "'"], 2000, 10);
    for (const tail of tails) {
      const msg = `option '--repeat <n>' argument '0' is invalid.${tail}`;
      const o = msg.match(OLD);
      const n = msg.match(NEW);
      expect(n === null, JSON.stringify(msg)).toBe(o === null);
      if (o && n) expect([n[1], n[2], n[3]!.trimStart()]).toEqual([o[1], o[2], o[3]]);
    }
  });
});

describe('agentPrompt: the same result as the old global replace', () => {
  const OLD = (p: string) => p.replace(/,?\s*following the project instructions \(CLAUDE\.md\)/g, '');
  const PHRASE = 'following the project instructions (CLAUDE.md)';
  it('matches the old replace on 3000 generated prompts', () => {
    for (const p of strings([PHRASE, ' ', ',', '\n', 'Fix the bug', '.', 'following'], 3000, 8)) {
      expect(agentPrompt(p), JSON.stringify(p)).toBe(OLD(p));
    }
  });
  it('keeps the examples the old tests used', () => {
    expect(agentPrompt(`Add GST, ${PHRASE}.`)).toBe('Add GST.');
    expect(agentPrompt('Add GST.')).toBe('Add GST.');
  });
  it('is fast on 1,000,000 spaces', () => {
    expect(time(() => agentPrompt(' '.repeat(1_000_000) + 'x'))).toBeLessThan(200);
  });
});

describe('noTestsRan: line-start patterns that cannot run across blank lines', () => {
  // noTestsRan as it was in 1.0.3.
  function OLD(output: string): boolean {
    const text = output.replace(/\x1b\[[0-9;]*m/g, '');
    const none =
      /^\s*(?:#|ℹ)\s*tests 0\s*$/m.test(text) ||
      /^1\.\.0\b/m.test(text) ||
      /\bNo tests? (?:files? )?found\b/i.test(text) ||
      /\bNo valid test files found\b/i.test(text) ||
      /couldn[’']?t find any files to test/i.test(text) ||
      /^\s*Ran 0 tests\b/m.test(text) ||
      /\bhad no matches\b/.test(text) ||
      /^\s*Total:\s+0\s*$/m.test(text);
    if (!none) return false;
    const some =
      /^\s*(?:#|ℹ)\s*tests [1-9]/m.test(text) ||
      /^\s*Tests?:?\s+.*\b[1-9]\d* (?:passed|failed|total)\b/m.test(text) ||
      /\b[1-9]\d* (?:passing|failing|pass|fail|tests? (?:passed|failed))\b/.test(text) ||
      /^\s*Ran [1-9]\d* tests?\b/m.test(text) ||
      /^\s*Total:\s+[1-9]/m.test(text) ||
      /# \{ total: [1-9]/.test(text);
    return !some;
  }
  const PARTS = [
    '\n',
    '\r\n',
    ' ',
    '\t',
    '# tests 0',
    'ℹ tests 3',
    'Ran 0 tests',
    'Ran 2 tests',
    'Total: 0',
    'Total: 4',
    'Tests: ',
    'Tests:  ',
    '3 passed',
    '0 passed',
    'x',
    'No tests found',
    '1..0',
    '\u2028',
    '\u00a0',
  ];

  it('gives the old answer on 6000 generated test outputs', () => {
    for (const out of strings(PARTS, 6000, 10)) expect(noTestsRan(out), JSON.stringify(out)).toBe(OLD(out));
  });

  it('keeps the answers for real runner output', () => {
    expect(noTestsRan('ℹ tests 0\nℹ pass 0')).toBe(true);
    expect(noTestsRan('No test files found, exiting with code 1')).toBe(true);
    expect(noTestsRan('Tests:       3 passed, 3 total\nNo tests found for one pattern')).toBe(false);
    expect(noTestsRan('  Tests  2 passed (2)')).toBe(false);
  });

  it('is fast on 1 MB of crafted test output (it could take minutes before)', () => {
    const blankLines = 'No tests found\n' + '\n'.repeat(1_000_000);
    const testsLine = 'No tests found\nTests:' + ' '.repeat(1_000_000) + 'x';
    expect(time(() => noTestsRan(blankLines))).toBeLessThan(1000);
    expect(time(() => noTestsRan(testsLine))).toBeLessThan(1000);
  });
});

describe('.yarnrc.yml nodeLinker: a line-start pattern that cannot run across blank lines', () => {
  const OLD = /^\s*nodeLinker\s*:\s*["']?([\w-]+)/m;
  const NEW = /^[^\S\n\r\u2028\u2029]*nodeLinker\s*:\s*["']?([\w-]+)/m;
  it('captures the same value on 5000 generated files', () => {
    for (const s of strings(
      ['\n', ' ', '\t', 'nodeLinker', ':', ' pnp', '"node-modules"', 'x: 1', '\r\n', '#'],
      5000,
      8,
    )) {
      expect(s.match(NEW)?.[1], JSON.stringify(s)).toBe(s.match(OLD)?.[1]);
    }
  });
  it('is fast on 1,000,000 blank lines', () => {
    expect(time(() => ('\n'.repeat(1_000_000) + 'x').match(NEW))).toBeLessThan(500);
  });
});
