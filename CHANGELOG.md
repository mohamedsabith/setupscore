# Changelog

All notable changes to this project are documented here. The project follows [Semantic Versioning](https://semver.org/). The command line, exit codes, `setupscore.yml` and the JSON output (`schemaVersion`) are the public API.

## 1.0.0 - 2026-11-06

First release.

- `setupscore check`: an offline linter for Claude Code setups (CLAUDE.md, CLAUDE.local.md, `@imports`, `.claude/rules`, skills, agents, commands, `settings.json`, `.mcp.json`).
- 16 rules: `broken-reference`, `broken-import`, `missing-script`, `invalid-config`, `secret`, `risky-permission`, `env-not-denied`, `mcp-config`, `contradiction`, `vague-rule`, `duplicate-rule`, `too-long`, `deep-import`, `unused-path-rule`, `skill-frontmatter`, `agent-frontmatter`.
- `--fix` for paths to files that were renamed in git history or moved.
- `--cost` estimates how many tokens each file adds to every session.
- `--json` output with `schemaVersion: 1`.
- `setupscore.yml` to change rule levels and ignore paths, set test and install commands, add registry hosts, and choose how `run` starts Claude Code (`agent.bin`, `agent.model`); `<!-- setupscore-disable-next-line -->` comments.
- `setupscore rules` lists every rule.
- A programmatic API: `import { check } from 'setupscore'`.
- `setupscore tasks` turns git history into test tasks. Each candidate commit's tests must fail before the change and pass after it. Everything runs in the operating system's sandbox (macOS Seatbelt, or bubblewrap on Linux and WSL2) through Anthropic's sandbox runtime, with **no Docker**. Tests get no network and no access to secrets, and the runtime is installed once into setupscore's cache on first use.
- `setupscore run` gives each task to Claude Code (`claude -p`) inside the sandbox, once per setup and repeat, and checks the result with the commit's hidden tests.
  - Compare your working setup, another git ref (`--setup-b`) and no setup at all (`--baseline`).
  - Setup Score (0–100): task success, rule following, consistency, cost per solved task and instruction health. Each success rate has a 95% range, and a difference is called real only when the ranges don't overlap.
  - A whole-run budget, a per-session budget, turn and time limits, and a cost estimate with a confirmation before anything is spent.
  - API overload, rate limits and network errors are retried and never counted against a setup. A missing Claude Code, a rejected key or no credit stops the run at once.
  - Ctrl+C, SIGTERM, SIGHUP or the end of the budget stops cleanly; `--resume` continues without repeating finished attempts.
  - Claude runs with a fresh, empty `CLAUDE_CONFIG_DIR`, so personal settings never affect the result. It signs in with `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), a gateway or Bedrock.
  - Claude can't look up the answer: the clone has no branches, tags, remote or reflog, your real project folder and its git metadata are hidden by the sandbox, and an attempt that digs through the shared git objects counts as failed.
  - The hidden tests run the commit's way: its tests, test helpers and test settings, its test command, and untouched dependencies, after a fresh install if Claude changed them.
  - Results are plain JSON files in `.setupscore/runs/<id>/`, with full transcripts and HTML, Markdown and JSON reports.
- `setupscore report` shows a run again as terminal text, HTML, Markdown or JSON, with `--fail-under` for CI.
- `setupscore suggest` proposes changes to CLAUDE.md based on what went wrong in a run, and `--apply <id>` makes one.
- `setupscore watch --model <id>` re-runs a run with another model and shows which tasks got worse.
- `setupscore doctor` checks Node.js, git, the sandbox (with a live test), the package manager, Claude Code and its sign-in.
- A GitHub Action (`action.yml`) for `check` or `run`, which keeps one results comment up to date on the pull request.
- Exit codes: 0 ok, 1 problems, 2 usage, 3 environment, 4 stopped early. Every error says what happened and what to do next.

Changes from end-to-end testing before the release:

### Security

- Claude can no longer fake a pass. It works on a copy of `node_modules` that is thrown away before the hidden tests, so a fake `node` in `node_modules/.bin` or an edited package doesn't count. The commit's tests, test helpers, fixtures, snapshots, test runner config files, `package.json` test fields and `.npmrc` are put back from the commit before the tests run. A test file replaced by a link (for example to `/dev/null`) is removed and written again.
- Your real project folder and its git metadata (`HEAD`, branches, tags, reflog, config) are hidden in every phase of an attempt (install, Claude's session and the hidden tests), not only while Claude works. Only its git objects stay readable, because the clone shares them.
- Digging for the answer is caught in more ways: the text Claude writes into files is checked too, as are `/proc` lookups and `GIT_ALTERNATE_OBJECT_DIRECTORIES`. The real folder is matched however it is spelled on macOS (case, Unicode form, `/private/tmp`).
- Claude gets its own package cache, so it can't poison the shared cache that later installs use, and it can't read `~/.npmrc`. AWS keys are passed to Claude Code only when `CLAUDE_CODE_USE_BEDROCK` is set.
- More secret locations are hidden from sandboxed commands: cloud and deploy tool logins (Netlify, Vercel, Cloudflare Wrangler, Fly, DigitalOcean, Oracle Cloud, Stripe, Terraform), Cargo and RubyGems credentials, `~/.pgpass`, `~/.my.cnf`, the Claude desktop app's config, Firefox, Chrome and Chromium profiles, macOS cookies, and shell start-up and history files.
- Run results are private: `setupscore run` creates `.setupscore/` and run folders with mode 0700 and writes files with mode 0600. Credentials are removed from saved transcripts.
- Run ids are checked, so `--run`, `--resume` and `.setupscore/latest` can't read or write outside `.setupscore/runs`. Run results files are written atomically and never through a symbolic link.

### Changed

- Setup Score: rule following only counts solved attempts, so a setup that solves nothing keeps only its health points. A setup with no scored attempt has no score (`-`), and `--fail-under` fails when setup A has none. A run in which no attempt could be scored exits with code 3 instead of 0.
- Instruction health in a run uses your `setupscore.yml` rules and ignore list, like `setupscore check`.
- The budget only stops new sessions from starting. Sessions already running finish and count, because they are already paid for. Each session's limit is capped at what is left, and the resume hint suggests a budget that covers what was spent plus what is left.
- `--resume` keeps the run's settings. Only `--budget`, `--concurrency` and `--timeout` can change; other run options are ignored with a warning. It shows what is left and what was spent, and asks before spending (add `--yes`). Only one process can work on a run at a time; a second one is refused.
- `setupscore run` saves the tasks it builds to `.setupscore/tasks.json`, so the next run reuses them.
- `setupscore run` with no usable tasks exits with code 1, like `setupscore tasks`.
- `setupscore tasks` checks each commit with its test helpers and test settings in place, and runs the same test command before and after the change. It looks at more candidate commits, and doesn't retry an install that failed for commits with the same dependencies.
- On macOS, sandboxed commands may bind and reach `localhost`, so tests that start a local server work. See the limits in `docs/sandbox.md`.
- Every workspace has its own temp folder (`TMPDIR`, `TMP`, `TEMP`), so attempts don't share temp files.
- Run ids use UTC time.

### Fixed

- Ctrl+C, SIGTERM and SIGHUP stop a run cleanly and save its results; a second signal quits at once and kills every process setupscore started. A run is no longer left marked "running" after it stops or fails, and no process is left running after setupscore exits.
- Processes that a sandboxed command leaves running in the background are killed when the command ends.
- A session that finished normally is no longer treated as a rejected key or a billing problem because of words in Claude's final message. Claude Code that can't start inside the sandbox ("not found", exit code 127, "Cannot find module") stops the run at once.
- The cost of retried sessions counts toward the budget and the run's total. Negative costs are ignored.
- Results are no longer lost after a crash or a full disk: a new line is never glued onto a half-written one, damaged lines and files are reported clearly, and an unexpected error in one attempt is recorded while the run goes on.
- A tests folder replaced by a link fails that attempt only, instead of stopping the run.
- A workspace with files made unchangeable (`chflags uchg`, `chattr +i`) is cleaned up, or left behind with its path, instead of crashing the run.
- Piping the output into `head`, or a full disk, no longer stops a run before it saves its results.
- `--resume ''` is refused instead of starting a new run.
- `setupscore tasks`: a sandbox that breaks part way stops with a clear message instead of rejecting every commit, and a test command in watch mode is named in the timeout reason.
- Claude Code installed in a common folder whose path has spaces ("/Users/Jane Doe/...") is found.
- Wording: "1 session", "1 warning", "1 of 2 attempts passed" (attempts, not tasks), "N points below", and short retry waits shown in milliseconds.
