# How setupscore runs your code safely, without Docker

`setupscore check` only reads files. `setupscore tasks` and `setupscore run` do more: they install your project's dependencies, run its tests for many commits in a row, and (in `run`) let Claude Code edit the code and run commands with permission prompts turned off. All of that is code, so setupscore runs it inside a sandbox.

## The sandbox is part of your operating system

setupscore uses [Anthropic's sandbox runtime](https://github.com/anthropics/sandbox-runtime), the same isolation Claude Code uses for its own sandboxed commands. It is built on what your OS already has:

| System | Sandbox | What you install |
| --- | --- | --- |
| macOS | Seatbelt (built into macOS) | Nothing |
| Linux | bubblewrap | `sudo apt-get install bubblewrap socat ripgrep` (or dnf / pacman) |
| Windows | WSL2 with bubblewrap | Run setupscore inside WSL2 and install the same three packages; native Windows is planned |

On Linux the sandbox runtime needs all three: bubblewrap isolates each command, socat carries its network traffic through setupscore's filter, and ripgrep (`rg`) finds the files the runtime always protects. On Ubuntu 24.04 and newer, AppArmor can block bubblewrap; when the sandbox can't start, `setupscore doctor` shows the fix for your machine. On Ubuntu 25.04 and newer, AppArmor's `bwrap-userns-restrict` profile also stops the sandbox's seccomp helper ([anthropics/sandbox-runtime#429](https://github.com/anthropics/sandbox-runtime/issues/429)). Until the sandbox runtime handles it, the fix turns that profile off until the next restart, which weakens a protection of the whole machine. The GitHub Action does this on its throwaway runners.

**No Docker, no virtual machine.** Commands start in milliseconds.

The runtime isn't a dependency of setupscore, so `npm install setupscore` stays small and `check` never downloads it. The first time you run `setupscore doctor`, `tasks` or `run`, setupscore installs a pinned version (about 12 MB) into its cache folder. It does this once:

- macOS: `~/Library/Caches/setupscore`
- Linux: `~/.cache/setupscore`
- Windows: `%LOCALAPPDATA%\setupscore\Cache`

Set `SETUPSCORE_CACHE_DIR` to use another folder.

Run `npx setupscore doctor` to check everything at once. It starts a real sandboxed command and confirms that a write outside the allowed folder is blocked and a hidden file can't be read.

## What a sandboxed command can and can't do

setupscore never runs anything in your own project folder. It clones the repository into a temporary folder (the _workspace_), checks out the commit it needs, and runs commands there. Untracked files such as `.env` are never copied.

|  | Installing dependencies | Running tests | Claude Code (in `run`) |
| --- | --- | --- | --- |
| Write files | The workspace, setupscore's package cache and the sandbox's temp and log folders | The workspace and the sandbox's temp and log folders | The workspace (with its own package cache) and the sandbox's temp and log folders |
| The workspace's `.git` folder | Read-only | Read-only | Read-only |
| Read the [hidden locations](#what-is-hidden) (`~/.ssh`, cloud credentials, browser data, shell history, ...) | Blocked | Blocked | Blocked |
| Read `~/.npmrc` and `~/.yarnrc` (private registry tokens) | Allowed | Blocked | Blocked |
| Read the `.env` files at the top of your repository | Blocked | Blocked | Blocked |
| Read the rest of your real project folder | Allowed while building tasks; blocked in `run` attempts | Allowed while building tasks; blocked in `run` attempts | Blocked (only its git objects and `node_modules` stay readable) |
| Network | Only the npm and Yarn registries, plus registries named in the project's `.npmrc` or `.yarnrc.yml` and `sandbox.domains` in `setupscore.yml` | **None** | The Claude API (or your gateway or Bedrock) and the same registries |
| Environment variables | A short safe list (`PATH`, `HOME`, locale, certificate paths). API keys and tokens in your shell are not passed in. | Same | Same, plus the key or token Claude Code needs |

"The sandbox's temp and log folders" are `/tmp/claude` (on macOS `/private/tmp/claude`), which the sandbox runtime needs for itself, and npm's and Claude Code's log folders (`~/.npm/_logs`, `~/.claude/debug`), which the runtime always lets commands write.

In `run`, your real project folder is at a later commit, so it holds the answer. That is why it is hidden in every phase. See [Keeping the answer out of reach](run.md#keeping-the-answer-out-of-reach).

The test-phase rules are covered by an automated test that runs a deliberately malicious test file. That file tries to:

- write outside the workspace,
- read a fake SSH key and the real `.env`,
- plant a command in `.git/config`,
- read an API key from the environment,
- call an outside website.

The test checks that every attempt is blocked.

setupscore's own git commands on the workspace also run with the settings that can execute programs turned off: hooks, `core.fsmonitor` and `core.sshCommand`.

### What is hidden

Sandboxed commands can't read these, if they exist:

- **SSH, GPG and git credentials:** `~/.ssh`, `~/.gnupg`, `~/.git-credentials`, `~/.netrc`, `~/.config/gh`, `~/.config/hub`.
- **Cloud and deploy tools:** `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.kube`, `~/.docker`, `~/.oci`, `~/.fly`, `~/.config/doctl`, Netlify, Vercel, Cloudflare Wrangler and Stripe CLI logins, Terraform credentials.
- **Password managers:** `~/.config/op` (1Password CLI), `~/.password-store`, and on macOS `~/Library/Keychains`.
- **Package registries:** `~/.npmrc`, `~/.yarnrc`, `~/.pypirc`, Cargo and RubyGems credentials. (`~/.npmrc` and `~/.yarnrc` stay readable while installing dependencies, so private registries work.)
- **Databases:** `~/.pgpass`, `~/.my.cnf`.
- **Claude:** `~/.claude.json`, `~/.claude/.credentials.json`, and the Claude desktop app's config, which can hold MCP server tokens (`~/.config/Claude`, `~/Library/Application Support/Claude`).
- **Browsers:** Firefox, Chrome and Chromium profiles, and `~/Library/Cookies` on macOS.
- **Shell start-up and history files**, which often hold exported tokens: `.bashrc`, `.bash_profile`, `.bash_history`, `.profile`, `.zshrc`, `.zshenv`, `.zprofile`, `.zsh_history`, and fish's variables and history.
- **`.env` files** at the top of your repository (templates such as `.env.example` are left readable).

### Each command cleans up after itself

- **Temp files:** every workspace has its own temp folder, and commands get it as `TMPDIR`, `TMP` and `TEMP`. Tests that write temp files don't see another attempt's files.
- **Package cache:** in `run`, Claude Code gets its own package cache, so it can't change the shared cache that later installs use.
- **Leftover processes:** when a command ends, anything it left running in the background is killed. When setupscore exits or is stopped, every process it started is killed too.

## When there is no sandbox

If the sandbox can't start, setupscore stops before running anything. It exits with code `3` and tells you how to fix it.

`--sandbox none` runs commands without isolation. It's meant for throwaway machines such as CI runners, and is refused unless `CI` is set or you add `--yes`. On GitHub Actions' Ubuntu runners the sandbox works too, if you install `bubblewrap`, `socat` and `ripgrep` first.

## Limits

- The sandbox filters network traffic by domain name. It doesn't inspect what is sent to an allowed domain.
- **On macOS, sandboxed commands may bind and reach `localhost`.** Tests that start a local server need this. It also means a command can reach services running on your Mac's `localhost`, such as a local database or a development server. On Linux each command has its own network, so your machine's `localhost` is out of reach (and a test's server can't clash with yours).
- Commands share your machine's CPU and memory.
- A sandbox reduces risk; it doesn't make untrusted code safe. Only run `setupscore tasks` on repositories you would run `npm install` on anyway.
