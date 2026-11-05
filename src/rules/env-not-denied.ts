import picomatch from 'picomatch';
import { gitTracked } from '../core/git.js';
import { baseOf } from '../core/paths.js';
import type { Context, Issue, Rule } from '../core/types.js';
import { isObject, parseJson } from './util.js';

const ENV_FILE = /^\.env(?:\.[\w.-]+)?$/i;
const TEMPLATE = /\.(?:example|sample|template|dist|defaults?)$/i;

/** One deny rule: the folder its settings file belongs to, and the pattern inside Read(...). */
interface Deny {
  base: string;
  pattern: string;
}

/**
 * True when a deny rule stops Claude from reading the file. Rules follow gitignore-style
 * patterns: "./.env" or "/.env" is the file in that folder, ".env" or "**\/.env" is any .env.
 * Claude Code only understands forward slashes, so a pattern with "\" never matches.
 */
function covers(d: Deny, envPath: string): boolean {
  let p = d.pattern.trim();
  if (p === '' || p === '*' || p === '**') return true; // denies every read
  if (p.includes('\\')) return false;
  if (p.startsWith('~') || p.startsWith('//')) return p.includes('.env'); // a fixed path on one machine: cannot check, trust it
  if (d.base && !envPath.startsWith(`${d.base}/`)) return false;
  const rel = d.base ? envPath.slice(d.base.length + 1) : envPath;
  const anchored = p.startsWith('./') || p.startsWith('/') || p.slice(0, -1).includes('/');
  p = p.replace(/^\.?\//, '');
  try {
    const match = picomatch(p, { dot: true });
    return anchored ? match(rel) : match(baseOf(rel)) || match(rel);
  } catch {
    return false;
  }
}

export const envNotDenied: Rule = {
  id: 'env-not-denied',
  severity: 'warning',
  summary: 'The project has a .env file but no permission rule stops Claude from reading it.',
  why: "Claude Code can read any file in the project. A deny rule keeps API keys and passwords in .env out of the conversation, and out of the AI provider's logs.",
  check(ctx: Context): Issue[] {
    let envFiles = ctx.repoFiles().filter((p) => ENV_FILE.test(baseOf(p)) && !TEMPLATE.test(p));
    if (envFiles.length === 0) return [];
    // A .env file committed to git is public config, not a secret store.
    const tracked = gitTracked(ctx.root, '*.env*');
    if (tracked) envFiles = envFiles.filter((p) => !tracked.has(p));
    if (envFiles.length === 0) return [];

    const denies: Deny[] = [];
    for (const f of ctx.files.filter((f) => f.kind === 'settings' || f.kind === 'settings-local')) {
      const { value } = parseJson(f);
      if (!isObject(value) || !isObject(value.permissions) || !Array.isArray(value.permissions.deny)) continue;
      const base = f.path.slice(0, Math.max(0, f.path.indexOf('.claude/') - 1));
      for (const d of value.permissions.deny) {
        if (typeof d !== 'string') continue;
        const m = d.trim().match(/^(?:Read|Edit|Write)(?:\((.*)\))?$/);
        if (m) denies.push({ base, pattern: m[1] ?? '' });
        // Other entries that name .env (for example "Bash(cat .env)") do not stop the Read tool.
      }
    }
    const open = envFiles.filter((p) => !denies.some((d) => covers(d, p)));
    if (open.length === 0) return [];

    const nested = open.some((p) => p.includes('/'));
    const shown = open.slice(0, 5).join(', ') + (open.length > 5 ? ` and ${open.length - 5} more` : '');
    return [
      {
        rule: 'env-not-denied',
        severity: 'warning',
        file: ctx.existsRel('.claude/settings.json') ? '.claude/settings.json' : open[0]!,
        message: `Claude can read ${shown}. Nothing in .claude/settings.json denies it.`,
        hint: nested
          ? 'Add to .claude/settings.json:  "permissions": { "deny": ["Read(**/.env)", "Read(**/.env.*)"] }'
          : 'Add to .claude/settings.json:  "permissions": { "deny": ["Read(./.env)", "Read(./.env.*)"] }',
      },
    ];
  },
};
