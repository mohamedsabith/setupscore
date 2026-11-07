import { statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { gitIgnored, gitModes } from '../core/git.js';
import { closest } from '../core/suggest.js';
import type { Context, Issue, Rule, SetupFile } from '../core/types.js';
import { SKIP_DIRS } from '../core/walk.js';
import { clip, isObject, lineOf, parseJson, quote } from './util.js';

// Everything here follows the hooks reference, code.claude.com/docs/en/hooks (Claude Code 2.1.319,
// November 2026). Only configurations the docs say cannot work are reported: a broken hook fails
// quietly, so Claude Code shows at most a one-line "hook error" and carries on.

/** The 33 documented hook events. A name that is not here and not close to one is left alone: it may be newer. */
const EVENTS = [
  'SessionStart',
  'Setup',
  'InstructionsLoaded',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'MessageDisplay',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'PermissionDenied',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'Stop',
  'StopFailure',
  'TeammateIdle',
  'ConfigChange',
  'CwdChanged',
  'DirectoryAdded',
  'FileChanged',
  'WorktreeCreate',
  'WorktreeRemove',
  'PreCompact',
  'PostCompact',
  'PreModelSwitch',
  'PostModelSwitch',
  'SessionEnd',
  'Elicitation',
  'ElicitationResult',
];
/** Events whose matcher is a tool name, and the only events where `if` is evaluated. */
const TOOL_EVENTS = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
]);
/** Events without matcher support: a matcher there is silently ignored. */
const NO_MATCHER = new Set([
  'CwdChanged',
  'UserPromptSubmit',
  'PostToolBatch',
  'Stop',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'WorktreeCreate',
  'WorktreeRemove',
  'MessageDisplay',
]);
/** Events that use the narrower exact-match characters (letters, digits, _ and | only). */
const NARROW = new Set(['FileChanged', 'StopFailure']);
const TYPES = ['command', 'http', 'mcp_tool', 'prompt', 'agent'];
/** The field each handler type cannot run without. */
const REQUIRED: Record<string, string[]> = {
  command: ['command'],
  http: ['url'],
  mcp_tool: ['server', 'tool'],
  prompt: ['prompt'],
  agent: ['prompt'],
};
/** Built-in tool names (code.claude.com/docs/en/tools-reference). Matchers are case-sensitive. */
const TOOLS = [
  'Agent',
  'AskUserQuestion',
  'Bash',
  'Edit',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'LSP',
  'Monitor',
  'NotebookEdit',
  'PowerShell',
  'Read',
  'Skill',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
];
/** Programs that run the script given as their first argument. Any other program (tee, echo, cat) may name an output file. */
const INTERPRETERS = new Set([
  'python',
  'python3',
  'node',
  'bun',
  'deno',
  'ruby',
  'perl',
  'php',
  'bash',
  'sh',
  'zsh',
  'tsx',
  'ts-node',
]);
/** Interpreters measured to exit with code 2, which Claude Code treats as "block", when the script is missing. */
const EXIT_2_WHEN_MISSING = new Set(['python', 'python3', 'sh']);

type Add = (issue: Omit<Issue, 'rule' | 'severity' | 'file'>) => void;

/** "Bash|Edit" -> exact list; "^Notebook" -> regex; "", "*" -> everything. */
function classify(
  matcher: string,
  event: string,
): { kind: 'all' } | { kind: 'exact'; items: string[] } | { kind: 'regex' } {
  if (matcher === '' || matcher === '*') return { kind: 'all' };
  if (NARROW.has(event)) {
    return /^[A-Za-z0-9_|]+$/.test(matcher) ? { kind: 'exact', items: split(matcher, /\|/) } : { kind: 'regex' };
  }
  return /^[A-Za-z0-9_\- ,|]+$/.test(matcher) ? { kind: 'exact', items: split(matcher, /[|,]/) } : { kind: 'regex' };
}
const split = (s: string, sep: RegExp) =>
  s
    .split(sep)
    .map((x) => x.trim())
    .filter(Boolean);

/** A script under ${CLAUDE_PROJECT_DIR} that a hook runs. */
interface Script {
  /** The path after the placeholder, as written: "/.claude/hooks/check.sh". */
  path: string;
  /** True when the script is the program itself, not an argument to an interpreter. */
  direct: boolean;
  /** The program before the script, such as "python3", when there is one. */
  interpreter?: string;
}

