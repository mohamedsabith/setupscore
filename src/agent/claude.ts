import { lookup } from 'node:dns/promises';
import { existsSync, statSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runProgram } from '../sandbox/runtime.js';
import { EnvironmentError } from '../sandbox/types.js';
import { shellQuote } from '../tasks/pm.js';
import type { AgentMetrics } from './transcript.js';

/** Where Claude Code is usually installed, tried when `claude` is not on PATH. */
function commonLocations(): string[] {
  const home = homedir();
  return process.platform === 'win32'
    ? [
        ...(process.env.APPDATA ? [join(process.env.APPDATA, 'npm', 'claude.cmd')] : []),
        join(home, '.local', 'bin', 'claude.exe'),
      ]
    : [
        join(home, '.claude', 'local', 'claude'),
        join(home, '.local', 'bin', 'claude'),
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
      ];
}

export interface ClaudeInfo {
  /** The command to start Claude Code, ready for the shell (a path with spaces is quoted). */
  bin: string;
  version: string;
}

/** How long `claude --version` may take. */
const VERSION_TIMEOUT_MS = 20_000;
const INSTALL_HINT =
  'Install it: npm install -g @anthropic-ai/claude-code   (or see https://docs.claude.com/en/docs/claude-code)';

/** Remove colour codes, other escape sequences and unprintable bytes from a program's output. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (titles, links)
    .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '') // CSI (colours, cursor moves)
    .replace(/\x1b[\x40-\x5f]/g, '')
    .replace(/[\x00-\x08\v\f\x0e-\x1f\x7f-\x9f\ufffd]/g, '');
}

/** A path to a file: quoted for the shell when it has spaces or other special characters. */
const quoteIfNeeded = (p: string): string => {
  if (!/[^\w@%+=:,./\\-]/.test(p)) return p;
  // Windows paths cannot contain double quotes, and cmd.exe keeps backslashes as they are.
  return process.platform === 'win32' ? `"${p}"` : shellQuote(p);
};

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

const seconds = (ms: number) => `${+(ms / 1000).toFixed(1)} second${ms === 1000 ? '' : 's'}`;

type Probe = { ok: true; version: string } | { ok: false; notFound: boolean; problem: string };

/** Run `<bin> --version`: the version, or what went wrong in words. */
async function probeVersion(bin: string, label: string, timeoutMs: number): Promise<Probe> {
  // `bin` may be a whole command such as "node fake-claude.mjs", so it goes through the shell.
  const r = await runProgram(`${bin} --version`, 'shell', { timeoutMs });
  const out = stripAnsi(r.stdout);
  const err = stripAnsi(r.stderr);
  const said = (err || out)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^at\s/.test(l) && !/^Node\.js v\d/.test(l));
  const reason = (
    said.find((l) => /error|cannot|not found|denied|failed|requires|needs/i.test(l)) ??
    said[0] ??
    ''
  ).slice(0, 200);
  if (r.timedOut)
    return { ok: false, notFound: false, problem: `${label} did not answer "--version" within ${seconds(timeoutMs)}` };
  if (r.error)
    return {
      ok: false,
      notFound: r.error.code === 'ENOENT',
      problem: `${label} could not be started (${r.error.message})`,
    };
  const notFound =
    r.code === 127 ||
    r.code === 9009 ||
    /command not found|: not found|is not recognized as an internal|no such file or directory/i.test(err);
  if (notFound) return { ok: false, notFound: true, problem: `${label} was not found${reason ? ` (${reason})` : ''}` };
  if (r.code !== 0)
    return {
      ok: false,
      notFound: false,
      problem: `${label} failed with exit code ${r.code}${reason ? `: ${reason}` : ' and printed nothing'}`,
    };
  const version =
    out
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean)
      ?.slice(0, 100) ?? '';
  if (!version) {
    // Something was printed, but nothing readable: it started, so use it.
    if (r.stdout.trim()) return { ok: true, version: 'unknown version' };
    return { ok: false, notFound: false, problem: `${label} printed no version for "--version"` };
  }
  return { ok: true, version };
}

/**
 * Find Claude Code and its version: the given command, then PATH, then common install folders.
 * Returns null when Claude Code is not installed anywhere. When it is there but does not work
 * (`--version` hangs, fails or prints nothing), or the given path does not exist, it throws an
 * EnvironmentError that says what happened.
 */
