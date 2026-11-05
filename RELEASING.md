# Releasing setupscore

For maintainers. A release is one tag: push `vX.Y.Z`, and the Release workflow tests, publishes and announces it. Nobody runs `npm publish` on a laptop.

## How it works

Pushing a tag such as `v1.0.1` runs the Release workflow ([.github/workflows/release.yml](.github/workflows/release.yml)). It:

1. checks that the tag matches the version in `package.json`, and stops if it doesn't,
2. installs, type-checks and runs the whole test suite on Linux, sandbox tests included,
3. publishes to npm with provenance. A prerelease (`v1.1.0-beta.1`) goes to the npm dist-tag `next`, so `npm install setupscore` keeps getting the newest stable version. A version that is already on npm is skipped, so a failed run can simply be re-run,
4. creates the GitHub release, which links to `CHANGELOG.md`,
5. moves the major tag (`v1`) to the new release.

Pushes to `main` don't release anything.

## Version rules

setupscore follows [Semantic Versioning](https://semver.org). The public contract (commands, flags, exit codes, `setupscore.yml`, the JSON output, the library API, the Action's inputs and outputs) only grows within a major version.

| Change since the last release                  | Version           |
| ---------------------------------------------- | ----------------- |
| Bug fixes only                                 | 1.0.0 → **1.0.1** |
| Faster, same behavior                          | 1.0.1 → **1.0.2** |
| A new feature, nothing breaks (a flag, a rule) | 1.0.2 → **1.1.0** |
| A breaking change                              | 1.1.0 → **2.0.0** |
| Docs, tests or tooling only                    | no release        |

A change is breaking if a user's working command, config file, CI workflow or script could stop working after the update. Removing or renaming a flag, changing an exit code, changing a JSON field, or dropping a Node.js version are breaking. Adding a flag, a JSON field or a new rule is not. A new rule can add findings, so users who need the same findings every time pin an exact version.

## Make a release

From an up-to-date `main` with nothing uncommitted:

```bash
npm version 1.0.1 --no-git-tag-version   # sets package.json and package-lock.json
```

1. Add a section to the top of `CHANGELOG.md`: `## 1.0.1 - YYYY-MM-DD`, with one line per change, written for users.
2. Run `npm test`.
3. Commit and push: `git commit -am "chore(release): 1.0.1" && git push origin main`.
4. Tag and push the tag:

   ```bash
   git tag v1.0.1
   git push origin v1.0.1
   ```

5. Watch **Actions → Release**, then do the checks in [After every release](#after-every-release).

## The first release (1.0.0)

npm only lets you set up trusted publishing for a package that already exists. So the first version is published from CI with a short-lived token. It still gets provenance, because provenance comes from the workflow, not from the token.

1. On [npmjs.com](https://www.npmjs.com), turn on two-factor authentication for your account.
2. Create a **granular access token** (avatar → **Access Tokens** → **Generate New Token**):
   - name: `setupscore first release`,
   - expiration: **7 days**,
   - packages and scopes: **Read and write**, for all packages (setupscore doesn't exist yet, so it can't be selected),
   - tick **Bypass two-factor authentication**, so CI can publish.
3. In GitHub, **Settings → Secrets and variables → Actions → New repository secret**: name `NPM_TOKEN`, value the token. Never paste it anywhere else.
4. `package.json` already says `1.0.0`, and `CHANGELOG.md` has its section. Tag and push:

   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

5. When the Release run is green, do the checks in [After every release](#after-every-release).

Then switch to trusted publishing, so no npm token exists anywhere:

1. On npmjs.com, open the package, then **Settings → Trusted Publisher → GitHub Actions**. Enter owner `mohamedsabith`, repository `setupscore` and workflow `release.yml`. Leave the environment empty.
2. Delete the `NPM_TOKEN` secret in GitHub, and revoke the token on npmjs.com.
3. In the package settings, choose **Require two-factor authentication and disallow tokens**.
4. At the next release, look for `OIDC token exchange with the npm registry succeeded` in the Release log.

## Prereleases

Use a prerelease to let people test a bigger change before it reaches everyone.

1. Set the version, for example `npm version 1.1.0-beta.1 --no-git-tag-version`, commit and push.
2. Tag `v1.1.0-beta.1` and push the tag. It goes to the npm dist-tag `next`, the GitHub release is marked as a prerelease, and `v1` doesn't move.
3. Testers use `npx setupscore@next`, or in the Action `uses: mohamedsabith/setupscore@v1.1.0-beta.1` with `version: 1.1.0-beta.1`.
4. When it is ready, release `1.1.0` the normal way.

## After every release

```bash
npm view setupscore dist-tags                  # latest points at the new version
mkdir /tmp/try && cd /tmp/try && npm init -y >/dev/null
npm install setupscore@latest && npx setupscore --version
npm audit signatures                           # verified registry signature and attestation
git ls-remote --tags origin v1 v1.0.1          # v1 points at the same commit as v1.0.1
```

Also check that the GitHub release reads well. You can edit its notes at any time.

## If a release fails

- **It failed before anything was published** (tests, a tag that doesn't match `package.json`, npm sign-in): if the code or version needs a change, delete the tag (`git push --delete origin v1.0.1` and `git tag -d v1.0.1`), fix it on `main`, then tag again. Otherwise re-run the failed run.
- **npm has the version, but the GitHub release or the `v1` tag is missing:** re-run the failed run. Publishing is skipped because the version is already on npm, and the remaining steps run.

Never publish from your machine with `npm publish`: a version published from a laptop has no provenance.

## Roll back a bad release

A published version can't be replaced: npm never allows the same version number twice. So you roll **forward**:

1. **Fix or revert it** on `main`, then release a new patch version.
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

4. **Tell people.** Add a warning at the top of the bad version's GitHub release notes. If many users are affected, post in Discussions. For a security problem, also publish a GitHub Security Advisory that names the affected versions (see [SECURITY.md](SECURITY.md)).

Avoid `npm unpublish`. npm only allows it in a few cases, the version number can never be used again, and it breaks every project that already installed that version. The one exception: a version that accidentally contains a secret. Then unpublish it if npm allows it, **and** revoke the secret, because it has already been seen.
