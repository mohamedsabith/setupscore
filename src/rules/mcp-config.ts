import type { Context, Issue, Rule, SetupFile } from '../core/types.js';
import { clip, isObject, lineOf, parseJson } from './util.js';

const BARE_VAR = /(?<![$\\])\$([A-Z_]\w*)(:[A-Z_]\w*)?/i;
/** cmd.exe style %VAR%: only cmd.exe expands it, never Claude Code. */
const PERCENT_VAR = /%([A-Z_]\w*)%/i;
const LOCAL_HOST = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:\/|$)/i;

/** True when a package spec names a version: pkg@1.2.3, @scope/pkg@1.2.3, pkg==1.2.3 */
const pinned = (spec: string): boolean => {
  if (spec.includes('==')) return true;
  const at = spec.lastIndexOf('@');
  if (at <= 0) return false;
  const version = spec.slice(at + 1);
  return version !== '' && version !== 'latest' && version !== 'next';
};

/** Every string value in a server's command, args, env, url and headers, with where it came from. */
function strings(server: Record<string, unknown>): { where: string; value: string }[] {
  const out: { where: string; value: string }[] = [];
  if (typeof server['command'] === 'string') out.push({ where: 'command', value: server['command'] });
  if (typeof server['url'] === 'string') out.push({ where: 'url', value: server['url'] });
  if (Array.isArray(server['args']))
    server['args'].forEach((a) => typeof a === 'string' && out.push({ where: 'args', value: a }));
  for (const key of ['env', 'headers'] as const) {
    const block = server[key];
    if (isObject(block))
      for (const [k, v] of Object.entries(block))
        if (typeof v === 'string') out.push({ where: `${key}.${k}`, value: v });
  }
  return out;
}

export const mcpConfig: Rule = {
  id: 'mcp-config',
  severity: 'warning',
  summary: 'An MCP server in .mcp.json is unpinned, uses $VAR or %VAR% that never expands, or talks plain HTTP.',
  why: 'An unpinned npx or uvx server runs whatever version is newest each time, so a bad release runs on your machine. "$VAR" and "%VAR%" are passed through as literal text (only "${VAR}" is expanded), and plain HTTP sends data unencrypted.',
  check(ctx: Context): Issue[] {
    const issues: Issue[] = [];
    for (const f of ctx.files.filter((f) => f.kind === 'mcp')) {
      const { value } = parseJson(f);
      if (value === undefined) continue; // invalid-config reports it
      const add = (message: string, hint: string, line?: number) =>
        issues.push({ rule: 'mcp-config', severity: 'warning', file: f.path, line, message, hint });

      if (!isObject(value) || !isObject(value['mcpServers'])) {
        add(
          'No "mcpServers" object, so Claude Code finds no servers here.',
          'Use { "mcpServers": { "name": { "command": "…", "args": [] } } }.',
          1,
        );
        continue;
      }
      for (const [name, server] of Object.entries(value['mcpServers'])) {
        if (!isObject(server)) continue;
        checkServer(f, name, server, add);
      }
    }
    return issues;
  },
};

/** "C:\\Program Files\\nodejs\\npx.cmd" -> "npx" */
const commandName = (c: string): string =>
  c
    .trim()
    .replace(/^.*[/\\]/, '')
    .replace(/\.(?:cmd|exe|bat|ps1)$/i, '')
    .toLowerCase();

function checkServer(
  f: SetupFile,
  name: string,
  server: Record<string, unknown>,
  add: (message: string, hint: string, line?: number) => void,
): void {
  const line = lineOf(f, JSON.stringify(name));
  const label = `Server "${clip(name, 40)}"`;
  const args = Array.isArray(server['args']) ? server['args'].filter((a): a is string => typeof a === 'string') : [];
  let command = typeof server['command'] === 'string' ? commandName(server['command']) : '';
  let rest = args;
  // Windows style: "command": "cmd", "args": ["/c", "npx", ...], also with /d /s before /c.
  const viaCmd = command === 'cmd';
  let script: string | undefined;
  if (viaCmd) {
    const c = rest.findIndex((a) => /^\/[ck]$/i.test(a));
    if (c >= 0 && rest.slice(0, c).every((a) => a.startsWith('/'))) {
      rest = rest.slice(c + 1);
      if (/\s/.test(rest[0] ?? '')) script = rest.join(' ');
      else {
        command = commandName(rest[0] ?? '');
        rest = rest.slice(1);
      }
    }
  }
  // A shell running a command string: "bash", ["-c", "npx pkg --flag $TOKEN"]. The shell expands $VAR there.
  const viaShell = /^(?:bash|sh|zsh|dash|ksh|fish|powershell|pwsh)$/.test(command);
  if (viaShell) {
    const c = rest.findIndex((a) => /^-(?:[a-z]*c|command)$/i.test(a));
    if (c >= 0) script = rest.slice(c + 1).join(' ');
  }
  if (script !== undefined) {
    const words = script.split(/[\s;&|()"'`]+/).filter(Boolean);
    const at = words.findIndex((w) => ['npx', 'pnpx', 'bunx', 'uvx'].includes(commandName(w)));
    if (at >= 0) {
      command = commandName(words[at]!);
      rest = words.slice(at + 1);
    } else command = '';
  }
  if (command === 'npx' || command === 'pnpx' || command === 'bunx' || command === 'uvx') {
    const spec = rest.find((a) => !a.startsWith('-'));
    if (spec && !pinned(spec)) {
      const bare = spec.replace(/(.)@(?:latest|next)$/, '$1');
      const example = command === 'uvx' ? `${bare}==1.2.3` : `${bare}@1.2.3`;
      const what = bare === spec ? 'without a version' : `with "@${spec.slice(bare.length + 1)}"`;
      add(
        `${label} runs "${command} ${clip(spec, 80)}" ${what}, so every start may run new code.`,
        `Pin an exact version, e.g. "${clip(example, 80)}", and update on purpose.`,
        line,
      );
    }
  }
  for (const { where, value } of strings(server)) {
    const at = lineOf(f, value) ?? line;
    // Inside a shell's command string the shell itself expands $VAR, %VAR% (cmd) and $env:VAR.
    if (script !== undefined && (where === 'args' || where === 'command')) continue;
    const m = value.match(BARE_VAR);
    if (m) {
      // PowerShell's $env:TOKEN means the variable TOKEN.
      const v = m[1]!.toLowerCase() === 'env' && m[2] ? m[2].slice(1) : m[1]!;
      const written = m[2] && m[1]!.toLowerCase() === 'env' ? `$${m[1]}${m[2]}` : `$${m[1]}`;
      add(`${label} ${where} uses "${written}", which Claude Code never expands.`, `Write "\${${v}}" instead.`, at);
      continue;
    }
    // cmd.exe expands %VAR% in the arguments it runs, but nothing expands it in env, headers or url.
    const p = value.match(PERCENT_VAR);
    if (p && !(viaCmd && (where === 'args' || where === 'command'))) {
      add(
        `${label} ${where} uses "%${p[1]}%", which Claude Code passes on as literal text: it only expands "\${VAR}".`,
        `Write "\${${p[1]}}" instead.`,
        at,
      );
    }
  }
  if (typeof server['url'] === 'string' && /^http:\/\//i.test(server['url']) && !LOCAL_HOST.test(server['url'])) {
    add(
      `${label} uses plain http://, so requests and tokens travel unencrypted.`,
      'Use https://.',
      lineOf(f, server['url']) ?? line,
    );
  }
}
