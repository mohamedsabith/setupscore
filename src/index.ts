/**
 * setupscore: check a Claude Code setup without calling any AI.
 *
 *   import { check } from 'setupscore';
 *   const result = check('.');
 *   console.log(result.errors, result.issues);
 */
export { check, type CheckOptions, type CheckRun } from './core/check.js';
export { applyFixes, type Applied } from './core/fix.js';
export { loadConfig, ConfigError, CONFIG_NAMES, type Config } from './core/config.js';
export { estimateTokens } from './core/cost.js';
export { RULES, RULE_IDS } from './rules/index.js';
export { toJson, JSON_SCHEMA_VERSION, type JsonReport } from './report/json.js';
export { VERSION } from './version.js';
export type {
  CheckResult,
  Context,
  FileKind,
  FileReport,
  Fix,
  ImportRef,
  Issue,
  Rule,
  RuleSetting,
  SetupFile,
  Severity,
} from './core/types.js';
