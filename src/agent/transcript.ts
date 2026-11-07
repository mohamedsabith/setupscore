/**
 * Reads the stream-json transcript of `claude -p --output-format stream-json --verbose`.
 * One JSON object per line: a system "init" event first, assistant/user messages, and a "result"
 * event with cost and turns. A background subagent can outlive the main answer, and Claude Code
 * then answers again, so there can be more than one result event (see parseTranscript).
 * Unknown events and broken lines are skipped, never fatal: parseTranscript never throws.
 */

type AgentOutcome =
  | 'completed' // the agent finished on its own
  | 'max_turns' // stopped by --max-turns
  | 'budget' // stopped by --max-budget-usd
  | 'error' // the agent reported an error
  | 'no_result'; // no final result line: crashed, killed or timed out

/**
 * The last meaningful event of the transcript. Informational notices (task progress, rate-limit
 * notices, background task lists) are skipped, so that "Claude Code was only waiting on the API"
 * can be told apart from "a command of the agent was still running".
 */
type LastEventKind =
  | 'init' // nothing but the start: the first API request never got an answer
  | 'api_retry' // Claude Code was retrying an API request
  | 'api_error' // Claude Code gave up on an API request (synthetic "API Error" message)
  | 'assistant' // the model's text or thinking
  | 'tool_use' // the model asked for a tool
  | 'tool_result' // a tool answered; the next API request was due
  | 'result'; // a result event

export interface AgentMetrics {
  /** Outcome of the main session (its first result event; later ones are follow-ups, see parseTranscript). */
  outcome: AgentOutcome;
  resultSubtype?: string | undefined;
  isError: boolean;
  /** The final text, or the error text. */
  result?: string | undefined;
  /** Total cost in USD: total_cost_usd of the last result event (Claude Code reports it for the whole process). */
  costUsd: number;
  /**
   * Claude Code's own turn count: num_turns of the result events, added up when there are several.
   * It is not the number of API requests: Claude Code 2.1.318 adds one per tool call of the main
   * agent (parallel calls count one each) plus one for the final answer, does not count subagent
   * turns, and reports N + 1 when it stops at --max-turns N.
   */
  turns: number;
  durationMs: number;
  /** Tokens of the whole process, main agent and subagents (the result's modelUsage, summed over models). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolCalls: Record<string, number>;
  /** Shell commands (main agent and subagents), each cut to 300 characters, at most 200. */
  bashCommands: string[];
  /** Shell commands that returned an error. */
  failedCommands: string[];
  /** Files changed by Edit, Write, MultiEdit or NotebookEdit calls that did not fail. */
  filesEdited: string[];
  /** Paths the agent pointed tools at without changing them: Read, Grep, Glob, LS..., and edits that failed. */
  pathsRead: string[];
  /** Text the agent wrote into files (Write, Edit, MultiEdit), capped; checked for digging. */
  textWritten: string[];
  /** Skills loaded by Skill calls that did not fail. */
  skillsUsed: string[];
  /** Subagent types started by Agent/Task calls that did not fail ("general-purpose" when no type is given). */
  subagentsUsed: string[];
  mcpServers: { name: string; status: string }[];
  /** Every error code reported along the way, including API retries Claude Code recovered from: informational only. */
  errorCodes: string[];
  apiRetries: number;
  /** The model Claude Code said it would use (init event). */
  model?: string | undefined;
  /** Models that answered, main agent and subagents (the result's modelUsage). */
  modelsUsed: string[];
  apiKeySource?: string | undefined;
  sessionId?: string | undefined;
  claudeCodeVersion?: string | undefined;
  /** Skills Claude Code could see at start (from the init event). */
  skillsAvailable: string[];
  /** Claude Code's auto-memory folder for the session (init memory_paths), not the CLAUDE.md files it loaded. */
  memoryPaths: string[];
  /** Why the main session ended, when Claude Code says (completed, api_error, max_turns, prompt_too_long...). */
  terminalReason?: string | undefined;
  /**
   * The API error that ended the main session: the error code of Claude Code's final "API Error"
   * message (server_error, rate_limit, authentication_failed, billing_error, model_not_found,
   * invalid_request, unknown...). Errors Claude Code recovered from are not here.
   */
  finalErrorCode?: string | undefined;
  /** HTTP status of that final API error (result api_error_status), when Claude Code reports one. */
  apiErrorStatus?: number | undefined;
  /** Claude Code's class of that final API error (result api_error, e.g. connection_failed). */
  apiErrorKind?: string | undefined;
  /** How many result events there were: more than one when a background subagent outlived the main answer. */
  resultCount: number;
  /** Did any shell command (main agent or subagent) run the project's tests? Checked on whole commands, before the 300-character cut and the 200-command cap. */
  ranTests: boolean;
  /** The last meaningful event (see LastEventKind). Undefined for an empty transcript. */
  lastEventKind?: LastEventKind | undefined;
  /** API retries since the last progress: Claude Code was still waiting on the API when the transcript ended. */
  apiRetriesAtEnd: number;
  /** Error code of the last of those retries (overloaded, rate_limit, server_error...). */
  lastRetryError?: string | undefined;
  /** Tool calls (subagents not included) that had no result yet when the transcript ended: a command was still running. */
  toolsRunningAtEnd: number;
  /** Timestamp (ISO 8601) of the last assistant message or tool result: the agent's last progress. */
  lastProgressAt?: string | undefined;
  parsedLines: number;
  badLines: number;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const AGENT_TOOLS = new Set(['Task', 'Agent']);
const MAX_COMMANDS = 200;
const MAX_WRITTEN = 512 * 1024;
const MAX_RESULT = 20_000;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
/** Text of an untrusted value, never throwing (String({ toString: 1 }) throws). */
const text = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const message = str(obj(v)?.['message']);
  if (message !== undefined) return message;
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
};

