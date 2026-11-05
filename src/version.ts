import { readFileSync } from 'node:fs';

/** The package version, read from package.json next to the built files. */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export const REPO_URL = 'https://github.com/mohamedsabith/setupscore';
