import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * The programs the sandbox needs on Linux, and plain, specific advice when one is missing or
 * the sandbox cannot start. Programs are looked up on PATH directly: minimal images (Fedora,
 * Arch, Alpine containers) often have no `which`, and `which` can be slow on a busy machine.
 */

/** Linux tools the sandbox runtime needs, with the words the runtime itself uses when one is missing. */
export const LINUX_TOOLS: { bin: string; pkg: string; missing: string }[] = [
  { bin: 'bwrap', pkg: 'bubblewrap', missing: 'bubblewrap (bwrap) not installed' },
  { bin: 'socat', pkg: 'socat', missing: 'socat not installed' },
  { bin: 'rg', pkg: 'ripgrep', missing: 'ripgrep (rg) not found' },
];

/** The full path of a program on PATH, without starting anything. */
export function onPath(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env.PATH ?? env.Path ?? '';
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, bin + ext);
      try {
        if (!statSync(p).isFile()) continue;
        if (process.platform !== 'win32') accessSync(p, constants.X_OK);
        return p;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** The sandbox tools missing on this Linux machine. Empty elsewhere. */
export function missingTools(): typeof LINUX_TOOLS {
  if (process.platform !== 'linux') return [];
  return LINUX_TOOLS.filter((t) => !onPath(t.bin));
}

/** Missing tools in the runtime's words, for a check's detail line. */
export function missingSandboxTools(): string[] {
  return missingTools().map((t) => t.missing);
}

interface Distro {
  id: string;
  like: string[];
}

/** Which Linux distribution this is, from /etc/os-release. */
export function linuxDistro(file = '/etc/os-release'): Distro | null {
  try {
    const text = readFileSync(file, 'utf8');
    const value = (key: string) => text.match(new RegExp(`^${key}=["']?([^"'\\n]*)`, 'm'))?.[1]?.toLowerCase() ?? '';
    return { id: value('ID'), like: value('ID_LIKE').split(/\s+/).filter(Boolean) };
  } catch {
    return null;
  }
}

const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;

/** The command that installs these packages on this distribution (no sudo when already root). */
export function installCommand(packages: string[], distro = linuxDistro()): string {
  const sudo = isRoot() ? '' : 'sudo ';
  const names = packages.join(' ');
  const is = (...ids: string[]) => !!distro && ids.some((id) => distro.id === id || distro.like.includes(id));
  if (is('debian', 'ubuntu')) return `${sudo}apt-get install ${names}`;
  if (is('fedora', 'rhel', 'centos')) return `${sudo}dnf install ${names}`;
  if (is('arch')) return `${sudo}pacman -S ${names}`;
  if (is('alpine')) return `${sudo}apk add ${names}`;
  if (is('suse', 'opensuse')) return `${sudo}zypper install ${names}`;
  return `${sudo}apt-get install ${names}  (or dnf / pacman / apk)`;
}

const readText = (file: string) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

const inContainer = () =>
  existsSync('/.dockerenv') ||
  existsSync('/run/.containerenv') ||
  /docker|containerd|kubepods|lxc/.test(readText('/proc/1/cgroup'));
const onWsl = () => /microsoft/i.test(readText('/proc/version'));

/** bwrap could not create its namespaces (disabled by the kernel, AppArmor or a container). */
export const isNamespaceError = (detail: string): boolean =>
  /namespace|uid map|setting up uid|unprivileged|clone.*(not permitted|EPERM)|unshare.*(not permitted|EPERM)|Operation not permitted/i.test(
    detail,
  );

/** What to do on Linux, for this machine, given what went wrong (`detail`). */
export function linuxSandboxFix(detail = ''): string {
  const distro = linuxDistro();
  const sudo = isRoot() ? '' : 'sudo ';
  const lines: string[] = [];
  const missing = missingTools();
  if (missing.length) {
    lines.push(
      `Install ${missing.map((t) => t.pkg).join(', ')}:  ${installCommand(
        missing.map((t) => t.pkg),
        distro,
      )}`,
    );
  } else if (isNamespaceError(detail)) {
    lines.push('bubblewrap cannot create the user namespace the sandbox runs in.');
    if (readText('/proc/sys/user/max_user_namespaces').trim() === '0') {
      lines.push(`User namespaces are turned off: ${sudo}sysctl -w user.max_user_namespaces=15000`);
    } else if (distro && (distro.id === 'ubuntu' || distro.like.includes('ubuntu'))) {
      lines.push(
        `On Ubuntu 24.04+, AppArmor blocks them for unconfined programs: ${sudo}sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`,
      );
      lines.push(
        '  (or give bwrap its own AppArmor profile; see https://code.claude.com/docs/en/sandboxing, Ubuntu section)',
      );
    } else if (readText('/proc/sys/kernel/unprivileged_userns_clone').trim() === '0') {
      lines.push(`Unprivileged user namespaces are turned off: ${sudo}sysctl -w kernel.unprivileged_userns_clone=1`);
    } else {
      lines.push(
        `Check that unprivileged user namespaces are allowed (for example: ${sudo}sysctl -w user.max_user_namespaces=15000).`,
      );
    }
    if (inContainer())
      lines.push(
        'Inside a container they are often blocked: allow them (for Docker: --security-opt seccomp=unconfined --security-opt apparmor=unconfined), or use --sandbox none on a throwaway CI container.',
      );
  } else {
    lines.push(
      `The sandbox needs bubblewrap, socat and ripgrep:  ${installCommand(
        LINUX_TOOLS.map((t) => t.pkg),
        distro,
      )}`,
    );
    if (!distro || distro.id === 'ubuntu' || distro.like.includes('ubuntu'))
      lines.push(
        'On Ubuntu 24.04+, AppArmor may block it; see https://code.claude.com/docs/en/sandboxing (Ubuntu section).',
      );
  }
  if (onWsl()) lines.push('On WSL, use WSL2 (WSL1 cannot sandbox).');
  return lines.join('\n');
}