// "$CLAUDE_PROJECT_DIR", "${CLAUDE_PROJECT_DIR}", optionally in double quotes, then a path.
// Not global: every search makes its own copy, so no search can leave state behind for the next one.
const PLACEHOLDER = /"?\$(?:\{CLAUDE_PROJECT_DIR\}|CLAUDE_PROJECT_DIR(?![\w]))"?(\/[^\s"'`;|&<>()$*?{}[\]\\]*)/;
/** Characters that mean the path goes on with something we cannot resolve offline. */
const UNRESOLVED = /^["']?[$*?{[`\\]/;

/** Longer commands are inline programs, not a script call: their scripts are not checked. */
const MAX_COMMAND = 4000;

/** The scripts a command hook runs through ${CLAUDE_PROJECT_DIR}. Anything we cannot resolve is left out. */
function scriptsOf(h: Record<string, unknown>): Script[] {
  const command = typeof h.command === 'string' ? h.command : '';
  if (command.length > MAX_COMMAND) return [];
  const out: Script[] = [];
  if (Array.isArray(h.args)) {
    // Exec form: `command` is the program, each `args` element one argument.
    const whole = (s: string) => {
      const m = PLACEHOLDER.exec(s);
      return m && m.index === 0 && m[0].length === s.length ? m[1]! : null;
    };
    const direct = whole(command);
    if (direct) out.push({ path: direct, direct: true });
    else {
      const program = command
        .split(/[\\/]/)
        .pop()!
        .replace(/\.exe$/i, '');
      const first = h.args[0];
      // Only the script an interpreter runs: other arguments may be output files.
      if (INTERPRETERS.has(program) && typeof first === 'string' && whole(first)) {
        out.push({ path: whole(first)!, direct: false, interpreter: program });
      }
    }
    return out;
  }
  // Shell form: find each placeholder path; the word before it says how it is run.
  for (const m of command.matchAll(new RegExp(PLACEHOLDER.source, 'g'))) {
    const after = command.slice(m.index + m[0].length);
    if (UNRESOLVED.test(after)) continue;
    // Only the simple command the path is in: "a && b" runs b on its own.
    const before = command
      .slice(0, m.index)
      .split(/&&|\|\||[;|&]/)
      .pop()!;
    // Leading VAR=value assignments do not change which program runs.
    const words = before
      .replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (words.length === 0) out.push({ path: m[1]!, direct: true });
    else if (words.length === 1 && INTERPRETERS.has(words[0]!))
      out.push({ path: m[1]!, direct: false, interpreter: words[0] });
  }
  return out;
}

export const brokenHook: Rule = {
  id: 'broken-hook',
  severity: 'warning',
  summary:
    'A hook in .claude/settings.json can never run as written: a wrong shape, a misspelled event, a matcher that matches nothing, or a missing script.',
  why: 'A broken hook fails quietly. Claude Code shows at most a one-line "hook error" and carries on, so a check you rely on (formatting, tests, blocking dangerous commands) silently does nothing. A missing Python script can instead block every tool call.',
  check(ctx: Context): Issue[] {
    const issues: Issue[] = [];
    const scripts: { f: SetupFile; rel: string; script: Script; line?: number; event: string }[] = [];

    for (const f of ctx.files.filter((f) => f.kind === 'settings' || f.kind === 'settings-local')) {
      const { value } = parseJson(f);
      if (!isObject(value) || !('hooks' in value)) continue; // invalid JSON is reported by invalid-config
      const add: Add = (i) => issues.push({ rule: 'broken-hook', severity: 'warning', file: f.path, ...i });
      const hooks = value.hooks;
      const hooksLine = lineOf(f, '"hooks"');
      if (!isObject(hooks)) {
        add({
          line: hooksLine,
          message:
            '"hooks" must be an object of events, such as { "PreToolUse": [ ... ] }, so none of these hooks run.',
          hint: 'See the example at code.claude.com/docs/en/hooks#configuration.',
        });
        continue;
      }
      const base = f.path.slice(0, Math.max(0, f.path.indexOf('.claude/') - 1));
      for (const [event, groups] of Object.entries(hooks)) {
        const line = lineOf(f, JSON.stringify(event)) ?? hooksLine;
        if (!EVENTS.includes(event)) {
          const sameLetters = EVENTS.find((e) => e.toLowerCase() === event.toLowerCase());
          const near = sameLetters ?? closest(event, EVENTS, 0.8);
          if (near) {
            add({
              line,
              message:
                `"${event}" is not a hook event, so Claude Code skips these hooks. ${sameLetters ? 'Event names are case-sensitive.' : ''}`.trim(),
              hint: `Did you mean "${near}"?`,
            });
          }
          continue; // a name far from every known event may be newer than this list
        }
        if (!Array.isArray(groups)) {
          add({
            line,
            message: `${event} must be a list of matcher groups ([ { "matcher": ..., "hooks": [ ... ] } ]), so its hooks don't run.`,
          });
          continue;
        }
        for (const group of groups) {
          if (!isObject(group)) {
            add({ line, message: `${event} has an entry that is not an object, so it doesn't run.` });
            continue;
          }
          if (!Array.isArray(group.hooks)) {
            const flat = 'type' in group || 'command' in group;
            add({
              line:
                flat && typeof group.command === 'string' ? (lineOf(f, JSON.stringify(group.command)) ?? line) : line,
              message: flat
                ? `A ${event} hook is written directly in the list, without the "hooks" wrapper, so it doesn't run.`
                : `A ${event} matcher group has no "hooks" list, so it runs nothing.`,
              hint: flat
                ? 'Wrap it: { "matcher": "...", "hooks": [ { "type": "command", "command": "..." } ] }.'
                : 'Add "hooks": [ { "type": "command", "command": "..." } ].',
            });
            continue;
          }
          checkMatcher(group.matcher, event, line, add);
          for (const h of group.hooks) checkHandler(f, h, event, line, add, base, scripts);
        }
      }
    }
    checkScripts(ctx, scripts, issues);
    return issues;
  },
};

function checkMatcher(matcher: unknown, event: string, line: number | undefined, add: Add): void {
  if (matcher === undefined || matcher === null) return;
  if (typeof matcher !== 'string') {
    add({
      line,
      message: `The ${event} "matcher" must be one string, not ${Array.isArray(matcher) ? 'a list' : typeof matcher}, so this hook never runs.${
        TOOL_EVENTS.has(event) && (event === 'PreToolUse' || event === 'PermissionRequest')
          ? ' On this event it can also stop every other hook in this file from loading.'
          : ''
      }`,
      hint: 'Join the names with "|", for example "Edit|Write".',
    });
    return;
  }
  const kind = classify(matcher, event);
  if (NO_MATCHER.has(event) && kind.kind !== 'all') {
    add({
      line,
      message: `${event} has no matcher, so ${quote(matcher, 40)} is ignored and this hook runs every time.`,
      hint: 'Remove the matcher, or filter inside the hook.',
    });
    return;
  }
  if (kind.kind === 'regex') {
    try {
      new RegExp(matcher);
    } catch {
      add({
        line,
        message: `The ${event} matcher ${quote(matcher, 50)} is not a valid regular expression, so Claude Code can't use it to pick tools.`,
      });
    }
    return;
  }
  if (kind.kind !== 'exact' || !TOOL_EVENTS.has(event)) return;
  for (const item of kind.items) {
    if (/^mcp__/.test(item) && !item.slice(5).includes('__')) {
      add({
        line,
        message: `The ${event} matcher "${item}" matches no tool: MCP tools are named mcp__<server>__<tool>.`,
        hint: `Use "${item}__.*" for every tool of that server.`,
      });
      continue;
    }
    const tool = TOOLS.find((t) => t !== item && t.toLowerCase() === item.toLowerCase());
    if (tool) {
      add({
        line,
        message: `The ${event} matcher "${item}" matches no tool: tool names are case-sensitive.`,
        hint: `Write "${tool}".`,
      });
    }
  }
}

function checkHandler(
  f: SetupFile,
  h: unknown,
  event: string,
  groupLine: number | undefined,
  add: Add,
  base: string,
  scripts: { f: SetupFile; rel: string; script: Script; line?: number; event: string }[],
): void {
  if (!isObject(h)) {
    add({ line: groupLine, message: `A ${event} hook is not an object, so it doesn't run.` });
    return;
  }
  const main = [h.command, h.url, h.prompt, h.tool].find((v): v is string => typeof v === 'string' && v !== '');
  const line = (main !== undefined ? lineOf(f, JSON.stringify(main)) : undefined) ?? groupLine;
  const what = main !== undefined ? ` ${quote(main, 50)}` : '';
  if (h.type === undefined) {
    add({
      line,
      message: `The ${event} hook${what} has no "type", which every hook needs.`,
      hint: 'Add "type": "command" (or http, mcp_tool, prompt, agent).',
    });
    return;
  }
  if (typeof h.type !== 'string' || !TYPES.includes(h.type)) {
    const t = String(h.type);
    const near = TYPES.find((x) => x === t.toLowerCase()) ?? closest(t, TYPES, 0.6);
    if (near) {
      add({
        line,
        message: `The ${event} hook${what} has "type": ${quote(t, 30)}, which is not a hook type. The types are command, http, mcp_tool, prompt and agent.`,
        hint: `Did you mean "${near}"?`,
      });
    }
    return;
  }
  for (const field of REQUIRED[h.type]!) {
    if (typeof h[field] !== 'string' || h[field].trim() === '') {
      add({ line, message: `The ${event} ${h.type} hook has no "${field}", so it can't run.` });
    }
  }
  if ('timeout' in h && !(typeof h.timeout === 'number' && Number.isFinite(h.timeout) && h.timeout > 0)) {
    add({
      line,
      message: `The ${event} hook${what} has "timeout": ${clip(JSON.stringify(h.timeout) ?? String(h.timeout), 20)}. It must be a number of seconds above 0.`,
      hint: 'For example "timeout": 30.',
    });
  }
  if (typeof h.if === 'string' && h.if.trim() !== '' && !TOOL_EVENTS.has(event)) {
    add({
      line,
      message: `The ${event} hook${what} has "if", which Claude Code only checks on tool events, so this hook never runs.`,
      hint: 'Remove "if", or move the hook to PreToolUse or PostToolUse.',
    });
  }
  if (h.type === 'command') {
    for (const script of scriptsOf(h)) {
      const rel = posix.normalize((base ? `${base}/` : '') + script.path.slice(1)).replace(/\/$/, '');
      if (rel.startsWith('..') || rel === '.' || SKIP_DIRS.has(rel.split('/')[0]!)) continue;
      scripts.push({ f, rel, script, line, event });
    }
  }
}

/** Scripts under ${CLAUDE_PROJECT_DIR}: missing, or run directly without the executable bit. */
function checkScripts(
  ctx: Context,
  scripts: { f: SetupFile; rel: string; script: Script; line?: number; event: string }[],
  issues: Issue[],
): void {
  if (scripts.length === 0) return;
  const missing = scripts.filter((s) => !ctx.existsRel(s.rel) && !ctx.isDir(s.rel));
  // A gitignored script may be generated on each machine (by an install step), so we can't tell.
  const ignored = gitIgnored(
    ctx.root,
    missing.map((s) => s.rel),
  );
  const reported = new Set<string>();
  for (const s of missing) {
    if (ignored.has(s.rel) || reported.has(`${s.f.path}\0${s.rel}`)) continue;
    reported.add(`${s.f.path}\0${s.rel}`);
    const blocks = s.script.interpreter && EXIT_2_WHEN_MISSING.has(s.script.interpreter);
    issues.push({
      rule: 'broken-hook',
      severity: 'warning',
      file: s.f.path,
      line: s.line,
      message: blocks
        ? `The ${s.event} hook runs ${s.rel} with ${s.script.interpreter}, but the file doesn't exist. ${s.script.interpreter} then exits with code 2, which Claude Code treats as "block".`
        : `The ${s.event} hook runs ${s.rel}, but the file doesn't exist, so the hook never runs.`,
      hint: 'Fix the path, or add the script to the repository.',
    });
  }
  // Executable bit: only for a script that is the program itself, on systems that have the bit.
  if (process.platform === 'win32') return;
  const direct = scripts.filter((s) => s.script.direct && ctx.existsRel(s.rel) && !/\.(ps1|cmd|bat|exe)$/i.test(s.rel));
  if (direct.length === 0) return;
  const modes = gitModes(
    ctx.root,
    direct.map((s) => s.rel),
  );
  for (const s of direct) {
    const key = `${s.f.path}\0${s.rel}`;
    if (reported.has(key)) continue;
    const mode = modes?.get(s.rel);
    let notExecutable: 'git' | 'disk' | null = null;
    if (mode !== undefined) notExecutable = mode === '100644' ? 'git' : null;
    else {
      try {
        notExecutable = (statSync(join(ctx.root, s.rel)).mode & 0o111) === 0 ? 'disk' : null;
      } catch {
        notExecutable = null;
      }
    }
    if (!notExecutable) continue;
    reported.add(key);
    issues.push({
      rule: 'broken-hook',
      severity: 'warning',
      file: s.f.path,
      line: s.line,
      message:
        notExecutable === 'git'
          ? `The ${s.event} hook runs ${s.rel} directly, but git stores it as not executable, so it fails with "Permission denied" on every clone.`
          : `The ${s.event} hook runs ${s.rel} directly, but the file is not executable, so it fails with "Permission denied".`,
      hint: notExecutable === 'git' ? `Run: git update-index --chmod=+x ${s.rel}` : `Run: chmod +x ${s.rel}`,
    });
  }
}
