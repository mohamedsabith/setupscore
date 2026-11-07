import type { Rule } from '../core/types.js';
import { agentFrontmatter } from './agent-frontmatter.js';
import { agentsMdNotLoaded } from './agents-md-not-loaded.js';
import { brokenHook } from './broken-hook.js';
import { brokenImport } from './broken-import.js';
import { brokenReference } from './broken-reference.js';
import { contradiction } from './contradiction.js';
import { deepImport } from './deep-import.js';
import { duplicateRule } from './duplicate-rule.js';
import { envNotDenied } from './env-not-denied.js';
import { invalidConfig } from './invalid-config.js';
import { mcpConfig } from './mcp-config.js';
import { misnamedFile } from './misnamed-file.js';
import { missingScript } from './missing-script.js';
import { riskyPermission } from './risky-permission.js';
import { secret } from './secret.js';
import { skillFrontmatter } from './skill-frontmatter.js';
import { tooLong } from './too-long.js';
import { unusedPathRule } from './unused-path-rule.js';
import { vagueRule } from './vague-rule.js';
import { wrongPackageManager } from './wrong-package-manager.js';

/** Every rule, in the order they are listed by `setupscore rules`. */
export const RULES: readonly Rule[] = [
  // Broken things: Claude is told something that cannot work.
  brokenReference,
  brokenImport,
  missingScript,
  wrongPackageManager,
  brokenHook,
  invalidConfig,
  secret,
  misnamedFile,
  agentsMdNotLoaded,
  // Security of the setup itself.
  riskyPermission,
  envNotDenied,
  mcpConfig,
  // Quality of the instructions.
  contradiction,
  vagueRule,
  duplicateRule,
  tooLong,
  deepImport,
  unusedPathRule,
  skillFrontmatter,
  agentFrontmatter,
];

export const RULE_IDS = RULES.map((r) => r.id);
