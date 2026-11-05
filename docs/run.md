# setupscore run: does your setup actually help Claude?

`setupscore check` tells you what is broken in your instructions. `setupscore run` measures whether they work. It gives real tasks from your git history to Claude Code, once with each setup you want to compare, and checks the result with hidden tests.

```bash
npx setupscore doctor                       # is this machine ready?
npx setupscore run                          # your current setup, 2 tries per task
npx setupscore run --baseline               # ...and Claude with no instructions, to see what yours add
npx setupscore run --setup-b main           # your changes against the main branch
npx setupscore report --format html --output report.html
npx setupscore suggest                      # evidence-based changes to CLAUDE.md
```

## What happens in a run

1. **Tasks.** setupscore reads `.setupscore/tasks.json`. If there is none, it builds tasks from your git history first, as [`setupscore tasks`](../README.md#turn-git-history-into-test-tasks) does, and saves them to `.setupscore/tasks.json` so the next run reuses them. Each task is a past commit whose tests fail before the change and pass after it.
2. **Setups.** A setup is every `CLAUDE.md`, the `.claude/` folder (rules, skills, agents, commands, `settings.json`) and `.mcp.json`. Personal files (`CLAUDE.local.md`, `settings.local.json`) are never included.
   - `--setup-a` (default `working`) is your files as they are now, uncommitted changes included.
   - `--setup-b <ref>` is another setup from a branch, tag or commit, for example `main` or `HEAD~5`.
   - `--baseline` adds Claude with **no** instructions, so you see what your setup adds.
3. **Attempts.** For every task, setup and repeat, setupscore:
   1. checks out the commit _before_ the task in a throwaway clone, with the task's tests hidden,
   2. replaces that commit's setup with the setup under test,
   3. installs dependencies,
   4. gives Claude its own copy of `node_modules`,
   5. runs Claude Code headless (`claude -p`) in the sandbox with the task as the prompt.
4. **Checks.** After Claude finishes, its copy of `node_modules` is thrown away and the original comes back. Then the hidden tests run with no network, the way the commit itself ran them. These are put back from the commit first:
   - the commit's test files,
   - its test helpers, mocks, fixtures and snapshots (files in folders such as `test/`, `__tests__/`, `__mocks__/`, `fixtures/` or `__snapshots__/`),
   - its test runner config files in the project folder (Jest, Vitest, Vite, Mocha, AVA, Playwright, Babel, c8, nyc, tap and Bun configs, `.npmrc`, `.yarnrc`). A config file the commit doesn't have is removed,
   - the test settings in `package.json`: `scripts` and the `jest`, `vitest`, `mocha`, `ava`, `tap`, `c8`, `nyc` and `babel` fields.

   The tests run with the command recorded when the task was built. So Claude can't pass by editing a test, a helper, the test script, the runner config or a package in `node_modules`. If Claude changed the dependencies (in `package.json` or the lockfile), they are installed fresh first, as CI would. The tests decide pass or fail. setupscore also records:
   - which "never use X" rules from your instructions Claude's new code broke,
   - whether Claude ran the tests itself,
   - which files it changed,
   - the skills it used, its turns, time and cost.

5. **Score and report.** Results go to `.setupscore/runs/<run-id>/`. That folder holds `run.json`, `attempts.jsonl`, the full transcripts, `report.html`, `report.md` and `results.json`.

### Your results on disk

- **Private.** `setupscore run` creates `.setupscore/` and each run folder so that only your user can open them (mode 0700), and writes its files readable only by you (0600). Transcripts hold your code.
- **No credentials.** Before a transcript is saved, the values of the keys and tokens in your environment (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, AWS keys, `GITHUB_TOKEN`, `NPM_TOKEN` and similar) and anything shaped like an Anthropic, GitHub, AWS or npm key are replaced with `[redacted]`. So a session that ran `env` doesn't put your key on disk.
- **Never half-written.** Files are written to a temporary file and then renamed, so a crash or a full disk leaves the old file or the new one, never half of each. `attempts.jsonl` only grows: one line each time an attempt ends. A damaged line is skipped with a warning.

## The Setup Score

| Part | Points | What it measures |
| --- | --: | --- |
| Task success | 40 | Hidden tests pass after Claude's change |
| Rule following | 20 | In the attempts Claude solved, its new code keeps your "never use `X`" rules (only code-like rules are checked) |
| Consistency | 15 | A task Claude solved once is solved on every repeat (needs `--repeat 2` or more) |
| Efficiency | 15 | Cost per solved task, compared with the cheapest setup in the run (needs two setups) |
| Instruction health | 10 | From `setupscore check`, with your `setupscore.yml` (left out for "no setup", which has no files) |

A part a run can't measure is left out, and the others are scaled up, so the score is always out of 100. Every part except health rewards solved attempts. Rule following only counts attempts Claude solved, so keeping a rule while solving nothing earns nothing. A setup that solves nothing keeps only its health points, however cheap or consistent its failures are.

Attempts that hit an infrastructure problem are not scored (see below). A setup with no scored attempt has no score: the report shows `-`. With `--fail-under`, setup A then fails the check (exit code 1). If no attempt in the whole run could be scored, `setupscore run` exits with code 3 and tells you how to try them again with `--resume`.

Each success rate comes with a **95% range** (a Wilson interval). setupscore calls a difference real only when the ranges don't overlap: between two setups it then names a winner, and against the baseline it says your setup clearly helps (or gets in Claude's way). Otherwise it says the difference could be chance and suggests more repeats. Five tasks with 2 repeats show big differences; small ones need more tasks or repeats.

