# Contributing to setupscore

Thank you for helping. The most useful contributions are:

1. **False-alarm reports.** setupscore flagged something that is fine? Open a [false-alarm issue](https://github.com/mohamedsabith/setupscore/issues/new?template=2-false-alarm.yml) with the flagged line. A linter that people turn off helps nobody, so precision matters more than recall here.
2. **Real problems it missed**, with a small example ([missed problem](https://github.com/mohamedsabith/setupscore/issues/new?template=3-missed-problem.yml)).
3. **New rules**, with evidence that the problem makes Claude Code do a worse job.
4. **Fixes and tests** for open issues. Look for [`good first issue`](https://github.com/mohamedsabith/setupscore/labels/good%20first%20issue) and [`help wanted`](https://github.com/mohamedsabith/setupscore/labels/help%20wanted).

Everyone who takes part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Questions go to [Discussions](https://github.com/mohamedsabith/setupscore/discussions) (see [SUPPORT.md](SUPPORT.md)). Security problems are reported privately (see [SECURITY.md](SECURITY.md)).

## Before you start

- **Search** the [issues](https://github.com/mohamedsabith/setupscore/issues?q=is%3Aissue) and [discussions](https://github.com/mohamedsabith/setupscore/discussions) first.
- **Small fixes** (a typo, a clear bug with an obvious fix, a missing test): open a pull request directly.
- **Anything bigger** (a new rule, a new flag, a change in how the score works): open an issue or an [Ideas discussion](https://github.com/mohamedsabith/setupscore/discussions/categories/ideas) first, and wait until a maintainer agrees. This saves you from writing code that can't be merged.
- **Changes to the public contract** (commands, flags, exit codes, `setupscore.yml`, the JSON output, the library API, the Action's inputs and outputs) are always discussed first. See [GOVERNANCE.md](GOVERNANCE.md#how-decisions-are-made).
- Want an issue? Comment on it, so others know you are working on it.

## Quick start

```bash
git clone https://github.com/<you>/setupscore     # your fork
cd setupscore
nvm use                  # the Node.js version in .nvmrc (or fnm, volta)
npm ci                   # installs dependencies and the git hooks
npm run check-all        # every check: format, lint, types, layers, unused code, tests, API, package
node dist/cli.js check examples/bakery-api       # try it on the example, which is broken on purpose
```

## Development setup

**Node.js.** Development uses the version in `.nvmrc`. The build and lint tools need a newer Node.js than setupscore itself, which runs on 22.12 or newer.

**The sandbox.** `tasks`, `run` and their tests need the OS sandbox:

- macOS: nothing to install.
- Linux and WSL2: `sudo apt-get install bubblewrap socat ripgrep` (or dnf, pacman).
- Native Windows: the sandbox tests are skipped. Use WSL2 to work on `tasks` or `run`.

Check your machine with `node dist/cli.js doctor`.

**Scripts.**

| Command | What it does |
| --- | --- |
| `npm run build` | Bundle `src/` into `dist/` with tsup |
| `npm test` | Build, then run every test |
| `npm run test:fast` | Only the core and rule unit tests. Takes seconds. Use it while you work |
| `npm run lint` | ESLint with type information (typescript-eslint strict), regex safety (ReDoS) and Node checks. Fails on any warning. There is no `lint:fix`: an automatic regex fix can change what a rule matches, so fix each finding by hand and check it with the tests and `npm run corpus` |
| `npm run format` | Format every file with Prettier. `npm run format:check` only checks |
| `npm run typecheck` | `tsc --noEmit` with strict settings (see `tsconfig.json`) |
| `npm run deps` | [dependency-cruiser](https://github.com/sverweij/dependency-cruiser): no import loops, and each folder of `src/` only imports the layers below it (see `.dependency-cruiser.mjs`) |
| `npm run knip` | [Knip](https://knip.dev): unused files, exports and dependencies |
| `npm run api` | [API Extractor](https://api-extractor.com): fails when the public library API (`dist/index.d.ts`) differs from `api/setupscore.api.md`. After an intended change, run `npm run api:update` and commit the new report |
| `npm run check:package` | [publint](https://publint.dev) and [Are the Types Wrong](https://arethetypeswrong.github.io) on the packed package: what users install resolves and has its types |
| `npm run coverage` | Tests with a coverage report in `coverage/` |
| `npm run check-all` | Every check above, in order. Run it before you open a pull request |

**Editor.** Editors read `.editorconfig`. Install the Prettier and ESLint extensions to see the same results as `npm run check-all` while you type.

### Git hooks

`npm ci` installs one [Husky](https://typicode.github.io/husky/) hook, commit-msg: [commitlint](https://commitlint.js.org) checks that the message is a Conventional Commit (see `commitlint.config.js`). Skip it once with `git commit --no-verify`, or turn it off with `HUSKY=0`.

## Commit messages and pull request titles

setupscore uses [Conventional Commits](https://www.conventionalcommits.org): `type(scope): subject`. Start the subject with a lowercase word (names such as Claude or README keep their capitals), write it in the imperative ("add", not "added"), and end it without a period.

```text
feat(rules): flag MCP servers without a pinned version
fix(run): keep finished results after Ctrl+C
fix(rules): stop flagging paths to build output as missing
perf(check): read each file only once
docs(sandbox): explain the macOS localhost limits
test(tasks): cover pnpm workspaces
chore(deps-dev): bump eslint from 10.13.0 to 10.14.0
feat!: drop Node.js 22
```

- **Types:** `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`, `revert`.
- **Scopes** are optional. Use one from [commitlint.config.js](commitlint.config.js), for example `rules`, `check`, `run`, `sandbox`, `action`, `deps`. If a new area needs a new scope, add it there in the same pull request.
- **Breaking changes:** put `!` after the type or scope (`feat!:` or `feat(cli)!:`). Explain what breaks, and what users should do, in the pull request description.

Pull requests are **squash-merged**. The pull request title becomes the one commit on `main`, and that title decides the next release:

| Title starts with                                           | Release | Example       |
| ----------------------------------------------------------- | ------- | ------------- |
| `fix`, `perf`                                               | Patch   | 1.0.0 → 1.0.1 |
| `feat`                                                      | Minor   | 1.0.1 → 1.1.0 |
| any type with `!`                                           | Major   | 1.1.0 → 2.0.0 |
| `docs`, `test`, `refactor`, `build`, `ci`, `chore`, `style` | None    |               |

So choose the title with care. A check on every pull request enforces the format. The commit messages on your branch can be anything (the commit-msg hook still asks for the format locally). How releases work is in [RELEASING.md](RELEASING.md).

## Pull requests

1. **Fork** the repository and create a branch from `main`, for example `fix/broken-reference-dist`.
2. **Make one change per pull request.** Smaller pull requests are reviewed faster.
3. **Add tests** (see [Tests](#tests)) and update the docs if users will notice the change: `README.md`, `docs/`, and `docs/rules.md` for rules. Don't edit `CHANGELOG.md` or the version in `package.json`: the maintainer updates them for each release.
4. **Run `npm run check-all`.**
5. **Open the pull request.** Use a Conventional Commit title, fill in the template, and link the issue (`Fixes #123`). Open it as a draft if you want early feedback.
6. **Checks.** CI runs the tests on Linux, macOS and Windows with Node 22 and 24, plus every other check in `npm run check-all`. Another check makes sure the title is a Conventional Commit. All of them must pass before merging.
7. **Review.** A maintainer looks at new pull requests within a week. Answer review comments yourself, and push new commits to the same branch.
8. **Merge and release.** A maintainer squash-merges the pull request. It is published with the next release (see [RELEASING.md](RELEASING.md)).

A pull request with no activity for a long time may be closed. You can always reopen it.

## Project layout

```text
src/
  cli.ts, main.ts   entry point, commands, flags, exit codes
  core/             discovery, markdown parsing, config, git, fixes, check(), redact(), safe file writes
  rules/            one file per rule, registered in rules/index.ts
  report/           check output (terminal, JSON) and run reports (terminal, HTML, Markdown, JSON)
  sandbox/          the OS sandbox (no Docker): runtime loader, policies, safe environment
  tasks/            git history to tasks, workspace clones, package managers
  agent/            the Claude Code adapter: finding it, the headless command, transcripts, failure types
  run/              setups, the results store, the attempt runner, checks, scoring, suggestions
  commands/         doctor, tasks, run, report, watch
test/               vitest. helpers.ts builds throwaway projects. fixtures/fake-claude.mjs stands in for Claude Code
docs/               rules.md, run.md, sandbox.md
action.yml          the GitHub Action
examples/           a project that is broken on purpose
```

The full map, and the rules for changing code, are in [AGENTS.md](AGENTS.md). Claude Code and other coding agents read the same file.

## Adding a rule

1. Create `src/rules/<rule-id>.ts`. Export a `Rule` with `id`, `severity`, `summary`, `why` and `check(ctx)`.
2. Register it in `src/rules/index.ts`.
3. Add tests to `test/rules.test.ts`: at least one for what it **catches**, and one for what it **must not flag**.
4. Document it in `docs/rules.md` and in the rules table in `docs/reference.md`.
5. Add the rule id to the **Rule** lists in `.github/ISSUE_TEMPLATE/2-false-alarm.yml` and `.github/ISSUE_TEMPLATE/3-missed-problem.yml`.
6. Run it on real repositories that use Claude Code, and read every finding. `npm run corpus` checks the repositories in `scripts/corpus-repos.txt` with the newest release and with your build, and prints every finding that was added or removed (`-- --base 1.0.0 --limit 10` to choose the version and the count). If more than a rare one is wrong, make the rule stricter or make it a warning. Say which repositories you tried in the pull request.

A new rule is a `feat(rules): ...` pull request, so it ships in a minor release.

Rules for rules:

- Messages use plain words: what is wrong, why it matters to Claude, and how to fix it.
- Never print a full secret. Use `mask()` from `src/core/secrets.ts`.
- Only offer an automatic fix when there is exactly one correct answer.
- `check` makes no network requests and no AI calls, and never runs project code.

## Tests

- **Every bug fix comes with a test** that fails without the fix.
- **Every rule** has tests for what it catches and what it must not flag. Most bugs in a linter are false alarms, so the "must not flag" tests matter most.
- **Build test projects with `makeRepo()`** from `test/helpers.ts`. Tests never touch the real repository or your home folder.
- **No network and no real Claude API.** `test/fixtures/fake-claude.mjs` behaves like `claude -p --output-format stream-json`. Its mode decides what it does: for example `solve`, `needs-claude-md`, `break-rule`, `auth-fail` or `overloaded-once`. The `cheat-*` modes try to fake a pass or look up the answer.
- **Every protection has a test that attacks it.** When you add a protection against cheating, add a `cheat-*` mode to the fake Claude and a test in `test/run.test.ts` that proves it is caught. `test/sandbox.test.ts` runs a malicious test file that must not escape. Keep it passing.
- **Fake secrets only.** Use values that are clearly fake, such as `sk-ant-api03-TESTKEY0123456789abcdef`. GitHub's push protection blocks commits that contain real-looking keys.
- **Every OS.** setupscore runs on Linux, macOS and Windows. Use `node:path` to build paths. For tests that only work on some systems, use `it.skipIf(...)` or `it.runIf(...)`, and say why.
- **No flaky tests.** Don't depend on timing, the current date or the order of files on disk.

To try a real run, set `ANTHROPIC_API_KEY` and keep the budget small:

```bash
node dist/cli.js run --limit 1 --repeat 1 --budget 1
```

To try a mode of the fake Claude by hand, pass it with `--claude-bin "node test/fixtures/fake-claude.mjs <mode>"`.

## Rules for code

The full list is in [AGENTS.md](AGENTS.md). The most important ones:

- Every error a user can hit is a `NothingToDo` (exit 1), `UsageError` (exit 2), `EnvironmentError` (exit 3) or `StoppedEarly` (exit 4). Each has a message that says what happened and a fix that says what to do.
- A problem with the API or the network is retried and never counted against a setup.
- Anything that runs project code goes through `openSandbox()` and an explicit `Policy`, and runs asynchronously (`runShell`), never with `spawnSync`.
- All user-visible run text (transcripts, attempt reasons, test output) goes through `redact()` from `src/core/redact.ts`.
- Write results files with `writeFileAtomic()` from `src/core/fsx.ts`. Never lose finished results: every run can be resumed.
- The agent must never be able to fake a pass or read the answer.

## Writing docs and messages

Many users read English as a second language, or use a translator. So:

- One idea per sentence. Short sentences.
- Common words: "use", not "utilize". "Check", not "validate".
- No idioms, jokes or wordplay.
- Active voice and "you": "setupscore hides your `.env` files".
- American English spelling.
- Every code block has a language tag (`bash`, `yaml`, `text`).
- Link text says where it goes: "see [the sandbox docs](docs/sandbox.md)", never "click here".

## Using AI tools

setupscore is built for people who code with AI agents, and you are welcome to use them here. There are three rules.

1. **Say so.** In the pull request template, tick the AI box and name the tool. In an issue, say if AI helped write it.
2. **You own it.** You have read, run and understood every line, and you can explain it. You answer review comments yourself, not by pasting them into an agent and back.
3. **A person in charge.** We don't accept pull requests from bulk or unattended agents, for example an agent pointed at our issue list whose output is forwarded without a person reviewing it. A pull request is welcome only if a named person chose the issue, checked the change, and will handle the review.

Issues and false-alarm reports must describe something you really saw: paste real output. Pull requests that look generated and break these rules, and reports we can't reproduce, are closed without a full review.

Using a translator or a grammar tool for your text is fine. Please write the description in your own words.

**Coding agents:** read [AGENTS.md](AGENTS.md) first, and follow the rules above.

## License

setupscore is under the [MIT license](LICENSE). There is no contributor license agreement. When you open a pull request, you agree that your contribution is under the same license.
