import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, relative } from 'node:path';

/**
 * Environment variables passed into sandboxed commands. Everything else (API keys, cloud
 * credentials, tokens in your shell) is left out on purpose.
 */
const PASS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TERM',
  'TZ',
  'TMPDIR',
  // Corporate networks: custom certificates are not secrets, and tools need them for TLS.
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'npm_config_cafile',
  'NPM_CONFIG_CAFILE',
  // Node and package-manager locations (nvm, volta, fnm, corepack).
  'NVM_DIR',
  'NVM_BIN',
  'VOLTA_HOME',
  'FNM_DIR',
  'COREPACK_HOME',
  'PNPM_HOME',
  'BUN_INSTALL',
  // Windows needs these to start programs at all.
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'COMSPEC',
  'ComSpec',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramData',
  'TEMP',
  'TMP',
  'HOMEDRIVE',
  'HOMEPATH',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  // Claude Code on Windows needs Git Bash; this says where it is when it is not in the default place.
  'CLAUDE_CODE_GIT_BASH_PATH',
]);
const PASS_PREFIX = /^LC_/;

export function safeEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && (PASS.has(k) || PASS_PREFIX.test(k))) env[k] = v;
  }
  return {
    ...env,
    // Test runners stop watching and run once. Nothing else is changed, so tests behave as in
    // the project's own CI (colour variables, for example, would change what some tests expect).
    CI: '1',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    ...extra,
  };
}

/** Secret locations in the home folder that sandboxed commands should never read. */
const HOME_SECRETS = [
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.kube',
  '.docker',
  '.netrc',
  '.git-credentials',
  '.pypirc',
  '.npmrc',
  '.yarnrc',
  '.config/gh',
  '.config/gcloud',
  '.config/hub',
  '.config/op',
  '.claude.json',
  '.claude/.credentials.json',
  '.password-store',
  // Cloud and deploy tools
  '.config/doctl',
  '.config/netlify',
  '.config/stripe',
  '.config/.wrangler',
  '.wrangler',
  '.fly',
  '.oci',
  '.terraform.d/credentials.tfrc.json',
  '.cargo/credentials',
  '.cargo/credentials.toml',
  '.gem/credentials',
  '.pgpass',
  '.my.cnf',
  '.local/share/com.vercel.cli',
  '.config/Claude', // Claude desktop app on Linux (MCP server tokens)
  // Browsers (saved logins and cookies)
  '.mozilla',
  '.config/google-chrome',
  '.config/chromium',
  // Shell start-up files and history often hold exported tokens
  '.bashrc',
  '.bash_profile',
  '.bash_history',
  '.profile',
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.zsh_history',
  '.config/fish/fish_variables',
  '.local/share/fish/fish_history',
  // macOS
  'Library/Keychains',
  'Library/Application Support/Claude',
  'Library/Application Support/com.vercel.cli',
  'Library/Preferences/netlify',
  'Library/Application Support/Firefox',
  'Library/Application Support/Google/Chrome',
  'Library/Cookies',
];

const ENV_FILE = /^\.env(?:\.[\w.-]+)?$/;
const ENV_TEMPLATE = /\.(?:example|sample|template|dist|defaults?)$/i;

/**
 * Absolute paths to hide: home-folder credentials plus local .env files in the user's own
 * checkout. Only existing paths are listed (a missing path cannot be hidden on Linux anyway).
 */
export function secretPaths(repoRoot: string, options: { allowNpmrc?: boolean } = {}): string[] {
  const home = homedir();
  const out = HOME_SECRETS.filter((p) => !(options.allowNpmrc && (p === '.npmrc' || p === '.yarnrc')))
    .map((p) => join(home, p))
    .filter((p) => existsSync(p));
  try {
    for (const name of readdirSync(repoRoot)) {
      if (ENV_FILE.test(name) && !ENV_TEMPLATE.test(name)) out.push(join(repoRoot, name));
    }
  } catch {
    // unreadable folder: nothing to add
  }
  return out;
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** True when `child` is `parent` or inside it. */
const within = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * The files of the user's real project, to hide from the agent. The agent works in a clone at
 * an older commit, and the real folder holds the answer. Kept readable:
 * - `.git`, because the clone reads its objects from there,
 * - `node_modules`, which may hold Claude Code or the sandbox runtime,
 * - symbolic links, which could point anywhere (hiding one could hide its target),
 * - any entry that contains a path the command needs (`keep`).
 */
export function projectFiles(repoRoot: string, keep: string[]): string[] {
  const keepReal = keep.filter(Boolean).map(real);
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(repoRoot);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === '.git' || name === 'node_modules') continue;
    const abs = join(repoRoot, name);
    try {
      if (lstatSync(abs).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    const absReal = real(abs);
    if (keepReal.some((k) => within(k, absReal))) continue;
    out.push(abs);
    if (out.length >= 2_000) break;
  }
  return out;
}

/**
 * The files a command line runs: absolute paths in it, and its first word found on PATH.
 * Used to keep them visible inside the sandbox.
 */
export function commandPaths(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const words = [...command.matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
  const out = words.filter((w) => isAbsolute(w) && existsSync(w)).map(real);
  const first = words[0];
  if (first && !first.includes('/') && !first.includes('\\')) {
    // Windows spells it Path, and finds "claude" as claude.cmd or claude.exe (PATHEXT).
    const win = platform === 'win32';
    const pathKey = win ? (Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH') : 'PATH';
    const sep = win ? ';' : delimiter;
    const exts =
      win && !/\.[^.\\/]+$/.test(first)
        ? ['', ...(env.PATHEXT ?? env.Pathext ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
        : [''];
    for (const dir of (env[pathKey] ?? '').split(sep)) {
      if (!dir) continue;
      // Every spelling found in the first folder that has one (claude and claude.cmd): keeping an
      // extra file visible is harmless, hiding the one the shell runs is not.
      const found = new Set<string>();
      for (const ext of exts) {
        for (const name of ext ? [first + ext.toLowerCase(), first + ext.toUpperCase()] : [first]) {
          const candidate = join(dir.replace(/^"(.*)"$/, '$1'), name);
          if (existsSync(candidate)) found.add(real(candidate));
        }
      }
      if (found.size) {
        out.push(...found);
        break;
      }
    }
  }
  return out;
}

/**
 * The user's repository metadata (HEAD, branches, tags, reflog, config) to hide from the agent:
 * it points straight at later commits. Only `objects` stays readable, because the workspace
 * clone shares it.
 */
export function gitMetadata(repoRoot: string): string[] {
  const gitDir = join(repoRoot, '.git');
  try {
    if (!lstatSync(gitDir).isDirectory()) return [];
    return readdirSync(gitDir)
      .filter((name) => name !== 'objects')
      .map((name) => join(gitDir, name))
      .filter((p) => !lstatSync(p).isSymbolicLink());
  } catch {
    return [];
  }
}
