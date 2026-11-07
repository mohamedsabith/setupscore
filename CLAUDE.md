# setupscore

TypeScript CLI that lints Claude Code setups (CLAUDE.md, .claude/, .mcp.json) and scores them on real tasks from git history. Offline: no network and no AI calls in `check`.

## Commands

- `npm run build`: bundle with tsup into dist/
- `npm test`: builds, then runs vitest (unit tests plus CLI tests against dist/cli.js)
- `npm run typecheck`: strict TypeScript check
- `npm run check-all`: every check before a commit (format, lint, types, layers, unused code, tests, API report, package)
- `node dist/cli.js check examples/bakery-api`: try it on the broken example

## Layout

- src/core/: discovery, markdown parsing, config, git, fixes, cost, `check()`
  - lifecycle.ts: signals (Ctrl+C, SIGTERM, SIGHUP), graceful stop (`shutdown.signal`), killing child processes on exit
  - fsx.ts: `writeFileAtomic()`, private folders, safe reads of damaged or huge files
  - redact.ts: `redact()` removes credentials from run text (transcripts, reasons, test output)
- src/rules/: one file per rule; register new rules in src/rules/index.ts
- src/report/: terminal and JSON output for check; terminal, HTML, Markdown and JSON reports for run
- src/sandbox/: OS sandbox without Docker (Anthropic sandbox runtime, installed on first use)
- src/tasks/: git history to tasks; every command that runs project code goes through a Sandbox and a Policy
  - testsetup.ts: puts the commit's tests, test helpers and test settings back before tests run (used by tasks and run)
- src/agent/: Claude Code adapter (find, sign-in, headless command, transcript parsing, failure classes)
- src/run/: setups, JSON results store, attempt runner, checks, scoring, suggestions
- src/commands/: doctor, tasks, run, report, suggest, watch
- test/fixtures/fake-claude.mjs: stands in for `claude -p` in tests; tests never call the real API
- test/helpers.ts: `makeRepo()` builds throwaway projects for tests

## Rules for changes

- Every rule needs a test for what it catches and a test for what it must not flag.
- Never print a full secret; use `mask()` from src/core/secrets.ts.
- Exit codes and JSON output (schemaVersion 1) are a public contract: only add fields.
- Only attach a `fix` to an issue when there is exactly one correct replacement.
- Before changing how a rule matches, run it on a few real repos that use Claude Code and read every finding.
- User-facing text is plain English: what is wrong, why it matters to Claude, how to fix it.
- Sandboxed commands must run asynchronously (runShell), never with spawnSync: the network filter lives in our process.
- Keep test/sandbox.test.ts passing: it proves a malicious test cannot escape.
- User-facing errors are NothingToDo (1), UsageError (2), EnvironmentError (3) or StoppedEarly (4), each with a fix. API and network problems are retried and never count against a setup.
- Never write a results file without `writeFileAtomic()` from src/core/fsx.ts. attempts.jsonl is the one append-only file. Never lose results: every run can be resumed.
- All user-visible run text (transcripts, attempt reasons, test output, messages) goes through `redact()` from src/core/redact.ts.
- Commands that can stop cleanly call `enableGracefulStop()` from src/core/lifecycle.ts and pass `shutdown.signal` down; other commands quit at the first signal. Project and agent commands go through runShell, which tracks them so they are killed on exit.
- The agent must never be able to fake a pass: before hidden tests, give back the original node_modules (`returnDependencies()`) and call `restoreTestSetup()`.
