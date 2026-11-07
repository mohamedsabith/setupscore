# setupscore rules

Every rule, why it matters, and how to fix what it finds. Run `npx setupscore rules` to see the same list in your terminal.

To change a rule's level, or turn it off, use `setupscore.yml`:

```yaml
version: 1
rules:
  vague-rule: off
```

To silence a single line, put `<!-- setupscore-disable-next-line rule-id -->` above it. A disable comment shown inside a code block is only an example and has no effect.

Text that setupscore quotes from your files is always shown with secrets masked, and lines over 10,000 characters are not checked for wording (they are almost always generated text).

Folder links inside `.claude/` (for example `.claude/skills` pointing to a shared `skills/` folder in the repo) are followed, as Claude Code follows them. Links that leave the repository, or point back to a folder that contains them, are not.

---

## broken-reference

**Level:** error

A file path in your instructions points to a file that doesn't exist.

**Why it matters:** Claude looks for the file, finds nothing and has to guess. Old paths are the most common way instructions go stale after a refactor.

```markdown
<!-- Bad: the logger moved to src/lib/logger.ts -->
- Use the logger from src/common/logger.js

<!-- Good -->
- Use the logger from src/lib/logger.ts
```

Paths in any language (`docs/menü.md`), dot folders (`.github/workflows/ci.yml`, `.claude/skills/x/SKILL.md`), paths in `_italics_` and Windows paths with backslashes (`src\utils\old.ts`) are checked too. The letter case must match exactly, on every OS: `src/Utils.ts` is reported when the file is `src/utils.ts`, because Claude Code on Linux (and CI) cannot open it, even if your Mac or Windows disk can. In a nested `CLAUDE.md`, a path is read from that file's folder first.

**What it ignores:** URLs, globs (`src/**/*.ts`), placeholders (`src/<name>/index.ts`, `path/to/file.ts`, `index.bundle.{FEATURE}.ts`), examples (after "e.g.", "for example", "such as" or "like"), build output (`dist/`, `build/`, `coverage/`) and anything else `.gitignore` ignores, personal files (`*.local.*`), code blocks, and paths whose first folder doesn't exist in the project (usually package paths or examples). In a file reached through a folder link, a relative path also counts when it works from where the file really is.

**Auto-fix:** `--fix` rewrites the path when git history shows the file was renamed (the last 2,000 commits), when only the letter case is wrong, or when exactly one file with that name exists elsewhere in the project. Only the flagged occurrence is rewritten, every line keeps its own line ending, and each file is written atomically (a full disk never leaves half a file). If a file cannot be written, the others are still fixed and setupscore says which file failed.

## broken-import

**Level:** error

An `@path` import in `CLAUDE.md` points to a missing file. Imports are resolved from the folder of the file that contains them.

**Why it matters:** Claude Code skips imports it can't find, without a warning, so that file's instructions never reach Claude.

```markdown
See @docs/style-guide.md      <!-- the file is docs/style.md -->
```

Imports inside `` `code spans` `` and code blocks are ignored, as in Claude Code. `~/` and absolute imports are machine-specific and not checked. File paths inside npm packages (`@types/node/index.d.ts`, `@babel/preset-env/lib/index.js`) are not imports and are left alone. An import written with backslashes (`@docs\guide.md`) only works on Windows, so it is reported with a fix to forward slashes. **Auto-fix:** same as `broken-reference`.

## missing-script

**Level:** error

Your instructions tell Claude to run a `package.json` script that doesn't exist: `npm run x`, `pnpm run x`, `yarn run x`, `bun run x`, or `npm test` without a `test` script.

**Why it matters:** Claude runs the command and it fails. Then Claude either skips checking its work or makes up another command.

setupscore uses the nearest `package.json` (a `package.json` saved with a byte order mark is fine). In a monorepo, commands with `--filter`, `-w` or `--workspace` are left alone, and so is a script from another package when the line names that package ("`pnpm run migrate` in the api package"). A root `CLAUDE.md` may also list the scripts of workspace packages, but `npm test` always means the nearest package, and a nested `CLAUDE.md` is checked against its own package. Prose like "npm run with the --silent flag" is not a script call.

