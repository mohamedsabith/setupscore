import type { Context, Issue, Rule } from '../core/types.js';
import { isObject, lineOf, parseJson, quote } from './util.js';

/** "Bash", "Bash()", "Bash(*)", "Bash(:*)", "Bash(**)": any command at all. Checked without a regex (no backtracking). */
function anyBash(entry: string): boolean {
  if (entry === 'Bash') return true;
  if (!entry.startsWith('Bash(') || !entry.endsWith(')')) return false;
  const inner = entry.slice(5, -1).trim();
  return inner === '' || inner === '*' || inner === ':*' || inner === '**';
}
const DANGEROUS =
  /^Bash\([ \t]*(sudo|su|rm|rmdir \/s|del|Remove-Item|chmod|chown|curl|wget|Invoke-WebRequest|ssh|scp|rsync|dd|mkfs|git push|git reset --hard|npm publish|pnpm publish|yarn publish|docker|kubectl|terraform|aws|gcloud|az)\b/i;
/** A shell with a wildcard runs anything: "Bash(powershell:*)", "Bash(cmd /c:*)", "Bash(bash -c *)". */
const SHELL =
  /^Bash\([ \t]*((?:[\w./\\:-]*[/\\])?(?:bash|sh|zsh|fish|dash|ksh|powershell|pwsh|cmd|eval|exec)(?:\.exe)?)\b[^)]*\*[ \t]*\)$/i;

export const riskyPermission: Rule = {
  id: 'risky-permission',
  severity: 'warning',
  summary: 'settings.json lets Claude run risky commands without asking, or turns permission prompts off.',
  why: 'Allowed commands run with no prompt. One bad step, or a prompt injection hidden in a file or web page, can then delete files, push code or send data out.',
  check(ctx: Context): Issue[] {
    const issues: Issue[] = [];
    for (const f of ctx.files.filter((f) => f.kind === 'settings' || f.kind === 'settings-local')) {
      const { value } = parseJson(f);
      if (!isObject(value) || !isObject(value.permissions)) continue;
      const who = f.kind === 'settings' ? 'everyone who uses this repo' : 'you';
      const allow = Array.isArray(value.permissions.allow) ? value.permissions.allow : [];

      for (const entry of allow) {
        if (typeof entry !== 'string') continue;
        const line = lineOf(f, JSON.stringify(entry));
        if (anyBash(entry.trim())) {
          issues.push({
            rule: 'risky-permission',
            severity: 'warning',
            file: f.path,
            line,
            message: `${quote(entry)} lets Claude run any shell command without asking ${who}.`,
            hint: 'Allow specific commands instead, e.g. "Bash(npm run test:*)", "Bash(git status)".',
          });
          continue;
        }
        if (entry.length > 10_000) continue; // not a real permission rule
        const shell = entry.match(SHELL);
        if (shell) {
          issues.push({
            rule: 'risky-permission',
            severity: 'warning',
            file: f.path,
            line,
            message: `${quote(entry)} lets Claude run any command through ${quote(shell[1]!, 30)} without asking ${who}.`,
            hint: 'A shell with a wildcard allows everything. Allow the specific commands you need instead.',
          });
          continue;
        }
        const m = entry.match(DANGEROUS);
        if (m) {
          issues.push({
            rule: 'risky-permission',
            severity: 'warning',
            file: f.path,
            line,
            message: `${quote(entry)} runs "${m[1]}" with no prompt.`,
            hint: `Move it to "ask" so a person confirms each time, or narrow it to the exact command you need.`,
          });
        }
      }

      if (value.permissions.defaultMode === 'bypassPermissions') {
        issues.push({
          rule: 'risky-permission',
          severity: 'warning',
          file: f.path,
          line: lineOf(f, 'bypassPermissions'),
          message: `"defaultMode": "bypassPermissions" turns off every permission prompt for ${who}.`,
          hint: 'Use it only inside a throwaway container. In a shared repo, prefer "acceptEdits" or a short allow list.',
        });
      }
    }
    return issues;
  },
};
