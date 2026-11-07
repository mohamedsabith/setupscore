import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cacheDir,
  installCommand,
  linuxDistro,
  loadRuntime,
  missingSandboxTools,
  openSandbox,
  probeOsSandbox,
  safeEnv,
  sandboxHint,
} from '../src/sandbox/index.js';
import { npmReason } from '../src/sandbox/runtime.js';
import { OsSandbox } from '../src/sandbox/os.js';
import { buildTasks, policiesFor } from '../src/tasks/build.js';
import { Workspace } from '../src/tasks/workspace.js';
import { git, initGit, makeRepo, writeFiles } from './helpers.js';

// These tests need the real OS sandbox (macOS Seatbelt, or bubblewrap + socat on Linux).
const rt = await loadRuntime({ cwd: process.cwd(), install: false });
const probe = rt ? await probeOsSandbox(rt) : null;
const available = !!probe?.ok;
if (!available) console.warn(`Skipping OS sandbox tests: ${probe?.detail ?? 'sandbox runtime not installed'}`);

const commit = (root: string, files: Record<string, string>, message: string) => {
  writeFiles(root, files);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', message);
};

const PKG = JSON.stringify({ name: 'demo', type: 'module', private: true, scripts: { test: 'node --test' } });
const TEST_HEAD = "import { test } from 'node:test';\nimport assert from 'node:assert';\n";

