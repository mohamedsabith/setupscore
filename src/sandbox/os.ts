import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeEnv } from './env.js';

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
import type { Runtime } from './runtime.js';
import { runShell } from './spawn.js';
import type { Check, ExecOptions, ExecResult, Policy, Sandbox } from './types.js';
import { linuxSandboxFix, LINUX_TOOLS, missingTools, onPath } from './tools.js';

const PLATFORM_LABEL: Record<string, string> = {
  darwin: 'macOS Seatbelt',
  linux: 'Linux bubblewrap',
};

// macOS has no network namespace: without this, tests that start a server on localhost fail
// with "listen EPERM". It lets sandboxed commands bind and reach localhost (see docs/sandbox.md).
const toConfig = (p: Policy) => ({
  network: {
    allowedDomains: [] as string[],
    deniedDomains: [] as string[],
    allowLocalBinding: process.platform === 'darwin',
  },
  filesystem: { denyRead: p.hidden, allowWrite: p.writable, denyWrite: p.readOnly ?? [] },
  ...linuxToolPaths(),
});

let toolPaths: { bwrapPath?: string; socatPath?: string; ripgrep?: { command: string } } | null = null;

/**
 * On Linux, the full paths of bwrap, socat and rg, found on PATH by setupscore: the runtime then
 * does not need a working `which` (minimal images have none, and it can be slow on a busy machine).
 */
function linuxToolPaths(): { bwrapPath?: string; socatPath?: string; ripgrep?: { command: string } } {
  if (process.platform !== 'linux') return {};
  if (!toolPaths) {
    const bwrap = onPath('bwrap');
    const socat = onPath('socat');
    const rg = onPath('rg');
    toolPaths = {
      ...(bwrap ? { bwrapPath: bwrap } : {}),
      ...(socat ? { socatPath: socat } : {}),
      ...(rg ? { ripgrep: { command: rg } } : {}),
    };
  }
  return toolPaths;
}

/**
 * Runs commands inside the operating system's own sandbox, through Anthropic's sandbox runtime.
 * Files outside `policy.writable` are read-only, `policy.hidden` cannot be read, and network
 * traffic only reaches `policy.domains` (none by default). No Docker, no virtual machine.
 */
export class OsSandbox implements Sandbox {
  readonly kind = 'os' as const;
  readonly label = PLATFORM_LABEL[process.platform] ?? 'OS sandbox';
  private constructor(private readonly rt: Runtime) {}

  static async open(rt: Runtime): Promise<OsSandbox> {
    // The runtime takes its temp folder from these; setupscore's policies expect the default.
    delete process.env.CLAUDE_CODE_TMPDIR;
    delete process.env.CLAUDE_TMPDIR;
    // Start closed: no network, no writes. Each command gets its own policy.
    await rt.SandboxManager.initialize(toConfig({ writable: [], hidden: [], domains: [] }));
    return new OsSandbox(rt);
  }

  async exec(command: string, o: ExecOptions): Promise<ExecResult> {
    const sm = this.rt.SandboxManager;
    // An unguessable id ties network traffic to this one command's allow list.
    const commandId = randomBytes(18).toString('base64url');
    // The runtime points TMPDIR at a folder shared by every command. Use the workspace's own.
    const tmp = o.env?.TMPDIR;
    const inner = tmp
      ? `export TMPDIR=${shellQuote(tmp)} TMP=${shellQuote(tmp)} TEMP=${shellQuote(tmp)}; ${command}`
      : command;
    let wrapped: string;
    try {
      wrapped = await sm.wrapWithSandbox(inner, undefined, toConfig(o.policy), undefined, { commandId });
      if (o.policy.domains.length) sm.registerCommandNetworkLists(commandId, { allowedDomains: o.policy.domains });
    } catch (err) {
      try {
        sm.unregisterCommandNetworkLists(commandId);
      } catch {
        // nothing was registered
      }
      // For example a network allow-list entry the runtime refuses ("litellm"): a clear message
      // for this one command, never a crash of the whole run.
      throw new SandboxCommandError(
        `the sandbox could not prepare the command: ${firstLine((err as Error)?.message ?? String(err))}`,
      );
    }
    try {
      return await runShell(wrapped, o.cwd, safeEnv(o.env), o.timeoutMs, o.signal, o);
    } finally {
      try {
        sm.unregisterCommandNetworkLists(commandId);
        sm.cleanupAfterCommand();
      } catch {
        // best effort: the command has finished
      }
    }
  }

  private closed = false;

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.rt.SandboxManager.reset();
  }
}

/** The sandbox could not set up one command (not the command failing). */
export class SandboxCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxCommandError';
  }
}

/**
 * Check that the OS sandbox really works here: platform, dependencies, then a live test that a
 * write outside the allowed folder is blocked and a hidden file cannot be read. Every failure is
 * a failed check with a plain reason and a fix for this machine; it never throws.
 */
