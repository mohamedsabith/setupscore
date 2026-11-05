# Releasing setupscore

For maintainers. Releases are automatic: nobody picks a version number or publishes by hand.

## How it works

Every push to `main` runs the Release workflow ([.github/workflows/release.yml](.github/workflows/release.yml)). It runs [semantic-release](https://semantic-release.gitbook.io) with [.releaserc.json](.releaserc.json). semantic-release reads the Conventional Commit messages since the last release. Pull requests are squash-merged, so each message is a pull request title.

If one of those commits is a `feat`, a `fix`, a `perf` or a breaking change, the workflow:

1. picks the next version,
2. writes the release notes into `CHANGELOG.md`, sets the version in `package.json` and `package-lock.json`, and sets the default `version` input of `action.yml` to the major version,
3. commits these files as `chore(release): X.Y.Z [skip ci]` and tags the commit `vX.Y.Z`,
4. publishes to npm with provenance, through npm trusted publishing (no npm token is stored),
5. creates the GitHub release with the same notes, and comments "released" on the issues and pull requests it includes,
6. moves the major tag (`v1`) to the new release.

If no commit since the last release is releasable (only `docs`, `test`, `chore` and similar), nothing happens.

## Version rules

setupscore follows [Semantic Versioning](https://semver.org). The public contract (commands, flags, exit codes, `setupscore.yml`, the JSON output, the library API, the Action's inputs and outputs) only grows within a major version.

| Pull request title                                | What it means                      | Version           |
| ------------------------------------------------- | ---------------------------------- | ----------------- |
| `feat: first public release`                      | The first release                  | **1.0.0**         |
| `fix(rules): stop flagging URLs as missing paths` | A bug fix                          | 1.0.0 → **1.0.1** |
| `perf(check): read each file only once`           | Faster, same behavior              | 1.0.1 → **1.0.2** |
| `feat(run): add --max-cost-per-task`              | A new feature, nothing breaks      | 1.0.2 → **1.1.0** |
| `feat(cli)!: rename --budget to --max-cost`       | A breaking change                  | 1.1.0 → **2.0.0** |
| `docs: explain the sandbox limits`                | No change for users of the package | no release        |

When several pull requests are merged before a release runs, the biggest change wins. One `feat` and three `fix` commits give a minor release.

A change is breaking if a user's working command, config file, CI workflow or script could stop working after the update. Removing or renaming a flag, changing an exit code, changing a JSON field, or dropping a Node.js version are breaking. Adding a flag, a JSON field or a new rule is not. A new rule can add findings, so users who need the same findings every time pin an exact version.

## The moving major tag

GitHub Action users write `uses: mohamedsabith/setupscore@v1`. The `v1` tag is not a release. After each stable release, the workflow moves `v1` to the newest `v1.x.y` tag. `action.yml`'s default `version` input is the major version (`'1'`), so the Action runs `npx setupscore@1`, the newest 1.x.

`v1` does **not** move for:

- a prerelease (`1.1.0-beta.1`),
- a fix on an older line (`1.4.1` released after `1.5.0`).

After `2.0.0`, the workflow creates `v2`. `v1` stays on the last 1.x release, so workflows pinned to `@v1` keep working.

## One-time setup

Do these steps once, in this order. The settings themselves are in [docs/maintainers/repo-settings.md](docs/maintainers/repo-settings.md).

### 1. The release GitHub App

The release commit and tags must get past the rulesets on `main` and on tags. The built-in `GITHUB_TOKEN` can't be added to a bypass list, so the workflow uses a small GitHub App.

1. Create an app at <https://github.com/settings/apps/new>, for example `setupscore-release`. No webhook. Repository permissions: **Contents**, **Issues** and **Pull requests**, all _Read and write_.
2. Install it on this repository only.
3. Generate a private key.
4. In **Settings → Secrets and variables → Actions**, add the variable `RELEASE_APP_CLIENT_ID` (the app's Client ID) and the secret `RELEASE_APP_PRIVATE_KEY` (the whole `.pem` file).
5. Add the app to the bypass list of the `main` ruleset and the release-tag ruleset.

Until `RELEASE_APP_CLIENT_ID` exists, the Release job is skipped.

### 2. The first release (1.0.0) with a temporary npm token

npm only lets you set up trusted publishing for a package that already exists. So the first version is published from CI with a short-lived token. It still gets provenance, because provenance comes from the workflow, not from the token.

1. On [npmjs.com](https://www.npmjs.com), turn on two-factor authentication for your account.
2. Create a **granular access token**: _Read and write_ for packages, _Bypass two-factor authentication_ ticked, expiry **30 days**.
3. Save it as the repository secret `NPM_TOKEN`.
4. Check that nothing releasable has been merged since the last change to this setup, and that no `v*` tag exists. With no release tag in the repository, semantic-release makes its first release **1.0.0**. Never create a `v0.*` tag.
5. Merge the pull request titled `feat: first public release`. The workflow publishes `setupscore@1.0.0`, tags `v1.0.0`, creates `v1` and the GitHub release.
6. Check the result: see [After every release](#after-every-release).

### 3. Switch to npm trusted publishing

1. On npmjs.com, open the package, then **Settings → Trusted Publisher → GitHub Actions**. Enter owner `mohamedsabith`, repository `setupscore` and workflow `release.yml`. If the release job in `release.yml` uses a GitHub environment, enter its name too. Otherwise leave it empty.
2. A new trusted-publisher setting expires if it isn't used to publish within 48 hours. So do this just before you merge the next `feat` or `fix`. If it expires, create it again; the token keeps releases working until then.
3. After that release, open the Release workflow log and look for `OIDC token exchange with the npm registry succeeded`.
4. Then delete the `NPM_TOKEN` secret, revoke the token on npmjs.com, and in the package settings choose **Require two-factor authentication and disallow tokens**.

From then on, no npm token exists anywhere.

## Prereleases

Use a prerelease to let people test a bigger change before it reaches everyone.

1. Create the `beta` branch from `main`:

   ```bash
   git fetch origin
   git push origin origin/main:refs/heads/beta
   ```

2. Open pull requests against `beta`, with Conventional Commit titles as usual. Each merge publishes the next prerelease, for example `1.1.0-beta.1`, then `1.1.0-beta.2`. They go to the npm dist-tag `beta`, so `npm install setupscore` still gets the newest stable version. The GitHub releases are marked as prereleases. `v1` doesn't move.
3. Testers use `npx setupscore@beta`, or in the Action `uses: mohamedsabith/setupscore@v1.1.0-beta.2` with `version: 1.1.0-beta.2`.
4. When it is ready, open a pull request from `beta` into `main`. Give it the title the stable release needs, for example `feat(run): compare two models in one run`, and squash-merge it. This publishes `1.1.0` to `latest` and moves `v1`.
5. Delete the `beta` branch: `git push origin --delete beta`. Create it again from `main` for the next prerelease.

The `next` branch works the same way, with the dist-tag `next`.

## Fixes for an older major version

After 2.0.0, a fix for 1.x goes on a maintenance branch:

```bash
git fetch origin --tags
git push origin 'v1.6.2^{commit}:refs/heads/1.x'     # the last 1.x release
```

Open the fix pull request against `1.x`. Merging it publishes `1.6.3` with the npm dist-tag `release-1.x`, and moves `v1`. `latest` stays on 2.x.

## After every release

```bash
npm view setupscore dist-tags                  # latest points at the new version
mkdir /tmp/try && cd /tmp/try && npm init -y >/dev/null
npm install setupscore@latest && npx setupscore --version
npm audit signatures                           # verified registry signature and attestation
gh release verify v1.2.0 --repo mohamedsabith/setupscore
git ls-remote --tags origin v1 v1.2.0          # v1 points at the same commit as v1.2.0
```

Also check that the release notes on GitHub read well. You can still edit the notes of a published release; its tag and files can't change.

## If a release fails

The workflow opens an issue with the error. Fix the cause, then re-run the failed workflow run, or run **Release** from the Actions tab.

- **It failed before anything was published** (tests, npm authentication): fix it and re-run.
- **The tag was pushed, but the npm publish failed:** delete the tag with `git push --delete origin vX.Y.Z` (as an admin, the tag ruleset lets you), fix the cause and re-run. Remove the duplicate entry from `CHANGELOG.md` in the next pull request.
- **npm has the version, but the GitHub release is missing:** semantic-release sees the tag and won't try again. Create the release by hand, with the notes from `CHANGELOG.md`: `gh release create vX.Y.Z --verify-tag --title vX.Y.Z --notes-file notes.md`. Then move `v1` as described below.
- **Two pull requests merged within minutes:** the second Release run may find that `main` moved and stop. Run **Release** again from the Actions tab.

Never fix a release by editing the version in `package.json`, editing a released section of `CHANGELOG.md`, pushing a `v*.*.*` tag yourself, or running `npm publish` on your machine. A version published from a laptop has no provenance.

## Roll back a bad release

A published version can't be replaced: npm never allows the same version number twice, and immutable GitHub releases can't change their tag or files. So you roll **forward**:

1. **Fix or revert it.** Open a pull request that fixes the problem, or reverts the bad change, with a `fix:` title, for example `fix: revert "feat(run): add --max-cost-per-task"`. Merging it publishes a new patch version.
2. **Deprecate the bad version**, so npm warns everyone who installs it:

   ```bash
   npm login                       # with your npm account's two-factor authentication
   npm deprecate setupscore@1.2.0 "Broken: <what is wrong>. Use 1.2.1 or newer."
   ```

3. **If the fix will take a while**, point `latest` back at the last good version, so new installs get it:

   ```bash
   npm dist-tag add setupscore@1.1.3 latest
   ```

   And move the Action's major tag back:

   ```bash
   git fetch origin --tags
   git tag -f v1 'v1.1.3^{commit}'
   git push -f origin refs/tags/v1
   ```

   The next stable release moves both forward again.

4. **Tell people.** Add a warning at the top of the bad version's GitHub release notes. If many users are affected, post in Discussions → Announcements. For a security problem, also publish a GitHub Security Advisory that names the affected versions (see [SECURITY.md](SECURITY.md)).

Avoid `npm unpublish`. npm only allows it in a few cases, the version number can never be used again, and it breaks every project that already installed that version. The one exception: a version that accidentally contains a secret. Then unpublish it if npm allows it, **and** revoke the secret, because it has already been seen.