Infrastructure problems are retried up to 2 times and **never count against a setup**: API overload, rate limits, network errors, a failed install. A session that was retried still cost money, so its cost counts toward the budget and the run's total.

## Cost and limits

Every session is a real Claude Code session, billed to your key or subscription. setupscore shows the plan and an estimate, and asks before it starts; add `--yes` in CI.

| Option | Default |  |
| --- | --- | --- |
| `--repeat <n>` | 2 | Tries per task per setup |
| `--budget <usd>` | 5 | No new session starts once the run has spent this; finished results are kept |
| `--attempt-budget <usd>` | 1.5 | One session stops here (`--max-budget-usd`) |
| `--max-turns <n>` | 30 | One session's turn limit |
| `--timeout <minutes>` | 15 | One session's time limit |
| `--concurrency <n>` | 2 | Sessions at the same time |
| `--limit <n>` | all | Use only the first n tasks |
| `--model <id>` | Claude Code's default | Model to test (or `agent.model` in `setupscore.yml`) |
| `--claude-bin <path>` | `claude` on your PATH | How to start Claude Code (or `agent.bin` in `setupscore.yml`) |

**How the budget works.** A new session starts only if there is money left after the sessions already running. Each session's own limit is also capped at what is left, so the run can't go far past the budget. When the budget is used up, no new session starts. Sessions that are already running finish and count, because they are already paid for. Then the run stops with exit code 4 and prints a `--resume` command with a `--budget` big enough for what was spent plus what is left.

## Stopping and resuming

Press Ctrl+C to stop a run. setupscore starts no new sessions, ends the running sessions, saves every finished result and exits with code 4. SIGTERM (for example when a CI job is cancelled) and SIGHUP (the terminal was closed) do the same. A second Ctrl+C or signal quits at once: setupscore kills every process it started and marks the run as stopped. Either way, nothing keeps running or spending money after setupscore is gone.

Continue a stopped run with `npx setupscore run --resume <run-id>` (or `--resume latest`):

- Finished attempts are never repeated. Attempts that hit an infrastructure problem or were stopped run again.
- The run keeps its settings: tasks, setups, repeats, model, turn limit and per-session budget. Only `--budget`, `--concurrency` and `--timeout` can change. Other run options are ignored with a warning; start a new run to change them.
- setupscore shows how many attempts are left and what was spent so far, and asks before it spends more. Add `--yes` in CI.
- Only one setupscore process can work on a run at a time. A second one is refused. If the first one died, its lock is taken over.

## Signing in

The sandbox can't see your normal Claude login (it lives in your keychain or home folder, which the sandbox hides). Give setupscore a key or token in the environment:

```bash
export ANTHROPIC_API_KEY=sk-ant-...            # pay per use, from console.anthropic.com
# or, to use your Claude subscription:
claude setup-token                             # prints a long-lived token
export CLAUDE_CODE_OAUTH_TOKEN=...
```

`ANTHROPIC_BASE_URL` (a gateway) and Amazon Bedrock (`CLAUDE_CODE_USE_BEDROCK` with AWS keys in the environment) also work. AWS keys are passed to Claude Code only when `CLAUDE_CODE_USE_BEDROCK` is set. On Linux, a gateway running on your machine's `localhost` can't be reached from inside the sandbox, because the sandbox has its own network.

## Safety

Claude runs with `--dangerously-skip-permissions`, because nobody is there to approve prompts. That is only safe because the session runs inside the [OS sandbox](sandbox.md):

