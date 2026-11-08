import { statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import pc from 'picocolors';
import { gitRepoProblem, renderCheck, renderDoctorSummary, runDoctor } from './commands/doctor.js';
import { reportCommand, suggestCommand, type ReportFlags, type SuggestFlags } from './commands/report.js';
import { startRun, type RunFlags } from './commands/run.js';
import { watchCommand, type WatchFlags } from './commands/watch.js';
import { NothingToDo, StoppedEarly, UsageError } from './core/errors.js';
import { renderTasksSummary, runTasks, type TasksFlags } from './commands/tasks.js';
import { check, type CheckRun } from './core/check.js';
import { ConfigError, loadConfig, type Config } from './core/config.js';
import { displayPath, shellArg as asArg } from './core/paths.js';
import { EnvironmentError } from './sandbox/types.js';
import { assertSandboxModeAllowed, runProgram, windowsRefusal, type SandboxMode } from './sandbox/index.js';
import { applyFixes, type Applied } from './core/fix.js';
import { toJson } from './report/json.js';
import { renderRules, renderTerminal } from './report/terminal.js';
import { RULES } from './rules/index.js';
import { REPO_URL, VERSION } from './version.js';

/** Exit codes are a public contract: CI pipelines depend on them. */
export const EXIT = { ok: 0, problems: 1, usage: 2, environment: 3, stopped: 4 } as const;

const COMMANDS = ['check', 'rules', 'doctor', 'tasks', 'run', 'report', 'suggest', 'watch', 'help'];

interface CheckFlags {
  json?: boolean;
  fix?: boolean;
  cost?: boolean;
  strict?: boolean;
  quiet?: boolean;
}

const write = (text: string) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);

/** A path as the user would type it in a command: quoted when it has spaces or other special characters. */
function runCheck(dir: string, flags: CheckFlags): number {
  let run: CheckRun = check(dir);
  let fixed: Applied[] = [];
  if (flags.fix && run.fixable > 0) {
    fixed = applyFixes(run.root, run.issues);
    if (fixed.length) run = check(dir, { config: run.config }); // show what is left
  }

  const command = dir === '.' ? 'npx setupscore check' : `npx setupscore check ${asArg(dir)}`;
  if (flags.json) write(JSON.stringify(toJson(run, fixed), null, 2));
  else write(renderTerminal(run, { quiet: flags.quiet, cost: flags.cost, fixed, command }));

  if (run.errors > 0 || (flags.strict && run.warnings > 0)) return EXIT.problems;
  return EXIT.ok;
}

/** Edit distance, for "did you mean" suggestions. */
function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

