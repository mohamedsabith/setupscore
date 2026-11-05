import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runShell } from '../src/sandbox/spawn.js';
import { policiesFor } from '../src/tasks/build.js';
import { tempFolderProblem, Workspace } from '../src/tasks/workspace.js';
import { git, initGit, makeRepo, writeFiles } from './helpers.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const fake = (mode: string, ...extra: string[]) => `node ${JSON.stringify(FAKE)} ${mode} ${extra.join(' ')}`.trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const linux = process.platform === 'linux';

/** A project with two tasks and their tasks.json already built. */
function project(): string {
  const root = makeRepo({
    'package.json': JSON.stringify({ name: 'shop', type: 'module', private: true, scripts: { test: 'node --test' } }),
    'src/cart.js': 'export const total = (items) => items.reduce((t, i) => t + i.price, 0);\n',
    'src/cart.test.js':
      "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { total } from './cart.js';\ntest('total', () => assert.strictEqual(total([{ price: 2 }]), 2));\n",
  });
  initGit(root);
  for (const [name, body] of [
    ['count', 'export const count = (items) => items.length;\n'],
    ['tax', 'export const withTax = (a) => Math.round(a * 118) / 100;\n'],
  ] as const) {
    writeFiles(root, {
      [`src/${name}.js`]: body,
      [`src/${name}.test.js`]: `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport * as m from './${name}.js';\ntest('${name} works', () => assert.ok(Object.keys(m).length));\n`,
    });
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', `Add ${name}`);
  }
  const r = spawnSync(process.execPath, [CLI, 'tasks', root, '--sandbox', 'none', '--yes'], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  expect(r.status, r.stderr).toBe(0);
  return root;
}

/** Processes whose command line mentions this marker. */
function processesWith(marker: string): string[] {
  if (!linux) return [];
  const out: string[] = [];
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    if (Number(pid) === process.pid) continue;
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      if (cmd.includes(marker)) out.push(`${pid} ${cmd.slice(0, 80)}`);
    } catch {
      // gone
    }
  }
  return out;
}

const growing = async (file: string) => {
  const size = () => (existsSync(file) ? statSync(file).size : 0);
  const before = size();
  await sleep(600);
  return size() > before;
};

/** Start `setupscore run` with a slow fake agent in its own temp folder; resolve once the agent works. */
async function startSlowRun(root: string, extra: string[] = []) {
  const tmp = mkdtempSync(join(tmpdir(), 'setupscore-life-'));
  const marker = `life-${Math.random().toString(36).slice(2)}`;
  const env = { ...process.env, NO_COLOR: '1', ANTHROPIC_API_KEY: 'sk-ant-test-not-real', TMPDIR: tmp } as Record<
    string,
    string
  >;
  delete env.CI;
  const child = spawn(
    process.execPath,
    [
      CLI,
      'run',
      root,
      '--claude-bin',
      fake('slow', '--ms=30000', `--marker=${marker}`),
      '--repeat',
      '1',
      '--concurrency',
      '1',
      '--sandbox',
      'none',
      '--yes',
      ...extra,
    ],
    { env },
  );
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const done = new Promise<number | null>((r) => child.on('close', (code, sig) => r(code ?? (sig ? -1 : null))));
  for (let i = 0; i < 300 && !/Claude is working/.test(out); i++) await sleep(100);
  await sleep(800); // the fake is running now
  return { child, done, tmp, marker, output: () => out };
}

const runJson = (root: string) => {
  const id = readFileSync(join(root, '.setupscore', 'latest'), 'utf8').trim();
  return JSON.parse(readFileSync(join(root, '.setupscore', 'runs', id, 'run.json'), 'utf8'));
};
const workspacesIn = (tmp: string) => readdirSync(tmp).filter((n) => n.startsWith('setupscore-ws-'));

