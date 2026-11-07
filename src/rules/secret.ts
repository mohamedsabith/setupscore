import { findSecrets, isPlaceholder, mask } from '../core/secrets.js';
import type { Context, Issue, Rule, SetupFile } from '../core/types.js';
import { clip, isObject, lineOf, parseJson } from './util.js';

const SECRET_KEY = /key|token|secret|password|passwd|pwd|auth|credential|cookie|session/i;

/** True for a value in an env or headers block that is clearly not a literal secret. */
function notASecret(v: string): boolean {
  // "${VAR}" is the right way; "$VAR" and "%VAR%" are variables written wrongly (mcp-config reports them), not secrets.
  if (v.includes('${') || /^\$[A-Z_]/i.test(v) || /%[A-Z_]\w*%/i.test(v)) return true;
  if (/^(?:true|false|none|null)$/i.test(v.trim())) return true;
  const bare = v.replace(/^(?:Bearer|Basic|Token)\s+/i, '').trim();
  if (bare.length < 8 || isPlaceholder(bare)) return true;
  // A sentence ("is passed in the header") is a note, not a key. Known key formats inside it are still found line by line.
  if (/\s/.test(bare) && !bare.startsWith('-----BEGIN')) return true;
  return false;
}

/** Literal secrets in "env" and "headers" blocks of .mcp.json, or "env" in settings.json. */
function structured(f: SetupFile): { key: string; value: string }[] {
  const { value } = parseJson(f);
  if (!isObject(value)) return [];
  const blocks: Record<string, unknown>[] = [];
  if (f.kind === 'mcp' && isObject(value['mcpServers'])) {
    for (const server of Object.values(value['mcpServers'])) {
      if (!isObject(server)) continue;
      if (isObject(server['env'])) blocks.push(server['env']);
      if (isObject(server['headers'])) blocks.push(server['headers']);
    }
  }
  if ((f.kind === 'settings' || f.kind === 'settings-local') && isObject(value['env'])) blocks.push(value['env']);

  const out: { key: string; value: string }[] = [];
  for (const block of blocks) {
    for (const [key, v] of Object.entries(block)) {
      if (typeof v !== 'string' || !SECRET_KEY.test(key) || notASecret(v)) continue;
      out.push({ key, value: v });
    }
  }
  return out;
}

export const secret: Rule = {
  id: 'secret',
  severity: 'error',
  summary: 'An API key, token or password is written into a setup file.',
  why: 'Setup files are committed to git and sent to the AI provider. Anyone with the repo, or its history, can read the key.',
  check(ctx: Context): Issue[] {
    const issues: Issue[] = [];
    for (const f of ctx.files) {
      const isJsonConfig = f.kind === 'mcp' || f.kind === 'settings' || f.kind === 'settings-local';
      const local = f.kind === 'settings-local' || f.kind === 'claude-local-md';
      const advice = isJsonConfig
        ? f.kind === 'mcp'
          ? 'Write "${VAR_NAME}" instead and set the variable in your shell. Claude Code expands it.'
          : 'Move it to an environment variable outside the repo.'
        : 'Delete it and keep it in an environment variable.';
      const rotate = local ? '' : ' If it was ever committed, rotate the key: it is in your git history.';

      // Each secret is reported once per file. Values found in env blocks are remembered by line,
      // so the line scan below does not report them a second time.
      const reported = new Set<string>();
      const structuredByLine = new Map<number, string[]>();
      for (const { key, value } of structured(f)) {
        if (reported.has(value)) continue;
        reported.add(value);
        const line = lineOf(f, value);
        if (line !== undefined) structuredByLine.set(line, [...(structuredByLine.get(line) ?? []), value]);
        issues.push({
          rule: 'secret',
          severity: 'error',
          file: f.path,
          line,
          message: `"${clip(key, 60)}" holds a literal secret (${mask(value)}).`,
          hint: advice + rotate,
        });
      }
      for (const l of f.lines) {
        const onLine = structuredByLine.get(l.n);
        for (const s of findSecrets(l.text)) {
          if (reported.has(s.value)) continue;
          if (onLine?.some((r) => r.includes(s.value) || s.value.includes(r))) continue;
          reported.add(s.value);
          issues.push({
            rule: 'secret',
            severity: 'error',
            file: f.path,
            line: l.n,
            column: s.index + 1,
            message: `Looks like ${s.what} (${mask(s.value)}).`,
            hint: advice + rotate,
          });
        }
      }
    }
    return issues;
  },
};
