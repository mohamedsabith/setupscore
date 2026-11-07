// Property-based tests (fast-check): instead of a few hand-picked examples, each test states a
// rule that must hold for every input, and fast-check tries hundreds of generated inputs.
// A failure prints the smallest input that breaks the rule and a seed to replay it:
//   fc.assert(..., { seed: <seed>, path: '<path>' })
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { withoutTrailingTag } from '../src/agent/transcript.js';
import { check } from '../src/core/check.js';
import { writeFileAtomic } from '../src/core/fsx.js';
import { normRel, shellArg } from '../src/core/paths.js';
import { redact } from '../src/core/redact.js';
import { isPlaceholder, mask, maskSecrets } from '../src/core/secrets.js';
import { trimEndWhile } from '../src/core/text.js';
import { toJson } from '../src/report/json.js';
import { renderTerminal } from '../src/report/terminal.js';
import { clip } from '../src/rules/util.js';
import { shellQuote } from '../src/tasks/pm.js';
import { makeRepo } from './helpers.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;
const NO_CONFIG = { config: { rules: {}, ignore: [] } };

/** Characters that break naive code: quotes, shell symbols, escapes, control and direction characters. */
const NASTY = [
  ...Array.from(`'"$\`\\!*?~#&;|()<>{}[]%^@=:,./- \t\n\r`),
  '\u0000',
  '\u0007',
  '\u001b',
  '\u007f',
  '\u0085',
  '\u00a0',
  '\u2028',
  '\u202e',
  '\u2066',
  '\ufeff',
  'é',
  '中',
  '😀',
];
const nastyChar = fc.oneof(fc.constantFrom(...NASTY), fc.string({ unit: 'grapheme', minLength: 1, maxLength: 1 }));
const nastyString = (maxLength = 40) => fc.string({ unit: nastyChar, maxLength });

/** Every character clip() and safe output must never contain: terminal control and text-direction characters. */
// eslint-disable-next-line no-control-regex -- control characters are what this checks for
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

const UPPER_DIGITS = Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
const ALNUM = [...UPPER_DIGITS, ...Array.from('abcdefghijklmnopqrstuvwxyz')];
const fromChars = (chars: string[], min: number, max: number) =>
  fc.string({ unit: fc.constantFrom(...chars), minLength: min, maxLength: max });

/** Real-looking keys (never placeholders), in the formats setupscore knows. */
const token = fc
  .oneof(
    fromChars(ALNUM, 36, 40).map((s) => `ghp_${s}`),
    fromChars(UPPER_DIGITS, 16, 16).map((s) => `AKIA${s}`),
    fromChars([...ALNUM, '_', '-'], 24, 40).map((s) => `sk-ant-${s}`),
  )
  .filter((t) => !isPlaceholder(t));
/** Text around a key, ending and starting with a character that cannot be part of a key. */
const before = fc.tuple(nastyString(), fc.constantFrom(' ', '\n', '"', "'", '=', ':', '(')).map(([s, end]) => s + end);
const after = fc
  .tuple(fc.constantFrom(' ', '\n', '"', "'", ')', '.', ','), nastyString())
  .map(([start, s]) => start + s);