export function emptyMetrics(): AgentMetrics {
  return {
    outcome: 'no_result',
    isError: false,
    costUsd: 0,
    turns: 0,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolCalls: {},
    bashCommands: [],
    failedCommands: [],
    filesEdited: [],
    pathsRead: [],
    textWritten: [],
    skillsUsed: [],
    subagentsUsed: [],
    mcpServers: [],
    skillsAvailable: [],
    memoryPaths: [],
    modelsUsed: [],
    errorCodes: [],
    apiRetries: 0,
    resultCount: 0,
    ranTests: false,
    apiRetriesAtEnd: 0,
    toolsRunningAtEnd: 0,
    parsedLines: 0,
    badLines: 0,
  };
}

interface ResultEvent {
  followUp: boolean;
  subtype: string;
  isError: boolean;
  result?: string | undefined;
  cost: number;
  turns: number;
  durationMs: number;
  sessionId?: string | undefined;
  terminalReason?: string | undefined;
  apiErrorStatus?: number | undefined;
  apiErrorKind?: string | undefined;
  finalErrorCode?: string | undefined;
  usage: Record<string, unknown>;
  modelUsage: Record<string, Record<string, unknown>>;
}

/** A tool call that only counts if Claude Code does not report it as failed. */
interface Pending {
  id?: string | undefined;
  value: string;
}

/**
 * Parse a transcript. With background subagents there can be several result events: the first
 * one without an "origin" is the main answer (outcome, final text, error), later ones are Claude
 * Code answering a subagent's notification. Turns and durations are added up, the cost is the last
 * total_cost_usd (it covers the whole process), and tokens come from the last modelUsage, which
 * also covers subagents (the usage field does not).
 */
