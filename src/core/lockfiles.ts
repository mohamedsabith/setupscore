/** The package managers setupscore knows, and the lockfile each one writes. */
export type PmName = 'npm' | 'pnpm' | 'yarn' | 'bun';

const PM_NAMES: readonly PmName[] = ['npm', 'pnpm', 'yarn', 'bun'];

/** In the order `tasks` prefers them when a folder has more than one. Bun keeps bun.lockb next to bun.lock on purpose. */
export const LOCKFILES: readonly (readonly [string, PmName])[] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

/** The package manager named by package.json "packageManager" ("pnpm@9.1.0"), if it is one setupscore knows. */
export const pmFromField = (value: unknown): PmName | undefined => {
  const name = typeof value === 'string' ? value.split('@')[0] : undefined;
  return PM_NAMES.find((n) => n === name);
};
