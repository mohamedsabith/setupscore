import { isAbsolute, posix, relative, sep } from 'node:path';

/** Turn any OS path into a forward-slash path. */
export const toPosix = (p: string): string => (sep === '\\' ? p.replaceAll('\\', '/') : p);

/** Normalise a relative path: remove `./`, resolve `..`, keep forward slashes. */
export const normRel = (p: string): string => {
  const n = posix.normalize(toPosix(p));
  return n === '.' ? '' : n.replace(/^\.\//, '');
};

/** Join a folder (relative to the root) and a path written inside a file. */
export const joinRel = (dir: string, p: string): string => normRel(posix.join(dir, p));

export const dirOf = (rel: string): string => {
  const d = posix.dirname(rel);
  return d === '.' ? '' : d;
};

export const baseOf = (rel: string): string => posix.basename(rel);

/** A word to paste into a shell hint, quoted only when needed. Windows keeps backslashes inside "...". */
export function shellArg(s: string): string {
  const win = process.platform === 'win32';
  if ((win ? /^[\w@%+=:,./\\-][\w@%+=:,./\\~-]*$/ : /^[\w@%+=:,./-][\w@%+=:,./~-]*$/).test(s)) return s;
  if (win) return `"${s}"`;
  // Inside "..." a shell still expands $, ` and ! (bash), and JSON escapes such as \n mean nothing to it.
  // Control characters are exactly what "..." cannot carry.
  if (/[$`!\u0000-\u001f]/.test(s)) return `'${s.replaceAll("'", `'\\''`)}'`;
  return JSON.stringify(s);
}

/** A path to show the user: relative to the current folder when it is inside it, otherwise absolute. */
export const displayPath = (abs: string, cwd: string = process.cwd()): string => {
  const rel = relative(cwd, abs);
  return !rel ? '.' : rel.startsWith('..') || isAbsolute(rel) ? abs : rel;
};