export async function findClaude(preferred?: string, options: { timeoutMs?: number } = {}): Promise<ClaudeInfo | null> {
  const timeoutMs = options.timeoutMs ?? VERSION_TIMEOUT_MS;
  if (preferred !== undefined) {
    const given = preferred.trim();
    if (!given)
      throw new EnvironmentError('The path given for Claude Code is empty.', [
        'Pass the path to the claude program: --claude-bin /path/to/claude',
      ]);
    let bin = given;
    if (isFile(given)) {
      bin = quoteIfNeeded(given); // "C:\Program Files\..." or "/Users/Jane Doe/..."
    } else if (!/\s/.test(given) && /[\\/]/.test(given) && !existsSync(given)) {
      throw new EnvironmentError(`Claude Code was not found at ${given}: that path does not exist.`, [
        'Check the path given with --claude-bin (or agent.bin in setupscore.yml).',
        INSTALL_HINT,
      ]);
    }
    const p = await probeVersion(bin, `Claude Code (${given})`, timeoutMs);
    if (p.ok) return { bin, version: p.version };
    throw new EnvironmentError(
      `${p.problem}.`,
      p.notFound
        ? ['Check the path given with --claude-bin (or agent.bin in setupscore.yml).', INSTALL_HINT]
        : [
            `Run it yourself to see what is wrong: ${bin} --version`,
            `Or install it again: npm install -g @anthropic-ai/claude-code`,
          ],
    );
  }

  const candidates: [bin: string, label: string][] = [['claude', 'Claude Code ("claude" on PATH)']];
  for (const p of commonLocations()) if (isFile(p)) candidates.push([quoteIfNeeded(p), `Claude Code (${p})`]);
  let firstProblem: { problem: string; bin: string } | null = null;
  for (const [bin, label] of candidates) {
    const p = await probeVersion(bin, label, timeoutMs);
    if (p.ok) return { bin, version: p.version };
    if (!p.notFound && !firstProblem) firstProblem = { problem: p.problem, bin };
  }
  if (!firstProblem) return null;
  throw new EnvironmentError(`${firstProblem.problem}.`, [
    `Run it yourself to see what is wrong: ${firstProblem.bin} --version`,
    'Or install it again: npm install -g @anthropic-ai/claude-code',
    'If a working copy is installed somewhere else, pass its path: --claude-bin /path/to/claude',
  ]);
}

/**
 * Environment variables Claude Code needs inside the sandbox: only authentication and the
 * API endpoint. Everything else stays filtered out (see sandbox/env.ts).
 */
const AUTH_VARS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
];

export interface AuthStatus {
  ok: boolean;
  /** How Claude Code will sign in, for messages. Never the secret itself. */
  via: string;
  fix?: string;
}

export function authStatus(env: NodeJS.ProcessEnv = process.env): AuthStatus {
  if (env.ANTHROPIC_API_KEY) return { ok: true, via: 'ANTHROPIC_API_KEY' };
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { ok: true, via: 'CLAUDE_CODE_OAUTH_TOKEN (your Claude subscription)' };
  if (env.ANTHROPIC_AUTH_TOKEN) return { ok: true, via: 'ANTHROPIC_AUTH_TOKEN' };
  if (env.CLAUDE_CODE_USE_BEDROCK && (env.AWS_ACCESS_KEY_ID || env.AWS_BEARER_TOKEN_BEDROCK) && env.AWS_REGION)
    return { ok: true, via: 'Amazon Bedrock' };
  return {
    ok: false,
    via: 'none',
    fix: [
      'setupscore runs Claude Code in a clean sandbox, so it cannot use your normal Claude login.',
      'Give it a key or token in the environment, either:',
      '  export ANTHROPIC_API_KEY=sk-ant-...        (pay per use, from console.anthropic.com)',
      '  export CLAUDE_CODE_OAUTH_TOKEN=...         (your Claude subscription: run "claude setup-token" to get one)',
    ].join('\n'),
  };
}

