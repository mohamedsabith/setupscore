import { dirOf, joinRel, normRel } from '../core/paths.js';
import type { Context, Issue, Rule } from '../core/types.js';
import { DATE_PLACEHOLDER, pathMentions } from './path-mentions.js';
import { instructionFiles, projectFolder } from './util.js';

/** Words that stand for a value in a file name pattern: plans/YYYY-MM-DD-ENG-XXXX-description.md. */
const NAME_WORDS =
  /^(?:description|desc|title|name|slug|topic|summary|subject|feature|patch|minor|major|version|ver|id|number|num|ticket|issue|pr|branch|author|user|username|count|seq)$/i;
/** A year in a file name: 2026-10.md, 20261031.log, 2026.3.1.md. */
const DATED = /(?<!\d)(?:19|20)\d\d/;

/** One part of a file name pattern as a regular expression: YYYY -> 4 digits, XXXX or <id> -> anything. */
/** One run of a letter in a pattern: YYYY, MM, D, ww, T, ... */
function runPattern(run: string): string {
  if (/^(?:y{2}|y{4})$/i.test(run)) return `\\d{${run.length}}`;
  // Month, day, hour, second (M or MM ...), and a week number written twice (ww).
  if (/^(?:mm?|dd?|hh?|ss?|ww)$/i.test(run)) return run.length === 1 ? '\\d{1,2}' : '\\d{2}';
  if (
    // XXXX, NNNN, ###, and one capital letter such as the P (patch) in YYYY.M.P.md or the T in DDTHH
    /^(?:x{2,}|n{2,}|#+)$/i.test(run) ||
    /^[A-Z]$/.test(run) ||
    NAME_WORDS.test(run) ||
    /^(?:<[^<>]*>|\{[^{}]*\}|\[[^[\]]*\])$/.test(run)
  )
    return '[^/]+?';
  return run.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One part of a file name pattern as a regular expression: YYYY -> 4 digits, XXXX or <id> -> anything.
 * Letters glued together are read one run at a time: YYYYMMDD, DDTHH (ISO time), Www (ISO week, W45),
 * QN (quarter, Q4), vYYYY (v2026). Only parts made of these date letters, or that hold a year, are split.
 */
function tokenPattern(token: string): string {
  if (/^[a-z]+$/i.test(token) && (/y{2}/i.test(token) || /^[ymdhswqnt]+$/i.test(token))) {
    // Runs of one letter in one case: "Www" is W then ww, "DDTHH" is DD, T, HH.
    const runs: string[] = [];
    for (const ch of token) {
      const last = runs.length - 1;
      if (last >= 0 && runs[last]![0] === ch) runs[last] = runs[last]! + ch;
      else runs.push(ch);
    }
    // A capital that only marks what follows is written as it is: the W of W45, the Q of Q4, the T of 14:30.
    const marker = (run: string, k: number) => /^[A-Z]$/.test(run) && !/^[MDHS]$/.test(run) && k < runs.length - 1;
    if (runs.length > 1) return runs.map((run, k) => (marker(run, k) ? run : runPattern(run))).join('');
  }
  return runPattern(token);
}

/** A path segment as a regular expression, and whether it holds anything to fill in. */
function segmentPattern(segment: string, isName: boolean): { re: string; fill: boolean } {
  const dot = isName ? segment.lastIndexOf('.') : -1;
  const stem = dot > 0 ? segment.slice(0, dot) : segment;
  const ext = dot > 0 ? segment.slice(dot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
  const parts = stem.split(/([-_.])/);
  const re = parts.map((t, k) => (k % 2 ? t.replace(/\./g, '\\.') : tokenPattern(t))).join('');
  return { re: re + ext, fill: re !== stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };
}

type PatternCheck =
  | { kind: 'fits' }
  | { kind: 'unknown' }
  | { kind: 'mismatch'; folder: string; files: string[] }
  | { kind: 'moved'; folder: string; written: string };

/**
 * A file name pattern (knowledge/history/YYYY-MM.md, docs/plans/YYYY-MM-DD-ENG-XXXX-description.md,
 * reports/YYYY/MM.md) compared with the files it describes. No folder name or place is assumed:
 * - the folder is looked up from each place the path may be written from (the project root, the
 *   instruction file's own folder, then the folder that holds its .claude/, then the project root),
 *   in any project layout;
 * - when that folder has files with a year in their name and the same extension, at least one must
 *   fit the pattern, or the pattern and the files disagree;
 * - when the folder exists nowhere, a folder of the same name elsewhere whose files fit is reported
 *   as the place it moved to, but only when there is exactly one.
 * Anything else is "unknown": no folder or no dated file yet (the first one is still to be written).
 */
function checkPattern(ctx: Context, path: string, bases: string[]): PatternCheck {
  const segments = normRel(path).split('/');
  const parts = segments.map((s, k) => segmentPattern(s, k === segments.length - 1));
  const fixed = parts.findIndex((p) => p.fill);
  if (fixed === -1) return { kind: 'unknown' };
  const ext = /\.[\w-]+$/.exec(segments[segments.length - 1]!)?.[0]?.toLowerCase() ?? '';
  const depth = segments.length - fixed;
  // eslint-disable-next-line security/detect-non-literal-regexp -- every part from the file is escaped or a fixed pattern (tokenPattern)
  const fits = new RegExp(
    `^${parts
      .slice(fixed)
      .map((p) => p.re)
      .join('/')}$`,
    'i',
  );
  const under = (folder: string) => {
    const prefix = folder ? `${folder}/` : '';
    return ctx
      .repoFiles()
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.slice(prefix.length))
      .filter((rest) => rest.split('/').length === depth && rest.toLowerCase().endsWith(ext) && DATED.test(rest));
  };
  const written = segments.slice(0, fixed).join('/');
  for (const base of bases) {
    const folder = joinRel(base, written);
    if (folder !== '' && !ctx.isDir(folder)) continue;
    const files = under(folder);
    if (files.length === 0) return { kind: 'unknown' };
    return files.some((rest) => fits.test(rest)) ? { kind: 'fits' } : { kind: 'mismatch', folder, files: files.sort() };
  }
  // The folder is nowhere it may be read from. Is there one folder of the same name whose files fit?
  const name = written.slice(written.lastIndexOf('/') + 1);
  if (!name) return { kind: 'unknown' };
  const elsewhere = [...new Set(ctx.repoFiles().map((p) => dirOf(p)))]
    .filter((d) => d === name || d.endsWith(`/${name}`))
    .filter((d) => under(d).some((rest) => fits.test(rest)));
  return elsewhere.length === 1 ? { kind: 'moved', folder: elsewhere[0]!, written } : { kind: 'unknown' };
}

export const fileNamePattern: Rule = {
  id: 'file-name-pattern',
  severity: 'warning',
  summary: 'A file name pattern in your instructions (history/YYYY-MM.md) does not fit the files it describes.',
  why: 'Claude writes new files the way the instructions say. If that differs from the files already there, the folder ends up with two naming styles, and tools that read it miss half the files.',
  check(ctx: Context): Issue[] {
    const issues: Issue[] = [];
    for (const f of instructionFiles(ctx)) {
      // The most specific folder first: a nested CLAUDE.md means its own folder, like broken-reference.
      const bases = [...new Set([dirOf(f.path), projectFolder(f.path), ''])];
      for (const { line, column, ref, path } of pathMentions(f)) {
        if (!DATE_PLACEHOLDER.test(path)) continue;
        const r = checkPattern(ctx, path, bases);
        const at = { rule: 'file-name-pattern', severity: 'warning' as const, file: f.path, line: line.n, column };
        if (r.kind === 'mismatch') {
          const { folder, files } = r;
          const shown = files.length > 1 ? `"${files[0]}" … "${files[files.length - 1]}"` : `"${files[0]}"`;
          issues.push({
            ...at,
            message: `"${ref}" is a file name pattern, but no file in ${folder || '.'}/ is named that way (the files there look like ${shown}), so Claude would start a second naming style.`,
            hint: 'Write the pattern the files use, or rename the files to fit it.',
          });
        } else if (r.kind === 'moved') {
          issues.push({
            ...at,
            message: `"${ref}" is a file name pattern for ${r.written}/, which does not exist. Files named that way are in ${r.folder}/.`,
            hint: `Write ${r.folder}/${path.slice(path.lastIndexOf('/') + 1)} if that is the folder you mean.`,
          });
        }
      }
    }
    return issues;
  },
};