export function parseTranscript(input: string): AgentMetrics {
  const m = emptyMetrics();
  const calls = new Map<string, number>();
  const edits: Pending[] = [];
  const skills: Pending[] = [];
  const agents: Pending[] = [];
  const failedIds = new Set<string>();
  const errors = new Set<string>();
  const bashById = new Map<string, string>();
  const running = new Set<string>();
  const results: ResultEvent[] = [];
  let written = 0;
  let finalError: string | undefined;

  const progress = (kind: LastEventKind, ev: Record<string, unknown>) => {
    m.lastEventKind = kind;
    m.apiRetriesAtEnd = 0;
    m.lastRetryError = undefined;
    const at = str(ev['timestamp']);
    if (at && !Number.isNaN(Date.parse(at))) m.lastProgressAt = at;
  };

  const onLine = (ev: Record<string, unknown>) => {
    const type = str(ev['type']);
    // Messages of a subagent carry the id of the Agent call that started it.
    const main = !ev['parent_tool_use_id'];

    if (type === 'system') {
      if (ev['subtype'] === 'init') {
        m.lastEventKind ??= 'init';
        m.model = str(ev['model']) ?? m.model;
        m.apiKeySource = str(ev['apiKeySource']) ?? m.apiKeySource;
        m.sessionId = str(ev['session_id']) ?? m.sessionId;
        m.claudeCodeVersion = str(ev['claude_code_version']) ?? m.claudeCodeVersion;
        const names = (v: unknown) =>
          Array.isArray(v) ? v.map((x) => str(x) ?? str(obj(x)?.['name'])).filter((x): x is string => !!x) : [];
        m.skillsAvailable = names(ev['skills']);
        m.memoryPaths = names(ev['memory_paths']).length
          ? names(ev['memory_paths'])
          : Object.values(obj(ev['memory_paths']) ?? {}).flatMap((v) => names(Array.isArray(v) ? v : [v]));
        if (Array.isArray(ev['mcp_servers'])) {
          m.mcpServers = ev['mcp_servers']
            .map((s) => obj(s))
            .filter((s): s is Record<string, unknown> => !!s)
            .map((s) => ({ name: str(s['name']) ?? '?', status: str(s['status']) ?? '?' }));
        }
      } else if (ev['subtype'] === 'api_retry') {
        m.apiRetries++;
        m.apiRetriesAtEnd++;
        m.lastEventKind = 'api_retry';
        const code = str(ev['error']) ?? str(obj(ev['error'])?.['type']);
        m.lastRetryError = code;
        if (code) errors.add(code);
      }
      return;
    }

    if (type === 'rate_limit_event') {
      // "allowed" and "allowed_warning" are notices about the subscription's limits, not errors.
      const status = str(obj(ev['rate_limit_info'])?.['status']) ?? str(ev['status']);
      if (!status?.startsWith('allowed')) errors.add('rate_limit');
      return;
    }

    if (type === 'assistant') {
      const code = str(ev['error']) ?? str(obj(ev['error'])?.['type']);
      if (code) errors.add(code);
      // Claude Code gave up on an API request and says so in a synthetic message. A later
      // normal message means the session went on, so that error did not end it.
      const apiError =
        ev['is_api_error_message'] === true || (!!code && str(obj(ev['message'])?.['model']) === '<synthetic>');
      if (main) finalError = apiError ? (code ?? 'unknown') : undefined;
      const content = obj(ev['message'])?.['content'];
      let asked = false;
      for (const block of Array.isArray(content) ? content : []) {
        const b = obj(block);
        if (!b || b['type'] !== 'tool_use') continue;
        asked = true;
        const name = str(b['name']) ?? 'unknown';
        calls.set(name, (calls.get(name) ?? 0) + 1);
        const input = obj(b['input']) ?? {};
        const id = str(b['id']);
        if (id && !AGENT_TOOLS.has(name)) running.add(id);
        if (name === 'Bash') {
          const cmd = str(input['command']);
          if (!cmd) continue;
          if (!m.ranTests && runsTests(cmd)) m.ranTests = true;
          if (m.bashCommands.length < MAX_COMMANDS) m.bashCommands.push(cmd.slice(0, 300));
          if (id) bashById.set(id, cmd.slice(0, 300));
        } else if (EDIT_TOOLS.has(name)) {
          const p = str(input['file_path']) ?? str(input['notebook_path']) ?? str(input['path']);
          if (p) edits.push({ id, value: p });
          const more = Array.isArray(input['edits']) ? input['edits'].map((e) => str(obj(e)?.['new_string'])) : [];
          for (const t of [str(input['content']), str(input['new_string']), str(input['new_source']), ...more]) {
            if (t && written < MAX_WRITTEN) {
              m.textWritten.push(t.slice(0, MAX_WRITTEN - written));
              written += t.length;
            }
          }
        } else if (name === 'Skill') {
          const s = str(input['skill']) ?? str(input['command']) ?? str(input['name']);
          if (s) skills.push({ id, value: s.replace(/^\//, '') });
        } else if (AGENT_TOOLS.has(name)) {
          // Without subagent_type Claude Code starts its general-purpose subagent.
          agents.push({ id, value: str(input['subagent_type']) || str(input['agent']) || 'general-purpose' });
        } else {
          const p = str(input['file_path']) ?? str(input['path']) ?? str(input['notebook_path']);
          if (p && m.pathsRead.length < MAX_COMMANDS) m.pathsRead.push(p.slice(0, 300));
        }
      }
      progress(apiError ? 'api_error' : asked ? 'tool_use' : 'assistant', ev);
      return;
    }

    if (type === 'user') {
      const content = obj(ev['message'])?.['content'];
      if (!Array.isArray(content)) return;
      let answered = false;
      for (const block of content) {
        const b = obj(block);
        if (!b || b['type'] !== 'tool_result') continue;
        answered = true;
        const id = str(b['tool_use_id']) ?? '';
        running.delete(id);
        if (b['is_error'] !== true) continue;
        failedIds.add(id);
        const cmd = bashById.get(id);
        if (cmd && m.failedCommands.length < MAX_COMMANDS) m.failedCommands.push(cmd);
      }
      if (answered) progress('tool_result', ev);
      return;
    }

    if (type === 'result') {
      const u = obj(ev['usage']) ?? {};
      const mu = Object.create(null) as Record<string, Record<string, unknown>>;
      for (const [model, usage] of Object.entries(obj(ev['modelUsage']) ?? {})) {
        const v = obj(usage);
        if (v) mu[model] = v;
      }
      const status = ev['api_error_status'];
      results.push({
        followUp: !!obj(ev['origin']),
        subtype: str(ev['subtype']) ?? 'unknown',
        isError: ev['is_error'] === true,
        result: (
          str(ev['result']) ??
          (Array.isArray(ev['errors']) ? ev['errors'].map(text).filter(Boolean).join('; ') : undefined)
        )?.slice(0, MAX_RESULT),
        cost: Math.max(0, num(ev['total_cost_usd'])), // never negative: it feeds the budget
        turns: Math.max(0, num(ev['num_turns'])),
        durationMs: Math.max(0, num(ev['duration_ms'])),
        sessionId: str(ev['session_id']),
        terminalReason: str(ev['terminal_reason']),
        apiErrorStatus: typeof status === 'number' && Number.isInteger(status) ? status : undefined,
        apiErrorKind: str(ev['api_error']),
        finalErrorCode: finalError,
        usage: u,
        modelUsage: mu,
      });
      progress('result', ev);
    }
  };

  for (const raw of input.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let ev: Record<string, unknown> | undefined;
    try {
      ev = obj(JSON.parse(line));
    } catch {
      m.badLines++;
      continue;
    }
    if (!ev) {
      m.badLines++;
      continue;
    }
    try {
      onLine(ev);
      m.parsedLines++;
    } catch {
      // An event shaped in a way nobody foresaw: skip it rather than lose the attempt.
      m.badLines++;
    }
  }

  if (results.length) {
    const main = results.find((r) => !r.followUp) ?? results[0]!;
    const last = results[results.length - 1]!;
    m.resultCount = results.length;
    m.resultSubtype = main.subtype;
    m.isError = main.isError;
    m.result = main.result;
    m.terminalReason = main.terminalReason;
    m.apiErrorStatus = main.apiErrorStatus;
    m.apiErrorKind = main.apiErrorKind;
    m.finalErrorCode = main.isError || main.subtype !== 'success' ? main.finalErrorCode : undefined;
    m.sessionId = main.sessionId ?? m.sessionId;
    m.outcome =
      main.subtype === 'success' && !main.isError
        ? 'completed'
        : main.subtype === 'error_max_turns'
          ? 'max_turns'
          : main.subtype === 'error_max_budget_usd' || main.subtype === 'error_budget'
            ? 'budget'
            : 'error';
    m.costUsd = Math.max(last.cost, ...results.map((r) => r.cost));
    m.turns = results.reduce((s, r) => s + r.turns, 0);
    m.durationMs = results.reduce((s, r) => s + r.durationMs, 0);
    const withModels = [...results].reverse().find((r) => Object.keys(r.modelUsage).length);
    if (withModels) {
      const per = Object.values(withModels.modelUsage);
      const sum = (k: string) => per.reduce((s, v) => s + Math.max(0, num(v[k])), 0);
      m.inputTokens = sum('inputTokens');
      m.outputTokens = sum('outputTokens');
      m.cacheReadTokens = sum('cacheReadInputTokens');
      m.cacheWriteTokens = sum('cacheCreationInputTokens');
      m.modelsUsed = Object.keys(withModels.modelUsage).filter((k) => k !== '<synthetic>');
    } else {
      const sum = (k: string) => results.reduce((s, r) => s + Math.max(0, num(r.usage[k])), 0);
      m.inputTokens = sum('input_tokens');
      m.outputTokens = sum('output_tokens');
      m.cacheReadTokens = sum('cache_read_input_tokens');
      m.cacheWriteTokens = sum('cache_creation_input_tokens');
    }
  } else {
    // Killed or crashed: the last API error, if Claude Code had already given up, is the failure.
    m.finalErrorCode = finalError;
  }

  const ok = (list: Pending[]) => [...new Set(list.filter((p) => !p.id || !failedIds.has(p.id)).map((p) => p.value))];
  m.filesEdited = ok(edits);
  for (const p of edits) {
    if (p.id && failedIds.has(p.id) && !m.filesEdited.includes(p.value) && m.pathsRead.length < MAX_COMMANDS)
      m.pathsRead.push(p.value.slice(0, 300));
  }
  m.skillsUsed = ok(skills);
  m.subagentsUsed = ok(agents);
  m.errorCodes = [...errors];
  m.toolsRunningAtEnd = running.size;
  // Own properties only (a tool named "__proto__" or "constructor" is counted like any other).
  m.toolCalls = Object.fromEntries(calls);
  return m;
}

/**
 * A model name without a trailing "[...]" tag, as s.replace(/\[[^\]]*\]$/, '') gives, in linear
 * time: the tag starts at the first "[" after the last "]" before the end.
 */
export function withoutTrailingTag(s: string): string {
  if (!s.endsWith(']')) return s;
  const body = s.slice(0, -1);
  const open = body.indexOf('[', body.lastIndexOf(']') + 1);
  return open === -1 ? s : s.slice(0, open);
}

/**
 * The model Claude Code really used, when it is not the one asked for with --model, so the run
 * can say so (Claude Code may silently replace a retired model). Aliases such as "sonnet" match
 * any model of that family; "default" and similar are never reported.
 */
export function modelMismatch(
  requested: string | undefined,
  m: Pick<AgentMetrics, 'model' | 'modelsUsed'>,
): string | undefined {
  const used = m.model && m.model !== '<synthetic>' ? m.model : m.modelsUsed[0];
  if (!requested || !used) return undefined;
  const norm = (s: string) => withoutTrailingTag(s.toLowerCase()).trim();
  const want = norm(requested);
  const got = norm(used);
  if (!want || want === got || got.includes(want) || want.includes(got)) return undefined;
  if (!want.includes('-')) {
    // An alias: "sonnet", "opus", "haiku" match their family; others ("default", "best", "opusplan") are not checked.
    return ['sonnet', 'opus', 'haiku'].includes(want) && !got.includes(want) ? used : undefined;
  }
  return used;
}

// ---------------------------------------------------------------------------------------------
// Did a shell command run the project's tests?

const TEST_SCRIPT = /^tests?(?:$|[:._-])/;
const TEST_PATH =
  /(?:^|\/)(?:__tests__|tests?)\/.+\.[cm]?[jt]sx?$|[._-](?:test|spec)\.[cm]?[jt]sx?$|^(?:.*\/)?tests?\.[cm]?[jt]sx?$/;
const RUNNERS = new Set(['vitest', 'jest', 'mocha', 'ava', 'tap', 'tape', 'uvu', 'jasmine', 'karma']);
const RUNNER_BIN = /(?:^|\/)node_modules\/(?:\.bin\/|(?:vitest|jest|jest-cli|mocha|ava|tap|uvu|jasmine)\/)/;
const SKIP_WORDS = new Set([
  'time',
  'nohup',
  'exec',
  'command',
  'builtin',
  'then',
  'do',
  'else',
  'elif',
  'if',
  'while',
  'until',
  '!',
  '{',
  '}',
  '--',
]);
/** Wrappers that run another command after their own options, and those options that take a value. */
const WRAPPERS: Record<string, string[]> = {
  npx: ['-p', '--package', '--cache', '--userconfig'],
  pnpx: ['-p', '--package'],
  bunx: ['-p', '--package'],
  env: ['-u', '--unset', '-C', '--chdir'],
  nice: ['-n', '--adjustment'],
  sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U'],
  stdbuf: ['-i', '-o', '-e'],
  c8: [
    '-r',
    '--reporter',
    '--reports-dir',
    '--report-dir',
    '--temp-directory',
    '-x',
    '--exclude',
    '-n',
    '--include',
    '-e',
    '--extension',
  ],
  nyc: ['-r', '--reporter', '--report-dir', '--temp-dir', '-x', '--exclude', '-n', '--include', '-e', '--extension'],
  'cross-env': [],
  dotenv: ['-e', '-c', '-v', '-p'],
};
const PM_VALUE_FLAGS: Record<string, string[]> = {
  npm: ['--prefix', '-C', '--workspace', '-w', '--loglevel', '--userconfig', '--cache'],
  pnpm: ['--filter', '-F', '-C', '--dir', '--workspace-dir', '--reporter', '--loglevel'],
  yarn: ['--cwd', '--modules-folder', '--cache-folder'],
  bun: ['--cwd', '-c', '--config', '--filter', '-F'],
};
const PM_TEST: Record<string, string[]> = {
  npm: ['test', 't', 'tst', 'it', 'cit', 'install-test', 'install-ci-test'],
  pnpm: ['test', 't', 'tst'],
  yarn: ['test'],
  bun: ['test'],
};
const NODE_VALUE_FLAGS = [
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '-C',
  '--conditions',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-concurrency',
  '--test-timeout',
  '--env-file',
  '--tsconfig',
];

const base = (w: string) => w.replace(/^.*\//, '');

/** Words after a command's options: values of the given flags are skipped too. */
function afterOptions(words: string[], valueFlags: string[]): string[] {
  let i = 0;
  while (i < words.length && words[i]!.startsWith('-') && words[i] !== '--') {
    if (valueFlags.includes(words[i]!)) i++;
    i++;
  }
  if (words[i] === '--') i++;
  return words.slice(i);
}

/**
 * Split a shell command line into simple commands (lists of words), roughly the way a shell
 * does: quotes are removed, comments and here-document bodies are dropped, redirections are
 * skipped, and ; && || | & ( ) ` $( start a new command.
 */
function simpleCommands(src: string, depth = 0): string[][] {
  const out: string[][] = [];
  const nested: string[] = [];
  const heredocs: { tag: string; strip: boolean }[] = [];
  const n = src.length;
  let words: string[] = [];
  let word: string | null = null;
  let i = 0;
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  // Read one quoted or unquoted chunk at i into the current word; returns false at a separator.
  const quoted = (): boolean => {
    const c = src[i]!;
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j === -1 ? n : j;
      word = (word ?? '') + src.slice(i + 1, end);
      i = end + 1;
      return true;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n && '"\\$`\n'.includes(src[j + 1]!)) {
          s += src[j + 1]!;
          j += 2;
        } else if (src.startsWith('$(', j)) {
          // A command substitution runs even inside double quotes: "$(npm test)".
          let depth = 0;
          let k = j + 1;
          for (; k < n; k++) {
            if (src[k] === '(') depth++;
            else if (src[k] === ')' && --depth === 0) break;
          }
          nested.push(src.slice(j + 2, k));
          s += src.slice(j, k + 1);
          j = k + 1;
        } else s += src[j++]!;
      }
      word = (word ?? '') + s;
      i = j + 1;
      return true;
    }
    if (c === '\\') {
      if (src[i + 1] !== '\n') word = (word ?? '') + (src[i + 1] ?? '');
      i += 2;
      return true;
    }
    return false;
  };
  // The word after a redirection or here-document operator.
  const target = (): string => {
    while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
    const saved = word;
    word = '';
    while (i < n && !' \t\r\n;&|()<>`'.includes(src[i]!)) {
      if (!quoted()) word += src[i++]!;
    }
    const t: string = word;
    word = saved;
    return t;
  };

  while (i < n) {
    const c = src[i]!;
    if (c === '\n') {
      endCommand();
      i++;
      for (const h of heredocs.splice(0)) {
        while (i < n) {
          const nl = src.indexOf('\n', i);
          const line = src.slice(i, nl === -1 ? n : nl);
          i = nl === -1 ? n : nl + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line).replace(/\r$/, '') === h.tag) break;
        }
      }
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
    } else if (c === '#' && word === null) {
      while (i < n && src[i] !== '\n') i++;
    } else if (quoted()) {
      // added to the word
    } else if (c === '$' && src[i + 1] === '(') {
      endCommand();
      i += 2;
    } else if (';&|()`'.includes(c)) {
      endCommand();
      i++;
    } else if (c === '<' || c === '>') {
      if (word !== null && /^\d+$/.test(word)) word = null; // the file descriptor in 2>&1
      endWord();
      if (src.startsWith('<<', i) && src[i + 2] !== '<') {
        i += 2;
        const strip = src[i] === '-';
        if (strip) i++;
        const tag = target();
        if (tag) heredocs.push({ tag, strip });
      } else {
        while (i < n && '<>&|'.includes(src[i]!)) i++;
        target();
      }
    } else {
      word = (word ?? '') + c;
      i++;
    }
  }
  endCommand();
  if (depth < 4) for (const inner of nested) out.push(...simpleCommands(inner, depth + 1));
  return out;
}