/** The command a word was probably meant to be: a close spelling or the start of a name. */
export function closestCommand(word: string): string | undefined {
  const w = word.toLowerCase();
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of COMMANDS) {
    if (c === 'help') continue;
    const d = distance(w, c);
    const limit = c.length <= 4 ? 1 : 2;
    if ((d <= limit || (w.length >= 3 && c.startsWith(w))) && d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/**
 * Every command that takes a project folder checks it first, the same way: a folder that does
 * not exist, a file instead of a folder, or (for the default command) a mistyped command name.
 */
function projectFolder(dir: string, command: string, implicit = false): void {
  process.cwd(); // throws (uv_cwd) when the current folder was deleted: handleError says so
  let st;
  try {
    st = statSync(dir, { throwIfNoEntry: false });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOTDIR') throw err;
  }
  if (!st) {
    const bareWord = /^[a-z][\w-]*$/i.test(dir);
    const meant = implicit && bareWord ? closestCommand(dir) : undefined;
    if (meant)
      throw new UsageError(`Unknown command '${dir}'. Did you mean '${meant}'?`, [
        `Run: npx setupscore ${meant}`,
        'See every command: npx setupscore --help',
      ]);
    throw new UsageError(`Folder not found: ${dir}`, [
      'Check the path, or run the command inside your project folder.',
      ...(implicit && bareWord
        ? [`If "${dir}" is meant to be a command, see every command: npx setupscore --help`]
        : []),
    ]);
  }
  if (!st.isDirectory()) {
    const parent = dirname(dir);
    throw new UsageError(`${dir} is a file, not a folder.`, [
      `"setupscore ${command}" needs the project folder. Try: npx setupscore ${command}${parent === '.' ? '' : ` ${asArg(parent)}`}`,
    ]);
  }
}

const gitMissing = (command: string) =>
  new EnvironmentError('Git is not installed (or not on PATH).', [
    `"setupscore ${command}" reads your git history. Install git from https://git-scm.com and open a new terminal.`,
  ]);

function dubiousOwnership(path: string): EnvironmentError {
  return new EnvironmentError(
    `Git refuses to use the repository at ${path}: it belongs to another user ("dubious ownership").`,
    [
      `If you trust it, allow it:  git config --global --add safe.directory '${path}'`,
      'Or run setupscore as the user who owns the folder.',
    ],
  );
}

/** tasks, run and watch need a git repository that git is willing to read. Checked before anything else starts. */
async function requireGitRepo(dir: string, command: string): Promise<void> {
  const r = await runProgram('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 15_000 });
  if (r.error?.code === 'ENOENT') throw gitMissing(command);
  if (r.timedOut)
    throw new EnvironmentError('Git did not answer within 15 seconds.', [
      'Run "git status" in this folder to see what it is waiting for.',
    ]);
  if (r.error) throw r.error;
  if (r.code === 0) return;
  const said = `${r.stderr}\n${r.stdout}`;
  const problem = gitRepoProblem(said, dir);
  switch (problem.kind) {
    case 'dubious':
      throw dubiousOwnership(said.match(/dubious ownership in repository at '([^']+)'/)?.[1] ?? resolve(dir));
    case 'not-a-repo':
      throw new UsageError('This folder is not inside a git repository.', [
        '"setupscore tasks" and "setupscore run" build tasks from git history. Run them inside a repository.',
      ]);
    case 'bare':
      throw new UsageError('This is a bare repository: it has no working folder with files.', problem.fixes);
    default:
      throw new EnvironmentError(`${capitalize(problem.detail)}.`, problem.fixes);
  }
}

/** Checks shared by every command that runs project code: usage errors first, then this machine. */
async function beforeProjectCode(
  dir: string,
  command: string,
  flags: { sandbox: SandboxMode; yes?: boolean | undefined },
): Promise<void> {
  projectFolder(dir, command);
  assertSandboxModeAllowed(flags.sandbox, flags.yes);
  // Native Windows: refuse before downloading the sandbox runtime or creating anything.
  if (process.platform === 'win32' && flags.sandbox !== 'none') throw windowsRefusal();
  await requireGitRepo(dir, command);
}

function positiveInt(v: string, flag: string, max?: number, why = ''): number {
  const n = Number(v);
  if (!v.trim() || !Number.isInteger(n) || n < 1)
    throw new InvalidArgumentError(`${flag} must be a whole number above 0.`);
  if (max !== undefined && n > max) throw new InvalidArgumentError(`${flag} can be at most ${max}${why}.`);
  return n;
}

function positiveNumber(v: string, flag: string, example = '5 or 2.5', max?: number, why = ''): number {
  const n = Number(v);
  if (!v.trim() || !Number.isFinite(n) || n <= 0)
    throw new InvalidArgumentError(`${flag} must be a number above 0, for example ${example}.`);
  if (max !== undefined && n > max) throw new InvalidArgumentError(`${flag} can be at most ${max}${why}.`);
  return n;
}

function score0to100(v: string): number {
  const n = Number(v);
  if (!v.trim() || !Number.isFinite(n) || n < 0 || n > 100)
    throw new InvalidArgumentError('--fail-under must be a score from 0 to 100.');
  return n;
}

function sandboxMode(v: string): SandboxMode {
  if (v === 'auto' || v === 'os' || v === 'none') return v;
  throw new InvalidArgumentError('Use "auto", "os" or "none". Docker is not needed.');
}

function runId(flag: string) {
  return (v: string): string => {
    if (!v.trim())
      throw new InvalidArgumentError(
        `${flag} needs a run id, or "latest" for the newest run. "npx setupscore report" shows the run ids.`,
      );
    return v;
  };
}

/** The repeat limit: each repeat is another paid session for every task and setup. */
const MAX_REPEAT = 100;

export async function main(argv: string[]): Promise<number> {
  let code: number = EXIT.ok;
  const program = new Command('setupscore')
    .description(
      'Check your Claude Code setup: CLAUDE.md, rules, skills, agents, settings and .mcp.json.\n' +
        '"check" (the default) is free and offline: no AI calls, nothing leaves your machine.\n' +
        '"tasks" downloads your project\'s dependencies, and "run" and "watch" call Claude (paid).',
    )
    .version(VERSION, '-v, --version', 'print the version')
    .helpOption('-h, --help', 'show help')
    .showSuggestionAfterError(true)
    // Errors are printed by handleError, in the same style as every other message.
    .configureOutput({ outputError: () => {} })
    .exitOverride();

  /** A command whose usage errors remember which command they belong to (for the "--help" hint). */
  const command = (name: string, opts?: { isDefault?: boolean }) =>
    program
      .command(name, opts)
      .exitOverride((err) => {
        throw Object.assign(err, { commandName: name });
      })
      .option('--no-color', 'turn colours off');

  command('check', { isDefault: true })
    .description('find problems in the setup (default command)')
    .argument('[dir]', 'project folder', '.')
    .option('--json', 'print the result as JSON (for CI and other tools)')
    .option('--fix', 'fix broken paths that have a known safe replacement')
    .option('--cost', 'show how many tokens each file adds to your sessions')
    .option('--strict', 'exit with code 1 on warnings too, not just errors')
    .option('-q, --quiet', 'show errors only')
    .action((dir: string, flags: CheckFlags) => {
      // `setupscore chek` reaches here with "chek" as the folder: say it is not a command.
      const typed = argv.find((a) => !a.startsWith('-'));
      projectFolder(dir, 'check', typed !== 'check');
      code = runCheck(dir, flags);
    });

  command('rules')
    .description('list every rule and why it matters')
    .option('--json', 'print as JSON')
    .action((flags: { json?: boolean }) => {
      if (flags.json)
        write(
          JSON.stringify(
            RULES.map(({ id, severity, certainty, summary, why }) => ({ id, severity, certainty, summary, why })),
            null,
            2,
          ),
        );
      else write(renderRules());
    });

  const loadCfg = async (dir: string) => {
    const { RULE_IDS } = await import('./rules/index.js');
    return loadConfig(dir, RULE_IDS);
  };

  command('doctor')
    .description('check that this machine can run "tasks" and "run" (no Docker needed)')
    .argument('[dir]', 'project folder', '.')
    .option('--claude-bin <path>', 'path to Claude Code if it is not on PATH')
    .option('--json', 'print the result as JSON')
    .action(async (dir: string, flags: { json?: boolean; claudeBin?: string }) => {
      projectFolder(dir, 'doctor');
      const log = (m: string) => process.stderr.write(`${m}\n`);
      let claudeBin = flags.claudeBin;
      if (claudeBin === undefined) {
        try {
          claudeBin = (await loadCfg(dir)).agent?.bin;
        } catch {
          // a broken setupscore.yml is for "check" to report
        }
      }
      // Each check is printed as soon as it is known, so a slow machine shows progress.
      if (!flags.json) write(`${pc.bold('setupscore doctor')}\n\n`);
      let overrides: Config['tasks'];
      try {
        overrides = (await loadCfg(dir)).tasks;
      } catch {
        overrides = undefined;
      }
      const checks = await runDoctor(dir, log, {
        claudeBin,
        overrides,
        onCheck: flags.json ? undefined : (c) => write(renderCheck(c)),
      });
      if (flags.json) write(JSON.stringify({ schemaVersion: 1, checks }, null, 2));
      else write(renderDoctorSummary(checks));
      code = checks.some((c) => c.required && !c.ok) ? EXIT.environment : EXIT.ok;
    });

  command('tasks')
    .description('turn git history into test tasks, checked inside a sandbox')
    .argument('[dir]', 'project folder', '.')
    .option('--limit <n>', 'stop after this many valid tasks', (v) => positiveInt(v, '--limit'), 10)
    .option('--since <date>', 'only commits after this date, e.g. 2026-01-01 or "6 months ago"')
    .option('--sandbox <mode>', 'auto or os (the OS sandbox), or none (CI only)', (v) => sandboxMode(v), 'auto')
    .option(
      '--timeout <seconds>',
      'time limit for each test run',
      (v) => positiveNumber(v, '--timeout', '120 or 30.5', 86_400, ' seconds (one day)'),
      120,
    )
    .option('--yes', 'allow --sandbox none outside CI')
    .option('--json', 'print the result as JSON')
    .action(async (dir: string, flags: TasksFlags) => {
      await beforeProjectCode(dir, 'tasks', flags);
      const log = (m: string) => (flags.json ? process.stderr : process.stdout).write(`${m}\n`);
      const config = await loadCfg(dir);
      const outcome = await runTasks(dir, flags, config, log);
      if (flags.json)
        write(
          JSON.stringify(
            { schemaVersion: 1, file: outcome.file, sandbox: outcome.sandbox, ...outcome.result },
            null,
            2,
          ),
        );
      else write(renderTasksSummary(outcome));
      code = outcome.result.tasks.length > 0 ? EXIT.ok : EXIT.problems;
    });

  const runOptions = (cmd: Command, repeatHelp: string, repeatDefault?: number) =>
    cmd
      .option(
        '--repeat <n>',
        repeatHelp,
        (v) => positiveInt(v, '--repeat', MAX_REPEAT, ' (each repeat is another paid session for every task)'),
        repeatDefault,
      )
      .option('--budget <usd>', 'stop the whole run at this many US dollars', (v) => positiveNumber(v, '--budget'), 5)
      .option(
        '--attempt-budget <usd>',
        'stop one Claude session at this many dollars',
        (v) => positiveNumber(v, '--attempt-budget'),
        1.5,
      )
      .option('--max-turns <n>', 'turn limit for one Claude session', (v) => positiveInt(v, '--max-turns'), 30)
      .option(
        '--timeout <minutes>',
        'time limit for one Claude session',
        (v) => positiveNumber(v, '--timeout', '15 or 0.5', 1_440, ' minutes (one day)'),
        15,
      )
      .option('--concurrency <n>', 'Claude sessions at the same time', (v) => positiveInt(v, '--concurrency'), 2)
      .option('--limit <n>', 'use only the first n tasks', (v) => positiveInt(v, '--limit'))
      .option('--claude-bin <path>', 'path to Claude Code if it is not on PATH')
      .option('--sandbox <mode>', 'auto or os (the OS sandbox), or none (CI only)', (v) => sandboxMode(v), 'auto')
      .option('--fail-under <score>', 'exit with code 1 when setup A scores below this', (v) => score0to100(v))
      .option('--yes', 'start without asking (needed in CI)')
      .option('--json', 'print the result as JSON');

  /** Options typed on the command line (not defaults): a resumed run only changes those. */
  const explicitOptions = (cmd: Command) =>
    new Set(Object.keys(cmd.opts()).filter((k) => cmd.getOptionValueSource(k) === 'cli'));

  runOptions(
    command('run')
      .description('give each task to Claude Code with your setup(s) and score them')
      .argument('[dir]', 'project folder', '.')
      .option('--setup-a <ref>', 'setup A: "working" (your files now), "none", or a git ref', 'working')
      .option('--setup-b <ref>', 'setup B to compare with: "working", "none", or a git ref (e.g. main)')
      .option('--baseline', 'also run with no instructions at all, to measure what your setup adds')
      .option('--model <id>', "Claude model, e.g. claude-sonnet-5-5 (default: Claude Code's default)")
      .option('--tasks <file>', 'task file (default .setupscore/tasks.json; built automatically if missing)')
      .option('--resume <run-id>', 'continue a run that stopped (use "latest" for the newest)', runId('--resume')),
    'how many times to try each task with each setup',
    2,
  ).action(async (dir: string, flags: RunFlags, cmd: Command) => {
    await beforeProjectCode(dir, 'run', flags);
    flags.explicit = explicitOptions(cmd);
    const config = await loadCfg(dir);
    const log = (m: string) => (flags.json ? process.stderr : process.stdout).write(`${m}\n`);
    // startRun prints the JSON itself (also when the run stops early or fails, before it throws).
    const result = await startRun({ dir, flags, config, log, emitJson: (text) => write(text) });
    code = result.exitCode;
  });

  command('report')
    .description('show the results of a run again (terminal, html, markdown or json)')
    .argument('[dir]', 'project folder', '.')
    .option('--run <id>', 'which run (default: the latest)', runId('--run'))
    .option(
      '--format <format>',
      'terminal, html, markdown or json',
      (v) => {
        if (!['terminal', 'html', 'markdown', 'json'].includes(v))
          throw new InvalidArgumentError('Use terminal, html, markdown or json.');
        return v;
      },
      'terminal',
    )
    .option('--output <file>', 'write to a file instead of the screen')
    .option('--fail-under <score>', 'exit with code 1 when setup A scores below this', (v) => score0to100(v))
    .action((dir: string, flags: ReportFlags) => {
      projectFolder(dir, 'report');
      code = reportCommand(dir, flags, write);
    });

  command('suggest')
    .description('evidence-based changes to your setup, from a run')
    .argument('[dir]', 'project folder', '.')
    .option('--run <id>', 'which run (default: the latest)', runId('--run'))
    .option('--apply <id>', 'apply a suggestion to CLAUDE.md')
    .option('--json', 'print as JSON')
    .action((dir: string, flags: SuggestFlags) => {
      projectFolder(dir, 'suggest');
      code = suggestCommand(dir, flags, write);
    });

  runOptions(
    command('watch')
      .description('re-run an earlier run with a new model and show what changed')
      .argument('[dir]', 'project folder', '.')
      .requiredOption('--model <id>', 'the model to try, e.g. claude-opus-5-5')
      .option('--run <id>', 'the run to compare with (default: the latest)', runId('--run')),
    'how many times to try each task with each setup (default: the same as the run it is compared with)',
  ).action(async (dir: string, flags: WatchFlags) => {
    await beforeProjectCode(dir, 'watch', flags);
    const config = await loadCfg(dir);
    // Same number of repeats as the run it is compared with, unless you choose otherwise.
    flags.repeat ??= 0;
    const log = (m: string) => (flags.json ? process.stderr : process.stdout).write(`${m}\n`);
    code = await watchCommand(dir, flags, config, log);
  });

  program.addHelpText(
    'after',
    `
Examples:
  npx setupscore                  check the current folder
  npx setupscore check ../api     check another folder
  npx setupscore --fix            fix broken paths that moved or were renamed
  npx setupscore --cost           see what loads into every session
  npx setupscore --json           machine-readable output for CI
  npx setupscore check --help     every option for check
  npx setupscore doctor           check this machine for "tasks" and "run"
  npx setupscore tasks            turn git history into test tasks
  npx setupscore run              give the tasks to Claude Code and score your setup
  npx setupscore run --setup-b main --baseline   compare with main and with no instructions
  npx setupscore report --format html --output report.html
  npx setupscore suggest          evidence-based changes to CLAUDE.md

Exit codes: 0 ok, 1 problems found or score below --fail-under, 2 bad usage or config,\n3 environment problem (see setupscore doctor), 4 stopped early (budget or Ctrl+C; use --resume).
Docs and issues: ${REPO_URL}`,
  );

  try {
    // `setupscore help nope`: commander would print the main help and succeed.
    if (argv[0] === 'help' && argv[1] !== undefined && !argv[1].startsWith('-') && !COMMANDS.includes(argv[1])) {
      const meant = closestCommand(argv[1]);
      throw new UsageError(`Unknown command '${argv[1]}'.${meant ? ` Did you mean '${meant}'?` : ''}`, [
        ...(meant ? [`Run: npx setupscore help ${meant}`] : []),
        'See every command: npx setupscore --help',
      ]);
    }
    await program.parseAsync(argv, { from: 'user' });
    return code;
  } catch (err) {
    return handleError(err);
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Commander's usage errors, rewritten as sentences with a next step. */
function commanderMessage(err: CommanderError & { commandName?: string }): { title: string; fixes: string[] } {
  const cmd = err.commandName;
  const helpHint = cmd
    ? `See every option: npx setupscore ${cmd} --help`
    : 'See every command and option: npx setupscore --help';
  const raw = err.message.replace(/^error:\s*/i, '').trim();
  const [first = '', ...rest] = raw.split('\n');
  const suggestion = rest.join(' ').match(/\(Did you mean (.+?)\?\)/)?.[1];
  const longFlag = (spec: string) => spec.match(/--[\w-]+/)?.[0] ?? spec;
  switch (err.code) {
    case 'commander.unknownOption': {
      const flag = first.match(/'([^']+)'/)?.[1] ?? first;
      return {
        title: `Unknown option '${flag}'${cmd ? ` for "setupscore ${cmd}"` : ''}.`,
        fixes: [...(suggestion ? [`Did you mean ${suggestion}?`] : []), helpHint],
      };
    }
    case 'commander.invalidArgument': {
      const m = first.match(/^option '([^']+)' argument '([\s\S]*)' is invalid\.([\s\S]*)$/);
      if (m)
        return {
          title: `The value '${m[2]}' for ${longFlag(m[1]!)} is invalid. ${capitalize(m[3]!.trimStart())}`,
          fixes: [helpHint],
        };
      return { title: capitalize(first), fixes: [helpHint] };
    }
    case 'commander.missingMandatoryOptionValue': {
      const spec = first.match(/'([^']+)'/)?.[1] ?? '';
      return {
        title: `Missing required option '${spec}'.`,
        fixes: [...(cmd === 'watch' ? ['For example: npx setupscore watch --model claude-opus-5-5'] : []), helpHint],
      };
    }
    case 'commander.optionMissingArgument': {
      const spec = first.match(/'([^']+)'/)?.[1] ?? '';
      return { title: `The option '${spec}' needs a value.`, fixes: [helpHint] };
    }
    case 'commander.excessArguments':
      return {
        title: capitalize(first),
        fixes: [...(cmd && cmd !== 'rules' ? ['A folder name with spaces needs quotes around it.'] : []), helpHint],
      };
    default:
      return {
        title: capitalize(first.replace(/\.$/, '')) + '.',
        fixes: [...(suggestion ? [`Did you mean ${suggestion}?`] : []), helpHint],
      };
  }
}

/** A path for a message: relative to the current folder when it is inside it. */
function shown(p: string | undefined): string {
  if (!p) return 'a file';
  // writeFileAtomic's temp file (".tasks.json.123.ab12cd34.tmp") stands for the file being written.
  p = p.replace(/(^|[\\/])\.([^\\/]+)\.\d+\.[0-9a-f]+\.tmp$/, '$1$2');
  try {
    return isAbsolute(p) ? displayPath(p) : p;
  } catch {
    return p; // the current folder is gone
  }
}

/**
 * Errors from the operating system (disk full, no permission, too many open files, a file in the
 * way) are problems with this machine, not bugs: say which path and what to do. Null for others.
 */
function systemMessage(e: NodeJS.ErrnoException & { dest?: string }): { title: string; fixes: string[] } | null {
  if (typeof e?.code !== 'string' || typeof e.syscall !== 'string') return null;
  const path = shown(e.path);
  const dest = e.dest ? shown(e.dest) : undefined;
  switch (e.code) {
    case 'ENOSPC':
      return {
        title: `The disk is full${e.path ? ` (writing ${path})` : ''}.`,
        fixes: ['Free some space and try again. A run that stopped continues with: npx setupscore run --resume latest'],
      };
    case 'EACCES':
    case 'EPERM':
      return {
        title: `No permission to use ${path}.`,
        fixes: [
          'Check the permissions of that file or folder (and that it is not locked or marked read-only). Do not run setupscore with sudo.',
        ],
      };
    case 'EROFS':
      return {
        title: `${capitalize(path)} is on a read-only file system, so setupscore cannot write it.`,
        fixes: ['Run setupscore on a copy of the project in a folder you can write to.'],
      };
    case 'EMFILE':
    case 'ENFILE':
      return {
        title: `Too many open files${e.path ? ` (while opening ${path})` : ''}.`,
        fixes: [
          e.code === 'EMFILE'
            ? 'Raise the limit for this terminal (for example: ulimit -n 4096), then try again.'
            : 'The whole system is out of file handles: close other programs, then try again.',
        ],
      };
    case 'ENOENT':
      if (e.syscall === 'mkdtemp')
        return {
          title: `The temporary folder ${shown(dirname(e.path ?? ''))} does not exist.`,
          fixes: ['Check TMPDIR (TEMP on Windows): it must point to a folder that exists.'],
        };
      return {
        title: `${capitalize(path)} does not exist.`,
        fixes: ['It may have been moved or deleted while setupscore was running. Check the path and try again.'],
      };
    case 'EEXIST':
      if (e.syscall === 'mkdir')
        return {
          title: `Cannot create the folder ${path}: a file with that name is in the way.`,
          fixes: ['Move or delete that file, then try again.'],
        };
      return {
        title: `${capitalize(path)} already exists and is in the way.`,
        fixes: ['Move or delete it, then try again.'],
      };
    case 'ENOTDIR':
      return {
        title: `Cannot use ${path}: part of that path is a file, not a folder.`,
        fixes: ['Check the path (and SETUPSCORE_CACHE_DIR or TMPDIR if you set them), then try again.'],
      };
    case 'EISDIR':
      return {
        title: `${capitalize(path)} is a folder, but setupscore expected a file there.`,
        fixes: ['Move or rename that folder, then try again.'],
      };
    case 'EXDEV':
      return {
        title: `Cannot move ${path}${dest ? ` to ${dest}` : ''}: they are on different disks.`,
        fixes: ['Keep the project and its .setupscore folder on one disk (one mount), then try again.'],
      };
    case 'EBUSY':
      return {
        title: `${capitalize(path)} is in use by another program.`,
        fixes: ['Close programs that may use it (an editor, a virus scanner, a running test), then try again.'],
      };
    default:
      return null;
  }
}

/** One place that turns every failure into a short message, the steps to fix it and an exit code. */
export function handleError(err: unknown): number {
  const say = (title: string, fixes: string[] = []) => {
    // Lines that start with spaces continue the fix above them, so they get no arrow.
    const lines = fixes.map((f) => (/^\s/.test(f) ? `    ${f.trimStart()}` : `  ${pc.dim('→')} ${f}`));
    process.stderr.write(`${pc.red('✖')} ${title}\n${lines.join('\n')}${lines.length ? '\n' : ''}`);
  };
  if (err instanceof CommanderError) {
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version' || err.code === 'commander.help')
      return EXIT.ok;
    const { title, fixes } = commanderMessage(err);
    say(title, fixes);
    return EXIT.usage;
  }
  if (err instanceof UsageError) {
    say(err.message, err.fixes);
    return EXIT.usage;
  }
  if (err instanceof ConfigError) {
    say(err.message, ['Fix the file, or delete it to use the defaults. See "Configuration" in the README.']);
    return EXIT.usage;
  }
  if (err instanceof EnvironmentError) {
    say(err.message, err.fixes);
    return EXIT.environment;
  }
  if (err instanceof StoppedEarly) {
    say(err.message, err.fixes);
    return EXIT.stopped;
  }
  if (err instanceof NothingToDo) {
    say(err.message, err.fixes);
    return EXIT.problems;
  }
  const e = err as NodeJS.ErrnoException & { fixes?: unknown; dest?: string };
  const message = e instanceof Error ? e.message : String(err);

  // git refuses a repository that belongs to another user.
  const dubious = message.match(/dubious ownership in repository at '([^']+)'/);
  if (dubious || /detected dubious ownership/.test(message)) {
    const d = dubiousOwnership(dubious?.[1] ?? '<the project folder>');
    say(d.message, d.fixes);
    return EXIT.environment;
  }
  // A program setupscore starts is missing (git.ts keeps only the message, so look at both).
  const spawned =
    e?.code === 'ENOENT' && typeof e.syscall === 'string' && e.syscall.startsWith('spawn')
      ? (e.path ?? e.syscall.slice(6))
      : message.match(/spawn (\S+) ENOENT/)?.[1];
  if (spawned) {
    const name = spawned.replace(/^.*[\\/]/, '').replace(/\.(?:cmd|exe)$/i, '');
    if (name === 'git') {
      say(gitMissing('tasks').message, [
        'setupscore reads your git history. Install git from https://git-scm.com and open a new terminal.',
      ]);
    } else {
      say(`${name} is not installed (or not on PATH).`, [
        name === 'npm'
          ? 'npm comes with Node.js: install Node.js 22.12 or newer from https://nodejs.org'
          : 'Install it and open a new terminal.',
      ]);
    }
    return EXIT.environment;
  }
  // Errors from git with their own message and fix (src/tasks/git.ts).
  if (e?.name === 'GitError') {
    say(
      message,
      Array.isArray(e.fixes) ? (e.fixes as string[]) : ['Run "git status" in the project folder to see what is wrong.'],
    );
    // Pointing setupscore at the wrong place is a usage problem; a broken git or machine is not.
    const kind = (e as { kind?: string }).kind;
    return kind === 'folder-not-found' || kind === 'not-a-repo' || kind === 'bare-repo' || kind === 'no-commits'
      ? EXIT.usage
      : EXIT.environment;
  }
  if (e instanceof Error && /not a git repository/i.test(message)) {
    say('This folder is not inside a git repository.', [
      '"setupscore tasks" and "setupscore run" build tasks from git history. Run them inside a repository.',
    ]);
    return EXIT.usage;
  }
  if (e instanceof Error && /must be run in a work tree|unknown repository extension/i.test(message)) {
    const p = gitRepoProblem(message, '.');
    say(`${capitalize(p.detail)}.`, p.fixes);
    return p.kind === 'bare' ? EXIT.usage : EXIT.environment;
  }
  if (e instanceof Error && /does not have any commits yet/.test(message)) {
    say('This repository has no commits yet, so there is no history to build tasks from.', [
      'Commit your work first, then run the command again.',
    ]);
    return EXIT.usage;
  }
  // git's own words ("fatal: …", "error: …"), passed on by src/tasks/git.ts: a problem with the
  // repository or this machine, not a bug in setupscore.
  if (e instanceof Error && /^(?:fatal|error): /.test(message)) {
    say(`Git failed: ${message}`, [
      'Run "git status" in the project folder to see what is wrong, fix it, then run the command again.',
    ]);
    return EXIT.environment;
  }
  if (e instanceof Error && message.startsWith('Folder not found')) {
    say(message, ['Check the path, or run the command inside your project folder.']);
    return EXIT.usage;
  }
  if (e?.syscall === 'uv_cwd') {
    say('The current folder no longer exists (it was deleted or moved).', [
      'Go to your project folder again (cd) and run the command there.',
    ]);
    return EXIT.environment;
  }
  const sys = systemMessage(e);
  if (sys) {
    say(sys.title, sys.fixes);
    return EXIT.environment;
  }
  say(`Something went wrong inside setupscore: ${message}`, [
    'This is a bug, not something you did. Please report it with the command you ran:',
    `${REPO_URL}/issues`,
    ...(process.env['SETUPSCORE_DEBUG'] ? [] : ['Run again with SETUPSCORE_DEBUG=1 to see the details.']),
  ]);
  if (process.env['SETUPSCORE_DEBUG']) process.stderr.write(`${(e as Error)?.stack ?? String(err)}\n`);
  return EXIT.usage;
}
