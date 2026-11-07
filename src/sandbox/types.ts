export type SandboxMode = 'auto' | 'os' | 'none';

/** What one command may touch. Everything not listed is read-only, and the network is closed. */
export interface Policy {
  /** Absolute folders the command may write to. */
  writable: string[];
  /** Absolute files and folders the command may not read (SSH keys, cloud credentials, .env). */
  hidden: string[];
  /** Domains the command may reach. Empty means no network at all. */
  domains: string[];
  /** Absolute paths inside `writable` that must stay read-only (for example the clone's .git). */
  readOnly?: string[];
}

export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  policy: Policy;
  /** Extra environment variables. The base environment is already filtered (see env.ts). */
  env?: Record<string, string> | undefined;
  /** Stops the command (whole process tree) when aborted. */
  signal?: AbortSignal | undefined;
  /** Also write all of stdout / stderr to these files, from outside the sandbox. */
  stdoutFile?: string | undefined;
  stderrFile?: string | undefined;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
}

export interface Sandbox {
  /** 'os' = operating-system sandbox (Seatbelt, bubblewrap, Windows sandbox user). 'none' = no isolation. */
  kind: 'os' | 'none';
  /** Human description, e.g. "macOS Seatbelt". */
  label: string;
  exec(command: string, options: ExecOptions): Promise<ExecResult>;
  close(): Promise<void>;
}

export interface Check {
  name: string;
  ok: boolean;
  /** Shown after the name: a version, or what is wrong. */
  detail: string;
  /** How to fix it. */
  fix?: string | undefined;
  /** Required checks make doctor fail; optional ones only warn. */
  required: boolean;
}

/** An environment problem: exit code 3. */
export class EnvironmentError extends Error {
  constructor(
    message: string,
    readonly fixes: string[] = [],
  ) {
    super(message);
    this.name = 'EnvironmentError';
  }
}
