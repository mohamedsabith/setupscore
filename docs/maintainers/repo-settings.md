# Repository and npm settings

A step-by-step checklist for the repository owner. These settings are not stored in files, so they must be set by hand: once after the first push, and checked again every 6 months.

Most steps have a `gh` command and the same setting in the web interface. Run the commands from a clone of the repository, signed in as the owner (`gh auth login`, then check with `gh auth status`).

```bash
R=mohamedsabith/setupscore
```

Order matters in a few places: create the labels (step 4) before people use the issue forms, and set up the release app (step 7) before the rulesets (step 8).

## 1. General

```bash
gh repo edit "$R" \
  --description "Lint your Claude Code setup, then measure if it helps: real tasks from your git history, run in an OS sandbox, scored 0-100." \
  --homepage "https://www.npmjs.com/package/setupscore" \
  --enable-issues --enable-discussions --enable-wiki=false --enable-projects=false
gh repo edit "$R" \
  --add-topic claude-code,claude,claude-md,anthropic,ai-agents,coding-agent,agentic-coding,llm,llm-evaluation,evals \
  --add-topic benchmark,linter,static-analysis,cli,developer-tools,typescript,nodejs,mcp,github-actions,sandbox
```

In **Settings → General**:

- [ ] **Description** (above). Keep it the same as the start of `description` in `package.json`.
- [ ] **Website:** the npm page for now. When the docs site exists, use its address instead (for example `https://mohamedsabith.github.io/setupscore/`).
- [ ] **Topics:** the 20 above. GitHub allows at most 20.
- [ ] **Social preview:** **Edit → Upload an image**. A PNG of 1280 × 640 pixels, under 1 MB, with the name, the one-line pitch and a slice of real output. Don't use Anthropic or Claude logos: setupscore is not made or endorsed by Anthropic.
- [ ] **Features:** Issues on, Discussions on, Wiki off (the docs live in the repository), Projects off unless you use them.
- [ ] On the repository's home page, the gear icon next to **About**: Releases on, Packages off, Deployments off.

## 2. Pull requests

```bash
gh repo edit "$R" \
  --enable-squash-merge --squash-merge-commit-message pr-title \
  --enable-merge-commit=false --enable-rebase-merge=false \
  --delete-branch-on-merge --enable-auto-merge --allow-update-branch
```

In **Settings → General → Pull Requests**:

- [ ] **Allow squash merging** only. Merge commits and rebase merging off.
- [ ] Default commit message: **Pull request title**. The title alone becomes the commit on `main`, so the pull request description (and the template text in it) never reaches the release notes. Breaking changes are marked with `!` in the title.
- [ ] **Always suggest updating pull request branches:** on.
- [ ] **Allow auto-merge:** on.
- [ ] **Automatically delete head branches:** on.
- [ ] Pull request access: keep it open to everyone for now. If pull requests made by unattended agents become a burden, use GitHub's pull request access settings to limit how many open pull requests a user without write access can have (for example 3), or to allow pull requests from collaborators only.

## 3. Discussions

Turn on Discussions in step 1, then open the **Discussions** tab and click the pencil next to **Categories**. GitHub creates these categories by default; check that they look like this:

| Category | Format | What it is for |
| --- | --- | --- |
| Announcements | Announcement (only maintainers can post) | Releases, roadmap updates, breaking changes |
| Q&A | Question and answer | "How do I ...?", CI setup, reading a Setup Score. Answers can be marked |
| Ideas | Open-ended discussion | Feature ideas and new rule proposals, before they become issues |
| Show and tell | Open-ended discussion | Share Setup Scores before and after a change |
| General | Open-ended discussion | Everything else |
| Polls | Poll | Optional. For example: which agent should come after Codex? |

