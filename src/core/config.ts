import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { readSetupText } from './discover.js';
import { closest } from './suggest.js';
import type { RuleSetting } from './types.js';

export const CONFIG_NAMES = ['setupscore.yml', 'setupscore.yaml', '.setupscore.yml', '.setupscore.yaml'];

export interface Config {
  /** Which file it came from, relative to the root; undefined when using defaults. */
  source?: string;
  rules: Record<string, RuleSetting>;
  ignore: string[];
  /** Custom commands for `setupscore tasks`. */
  tasks?: { test?: string; install?: string };
  /** Extra domains the sandbox may reach while installing dependencies. */
  sandbox?: { domains?: string[] };
  /** How to start Claude Code for `setupscore run`. */
  agent?: { bin?: string; model?: string };
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly file: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

const schema = z
  .object({
    version: z.literal(1, { error: 'version must be 1' }),
    rules: z.record(z.string(), z.enum(['off', 'warning', 'error'])).optional(),
    ignore: z
      .array(
        z
          .string()
          .min(1, { error: 'an empty pattern matches nothing; remove it' })
          .max(4096, { error: 'a pattern this long cannot be a real path; shorten it' }),
      )
      .optional(),
    tasks: z
      .object({ test: z.string().min(1).optional(), install: z.string().min(1).optional() })
      .strict()
      .optional(),
    sandbox: z
      .object({ domains: z.array(z.string().min(1)).optional() })
      .strict()
      .optional(),
    agent: z
      .object({ bin: z.string().min(1).optional(), model: z.string().min(1).optional() })
      .strict()
      .optional(),
  })
  .strict();

const TOP_KEYS = ['version', 'rules', 'ignore', 'tasks', 'sandbox', 'agent'];

export function loadConfig(root: string, ruleIds: string[]): Config {
  const name = CONFIG_NAMES.find((n) => existsSync(join(root, n)));
  if (!name) return { rules: {}, ignore: [] };

  const abs = join(root, name);
  const read = readSetupText(abs, 1024 * 1024);
  if (read === null) {
    const what = statSync(abs, { throwIfNoEntry: false })?.isDirectory()
      ? 'a folder'
      : 'not a regular file (a pipe, socket or device)';
    throw new ConfigError(`${name} is ${what}. setupscore reads its settings from a plain YAML file.`, name);
  }
  if ('problem' in read) {
    if (read.problem === 'too-big')
      throw new ConfigError(`${name} is too big to be a setupscore config (${read.detail} bytes).`, name);
    if (read.problem === 'not-utf8')
      throw new ConfigError(
        `${name} is saved as UTF-16. Save it as UTF-8 (in PowerShell: Set-Content -Encoding utf8).`,
        name,
      );
    if (!/permission/.test(read.detail)) throw new ConfigError(`Cannot read ${name} (${read.detail}).`, name);
    // Keep the error code, so the CLI says "No permission to use …" and exits with 3.
    const err = new Error(`Cannot read ${name}: ${read.detail}`) as NodeJS.ErrnoException;
    err.code = 'EACCES';
    err.path = abs;
    throw err;
  }

  let data: unknown;
  try {
    // logLevel 'error': YAML warnings would otherwise be printed to stderr with a copy of the text.
    data = parseYaml(read.text.replace(/^\uFEFF/, ''), { logLevel: 'error' });
  } catch (err) {
    throw new ConfigError(`${name} is not valid YAML: ${(err as Error).message.split('\n')[0]}`, name);
  }
  if (data === null || data === undefined) data = { version: 1 };

  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => {
      if (i.code === 'unrecognized_keys') {
        return i.keys
          .map((k) => {
            const near = closest(k, TOP_KEYS);
            return `unknown key "${k}"${near ? ` (did you mean "${near}"?)` : ''}`;
          })
          .join('; ');
      }
      const where = i.path.length ? `${i.path.join('.')}: ` : '';
      if (i.path[0] === 'rules' && i.path.length === 2) return `${where}use "off", "warning" or "error"`;
      if (i.path[0] === 'version') return 'add "version: 1" at the top';
      return `${where}${i.message}`;
    });
    throw new ConfigError(`${name}: ${problems.join('; ')}`, name);
  }

  const rules = parsed.data.rules ?? {};
  for (const id of Object.keys(rules)) {
    if (!ruleIds.includes(id)) {
      const near = closest(id, ruleIds);
      throw new ConfigError(
        `${name}: unknown rule "${id}"${near ? ` (did you mean "${near}"?)` : ''}. Run "setupscore rules" to see every rule.`,
        name,
      );
    }
  }
  return {
    source: name,
    rules,
    ignore: parsed.data.ignore ?? [],
    tasks: parsed.data.tasks,
    sandbox: parsed.data.sandbox,
    agent: parsed.data.agent,
  };
}
