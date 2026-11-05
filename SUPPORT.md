# Getting help

## Where to go

| You want to | Go to |
| --- | --- |
| Ask "how do I ...?", or get help with `setupscore.yml`, CI or a Setup Score | [Discussions: Q&A](https://github.com/mohamedsabith/setupscore/discussions/categories/q-a). Search first: someone may have asked already |
| Suggest an idea or a new rule | [Discussions: Ideas](https://github.com/mohamedsabith/setupscore/discussions/categories/ideas) |
| Report a crash or a wrong result | [Open an issue](https://github.com/mohamedsabith/setupscore/issues/new/choose) and pick a form: bug, false alarm, missed problem, score looks wrong, feature or docs |
| Report a security problem | Report it privately, as described in [SECURITY.md](SECURITY.md). Never in a public issue |
| Report behavior that breaks the [Code of Conduct](CODE_OF_CONDUCT.md) | Email mohamedsabithmp@gmail.com |

Many answers are already in the docs: [README](README.md), [rules](docs/rules.md), [runs and the Setup Score](docs/run.md) and [the sandbox](docs/sandbox.md).

## What to include

- The setupscore version: `npx setupscore --version`.
- The exact command you ran, and its output as text, not a screenshot.
- For `tasks`, `run` and sandbox problems: the output of `npx setupscore doctor --json`.
- For a crash: the output when you run the command again with `SETUPSCORE_DEBUG=1`.
- Remove API keys, tokens and private paths before you paste anything.

You can write in your own language and use a translator. That is fine.

## What we don't support here

- **Problems with Claude Code itself** (sign-in, the app, the model's answers): report them to [anthropics/claude-code](https://github.com/anthropics/claude-code/issues). setupscore is not made or endorsed by Anthropic.
- **`tasks` and `run` on native Windows:** use WSL2. There is no supported sandbox on native Windows yet. `check` works everywhere.
- **Projects that aren't JavaScript or TypeScript** in `tasks` and `run`. They are on the [roadmap](ROADMAP.md).

## How fast you get an answer

setupscore has one maintainer, who works on it in their own time. We try to look at every new issue within a week. Answers can take a few days. Security reports come first.
