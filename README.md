<p align="center">
  <img src="https://raw.githubusercontent.com/mohamedsabith/setupscore/main/docs/assets/banner.png" alt="setupscore: stop vibe-checking your CLAUDE.md. Benchmark it on your own code: real commits, hidden tests, one score out of 100." width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/setupscore"><img src="https://img.shields.io/npm/v/setupscore" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2022.12-339933?logo=node.js&logoColor=white" alt="Node.js 22.12 or newer">
  <img src="https://img.shields.io/badge/check-free%20%C2%B7%20offline-2ea44f" alt="check is free and works offline">
</p>

<p align="center">
  <a href="#why-you-need-it">Why</a> ·
  <a href="#install-in-3-steps">Install</a> ·
  <a href="#check-your-setup-free">Check</a> ·
  <a href="#measure-your-setup-optional">Measure</a> ·
  <a href="#common-problems">Help</a> ·
  <a href="docs/reference.md">Reference</a>
</p>

# setupscore

**setupscore checks the instructions you give Claude Code, and tells you in plain English what is broken and how to fix it.**

Claude Code reads files in your project to learn how you work: `CLAUDE.md`, the `.claude/` folder (rules, skills, agents, settings) and `.mcp.json`. We call these files your **setup**. When they are wrong, Claude doesn't complain. It just does a worse job.

<p align="center">
  <img src="https://raw.githubusercontent.com/mohamedsabith/setupscore/main/docs/assets/demo.gif" alt="Running npx setupscore in a project: it lists broken paths, a missing npm script, contradicting and vague rules, a leaked password and MCP problems, then gives an instruction health of 2/10." width="100%">
</p>

## Why you need it

Your code changes every day. Your `CLAUDE.md` usually doesn't. Sooner or later, one of these happens:

| What goes wrong                                                    | What Claude does                                |
| ------------------------------------------------------------------ | ----------------------------------------------- |
| A folder was renamed, but `CLAUDE.md` still points to the old path | Looks for a file that isn't there, then guesses |
| A script was removed, but the instructions still say "run it"      | Runs a command that fails                       |
| Two rules say opposite things                                      | Has to pick one, and may pick the wrong one     |
| A rule is vague, like "write good code"                            | Has nothing it can act on                       |
| Someone pasted a password or API key into a setup file             | Sends it to the AI along with your instructions |
| Claude may run any command without asking                          | Can run something you didn't want               |

setupscore finds all of these in about a second, before they cost you time.

**Use it when:**

- **You use Claude Code on a project** and want to know your instructions still match the code.
- **Your team shares one `.claude/` folder** and you want to catch mistakes and leaked secrets before they are merged.
- **You changed `CLAUDE.md`** and want to know if Claude really does better with the new version, instead of guessing.
- **You review pull requests** and want a check that fails when someone breaks the setup.

## Install in 3 steps

You don't need to install setupscore itself. One command downloads and runs the newest version.