/** Network destinations the agent may reach: the Claude API (or your gateway) only. */
export function agentDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  const out = new Set(['api.anthropic.com']);
  if (env.ANTHROPIC_BASE_URL) {
    try {
      const host = new URL(env.ANTHROPIC_BASE_URL.trim()).hostname;
      // Only names the sandbox's allow list accepts (checked before the run by endpointProblem).
      if (isAllowableHost(host)) out.add(host);
    } catch {
      // ignored: endpointProblem reports a bad URL before the run
    }
  }
  if (env.CLAUDE_CODE_USE_BEDROCK && env.AWS_REGION && /^[a-z0-9-]+$/.test(env.AWS_REGION))
    out.add(`bedrock-runtime.${env.AWS_REGION}.amazonaws.com`);
  return [...out];
}

/** A host the sandbox's network allow list accepts: a dotted name, localhost, or an IP address. */
export function isAllowableHost(host: string): boolean {
  if (!host) return false;
  if (/^\[[0-9a-f:.]+\]$/i.test(host)) return isIP(host.slice(1, -1)) === 6;
  if (isIP(host) === 4 || host === 'localhost') return true;
  return /^[\w-]+(?:\.[\w-]+)+$/.test(host) && !host.split('.').some((l) => !l || l.startsWith('-') || l.endsWith('-'));
}

/** Address ranges the OS sandbox never routes to (they skip its proxy, and the sandbox has no other network). */
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');
const LOCAL_ONLY = new BlockList();
LOCAL_ONLY.addSubnet('0.0.0.0', 8, 'ipv4');
LOCAL_ONLY.addSubnet('169.254.0.0', 16, 'ipv4');
LOCAL_ONLY.addAddress('::', 'ipv6');
LOCAL_ONLY.addSubnet('fe80::', 10, 'ipv6');
const PRIVATE = new BlockList();
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');

function addressKind(ip: string): 'loopback' | 'local' | 'private' | null {
  const family = isIP(ip) === 6 ? 'ipv6' : 'ipv4';
  const mapped = family === 'ipv6' ? /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1] : undefined;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- needed: without it fam is a plain string and tsc fails
  const [addr, fam] = mapped ? [mapped, 'ipv4' as const] : [ip, family as 'ipv4' | 'ipv6'];
  if (LOOPBACK.check(addr, fam)) return 'loopback';
  if (LOCAL_ONLY.check(addr, fam)) return 'local';
  if (PRIVATE.check(addr, fam)) return 'private';
  return null;
}

export interface EndpointProblem {
  message: string;
  fixes: string[];
}

/**
 * A problem with ANTHROPIC_BASE_URL that would make every session fail, found before anything is
 * spent: not a URL at all, or (with the OS sandbox) a gateway Claude Code cannot reach from inside
 * it. The sandbox has no network except its proxy, and the proxy is skipped for localhost and
 * private addresses (and refuses names that resolve to loopback or link-local addresses).
 */
