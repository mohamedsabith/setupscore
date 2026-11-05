import { UsageError } from '../core/errors.js';
import { safeEnv } from './env.js';
import { OsSandbox, probeOsSandbox, sandboxFix } from './os.js';
import { loadRuntime, runtimeInstallHint, type Runtime } from './runtime.js';
import { runShell } from './spawn.js';
import { missingSandboxTools } from './tools.js';
import { EnvironmentError, type Check, type ExecOptions, type Sandbox, type SandboxMode } from './types.js';

export * from './types.js';
export { secretPaths, safeEnv } from './env.js';
export { probeOsSandbox, sandboxFix } from './os.js';
export { cacheDir, loadRuntime, runProgram, RUNTIME_PACKAGE, RUNTIME_VERSION, type ProgramResult } from './runtime.js';
export { installCommand, linuxDistro, missingSandboxTools, onPath } from './tools.js';

/** No isolation. Only for throwaway machines such as CI runners. */
class NoSandbox implements Sandbox {
  readonly kind = 'none' as const;
  readonly label = 'no sandbox';
  exec(command: string, o: ExecOptions) {
    return runShell(command, o.cwd, safeEnv(o.env), o.timeoutMs, o.signal, o);
  }
  async close() {}
}

export const isCI = (): boolean => !!process.env.CI && process.env.CI !== 'false' && process.env.CI !== '0';

const NONE_MESSAGE = "--sandbox none runs the project's install scripts and tests directly on this machine.";
const NONE_FIXES = [
  'Use it only on a throwaway machine such as a CI runner (where CI=true is set).',
  'To run without a sandbox here anyway, add --yes.',
];

/** --sandbox none outside CI without --yes is a usage error: the command line must say so. */
export function assertSandboxModeAllowed(mode: SandboxMode, yes?: boolean): void {
  if (mode === 'none' && !isCI() && !yes) throw new UsageError(NONE_MESSAGE, NONE_FIXES);
}

export const SANDBOX_CHECK_NAME = 'Sandbox (no Docker needed)';

/** What to do when the sandbox is missing or broken on this machine. */
export const sandboxHint = (detail = ''): string => sandboxFix(detail);

/** Native Windows: refused before anything is downloaded. */
export function windowsRefusal(): EnvironmentError {
  return new EnvironmentError(
    'The sandbox does not work on native Windows yet, so "tasks" and "run" cannot run project code safely here.',
    sandboxFix().split('\n'),
  );
}

/** The OS sandbox check (kept as a name for callers; the probe itself makes its answer plain). */
export const checkSandbox = (rt: Runtime): Promise<Check> => probeOsSandbox(rt);

export interface OpenOptions {
  mode: SandboxMode;
  cwd: string;
  /** Allows --sandbox none outside CI. */
  yes?: boolean;
  log?: (message: string) => void;
  /** Stops a runtime install (Ctrl+C). */
  signal?: AbortSignal;
}

/**
 * Open the sandbox to run repo code in. `auto` and `os` use the OS sandbox and stop with
 * a clear EnvironmentError if it is not available. Docker is never needed.
 */
export async function openSandbox(o: OpenOptions): Promise<Sandbox> {
  if (o.mode === 'none') {
    if (!isCI() && !o.yes) throw new EnvironmentError(NONE_MESSAGE, NONE_FIXES);
    return new NoSandbox();
  }
  // Refuse before downloading anything the platform cannot use.
  if (process.platform === 'win32') throw windowsRefusal();
  // Missing tools are named before the runtime is downloaded: it could not work anyway.
  const missing = missingSandboxTools();
  if (missing.length) {
    const detail = missing.join('; ');
    throw new EnvironmentError(`The sandbox does not work on this machine: ${detail}.`, [
      ...sandboxFix(detail).split('\n'),
      'Run "npx setupscore doctor" to check everything at once.',
    ]);
  }
  const rt = await loadRuntime({ cwd: o.cwd, install: true, onInstall: o.log, signal: o.signal });
  if (!rt) throw new EnvironmentError('The sandbox runtime is not installed.', [runtimeInstallHint]);
  const probe = await probeOsSandbox(rt);
  if (!probe.ok) {
    throw new EnvironmentError(`The sandbox does not work on this machine: ${probe.detail}.`, [
      ...(probe.fix ?? sandboxFix(probe.detail)).split('\n'),
      'Run "npx setupscore doctor" to check everything at once.',
    ]);
  }
  return OsSandbox.open(rt);
}