describe.runIf(process.platform !== 'win32')('signals stop a run cleanly (R3, F2, K13, C04-C07, C22)', () => {
  for (const sig of ['SIGTERM', 'SIGHUP'] as const) {
    it(`${sig}: exit 4, run marked stopped, no agent left running, no workspace left`, async () => {
      const root = project();
      const r = await startSlowRun(root);
      // processesWith reads /proc, so it can only see the agent on Linux.
      if (linux) expect(processesWith(r.marker).length, r.output()).toBeGreaterThan(0);
      r.child.kill(sig);
      const code = await r.done;
      expect(code, r.output()).toBe(4);
      expect(r.output()).toContain(sig === 'SIGTERM' ? 'asked to stop (SIGTERM)' : 'terminal was closed (SIGHUP)');
      expect(runJson(root).status).toBe('stopped');
      await sleep(300);
      expect(processesWith(r.marker)).toEqual([]);
      expect(workspacesIn(r.tmp)).toEqual([]);
    }, 120_000);
  }

  it('a second Ctrl+C quits at once (exit 130), still leaving no agent, workspace or "running" run', async () => {
    const root = project();
    const r = await startSlowRun(root);
    r.child.kill('SIGINT');
    await sleep(50);
    r.child.kill('SIGINT');
    const code = await r.done;
    expect([130, 4], r.output()).toContain(code); // 4 when it had already finished stopping
    await sleep(300);
    expect(processesWith(r.marker)).toEqual([]);
    expect(workspacesIn(r.tmp)).toEqual([]);
    expect(runJson(root).status).not.toBe('running');
  }, 120_000);
});

describe.runIf(linux)('nothing the agent starts outlives its command (M5, F18, F19, S9)', () => {
  it('a background process in its own session is killed when the command ends', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'setupscore-bg-'));
    const hb = join(dir, 'hb');
    const r = await runShell(
      `setsid sh -c 'while true; do echo x >> ${hb}; sleep 0.1; done' > /dev/null 2>&1 & echo started`,
      dir,
      { PATH: process.env.PATH! },
      20_000,
    );
    expect(r.stdout).toContain('started');
    await sleep(300);
    expect(await growing(hb)).toBe(false);
  });

  it('an agent that leaves a setsid process behind (--sandbox none): it is gone after the run', async () => {
    const root = project();
    const hb = join(mkdtempSync(join(tmpdir(), 'setupscore-bg-')), 'hb');
    const r = spawnSync(
      process.execPath,
      [
        CLI,
        'run',
        root,
        '--claude-bin',
        fake('bg-escape', `--hb=${hb}`),
        '--repeat',
        '1',
        '--limit',
        '1',
        '--sandbox',
        'none',
        '--yes',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1', ANTHROPIC_API_KEY: 'sk-ant-test-not-real' },
      },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(hb)).toBe(true);
    expect(await growing(hb)).toBe(false);
  }, 120_000);

  it('keeps only the last 1 MB of output in memory, and all of it in a file when asked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'setupscore-out-'));
    const file = join(dir, 'out.txt');
    const r = await runShell(
      `${JSON.stringify(process.execPath)} -e "process.stdout.write('a'.repeat(3*1024*1024)+'END')"`,
      dir,
      { PATH: process.env.PATH! },
      60_000,
      undefined,
      { stdoutFile: file },
    );
    expect(r.stdout.length).toBeLessThanOrEqual(1024 * 1024);
    expect(r.stdout.endsWith('END')).toBe(true);
    expect(statSync(file).size).toBe(3 * 1024 * 1024 + 3);
  });
});