function pmRunsTests(pm: string, words: string[], depth: number): boolean {
  const args = afterOptions(words, PM_VALUE_FLAGS[pm] ?? []);
  const sub = args[0];
  if (sub === undefined) return false;
  const rest = args.slice(1);
  if (PM_TEST[pm]!.includes(sub)) return true;
  if (['run', 'run-script', 'rum', 'urn'].includes(sub)) {
    const script = afterOptions(rest, PM_VALUE_FLAGS[pm] ?? [])[0];
    return (
      !!script && (TEST_SCRIPT.test(script) || RUNNERS.has(base(script)) || (pm === 'bun' && TEST_PATH.test(script)))
    );
  }
  if (['exec', 'x', 'dlx'].includes(sub))
    return wordsRunTests(afterOptions(rest, ['-p', '--package', '-c', '--call']), depth + 1);
  if (pm === 'yarn' && sub === 'workspace') return pmRunsTests(pm, rest.slice(1), depth);
  if (pm === 'yarn' && sub === 'workspaces' && rest[0] === 'foreach')
    return pmRunsTests(pm, afterOptions(rest.slice(1), ['--include', '--exclude', '--from', '-j', '--jobs']), depth);
  if (pm === 'pnpm' && ['recursive', 'multi', 'm'].includes(sub)) return pmRunsTests(pm, rest, depth);
  // pnpm, yarn and bun also run package scripts and installed tools by name: "pnpm test:unit", "yarn vitest".
  if (pm !== 'npm' && (TEST_SCRIPT.test(sub) || RUNNERS.has(sub))) return true;
  return pm === 'bun' && TEST_PATH.test(sub);
}