- **Writes:** only the throwaway workspace (the clone and its own temp folder) and the few temp and log folders the sandbox always allows are writable. The clone's `.git` is read-only.
- **Package cache:** Claude gets its own package cache in the workspace, so it can't change the shared cache that later installs use.
- **Dependencies:** Claude works on a copy of `node_modules` that is thrown away before the hidden tests. A fake `node` in `node_modules/.bin` or an edited package can't fake a pass.
- **Network:** only the Claude API (or your gateway or Bedrock) and your package registries can be reached.
- **Secrets:** `~/.ssh`, cloud and deploy credentials, `~/.npmrc`, shell history and your real `.env` are hidden. See the [full list](sandbox.md#what-is-hidden).
- **Environment:** only the key or token Claude needs is passed in.
- **Personal settings:** `CLAUDE_CONFIG_DIR` points at a fresh, empty folder, so your personal `~/.claude` settings, memory and plugins never leak in. Only the project's own setup is tested.
- **Processes:** when a command ends, anything it left running is killed, and when setupscore exits, so is every process it started.

Transcripts contain your code and Claude's output, and are saved in `.setupscore/` with credentials removed. Add `.setupscore/` to `.gitignore`.

## Keeping the answer out of reach

Every task is a commit that really happened, so the answer exists somewhere on your machine. A test bench is only fair if Claude can't simply look it up:

- **No pointers to later commits.** The clone Claude works in has no branches, tags, remote or reflog. Commands such as `git log --all`, `git branch -a`, `git show origin/main:file` or `git reflog` only show history up to the task. The task is checked out on a branch called `main`.
- **Your real project is hidden.** Your project folder is at a later commit, so it holds the answer. Its files and its git metadata (`HEAD`, branches, tags, reflog, config) are hidden in every phase of an attempt: the install, Claude's session and the hidden tests. Only two things in it stay readable: its git objects, because the clone shares them, and its `node_modules`, which may hold Claude Code itself.
- **Digging is caught.** Because the git objects are shared, an agent that deliberately goes through them could still find a later commit. So setupscore checks every command Claude ran, every file path it read or edited, and the text it wrote into files. The attempt counts as **failed**, with the reason shown, if any of them:
  - mentions your real project folder,
  - mentions the shared object store (`.git/objects/info/alternates`),
  - lists every object (`--batch-all-objects`, `git fsck`),
  - points git at another git folder or object store (`--git-dir`, `GIT_DIR=`, `GIT_OBJECT_DIRECTORY=`, `GIT_ALTERNATE_OBJECT_DIRECTORIES=`),
  - reads process details from `/proc` (such as `/proc/<pid>/cwd`, `/proc/self/mountinfo`, `cmdline` or `environ`), which could reveal your real folder.
- **What this can't catch.** The check reads Claude Code's transcript, where real Claude Code records every command it runs and every file it reads or writes. A fake or modified `claude` program that hides what it does can't be caught this way. The check also only looks for known ways to dig, so treat it as a strong guard, not a proof.
- **`.git` is read-only.** Claude can look at history and diffs, but it can't commit or switch branches. If your instructions say "commit when done", that step fails the same way for every setup, so the comparison stays fair.

## Limits

- JavaScript and TypeScript projects only (npm, pnpm, Yarn or Bun), like `setupscore tasks`.
- macOS, Linux and WSL2. Native Windows has no supported sandbox yet.
- A task is only as good as the commit's tests: a commit whose tests check little makes an easy task. `setupscore tasks` already rejects commits whose tests pass before the change.
- The prompt is written from the commit title, the files involved and the names of the new tests. It is clearer than many real requests, so absolute success rates run high. Comparisons between setups are what matter.
- Claude Code only for now. Codex and Cursor are planned.

## Exit codes

| Code | Meaning |
| --: | --- |
| `0` | The run finished, and setup A met `--fail-under` if you gave it |
| `1` | Setup A scored below `--fail-under` or has no scored attempt, or there are no usable tasks |
| `2` | Bad usage, for example an unknown flag or run id, or you answered "no" when asked to start |
| `3` | An environment problem (no sandbox, Claude Code missing, key rejected, no credit), or no attempt could be scored |
| `4` | The run stopped early (budget used up, Ctrl+C, SIGTERM or SIGHUP); continue it with `--resume` |

## Comparing models: setupscore watch

```bash
npx setupscore watch --model claude-sonnet-5-5
```

`watch` re-runs the tasks and setups of your latest run (or `--run <id>`) with another model, then shows each setup's score before and after, and the tasks that got worse. Use it before switching your team to a new model.

## In CI

```yaml
# .github/workflows/setupscore.yml
name: setupscore
on: [pull_request]
permissions:
  contents: read
  pull-requests: write   # for the results comment
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0     # tasks come from git history
      - uses: mohamedsabith/setupscore@v1
        with:
          command: run
          args: --setup-b origin/main --limit 5 --budget 3 --fail-under 60
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

The action posts the results as a pull request comment, and updates the same comment on every push. It only ever posts the results of the run that just finished: if a run stops before it has results (for example with no key), nothing is posted. The results also go into the job summary, so they show up for `push` and `schedule` runs too. If the comment can't be posted, for example because the job has no `pull-requests: write` permission, the action warns and the job result still comes from setupscore.

Secrets are not available to pull requests from forks, so `run` only works for branches in your own repository: without a key or token, the action stops before installing anything and says so. Use `command: check` for everything else; it's free. `run` needs Linux or macOS runners, because native Windows has no sandbox.

`args` is split into words like a shell does, so quotes work (`--claude-bin "node ./agent.mjs"`), but nothing is expanded: no `*`, `$VAR` or `$(...)`. To pin versions, set `version` (setupscore, default `1`, the newest `1.x`) and `claude-code-version` (default `latest`).