**Step 1. Install Node.js** (version 22.12 or newer). Download the **LTS** version from [nodejs.org](https://nodejs.org) and install it like any other app. To check, open a terminal and type:

```bash
node -v
```

You should see `v22.12.0` or a higher number.

**Step 2. Open a terminal in your project folder.** That is the folder that holds your `CLAUDE.md` (or your `.claude/` folder).

- **macOS:** open **Terminal**, type `cd ` (with a space), drag the project folder into the window, and press Enter.
- **Windows:** open the project folder in File Explorer, click the address bar, type `powershell` and press Enter.
- **VS Code:** open the project, then choose **Terminal → New Terminal**.

**Step 3. Run setupscore.**

```bash
npx setupscore
```

The first time, `npx` asks to install the package. Type `y` and press Enter. That's it.

## Check your setup (free)

`npx setupscore` reads your setup files and lists every problem. It is **free, works offline, and makes no AI calls**. Nothing leaves your computer.

<p align="center">
  <img src="https://raw.githubusercontent.com/mohamedsabith/setupscore/main/docs/assets/check.png" alt="Terminal output of setupscore check on the example project: 4 errors and 8 warnings across CLAUDE.md, a skill and .mcp.json, each with a plain-English fix." width="100%">
</p>

**How to read it:**

- Each file is listed with its problems. `11:23` means line 11, character 23.
- **error** (red): something is broken. Fix these first.
- **warning** (yellow): something that makes Claude's job harder.
- The line starting with **→** tells you how to fix it.
- **Instruction health** is a score from 0 to 10. 10 means no problems were found.

The screenshot shows our [example project](examples/bakery-api), which is broken on purpose. Secrets are never printed in full.

**Useful commands:**

| Command | What it does |
| --- | --- |
| `npx setupscore` | Check the folder you are in |
| `npx setupscore check ../other-project` | Check a different folder |
| `npx setupscore --fix` | Fix file paths that moved or were renamed (only when the answer is certain) |
| `npx setupscore --cost` | Show how much each file adds to every Claude session |
| `npx setupscore rules` | List every check and why it matters |

Every check is explained, with good and bad examples, in [docs/rules.md](docs/rules.md).

## Measure your setup (optional)

Finding mistakes is step one. Step two is proving that your setup **actually helps Claude**. `npx setupscore run` does that:

1. It takes real changes from your project's git history: commits that changed both code and tests.
2. It gives each one to Claude Code as a task, once **with** your setup and once **without** it (or with an older version).
3. It checks Claude's work with the commit's own tests, which Claude never sees.
4. It gives your setup a **Setup Score out of 100**, and tells you if a difference is real or could be luck.

```text
  Setup     Source   Score  Success (95% range)  Cost/try  Turns  Rule breaks  vs none
  A         working  97     100% (72%–100%)      $0.24     14     1            +60 pts
  baseline  none     40     40% (17%–69%)        $0.21     11     0
```

_This is an example. Your numbers depend on your project, your tasks and the model._

**Before you start, you need:**

- **macOS, Linux, or Windows with WSL2.** On Linux, also install three small tools: `sudo apt-get install bubblewrap socat ripgrep`
- **Claude Code:** `npm install -g @anthropic-ai/claude-code`
- **A JavaScript or TypeScript project** with tests and some git history
- **A Claude API key** from [console.anthropic.com](https://console.anthropic.com), **or** a token for your Claude subscription (run `claude setup-token`)

**Then run:**

```bash
npx setupscore doctor                    # 1. checks that your computer is ready, and says what to fix
export ANTHROPIC_API_KEY=sk-ant-...      # 2. your key (or: export CLAUDE_CODE_OAUTH_TOKEN=...)
npx setupscore run --baseline            # 3. your setup vs no setup
```

**Good to know:**

- **It costs a little money.** Every try is a real Claude Code session on your key or subscription. setupscore shows an estimate and asks before it starts. By default it stops at **$5**, and 5 tasks usually cost a few dollars.
- **It's safe.** Claude works in a throwaway copy of your project, inside your computer's own sandbox. **No Docker needed.** It can't read your `.env` files, SSH keys or cloud passwords, and it can only reach the Claude API and your package registry.
- **You can stop at any time** with Ctrl+C. Nothing is lost: continue later with `npx setupscore run --resume latest`.
- **After a run,** `npx setupscore suggest` shows changes to `CLAUDE.md` based on what went wrong, and `npx setupscore report` shows the results again.

Scoring, costs and every option are explained in [docs/run.md](docs/run.md). How the sandbox protects you is in [docs/sandbox.md](docs/sandbox.md).

## Use it on GitHub

Add this file to your repository as `.github/workflows/setupscore.yml`. Every pull request is then checked, and the check fails if the setup has errors:

```yaml
name: setupscore
on: [pull_request]
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - run: npx setupscore@1
```

There is also a GitHub Action that can **measure** the setup on pull requests and post the score as a comment. See [CI and the GitHub Action](docs/reference.md#use-it-in-ci).

## Common problems

| You see | What to do |
| --- | --- |
| `npx: command not found` or `'npx' is not recognized` | Node.js isn't installed, or the terminal was opened before you installed it. Install Node.js, then open a **new** terminal. |
| `setupscore needs Node.js 22.12 or newer` | Your Node.js is too old. Install the current LTS from [nodejs.org](https://nodejs.org). |
| `No Claude Code setup files found here` | You are in the wrong folder. Go to the folder that holds `CLAUDE.md` or `.claude/`, or pass it: `npx setupscore check path/to/project`. |
| A warning you think is wrong | Put `<!-- setupscore-disable-next-line rule-id -->` above that line, and please [tell us](https://github.com/mohamedsabith/setupscore/issues/new?template=false-alarm.yml). |
| `run` says the sandbox doesn't work | Run `npx setupscore doctor`. It tells you exactly what to install or change. |
| You want `run` on Windows | `run` needs WSL2: open your project in WSL2 and run it there. `check` works on Windows directly. |

Still stuck? [Open an issue](https://github.com/mohamedsabith/setupscore/issues) with what you ran and what you saw. Put `SETUPSCORE_DEBUG=1` before the command to get more detail.

## FAQ

**Does it send my code anywhere?** `npx setupscore` (check) doesn't: no network and no AI. `run` sends the tasks and the files Claude reads to the Claude API, exactly like Claude Code does when you use it yourself. Results stay on your computer, in the `.setupscore/` folder.

**Does it work with Python, Go or other languages?** `check` works on any project that uses Claude Code. `run` supports JavaScript and TypeScript projects for now. Python and Go are planned.

**Why does `run` need an API key when I'm already signed in to Claude Code?** Your normal sign-in is stored where the sandbox can't see it, on purpose. Set `ANTHROPIC_API_KEY`, or run `claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN` to use your subscription.

**What is "instruction health"?** A quick score from 0 to 10: 10, minus 1 for each error and 0.5 for each warning. Use it to track your setup over time.

**Does it check `AGENTS.md`?** Yes, when Claude Code reads it through your `CLAUDE.md`: an `@AGENTS.md` import, or a `CLAUDE.md` that is a link to `AGENTS.md`. Claude Code 2.1.277 and newer also reads `AGENTS.md` on its own when the project has no `CLAUDE.md`; setupscore doesn't check that case yet. Codex and Cursor rules are planned.

## More documentation

- [Reference](docs/reference.md): every command and option, configuration (`setupscore.yml`), CI, exit codes and JSON output
- [Rules](docs/rules.md): every check, with examples
- [Measuring with `run`](docs/run.md): scoring, costs, resuming and comparing models
- [Sandbox](docs/sandbox.md): how setupscore keeps your computer safe

## Contributing

Bug reports, false-alarm reports and new rules are very welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Mohamed Sabith

`setupscore tasks` and `setupscore run` download [@anthropic-ai/sandbox-runtime](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime) (Apache-2.0) on first use. It isn't bundled or installed with setupscore.
