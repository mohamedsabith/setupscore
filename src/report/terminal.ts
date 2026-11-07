import pc from 'picocolors';
import type { CheckRun } from '../core/check.js';
import type { Applied } from '../core/fix.js';
import type { FileKind, Issue } from '../core/types.js';
import { RULES } from '../rules/index.js';
import { VERSION } from '../version.js';

const useUnicode = process.platform !== 'win32' || !!process.env.WT_SESSION || process.env.TERM_PROGRAM === 'vscode';
const SYM = useUnicode
  ? { error: '✖', warning: '⚠', ok: '✔', arrow: '→', dot: '·' }
  : { error: 'x', warning: '!', ok: 'v', arrow: '->', dot: '-' };

export interface TerminalOptions {
  quiet?: boolean;
  cost?: boolean;
  fixed?: Applied[];
  /** The command the user typed, used in the "run with --fix" tip. */
  command?: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** File names come from disk and may hold control characters (terminal escape sequences): never print them raw. */
const clean = (text: string): string =>
  // eslint-disable-next-line no-control-regex -- matching control characters is the point: they are replaced
  text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '\uFFFD');

function issueLines(i: Issue, width: number): string[] {
  const pos = i.line !== undefined ? `${i.line}${i.column ? `:${i.column}` : ''}` : '-';
  const sev = i.severity === 'error' ? pc.red('error  ') : pc.yellow('warning');
  const out = [`  ${pc.dim(pos.padEnd(width))}  ${sev}  ${i.message}  ${pc.dim(i.rule)}`];
  if (i.hint) out.push(`  ${' '.repeat(width)}           ${pc.dim(`${SYM.arrow} ${i.hint}`)}`);
  return out;
}

const WHEN: Record<FileKind, string> = {
  'claude-md': 'every session',
  'claude-local-md': 'every session (only on your machine)',
  import: 'imported',
  rule: 'every session',
  skill: 'description only; body when used',
  agent: 'description only; body when used',
  command: 'when you type the command',
  settings: 'config, not sent as text',
  'settings-local': 'config, not sent as text',
  mcp: 'config; tool lists load per server',
};