describe('text helpers', () => {
  it('trimEndWhile removes exactly the trailing characters that match, and nothing else', () => {
    const drop = (c: string) => c === '.' || /\s/.test(c);
    fc.assert(
      fc.property(nastyString(60), (s) => {
        const out = trimEndWhile(s, drop);
        expect(s.startsWith(out)).toBe(true);
        expect(Array.from(s.slice(out.length)).every(drop)).toBe(true);
        expect(out === '' || !drop(out.at(-1)!)).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it('withoutTrailingTag gives the same result as the regular expression it replaced', () => {
    const tagged = fc.string({ unit: fc.constantFrom('[', ']', 'a', '1', ' ', '-'), maxLength: 30 });
    fc.assert(
      fc.property(fc.oneof(tagged, nastyString()), (s) => {
        // eslint-disable-next-line regexp/no-super-linear-move -- the old regex, kept as the reference; inputs are short
        expect(withoutTrailingTag(s)).toBe(s.replace(/\[[^\]]*\]$/, ''));
      }),
      { numRuns: 2000 },
    );
  });

  it('normRel is stable: normalising twice gives the same path, never with a leading ./', () => {
    const path = fc.string({ unit: fc.constantFrom('a', 'b', '.', '/', '..', './', '../'), maxLength: 20 });
    fc.assert(
      fc.property(path, (p) => {
        const once = normRel(p);
        expect(normRel(once)).toBe(once);
        expect(once.startsWith('./')).toBe(false);
        expect(once.includes('//')).toBe(false);
      }),
      { numRuns: 1000 },
    );
  });

  it('clip gives one short, safe line: at most max characters, no control or direction characters', () => {
    fc.assert(
      fc.property(nastyString(300), fc.integer({ min: 2, max: 200 }), (s, max) => {
        const out = clip(s, max);
        expect(out.length).toBeLessThanOrEqual(max);
        expect(out).not.toMatch(UNSAFE);
        expect(out).not.toMatch(/ {2}/);
        expect(out).toBe(out.trim());
      }),
      { numRuns: 1000 },
    );
  });
});

describe('secrets are never shown in full', () => {
  it('mask shows at most the first 4 characters (and at most a quarter) of a value, then its length', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 200 }), (v) => {
        fc.pre(!v.startsWith('-----BEGIN'));
        const out = mask(v);
        const shown = Math.min(4, Math.floor(v.length / 4));
        expect(out).toBe(`${v.slice(0, shown)}… (${v.length} characters)`);
      }),
      { numRuns: 1000 },
    );
  });

  it('maskSecrets hides a real-looking key wherever it appears in the text', () => {
    fc.assert(
      fc.property(before, token, after, (pre, key, post) => {
        expect(maskSecrets(pre + key + post)).not.toContain(key);
      }),
      { numRuns: 1000 },
    );
  });

  it('clip hides a real-looking key too, whatever the length limit', () => {
    fc.assert(
      fc.property(before, token, after, fc.integer({ min: 2, max: 400 }), (pre, key, post, max) => {
        expect(clip(pre + key + post, max)).not.toContain(key);
      }),
      { numRuns: 500 },
    );
  });

  it('redact removes key shapes from run text, also after a JSON escape such as \\n', () => {
    const sep = fc.constantFrom(' ', '\n', '"', ':', '=', '\\n', '\\t');
    fc.assert(
      fc.property(nastyString(), sep, token, after, (pre, s, key, post) => {
        expect(redact(pre + s + key + post, {})).not.toContain(key);
      }),
      { numRuns: 1000 },
    );
  });

  it('redact removes the value of a secret environment variable wherever it appears', () => {
    // The value uses characters the surrounding text never has, so any copy left behind is a leak.
    const value = fromChars(UPPER_DIGITS, 8, 40);
    const text = fromChars(Array.from('abcdefghijklmnopqrstuvwxyz \n"{}[]:,.\\'), 0, 40);
    const name = fc.constantFrom('ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN', 'NPM_TOKEN');
    fc.assert(
      fc.property(name, value, text, text, fc.integer({ min: 1, max: 3 }), (k, v, a, b, times) => {
        const out = redact(a + Array.from({ length: times }, () => v).join(b) + b, { [k]: v });
        expect(out).not.toContain(v);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('shell quoting survives a real shell', () => {
  // printf %s prints its argument exactly, so the output shows what the shell made of the quoted word.
  const throughShell = (word: string) => execFileSync('sh', ['-c', `printf '%s' ${word}`], { encoding: 'utf8' });
  // Pieces a shell treats specially, so they show up often (a lone $ or ` rarely does anything).
  const shellPiece = fc.oneof(nastyChar, fc.constantFrom('$HOME', '$1', '${x}', '$(id)', '`id`', '!!', "'\\''", '\\n'));
  const word = fc.string({ unit: shellPiece, maxLength: 12 }).filter((s) => !s.includes('\u0000'));

  posixOnly('shellQuote: the shell reads back exactly the original text', () => {
    fc.assert(
      fc.property(word, (s) => {
        expect(throughShell(shellQuote(s))).toBe(s);
      }),
      { numRuns: 300 },
    );
  });

  posixOnly('shellArg: a hint pasted into a shell gives back exactly the original text', () => {
    fc.assert(
      fc.property(word, (s) => {
        expect(throughShell(shellArg(s))).toBe(s);
      }),
      { numRuns: 300 },
    );
  });
});

describe('writeFileAtomic', () => {
  it('writes exactly the given bytes and leaves no temporary files behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'setupscore-atomic-'));
    try {
      fc.assert(
        fc.property(fc.oneof(nastyString(200), fc.uint8Array({ maxLength: 4096 })), (data) => {
          const file = join(dir, 'results.json');
          const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
          writeFileAtomic(file, typeof data === 'string' ? data : bytes);
          expect(readFileSync(file).equals(bytes)).toBe(true);
          expect(readdirSync(dir)).toEqual(['results.json']);
        }),
        { numRuns: 200 },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('check() on generated projects', () => {
  const KEY = 'ghp_' + 'Q7wZ'.repeat(9); // a real-looking GitHub token, planted to prove it is never printed
  const fragment = fc.oneof(
    { weight: 3, arbitrary: nastyString(60) },
    {
      weight: 5,
      arbitrary: fc.constantFrom(
        '# Project',
        '## Commands',
        '- Run `npm test` before you commit.',
        '- Run `npm run lint` and `pnpm build`.',
        '- Never use `any`.',
        '- Always use `any`.',
        '- Use 2-space indentation.',
        '- Write clean code.',
        '- See src/app.ts and src/missing.ts.',
        '- See ./docs/guide.md and _src/old.ts_.',
        '- Helpers live in src/Utils/helper.ts.', // only the letter case is wrong: a safe fix
        '- See docs/Guide.md and ./docs/Guide.md.',
        '@docs/Guide.md',
        '@readme.md',
        '@docs\\guide.md', // backslashes: only Windows reads them as folders
        '- Read docs\\menu.md, e.g. src/example.ts.',
        '@README.md',
        '@docs/missing.md',
        '@~/.claude/x.md',
        '```',
        '```bash',
        '~~~',
        '---',
        '<!-- setupscore-disable vague-rule -->',
        '<!-- setupscore-disable-next-line broken-reference -->',
        `- Token: ${KEY}`,
        `password=${KEY.slice(4)}`,
        '[link](src/x.ts) and https://example.com/a/b.ts',
        'a'.repeat(3000),
      ),
    },
  );
  const markdown = fc
    .tuple(fc.array(fragment, { maxLength: 25 }), fc.constantFrom('\n', '\r\n', '\r'), fc.boolean())
    .map(([parts, eol, bom]) => (bom ? '\ufeff' : '') + parts.join(eol));
  const json = fc.oneof(
    fc.json({ maxDepth: 3 }),
    fc.string({ maxLength: 40 }),
    fc.constant(
      '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"python3 .claude/hooks/x.py"}]}]},"permissions":{"allow":["Bash(*)"]}}',
    ),
    fc.constant('{"mcpServers":{"a":{"command":"npx","args":["-y","x"],"env":{"TOKEN":"' + KEY + '"}}}}'),
  );
  const project = fc.record(
    {
      'CLAUDE.md': markdown,
      'AGENTS.md': markdown,
      '.claude/rules/api.md': markdown.map((m) => `---\npaths: src/**/*.ts\n---\n${m}`),
      '.claude/skills/s/SKILL.md': markdown,
      '.claude/settings.json': json,
      '.mcp.json': json,
      'package.json': fc.oneof(fc.constant('{"name":"demo","scripts":{"test":"vitest","lint":"eslint ."}}'), json),
    },
    { requiredKeys: ['CLAUDE.md'] },
  );
  const ALWAYS = {
    'src/app.ts': 'export {};\n',
    'src/utils/helper.ts': 'export {};\n',
    'docs/guide.md': '# Guide\n',
    'README.md': '# Demo\n',
  };
  const lineCount = (text: string) => text.replace(/^\ufeff/, '').split(/\r\n|\r|\n/).length;
  const lineText = (text: string, n: number) => text.replace(/^\ufeff/, '').split(/\r\n|\r|\n/)[n - 1] ?? '';

  it('never crashes, every rule finishes, and every finding points at a real place', () => {
    let fixes = 0;
    fc.assert(
      fc.property(project, (files) => {
        const all: Record<string, string> = { ...files, ...ALWAYS };
        const run = check(makeRepo(all), NO_CONFIG);
        expect(run.ruleErrors).toEqual([]);
        expect(run.errors).toBe(run.issues.filter((i) => i.severity === 'error').length);
        expect(run.warnings).toBe(run.issues.filter((i) => i.severity === 'warning').length);
        expect(run.health).toBeGreaterThanOrEqual(0);
        expect(run.health).toBeLessThanOrEqual(10);
        // Every finding is checked; the test then shows all wrong ones at once.
        const wrong: string[] = [];
        for (const i of run.issues) {
          const at = `${i.rule} ${i.file}:${i.line}:${i.column}`;
          const text = all[i.file];
          if (i.file.startsWith('/') || i.file.includes('\\')) wrong.push(`${at}: not a relative path`);
          if (i.line !== undefined && i.line < 1) wrong.push(`${at}: line below 1`);
          if (i.line !== undefined && text !== undefined && i.line > lineCount(text)) wrong.push(`${at}: past the end`);
          if (i.column !== undefined && i.column < 1) wrong.push(`${at}: column below 1`);
          if (i.fix && text !== undefined) {
            fixes++;
            const line = lineText(text, i.fix.line);
            const ok =
              i.fix.column === undefined ? line.includes(i.fix.from) : line.startsWith(i.fix.from, i.fix.column - 1);
            if (!ok) wrong.push(`${at}: the fix's "${i.fix.from}" is not on line ${i.fix.line}: ${line}`);
          }
        }
        expect(wrong).toEqual([]);
      }),
      { numRuns: 150 },
    );
    expect(fixes, 'the generated projects must produce fixes, or the fix check above tests nothing').toBeGreaterThan(
      20,
    );
  });

  it('never prints a planted key: not in the terminal report, not in the JSON report', () => {
    fc.assert(
      fc.property(project, (files) => {
        const run = check(makeRepo({ ...files, ...ALWAYS }), NO_CONFIG);
        const json = JSON.stringify(toJson(run));
        expect(JSON.parse(json).schemaVersion).toBe(1);
        expect(json).not.toContain(KEY.slice(4));
        expect(renderTerminal(run)).not.toContain(KEY.slice(4));
      }),
      { numRuns: 150 },
    );
  });
});
