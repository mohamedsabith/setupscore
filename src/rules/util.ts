import { isInstruction, readSetupText } from '../core/discover.js';
import { MAX_LINE } from '../core/markdown.js';
import { maskSecrets } from '../core/secrets.js';
import type { Context, Line, SetupFile } from '../core/types.js';

export const instructionFiles = (ctx: Context): SetupFile[] => ctx.files.filter(isInstruction);

/** Lines that are prose: not code blocks, not frontmatter, not HTML comments, not absurdly long. */
export const proseLines = (f: SetupFile): Line[] =>
  f.lines.filter((l) => !l.inFence && !l.inFrontmatter && l.text.length <= MAX_LINE && !isCommentLine(l.text));

function isCommentLine(text: string): boolean {
  const t = text.trim();
  return t.startsWith('<!--') && t.endsWith('-->');
}

const jsonCache = new WeakMap<SetupFile, { value?: unknown; error?: string; position?: number }>();

/** Parse a JSON setup file once. */
export function parseJson(f: SetupFile): { value?: unknown; error?: string; position?: number } {
  let r = jsonCache.get(f);
  if (!r) {
    const text = f.text.replace(/^﻿/, '');
    const offset = f.text.length - text.length;
    try {
      r = text.trim() === '' ? { error: 'the file is empty' } : { value: JSON.parse(text) };
    } catch (err) {
      const found = diagnoseJson(text);
      r = found
        ? { error: found.message, position: found.at + offset }
        : { error: (err as Error).message.split('\n')[0]!.slice(0, 200) };
    }
    jsonCache.set(f, r);
  }
  return r;
}

const WS = new Set([' ', '\t', '\n', '\r']);
const LITERAL = /true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const describeChar = (ch: string | undefined): string =>
  ch === undefined ? 'the end of the file' : ch === '\n' || ch === '\r' ? 'a line break' : `"${ch}"`;

/**
 * Find the first JSON mistake and say what it is in plain words, without depending on the
 * wording of Node's own error messages (they change between versions). `at` is an offset in `text`.
 */
export function diagnoseJson(text: string): { message: string; at: number } | undefined {
  let i = 0;
  const n = text.length;
  // Each entry: what the container expects next.
  type Frame = { type: 'object' | 'array'; state: 'first' | 'key' | 'colon' | 'value' | 'comma' };
  const stack: Frame[] = [];
  let done = false;
  const fail = (message: string, at = i) => ({ message, at });

  const skipSpace = (): { message: string; at: number } | undefined => {
    for (;;) {
      while (i < n && WS.has(text[i]!)) i++;
      if (text.startsWith('//', i) || text.startsWith('/*', i)) return fail('comments are not allowed in JSON');
      return undefined;
    }
  };
  const readString = (): { message: string; at: number } | undefined => {
    const start = i;
    i++; // opening quote
    while (i < n) {
      const ch = text[i]!;
      if (ch === '"') {
        i++;
        return undefined;
      }
      if (ch === '\\') {
        const next = text[i + 1];
        if (next === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) return fail('a \\u escape needs four hex digits');
          i += 6;
          continue;
        }
        if (next === undefined || !'"\\/bfnrt'.includes(next)) {
          return fail(
            `"\\${next ?? ''}" is not a valid escape in JSON; write "\\\\" for a backslash (Windows paths need double backslashes)`,
          );
        }
        i += 2;
        continue;
      }
      if (ch === '\n' || ch === '\r') return fail('a line break inside a string; write \\n instead');
      if (ch.charCodeAt(0) < 0x20) return fail('a control character inside a string');
      i++;
    }
    return fail('a string is never closed (missing ")', start);
  };
  const readValue = (): { message: string; at: number } | undefined => {
    const ch = text[i];
    if (ch === '"') return readString();
    if (ch === '{' || ch === '[') {
      stack.push({ type: ch === '{' ? 'object' : 'array', state: 'first' });
      i++;
      return undefined;
    }
    if (ch === "'") return fail('strings need double quotes, not single quotes');
    LITERAL.lastIndex = i;
    const lit = LITERAL.exec(text);
    if (lit) {
      i += lit[0].length;
      if (i < n && /[\w.]/.test(text[i]!)) return fail(`unexpected ${describeChar(text[i])} after a value`);
      return undefined;
    }
    if (ch !== undefined && /[A-Za-z_]/.test(ch)) return fail('a word without quotes; text values need double quotes');
    return fail(`expected a value but found ${describeChar(ch)}`);
  };

  const first = skipSpace();
  if (first) return first;
  if (i >= n) return fail('the file is empty');
  const v = readValue();
  if (v) return v;
  if (stack.length === 0) done = true;

  while (!done) {
    const s = skipSpace();
    if (s) return s;
    const top = stack[stack.length - 1]!;
    const ch = text[i];
    if (ch === undefined)
      return fail(`the file ends before the ${top.type === 'object' ? '"}"' : '"]"'} that closes it`);
    const close = top.type === 'object' ? '}' : ']';
    if (top.type === 'object' && (top.state === 'first' || top.state === 'key')) {
      if (ch === '}' && top.state === 'first') {
        i++;
        stack.pop();
      } else if (ch === '}') return fail('trailing comma before a closing bracket', text.lastIndexOf(',', i));
      else if (ch === '"') {
        const e = readString();
        if (e) return e;
        top.state = 'colon';
        continue;
      } else if (ch === "'") return fail('keys need double quotes, not single quotes');
      else if (/[A-Za-z_$]/.test(ch)) return fail('a key without quotes; keys need double quotes');
      else return fail(`expected a key in double quotes but found ${describeChar(ch)}`);
    } else if (top.type === 'object' && top.state === 'colon') {
      if (ch !== ':') return fail(`expected ":" after the key but found ${describeChar(ch)}`);
      i++;
      top.state = 'value';
      continue;
    } else if (top.state === 'value' || (top.type === 'array' && top.state === 'first')) {
      if (ch === ']' && top.type === 'array') {
        if (top.state === 'first') {
          i++;
          stack.pop();
        } else return fail('trailing comma before a closing bracket', text.lastIndexOf(',', i));
      } else {
        top.state = 'comma';
        const e = readValue();
        if (e) return e;
        continue;
      }
    } else if (top.state === 'comma') {
      if (ch === ',') {
        i++;
        top.state = top.type === 'object' ? 'key' : 'value';
        continue;
      }
      if (ch === close) {
        i++;
        stack.pop();
      } else if (ch === '"' || ch === '{' || ch === '[' || /[\w-]/.test(ch))
        return fail('a comma is missing before this');
      else return fail(`expected "," or "${close}" but found ${describeChar(ch)}`);
    }
    if (stack.length === 0) done = true;
  }
  const after = skipSpace();
  if (after) return after;
  if (i < n) return fail(`unexpected ${describeChar(text[i])} after the end of the JSON`);
  return undefined;
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const tokenIndex = new WeakMap<SetupFile, Map<string, number>>();