export function renderTerminal(run: CheckRun, opts: TerminalOptions = {}): string {
  const out: string[] = [];
  out.push(`${pc.bold('setupscore')} ${pc.dim(`v${VERSION} ${SYM.dot} ${run.root}`)}`);
  out.push('');

  // With no setup files there is nothing to show, unless something was found anyway (a .env
  // Claude can read, a file that could not be read): then show it, so the exit code makes sense.
  if (run.files.length === 0 && run.issues.length === 0 && run.ruleErrors.length === 0) {
    out.push(`${pc.yellow(SYM.warning)} No Claude Code setup files found here.`);
    out.push(
      pc.dim(
        '  setupscore looks for CLAUDE.md, CLAUDE.local.md, .claude/ (rules, skills, agents, commands, settings) and .mcp.json.',
      ),
    );
    out.push(pc.dim('  Run it from your project root, or pass the folder:  npx setupscore check path/to/project'));
    return out.join('\n');
  }

  if (opts.fixed?.length) {
    out.push(pc.green(`${SYM.ok} Fixed ${plural(opts.fixed.length, 'problem')}:`));
    for (const a of opts.fixed)
      out.push(
        `  ${clean(a.fix.file)}:${a.fix.line}  ${pc.dim(clean(a.fix.from))} ${SYM.arrow} ${pc.green(clean(a.fix.to))}`,
      );
    out.push('');
  }

  const shown = opts.quiet ? run.issues.filter((i) => i.severity === 'error') : run.issues;
  const byFile = Map.groupBy(shown, (i) => i.file);
  const width = Math.max(4, ...shown.map((i) => `${i.line ?? ''}${i.column ? `:${i.column}` : ''}`.length));
  for (const [file, issues] of byFile) {
    out.push(pc.underline(clean(file)));
    for (const i of issues) out.push(...issueLines(i, width));
    out.push('');
  }

  if (opts.cost) {
    out.push(pc.bold('Context cost') + pc.dim('  (≈ tokens, estimated at 4 characters per token)'));
    const rows = run.files.filter((f) => f.kind !== 'settings' && f.kind !== 'settings-local');
    const nameWidth = Math.min(60, Math.max(...rows.map((f) => f.path.length)));
    for (const f of rows) {
      const when = f.loadsAtStart
        ? pc.cyan(WHEN[f.kind])
        : pc.dim(
            f.kind === 'claude-md' || f.kind === 'claude-local-md'
              ? 'when Claude works in that folder'
              : f.kind === 'rule'
                ? 'when a matching file is read'
                : f.kind === 'import'
                  ? 'with the file that imports it'
                  : WHEN[f.kind],
          );
      out.push(`  ${clean(f.path).padEnd(nameWidth)}  ${String(f.tokens).padStart(7)}  ${when}`);
    }
    out.push(
      `  ${'Sent with every message'.padEnd(nameWidth)}  ${pc.bold(String(run.startupTokens).padStart(7))}  ${pc.dim('start-up files + skill and agent descriptions')}`,
    );
    out.push('');
  }

  for (const e of run.ruleErrors)
    out.push(pc.red(`Rule "${e.rule}" crashed and was skipped: ${e.message}. Please report this.`));
  if (run.truncated)
    out.push(
      pc.yellow(`${SYM.warning} Stopped listing files at 100,000. Add big folders to "ignore" in setupscore.yml.`),
    );

  const files =
    run.files.length === 0 ? 'this folder (no readable setup files)' : plural(run.files.length, 'setup file');
  if (run.issues.length === 0) {
    out.push(pc.green(`${SYM.ok} No problems in ${files}.`) + pc.dim(`  Instruction health 10/10`));
  } else {
    const parts = [
      run.errors ? pc.red(plural(run.errors, 'error')) : null,
      run.warnings ? pc.yellow(plural(run.warnings, 'warning')) : null,
    ].filter(Boolean);
    const icon = run.errors ? pc.red(SYM.error) : pc.yellow(SYM.warning);
    const hidden = opts.quiet && run.warnings ? pc.dim(` (${plural(run.warnings, 'warning')} hidden by --quiet)`) : '';
    out.push(`${icon} ${parts.join(', ')} in ${files}${hidden}`);
    const health = run.health >= 8 ? pc.green : run.health >= 5 ? pc.yellow : pc.red;
    out.push(`  Instruction health ${health(pc.bold(`${run.health}/10`))}`);
    if (run.fixable && !opts.fixed?.length) {
      out.push(
        `  ${plural(run.fixable, 'problem')} can be fixed automatically: ${pc.cyan(`${opts.command ?? 'npx setupscore check'} --fix`)}`,
      );
    }
    out.push(
      pc.dim(`  Turn a rule off in setupscore.yml, or add <!-- setupscore-disable-next-line rule-id --> above a line.`),
    );
  }
  if (!opts.cost)
    out.push(
      pc.dim(`  ${run.startupTokens.toLocaleString('en-US')} tokens load into every session. See where with --cost.`),
    );
  return out.join('\n');
}

export function renderRules(): string {
  const out = [pc.bold('setupscore rules'), ''];
  const width = Math.max(...RULES.map((r) => r.id.length));
  for (const r of RULES) {
    const sev = r.severity === 'error' ? pc.red('error  ') : pc.yellow('warning');
    out.push(`  ${pc.bold(r.id.padEnd(width))}  ${sev}  ${r.summary}`);
    out.push(`  ${' '.repeat(width)}           ${pc.dim(r.why)}`);
    out.push('');
  }
  out.push(pc.dim('Change a level or turn a rule off in setupscore.yml:'));
  out.push(pc.dim('  version: 1\n  rules:\n    vague-rule: off\n    too-long: error'));
  return out.join('\n');
}