describe('workspaces', () => {
  it("keep git hooks, parked dependencies and setupscore's own files outside what sandboxed commands may write", async () => {
    const root = makeRepo({ 'a.txt': 'a' });
    initGit(root);
    const ws = await Workspace.create(root);
    try {
      const { writable } = policiesFor(ws, root, join(tmpdir(), 'pm'));
      const hooks = git(ws.root, 'config', 'core.hooksPath').trim();
      for (const p of [hooks, join(ws.outer, 'deps'), join(ws.outer, 'pristine'), ws.hostDir]) {
        expect(
          writable.some((w) => p === w || p.startsWith(`${w}/`)),
          p,
        ).toBe(false);
      }
      expect(writable).toContain(ws.base);
      expect(ws.root.startsWith(ws.base)).toBe(true);
    } finally {
      ws.close();
    }
    expect(existsSync(ws.outer)).toBe(false);
  });

  it('a later setupscore removes workspaces left by a killed one, and nothing else (K07, D11)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'setupscore-sweep-'));
    const dead = join(dir, 'setupscore-ws-dead01');
    const alive = join(dir, 'setupscore-ws-live01');
    const other = join(dir, 'setupscore-other');
    for (const d of [dead, alive, other]) mkdirSync(d);
    writeFileSync(join(dead, 'owner.pid'), '999999999\n');
    writeFileSync(join(alive, 'owner.pid'), `${process.pid}\n`);
    Workspace.sweepLeftovers(dir);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(alive)).toBe(true);
    expect(existsSync(other)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('git hooks set globally never run while the workspace is made (linux-env T16, T17)', async () => {
    const root = makeRepo({ 'a.txt': 'a' });
    initGit(root);
    const hookDir = mkdtempSync(join(tmpdir(), 'setupscore-ghooks-'));
    const mark = join(hookDir, 'ran');
    writeFileSync(join(hookDir, 'reference-transaction'), `#!/bin/sh\necho ran >> ${JSON.stringify(mark)}\n`, {
      mode: 0o755,
    });
    const home = mkdtempSync(join(tmpdir(), 'setupscore-home-'));
    // Forward slashes: git reads a backslash in its config as an escape.
    writeFileSync(join(home, '.gitconfig'), `[core]\n\thooksPath = ${hookDir.replaceAll('\\', '/')}\n`);
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const ws = await Workspace.create(root);
      await ws.checkout(ws.head!);
      ws.close();
    } finally {
      process.env.HOME = saved;
    }
    expect(existsSync(mark)).toBe(false);
  });
});

describe.runIf(linux)(
  'temp folders the sandbox cannot use are reported before the run (linux-env F1, F26, E36)',
  () => {
    it('TMPDIR under /dev (bubblewrap mounts its own /dev)', () => {
      const saved = process.env.TMPDIR;
      process.env.TMPDIR = '/dev/shm';
      try {
        expect(tempFolderProblem({ sandboxed: true })?.message).toMatch(/under \/dev/);
        expect(tempFolderProblem({ sandboxed: false })).toBeNull();
      } finally {
        if (saved === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = saved;
      }
    });

    it.runIf(process.getuid?.() === 0)(
      'a temp folder mounted noexec (tests would fail with "Permission denied")',
      () => {
        const mnt = mkdtempSync(join(tmpdir(), 'setupscore-noexec-'));
        const mounted = spawnSync('mount', ['-t', 'tmpfs', '-o', 'noexec,size=16m', 'tmpfs', mnt]).status === 0;
        if (!mounted) return; // not allowed here (container without CAP_SYS_ADMIN)
        const saved = process.env.TMPDIR;
        process.env.TMPDIR = mnt;
        try {
          expect(tempFolderProblem({ sandboxed: false })?.message).toMatch(/mounted noexec/);
        } finally {
          if (saved === undefined) delete process.env.TMPDIR;
          else process.env.TMPDIR = saved;
          spawnSync('umount', [mnt]);
          rmSync(mnt, { recursive: true, force: true });
        }
      },
    );

    it('a project under /dev/shm', () => {
      expect(
        tempFolderProblem({ sandboxed: true, dirs: [{ label: 'The project', path: '/dev/shm/x', fix: 'move it' }] }),
      ).toMatchObject({ message: expect.stringContaining('The project'), fixes: ['move it'] });
      expect(tempFolderProblem({ sandboxed: true })).toBeNull(); // the normal temp folder is fine
    });
  },
);
