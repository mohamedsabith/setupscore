# Roadmap

What we are working on, what comes next, and what we don't plan to do. Dates are not promises: setupscore has one maintainer.

## How this roadmap works

- Ideas start in [Discussions: Ideas](https://github.com/mohamedsabith/setupscore/discussions/categories/ideas).
- An accepted idea becomes an issue with the `roadmap` label, and usually a milestone named after the version that should ship it (for example `v1.2.0`).
- Changes to the public contract are discussed first, as described in [GOVERNANCE.md](GOVERNANCE.md#how-decisions-are-made).
- This page is updated with each minor release.

Want to help with an item? Comment on its issue before you start, so two people don't build the same thing.

## Now

The goal is to make the first version reliable: few false alarms, and scores you can trust.

- **Fewer false alarms in `check`.** Run `check` on the setups of well-known public repositories in CI, and fix every wrong finding. For example, paths to build output (`dist/`) that git ignores.
- **`AGENTS.md` as part of a Claude Code setup.** Claude Code reads `AGENTS.md` when a folder has no `CLAUDE.md`. `check` should lint it, and `run` should include it in a setup and remove it for the baseline.
- **Prove that the setup loaded.** Before an attempt is scored, check from Claude Code's transcript that it loaded the instruction files and skills of the setup under test. If it didn't, don't score the attempt.
- **A stable Setup Score.** Clear verdicts, honest 95% ranges, and no infrastructure problems counted against a setup.
- **The GitHub Action.** A written trust model, and installing Claude Code with its native installer.
- **Release and supply chain.** Automatic releases with npm provenance, OpenSSF Scorecard, and pinned dependencies and actions.

## Next

- **Agent adapters.** One interface for everything that differs between agents: which files they read, how to run them headless, their transcripts, their cost and budget. Then the same tasks and the same score for:
  - **Codex** (`AGENTS.md`, `.agents/skills`, `codex exec --json`): first, because it shares files with Claude Code.
  - **Cursor** (`.cursor/rules/*.mdc` and the Cursor CLI).
  - **Gemini CLI** (`GEMINI.md`). Gemini CLI became enterprise-only in June 2026, so we will check who still uses it before we build this.
- **Setups for several agents in `check`.** Find instructions that disagree between `CLAUDE.md`, `AGENTS.md` and `.cursor/rules`, and hooks that exist for one agent but not another.
- **SARIF output** (`check --format sarif`), so findings show up in GitHub code scanning and in editors.
- **A JSON Schema for `setupscore.yml`**, for completion and checks in editors.
- **A docs site**, built from the same `docs/` files and published on GitHub Pages.

## Later

- `tasks` and `run` for Python and Go projects.
- A history of Setup Scores over time, shared across a team.
- A native Windows sandbox, so `tasks` and `run` work without WSL2.
- An OpenCode adapter.
- `setupscore init`: write `setupscore.yml`, add `.setupscore/` to `.gitignore`, and offer a CI workflow.

## Not planned

Writing these down saves everyone time. If you think one of them should change, start a discussion and explain why.

| Not planned | Why |
| --- | --- |
| A hosted service, or an account | setupscore runs on your machine and in your CI. Your code and your key stay with you |
| Telemetry or analytics | We don't collect anything, and we don't want to start |
| Changing your setup without your choice | `suggest` shows changes with the evidence behind them. You choose what to apply. setupscore never edits your instructions on its own |
| A public leaderboard of repositories | A Setup Score compares setups **within one repository**. Scores from different repositories can't be compared |
| A general model benchmark | setupscore measures your setup on your tasks. `watch` compares models on your own tasks, and that is all it is for |
| Running `run` on pull requests from forks | It would need your API key in code from a stranger. `check` is free and safe for forks |
| Docker or virtual machines as the default sandbox | The OS sandbox starts in milliseconds and needs nothing extra. We will keep it the default |

## Stability

From 1.0.0, setupscore follows [Semantic Versioning](https://semver.org). The public contract is:

- commands and flags, and exit codes,
- the `setupscore.yml` format,
- the JSON output (`schemaVersion`),
- the library API (`import { check } from 'setupscore'`),
- the inputs and outputs of the GitHub Action.

Within a major version, these only gain things: nothing is renamed or removed. New rules can be added in a minor version, so a new finding can appear after an update. Pin an exact version if you need the same findings every time. How releases work is in [RELEASING.md](RELEASING.md).
