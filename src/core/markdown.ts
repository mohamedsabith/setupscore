import { parse as parseYaml } from 'yaml';
import type { Frontmatter, Line } from './types.js';

/**
 * Lines longer than this are not matched by the rules that look for wording (vague, duplicate,
 * contradiction, paths, scripts). Real instructions are far shorter; minified or generated
 * text this long only makes the checks slow.
 */
export const MAX_LINE = 10_000;

/** Split text into lines (LF, CRLF or old Mac CR) and mark fenced code blocks and YAML frontmatter. */
export function toLines(text: string, withFrontmatter: boolean): { lines: Line[]; frontmatter?: Frontmatter } {
  const raw = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  const lines: Line[] = [];
  let fmEnd = 0;
  let frontmatter: Frontmatter | undefined;

  if (withFrontmatter && raw[0]?.trim() === '---') {
    const close = raw.findIndex((l, i) => i > 0 && (l.trim() === '---' || l.trim() === '...'));
    if (close > 0) {
      fmEnd = close + 1;
      const yamlText = raw.slice(1, close).join('\n');
      try {
        // logLevel 'error': YAML warnings would otherwise go to stderr with a copy of the text.
        const data = parseYaml(yamlText, { logLevel: 'error' }) as unknown;
        frontmatter = {
          data: data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {},
          endLine: fmEnd,
        };
      } catch (err) {
        // Claude Code reads frontmatter leniently: "description: Use when: X" works there even
        // though it is not strict YAML. Do the same, and only report files we cannot read at all.
        const loose = looseFrontmatter(raw.slice(1, close));
        frontmatter = loose
          ? { data: loose, endLine: fmEnd }
          : { data: null, error: (err as Error).message.split('\n')[0], endLine: fmEnd };
      }
    }
  }

  let fence: string | null = null;
  raw.forEach((text, i) => {
    const n = i + 1;
    if (n <= fmEnd) {
      lines.push({ n, text, inFence: false, inFrontmatter: true });
      return;
    }
    const m = text.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (m) {
      const marker = m[1]!;
      if (fence === null) fence = marker[0]!.repeat(marker.length);
      else if (marker[0] === fence[0] && marker.length >= fence.length) {
        lines.push({ n, text, inFence: true, inFrontmatter: false });
        fence = null;
        return;
      }
    }
    lines.push({ n, text, inFence: fence !== null, inFrontmatter: false });
  });

  return { lines, frontmatter };
}

/** Read top-level `key: value` lines as plain strings. Returns null if no key is found. */
function looseFrontmatter(lines: string[]): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let found = false;
  for (const line of lines) {
    const m = line.match(/^([A-Z][\w-]*)\s*:\s?(.*)$/i);
    if (!m) continue;
    found = true;
    out[m[1]!] = m[2]!.trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
  }
  return found ? out : null;
}

/**
 * Remove `inline code` spans, keeping the line length (they become spaces). As in Markdown, a
 * span opened by N backticks ends at the next run of exactly N backticks; a run with no partner
 * is plain text. Runs in linear time on any input.
 */
export function stripCodeSpans(text: string): string {
  if (!text.includes('`')) return text;
  const runs: { start: number; len: number }[] = [];
  for (let i = 0; i < text.length;) {
    if (text.charCodeAt(i) !== 96) {
      i++;
      continue;
    }
    let j = i;
    while (j < text.length && text.charCodeAt(j) === 96) j++;
    runs.push({ start: i, len: j - i });
    i = j;
  }
  const byLen = new Map<number, number[]>();
  runs.forEach((r, k) => {
    const list = byLen.get(r.len) ?? [];
    list.push(k);
    byLen.set(r.len, list);
  });
  const next = new Map<number, number>(); // per run length: how far into byLen we have looked
  let out = '';
  let at = 0;
  let k = 0;
  while (k < runs.length) {
    const open = runs[k]!;
    const list = byLen.get(open.len)!;
    let p = next.get(open.len) ?? 0;
    while (p < list.length && list[p]! <= k) p++;
    next.set(open.len, p);
    if (p >= list.length) {
      k++;
      continue;
    }
    const close = runs[list[p]!]!;
    out += text.slice(at, open.start) + ' '.repeat(close.start + close.len - open.start);
    at = close.start + close.len;
    k = list[p]! + 1;
  }
  return out + text.slice(at);
}

/** Remove HTML comments, keeping positions. Linear time, even with many unclosed `<!--`. */
export function stripComments(text: string): string {
  let i = text.indexOf('<!--');
  if (i < 0) return text;
  let out = '';
  let at = 0;
  while (i >= 0) {
    const end = text.indexOf('-->', i + 4);
    if (end < 0) break;
    out += text.slice(at, i) + ' '.repeat(end + 3 - i);
    at = end + 3;
    i = text.indexOf('<!--', at);
  }
  return out + text.slice(at);
}

const LIST_MARK = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ x]\]\s+)?/i;

/** True for a markdown list item. */
export const isListItem = (text: string): boolean => LIST_MARK.test(text);

/** The words of a rule line: list marker, emphasis and trailing spaces removed. */
export const ruleText = (text: string): string =>
  text
    .replace(LIST_MARK, '')
    .replace(/^#+\s+/, '')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .trim();

const KEEP_START = /[\p{L}\p{N}_`"']/u;
const KEEP_END = /[\p{L}\p{N}_`"')]/u;

/** Lower-case, collapse spaces, drop punctuation at the ends: for comparing rules. */
export function normalizeRule(text: string): string {
  const t = ruleText(text).toLowerCase().replace(/\s+/g, ' ');
  let s = 0;
  let e = t.length;
  while (s < e && !KEEP_START.test(t[s]!)) s++;
  while (e > s && !KEEP_END.test(t[e - 1]!)) e--;
  return t.slice(s, e);
}

export const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;

export interface Disables {
  file: Set<string>;
  /** 1-based line number -> rule ids disabled on that line. `*` means every rule. */
  lines: Map<number, Set<string>>;
}

/**
 * Read `<!-- setupscore-disable rule-a, rule-b -->` (whole file) and
 * `<!-- setupscore-disable-next-line rule-a -->` comments. No ids means every rule.
 */
export function readDisables(lines: Line[]): Disables {
  const out: Disables = { file: new Set(), lines: new Map() };
  for (const l of lines) {
    // A comment shown inside a code block is an example, not a setting.
    if (l.inFence || !l.text.includes('setupscore-disable')) continue;
    let i = l.text.indexOf('<!--');
    while (i >= 0) {
      const end = l.text.indexOf('-->', i + 4);
      if (end < 0) break;
      const m = l.text.slice(i + 4, end).match(/^\s*setupscore-disable(-next-line|-line)?(?![\w-])([^>]*)$/);
      i = l.text.indexOf('<!--', end + 3);
      if (!m) continue;
      const ids = m[2]!
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const set = new Set(ids.length > 0 ? ids : ['*']);
      if (!m[1]) set.forEach((id) => out.file.add(id));
      else {
        const target = m[1] === '-next-line' ? l.n + 1 : l.n;
        const existing = out.lines.get(target) ?? new Set<string>();
        set.forEach((id) => existing.add(id));
        out.lines.set(target, existing);
      }
    }
  }
  return out;
}