export async function endpointProblem(
  o: {
    sandboxed: boolean;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    resolve?: (host: string) => Promise<string[]>;
  } = { sandboxed: true },
): Promise<EndpointProblem | null> {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const raw = env.ANTHROPIC_BASE_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
    if (!/^https?:$/.test(url.protocol) || !url.hostname) throw new Error('not http(s)');
  } catch {
    return {
      message: `ANTHROPIC_BASE_URL is not a usable URL: "${raw.slice(0, 80)}".`,
      fixes: [
        'Set it to the full address of your gateway, for example https://gateway.example.com, or unset it to use the Claude API directly.',
      ],
    };
  }
  if (!o.sandboxed) return null;
  const host = url.hostname;
  const bare = host.replace(/^\[|\]$/g, '');
  const fixes = (example: string) => [
    `Use a gateway address the sandbox can reach: a full domain name that resolves to a non-local address (for example ${example}).`,
    'Or, on a machine you trust (such as a CI runner), run without the sandbox: --sandbox none --yes',
  ];
  const where = `ANTHROPIC_BASE_URL (${url.host})`;
  // The loopback interface is reachable from the macOS sandbox (local binding is allowed there), not on Linux.
  const blocked = (kind: ReturnType<typeof addressKind>) =>
    kind === 'local' || kind === 'private' || (kind === 'loopback' && platform !== 'darwin');
  if (isIP(bare)) {
    const kind = addressKind(bare);
    if (blocked(kind)) {
      return {
        message: `Claude Code cannot reach ${where} from inside the sandbox: ${kind === 'loopback' ? 'it is this machine (localhost)' : kind === 'private' ? 'it is a private network address' : 'it is a link-local address'}, and the sandbox only reaches the internet through its proxy.`,
        fixes: fixes('https://llm-gateway.example.com'),
      };
    }
    return null;
  }
  if (host === 'localhost') {
    return platform === 'darwin'
      ? null
      : {
          message: `Claude Code cannot reach ${where} from inside the sandbox: localhost is this machine, and the sandbox only reaches the internet through its proxy.`,
          fixes: fixes('https://llm-gateway.example.com'),
        };
  }
  if (!isAllowableHost(host)) {
    return {
      message: `The sandbox cannot allow ${where}: its network allow list needs a full domain name (with a dot), and "${host}" is a single name such as a Docker Compose service.`,
      fixes: fixes(`${host}.internal pointing at a reachable address`),
    };
  }
  // A name that resolves only to loopback or link-local addresses is refused by the sandbox's proxy.
  const resolve =
    o.resolve ??
    (async (h: string) => {
      const timeout = new Promise<string[]>((r) =>
        setTimeout(() => {
          r([]);
        }, 3_000).unref(),
      );
      return Promise.race([
        lookup(h, { all: true }).then(
          (xs) => xs.map((x) => x.address),
          () => [],
        ),
        timeout,
      ]);
    });
  const addresses = await resolve(host).catch(() => [] as string[]);
  if (
    addresses.length &&
    addresses.every((a) => {
      const k = addressKind(a);
      return k === 'loopback' || k === 'local';
    })
  ) {
    return {
      message: `Claude Code cannot reach ${where} from inside the sandbox: "${host}" resolves to ${addresses[0]}, a local address the sandbox's proxy refuses.`,
      fixes: fixes('https://llm-gateway.example.com'),
    };
  }
  return null;
}

/**
 * Environment for one attempt. CLAUDE_CONFIG_DIR points at a fresh, empty folder, so your
 * personal ~/.claude settings, memory and plugins never leak into the test: only the project's
 * own setup is measured.
 */
export function agentEnv(configDir: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {
    CLAUDE_CONFIG_DIR: configDir,
    IS_SANDBOX: '1', // Claude Code allows skipping prompts when it knows it is sandboxed
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  };
  // AWS credentials only go in when Claude Code is told to use Bedrock.
  const bedrock = !!env.CLAUDE_CODE_USE_BEDROCK && env.CLAUDE_CODE_USE_BEDROCK !== '0';
  for (const k of AUTH_VARS) if (env[k] && (bedrock || !k.startsWith('AWS_'))) out[k] = env[k]!;
  return out;
}

/** Claude Code tools that reach the web from outside the sandbox. */
export const WEB_TOOLS = ['WebSearch', 'WebFetch'];

export interface CommandOptions {
  bin: string;
  promptFile: string;
  /**
   * Redirect stdout / stderr to these files inside the command. Leave them out when setupscore
   * captures the output itself (it does for runs: then the agent cannot rewrite its own transcript).
   */
  transcriptFile?: string;
  stderrFile?: string;
  maxTurns: number;
  maxBudgetUsd: number;
  model?: string;
}

/** The shell command for one headless Claude Code session. The prompt comes from a file on stdin. */
export function claudeCommand(o: CommandOptions): string {
  const parts = [
    o.bin,
    '-p',
    '--output-format stream-json',
    '--verbose',
    `--max-turns ${o.maxTurns}`,
    `--max-budget-usd ${o.maxBudgetUsd.toFixed(2)}`,
    '--dangerously-skip-permissions', // safe here: the OS sandbox is the boundary
    '--no-session-persistence',
    // Web search and fetch run on Anthropic's servers, outside the sandbox's network rules: on a
    // public repository they could find the real commit. Turned off; any use still counts as looking outside.
    `--disallowedTools ${WEB_TOOLS.join(',')}`,
  ];
  if (o.model) parts.push(`--model ${shellQuote(o.model)}`);
  parts.push(`< ${shellQuote(o.promptFile)}`);
  if (o.transcriptFile) parts.push(`> ${shellQuote(o.transcriptFile)}`);
  if (o.stderrFile) parts.push(`2> ${shellQuote(o.stderrFile)}`);
  return parts.join(' ');
}

