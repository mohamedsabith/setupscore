import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { findClaude, stripAnsi } from '../src/agent/claude.js';
import { runDoctor } from '../src/commands/doctor.js';
import { NothingToDo } from '../src/core/errors.js';
import { closestCommand, handleError } from '../src/main.js';
import { gitRepoProblem } from '../src/commands/doctor.js';
import { git, initGit, makeRepo, writeFiles } from './helpers.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

/** Run the built CLI exactly as a user would. */
function run(args: string[], cwd?: string, env: Record<string, string | undefined> = {}) {
  const merged: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1', ...env };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: merged as NodeJS.ProcessEnv });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** A folder of executable shell scripts, to put first on PATH. */
function shims(scripts: Record<string, string>): string {
  const dir = makeRepo({});
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

/** A repository with one commit that adds a function and its test: one task. */
function taskRepo(testBody = "test('two is two', () => assert.strictEqual(two(), 2));"): string {
  const root = makeRepo({
    'package.json': JSON.stringify({ name: 'd', type: 'module', private: true, scripts: { test: 'node --test' } }),
    'src/a.js': 'export const one = () => 1;\n',
  });
  initGit(root);
  writeFiles(root, {
    'src/a.js': 'export const one = () => 1;\nexport const two = () => 2;\n',
    'src/a.test.js': `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { two } from './a.js';\n${testBody}\n`,
  });
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'Add two');
  return root;
}

const posixOnly = process.platform === 'win32' ? it.skip : it;

/** A killed process can stay a zombie until it is reaped; that counts as gone. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return true;
  }
}

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error('Build first: npm run build (npm test does this for you)');
});

describe('setupscore CLI', () => {
  it('exits 0 on a clean setup and 1 when there are errors', () => {
    const clean = makeRepo({ 'CLAUDE.md': '- Use 2-space indentation in TypeScript files\n' });
    const r1 = run([], clean);
    expect(r1.code).toBe(0);
    expect(r1.out).toContain('No problems in 1 setup file');

    const broken = makeRepo({ 'CLAUDE.md': '- See src/missing.ts\n', 'src/a.ts': '' });
    const r2 = run(['check', broken]);
    expect(r2.code).toBe(1);
    expect(r2.out).toContain('src/missing.ts');
  });

  it('exits 1 on warnings only with --strict', () => {
    const root = makeRepo({ 'CLAUDE.md': '- Write good code.\n' });
    expect(run([root]).code).toBe(0);
    expect(run([root, '--strict']).code).toBe(1);
  });

  it('prints stable JSON', () => {
    const root = makeRepo({ 'CLAUDE.md': '- See src/missing.ts\n', 'src/a.ts': '' });
    const r = run(['check', root, '--json']);
    const json = JSON.parse(r.out);
    expect(json).toMatchObject({
      schemaVersion: 1,
      tool: { name: 'setupscore' },
      summary: { files: 1, errors: 1, warnings: 0 },
      issues: [{ rule: 'broken-reference', severity: 'error', file: 'CLAUDE.md', line: 1, fixable: false }],
    });
  });

  it('fixes and reports what it changed', () => {
    const root = makeRepo({ 'CLAUDE.md': '- See src/old/thing.ts\n', 'src/new/thing.ts': '' });
    const r = run([root, '--fix']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Fixed 1 problem');
  });

  it('explains when there is nothing to check', () => {
    const r = run([makeRepo({ 'README.md': '# hi' })]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('No Claude Code setup files found');
  });

  it('exits 2 for a missing folder, a bad flag or a bad config', () => {
    expect(run(['/no/such/folder']).code).toBe(2);
    const bad = run(['--nope']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("Unknown option '--nope'");
    expect(bad.err).toContain('npx setupscore check --help'); // the next step
    const cfg = run([makeRepo({ 'setupscore.yml': 'version: 2\n', 'CLAUDE.md': 'x' })]);
    expect(cfg.code).toBe(2);
    expect(cfg.err).toContain('setupscore.yml');
  });

  it('shows help, version and the rule list', () => {
    expect(run(['--help']).out).toContain('Examples:');
    expect(run(['--version']).out.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const rules = run(['rules']);
    expect(rules.code).toBe(0);
    expect(rules.out).toContain('broken-reference');
    expect(JSON.parse(run(['rules', '--json']).out).length).toBeGreaterThan(10);
  });

  it('builds tasks from git history (no sandbox, so it runs on every CI machine)', () => {
    const root = makeRepo({
      'package.json': JSON.stringify({ name: 'd', type: 'module', private: true, scripts: { test: 'node --test' } }),
      'src/a.js': 'export const one = () => 1;\n',
    });
    initGit(root);
    writeFiles(root, {
      'src/a.js': 'export const one = () => 1;\nexport const two = () => 2;\n',
      'src/a.test.js':
        "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { two } from './a.js';\ntest('two is two', () => assert.strictEqual(two(), 2));\n",
    });
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'Add two');
    const r = run(['tasks', root, '--sandbox', 'none', '--yes', '--json']);
    expect(r.code, r.err).toBe(0);
    const json = JSON.parse(r.out);
    expect(json.tasks.map((t: { title: string }) => t.title)).toEqual(['Add two']);
    expect(existsSync(join(root, '.setupscore', 'tasks.json'))).toBe(true);
  });

  it('explains when tasks is run outside a git repository, or with a bad option', () => {
    const r = run(['tasks', makeRepo({ 'package.json': '{}' }), '--sandbox', 'none', '--yes']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('not inside a git repository');
    expect(run(['tasks', '--sandbox', 'docker']).err).toContain('Docker is not needed');
  });

  it('runs doctor and returns JSON checks', () => {
    const r = run(
      ['doctor', '--json', '--claude-bin', '/nonexistent/claude'],
      makeRepo({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) }),
    );
    expect([0, 3]).toContain(r.code);
    const checks = JSON.parse(r.out).checks as { name: string; detail: string }[];
    expect(checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(['Node.js', 'git', 'Sandbox (no Docker needed)', 'Package manager']),
    );
    // doctor accepts --claude-bin (its own hint names it) and says when that path does not exist
    expect(checks.find((c) => c.name === 'Claude Code')!.detail).toContain(
      '/nonexistent/claude: that path does not exist',
    );
  }, 120_000);

  it('prints each doctor check as it finishes, and "Folder not found" for a missing folder', () => {
    const r = run(['doctor'], makeRepo({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) }));
    expect(r.out).toMatch(/^setupscore doctor\n\n {2}✔ Node\.js/);
    expect(r.out).not.toContain('exit null');
    const missing = run(['doctor', 'no/such/dir'], makeRepo({}));
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('Folder not found: no/such/dir');
  }, 120_000);

  it('shows the context cost table', () => {
    const r = run([makeRepo({ 'CLAUDE.md': '- Use 2-space indentation in TypeScript files\n' }), '--cost']);
    expect(r.out).toContain('Context cost');
    expect(r.out).toContain('Sent with every message');
  });

  it('says a mistyped command is not a folder, and suggests the command (B19)', () => {
    const cwd = makeRepo({});
    const chek = run(['chek'], cwd);
    expect(chek.code).toBe(2);
    expect(chek.err).toContain("Unknown command 'chek'. Did you mean 'check'?");
    expect(run(['rule'], cwd).err).toContain("Did you mean 'rules'?");
    // An explicit "check" means the word is a folder.
    expect(run(['check', 'chek'], cwd).err).toContain('Folder not found: chek');
    const nope = run(['nope'], cwd);
    expect(nope.err).toContain('Folder not found: nope');
    expect(nope.err).toContain('npx setupscore --help');
    const help = run(['help', 'nope'], cwd);
    expect(help.code).toBe(2);
    expect(help.err).toContain("Unknown command 'nope'.");
    expect(run(['help', 'run']).out).toContain('Usage: setupscore run');
    expect(closestCommand('doctr')).toBe('doctor');
    expect(closestCommand('banana')).toBeUndefined();
  });

  it('says when a file is given where a folder is expected (B20)', () => {
    const root = makeRepo({ 'CLAUDE.md': '# hi\n' });
    const r = run(['check', join(root, 'CLAUDE.md')]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('CLAUDE.md is a file, not a folder.');
    expect(r.err).toContain(`npx setupscore check ${root}`);
  });

  it('says "Folder not found" for a missing folder on every command (X5)', () => {
    for (const args of [['tasks'], ['run'], ['report'], ['suggest'], ['watch', '--model', 'x'], ['doctor']]) {
      const r = run([args[0]!, '/no/such/folder', ...args.slice(1)], undefined, { CI: '1' });
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err, args.join(' ')).toContain('Folder not found: /no/such/folder');
      expect(r.err).not.toContain('This is a bug');
    }
  });

  it('writes usage errors as sentences with a next step, listing only flags that exist (X10, R14)', () => {
    const fixx = run(['check', '--fixx']);
    expect(fixx.err).toContain('Did you mean --fix?');
    const sandbox = run(['tasks', '--sandbox', 'docker']);
    expect(sandbox.code).toBe(2);
    expect(sandbox.err).toContain('is invalid. Use "auto", "os" or "none". Docker is not needed.');
    expect(run(['report', '--format', 'pdf']).err).toContain('is invalid. Use terminal, html, markdown or json.');
    expect(run(['watch']).err).toContain("Missing required option '--model <id>'.");
    expect(run(['rules', 'extra']).err).toMatch(/^✖ Too many arguments/);
    // --no-color is accepted everywhere, and doctor takes --claude-bin
    for (const cmd of ['rules', 'doctor', 'tasks', 'run', 'report', 'suggest', 'watch']) {
      expect(run([cmd, '--help']).out, cmd).toContain('--no-color');
    }
    expect(run(['rules', '--no-color']).code).toBe(0);
    expect(run(['doctor', '--help']).out).toContain('--claude-bin');
    // Every first letter of a message is a capital.
    for (const r of [fixx, sandbox]) expect(r.err).toMatch(/^✖ [A-Z]/);
  });

  it('caps --repeat, accepts decimal timeouts and refuses an empty run id (R13, R14, A41)', () => {
    const repeat = run(['run', '--repeat', '3000000']);
    expect(repeat.code).toBe(2);
    expect(repeat.err).toContain('--repeat can be at most 100');
    // --timeout 0.5 is accepted: the next problem is the folder.
    const timeout = run(['run', '/no/such/folder', '--timeout', '0.5']);
    expect(timeout.err).toContain('Folder not found');
    expect(run(['run', '--timeout', '0']).err).toContain('for example 15 or 0.5');
    const resume = run(['run', '--resume', '']);
    expect(resume.code).toBe(2);
    expect(resume.err).toContain('--resume needs a run id');
  });

  it('describes help honestly: only check is offline, watch repeats like the compared run (X9)', () => {
    const main = run(['--help']).out;
    expect(main).toContain('"check" (the default) is free and offline');
    expect(main).not.toMatch(/^Free and offline/m);
    const watch = run(['watch', '--help']).out.replace(/\s+/g, ' ');
    expect(watch).toContain('(default: the same as the run it is compared with)');
    expect(watch).not.toMatch(/--repeat <n> [^-]*\(default: 2\)/);
  });

  it('treats --sandbox none outside CI without --yes as a usage error (C9)', () => {
    const root = taskRepo();
    const r = run(['tasks', root, '--sandbox', 'none'], undefined, { CI: undefined });
    expect(r.code).toBe(2);
    expect(r.err).toContain('add --yes');
  });

  posixOnly('names git problems before anything starts: not installed, dubious ownership (X5, F10)', () => {
    const root = taskRepo();
    const noGit = run(['tasks', root, '--sandbox', 'none', '--yes'], undefined, { PATH: '/nonexistent' });
    expect(noGit.code).toBe(3);
    expect(noGit.err).toContain('Git is not installed');
    const bin = shims({ git: `echo "fatal: detected dubious ownership in repository at '${root}'" >&2; exit 128` });
    const dubious = run(['tasks', root, '--sandbox', 'none', '--yes'], undefined, {
      PATH: `${bin}:${process.env.PATH}`,
    });
    expect(dubious.code).toBe(3);
    expect(dubious.err).toContain('dubious ownership');
    expect(dubious.err).toContain(`git config --global --add safe.directory '${root}'`);
  });

  posixOnly('refuses native Windows before downloading the sandbox runtime (W5)', () => {
    const root = taskRepo();
    const preload = join(makeRepo({}), 'win32.mjs');
    writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'win32' });\n");
    const cache = makeRepo({});
    const r = spawnSync(process.execPath, ['--import', preload, CLI, 'tasks', root], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', SETUPSCORE_CACHE_DIR: cache },
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('WSL2');
    expect(readdirSync(cache)).toEqual([]); // nothing downloaded
  });

  it('writes tasks.json atomically: a symlink is replaced, not written through (F4)', () => {
    const root = taskRepo();
    const outside = join(makeRepo({ 'keep.json': 'KEEP' }), 'keep.json');
    mkdirSync(join(root, '.setupscore'));
    symlinkSync(outside, join(root, '.setupscore', 'tasks.json'));
    const r = run(['tasks', root, '--sandbox', 'none', '--yes', '--json']);
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(outside, 'utf8')).toBe('KEEP');
    expect(lstatSync(join(root, '.setupscore', 'tasks.json')).isFile()).toBe(true);
  });

  posixOnly('stops tasks at the first Ctrl+C with exit 4 and saves nothing (F1)', async () => {
    const mark = join(makeRepo({}), 'started');
    const root = taskRepo(
      `import fs from 'node:fs';\ntest('two is two', async () => { fs.writeFileSync(${JSON.stringify(mark)}, 'x'); await new Promise((r) => setTimeout(r, 60000)); assert.strictEqual(two(), 2); });`,
    );
    const child = spawn(process.execPath, [CLI, 'tasks', root, '--sandbox', 'none', '--yes'], {
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
    const until = Date.now() + 120_000;
    while (!existsSync(mark) && Date.now() < until && child.exitCode === null)
      await new Promise((r) => setTimeout(r, 100));
    child.kill('SIGINT');
    const started = Date.now();
    const code = await exited;
    expect(code, err).toBe(4);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(err).toContain('Nothing was saved');
    expect(existsSync(join(root, '.setupscore', 'tasks.json'))).toBe(false);
  });
});

describe('handleError', () => {
  const capture = (err: unknown) => {
    let text = '';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => {
      text += String(s);
      return true;
    });
    try {
      // CI turns colour on, which wraps the arrows in escape codes.
      return { code: handleError(err), text: stripAnsi(text) };
    } finally {
      spy.mockRestore();
    }
  };
  const sys = (code: string, syscall: string, path?: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(`${code}: failed, ${syscall} '${path}'`), { code, syscall, path, ...extra });

  it('maps operating-system errors to an environment problem naming the path (F9)', () => {
    const cases: [Error, RegExp][] = [
      [sys('ENOSPC', 'write', '/p/CLAUDE.md'), /disk is full.*CLAUDE\.md/],
      [sys('EACCES', 'open', '/p/x'), /No permission to use \/p\/x/],
      [sys('EPERM', 'open', '/p/x'), /No permission to use \/p\/x/],
      [sys('EROFS', 'open', '/ro/CLAUDE.md'), /\/ro\/CLAUDE\.md is on a read-only file system/],
      [sys('EMFILE', 'mkdtemp', '/tmp/setupscore-ws-'), /Too many open files[\s\S]*ulimit/],
      [sys('ENFILE', 'open', '/p/x'), /Too many open files/],
      [
        sys('ENOENT', 'mkdtemp', '/x/no-such-tmp/setupscore-probe-XXXXXX'),
        /temporary folder \/x\/no-such-tmp does not exist[\s\S]*TMPDIR/,
      ],
      [sys('ENOENT', 'open', '/p/CLAUDE.md'), /\/p\/CLAUDE\.md does not exist/],
      [
        sys('EEXIST', 'mkdir', '.setupscore'),
        /Cannot create the folder \.setupscore: a file with that name is in the way/,
      ],
      [sys('ENOTDIR', 'mkdir', '/c/cachefile/pm-cache'), /cachefile\/pm-cache: part of that path is a file/],
      [sys('EISDIR', 'read', '/p/attempts.jsonl'), /attempts\.jsonl is a folder/],
      [
        sys('EXDEV', 'rename', '/a/run.json.tmp', { dest: '/b/run.json' }),
        /Cannot move \/a\/run\.json\.tmp to \/b\/run\.json: they are on different disks/,
      ],
      [sys('EBUSY', 'rmdir', '/p/ws'), /\/p\/ws is in use by another program/],
      // The temp file of an atomic write stands for the file being written.
      [
        sys('EACCES', 'open', '/p/.setupscore/.tasks.json.9085.3d1d2d95.tmp'),
        /No permission to use \/p\/\.setupscore\/tasks\.json\./,
      ],
    ];
    for (const [err, re] of cases) {
      const r = capture(err);
      expect(r.code, err.message).toBe(3);
      expect(r.text, err.message).toMatch(re);
      expect(r.text).not.toContain('This is a bug');
    }
    expect(capture(sys('ENOENT', 'uv_cwd')).text).toContain('The current folder no longer exists');
  });

  it('maps git problems, NothingToDo and missing programs; anything else is still a bug', () => {
    const gitErr = Object.assign(new Error('Could not copy the repository: fatal: could not create work tree'), {
      name: 'GitError',
      fixes: ['Free some space.'],
      code: 128,
    });
    expect(capture(gitErr)).toMatchObject({ code: 3, text: expect.stringContaining('→ Free some space.') });
    const dubious = capture(new Error("fatal: detected dubious ownership in repository at '/srv/repo'"));
    expect(dubious.code).toBe(3);
    expect(dubious.text).toContain("safe.directory '/srv/repo'");
    expect(capture(new Error('spawn git ENOENT')).text).toContain('Git is not installed');
    expect(capture(new Error("fatal: could not create work tree dir '/x': No space left on device"))).toMatchObject({
      code: 3,
      text: expect.stringContaining('Git failed: fatal: could not create work tree'),
    });
    expect(capture(new Error('fatal: this operation must be run in a work tree'))).toMatchObject({
      code: 2,
      text: expect.stringContaining('bare repository'),
    });
    expect(
      capture(Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT', syscall: 'spawn npm', path: 'npm' })).text,
    ).toContain('npm is not installed');
    expect(capture(new Error("fatal: your current branch 'main' does not have any commits yet"))).toMatchObject({
      code: 2,
      text: expect.stringContaining('no commits yet'),
    });
    expect(capture(new NothingToDo('There are no usable tasks to run.', ['Try more history.']))).toMatchObject({
      code: 1,
      text: expect.stringContaining('→ Try more history.'),
    });
    const bug = capture(new TypeError('x is not a function'));
    expect(bug.code).toBe(2);
    expect(bug.text).toContain('This is a bug');
    expect(capture(Object.assign(new Error('weird'), { code: 'EWEIRD', syscall: 'open' })).text).toContain(
      'This is a bug',
    );
  });
});

describe('findClaude (F14, W2)', () => {
  const fake = (body: string, dirName = 'bin') => {
    const dir = join(makeRepo({}), dirName);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'claude');
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };

  posixOnly('finds a path with spaces and quotes it for the shell', async () => {
    const p = fake('echo "2.1.0 (Claude Code)"', 'Program Files');
    const info = await findClaude(p);
    expect(info).toEqual({ bin: `'${p}'`, version: '2.1.0 (Claude Code)' });
  });

  posixOnly('tells not found, hanging, silent and failing apart, and strips colour codes', async () => {
    await expect(findClaude('/nonexistent/claude')).rejects.toThrow('that path does not exist');
    await expect(findClaude(fake('exit 0'))).rejects.toThrow('printed no version');
    await expect(findClaude(fake('echo "Error: Claude Code needs Node.js 99" >&2; exit 1'))).rejects.toThrow(
      /exit code 1: Error: Claude Code needs Node\.js 99/,
    );
    const mark = join(makeRepo({}), 'child.pid');
    const started = Date.now();
    await expect(findClaude(fake(`sleep 30 & echo $! > ${mark}; wait`), { timeoutMs: 1_000 })).rejects.toThrow(
      'did not answer "--version" within 1 second',
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    // The whole process tree was stopped, not just the shell.
    const pid = Number(readFileSync(mark, 'utf8'));
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(pid)).toBe(false);
    expect((await findClaude(fake('printf "\\033[1m2.0.0\\033[0m (Claude Code)\\n"')))?.version).toBe(
      '2.0.0 (Claude Code)',
    );
    expect(stripAnsi('\u001b]0;title\u0007\u001b[31mred\u001b[0m\u0000')).toBe('red');
  });
});

describe('doctor (F17, F10, W6)', () => {
  posixOnly(
    'says a hung tool did not answer, a failing one failed, and git refusing a repository is not "not a repository"',
    async () => {
      const root = makeRepo({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) });
      const bin = shims({
        git: `if [ "$1" = "--version" ]; then exec sleep 30; fi; PATH='${process.env.PATH}' exec git "$@"`,
        npm: 'echo "npm ERR! cb() never called" >&2; exit 1',
      });
      const oldPath = process.env.PATH;
      process.env.PATH = `${bin}:${oldPath}`;
      try {
        const checks = await runDoctor(root, () => {}, { toolTimeoutMs: 1_000, claudeBin: '/nonexistent/claude' });
        const get = (n: string) => checks.find((c) => c.name === n)!;
        expect(get('git').detail).toBe('did not answer within 1 second');
        expect(get('Git repository')).toMatchObject({
          ok: false,
          required: false,
          detail: expect.stringContaining('not checked'),
        });
        expect(get('Package manager').detail).toContain('npm failed (exit code 1): npm ERR! cb() never called');
        expect(JSON.stringify(checks)).not.toMatch(/exit null|not found \(this project/);
      } finally {
        process.env.PATH = oldPath;
      }

      const dub = shims({
        git: `if [ "$1" = "--version" ]; then echo "git version 2.99.0"; exit 0; fi; echo "fatal: detected dubious ownership in repository at '/srv/x'" >&2; exit 128`,
      });
      process.env.PATH = `${dub}:${oldPath}`;
      try {
        const checks = await runDoctor(root, () => {}, { toolTimeoutMs: 5_000, claudeBin: '/nonexistent/claude' });
        const repo = checks.find((c) => c.name === 'Git repository')!;
        expect(repo.detail).toContain('dubious ownership');
        expect(repo.fix).toContain("git config --global --add safe.directory '/srv/x'");
      } finally {
        process.env.PATH = oldPath;
      }
    },
  );
});

describe('start-up and git reasons', () => {
  it('keeps the entry point parseable by old Node versions, so they get the version message (N1)', () => {
    const cli = readFileSync(CLI, 'utf8');
    expect(cli).not.toMatch(/\bawait\b/);
    expect(cli).not.toMatch(/\?\.|\?\?/);
  });

  it('turns colours off with FORCE_COLOR=0 (E16)', () => {
    const root = makeRepo({ 'CLAUDE.md': '- See src/missing.ts\n', 'src/a.ts': '' });
    const r = run(['check', root], undefined, { NO_COLOR: undefined, FORCE_COLOR: '0' });
    expect(r.out).toContain('src/missing.ts');
    expect(r.out + r.err).not.toContain('\u001b[');
  });

  it('names git refusing, bare and too-new repositories instead of "not a git repository" (T9, F13, F17)', () => {
    expect(
      gitRepoProblem("fatal: detected dubious ownership in repository at '/srv/x'\nTo add an exception...", '.'),
    ).toMatchObject({
      kind: 'dubious',
      fixes: [expect.stringContaining("safe.directory '/srv/x'"), expect.any(String)],
    });
    expect(gitRepoProblem('fatal: this operation must be run in a work tree', '.')).toMatchObject({
      kind: 'bare',
      detail: expect.stringContaining('bare repository'),
    });
    expect(gitRepoProblem('fatal: unknown repository extension found:\n\trefstorage', '.')).toMatchObject({
      kind: 'too-old',
      detail: expect.stringContaining('reftable'),
    });
    expect(gitRepoProblem('fatal: not a git repository (or any of the parent directories): .git', '.').kind).toBe(
      'not-a-repo',
    );
  });

  it('says so for a bare repository on tasks, and doctor explains a too-new one', async () => {
    const bare = join(makeRepo({}), 'r.git');
    git(makeRepo({}), 'init', '-q', '--bare', bare);
    const r = run(['tasks', bare, '--sandbox', 'none', '--yes']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('This is a bare repository');
    const root = makeRepo({ 'package.json': '{"name":"x","scripts":{"test":"node --test"}}' });
    initGit(root);
    git(root, 'config', 'core.repositoryformatversion', '1');
    git(root, 'config', 'extensions.someFutureExtension', 'true');
    const checks = await runDoctor(root, () => {}, { claudeBin: '/nonexistent/claude' });
    const repo = checks.find((c) => c.name === 'Git repository')!;
    expect(repo.detail).toContain('too old to read');
    expect(repo.detail).not.toContain('not inside a git repository');
  });

  posixOnly('does not block on a missing package manager when there is nothing to install (T29)', async () => {
    const root = makeRepo({
      'package.json': JSON.stringify({ name: 'x', packageManager: 'pnpm@10.0.0', scripts: { test: 'node --test' } }),
    });
    initGit(root);
    const oldPath = process.env.PATH;
    // A PATH with git and node, but no pnpm.
    const bin = shims({ git: `PATH='${oldPath}' exec git "$@"` });
    symlinkSync(process.execPath, join(bin, 'node'));
    process.env.PATH = bin;
    try {
      const checks = await runDoctor(root, () => {}, { claudeBin: '/nonexistent/claude' });
      const pm = checks.find((c) => c.name === 'Package manager')!;
      expect(pm).toMatchObject({ ok: false, required: false });
      expect(pm.detail).toContain('no dependencies to install');
    } finally {
      process.env.PATH = oldPath;
    }
  });
});
