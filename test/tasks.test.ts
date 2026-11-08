import { execFileSync } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EnvironmentError, loadRuntime, openSandbox, probeOsSandbox } from '../src/sandbox/index.js';
import { OsSandbox } from '../src/sandbox/os.js';
import { safeEnv, secretPaths } from '../src/sandbox/env.js';
import { buildPrompt, buildTasks, type BuildOptions } from '../src/tasks/build.js';
import { checkProjectFolder, findCandidates } from '../src/tasks/mine.js';
import {
  cacheEnv,
  detectPm,
  installFailure,
  nodeGlobLiteral,
  noTestsRan,
  registryDomains,
  runnerCommand,
} from '../src/tasks/pm.js';
import { newTestNames, testNames } from '../src/tasks/testnames.js';
import { explainGitFailure, git as git2, GitError, gitTimeoutMs } from '../src/tasks/git.js';
import { git, initGit, makeRepo, writeFiles } from './helpers.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;

describe('finding candidate commits', () => {
  it('keeps commits that change both tests and source code, newest first', async () => {
    const root = makeRepo({ 'src/a.ts': '1', 'README.md': 'x' });
    initGit(root);
    const commit = (files: Record<string, string>, msg: string) => {
      writeFiles(root, files);
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', msg);
    };
    commit({ 'src/a.ts': '2', 'src/a.test.ts': 't' }, 'Feature A');
    commit({ 'README.md': 'docs only' }, 'Docs');
    commit({ 'src/b.spec.tsx': 't' }, 'Tests only');
    commit(
      { 'src/c.ts': 'c', 'src/__tests__/c.ts': 't', 'docs/x.ts': 'd', 'examples/demo/index.spec.cjs': 'e' },
      'Feature C',
    );
    commit({ 'src/a.ts': '1', 'src/a.test.ts': 'u' }, 'Revert "Feature A"');

    const { candidates, scanned } = await findCandidates(root, { max: 10 });
    expect(scanned).toBe(6);
    expect(candidates.map((c) => c.title)).toEqual(['Feature C', 'Feature A']);
    expect(candidates[0]).toMatchObject({ testFiles: ['src/__tests__/c.ts'], sourceFiles: ['src/c.ts'] });
  });

  it('works for a package inside a monorepo (paths relative to the package)', async () => {
    const root = makeRepo({ 'packages/api/src/x.js': '1', 'packages/web/src/y.js': '1' });
    initGit(root);
    writeFiles(root, {
      'packages/api/src/x.js': '2',
      'packages/api/src/x.test.js': 't',
      'packages/web/src/y.js': '2',
      'packages/web/src/y.test.js': 't',
    });
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'Both');
    const { candidates } = await findCandidates(`${root}/packages/api`, { max: 10 });
    expect(candidates[0]).toMatchObject({ testFiles: ['src/x.test.js'], sourceFiles: ['src/x.js'] });
  });

  // Windows file names cannot hold quotes.
  posixOnly('reads file names exactly: unicode, quotes and spaces', async () => {
    const root = makeRepo({ 'src/a.js': '1', 'test/a.test.js': 't' });
    initGit(root);
    writeFiles(root, { 'src/ünï.js': '2', 'test/café "q".test.js': 't', 'test/my two.test.js': 't' });
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'Unicode');
    const { candidates } = await findCandidates(root, { max: 10 });
    expect(candidates[0]).toMatchObject({
      title: 'Unicode',
      testFiles: ['test/café "q".test.js', 'test/my two.test.js'],
      sourceFiles: ['src/ünï.js'],
    });
  });

  it('keeps feature commits named "Merge ..." but not git merges or redone commits, and remembers renamed tests', async () => {
    const OLD_TEST =
      "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('one', () => assert.equal(1, 1));\ntest('two', () => assert.equal(2, 2));\n";
    const root = makeRepo({ 'src/a.js': '1', 'test/old.test.js': OLD_TEST });
    initGit(root);
    const commit = (files: Record<string, string>, msg: string) => {
      writeFiles(root, files);
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '--allow-empty-message', '-m', msg);
    };
    commit({ 'src/a.js': '2', 'test/sort.test.js': 't' }, 'Merge sort for the results list');
    commit({ 'src/a.js': '3', 'test/b.test.js': 't' }, "Merge branch 'feature' into main");
    commit({ 'src/a.js': '4', 'test/c.test.js': 't' }, 'Reapply "Add c"');
    git(root, 'mv', 'test/old.test.js', 'test/renamed.test.js');
    commit({ 'src/a.js': '5', 'test/renamed.test.js': `${OLD_TEST}test('more', () => {});\n` }, 'Rename the test');
    // Test helpers and snapshots are part of the tests, not the change.
    commit({ 'src/a.js': '6', 'test/helpers.js': 'h', 'test/d.test.js': 't' }, 'Add d');
    commit(
      { 'test/helpers.js': 'h2', 'test/__snapshots__/e.snap': 's', 'test/e.test.js': 't' },
      'Tests and helpers only',
    );
    commit({ 'src/a.js': '7', 'test/f.test.js': 't' }, '');
    // Type tests, test setup files and fixture folders are not source files either.
    commit(
      {
        'src/types.test-d.ts': 't',
        'vitest.setup.ts': 's',
        'test/fixtures-extensions/x.js': 'f',
        'test/g.test.js': 't',
      },
      'Type tests only',
    );
    const { candidates } = await findCandidates(root, { max: 10 });
    expect(candidates.map((c) => c.title)).toEqual([
      'Update src/a.js so the new tests pass',
      'Add d',
      'Rename the test',
      'Merge sort for the results list',
    ]);
    expect(candidates[1]).toMatchObject({ testFiles: ['test/d.test.js'], sourceFiles: ['src/a.js'] });
    expect(candidates[2]!.previousPaths).toEqual({ 'test/renamed.test.js': 'test/old.test.js' });
  });

  it('explains repositories it cannot use: no commits, bare, a subfolder of the project, a bad --since', async () => {
    const empty = makeRepo({ 'package.json': '{}' });
    git(empty, 'init', '-q');
    await expect(findCandidates(empty, { max: 10 })).rejects.toMatchObject({
      name: 'UsageError',
      message: expect.stringContaining('no commits yet'),
    });

    const root = makeRepo({ 'package.json': '{}', 'src/a.js': '1' });
    initGit(root);
    await expect(findCandidates(join(root, 'src'), { max: 10, requirePackageJson: true })).rejects.toMatchObject({
      name: 'UsageError',
      message: expect.stringContaining('inside the project'),
    });
    // A Python project, and a monorepo root whose packages have their own package.json
    const python = makeRepo({ 'pyproject.toml': '', 'tests/test_a.py': '' });
    initGit(python);
    await expect(checkProjectFolder(python)).rejects.toMatchObject({
      message: expect.stringContaining('supports JavaScript and TypeScript projects'),
    });
    const mono = makeRepo({ 'packages/api/package.json': '{}', 'packages/api/test/fixtures/x/package.json': '{}' });
    initGit(mono);
    await expect(checkProjectFolder(mono)).rejects.toMatchObject({
      fixes: [expect.stringMatching(/setupscore tasks .*packages[\\/]api$/)],
    });
    await expect(checkProjectFolder(join(mono, 'packages/api'))).resolves.toBeUndefined();
    await expect(findCandidates(root, { max: 10, since: 'not-a-date' })).rejects.toMatchObject({
      name: 'UsageError',
      message: expect.stringContaining('not a date'),
    });
    await expect(findCandidates(root, { max: 10, since: '2 years ago' })).resolves.toMatchObject({
      scanned: 1,
      shallow: false,
      limitReached: false,
    });

    const bare = `${makeRepo({})}/bare.git`;
    git(root, 'clone', '-q', '--bare', root, bare);
    await expect(findCandidates(bare, { max: 10 })).rejects.toMatchObject({
      name: 'UsageError',
      message: expect.stringContaining('bare repository'),
    });
  });

  it('notices a shallow clone and a scan that stopped at its limit', async () => {
    const root = makeRepo({ 'src/a.js': '1' });
    initGit(root);
    for (let i = 2; i <= 4; i++) {
      writeFiles(root, { 'src/a.js': String(i), [`test/t${i}.test.js`]: 't' });
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', `Commit ${i}`);
    }
    const shallow = `${makeRepo({})}/shallow`;
    git(root, 'clone', '-q', '--depth', '1', `file://${root}`, shallow);
    await expect(findCandidates(shallow, { max: 10 })).resolves.toMatchObject({ candidates: [], shallow: true });
    await expect(findCandidates(root, { max: 10, scan: 2 })).resolves.toMatchObject({ scanned: 2, limitReached: true });
  });
});