describe.runIf(available)('OS sandbox, no Docker', () => {
  const cleanup: string[] = [];
  afterAll(() => {
    cleanup.forEach((d) => {
      rmSync(d, { recursive: true, force: true });
    });
  });

  it('keeps tasks whose tests fail before and pass after, and skips the rest', async () => {
    const root = makeRepo({
      'package.json': PKG,
      'src/a.js': 'export const one = () => 1;\n',
      'src/a.test.js': `${TEST_HEAD}import { one } from './a.js';\ntest('one', () => assert.strictEqual(one(), 1));\n`,
    });
    initGit(root);
    commit(
      root,
      {
        'src/a.js': 'export const one = () => 1;\nexport const two = () => 2;\n',
        'src/b.test.js': `${TEST_HEAD}import { two } from './a.js';\ntest('two returns 2', () => assert.strictEqual(two(), 2));\n`,
      },
      'Add two',
    );
    commit(
      root,
      {
        'src/a.js': 'export const one = () => 1;\nexport const two = () => 2;\nexport const three = () => 3;\n',
        'src/c.test.js': `${TEST_HEAD}import { one } from './a.js';\ntest('one again', () => assert.ok(one()));\n`,
      },
      'Add three',
    );

    const sandbox = await OsSandbox.open(rt!);
    try {
      const r = await buildTasks({ dir: root, sandbox, limit: 10, timeoutMs: 60_000, installTimeoutMs: 120_000 });
      expect(r.tasks.map((t) => t.title)).toEqual(['Add two']);
      expect(r.tasks[0]!.newTests).toEqual(['two returns 2']);
      expect(r.tasks[0]!.prompt).toContain('- two returns 2');
      expect(r.rejected).toEqual([
        expect.objectContaining({ title: 'Add three', reason: expect.stringContaining('already pass') }),
      ]);
    } finally {
      await sandbox.close();
    }
  });

  it('blocks a malicious test: no writes outside, no secrets, no network, no git config changes', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'setupscore-outside-'));
    const fakeHome = mkdtempSync(join(tmpdir(), 'setupscore-home-'));
    cleanup.push(outside, fakeHome);
    mkdirSync(join(fakeHome, '.ssh'));
    writeFileSync(join(fakeHome, '.ssh', 'id_test'), 'FAKE-KEY');

    const root = makeRepo({ 'package.json': PKG, '.gitignore': '.env\n', 'src/a.js': 'export const x = 1;\n' });
    initGit(root);
    writeFileSync(join(root, '.env'), 'TOKEN=real-secret');
    const escaped = join(outside, 'escaped.txt');
    commit(
      root,
      {
        'src/evil.test.js': `${TEST_HEAD}import fs from 'node:fs';
import { execSync } from 'node:child_process';
const log = {};
const attempt = (name, fn) => { try { fn(); log[name] = 'SUCCEEDED'; } catch { log[name] = 'blocked'; } };
test('evil', async () => {
  attempt('writeOutside', () => fs.writeFileSync(${JSON.stringify(escaped)}, 'x'));
  attempt('readSshKey', () => fs.readFileSync(${JSON.stringify(join(fakeHome, '.ssh', 'id_test'))}, 'utf8'));
  attempt('readRealEnv', () => fs.readFileSync(${JSON.stringify(join(root, '.env'))}, 'utf8'));
  attempt('gitConfig', () => fs.appendFileSync(execSync('git rev-parse --git-dir').toString().trim() + '/config', '[core]\\n\\tfsmonitor = touch ${escaped}\\n'));
  attempt('apiKeyInEnv', () => { if (!process.env.ANTHROPIC_API_KEY) throw new Error('absent'); });
  try { await fetch('https://example.com', { signal: AbortSignal.timeout(10000) }); log.network = 'SUCCEEDED'; } catch { log.network = 'blocked'; }
  fs.writeFileSync('attempts.json', JSON.stringify(log));
});
`,
      },
      'Add evil test',
    );

    const oldHome = process.env.HOME;
    const oldKey = process.env.ANTHROPIC_API_KEY;
    process.env.HOME = fakeHome; // so the fake ~/.ssh counts as a secret location
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-never-reach-the-sandbox';
    const ws = await Workspace.create(root);
    const sandbox = await OsSandbox.open(rt!);
    try {
      await ws.checkout(git(root, 'rev-parse', 'HEAD').trim());
      const { testPolicy, env } = policiesFor(ws, root, join(fakeHome, 'cache'));
      const r = await sandbox.exec('node --test src/evil.test.js', {
        cwd: ws.dir,
        timeoutMs: 60_000,
        policy: testPolicy,
        env,
      });
      const log = JSON.parse(readFileSync(join(ws.dir, 'attempts.json'), 'utf8'));
      expect(log, r.stdout + r.stderr).toEqual({
        writeOutside: 'blocked',
        readSshKey: 'blocked',
        readRealEnv: 'blocked',
        gitConfig: 'blocked',
        apiKeyInEnv: 'blocked',
        network: 'blocked',
      });
      expect(existsSync(escaped)).toBe(false);
      expect(readFileSync(join(ws.gitDir, 'config'), 'utf8')).not.toContain('fsmonitor');
      expect(readFileSync(join(root, '.git', 'config'), 'utf8')).not.toContain('fsmonitor');
    } finally {
      process.env.HOME = oldHome;
      if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = oldKey;
      await sandbox.close();
      ws.close();
    }
  });

  it('lets the install step reach the npm registry and keeps tests offline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'setupscore-net-'));
    cleanup.push(dir);
    const sandbox = await OsSandbox.open(rt!);
    try {
      const cmd = 'npm view picocolors name --silent';
      const install = await sandbox.exec(cmd, {
        cwd: dir,
        timeoutMs: 90_000,
        policy: { writable: [dir], hidden: [], domains: ['registry.npmjs.org'] },
        env: { npm_config_cache: join(dir, 'npm') },
      });
      const tests = await sandbox.exec(cmd, {
        cwd: dir,
        timeoutMs: 90_000,
        policy: { writable: [dir], hidden: [], domains: [] },
        env: { npm_config_cache: join(dir, 'npm-2'), npm_config_fetch_retries: '0' },
      });
      expect(install.stdout.trim(), install.stderr).toBe('picocolors');
      expect(tests.code).not.toBe(0);
    } finally {
      await sandbox.close();
    }
  }, 200_000);
});