/** Every JSON string literal in the file, mapped to the first line it is on. */
function stringTokens(f: SetupFile): Map<string, number> {
  let m = tokenIndex.get(f);
  if (!m) {
    m = new Map();
    for (const l of f.lines) {
      if (!l.text.includes('"')) continue;
      for (const t of l.text.matchAll(/"(?:[^"\\]|\\.)*"/g)) if (!m.has(t[0])) m.set(t[0], l.n);
    }
    tokenIndex.set(f, m);
  }
  return m;
}

/**
 * 1-based line of the first line containing `needle`, or undefined. A JSON string literal
 * (`JSON.stringify(x)`) is found through an index, so looking up thousands of keys stays fast.
 */
export const lineOf = (f: SetupFile, needle: string): number | undefined => {
  if (needle.length > 1 && needle.startsWith('"') && needle.endsWith('"')) {
    const hit = stringTokens(f).get(needle);
    if (hit !== undefined) return hit;
  } else {
    const hit = stringTokens(f).get(JSON.stringify(needle));
    if (hit !== undefined) return hit;
  }
  return f.lines.find((l) => l.text.includes(needle))?.n;
};

/** 1-based line for a character offset in the file. */
export const lineAt = (text: string, offset: number): number => {
  let n = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) n++;
  }
  return n;
};

const pkgCache = new Map<string, { name?: string; scripts: Record<string, string> } | null>();

/**
 * The name and "scripts" of a package.json, or null if it cannot be read. A UTF-8 byte order
 * mark is accepted (npm accepts it too), and only string values count as scripts.
 */
export function packageOf(abs: string): { name?: string; scripts: Record<string, string> } | null {
  if (!pkgCache.has(abs)) {
    let out: { name?: string; scripts: Record<string, string> } | null = null;
    try {
      const r = readSetupText(abs, 4 * 1024 * 1024);
      if (r && 'text' in r) {
        const pkg = JSON.parse(r.text.replace(/^\uFEFF/, '')) as unknown;
        const scripts = Object.create(null) as Record<string, string>;
        if (isObject(pkg) && isObject(pkg.scripts)) {
          for (const [k, v] of Object.entries(pkg.scripts)) if (typeof v === 'string') scripts[k] = v;
        }
        out = { name: isObject(pkg) && typeof pkg.name === 'string' ? pkg.name : undefined, scripts };
      }
    } catch {
      out = null;
    }
    pkgCache.set(abs, out);
  }
  return pkgCache.get(abs)!;
}

/** The "scripts" of a package.json, or null if it cannot be read. */
export const scriptsOf = (abs: string): Record<string, string> | null => packageOf(abs)?.scripts ?? null;

export const clearCaches = (): void => pkgCache.clear();

// eslint-disable-next-line no-control-regex -- matching control characters is the point: they are removed
const CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/**
 * Text from a file, safe to put in a message: secrets masked, control characters removed,
 * spaces collapsed and shortened to keep one line readable. Masking happens before shortening,
 * so a secret cut in half is still hidden.
 */
export const clip = (text: string, max = 70): string => {
  const short = text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(2000, max * 4));
  const t = maskSecrets(short).replace(CONTROL, ' ').replace(/ {2,}/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Quote text for a message: see clip(). */
export const quote = (text: string, max = 70): string => `"${clip(text, max)}"`;
