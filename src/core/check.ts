import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import picomatch from 'picomatch';
import { RULES } from '../rules/index.js';
import { clearCaches } from '../rules/util.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { estimateTokens, startupTokens } from './cost.js';
import { discover } from './discover.js';
import { gitRenames } from './git.js';
import { readDisables } from './markdown.js';
import { maskSecrets } from './secrets.js';
import type { CheckResult, Context, Issue, Rule, Severity } from './types.js';
import { exactLookup, isSetupLink, walk } from './walk.js';

export interface CheckOptions {
  /** Use these rules instead of the built-in list (for tests and plugins). */
  rules?: readonly Rule[];
  /** Skip loading setupscore.yml. */
  config?: Config;
}

export interface CheckRun extends CheckResult {
  config: Config;
  truncated: boolean;
  /** Rules that crashed. Reported, never fatal. */
  ruleErrors: { rule: string; message: string }[];
}

/** CLAUDE.md files first (they matter most), then everything else by path. */
const rank = (path: string) => (/(^|\/)CLAUDE(\.local)?\.md$/.test(path) ? 0 : 1);
const byPath = (a: string, b: string) => rank(a) - rank(b) || a.localeCompare(b);
const order = (a: Issue, b: Issue) =>
  byPath(a.file, b.file) ||
  (a.line ?? 0) - (b.line ?? 0) ||
  (a.column ?? 0) - (b.column ?? 0) ||
  a.rule.localeCompare(b.rule);

/** Control characters (terminal escape sequences) from files must never reach the terminal. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/**
 * Make text from a setup file safe to print: every secret masked, control characters replaced.
 * Every message and hint goes through this, whatever rule wrote it.
 */
export const safeText = (text: string): string => maskSecrets(text).replace(CONTROL, '�');

function compileIgnore(patterns: string[], source: string | undefined): (rel: string) => boolean {
  if (patterns.length === 0) return () => false;
  try {
    return picomatch(patterns, { dot: true });
  } catch (err) {
    throw new ConfigError(
      `${source ?? 'setupscore.yml'}: an "ignore" pattern is not a valid glob (${(err as Error).message.split('\n')[0]}).`,
      source ?? 'setupscore.yml',
    );
  }
}

export function check(dir: string, options: CheckOptions = {}): CheckRun {
  let root: string;
  try {
    root = resolve(dir);
  } catch {
    // resolve() needs the current folder, which may have been deleted under us.
    throw new Error(`Folder not found: ${dir} (the current folder no longer exists; cd into your project again)`);
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Folder not found: ${dir}`);
  clearCaches();

  const rules = options.rules ?? RULES;
  const config =
    options.config ??
    loadConfig(
      root,
      RULES.map((r) => r.id),
    );
  const ignored = compileIgnore(config.ignore, config.source);

  const listing = walk(root, (rel) => ignored(rel) || ignored(rel.replace(/\/$/, '')), { followLink: isSetupLink });
  const nfc = (p: string) => p.normalize('NFC');
  const repoFileSet = new Set(listing.files.map(nfc));
  const dirSet = new Set<string>();
  for (const f of listing.files) {
    let i = f.indexOf('/');
    while (i > 0) {
      dirSet.add(nfc(f.slice(0, i)));
      i = f.indexOf('/', i + 1);
    }
  }
  // Existence is checked with the exact letter case on every OS, so a check on macOS or Windows
  // gives the same answer as Claude Code on Linux and as CI.
  const lookup = exactLookup(root);
  const { files, imports, skipped, misnamed } = discover(root, listing.files, { lookup });

  let renames: Map<string, string> | undefined;
  const inside = (rel: string) => rel !== '' && rel !== '..' && !rel.startsWith('../');
  const existsRel = (rel: string) =>
    inside(rel) && (repoFileSet.has(nfc(rel)) || dirSet.has(nfc(rel)) || lookup(rel) !== null);
  const ctx: Context = {
    root,
    files,
    imports,
    skipped,
    misnamed,
    unreadableDirs: listing.unreadable ?? [],
    repoFiles: () => listing.files,
    existsRel,
    isDir: (rel) => inside(rel) && (dirSet.has(nfc(rel)) || lookup(rel) === 'dir'),
    renames: () => (renames ??= gitRenames(root, existsRel)),
  };

  const disables = new Map(files.map((f) => [f.path, readDisables(f.lines)]));
  const isDisabled = (i: Issue) => {
    const d = disables.get(i.file);
    if (!d) return false;
    if (d.file.has('*') || d.file.has(i.rule)) return true;
    const onLine = i.line !== undefined ? d.lines.get(i.line) : undefined;
    return !!onLine && (onLine.has('*') || onLine.has(i.rule));
  };

  const issues: Issue[] = [];
  const ruleErrors: CheckRun['ruleErrors'] = [];
  for (const rule of rules) {
    const setting = config.rules[rule.id] ?? rule.severity;
    if (setting === 'off') continue;
    let found: Issue[];
    try {
      found = rule.check(ctx);
    } catch (err) {
      ruleErrors.push({ rule: rule.id, message: safeText(String((err as Error)?.message ?? err)).slice(0, 300) });
      continue;
    }
    for (const i of found) {
      if (isDisabled(i)) continue;
      const issue: Issue = { ...i, severity: setting as Severity, message: safeText(i.message) };
      if (i.hint !== undefined) issue.hint = safeText(i.hint);
      issues.push(issue);
    }
  }
  issues.sort(order);

  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.length - errors;
  const reports = files
    .map((f) => ({ path: f.path, kind: f.kind, loadsAtStart: f.loadsAtStart, tokens: estimateTokens(f.text) }))
    .sort((a, b) => byPath(a.path, b.path));

  return {
    root,
    files: reports,
    issues,
    errors,
    warnings,
    fixable: issues.filter((i) => i.fix).length,
    health:
      files.length === 0 && issues.length === 0
        ? 10
        : Math.max(0, Math.round((10 - errors - warnings * 0.5) * 10) / 10),
    startupTokens: files.reduce((sum, f) => sum + startupTokens(f), 0),
    config,
    truncated: listing.truncated,
    ruleErrors,
  };
}
