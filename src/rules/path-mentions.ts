import { MAX_LINE } from '../core/markdown.js';
import type { Line, SetupFile } from '../core/types.js';

/** Letters and digits of any language, and `_`. */
const W = String.raw`\p{L}\p{M}\p{N}_`;
/** A folder separator: `/`, or `\` (Windows) when a name follows it. A `\` before punctuation is a Markdown escape. */
const SEP = String.raw`(?:\/|\\(?=[\p{L}\p{N}]))`;

/**
 * A path with at least one folder and a file extension: src/app.ts, ./docs/guide.md, ../shared/x.json,
 * .github/workflows/ci.yml, docs/menü.md, src\utils\old.ts.
 * The look-behind skips URLs, @imports, absolute paths and paths glued to other words.
 */
// eslint-disable-next-line security/detect-non-literal-regexp -- built from the fixed W and SEP character classes
const PATH = new RegExp(
  String.raw`(?<![${W}@$/.~\\:-])((?:\.{1,2}${SEP})*(?:\.?[${W}-][${W}.@-]*${SEP})+[${W}@-][${W}.@-]*\.[A-Za-z][A-Za-z0-9]{0,9})(?![${W}/\\{<$[-]|\.[${W}{<$[])`,
  'gu',
);

/** "e.g. src/x.ts", "for example docs/a.md", "files like a/b.ts": an example, not a real reference. */
const EXAMPLE_BEFORE =
  /(?:\be\.\s?g\.|\beg\.|\bi\.\s?e\.|\bfor example\b|\bfor instance\b|\bsuch as\b|\blike\b)[^.;!?]{0,80}$/i;

/** Files that are personal and usually not committed, so they are often missing in a fresh clone. */
const LOCAL_ONLY = /(?:^|\/)[^/]*\.local(?:\.[^/]*)?$/;

/** Example paths written to show a shape, not a real file: path/to/x.ts, src/foo/bar.ts, your-file.ts. */
const PLACEHOLDER =
  /(?:^|\/)(?:path\/to|to\/your|foo|bar|baz|qux|x{3,}|your[-_][\w-]*|some[-_][\w-]*|my[-_]?(?:file|component|feature|module|test|page|thing)|example|placeholder)(?:\/|\.|$)/i;

/** A file name pattern with a date to fill in: history/YYYY-MM.md, logs/YYYYMMDD.log, notes/yyyy-mm-dd.md. */
export const DATE_PLACEHOLDER = /(?:^|[/_.-])y{2,4}(?:[-_]?mm(?:[-_]?dd)?)?(?=[/_.-]|$)/i;
const SPACE_BEFORE = /[\s([*]/;
const SPACE_AFTER = /[\s.,;:!?)\]*]/;

/** Turn `_italic text_` markers into spaces (positions kept), so a path in italics is still found. */
function stripItalics(text: string): string {
  if (!text.includes('_')) return text;
  const openers: number[] = [];
  const closers: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '_') continue;
    const prev = text[i - 1];
    const next = text[i + 1];
    if ((prev === undefined || SPACE_BEFORE.test(prev)) && next !== undefined && !/[\s_]/.test(next)) openers.push(i);
    if (prev !== undefined && !/[\s_]/.test(prev) && (next === undefined || SPACE_AFTER.test(next))) closers.push(i);
  }
  if (openers.length === 0 || closers.length === 0) return text;
  const chars = text.split('');
  let c = 0;
  let lastClose = -1;
  for (const o of openers) {
    if (o <= lastClose) continue;
    while (c < closers.length && closers[c]! <= o) c++;
    if (c >= closers.length) break;
    chars[o] = ' ';
    chars[closers[c]!] = ' ';
    lastClose = closers[c]!;
    c++;
  }
  return chars.join('');
}

/** A file path written in an instruction file: `ref` as written, `path` with forward slashes. */
export interface PathMention {
  line: Line;
  column: number;
  ref: string;
  path: string;
}

/**
 * The file paths an instruction file mentions outside code blocks, frontmatter and very long lines,
 * leaving out placeholders (path/to/x.ts), personal files (*.local.*) and examples ("e.g. src/x.ts").
 */
export function pathMentions(f: SetupFile): PathMention[] {
  const out: PathMention[] = [];
  for (const l of f.lines) {
    if (l.inFence || l.inFrontmatter || l.text.length > MAX_LINE) continue;
    for (const m of stripItalics(l.text).matchAll(PATH)) {
      const ref = m[1]!;
      const path = ref.includes('\\') ? ref.replaceAll('\\', '/') : ref;
      if (PLACEHOLDER.test(path) || LOCAL_ONLY.test(path)) continue;
      if (EXAMPLE_BEFORE.test(l.text.slice(Math.max(0, m.index - 100), m.index))) continue;
      out.push({ line: l, column: m.index + 1, ref, path });
    }
  }
  return out;
}