- [ ] **Don't rename Q&A or Ideas.** The issue forms, `SUPPORT.md` and `CONTRIBUTING.md` link to them by their address (`category=q-a`, `category=ideas`).
- [ ] Post a welcome in Announcements and pin it. For example:

  > **Welcome to setupscore Discussions.** Ask questions in Q&A, and suggest ideas or new rules in Ideas. Bugs, false alarms and wrong scores go to the [issue forms](https://github.com/mohamedsabith/setupscore/issues/new/choose). Report security problems privately (see SECURITY.md). What's planned is in ROADMAP.md.

## 4. Labels

The labels are defined in [`.github/labels.yml`](../../.github/labels.yml). The issue forms and the workflows use these names, and GitHub ignores a label in a form if it doesn't exist yet.

```bash
.github/scripts/sync-labels.sh --dry-run "$R"   # shows what would change
.github/scripts/sync-labels.sh "$R"
```

- [ ] Run the script after the first push, and again whenever `labels.yml` changes.
- [ ] It renames GitHub's default labels (`bug`, `enhancement`, `documentation`, `duplicate`, `invalid`, `question`, `wontfix`), so issues keep them. It never deletes anything. At the end it prints a `gh label delete` command for each label that is not in `labels.yml`.

## 5. Security

```bash
gh api -X PUT "repos/$R/private-vulnerability-reporting"
gh api -X PUT "repos/$R/vulnerability-alerts"
gh api -X PUT "repos/$R/automated-security-fixes"
gh repo edit "$R" --enable-secret-scanning
gh repo edit "$R" --enable-secret-scanning-push-protection
gh api -X PUT "repos/$R/immutable-releases"

# Check
gh api "repos/$R/private-vulnerability-reporting"    # {"enabled":true}
gh api "repos/$R/immutable-releases"                 # "enabled": true
```

In **Settings → Advanced Security** (called **Code security** on some accounts):

- [ ] **Private vulnerability reporting:** on. [SECURITY.md](../../SECURITY.md) sends people there. Without it, the "Report a vulnerability" button doesn't exist.
- [ ] **Dependency graph:** on (the default for public repositories).
- [ ] **Dependabot alerts:** on. **Dependabot security updates:** on. **Grouped security updates:** on.
- [ ] **Secret scanning** (Secret Protection): on. **Push protection:** on. It blocks pushes that contain real keys.
- [ ] **Code scanning:** CodeQL runs from the workflow in `.github/workflows/` if there is one. Then don't also turn on CodeQL "default setup": the two conflict. If there is no CodeQL workflow, use default setup.

In **Settings → General → Releases**:

- [ ] **Enable release immutability.** After a release is published, its tag and files can't be changed, and GitHub signs an attestation for it (`gh release verify`). It doesn't affect the moving `v1` tag, which has no release.

## 6. GitHub Actions

```bash
gh api -X PUT "repos/$R/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
```

In **Settings → Actions → General**:

- [ ] **Workflow permissions:** "Read repository contents and packages permissions". Leave **"Allow GitHub Actions to create and approve pull requests"** off. Workflows ask for more permissions per job.
- [ ] **Approval for running fork pull request workflows:** "Require approval for first-time contributors" at least. CI runs sandbox tests, so "Require approval for all outside collaborators" is safer.
- [ ] **Actions permissions:** "Allow mohamedsabith, and select non-mohamedsabith, actions and reusable workflows". Allow actions created by GitHub, and list the other actions the workflows use. To see them:

  ```bash
  grep -rhoE 'uses: [^@ ]+' .github/workflows action.yml | sort -u
  ```

  At the time of writing, the actions not made by GitHub are `amannn/action-semantic-pull-request`, `anthropics/claude-code-action` and `ossf/scorecard-action`. When a workflow starts using a new action, add it here, or the workflow fails.

- [ ] Tick **"Require actions to be pinned to a full-length commit SHA"**. All workflows and `action.yml` already pin by SHA, and Dependabot keeps the pins up to date.
- [ ] Optional: the `@claude` workflow (`.github/workflows/claude.yml`) needs the Claude GitHub App (run `/install-github-app` in Claude Code) and an `ANTHROPIC_API_KEY` secret. Use a key with a low spending limit. Without them, the workflow does nothing useful, and you can delete it.

## 7. The release GitHub App

Follow [RELEASING.md, step 1](../../RELEASING.md#1-the-release-github-app): create the app, install it on this repository, and add the variable `RELEASE_APP_CLIENT_ID` and the secret `RELEASE_APP_PRIVATE_KEY`.

- [ ] Note the app's numeric **App ID** (on the app's settings page, above the Client ID). The rulesets below need it.

## 8. Rulesets

Rulesets protect `main` and the release tags. The release app is on both bypass lists, because the release commit and tags must get through.

```bash
APP_ID=123456   # the release app's numeric App ID from step 7
```

### The `main` branch

```bash
cat > /tmp/main-ruleset.json <<EOF
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [
    { "actor_id": $APP_ID, "actor_type": "Integration", "bypass_mode": "always" },
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request" }
  ],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [{ "context": "CI OK", "integration_id": 15368 }]
      }
    }
  ]
}
EOF
gh api -X POST "repos/$R/rulesets" --input /tmp/main-ruleset.json
```

If the API rejects `allowed_merge_methods`, remove that line and try again: step 2 already allows only squash merges.

What this does, and the same settings in **Settings → Rules → Rulesets → New branch ruleset**:

- [ ] Target: the default branch. Enforcement: **Active**.
- [ ] **Restrict deletions**, **Block force pushes**, **Require linear history**.
- [ ] **Require a pull request before merging**, with **0** required approvals while there is one maintainer (you can't approve your own pull request). **Dismiss stale approvals** on. **Require conversation resolution** on. **Allowed merge methods:** squash only.
- [ ] **Require status checks to pass:** `CI OK`, from GitHub Actions (`15368` is the GitHub Actions app, so no other app can fake the check). `CI OK` is the one job that waits for the whole CI matrix, so the ruleset doesn't change when the matrix does.
- [ ] Add the other pull request checks once they have run at least once: **`Conventional PR title`** (the title check, `pr-title.yml`) and **`Dependency review`** (`dependency-review.yml`). In the web interface, a check only appears in the list after it has run. If a job is renamed, update the ruleset, or every pull request waits for a check that never comes.
- [ ] Optional, once CodeQL has run on `main`: add the **Require code scanning results** rule with CodeQL, security alerts "High or higher". Scorecard, the labeler and Stale are not required checks.
- [ ] **Bypass list:** the release app (always), and the **Repository admin** role for pull requests only. That lets you merge a pull request whose checks are stuck, but never push to `main` directly.

When a second maintainer joins (see [GOVERNANCE.md](../../GOVERNANCE.md#how-the-project-grows)): set required approvals to 1, and turn on **Require review from Code Owners** and **Require approval of the most recent push**.

### Release tags

```bash
cat > /tmp/tags-ruleset.json <<EOF
{
  "name": "release tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*.*.*"], "exclude": [] } },
  "bypass_actors": [
    { "actor_id": $APP_ID, "actor_type": "Integration", "bypass_mode": "always" },
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }
  ],
  "rules": [{ "type": "creation" }, { "type": "update" }, { "type": "deletion" }]
}
EOF
gh api -X POST "repos/$R/rulesets" --input /tmp/tags-ruleset.json
gh api "repos/$R/rulesets" --jq '.[] | "\(.name): \(.enforcement)"'   # check both
```

- [ ] Target: tags matching `v*.*.*` (release tags such as `v1.2.0` and `v1.3.0-beta.1`). Enforcement: **Active**.
- [ ] **Restrict creations**, **Restrict updates**, **Restrict deletions**.
- [ ] **Bypass list:** the release app, and the Repository admin role (to delete a tag after a failed release, see [RELEASING.md](../../RELEASING.md#if-a-release-fails)).
- [ ] The pattern doesn't match the moving major tag `v1`, so the release workflow can move it. To protect `v1` from everyone else too, add `refs/tags/v*` to the same ruleset: the release app can still move it.

## 9. npm

- [ ] **Your npm account:** two-factor authentication on, with a security key or passkey. In **Account → Two-Factor Authentication**, require it for sign-in and for writes.
- [ ] **Before the first release:** `npm view setupscore` should answer 404 (the name is free). Then follow [RELEASING.md, step 2](../../RELEASING.md#2-the-first-release-100-with-a-temporary-npm-token): the temporary `NPM_TOKEN` secret, and the `feat: first public release` pull request.
- [ ] **After 1.0.0:** add the trusted publisher on npmjs.com, in the package's **Settings → Trusted Publisher → GitHub Actions**:

  | Field                | Value                                                                             |
  | -------------------- | --------------------------------------------------------------------------------- |
  | Organization or user | `mohamedsabith`                                                                   |
  | Repository           | `setupscore`                                                                      |
  | Workflow filename    | `release.yml`                                                                     |
  | Environment          | Empty, unless the release job in `release.yml` uses an environment: then its name |

  Do this just before you merge the next `feat` or `fix`: a trusted publisher that isn't used within 48 hours expires. See [RELEASING.md, step 3](../../RELEASING.md#3-switch-to-npm-trusted-publishing).

- [ ] **When trusted publishing works:** delete the `NPM_TOKEN` secret, revoke the token on npmjs.com, and in the package's **Settings → Publishing access** choose **"Require two-factor authentication and disallow tokens"**.
- [ ] **When a second maintainer joins:** make them a second owner (`npm owner add <their-npm-user> setupscore`) and update [MAINTAINERS.md](../../MAINTAINERS.md).

## 10. Your GitHub account

- [ ] Two-factor authentication on, with a passkey or security key. This project requires it from everyone with the Triage role or higher ([GOVERNANCE.md](../../GOVERNANCE.md)).
- [ ] Optional: sign your commits and tags. Don't require signed commits from contributors: squash merges made on GitHub are signed by GitHub anyway.

## 11. After the first release

- [ ] **Insights → Community standards:** every item should be checked (description, README, code of conduct, contributing, license, security policy, issue templates, pull request template).
- [ ] **OpenSSF Scorecard badge:** once the Scorecard workflow has run on `main` and published results, add the badge to the README. Expect a middle score at first: some checks need the repository to be 90 days old, or more than one reviewer.
- [ ] **OpenSSF Best Practices badge:** register at [bestpractices.dev](https://www.bestpractices.dev) and answer the "passing" questions. Most answers point to files that already exist here.
- [ ] **Milestones:** create one for the next minor version (for example `v1.1.0`), with a one-line goal, and add the `roadmap` issues to it.
- [ ] Check that the links in `.github/ISSUE_TEMPLATE/config.yml` open the right Discussions categories.

## 12. Every 6 months

- [ ] Review who has access, and update [MAINTAINERS.md](../../MAINTAINERS.md).
- [ ] Check that both rulesets are still **Active**, and that the required checks still match the CI job names.
- [ ] Rotate the release app's private key: generate a new key, update `RELEASE_APP_PRIVATE_KEY`, then delete the old key on the app's page.
- [ ] Check that no `NPM_TOKEN` secret exists any more (`gh secret list --repo "$R"`).
