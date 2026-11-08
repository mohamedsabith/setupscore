import type { CheckRun } from '../core/check.js';
import type { Applied } from '../core/fix.js';
import type { FileReport, Issue } from '../core/types.js';
import { VERSION } from '../version.js';

/** Bumped only on breaking changes. New fields may be added within a version. */
export const JSON_SCHEMA_VERSION = 1;

export interface JsonReport {
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  tool: { name: 'setupscore'; version: string };
  root: string;
  config: string | null;
  health: number;
  summary: {
    files: number;
    errors: number;
    warnings: number;
    /** Findings at the "hint" level, which never fail a build. */
    hints: number;
    fixable: number;
    startupTokens: number;
    /** True when the file scan stopped at its limit (100,000 files), so some files were not checked. */
    truncated: boolean;
  };
  files: FileReport[];
  issues: (Omit<Issue, 'fix'> & { fixable: boolean })[];
  fixed: { rule: string; file: string; line: number; column?: number | undefined; from: string; to: string }[];
  /** Rules that crashed and were skipped. Empty when every rule ran. */
  ruleErrors: { rule: string; message: string }[];
}

export function toJson(run: CheckRun, fixed: Applied[] = []): JsonReport {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    tool: { name: 'setupscore', version: VERSION },
    root: run.root,
    config: run.config.source ?? null,
    health: run.health,
    summary: {
      files: run.files.length,
      errors: run.errors,
      warnings: run.warnings,
      hints: run.hints,
      fixable: run.fixable,
      startupTokens: run.startupTokens,
      truncated: run.truncated,
    },
    files: run.files,
    issues: run.issues.map(({ fix, ...rest }) => ({ ...rest, fixable: !!fix })),
    fixed: fixed.map((a) => ({ rule: a.rule, ...a.fix })),
    ruleErrors: run.ruleErrors,
  };
}