export async function probeOsSandbox(rt: Runtime): Promise<Check> {
  const name = 'Sandbox (no Docker needed)';
  const fail = (detail: string, fix = sandboxFix(detail)): Check => ({ name, ok: false, required: true, detail, fix });
  const sm = rt.SandboxManager;
  if (process.platform === 'win32') {
    // The runtime's native Windows support is alpha and untested with setupscore. WSL2 works today.
    return fail('native Windows is not supported yet');
  }
  if (!sm.isSupportedPlatform()) return fail(`not supported on ${process.platform}`);
  // Look the tools up on PATH ourselves first: the runtime uses `which`, which minimal images lack.
  const missing = missingTools();
  if (missing.length) return fail(missing.map((t) => t.missing).join('; '));
  let deps: { errors: string[]; warnings: string[] };
  try {
    deps = await sm.checkDependenciesAsync();
  } catch (err) {
    return fail(`the sandbox runtime could not check its dependencies (${firstLine((err as Error).message)})`);
  }
  if (deps.errors.length) {
    // Installed (found on PATH above), yet the runtime did not find them: its `which` failed or was slow.
    const claimed =
      process.platform === 'linux' ? LINUX_TOOLS.filter((t) => deps.errors.some((e) => e.includes(t.missing))) : [];
    if (claimed.length) {
      return fail(
        `the sandbox runtime could not find ${claimed.map((t) => `${t.bin} (${onPath(t.bin)})`).join(', ')}, although ${claimed.length === 1 ? 'it is' : 'they are'} installed`,
        'The runtime looks programs up with the "which" command, which is missing, failed or took longer than 1 second.\nInstall "which" (for example the "which" or "debianutils" package), or try again when the machine is less busy.',
      );
    }
    return fail(deps.errors.join('; '));
  }

  let base: string;
  try {
    base = mkdtempSync(join(tmpdir(), 'setupscore-probe-'));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const why =
      e.code === 'ENOENT'
        ? 'it does not exist'
        : e.code === 'EROFS'
          ? 'it is read-only'
          : e.code === 'EACCES' || e.code === 'EPERM'
            ? 'permission denied'
            : (e.code ?? firstLine(e.message));
    return fail(
      `cannot create a temporary folder in ${tmpdir()} (${why})`,
      'Point TMPDIR at a folder that exists and that you can write to, for example: export TMPDIR=$HOME/tmp (create it first).',
    );
  }
  const inside = join(base, 'inside');
  const secret = join(base, 'secret.txt');
  let box: OsSandbox | undefined;
  try {
    writeFileSync(secret, 'secret');
    mkdirSync(inside);
    box = await OsSandbox.open(rt);
    const policy = { writable: [inside], hidden: [secret], domains: [] };
    const q = (p: string) => JSON.stringify(p);
    const ok = await box.exec(`echo ok > ${q(join(inside, 'w.txt'))} && echo ran`, {
      cwd: inside,
      timeoutMs: 30_000,
      policy,
    });
    if (!ok.stdout.includes('ran')) {
      const why =
        ok.timedOut || ok.code === null
          ? 'no answer within 30 seconds'
          : firstLine(ok.stderr) || `exit code ${ok.code}`;
      return fail(`the sandbox could not start a command (${why})`);
    }
    const escape = await box.exec(`echo x > ${q(join(base, 'escape.txt'))}`, {
      cwd: inside,
      timeoutMs: 30_000,
      policy,
    });
    const peek = await box.exec(`cat ${q(secret)}`, { cwd: inside, timeoutMs: 30_000, policy });
    if (escape.code === 0 || peek.stdout.includes('secret'))
      return fail('the sandbox started but did not block writes or hidden files');
    const warn = deps.warnings.length ? ` (${deps.warnings.join('; ')})` : '';
    return {
      name,
      ok: true,
      required: true,
      detail: `${PLATFORM_LABEL[process.platform] ?? 'OS sandbox'} works${warn}`,
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code && e.path && /^(EROFS|EACCES|EPERM|ENOSPC|ENOENT)$/.test(e.code)) {
      const why = {
        EROFS: 'read-only file system',
        EACCES: 'permission denied',
        EPERM: 'operation not permitted',
        ENOSPC: 'the disk is full',
        ENOENT: 'it does not exist',
      }[e.code];
      return fail(
        `the sandbox could not write ${e.path} (${why})`,
        'Make sure TMPDIR and your home folder are writable (the sandbox keeps its temporary files there), then try again.',
      );
    }
    return fail(firstLine(e.message ?? String(err)));
  } finally {
    await box?.close().catch(() => {});
    rmSync(base, { recursive: true, force: true });
  }
}

const firstLine = (s: string) => s.trim().split('\n')[0]?.slice(0, 200) ?? '';

/** What to do when the sandbox is missing or broken on this machine, given what went wrong. */
export function sandboxFix(detail = ''): string {
  switch (process.platform) {
    case 'darwin':
      return 'macOS includes the sandbox (sandbox-exec). To see the error, run: sandbox-exec -p "(version 1)(allow default)" true. Security software can block it.';
    case 'linux':
      return linuxSandboxFix(detail);
    case 'win32':
      return [
        'Run setupscore inside WSL2 (Ubuntu), with the sandbox tools installed there:  sudo apt-get install bubblewrap socat ripgrep',
        'Native Windows support is planned. "setupscore check" works on Windows today.',
        'On a throwaway CI runner only: --sandbox none (no isolation).',
      ].join('\n');
    default:
      return 'Use macOS, Linux or WSL2.';
  }
}
