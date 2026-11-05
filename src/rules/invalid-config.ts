import type { Context, Issue, Rule } from '../core/types.js';
import { lineAt, parseJson } from './util.js';

const isClaudeFolder = (rel: string): boolean => rel.split('/').includes('.claude');

export const invalidConfig: Rule = {
  id: 'invalid-config',
  severity: 'error',
  summary:
    "settings.json, .mcp.json or a file's YAML frontmatter cannot be parsed, or a setup file cannot be read at all.",
  why: 'Claude Code cannot read a broken file, so the permissions, MCP servers or skill settings in it do nothing.',
  check(ctx: Context): Issue[] {
    const issues: Issue[] = [];
    for (const s of ctx.skipped ?? []) {
      if (s.problem === 'not-utf8') {
        issues.push({
          rule: 'invalid-config',
          severity: 'error',
          file: s.path,
          message: 'This file is saved as UTF-16, so Claude Code reads it as garbage.',
          hint: 'Save it as UTF-8. In PowerShell 5, "echo … > file" and Out-File write UTF-16: use Set-Content -Encoding utf8 instead.',
        });
      } else if (s.problem === 'unreadable') {
        issues.push({
          rule: 'invalid-config',
          severity: 'error',
          file: s.path,
          message: `setupscore could not read this file (${s.detail}), so it was not checked. Claude Code may not be able to read it either.`,
          hint: 'Check the file permissions (for example chmod 644), and that the disk is healthy.',
        });
      }
    }
    for (const dir of ctx.unreadableDirs ?? []) {
      if (!isClaudeFolder(dir)) continue;
      issues.push({
        rule: 'invalid-config',
        severity: 'error',
        file: dir,
        message: 'setupscore could not open this folder, so the rules, skills and settings in it were not checked.',
        hint: 'Check the folder permissions (for example chmod 755). Claude Code cannot load what it cannot read either.',
      });
    }
    for (const f of ctx.files) {
      if (f.kind === 'mcp' || f.kind === 'settings' || f.kind === 'settings-local') {
        const r = parseJson(f);
        if (r.error === undefined) continue;
        issues.push({
          rule: 'invalid-config',
          severity: 'error',
          file: f.path,
          line: r.position !== undefined ? lineAt(f.text, r.position) : undefined,
          message: `Not valid JSON: ${r.error}.`,
          hint: 'JSON allows no comments and no trailing commas.',
        });
      } else if (f.frontmatter?.error) {
        issues.push({
          rule: 'invalid-config',
          severity: 'error',
          file: f.path,
          line: 1,
          message: `The frontmatter is not valid YAML: ${f.frontmatter.error}`,
          hint: 'Quote values that contain a colon, for example  description: "Use when: …"',
        });
      }
    }
    return issues;
  },
};
