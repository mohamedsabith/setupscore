<!--
Thank you for contributing. Please read CONTRIBUTING.md first.
For anything bigger than a small fix, open an issue or an Ideas discussion before you write code.

Title: a Conventional Commit, for example "fix(rules): stop flagging URLs as missing paths".
Pull requests are squash-merged, so the title becomes the commit on main and picks the next version:
fix or perf -> patch, feat -> minor, "!" after the type (feat!: ...) -> major. docs, test, refactor, build, ci, chore -> no release.
-->

## What and why

<!-- One or two sentences in your own words: what changes for users, and why. A translator is fine. -->

Fixes #

## Type of change

- [ ] Bug fix
- [ ] False-alarm fix (a rule flagged something that is fine)
- [ ] New or changed rule
- [ ] New feature or flag
- [ ] Docs
- [ ] Tests, CI, build, dependencies or refactoring

## How I tested it

<!-- The commands you ran. For rule changes: which real repositories you ran it on, and the findings before and after. If you added no tests, say why. -->

## Checklist

- [ ] `npm run check-all` passes (format, lint, types, unused code, tests, package checks)
- [ ] Bug fixes: a test that fails without the fix
- [ ] Rule changes: tests for what it catches **and** what it must not flag, and I ran it on a real repository that uses Claude Code and read every finding
- [ ] New rule: added to `docs/rules.md`, the README rules table, and the Rule lists in `.github/ISSUE_TEMPLATE/2-false-alarm.yml` and `3-missed-problem.yml`
- [ ] Users will notice: `README.md` and `docs/` are updated (don't edit `CHANGELOG.md` or the version: the release writes them)
- [ ] The public contract (commands, flags, exit codes, `setupscore.yml`, JSON output, library API, Action inputs and outputs) only gained things, or the title has `!` and this description explains the break
- [ ] No real secrets in tests, fixtures or output

## AI assistance

<!-- AI tools are welcome here. Tick one box. See "Using AI tools" in CONTRIBUTING.md. -->

- [ ] I did not use AI tools for this change.
- [ ] I used AI tools: <!-- name them, for example Claude Code --> . I have read, run and understood every line, and I will answer review comments myself.