export type FailureClass =
  | { kind: 'ok' }
  /** Stop the whole run: retrying will not help (bad key, no credit, Claude Code missing). */
  | { kind: 'fatal'; message: string; fix: string }
  /** Retry later: overloaded, rate limited, network blip. Never counted against the setup. */
  | { kind: 'retry'; message: string }
  /** The agent ran but failed the task on its own: counts against the setup. */
  | { kind: 'task'; message: string };

/** Final API errors that are about the request itself (refusal, prompt too long...), so retrying does not help. */
const REQUEST_ERRORS = new Set([
  'invalid_request',
  'invalid_request_error',
  'request_too_large',
  'not_found_error',
  'permission_error',
]);
/** Final API errors that are about the API or the network: retry later. */
const API_TROUBLE = new Set([
  'server_error',
  'unknown',
  'overloaded',
  'overloaded_error',
  'rate_limit',
  'rate_limit_error',
  'api_error',
  'timeout',
  'connection_failed',
]);
const API_TROUBLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const API_TROUBLE_TEXT =
  /overloaded|rate.?limit|\b(?:408|429|500|502|503|504|529)\b|econnreset|econnrefused|enotfound|eai_again|etimedout|epipe|socket hang up|network error|fetch failed|connection (?:refused|dropped|lost|reset|closed|error)|can.?t reach the api|cannot reach the api|request timed out|stream (?:was )?(?:cut|closed|ended|interrupted)|premature close/;

export interface ClassifyOptions {
  /** When the attempt was stopped (ms since the epoch), to tell how long the agent had been silent. */
  endedAt?: number;
  /** Silence after the last progress that counts as a stalled API, in ms. Default 3 minutes. */
  stallMs?: number;
}

/**
 * At a --timeout kill, was Claude Code only waiting on the API? True when it was retrying an API
 * request, had given up on one, never got its first answer, or (with endedAt) had made no
 * progress for stallMs while no command of the agent was running.
 */
function waitingOnApi(m: AgentMetrics, o: ClassifyOptions): boolean {
  if (m.apiRetriesAtEnd > 0) return true;
  if (m.lastEventKind === 'init' || m.lastEventKind === 'api_error') return true;
  if (m.toolsRunningAtEnd > 0 || !m.lastProgressAt || o.endedAt === undefined) return false;
  if (m.lastEventKind !== 'tool_result' && m.lastEventKind !== 'assistant') return false;
  return o.endedAt - Date.parse(m.lastProgressAt) >= (o.stallMs ?? 3 * 60_000);
}

/**
 * Decide what an attempt's agent failure means, from the transcript and stderr.
 * A session that finished normally is always "ok", whatever its final message says, and even if
 * Claude Code had to retry the API on the way (a 401, 529 or 429 it recovered from): only the
 * error that ended the session counts, and error patterns are only looked for in error results
 * and stderr, never in Claude's own words.
 * Pass `{ endedAt: Date.now() }` so a timeout after a long silence is blamed on the API.
 */
