import { posix } from 'node:path';
import { baseOf, dirOf, normRel } from './paths.js';
import type { Context } from './types.js';

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** Similarity from 0 to 1. */
export const similarity = (a: string, b: string): number =>
  1 - levenshtein(a.toLowerCase(), b.toLowerCase()) / Math.max(a.length, b.length, 1);

/** The closest word from a list, if it is close enough to be a likely typo. */
export function closest(word: string, options: Iterable<string>, min = 0.5): string | undefined {
  let best: string | undefined;
  let bestScore = min;
  for (const o of options) {
    const s = similarity(word, o);
    if (s > bestScore || (s === bestScore && best === undefined)) {
      best = o;
      bestScore = s;
    }
  }
  return best;
}

export interface PathSuggestion {
  /** Path relative to the root. */
  path: string;
  /** True when it is safe for --fix to apply without a human looking. */
  safe: boolean;
  reason: 'renamed' | 'moved' | 'similar' | 'case';
}

interface FileIndex {
  byBase: Map<string, string[]>;
  /** Folder + lower-case extension -> files, for "similar name in the same folder". */
  byDirExt: Map<string, string[]>;
  byLower: Map<string, string[]>;
  memo: Map<string, PathSuggestion | undefined>;
  /** Name comparisons left for "did you mean" hints, so thousands of broken paths stay fast. */
  budget: number;
}

const indexes = new WeakMap<readonly string[], FileIndex>();
const push = (m: Map<string, string[]>, k: string, v: string) => {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
};

/** Index the repo's files once per check: by name, by folder and by lower-case path. */
function fileIndex(files: readonly string[]): FileIndex {
  let idx = indexes.get(files);
  if (!idx) {
    idx = { byBase: new Map(), byDirExt: new Map(), byLower: new Map(), memo: new Map(), budget: 200_000 };
    for (const f of files) {
      push(idx.byBase, baseOf(f), f);
      push(idx.byDirExt, `${dirOf(f)}\0${posix.extname(f).toLowerCase()}`, f);
      push(idx.byLower, f.normalize('NFC').toLowerCase(), f);
    }
    indexes.set(files, idx);
  }
  return idx;
}

/** Folders with more files than this get no "similar name" hint: comparing every name costs too much. */
const MAX_SIBLINGS = 2000;

/**
 * Find where a missing file probably is now:
 * 1. renamed in git history (safe),
 * 2. the same path in a different letter case (safe: it works on macOS and Windows, not on Linux),
 * 3. the only file in the repo with the same name (safe),
 * 4. a similarly named file in the same folder (a hint only).
 */
export function suggestPath(ctx: Context, missing: string): PathSuggestion | undefined {
  const renamed = ctx.renames().get(missing);
  if (renamed) return { path: renamed, safe: true, reason: 'renamed' };

  const files = ctx.repoFiles();
  const idx = fileIndex(files);
  if (idx.memo.has(missing)) return idx.memo.get(missing);
  const remember = (s: PathSuggestion | undefined) => {
    idx.memo.set(missing, s);
    return s;
  };

  const sameLower = (idx.byLower.get(missing.normalize('NFC').toLowerCase()) ?? []).filter((f) => f !== missing);
  if (sameLower.length === 1) return remember({ path: sameLower[0]!, safe: true, reason: 'case' });

  const base = baseOf(missing);
  const sameName = (idx.byBase.get(base) ?? []).filter((f) => f !== missing);
  if (sameName.length === 1) return remember({ path: sameName[0]!, safe: true, reason: 'moved' });

  const dir = dirOf(missing);
  const ext = posix.extname(missing).toLowerCase();
  const siblings = idx.byDirExt.get(`${dir}\0${ext}`) ?? [];
  if (siblings.length <= MAX_SIBLINGS && idx.budget > 0) {
    idx.budget -= siblings.length;
    const names = siblings
      .map(baseOf)
      .filter((n) => Math.abs(n.length - base.length) <= 0.55 * Math.max(n.length, base.length));
    const near = closest(base, names, 0.45);
    if (near) return remember({ path: normRel(posix.join(dir, near)), safe: false, reason: 'similar' });
  }
  if (siblings.length === 1) return remember({ path: siblings[0]!, safe: false, reason: 'similar' });
  return remember(undefined);
}

/**
 * Write a replacement path in the same style as the original:
 * root-relative stays root-relative, and `./` or `../` stays relative to the file.
 */
export function rewriteLike(original: string, fileDir: string, newRootRel: string): string {
  if (/^\.{1,2}\//.test(original)) {
    let rel = posix.relative(fileDir || '.', newRootRel);
    if (!rel.startsWith('.')) rel = `./${rel}`;
    return rel;
  }
  return newRootRel;
}
