# Governance

This page explains who makes decisions in setupscore, how, and how you can take on more responsibility.

## Model

setupscore is **maintainer-led**. Today it has one lead maintainer, [Mohamed Sabith](https://github.com/mohamedsabith) (@mohamedsabith). Decisions are made in public, on GitHub: in issues, pull requests and Discussions. Private channels are used only for security reports and Code of Conduct reports.

The current maintainers and who holds which access are listed in [MAINTAINERS.md](MAINTAINERS.md).

## Roles

| Role | Who | What they can do | How to get there |
| --- | --- | --- | --- |
| **User** | Anyone who uses setupscore | Ask, report, suggest | Use it |
| **Contributor** | Anyone with a merged pull request, a confirmed report, or a helpful answer in Discussions | Everything a user can do | Contribute (see [CONTRIBUTING.md](CONTRIBUTING.md)) |
| **Triager** | Listed in MAINTAINERS.md. GitHub **Triage** role | Label issues, close duplicates, ask for information, move questions to Discussions | A maintainer nominates you after about 5 good contributions, such as reports, reviews or answers. Two-factor authentication on GitHub is required |
| **Maintainer** | Listed in MAINTAINERS.md. GitHub **Write** or **Maintain** role | Review and merge pull requests, decide on issues, help with security reports | Steady, good contributions for about 3 months, and good judgement about false alarms (precision) versus missed problems (recall). A maintainer nominates you in a public issue. You are accepted if no maintainer objects within 7 days |
| **Lead maintainer** | Listed in MAINTAINERS.md. GitHub **Admin**, npm owner | Releases, repository and npm settings, security advisories, the final decision while there are fewer than 3 maintainers | Chosen by the maintainers if the role becomes free |

Two-factor authentication is required for everyone with the Triage role or higher.

## How decisions are made

- **Day to day:** through pull request review. A maintainer approves and merges. While there is one maintainer, they merge their own pull requests after CI passes.
- **Bigger changes need an issue or discussion first,** labeled `roadmap`, and left open for at least 7 days so people can comment. Bigger changes are:
  - changes to the public contract: commands, flags, exit codes, `setupscore.yml`, the JSON output (`schemaVersion`), the library API, and the inputs and outputs of the GitHub Action;
  - support for a new agent (for example Codex or Cursor);
  - a new kind of check or a change in how the Setup Score is calculated;
  - a new runtime dependency.

  If nobody raises a problem that isn't resolved, the change goes ahead (lazy consensus).

- **When people disagree:** maintainers try to reach agreement in the issue. With 3 or more maintainers, a simple majority of maintainers decides. With fewer, the lead maintainer decides and writes down why.
- **The roadmap** is in [ROADMAP.md](ROADMAP.md). It is updated with each minor release.

## Access and accountability

- [MAINTAINERS.md](MAINTAINERS.md) lists everyone with sensitive access: GitHub admin, npm owners, the release GitHub App, and repository secrets.
- It is reviewed every 6 months, and whenever someone joins or leaves.
- Access is given only for a role's work, and removed when the role ends.

## Inactivity

Someone with the Triage role or higher who has no activity in the project for 12 months becomes **emeritus**. Their access is removed, and their name moves to the Emeritus list in MAINTAINERS.md, with thanks. They can come back by asking in an issue.

## Continuity

A project used in CI must not die silently or fall into the wrong hands.

- As soon as there is a trusted second maintainer, they become a second npm owner and a second GitHub admin.
- If the lead maintainer can't be reached for 90 days, the other maintainers may take over releases and settings.
- If the project is ever no longer maintained, the README will say so at the top, the npm package will be marked as deprecated with a message, and the repository will be archived. Nobody will be given the npm package or the repository without a public announcement first.

## Code of Conduct

Everyone in the project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Maintainers handle reports in private and decide on actions together. A maintainer who is part of a report takes no part in handling it. Reports about the lead maintainer can go to another maintainer, if there is one, or to GitHub through "Report abuse".

## Licensing of contributions

setupscore is under the [MIT license](LICENSE). There is no contributor license agreement (CLA). By opening a pull request, you agree that your contribution is under the same MIT license ("inbound = outbound").

## How the project grows

| Stage | When | What changes |
| --- | --- | --- |
| 0 (now) | One maintainer | Pull requests need CI to pass, but no approval. Everything happens in public |
| 1 | The first regular contributor | They get the Triage role. More issues are labeled `good first issue` and `help wanted` |
| 2 | A second maintainer | Pull requests need 1 approval from someone other than the author. Security-sensitive paths need a code owner's review. A second npm owner and admin. Move the repository to a GitHub organization, so no single account is a single point of failure |
| 3 | 3 or more maintainers | Majority decisions. Triage duty is shared in turns |

## Changing this document

Open a pull request. It stays open for at least 14 days before it is merged, so everyone can comment.