function wordsRunTests(input: string[], depth: number): boolean {
  if (depth > 4) return false;
  let words = input;
  for (let guard = 0; guard < 32 && words.length; guard++) {
    const head = words[0]!;
    if (SKIP_WORDS.has(head) || /^[A-Z_]\w*=/i.test(head)) {
      words = words.slice(1);
      continue;
    }
    const name = base(head);
    const rest = words.slice(1);
    if (name === 'timeout') {
      words = afterOptions(rest, ['-s', '--signal', '-k', '--kill-after']).slice(1); // then the duration
      continue;
    }
    if (Object.hasOwn(WRAPPERS, name)) {
      if (name === 'npx') {
        const call = rest.findIndex((w) => w === '-c' || w === '--call');
        if (call !== -1 && rest[call + 1]) return commandRunsTests(rest[call + 1]!, depth + 1);
      }
      words = afterOptions(rest, WRAPPERS[name]!);
      continue;
    }
    if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(name)) {
      const flag = rest.findIndex((w) => /^-[a-z]+$/.test(w) && w.includes('c'));
      return flag !== -1 && !!rest[flag + 1] && commandRunsTests(rest[flag + 1]!, depth + 1);
    }
    if (name === 'eval') return commandRunsTests(rest.join(' '), depth + 1);
    if (Object.hasOwn(PM_TEST, name)) return pmRunsTests(name, rest, depth);
    if (name === 'node' || name === 'tsx' || name === 'ts-node') {
      const options: string[] = [];
      let i = 0;
      while (i < rest.length && rest[i]!.startsWith('-') && rest[i] !== '--') {
        options.push(rest[i]!);
        if (NODE_VALUE_FLAGS.includes(rest[i]!)) i++;
        i++;
      }
      if (options.includes('--test')) return true;
      if (options.some((o) => ['-e', '--eval', '-p', '--print'].includes(o))) return false;
      const script = rest[rest[i] === '--' ? i + 1 : i];
      return !!script && (TEST_PATH.test(script) || RUNNER_BIN.test(script));
    }
    if (name === 'deno') return rest[0] === 'test';
    if (name === 'playwright') return rest[0] === 'test';
    if (name === 'cypress') return rest[0] === 'run';
    if (RUNNERS.has(name)) {
      const info = ['--version', '--help', '-h', 'init', '--init', 'list'];
      return !rest.some((w) => info.includes(w)) && !((name === 'jest' || name === 'vitest') && rest.includes('-v'));
    }
    if (name === 'turbo' || name === 'lerna') {
      const targets = afterOptions(rest[0] === 'run' ? rest.slice(1) : rest, [
        '--filter',
        '-F',
        '--scope',
        '--ignore',
        '--concurrency',
      ]);
      return targets.some((t) => !t.startsWith('-') && TEST_SCRIPT.test(t));
    }
    if (name === 'nx') {
      if (rest[0] === 'test') return true;
      if (rest[0] === 'run') return /:tests?(?:$|[:._-])/.test(rest[1] ?? '');
      const t = rest.findIndex((w) => w === '-t' || w === '--target' || w === '--targets');
      const value = t !== -1 ? rest[t + 1] : rest.find((w) => /^--targets?=/.test(w))?.replace(/^--targets?=/, '');
      return !!value && value.split(',').some((v) => TEST_SCRIPT.test(v));
    }
    if (name === 'make') return afterOptions(rest, ['-C', '-f', '-j']).some((t) => TEST_SCRIPT.test(t));
    return false;
  }
  return false;
}

function commandRunsTests(command: string, depth: number): boolean {
  return simpleCommands(command).some((words) => wordsRunTests(words, depth));
}

/**
 * Does this shell command run the project's tests? Recognises the package managers (npm test,
 * npm t, npm run-script test, pnpm/yarn/bun test, test:* scripts), node --test, node x.test.js,
 * test runners directly or through npx, and commands chained with && ; | or inside bash -c.
 * Words inside quotes, comments and here-documents are not commands: echo "npm test" does not count.
 */
export function runsTests(command: string): boolean {
  try {
    return commandRunsTests(command, 0);
  } catch {
    return false;
  }
}
