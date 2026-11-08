# Changelog

All notable changes to this project are documented here. The project follows [Semantic Versioning](https://semver.org/). The command line, exit codes, `setupscore.yml` and the JSON output (`schemaVersion`) are the public API.

## 1.1.1 - 2026-11-08

### Changed

- Releases are published with npm trusted publishing: npm only accepts a new version from this repository's release workflow, and no npm token is stored anywhere. Nothing changes in the package itself; `npm audit signatures` still verifies its provenance.

## 1.1.0 - 2026-11-08

### Added

- New rule `wrong-package-manager` (warning): your instructions say "use pnpm" or `yarn add x`, but the project's lockfile or `packageManager` says npm (or any other mix). Claude tends to follow the instructions over the lockfile, runs the wrong tool and can leave a second lockfile. It only reports when every lockfile and `packageManager` agree, follows `cd` in code blocks, and leaves alone tools named for contrast ("pnpm, NOT npm"), global installs, `npx`, CI and Docker lines, and install lines for the package's own users. On 114 public repositories it found 2 problems, both real. Each finding lowers the health score by 0.5, and `--strict` fails on it. Turn it off with `rules: { wrong-package-manager: off }` in `setupscore.yml`. See [docs/rules.md](docs/rules.md#wrong-package-manager).
- The library also exports the types `FixFailure`, `Frontmatter`, `Line`, `MisnamedFile` and `SkippedFile`. Its functions already used them, so TypeScript users can now name them.

### Changed

- The library's types now say that some optional properties can hold `undefined`, as they already could at runtime: `Issue.fix`, `Issue.line`, `Fix.column`, `FixFailure.code`, `Frontmatter.error`, `SetupFile.frontmatter`, `.importDepth`, `.importedBy` and `.realPath`, the `tasks`, `sandbox` and `agent` settings in `Config`, and `fixed[].column` in `JsonReport`. Nothing changes unless your project uses TypeScript's `exactOptionalPropertyTypes`, which now sees these types correctly.

### Fixed

- Hints that show a folder to paste into a shell (`setupscore tasks ...`) now quote it with `'...'` when it contains `$`, `` ` ``, `!` or a control character. Inside `"..."` the shell changed those, so the pasted command used a different folder. Found by the new property-based tests.

### Changed (development only, nothing changes for users)

- New checks in `npm run check-all`: security lint rules (eslint-plugin-security), import rules (eslint-plugin-import-x), folder layers (dependency-cruiser), unused code (Knip), the public API report (API Extractor), package checks (publint, Are the Types Wrong), property-based tests (fast-check) and stricter TypeScript settings.
- Commit messages are checked with commitlint in a Husky commit-msg hook.
- Removed code that nothing used.
- Fixed all 255 lint findings that were put aside in `eslint-suppressions.json`, and deleted that file. Regular expressions were only rewritten where the new one matches exactly the same text (checked on generated input for every changed expression).
- TypeScript is stricter: `exactOptionalPropertyTypes` and `noPropertyAccessFromIndexSignature` are on. The built JavaScript is the same as before.

## 1.0.4 - 2026-11-07

### Security

- Fixed a slowdown (ReDoS) in `setupscore check`: one crafted line in a setup file, for example `password=a` followed by many `<` characters, made the secret check take time that grows with the square of the line length (11.8 seconds for 200,000 characters, minutes for a 2 MB file). A pull request could use it to stall a CI job that runs `check`. Now that line takes 0.1 seconds, and the largest file setupscore reads takes under 0.2 seconds.
- Fixed 19 more regular expressions with the same kind of slowdown, found with eslint-plugin-regexp. They read the test output of the project (`tasks` and `run`), `.yarnrc.yml`, workspace patterns, task prompts, Claude's transcripts and some messages. Crafted test output of 1 MB could stall `tasks` or `run` for minutes.
- Every fix gives exactly the same results as before. New tests compare the old and the new code on thousands of generated inputs, and on 111 public repositories the findings are the same as in 1.0.3.

### Changed

- `SECURITY.md` now describes only the protections this repository really has: one Release workflow that starts on version tags, no workflow for pull requests, and npm provenance on every release.

## 1.0.3 - 2026-11-07

### Added

- New rule `broken-hook` (warning): a hook in `.claude/settings.json` or `.claude/settings.local.json` that can never run as written, following Claude Code's hooks reference. It reports:
  - a wrong shape: `"hooks"` that isn't an object, an event that isn't a list, or a handler written without the `{ "matcher", "hooks": [...] }` wrapper;
  - an event name in the wrong letter case or with a close typo (`pretooluse`, `PreToolUs`). Names far from every known event are left alone;
  - a matcher that isn't one string, a regular expression that doesn't compile, `mcp__server` without `__.*`, a built-in tool name in the wrong case (`bash`), or a matcher on an event that has none;
  - a handler with no or a misspelled `type`, a missing `command`, `url`, `server`, `tool` or `prompt`, a `timeout` that isn't a number of seconds above 0, or `if` on an event that isn't a tool event;
  - a script under `${CLAUDE_PROJECT_DIR}` that doesn't exist (with a stronger warning for `python3` and `sh`, which exit with code 2, the "block" code), or that the hook runs directly while git stores it as not executable.

  New warnings lower instruction health by 0.5 each and fail `--strict`; turn the rule off with `rules: { broken-hook: off }` in `setupscore.yml`.

## 1.0.2 - 2026-11-07

### Added

- New rule `agents-md-not-loaded` (warning). Claude Code 2.1.277 and newer reads `AGENTS.md` on its own, but by default only when there is no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md`. The rule reports an `AGENTS.md` (or `.claude/AGENTS.md`) that Claude never reads:
  - next to a `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` that doesn't import it or link to it, including one that only mentions `AGENTS.md` in words or is empty;
  - in a subfolder, when the project root has a `CLAUDE.md` and the subfolder has no `CLAUDE.md` that imports it (many such subfolders give one warning);
  - when `CLAUDE.md` is a link that git saved as a plain file whose only text is `AGENTS.md` (Windows, or `core.symlinks` off). `--fix` turns that text into `@AGENTS.md`.

  It doesn't report an `AGENTS.md` without a `CLAUDE.md`, one that is imported or linked (either way), an empty one, or `AGENTS.local.md`, `AGENTS.override.md` and files under `.agents/`, which Claude never reads. New warnings lower instruction health by 0.5 each and fail `--strict`; turn the rule off with `rules: { agents-md-not-loaded: off }` in `setupscore.yml`.

## 1.0.1 - 2026-11-07

### Fixed

- `unused-path-rule` matches `paths:` patterns the way Claude Code does. A pattern without a slash (`*.md`, `*.test.ts`, `Dockerfile`, `package.json`) matches files at any depth under the rule's base folder, and a pattern that starts with a slash (`/*.md`, `/src/*.ts`) matches only from the base folder. Before, `*.md` matched only files at the top, and every pattern that started with a slash counted as matching nothing, so rules that do load were reported as "never loads". This fix only removes wrong warnings; it never adds new ones.
- `unused-path-rule` skips a pattern such as `/node_modules/**` that starts with a slash and a folder setupscore doesn't read, the same way it already skipped `node_modules/**`.

### Changed

- The README is rewritten in plain English for everyone: what setupscore does, why you need it, install in 3 steps, how to read the output, measuring with `setupscore run`, using it on GitHub, common problems and an FAQ. The banner, demo GIF and screenshot stay.
- Every command, option and setting moved from the README to the new `docs/reference.md`: the rules table, files it reads, `--fix`, `--cost`, `setupscore tasks`, `setupscore.yml`, CI and the GitHub Action, exit codes, the JSON output and the library API. It is included in the npm package.
- The FAQ explains when setupscore checks `AGENTS.md`: when `CLAUDE.md` imports it (`@AGENTS.md`) or is a link to it. Claude Code 2.1.277 and newer also reads `AGENTS.md` on its own when a project has no `CLAUDE.md`; setupscore doesn't check that case yet.
- `docs/reference.md` says the GitHub Action's `version` input defaults to `1` (the newest 1.x), as `action.yml` does.
- `docs/run.md` links to `docs/reference.md` for how tasks are built.

### Added

- For contributors: `npm run corpus` (`scripts/corpus-diff.mjs`) runs `setupscore check --json` on public repositories (`scripts/corpus-repos.txt`, or `--repos <file>`) with a released version (`--base`) and with your build, and prints every finding that was added or removed. `CONTRIBUTING.md` explains it, and says that a new rule goes in the rules table in `docs/reference.md`.

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