describe('git commands', () => {
  it('turns git failures into plain-English errors with fixes', async () => {
    const notRepo = makeRepo({ 'a.txt': '' });
    process.env['GIT_CEILING_DIRECTORIES'] = join(notRepo, '..');
    try {
      await expect(git2(notRepo, ['rev-parse', '--show-toplevel'])).rejects.toMatchObject({
        name: 'GitError',
        kind: 'not-a-repo',
        message: expect.stringMatching(/not a git repository/i),
      });
    } finally {
      delete process.env['GIT_CEILING_DIRECTORIES'];
    }
    await expect(git2(join(notRepo, 'missing'), ['status'])).rejects.toMatchObject({
      kind: 'folder-not-found',
      code: 'ENOENT',
      message: expect.stringContaining('Folder not found'),
    });
    await expect(git2(join(notRepo, 'a.txt'), ['status'])).rejects.toMatchObject({
      kind: 'folder-not-found',
      message: expect.stringContaining('is a file'),
    });
    const path = process.env['PATH'];
    process.env['PATH'] = notRepo;
    try {
      await expect(git2(notRepo, ['status'])).rejects.toMatchObject({
        kind: 'missing-git',
        code: 'ENOENT',
        message: expect.stringContaining('spawn git ENOENT'),
      });
    } finally {
      process.env['PATH'] = path;
    }
    const e = explainGitFailure('/repo', ['status'], {
      exitCode: 128,
      stderr:
        "fatal: detected dubious ownership in repository at '/srv/my repo'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory '/srv/my repo'\n",
    });
    expect(e).toBeInstanceOf(GitError);
    expect(e.kind).toBe('dubious-ownership');
    expect(e.message).not.toMatch(/not a git repository/i);
    expect(e.fixes[0]).toContain("git config --global --add safe.directory '/srv/my repo'");
  });

  it('ignores git variables that point at another repository, and clones even when local clones are refused', async () => {
    const mine = makeRepo({ 'mine.txt': '' });
    initGit(mine);
    const other = makeRepo({ 'other.txt': '' });
    initGit(other);
    const saved = { ...process.env };
    Object.assign(process.env, {
      GIT_DIR: join(other, '.git'),
      GIT_WORK_TREE: other,
      GIT_INDEX_FILE: join(other, '.git', 'index'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'protocol.file.allow',
      GIT_CONFIG_VALUE_0: 'never',
    });
    try {
      expect((await git2(mine, ['ls-files'])).trim()).toBe('mine.txt');
      const into = join(makeRepo({}), 'copy');
      await git2(mine, ['clone', '--quiet', '--shared', '--no-checkout', mine, into]);
      expect((await git2(into, ['ls-tree', '--name-only', 'HEAD'])).trim()).toBe('mine.txt');
    } finally {
      for (const k of [
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_INDEX_FILE',
        'GIT_CONFIG_COUNT',
        'GIT_CONFIG_KEY_0',
        'GIT_CONFIG_VALUE_0',
      ]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
    const old = explainGitFailure('/repo', ['log'], {
      exitCode: 128,
      stderr: 'fatal: unknown repository extension found:\n\trefstorage\n',
    });
    expect(old).toMatchObject({ kind: 'unsupported-repo', fixes: [expect.stringContaining('Update git')] });
    const refused = explainGitFailure('/tmp', ['clone', '/repo', '/tmp/x'], {
      exitCode: 128,
      stderr: "fatal: transport 'file' not allowed\n",
    });
    expect(refused).toMatchObject({
      kind: 'transport-not-allowed',
      fixes: [expect.stringContaining('protocol.file.allow'), expect.any(String)],
    });
  });

  it.runIf(process.platform !== 'win32' && process.getuid?.() === 0)(
    'detects a repository owned by another user',
    async () => {
      const root = makeRepo({ 'a.txt': '' });
      initGit(root);
      execFileSync('chown', ['-R', '12345:12345', root]);
      await expect(git2(root, ['status'])).rejects.toMatchObject({
        kind: 'dubious-ownership',
        fixes: [expect.stringContaining(`safe.directory ${root}`), expect.any(String)],
      });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'stops a git command that runs too long, with everything it started',
    async () => {
      const root = makeRepo({ 'a.txt': '' });
      initGit(root);
      const marker = `${Date.now() % 100000}.25`;
      const started = Date.now();
      await expect(git2(root, ['-c', `alias.hang=!sleep ${marker}`, 'hang'], { timeoutMs: 500 })).rejects.toMatchObject(
        { kind: 'timeout', code: 'ETIMEDOUT' },
      );
      expect(Date.now() - started).toBeLessThan(10_000);
      await new Promise((r) => setTimeout(r, 200));
      const left = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' })
        .split('\n')
        .filter((l) => l.includes(`sleep ${marker}`));
      expect(left).toEqual([]);
      process.env['SETUPSCORE_GIT_TIMEOUT_MS'] = '1234';
      try {
        expect(gitTimeoutMs()).toBe(1234);
      } finally {
        delete process.env['SETUPSCORE_GIT_TIMEOUT_MS'];
      }
      expect(gitTimeoutMs()).toBe(600_000);
    },
  );
});

describe('test runner output', () => {
  it('tells "no tests ran" apart from passing and failing runs', () => {
    expect(noTestsRan('TAP version 13\n1..0\n# tests 0\n# suites 0\n# pass 0\n# fail 0\n')).toBe(true);
    expect(noTestsRan('ℹ tests 0\nℹ pass 0\n')).toBe(true);
    expect(noTestsRan('No tests found, exiting with code 0\nPattern: app/[id]/a.test.js - 0 matches')).toBe(true);
    expect(noTestsRan('No test files found, exiting with code 1')).toBe(true);
    expect(noTestsRan('Total:     0\nPassed:    0\n')).toBe(true);
    expect(noTestsRan('# tests 2\n# pass 1\n# fail 1\n')).toBe(false);
    expect(noTestsRan('Tests:       1 failed, 1 total\n')).toBe(false);
    // One workspace without tests, another with tests: tests ran.
    expect(noTestsRan('# tests 0\n# pass 0\n...\n# tests 3\n# pass 3\n')).toBe(false);
  });

  it('keeps the real reason an install failed', () => {
    const npmCi = [
      'npm error code EUSAGE',
      'npm error',
      'npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with `npm install` before continuing.',
      'npm error',
      'npm error Missing: ms@2.1.3 from lock file',
      'npm error',
      'npm error Clean install a project',
      'npm error',
      'npm error Usage:',
      'npm error npm ci',
      'npm error',
      'npm error Options:',
      'npm error [--install-strategy <hoisted|nested|shallow|linked>] [--legacy-bundling]',
      'npm error',
      'npm error aliases: clean-install, ic, install-clean, isntall-clean',
      'npm error',
      'npm error Run "npm help ci" for more info',
      'npm error A complete log of this run can be found in: /tmp/x/_logs/2026-11-05T11_24_26_783Z-debug-0.log',
    ].join('\n');
    expect(installFailure(npmCi)).toMatch(
      /^`npm ci` can only install packages when your package.json and package-lock.json .* are in sync/,
    );
    expect(
      installFailure(
        ' ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date',
      ),
    ).toContain('ERR_PNPM_OUTDATED_LOCKFILE');
    expect(installFailure('everything is fine')).toBeNull();
  });
});

describe('test names', () => {
  it('reads test() and it() names and finds the new ones', () => {
    const before = 'test(\'adds\', () => {});\nit("subtracts", () => {});';
    const after = `${before}\nit.only('multiplies two numbers', () => {});\ntest(\`divides by \${n}\`, () => {});\ntest('it\\'s escaped', () => {});\ntest.skip('later', () => {});`;
    expect(testNames(after)).toEqual(['adds', 'subtracts', 'multiplies two numbers', "it's escaped"]);
    expect(newTestNames(before, after)).toEqual(['multiplies two numbers', "it's escaped"]);
    expect(newTestNames(null, before)).toEqual(['adds', 'subtracts']);
  });
});

describe('package managers', () => {
  const pkg = (extra: object = {}) =>
    JSON.stringify({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '1' }, ...extra });

  it('picks the package manager from the lockfile', () => {
    const cases: [Record<string, string>, string, string][] = [
      [{ 'package-lock.json': '{}' }, 'npm ci', "vitest run 'a.test.ts'"],
      [{ 'pnpm-lock.yaml': '' }, 'pnpm install --frozen-lockfile', "vitest run 'a.test.ts'"],
      [{ 'yarn.lock': '' }, 'yarn install --frozen-lockfile --non-interactive', "vitest run 'a.test.ts'"],
      [
        { 'yarn.lock': '', '.yarnrc.yml': 'nodeLinker: node-modules\n' },
        'yarn install --immutable',
        "vitest run 'a.test.ts'",
      ],
      // Yarn 2+ uses Plug'n'Play unless told otherwise: no node_modules/.bin, so the runner starts through yarn
      [{ 'yarn.lock': '', '.yarnrc.yml': '' }, 'yarn install --immutable', "yarn vitest run 'a.test.ts'"],
      [{ 'bun.lock': '' }, 'bun install --frozen-lockfile', "vitest run 'a.test.ts'"],
      [{}, 'npm install --no-package-lock', "vitest run 'a.test.ts'"],
    ];
    for (const [files, install, test] of cases) {
      const pm = detectPm(makeRepo({ 'package.json': pkg(), ...files }));
      if ('error' in pm) throw new Error(pm.error);
      expect(pm.install).toBe(install);
      if (process.platform !== 'win32') expect(pm.test(['a.test.ts'])).toBe(test);
      expect(pm.installRoot).toBe('.');
    }
  });

  posixOnly('runs only the given files through the real test runner in the test script', () => {
    const f = ['a.test.js'];
    expect(runnerCommand('node --test && npm run check:type:ts', f)).toBe("node --test 'a.test.js'");
    expect(runnerCommand('cross-env NODE_ENV=test jest --runInBand', f)).toBe(
      "cross-env NODE_ENV=test jest --runInBand 'a\\.test\\.js'",
    );
    expect(runnerCommand('node --experimental-vm-modules --test', f)).toBe(
      "node --experimental-vm-modules --test 'a.test.js'",
    );
    expect(runnerCommand('node --import tsx --test-reporter spec --test', f)).toBe(
      "node --import tsx --test-reporter spec --test 'a.test.js'",
    );
    expect(runnerCommand('mocha "test/**/*.js"', f)).toBe(`mocha "test/**/*.js" 'a.test.js'`);
    expect(runnerCommand('npx --no-install vitest run', f)).toBe("vitest run 'a.test.js'");
    // Unknown runners, pipes and node running a script fall back to the whole script.
    expect(runnerCommand('turbo run test', f)).toBeNull();
    expect(runnerCommand('jest | tee out.txt', f)).toBeNull();
    expect(runnerCommand('node scripts/test.js --test', f)).toBeNull();
    const pm = detectPm(
      makeRepo({
        'package.json': JSON.stringify({ scripts: { test: 'turbo run test' } }),
        'package-lock.json': '{}',
      }),
    );
    if ('error' in pm) throw new Error(pm.error);
    expect(pm.test(['x.test.ts'])).toBe('npm test --silent');
    expect(pm.wholeScript).toBe(true);
  });

  posixOnly('passes file names so each runner reads them literally', () => {
    const f = ['app/[id]/a.test.js', 'app/(shop)/b.test.js'];
    // jest and playwright read regular expressions
    expect(runnerCommand('jest', f)).toBe("jest 'app/\\[id\\]/a\\.test\\.js' 'app/\\(shop\\)/b\\.test\\.js'");
    // node --test reads glob patterns without an escape character
    expect(runnerCommand('node --test', f)).toBe("node --test 'app/[[]id]/a.test.js' 'app/(shop)/b.test.js'");
    expect(nodeGlobLiteral('w/{x,y}/q?/s*/@(z)/c.test.js')).toBe('w/?x,y?/q[?]/s[*]/@[(]z)/c.test.js');
    // vitest, bun and mocha read file names
    expect(runnerCommand('vitest run', f)).toBe("vitest run 'app/[id]/a.test.js' 'app/(shop)/b.test.js'");
    // uvu reads a folder and a pattern
    expect(runnerCommand('uvu test', ['test/a.test.js'])).toBe("uvu . '^(?:test[\\\\/]a\\.test\\.js)$'");
    expect(runnerCommand('uvu -r tsm tests -i fixtures', ['tests/a.test.ts', 'tests/b.test.ts'])).toBe(
      "uvu -r tsm -i fixtures . '^(?:tests[\\\\/]a\\.test\\.ts|tests[\\\\/]b\\.test\\.ts)$'",
    );
    // "cd test && ..." starts the runner in another folder
    expect(runnerCommand('cd test && node --test', ['test/a.test.js'])).toBe("cd test && node --test 'a.test.js'");
    expect(runnerCommand('cd .. && node --test', ['test/a.test.js'])).toBeNull();
  });

  posixOnly('turns off watch mode and coverage thresholds, and runs pretest first', () => {
    const f = ['a.test.js'];
    expect(runnerCommand('vitest --watch', f)).toBe("vitest 'a.test.js'");
    expect(runnerCommand('vitest watch --reporter=dot', f)).toBe("vitest run --reporter=dot 'a.test.js'");
    expect(runnerCommand('jest --watchAll', f)).toBe("jest 'a\\.test\\.js'");
    expect(runnerCommand('node --test --watch', f)).toBe("node --test 'a.test.js'");
    expect(runnerCommand('mocha -w --watch-files src', f)).toBe("mocha 'a.test.js'");
    expect(runnerCommand('npm run build && vitest run --coverage && eslint .', f)).toBe(
      "npm run build && vitest run --coverage.enabled=false 'a.test.js'",
    );
    expect(runnerCommand('jest --coverage', f)).toBe("jest --coverage=false 'a\\.test\\.js'");
    expect(runnerCommand('jest', f, { jestCoverage: true })).toBe("jest --coverage=false 'a\\.test\\.js'");
    expect(runnerCommand('c8 --100 --reporter lcov node --test', f)).toBe("node --test 'a.test.js'");
    expect(runnerCommand('NODE_ENV=test nyc --check-coverage mocha', f)).toBe("NODE_ENV=test mocha 'a.test.js'");
    expect(runnerCommand('node --test --experimental-test-coverage --test-coverage-lines=100', f)).toBe(
      "node --test --experimental-test-coverage 'a.test.js'",
    );
    expect(runnerCommand('tap', f)).toBe("tap --disable-coverage 'a.test.js'");
    expect(runnerCommand('tap --100', f, { tapMajor: 16 })).toBe("tap --no-check-coverage 'a.test.js'");
    expect(runnerCommand('node --test', f, { pretest: 'npm run pretest --silent' })).toBe(
      "npm run pretest --silent && node --test 'a.test.js'",
    );
  });

  posixOnly("runs tsx tests without its socket, and Yarn Plug'n'Play runners through yarn", () => {
    const f = ['a.test.ts'];
    expect(runnerCommand('tsx --test', f)).toBe("node --import tsx --test 'a.test.ts'");
    expect(runnerCommand('tsx --test', f, { tsxMajor: 3 })).toBe("node --loader tsx --test 'a.test.ts'");
    expect(runnerCommand('jest', f, { pnp: true })).toBe("yarn jest 'a\\.test\\.ts'");
    expect(runnerCommand('cross-env TZ=UTC jest', f, { pnp: true })).toBe("yarn cross-env TZ=UTC jest 'a\\.test\\.ts'");
    expect(runnerCommand('NODE_ENV=test node --test', f, { pnp: true })).toBe(
      "NODE_ENV=test yarn node --test 'a.test.ts'",
    );
    expect(runnerCommand('tsc -p . && npx jest', f, { pnp: true })).toBe("yarn tsc -p . && yarn jest 'a\\.test\\.ts'");
  });

  posixOnly('follows "npm run test:unit" to the runner, and runners started through yarn or pnpm', () => {
    const f = ['test/a.test.js'];
    const scripts = {
      'test:unit': 'node --test',
      'pretest:unit': 'node build.js',
      'test:app': 'vitest run --config app.config.ts',
      'test:all': 'npm run test:unit && npm run lint',
      lint: 'eslint .',
    };
    const ctx = { scripts, runScript: 'npm run --silent' };
    expect(runnerCommand('npm run test:unit', f, ctx)).toBe(
      "npm run --silent pretest:unit && node --test 'test/a.test.js'",
    );
    expect(runnerCommand('yarn test:app --bail 1', f, { scripts, runScript: 'yarn run' })).toBe(
      "vitest run --config app.config.ts --bail 1 'test/a.test.js'",
    );
    expect(
      runnerCommand('npm run build && npm run test:all', f, {
        scripts: { ...scripts, 'pretest:unit': undefined },
        runScript: 'npm run',
      }),
    ).toBe("npm run build && node --test 'test/a.test.js'");
    expect(runnerCommand('pnpm run test:app -- --reporter=dot', f, { scripts })).toBe(
      "vitest run --config app.config.ts --reporter=dot 'test/a.test.js'",
    );
    // npm reads arguments without "--" as its own options; a script that runs itself is not followed forever
    expect(runnerCommand('npm run test:unit --bail', f, ctx)).toBeNull();
    expect(runnerCommand('npm run loop', f, { scripts: { loop: 'npm run loop' } })).toBeNull();
    expect(runnerCommand('yarn jest --ci', ['a.test.js'], { scripts })).toBe("jest --ci 'a\\.test\\.js'");
    expect(runnerCommand('pnpm exec vitest run', ['a.test.js'], { scripts })).toBe("vitest run 'a.test.js'");
    expect(runnerCommand('pnpm vitest run', ['a.test.js'], { scripts, pnp: false })).toBe("vitest run 'a.test.js'");
    const pm = detectPm(
      makeRepo({
        'package.json': JSON.stringify({ scripts: { test: 'npm run test:unit', 'test:unit': 'node --test' } }),
      }),
    );
    if ('error' in pm) throw new Error(pm.error);
    expect(pm.wholeScript).toBe(false);
    if (process.platform !== 'win32') expect(pm.test(['test/a.test.js'])).toBe("node --test 'test/a.test.js'");
  });

  it('keeps every package manager cache, store and self-download inside the writable cache', () => {
    const env = cacheEnv('/cache');
    for (const key of [
      'npm_config_cache',
      'npm_config_store_dir',
      'pnpm_config_store_dir',
      'PNPM_HOME',
      'COREPACK_HOME',
      'XDG_DATA_HOME',
      'XDG_CACHE_HOME',
      'YARN_CACHE_FOLDER',
      'YARN_GLOBAL_FOLDER',
      'BUN_INSTALL_CACHE_DIR',
    ]) {
      expect(env[key]?.startsWith(join('/cache'))).toBe(true);
    }
  });

  it('gives up quickly on very long test scripts', () => {
    const scripts = [
      'Bash(' + '\n'.repeat(100_000) + 'x',
      'jest' + ' '.repeat(100_000) + '&& x',
      `cross-env ${'A=1 '.repeat(2400)}nope`,
      `node ${'--x '.repeat(3000)}y`,
      'vitest run ' + '&&'.repeat(4900),
    ];
    const started = Date.now();
    for (const script of scripts) runnerCommand(script, ['a.test.js']);
    const pm = detectPm(
      makeRepo({ 'package.json': JSON.stringify({ scripts: { test: `${'\t'.repeat(100_000)}jest` } }) }),
    );
    if ('error' in pm) throw new Error(pm.error);
    expect(pm.test(['a.test.js'])).toBe('npm test --silent');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('notices test scripts that can never fail, and replaces every {files}', () => {
    const pmOf = (test: string, overrides = {}) => {
      const pm = detectPm(makeRepo({ 'package.json': JSON.stringify({ scripts: { test } }) }), overrides);
      if ('error' in pm) throw new Error(pm.error);
      return pm;
    };
    expect(pmOf('node --test || true').scriptWarning).toMatch(/\|\|/);
    expect(pmOf('node --test | cat').scriptWarning).toMatch(/pipes/);
    expect(pmOf('node --test').scriptWarning).toBeUndefined();
    if (process.platform !== 'win32')
      expect(pmOf('', { test: 'node --test {files} && node --test {files}' }).test(['a.js'])).toBe(
        "node --test 'a.js' && node --test 'a.js'",
      );
  });

  it('runs pretest like the package manager would, but not for Yarn 2+', () => {
    const scripts = { pretest: 'node build.js', test: 'node --test' };
    const npm = detectPm(makeRepo({ 'package.json': JSON.stringify({ scripts }) }));
    const berry = detectPm(
      makeRepo({
        'package.json': JSON.stringify({ scripts, devDependencies: { x: '1' } }),
        'yarn.lock': '',
        '.yarnrc.yml': 'nodeLinker: node-modules\n',
      }),
    );
    if ('error' in npm || 'error' in berry) throw new Error('detectPm failed');
    if (process.platform === 'win32') return;
    expect(npm.test(['a.test.js'])).toBe("npm run pretest --silent && node --test 'a.test.js'");
    expect(berry.test(['a.test.js'])).toBe("node --test 'a.test.js'");
    expect(berry.pnp).toBe(false);
  });

  it('reads package.json with a byte order mark, and never blocks on a pipe or a device', () => {
    const bom = detectPm(makeRepo({ 'package.json': `\uFEFF${pkg()}` }));
    expect('error' in bom).toBe(false);
    if (process.platform === 'win32') return;
    const fifo = makeRepo({});
    execFileSync('mkfifo', [join(fifo, 'package.json')]);
    expect(detectPm(fifo)).toEqual({ error: expect.stringContaining('not a regular file') });
    const dev = makeRepo({});
    symlinkSync('/dev/zero', join(dev, 'package.json'));
    expect(detectPm(dev)).toEqual({ error: expect.stringContaining('not a regular file') });
    // A pipe in place of a lockfile or .npmrc is ignored too.
    const lock = makeRepo({ 'package.json': pkg() });
    execFileSync('mkfifo', [join(lock, 'package-lock.json')]);
    execFileSync('mkfifo', [join(lock, '.npmrc')]);
    const pm = detectPm(lock);
    if ('error' in pm) throw new Error(pm.error);
    expect(pm.install).toBe('npm install --no-package-lock');
    expect(registryDomains(lock)).toContain('registry.npmjs.org');
  });

  it('installs a workspace package from the workspace root, with the root lockfile', () => {
    if (process.platform === 'win32') return;
    // pnpm workspace: the package has a workspace:* dependency and no lockfile of its own
    const pnpm = makeRepo({
      'package.json': JSON.stringify({ name: 'mono', private: true }),
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n  - "!packages/skip"\n',
      'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
      'packages/api/package.json': JSON.stringify({
        name: 'api',
        scripts: { test: 'vitest run' },
        dependencies: { shared: 'workspace:*' },
      }),
      'packages/skip/package.json': JSON.stringify({ name: 'skip', scripts: { test: 'node --test' } }),
    });
    initGit(pnpm);
    const api = detectPm(join(pnpm, 'packages/api'));
    if ('error' in api) throw new Error(api.error);
    expect(api).toMatchObject({
      name: 'pnpm',
      lockfile: 'pnpm-lock.yaml',
      installRoot: '../..',
      install: "cd '../..' && pnpm install --frozen-lockfile",
    });
    // a folder the workspace leaves out is a project of its own
    expect(detectPm(join(pnpm, 'packages/skip'))).toMatchObject({ name: 'npm', installRoot: '.', install: null });
    // the workspace root itself, with no dependencies of its own, still installs (T5)
    expect(detectPm(pnpm)).toMatchObject({ name: 'pnpm', installRoot: '.', install: 'pnpm install --frozen-lockfile' });

    // npm workspaces: a package without dependencies of its own uses the root's (vitest hoisted)
    const npm = makeRepo({
      'package.json': JSON.stringify({
        name: 'mono',
        private: true,
        workspaces: ['packages/*'],
        devDependencies: { vitest: '3.2.4' },
      }),
      'package-lock.json': '{}',
      'packages/api/package.json': JSON.stringify({ name: 'api', scripts: { test: 'vitest run' } }),
    });
    initGit(npm);
    const member = detectPm(join(npm, 'packages/api'));
    if ('error' in member) throw new Error(member.error);
    expect(member).toMatchObject({ name: 'npm', installRoot: '../..', install: "cd '../..' && npm ci" });
    // the root lockfile is part of the dependency hash
    const before = member.depsHash;
    writeFiles(npm, { 'package-lock.json': '{"lockfileVersion":3}' });
    expect((detectPm(join(npm, 'packages/api')) as { depsHash: string }).depsHash).not.toBe(before);
  });

  it("starts runners through yarn under Plug'n'Play", () => {
    if (process.platform === 'win32') return;
    const dir = makeRepo({
      'package.json': pkg({ scripts: { test: 'jest' }, devDependencies: { jest: '29.7.0' } }),
      'yarn.lock': '',
      '.yarnrc.yml': 'yarnPath: .yarn/releases/yarn-4.9.2.cjs\n',
    });
    const pm = detectPm(dir);
    if ('error' in pm) throw new Error(pm.error);
    expect(pm).toMatchObject({ name: 'yarn', pnp: true, install: 'yarn install --immutable' });
    expect(pm.test(['a.test.js'])).toBe("yarn jest 'a\\.test\\.js'");
  });

  it('skips install without dependencies and supports a custom test command', () => {
    const pm = detectPm(makeRepo({ 'package.json': JSON.stringify({ scripts: {} }) }), {
      test: 'vitest run {files} --reporter dot',
    });
    if ('error' in pm) throw new Error(pm.error);
    expect(pm.install).toBeNull();
    expect(pm.hasTestScript).toBe(true);
    if (process.platform !== 'win32') expect(pm.test(['x.test.ts'])).toBe("vitest run 'x.test.ts' --reporter dot");
    expect(detectPm(makeRepo({ 'README.md': '' }))).toEqual({ error: expect.stringContaining('no package.json') });
  });

  it('adds private registries from .npmrc to the install allow list', () => {
    const dir = makeRepo({ '.npmrc': '@acme:registry=https://npm.acme.dev/\nregistry=https://registry.npmjs.org/\n' });
    expect(registryDomains(dir)).toContain('npm.acme.dev');
  });
});

describe('sandbox safety settings', () => {
  it('passes only safe environment variables', () => {
    process.env['SETUPSCORE_TEST_SECRET'] = 'x';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'y';
    const env = safeEnv();
    expect(env['PATH']).toBe(process.env['PATH']);
    expect(env['SETUPSCORE_TEST_SECRET']).toBeUndefined();
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(env['CI']).toBe('1');
    delete process.env['SETUPSCORE_TEST_SECRET'];
    delete process.env['AWS_SECRET_ACCESS_KEY'];
  });

  it("hides the user's real .env files but not templates", () => {
    const root = makeRepo({ '.env': 'A=1', '.env.local': 'B=2', '.env.example': 'A=' });
    const hidden = secretPaths(root).map((p) => p.replace(/\\/g, '/'));
    expect(hidden.some((p) => p.endsWith('/.env'))).toBe(true);
    expect(hidden.some((p) => p.endsWith('/.env.local'))).toBe(true);
    expect(hidden.some((p) => p.endsWith('/.env.example'))).toBe(false);
  });

  it('refuses --sandbox none outside CI unless --yes is given', async () => {
    const old = process.env['CI'];
    delete process.env['CI'];
    try {
      await expect(openSandbox({ mode: 'none', cwd: '.' })).rejects.toBeInstanceOf(EnvironmentError);
      const box = await openSandbox({ mode: 'none', cwd: '.', yes: true });
      expect(box.kind).toBe('none');
    } finally {
      if (old !== undefined) process.env['CI'] = old;
    }
  });
});

describe('prompt', () => {
  it('turns the commit and new test names into an instruction', () => {
    const p = buildPrompt(
      { hash: 'h', parent: 'p', title: 'Add coupon codes.', date: '', testFiles: [], sourceFiles: ['src/checkout.js'] },
      ['applyCoupon gives 10% off'],
    );
    expect(p).toBe(
      'Add coupon codes.\n\nChange the code in this repository to do this.\nRelevant files: src/checkout.js.\n\nAcceptance criteria:\n- applyCoupon gives 10% off\n\nAdd or update tests next to the files you change.',
    );
  });
});

// These need the real OS sandbox (macOS Seatbelt, or bubblewrap + socat on Linux).
const rt = await loadRuntime({ cwd: process.cwd(), install: false });
const probe = rt ? await probeOsSandbox(rt) : null;
const sandboxed = !!probe?.ok;

describe.runIf(sandboxed)('checking candidate commits in the sandbox', () => {
  const HEAD = "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\n";
  const testOf = (fn: string, value: number, from = '../src/lib.js') =>
    `${HEAD}const { ${fn} } = require('${from}');\ntest('${fn} returns ${value}', () => assert.equal(${fn}(), ${value}));\n`;
  const repo = (pkg: object, extra: Record<string, string> = {}) => {
    const root = makeRepo({
      'package.json': JSON.stringify({ name: 'demo', private: true, ...pkg }),
      '.gitignore': 'node_modules\ndist\n',
      'src/lib.js': 'exports.one = () => 1;\n',
      'test/one.test.js': testOf('one', 1),
      ...extra,
    });
    initGit(root);
    return root;
  };
  const commit = (root: string, files: Record<string, string>, message: string) => {
    writeFiles(root, files);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', message);
  };
  const build = async (dir: string, extra: Partial<BuildOptions> = {}) => {
    const sandbox = await OsSandbox.open(rt!);
    try {
      return await buildTasks({ dir, sandbox, limit: 10, timeoutMs: 120_000, installTimeoutMs: 120_000, ...extra });
    } finally {
      await sandbox.close();
    }
  };

  it('counts test helpers, fixtures and snapshots as part of the tests (T1)', async () => {
    const root = repo({ scripts: { test: 'node --test' } });
    // Tests for behaviour that already exists, with a helper and a fixture: they fail before the
    // commit only because the helper is missing, so they do not check a change.
    commit(
      root,
      {
        'src/lib.js': '// checked with a helper\nexports.one = () => 1;\n',
        'test/helpers.js':
          "const assert = require('node:assert/strict');\nexports.returns = (fn, v) => assert.equal(fn(), v);\n",
        'test/fixtures/one.json': '{ "value": 1 }\n',
        'test/one-helper.test.js': `${HEAD}const { returns } = require('./helpers.js');\nconst { one } = require('../src/lib.js');\nconst data = require('./fixtures/one.json');\ntest('one via helper', () => returns(one, data.value));\n`,
      },
      'Test one with a helper',
    );
    // A real feature whose test needs a fixture added in the same commit.
    commit(
      root,
      {
        'src/lib.js': '// checked with a helper\nexports.one = () => 1;\nexports.two = () => 2;\n',
        'test/fixtures/two.json': '{ "value": 2 }\n',
        'test/two.test.js': `${HEAD}const { two } = require('../src/lib.js');\nconst data = require('./fixtures/two.json');\ntest('two matches fixture', () => assert.equal(two(), data.value));\n`,
      },
      'Add two',
    );
    const r = await build(root);
    expect(r.tasks.map((t) => t.title)).toEqual(['Add two']);
    expect(r.tasks[0]!.sourceFiles).toEqual(['src/lib.js']);
    expect(r.rejected).toEqual([
      expect.objectContaining({ title: 'Test one with a helper', reason: expect.stringContaining('already pass') }),
    ]);
  });

  it('runs test files whose names hold glob characters, runs pretest, and reports runs with no tests (T6, T8)', async () => {
    const BUILD =
      "const fs = require('node:fs');\nfs.mkdirSync('dist', { recursive: true });\nfs.copyFileSync('src/lib.js', 'dist/lib.js');\n";
    const root = repo({ scripts: { pretest: 'node build.js', test: 'node --test' } }, { 'build.js': BUILD });
    commit(
      root,
      {
        'src/lib.js': 'exports.one = () => 1;\nexports.two = () => 2;\n',
        'app/[id]/two.test.js': testOf('two', 2, '../../dist/lib.js'),
      },
      'Add two',
    );
    const r = await build(root);
    expect(r.rejected).toEqual([]);
    expect(r.tasks.map((t) => t.testCommand)).toEqual([
      "npm run pretest --silent && node --test 'app/[[]id]/two.test.js'",
    ]);

    // A test command that finds none of the files: zero tests is neither "fails before" nor "passes after".
    const none = await build(root, { overrides: { test: "node --test 'nothing/*.test.js' # {files}" } });
    expect(none.tasks).toEqual([]);
    expect(none.rejected[0]!.reason).toMatch(/^no tests ran/);
  });

  it('judges before and after with the commit\'s test script, and follows "npm run test:unit" (real-repo r1, r4)', async () => {
    // r1: the commit only repairs the test script and adds a test for existing behaviour.
    const root = repo({ scripts: { test: 'node --test --test-reporter=./missing-reporter.mjs' } });
    commit(
      root,
      {
        'package.json': JSON.stringify({ name: 'demo', private: true, scripts: { test: 'node --test' } }),
        'src/lib.js': '// helpers\nexports.one = () => 1;\n',
        'test/one-again.test.js': testOf('one', 1),
      },
      'Fix the test script',
    );
    const r1 = await build(root);
    expect(r1.tasks).toEqual([]);
    expect(r1.rejected[0]!.reason).toContain('already pass');

    // r4: an indirect script with an unrelated failing test: only the commit's test file runs.
    const r4 = repo(
      { scripts: { test: 'npm run test:unit', 'test:unit': 'node --test' } },
      { 'test/other.test.js': `${HEAD}test('broken elsewhere', () => assert.fail('old failure'));\n` },
    );
    commit(
      r4,
      { 'src/lib.js': 'exports.one = () => 1;\nexports.two = () => 2;\n', 'test/two.test.js': testOf('two', 2) },
      'Add two',
    );
    const built = await build(r4);
    expect(built.tasks.map((t) => t.testCommand)).toEqual(["node --test 'test/two.test.js'"]);
    expect(built.notes).toEqual([]);
  });

  it('says why a test script that can never fail finds no tasks, and that the whole script runs', async () => {
    const root = repo({ scripts: { test: 'node --test || true' } });
    commit(
      root,
      { 'src/lib.js': 'exports.one = () => 1;\nexports.two = () => 2;\n', 'test/two.test.js': testOf('two', 2) },
      'Add two',
    );
    const notes: string[] = [];
    const r = await build(root, { onProgress: (p) => p.type === 'note' && notes.push(p.message) });
    expect(r.rejected[0]!.reason).toContain('reports success even when the tests fail');
    expect(r.notes).toEqual([expect.stringContaining('whole script runs')]);
    expect(notes).toEqual(r.notes);
  });
});
