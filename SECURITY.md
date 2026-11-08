# Security policy

setupscore runs code from other people's repositories, and in `run` it lets an AI agent work with permission prompts turned off. The sandbox and the hidden tests are what make that safe and fair. This page explains what setupscore protects, what counts as a vulnerability, and how to report one.

## Report a vulnerability

**Don't open a public issue, discussion or pull request for a security problem.**

1. **Preferred:** report it privately on GitHub: [Report a vulnerability](https://github.com/mohamedsabith/setupscore/security/advisories/new) (the **Security** tab of this repository).
2. **If that doesn't work for you:** email **mohamedsabithmp@gmail.com** with "setupscore security" in the subject.

Please include:

- the setupscore version (`npx setupscore --version`),
- your OS and its version, your Node.js version and, for `run`, your Claude Code version (`claude --version`),
- the output of `npx setupscore doctor --json`,
- the exact command, and the smallest repository or files that show the problem,
- what you expected setupscore to block, and what happened instead,
- what an attacker could do with it.

You may use AI tools to find a problem or to write the report. But you must reproduce the problem yourself and paste real output. We close reports that we can't reproduce, and reports that are unchecked AI output.

## What happens next

| Step | When |
| --- | --- |
| We confirm that we received your report | Within 7 days |
| We tell you if we accept it, and how serious we think it is | Within 14 days |
| Fix released | Within 90 days. We aim for 30 days for a sandbox escape or a leaked secret |
| Updates while we work on it | At least every 14 days |

setupscore has one maintainer, so these are targets, not promises. We will tell you if we need more time.

When the fix is released, we publish a [GitHub Security Advisory](https://github.com/mohamedsabith/setupscore/security/advisories), and request a CVE when the problem is serious enough. We credit you by name, unless you ask us not to. Please keep the problem private until the advisory is published. If we can't fix it within 90 days, we agree on a disclosure date with you.

## Supported versions

| Version            | Security fixes               |
| ------------------ | ---------------------------- |
| Newest 1.x release | Yes                          |
| Older 1.x releases | No: update to the newest 1.x |
| 0.x                | Never published to npm       |

Fixes ship as a new patch or minor release. `npm install setupscore@1` and the GitHub Action at `mohamedsabith/setupscore@v1` always get the newest 1.x. When a new major version comes out, its release notes say how long the previous major version gets security fixes.

## Security model

setupscore treats the repository it works on as **untrusted**. That includes the project's code, its install scripts and tests, its setup files (`CLAUDE.md`, `.claude/`, hooks, skills, `.mcp.json`), and everything Claude Code writes or runs during `run`. setupscore **trusts** you, your machine, your operating system, Claude Code itself, the [sandbox runtime](https://github.com/anthropics/sandbox-runtime) and your package registry.

| Command | What it does | Runs project code? | Network |
| --- | --- | --- | --- |
| `check` | Reads setup files. Runs `git ls-files` and `git log` locally. With `--fix`, changes only the path on the reported line | No | None |
| `doctor` | Checks that the sandbox works by starting a test command in it | No | The npm registry once, to install the pinned sandbox runtime |
| `tasks` | Installs dependencies and runs tests in a throwaway clone, inside the OS sandbox | Yes, in the sandbox | Install: your package registries only. Tests: none |
| `run`, `watch` | Like `tasks`, then runs Claude Code headless (`claude -p --dangerously-skip-permissions`) in the sandbox, then runs the hidden tests | Yes, in the sandbox | Claude Code: the Claude API (or your gateway or Bedrock) and your package registries. Hidden tests: none |
| `report`, `suggest` | Reads saved results. `suggest --apply` edits `CLAUDE.md` in your project | No | None |
| GitHub Action | Runs `check` or `run` on a pull request, then posts a summary | Only with `command: run` | Same as the command, plus the GitHub API for the comment |

What the sandbox allows and blocks, phase by phase, is in [docs/sandbox.md](docs/sandbox.md). How `run` keeps the answer away from Claude is in [docs/run.md](docs/run.md#keeping-the-answer-out-of-reach).

### What leaves your machine

- **setupscore sends no telemetry.** It has no analytics, no crash reports and no update check.
- `check`, `report` and `suggest` make no network requests.
- `tasks` downloads your dependencies from your package registries, as `npm install` would.
- `run` and `watch` send the task prompt, and the files and command output Claude reads, to the Claude API. This is the same as using Claude Code yourself. setupscore sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` for Claude Code, so it sends no non-essential traffic.
- Results stay in `.setupscore/` on your machine, readable only by your user. Keys and tokens are removed from transcripts before they are saved.
- The GitHub Action posts a summary of the results as a pull request comment and in the job summary. It never posts transcripts.

## What counts as a vulnerability

Report these privately. A test bench is only useful if its sandbox holds and its scores are honest, so **a way to fake a result is a vulnerability too, not just a bug**.

1. **Escape the sandbox.** A command run by `tasks` or `run` (an install script, a test, Claude Code, a hook or an MCP server) can:
   - write outside the workspace and the temp and log folders the sandbox allows,
   - reach a host that is not on the allowed list, or reach the network while tests run,
   - change the workspace's `.git` folder, which is read-only,
   - change the shared package cache from Claude's session,
   - keep a process running after the command or setupscore has ended,
   - make setupscore run something **outside** the sandbox. For example through a file name, a branch name, `setupscore.yml`, the `args` input of the Action, or git settings such as hooks and `core.fsmonitor`.
2. **Read secrets.** Untrusted code, or anyone who reads the output, can get:
   - a file from the [hidden list](docs/sandbox.md#what-is-hidden), such as `~/.ssh`, cloud credentials or your `.env`,
   - an environment variable that is not on the safe list,
   - a full key or token from the terminal output, `--json` output, `report.html`, `report.md`, `results.json`, `attempts.jsonl`, a saved transcript, the pull request comment or the job summary,
   - a full secret from `check`, which should always shorten it,
   - your results, because `.setupscore/` can be read by other users on the machine.
3. **Read the answer.** During an attempt, Claude can see the commit it is asked to make, or the hidden tests, and the attempt is **not** marked as failed. For example through branches, tags, the reflog, the shared git objects, your real project folder or `/proc`. The digging check in `run` only knows the ways listed in [docs/run.md](docs/run.md#keeping-the-answer-out-of-reach). A new way to look up the answer that isn't caught is in scope.
4. **Fake a pass.** An attempt counts as solved without a real fix. For example by changing a test, a test helper, the test runner config, the test script in `package.json`, a file in `node_modules`, or something the hidden tests run later. Changing the score, the verdict or the report in any other way counts too.
5. **Run code from a report.** Text from a project or a transcript runs as a script when you open `report.html`.
6. **`check` does more than read.** `check` makes a network request, runs project code, or `--fix` writes anywhere other than the reported path (for example through a symbolic link).
7. **The GitHub Action leaks or injects.** Text from a pull request (its title, branch name or files) runs as a shell command, or the Action exposes a secret to a pull request from a fork.
8. **The supply chain.** A way to publish a setupscore package, a release tag or an Action version that doesn't come from this repository's release workflow.

## What is not a vulnerability

Open a normal issue, or report it to the right project, for these:

- **`--sandbox none`.** It turns isolation off on purpose, for throwaway CI machines.
- **The limits we already document.** They are listed in [docs/sandbox.md](docs/sandbox.md#limits) and [docs/run.md](docs/run.md#limits). The main ones:
  - The network filter checks host names. It doesn't check what is sent to an allowed host.
  - On macOS, sandboxed commands can reach services on your machine's `localhost`.
  - In `run`, the key or token Claude Code needs is inside the sandbox, and the sandbox can reach the Claude API and your package registries. Only run `run` on code and setups you would trust with that key.

  We still want to hear about practical attacks on these limits, and we may harden them. But they aren't treated as vulnerabilities unless they go beyond what the docs say.

- **A `claude` program you replaced.** The digging check reads the transcript that Claude Code writes. A program passed with `--claude-bin` that hides what it does can't be checked this way.
- **Code that runs inside the sandbox, as designed.** For example an install script that reads the workspace, or a test that uses a lot of CPU or memory.
- **Bugs in other projects.** Report them upstream: Claude Code to [Anthropic](https://github.com/anthropics/claude-code/security/policy), the sandbox runtime to [its repository](https://github.com/anthropics/sandbox-runtime), bubblewrap or macOS Seatbelt to their maintainers. Please tell us too if you think setupscore should protect against it.
- **What the Claude API does with your data.** See Anthropic's policies.
- **Your own MCP servers and hooks** when you use Claude Code yourself, outside setupscore.
- **Money.** The cost of a run you started. A run that spends more than `--budget` is a bug: open a normal issue.
- **Rule results.** A false alarm, or the `secret` rule missing a key format. Use the [issue forms](https://github.com/mohamedsabith/setupscore/issues/new/choose).

## Using the GitHub Action safely

- `command: check` is safe on every pull request, including pull requests from forks. It reads files and needs no secret.
- `command: run` runs the pull request's own setup, including its hooks, skills and MCP servers, inside the sandbox, **with your API key in the sandbox's environment**. Only use it on branches from people you would trust with that key.
- GitHub gives no secrets to pull requests from forks, so `run` stops there before it installs anything. Never use `pull_request_target` to run `command: run` on code from a fork: that gives the fork your secrets.
- Use a separate API key with a spending limit for CI.
- Pin the Action to a full commit SHA if your organization requires it, for example `mohamedsabith/setupscore@<sha> # v1.0.4`. The release workflow never moves version tags such as `v1.0.4`; it only moves the major tag `v1`. A commit SHA can never change, so it is the safest pin.

### How this repository protects its own workflows

- Release starts only when a maintainer pushes a version tag such as `v1.0.4`. It is the only workflow that can publish.
- CI (tests and checks) and the pull request title check run on pull requests with read-only permissions and no secrets, so code from a pull request can't publish or change the repository. They use `pull_request`, never `pull_request_target`.
- Every workflow starts with read-only permissions. Only Release's publish job gets `contents: write` (to create the GitHub release and move `v1`) and `id-token: write` (for npm trusted publishing and provenance).
- Every third-party action is pinned to a full commit SHA.
- Every release is published with npm provenance, so you can check that it was built from this repository by that workflow (`npm audit signatures`).
- Releases are published with npm trusted publishing (OIDC): npm only accepts a release from this repository's release workflow, and no npm token is stored anywhere. Versions 1.0.0 to 1.1.0 were published with a short-lived npm token.

## Safe harbor

We welcome good-faith security research on setupscore. If you follow this policy, we consider your research authorized, we won't take legal action against you, and we won't ask anyone else to. Please:

- test only on your own machines, repositories, accounts and API keys,
- don't access, change or delete other people's data, and stop as soon as you see data that isn't yours,
- don't run tests that cost other people money or disrupt services,
- give us a reasonable time to fix the problem before you talk about it publicly.

If you are not sure whether something is allowed, ask us first at the email address above.

## Verify a release

Every version on npm is built and published by this repository's [Release workflow](.github/workflows/release.yml), with [npm provenance](https://docs.npmjs.com/generating-provenance-statements). No person publishes from their own machine.

Check the signatures and provenance of what you installed:

```bash
npm install setupscore
npm audit signatures        # reports a "verified registry signature" and a "verified attestation"
```

On [npmjs.com/package/setupscore](https://www.npmjs.com/package/setupscore), the **Provenance** section shows the commit and the workflow run that built each version. Check that it says `github.com/mohamedsabith/setupscore` and `.github/workflows/release.yml`. Anything else did not come from us.

setupscore's GitHub releases are immutable: their tags and files can't be changed after they are published, and GitHub signs an attestation for each one. To check a release:

```bash
gh release verify v1.2.0 --repo mohamedsabith/setupscore
```

The moving major tag (`v1`) has no release of its own. It always points at the newest `v1.x.y` release tag.

setupscore installs one helper the first time `doctor`, `tasks` or `run` needs it: a pinned version of [`@anthropic-ai/sandbox-runtime`](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime), downloaded with npm from your npm registry. npm checks its integrity. Apart from this helper and your project's own dependencies, setupscore downloads nothing. The GitHub Action also installs Claude Code for `command: run`, at the version in its `claude-code-version` input.
