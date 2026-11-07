import { realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { EnvironmentError } from '../sandbox/types.js';
import { readSetupText } from './discover.js';
import { writeFileAtomic } from './fsx.js';
import type { Fix, Issue } from './types.js';

export interface Applied {
  fix: Fix;
  rule: string;
}

/** A file whose fixes could not be written. */
export interface FixFailure {
  file: string;
  /** Plain-English reason. */
  reason: string;
  code?: string | undefined;
}

function reasonOf(err: NodeJS.ErrnoException): string {
  switch (err.code) {
    case 'ENOSPC':
      return 'the disk is full';
    case 'EACCES':
    case 'EPERM':
      return 'no permission to change it';
    case 'EROFS':
      return 'it is on a read-only file system';
    case 'EDQUOT':
      return 'the disk quota is used up';
    default:
      return err.code ? `${err.code}: ${err.message.split(',')[0]}` : err.message;
  }
}

/** Apply the fixes for one line, right to left so earlier columns stay valid. */
function fixLine(line: string, fixes: Fix[]): { text: string; done: Fix[] } {
  const located = fixes
    .map((fix) => {
      let at = -1;
      if (fix.column !== undefined) {
        if (line.startsWith(fix.from, fix.column - 1)) at = fix.column - 1;
      } else at = line.indexOf(fix.from);
      return { fix, at };
    })
    .filter((x) => x.at >= 0)
    .sort((a, b) => b.at - a.at);
  let text = line;
  const done: Fix[] = [];
  let limit = Infinity; // never apply two fixes that overlap
  for (const { fix, at } of located) {
    if (at + fix.from.length > limit) continue;
    text = text.slice(0, at) + fix.to + text.slice(at + fix.from.length);
    limit = at;
    done.push(fix);
  }
  return { text, done };
}

/**
 * Apply the fixes attached to issues. Each fix replaces one exact piece of text at one place on
 * one line, so a fix that no longer matches (the file changed) is skipped, never forced. Each
 * file is written atomically (a full disk never leaves half a file) and keeps its own line
 * endings. If some files cannot be written, the others are still fixed: the failures go into
 * `failures` when it is given, or are thrown as one EnvironmentError that also says what was fixed.
 */
export function applyFixes(root: string, issues: Issue[], failures?: FixFailure[]): Applied[] {
  const byFile = new Map<string, Issue[]>();
  for (const i of issues) {
    if (!i.fix) continue;
    const list = byFile.get(i.fix.file) ?? [];
    list.push(i);
    byFile.set(i.fix.file, list);
  }

  const applied: Applied[] = [];
  const failed: FixFailure[] = [];
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = root;
  }
  for (const [file, list] of byFile) {
    const abs = join(root, file);
    try {
      // Write to the real file behind a symbolic link (CLAUDE.md -> AGENTS.md keeps its link),
      // but never to a file outside the project.
      const real = realpathSync(abs);
      const rel = relative(realRoot, real);
      if (rel.startsWith(`..${sep}`) || rel === '..') {
        failed.push({ file, reason: 'it links to a file outside the project' });
        continue;
      }
      const read = readSetupText(real);
      if (read === null || 'problem' in read) {
        failed.push({
          file,
          reason: read === null ? 'it was removed or replaced since the check' : `it cannot be read (${read.detail})`,
        });
        continue;
      }
      const bom = read.text.startsWith('﻿') ? '﻿' : '';
      // Odd entries are the line endings, so every line keeps its own (LF, CRLF or CR).
      const parts = read.text.slice(bom.length).split(/(\r\n|\r|\n)/);
      const byLine = Map.groupBy(list, (i) => i.fix!.line);
      const done: Applied[] = [];
      for (const [line, onLine] of byLine) {
        const idx = (line - 1) * 2;
        if (line < 1 || idx >= parts.length) continue;
        const r = fixLine(
          parts[idx]!,
          onLine.map((i) => i.fix!),
        );
        if (r.done.length === 0) continue;
        parts[idx] = r.text;
        for (const fix of r.done) done.push({ fix, rule: onLine.find((i) => i.fix === fix)!.rule });
      }
      if (done.length === 0) continue;
      writeFileAtomic(real, bom + parts.join(''), statSync(real).mode & 0o777);
      applied.push(...done.sort((a, b) => a.fix.line - b.fix.line || (a.fix.column ?? 0) - (b.fix.column ?? 0)));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') failed.push({ file, reason: 'it was removed since the check' });
      else failed.push({ file, reason: reasonOf(e), code: e.code });
    }
  }

  if (failures) failures.push(...failed);
  else if (failed.length > 0) {
    const what = failed.map((f) => `${f.file} (${f.reason})`).join(', ');
    const fixedFiles = [...new Set(applied.map((a) => a.fix.file))];
    const message =
      applied.length > 0
        ? `Fixed ${applied.length} problem${applied.length === 1 ? '' : 's'} in ${fixedFiles.join(', ')}, but could not fix ${what}.`
        : `Could not fix ${what}. Nothing was changed.`;
    throw new EnvironmentError(message, [
      failed.some((f) => f.code === 'ENOSPC' || f.code === 'EDQUOT')
        ? 'Free some disk space, then run the check with --fix again.'
        : 'Fix the cause, then run the check with --fix again.',
      'Files that could not be written were left exactly as they were.',
    ]);
  }
  return applied;
}