export function classifyAgentFailure(
  m: AgentMetrics,
  stderr: string,
  exitCode: number | null,
  timedOut: boolean,
  opts: ClassifyOptions = {},
): FailureClass {
  const err = stderr.toLowerCase();

  // Claude Code did not start at all: nothing on stdout, and the shell or Node says why.
  if (
    m.parsedLines === 0 &&
    (exitCode === 127 ||
      exitCode === 126 ||
      /command not found|: not found|not recognized as an internal|no such file or directory|cannot find module|enoent|permission denied/.test(
        err,
      ))
  ) {
    const detail = stderrSummary(stderr);
    return {
      kind: 'fatal',
      message: `Claude Code could not be started inside the sandbox${detail ? ` (${detail})` : ''}.`,
      fix: 'Install it (npm install -g @anthropic-ai/claude-code), or pass its path with --claude-bin. Run "npx setupscore doctor" to check.',
    };
  }
  // The main answer arrived; a background subagent may still have been running when we stopped it.
  if (m.outcome === 'completed') return { kind: 'ok' };
  if (timedOut) {
    if (waitingOnApi(m, opts)) {
      return {
        kind: 'retry',
        message: `the Claude API did not answer${m.lastRetryError ? ` (Claude Code was retrying: ${m.lastRetryError})` : ''}`,
      };
    }
    return { kind: 'task', message: 'the agent ran out of time' };
  }

  // The error that ended the session decides. Without one (an old Claude Code, a crash), the
  // error text and stderr do.
  const code = m.finalErrorCode?.toLowerCase();
  const status = m.apiErrorStatus;
  const text = `${m.isError ? (m.result ?? '') : ''}\n${err}`.toLowerCase();
  if (
    code === 'authentication_failed' ||
    (!code &&
      /invalid (?:x-)?api[ -]key|authentication[_ ]error|\b401\b|oauth token (?:has )?expired|please run \/login|not logged in/.test(
        text,
      ))
  ) {
    return {
      kind: 'fatal',
      message: 'Claude rejected the API key or token.',
      fix: 'Check ANTHROPIC_API_KEY, or create a new token with "claude setup-token" and set CLAUDE_CODE_OAUTH_TOKEN.',
    };
  }
  if (
    code === 'billing_error' ||
    (!code && /credit balance is too low|insufficient (?:credit|balance|quota)|billing_error/.test(text))
  ) {
    return {
      kind: 'fatal',
      message: 'Your Anthropic account has no credit left.',
      fix: 'Add credit at console.anthropic.com, or use a subscription token (claude setup-token).',
    };
  }
  if (
    code === 'model_not_found' ||
    /issue with the selected model|the model [^\n]{0,80} (?:does not exist|may not exist)/.test(text)
  ) {
    return {
      kind: 'fatal',
      message: `Claude Code cannot use the model${m.model ? ` ${m.model}` : ''}: it does not exist or your key has no access to it.`,
      fix: 'Check --model (or agent.model in setupscore.yml): use a model your key can use, such as sonnet or opus. Try it with: claude -p --model <model> "hi"',
    };
  }
  if (m.isError && /invalid url/i.test(m.result ?? '')) {
    return {
      kind: 'fatal',
      message: 'Claude Code cannot reach the API: the API address is not a valid URL ("Invalid URL").',
      fix: 'Check ANTHROPIC_BASE_URL: it must be a full URL such as https://gateway.example.com, or unset it to use api.anthropic.com.',
    };
  }
  if (m.outcome === 'max_turns') return { kind: 'task', message: 'the agent hit the turn limit' };
  if (m.outcome === 'budget') return { kind: 'task', message: 'the agent hit its spending limit for one attempt' };
  if (code && REQUEST_ERRORS.has(code))
    return { kind: 'task', message: (m.result ?? 'the API refused the request').slice(0, 200) };
  if (
    (code && API_TROUBLE.has(code)) ||
    /connect|network|timeout|socket|stream|overload|rate|server/.test(m.apiErrorKind ?? '') ||
    (status !== undefined && (API_TROUBLE_STATUS.has(status) || status >= 500)) ||
    m.terminalReason === 'api_error' ||
    API_TROUBLE_TEXT.test(text)
  ) {
    const detail = (m.isError ? m.result : undefined)?.replace(/\s+/g, ' ').trim();
    return {
      kind: 'retry',
      message: `the Claude API was busy or unreachable${detail ? ` (${detail.slice(0, 160)})` : ''}`,
    };
  }
  if (m.outcome === 'no_result') {
    const detail = stderrSummary(stderr);
    return exitCode === 0
      ? { kind: 'retry', message: 'Claude Code ended without a result' }
      : {
          kind: 'retry',
          message: `Claude Code stopped unexpectedly (exit ${exitCode ?? 'killed'})${detail ? `: ${detail}` : ''}`,
        };
  }
  return { kind: 'task', message: (m.result ?? 'the agent reported an error').slice(0, 200) };
}

/** The most useful line of an error output: the last line that names an error, not a stack frame or a version banner. */
export function stderrSummary(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^at\s/.test(l) && !/^Node\.js v\d/.test(l) && !/^\^+$/.test(l));
  const named = lines.filter((l) => /error|fatal|cannot|denied|not found|enoent|eacces|eperm|failed/i.test(l));
  return (named.pop() ?? lines.pop() ?? '').slice(0, 160);
}
