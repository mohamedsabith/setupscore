import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll } from 'vitest';
import { check, type CheckOptions } from '../src/core/check.js';
import type { Issue } from '../src/core/types.js';

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** Create a throwaway project folder from a map of path -> contents. */
export function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'setupscore-'));
  made.push(root);
  writeFiles(root, files);
  return root;
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
}

export function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function initGit(root: string): void {
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  // Files keep their exact bytes on every OS (Windows runners turn LF into CRLF by default).
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
}

/** Run the checker with built-in defaults (no config file lookup surprises). */
export function issuesOf(root: string, rule?: string, options?: CheckOptions): Issue[] {
  const run = check(root, { config: { rules: {}, ignore: [] }, ...options });
  return rule ? run.issues.filter((i) => i.rule === rule) : run.issues;
}

/** Shortcut: a repo with just these files, issues for one rule. */
export const lint = (rule: string, files: Record<string, string>): Issue[] => issuesOf(makeRepo(files), rule);

export const PKG = JSON.stringify({ name: 'demo', scripts: { test: 'vitest', build: 'tsc', lint: 'eslint .' } });