describe('sandbox start-up without the sandbox', () => {
  it('gives the install command for this distribution, without sudo for root (S19, S20, S21)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'setupscore-os-'));
    const release = (text: string) => {
      writeFileSync(join(dir, 'os-release'), text);
      return linuxDistro(join(dir, 'os-release'));
    };
    const sudo = typeof process.getuid === 'function' && process.getuid() === 0 ? '' : 'sudo ';
    expect(installCommand(['bubblewrap'], release('NAME="Fedora Linux"\nID=fedora\n'))).toBe(
      `${sudo}dnf install bubblewrap`,
    );
    expect(installCommand(['bubblewrap'], release('ID=arch\n'))).toBe(`${sudo}pacman -S bubblewrap`);
    expect(installCommand(['ripgrep'], release('ID=linuxmint\nID_LIKE="ubuntu debian"\n'))).toBe(
      `${sudo}apt-get install ripgrep`,
    );
    expect(installCommand(['socat'], release('ID="rocky"\nID_LIKE="rhel centos fedora"\n'))).toBe(
      `${sudo}dnf install socat`,
    );
    expect(installCommand(['socat'], null)).toContain('(or dnf / pacman / apk)');
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the useful lines of an npm error (R1, U12)', () => {
    const refused = [
      'npm error code ECONNREFUSED',
      'npm error syscall connect',
      'npm error errno ECONNREFUSED',
      'npm error FetchError: request to http://127.0.0.1:9/@anthropic-ai%2fsandbox-runtime failed, reason: connect ECONNREFUSED 127.0.0.1:9',
      'npm error',
      'npm error If you are behind a proxy, please make sure that the',
      "npm error 'proxy' config is set properly.  See: 'npm help config'",
      'npm error A complete log of this run can be found in: /root/.npm/_logs/x.log',
    ].join('\n');
    expect(npmReason(refused)).toBe(
      'FetchError: request to http://127.0.0.1:9/@anthropic-ai%2fsandbox-runtime failed, reason: connect ECONNREFUSED 127.0.0.1:9',
    );
    const cache = [
      'npm notice',
      'npm error code EACCES',
      'npm error syscall mkdir',
      'npm error path /home/u/.npm/_cacache',
      'npm error errno -13',
      "npm error Error: EACCES: permission denied, mkdir '/home/u/.npm/_cacache'",
      'npm error Log files were not written due to an error writing to the directory: /home/u/.npm/_logs',
    ].join('\n');
    expect(npmReason(cache)).toBe("Error: EACCES: permission denied, mkdir '/home/u/.npm/_cacache'");
  });

  it('resolves a relative SETUPSCORE_CACHE_DIR and ignores an empty or relative XDG_CACHE_HOME (R15-R18)', () => {
    const old = { s: process.env.SETUPSCORE_CACHE_DIR, x: process.env.XDG_CACHE_HOME };
    try {
      process.env.SETUPSCORE_CACHE_DIR = 'rc';
      expect(cacheDir()).toBe(join(process.cwd(), 'rc'));
      delete process.env.SETUPSCORE_CACHE_DIR;
      if (process.platform === 'linux') {
        for (const v of ['', 'relcache']) {
          process.env.XDG_CACHE_HOME = v;
          expect(cacheDir()).toMatch(/[\\/]\.cache[\\/]setupscore$/);
        }
      }
    } finally {
      if (old.s === undefined) delete process.env.SETUPSCORE_CACHE_DIR;
      else process.env.SETUPSCORE_CACHE_DIR = old.s;
      if (old.x === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = old.x;
    }
  });

  it('passes CLAUDE_CODE_GIT_BASH_PATH through to commands (W4)', () => {
    const old = process.env.CLAUDE_CODE_GIT_BASH_PATH;
    process.env.CLAUDE_CODE_GIT_BASH_PATH = 'D:\\Tools\\Git\\bin\\bash.exe';
    try {
      expect(safeEnv().CLAUDE_CODE_GIT_BASH_PATH).toBe('D:\\Tools\\Git\\bin\\bash.exe');
    } finally {
      if (old === undefined) delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
      else process.env.CLAUDE_CODE_GIT_BASH_PATH = old;
    }
  });

  it('refuses native Windows with a WSL2 message before loading or downloading the runtime (W5)', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const oldCache = process.env.SETUPSCORE_CACHE_DIR;
    const cache = mkdtempSync(join(tmpdir(), 'setupscore-cache-'));
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.SETUPSCORE_CACHE_DIR = cache;
    try {
      await expect(openSandbox({ mode: 'auto', cwd: '.' })).rejects.toThrow(/native Windows/);
      await expect(openSandbox({ mode: 'os', cwd: '.' })).rejects.toThrow(/native Windows/);
      expect(sandboxHint()).toContain('WSL2');
      expect(readdirSync(cache)).toEqual([]);
    } finally {
      Object.defineProperty(process, 'platform', platform);
      if (oldCache === undefined) delete process.env.SETUPSCORE_CACHE_DIR;
      else process.env.SETUPSCORE_CACHE_DIR = oldCache;
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'linux')('names ripgrep when it is missing, and the fix installs it (X8)', () => {
    const bin = mkdtempSync(join(tmpdir(), 'setupscore-bin-'));
    for (const name of ['bwrap', 'socat']) {
      writeFileSync(join(bin, name), '#!/bin/sh\n');
      chmodSync(join(bin, name), 0o755);
    }
    const old = process.env.PATH;
    process.env.PATH = bin;
    try {
      expect(missingSandboxTools()).toEqual(['ripgrep (rg) not found']);
    } finally {
      process.env.PATH = old;
      rmSync(bin, { recursive: true, force: true });
    }
    expect(sandboxHint()).toMatch(/apt-get install bubblewrap socat ripgrep/);
  });
});

/**
 * setupscore as users get it from npm: dist/ without the runtime next to it, so the runtime comes
 * from setupscore's cache. `npm` is a stand-in that "installs" by linking this repo's node_modules.
 */
function installedCopy(npmBody: (prefixVar: string) => string) {
  // A $, a double quote and a space in the path: the install must not go through a shell.
  const root = mkdtempSync(join(tmpdir(), 'setupscore-pkg-$HOME "q" '));
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const realModules = realpathSync(join(repo, 'node_modules'));
  cpSync(join(repo, 'dist'), join(root, 'pkg', 'dist'), { recursive: true });
  writeFileSync(join(root, 'pkg', 'package.json'), JSON.stringify({ name: 'setupscore', type: 'module' }));
  mkdirSync(join(root, 'pkg', 'node_modules'));
  for (const dep of ['commander', 'picocolors', 'picomatch', 'yaml', 'zod'])
    symlinkSync(join(realModules, dep), join(root, 'pkg', 'node_modules', dep));
  mkdirSync(join(root, 'bin'));
  // Only "npm install --prefix <dir>" does anything; "npm --version" (doctor) answers a version.
  writeFileSync(
    join(root, 'bin', 'npm'),
    `#!/bin/sh\n[ "$1" = "install" ] || { echo 10.0.0; exit 0; }\nprefix=\nwhile [ $# -gt 0 ]; do [ "$1" = "--prefix" ] && prefix="$2"; shift; done\n[ -n "$prefix" ] || exit 1\n${npmBody('"$prefix"').replace('REAL_MODULES', realModules)}\n`,
  );
  chmodSync(join(root, 'bin', 'npm'), 0o755);
  const cache = join(root, 'cache');
  const rtDir = join(cache, 'sandbox-runtime', '0.0.81');
  const env = {
    ...process.env,
    NO_COLOR: '1',
    SETUPSCORE_CACHE_DIR: cache,
    PATH: `${join(root, 'bin')}:${process.env.PATH}`,
  };
  return { root, cli: join(root, 'pkg', 'dist', 'cli.js'), cache, rtDir, env };
}

describe.runIf(available && process.platform !== 'win32')('sandbox runtime in the cache (F18)', () => {
  const project = () => makeRepo({ 'package.json': JSON.stringify({ name: 'p', scripts: { test: 'node --test' } }) });

  it('deletes a damaged or half-installed copy and installs it again, once', () => {
    for (const index of ['export const = ;\n', "import 'a-dependency-that-was-never-installed';\n"]) {
      const c = installedCopy((prefix) => `ln -s REAL_MODULES ${prefix}/node_modules`);
      const pkgDir = join(c.rtDir, 'node_modules', '@anthropic-ai', 'sandbox-runtime');
      mkdirSync(join(pkgDir, 'dist'), { recursive: true });
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({
          name: '@anthropic-ai/sandbox-runtime',
          version: '0.0.81',
          type: 'module',
          main: 'dist/index.js',
        }),
      );
      writeFileSync(join(pkgDir, 'dist', 'index.js'), index);
      const r = spawnSync(process.execPath, [c.cli, 'doctor', '--json'], {
        cwd: project(),
        encoding: 'utf8',
        env: c.env,
      });
      const sandbox = JSON.parse(r.stdout).checks.find(
        (x: { name: string }) => x.name === 'Sandbox (no Docker needed)',
      );
      expect(sandbox, r.stderr).toMatchObject({ ok: true });
      expect(r.stderr).toContain('is damaged or half-installed');
      expect(r.stderr).toContain('Downloading and installing the sandbox runtime');
      expect(existsSync(join(c.rtDir, '.setupscore-verified'))).toBe(true);
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it('two first-time installs at once both work (R29)', async () => {
    const c = installedCopy((prefix) => `sleep 1; ln -s REAL_MODULES ${prefix}/node_modules`);
    const once = () =>
      new Promise<string>((resolve) => {
        const child = spawn(process.execPath, [c.cli, 'doctor', '--json'], {
          cwd: project(),
          env: c.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (d) => (out += String(d)));
        child.on('close', () => {
          resolve(out);
        });
      });
    const outs = await Promise.all([once(), once()]);
    for (const out of outs)
      expect(JSON.parse(out).checks.find((x: { name: string }) => x.name === 'Sandbox (no Docker needed)').ok).toBe(
        true,
      );
    expect(readdirSync(join(c.cache, 'sandbox-runtime'))).toEqual(['0.0.81']);
    rmSync(c.root, { recursive: true, force: true });
  });

  it('reports a missing or read-only TMPDIR as a failed check, not a crash (E32, E34)', async () => {
    const rt = await loadRuntime({ cwd: process.cwd(), install: false });
    const old = process.env.TMPDIR;
    process.env.TMPDIR = join(tmpdir(), 'setupscore-no-such-tmp', 'x');
    try {
      const probe = await probeOsSandbox(rt!);
      expect(probe).toMatchObject({ ok: false, detail: expect.stringContaining('cannot create a temporary folder') });
      expect(probe.fix).toContain('TMPDIR');
    } finally {
      if (old === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = old;
    }
  });

  it('leaves no half-installed copy when Ctrl+C stops the install', async () => {
    const c = installedCopy(
      (prefix) =>
        `mkdir -p ${prefix}/node_modules/@anthropic-ai/sandbox-runtime; touch ${prefix}/started; exec sleep 60`,
    );
    const child = spawn(process.execPath, [c.cli, 'doctor'], {
      cwd: project(),
      env: c.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = new Promise<number | null>((resolve) =>
      child.on('close', (code) => {
        resolve(code);
      }),
    );
    const parent = join(c.cache, 'sandbox-runtime');
    const started = () => existsSync(parent) && readdirSync(parent).some((d) => existsSync(join(parent, d, 'started')));
    const until = Date.now() + 60_000;
    while (!started() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    child.kill('SIGINT');
    expect(await exited).toBe(130);
    expect(readdirSync(parent)).toEqual([]);
    rmSync(c.root, { recursive: true, force: true });
  });
});