## invalid-config

**Level:** error

`.claude/settings.json`, `.claude/settings.local.json` or `.mcp.json` isn't valid JSON, or a skill, agent or rule has frontmatter that can't be read.

**Why it matters:** Claude Code can't read a broken file, so the permissions, MCP servers or skill settings in it have no effect.

The most common causes are a trailing comma (`["a",]`) and comments. JSON allows neither. The message names the mistake and its line (comment, trailing comma, missing comma, line break inside a string, single quotes, `\` in a Windows path). Frontmatter is read as leniently as Claude Code reads it, so `description: Use when: x` is fine.

This rule also reports setup files that cannot be read at all: a file or `.claude/` folder without read permission, or a file saved as UTF-16 (the default of Windows PowerShell 5), which Claude Code reads as garbage. Save files as UTF-8.

## secret

**Level:** error

An API key, token or password is written in a setup file. setupscore detects known formats (Anthropic, OpenAI, AWS access keys, GitHub, GitLab, Slack tokens and webhooks, Google, Stripe secret keys, SendGrid, npm tokens, JWTs, private keys), passwords in URLs (`postgres://user:pass@host`), and assignments like `password=...`, `DB_PASSWORD=...` or `aws_secret_access_key = ...`, plus literal values in the `env` and `headers` blocks of `.mcp.json` and the `env` block of `settings.json`.

Placeholders are not reported: `${VAR}`, `%VAR%`, `<your-token>`, `xxxx`, `********`, `[REDACTED]`, `{{ secrets.X }}`, documented examples like `AKIAIOSFODNN7EXAMPLE`, Stripe publishable keys (`pk_live_…`), file paths and type names in code (`apiKey: string`).

**Why it matters:** setup files are committed to git and sent to the AI provider. Anyone with the repo, or its history, can read the key.

```json
// Bad (.mcp.json)
"env": { "GITHUB_TOKEN": "ghp_xxxxxxxxxxxxxxxxxxxx" }

// Good: Claude Code expands ${VAR} from your shell
"env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
```

If a real key was committed, **rotate it**: deleting the line doesn't remove it from git history. setupscore never prints a full secret.

## misnamed-file

**Level:** warning

A setup file or folder whose name differs from what Claude Code looks for only in letter case: `claude.md` or `Claude.local.md` at the project root, a `.Claude/` folder, `.claude/Settings.json`, `.claude/skills/x/skill.md`. Also a loose skill file such as `.claude/skills/release.md`: a skill must be a folder with a `SKILL.md` in it (`.claude/skills/release/SKILL.md`), so Claude Code never loads the loose file.

**Why it matters:** Claude Code looks for exact names. On macOS and Windows the disk ignores letter case, so the file seems to work there, but on Linux (CI, containers, teammates' machines) Claude Code never loads it. setupscore does not check what is inside a misnamed file.

**Fix:** rename it. On macOS or Windows use `git mv claude.md CLAUDE.md` so git records the change of case.

macOS AppleDouble files (`._name.md`, made when copying to exFAT or network drives) are ignored.

## agents-md-not-loaded

**Level:** warning

An `AGENTS.md` (or `.claude/AGENTS.md`) that Claude Code never reads. Claude Code 2.1.277 and newer reads `AGENTS.md` on its own, but by default only when there is no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md`. When there is one, Claude reads only the `CLAUDE.md` files. This rule reports:

- an `AGENTS.md` next to a `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` that doesn't import it,
- an `AGENTS.md` in a subfolder, when the project root has a `CLAUDE.md` and the subfolder has no `CLAUDE.md` that imports it,
- a `CLAUDE.md` whose only text is `AGENTS.md`: a link that git saved as a plain file (on Windows, or with `core.symlinks` off).

**Why it matters:** everything in `AGENTS.md` is silently missing for Claude, while other tools (Codex, Cursor, Copilot) read it. A personal `CLAUDE.local.md` counts too, so adding one can switch `AGENTS.md` off for you alone.

```markdown
<!-- Bad: CLAUDE.md next to AGENTS.md -->
- Run the tests with pnpm test.

<!-- Good: CLAUDE.md imports AGENTS.md, then adds Claude-only lines -->
@AGENTS.md

- Run the tests with pnpm test.
```

**Fix:** add `@AGENTS.md` to the `CLAUDE.md` (from `.claude/CLAUDE.md` write `@../AGENTS.md`), or make `CLAUDE.md` a link to `AGENTS.md`. A `CLAUDE.md` that only says "read AGENTS.md" in words isn't enough: Claude reads it only if it decides to open the file. `--fix` repairs the plain-file link case.

Not reported: an `AGENTS.md` with no `CLAUDE.md` (Claude reads it), one that a `CLAUDE.md` imports or links to, an `AGENTS.md` that is itself a link to `CLAUDE.md`, and an empty `AGENTS.md`. setupscore assumes Claude Code starts in the checked folder and uses its default **Project instructions** setting. It can't see files above that folder or your own Claude Code settings: with `claude-md-and-agents-md`, Claude reads both files and you can turn this rule off.

## risky-permission

**Level:** warning

`settings.json` allows `"Bash"` with no limits, allows a shell with a wildcard (`Bash(powershell:*)`, `Bash(cmd /c:*)`, `Bash(bash:*)`), allows dangerous commands (`rm`, `rmdir`, `del`, `Remove-Item`, `sudo`, `curl`, `wget`, `ssh`, `git push`, `npm publish`, `docker`, `kubectl`, `terraform` and cloud CLIs) with no prompt, or sets `"defaultMode": "bypassPermissions"`.

**Why it matters:** allowed commands run with no prompt. One bad step, or a prompt injection hidden in a file or web page, can then delete files, push code or send data out.

```json
// Better: allow exact commands, ask for risky ones
"permissions": {
  "allow": ["Bash(npm run test:*)", "Bash(git status)", "Bash(git diff:*)"],
  "ask": ["Bash(git push:*)"]
}
```

## env-not-denied

**Level:** warning

The project has a local `.env` file (in any folder), and no `permissions.deny` rule stops Claude from reading it. Templates (`.env.example`) and `.env` files committed to git are skipped, because they aren't secret. A deny rule counts when its pattern covers the file: `Read(./.env)` covers the root `.env` only, `Read(**/.env)` covers every folder. Patterns with backslashes (`Read(.\.env)`) do not count: Claude Code permission paths use forward slashes.

**Why it matters:** Claude Code can read any file in the project. A deny rule keeps the keys in `.env` out of the conversation.

```json
"permissions": { "deny": ["Read(./.env)", "Read(./.env.*)"] }
```

In a monorepo with `.env` files in package folders, use `"Read(**/.env)", "Read(**/.env.*)"`.

## mcp-config

**Level:** warning

There is a problem with a server in `.mcp.json`:

- **Unpinned:** `npx some-server` or `uvx some-server` without a version (or with `@latest`) runs whatever version is newest each time, so a bad release runs on your machine. Pin it: `some-server@1.4.2`.
- **`$VAR` or `%VAR%`:** Claude Code expands `${VAR}` and `${VAR:-default}` only. A bare `$VAR`, PowerShell's `$env:VAR` or cmd.exe's `%VAR%` is passed through as literal text. (`%VAR%` in the arguments of a `cmd /c` server is expanded by cmd.exe, so that case is fine.)
- Shell command strings are understood: in `"command": "bash", "args": ["-c", "npx pkg --token $TOKEN"]` the shell expands `$TOKEN` (not reported), and the unpinned `npx pkg` inside the string is reported.
- Windows wrappers are understood: `"command": "cmd", "args": ["/d", "/s", "/c", "npx.cmd", "pkg"]` and full paths like `C:\\Program Files\\nodejs\\npx.cmd` are checked like `npx pkg`.
- **Plain `http://`** to a non-local host sends requests and tokens unencrypted.
- **No `mcpServers`** object, so Claude Code finds no servers in the file.

## contradiction

**Level:** warning

Two rules seem to say opposite things: one says _never use/write/call X_, another says _use X_. Only list items are compared, across everything loaded at start-up, or within one file. A ban with a scope ("Never run migrations **in production**") only clashes with a rule that mentions the same scope. Each forbidden subject is reported once, with a count of the other lines that say the same.

**Why it matters:** when rules conflict, Claude has to guess which one wins, and it won't guess the same way every time.

```markdown
<!-- Bad -->
- Use Prisma for all queries. Never write raw SQL.
- For reports, use raw SQL because it is faster.

<!-- Good -->
- Use Prisma for all queries. Raw SQL is allowed only in src/reports/, for speed.
```

This rule is a heuristic, so it's a warning. If it's wrong, silence the line.

## vague-rule

**Level:** warning

A short rule built around a phrase like "write good code", "be careful", "follow best practices" or "high quality". Only standing instructions are checked (CLAUDE.md, rules and imports), not skill, agent or command prompts. A vague opener followed by the concrete rule ("Be careful: run migrations on staging first.") is fine.

**Why it matters:** Claude already tries to write good code. A vague rule costs tokens on every message and changes nothing.

```markdown
<!-- Bad -->
- Be careful with errors.

<!-- Good -->
- Wrap database calls in try/catch and log failures with logger.error({ err, orderId }).
```

## duplicate-rule

**Level:** warning

The same rule (at least 4 words) appears twice in the instructions loaded at start-up. Case, list style, extra spaces and punctuation at the start or end of the line are ignored; punctuation inside the line, such as a comma, still counts. Link footers ("Reference: [Blog](https://…)") and lead-ins that end with a colon are not rules and may repeat.

**Why it matters:** every copy is sent with every message. Copies also drift apart over time and turn into contradictions.

## too-long

**Level:** warning

A `CLAUDE.md`, rule or imported file is over 200 lines, or a `SKILL.md` is over 500 lines. These limits follow Anthropic's guidance.

**Why it matters:** files loaded at start-up are sent with every message. Long files cost more, and Claude follows each rule less reliably.

**Fix:** move rules that only apply to some files into `.claude/rules/` with `paths:` frontmatter, and move procedures into skills.

A setup file over 2 MB is too big for setupscore to read, so it is reported here instead of being skipped silently. Line counts and token estimates ignore Windows line endings (`\r`).

## deep-import

**Level:** warning

An `@import` sits more than 4 levels deep (CLAUDE.md imports A, which imports B, and so on).

**Why it matters:** Claude Code only follows a few levels of imports within imports. Sources say 4 or 5, depending on the version. Anything deeper may never load.

## unused-path-rule

**Level:** warning

A file in `.claude/rules/` has `paths:` frontmatter that matches no file in the project, so it never loads.

```markdown
---
paths:
  - "src/api/**/*.ts"     <!-- the folder is now src/server/ -->
---
```

## skill-frontmatter

**Level:** warning

A skill in `.claude/skills/<name>/SKILL.md`:

- has no frontmatter, or no `description`,
- has a description under 8 words or over 1,024 characters,
- has a `name` that isn't lowercase letters, numbers and hyphens (max 64), or
- has no instructions after the frontmatter.

**Why it matters:** Claude decides whether to use a skill from its description alone. A one-word description means the skill is rarely or never used.

```yaml
# Bad
description: Migrations.

# Good
description: Creates and runs database migrations with Prisma. Use when changing the schema, adding a table or a column.
```

## agent-frontmatter

**Level:** warning

A subagent in `.claude/agents/` has no frontmatter, no `name`, or a description that is missing or under 6 words.

**Why it matters:** Claude decides when to hand work to a subagent from its description.
