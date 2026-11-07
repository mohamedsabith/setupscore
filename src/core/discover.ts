import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { stripCodeSpans, stripComments, toLines } from './markdown.js';
import { dirOf, joinRel, toPosix } from './paths.js';
import type { FileKind, ImportRef, MisnamedFile, SetupFile, SkippedFile } from './types.js';

export const MAX_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_DEPTH = 10; // stop runaway or circular chains; Claude Code itself stops much earlier

/** Work out what kind of setup file a path is, or null if it is not one. Folder names must match exactly. */
export function kindOf(rel: string): FileKind | null {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  if (base.startsWith('._')) return null; // macOS AppleDouble metadata, not a real file
  if (base === 'CLAUDE.md') return 'claude-md';
  if (base === 'CLAUDE.local.md') return 'claude-local-md';
  if (base === '.mcp.json') return 'mcp';
  if (/(?:^|\/)\.claude\/settings\.json$/.test(rel)) return 'settings';
  if (/(?:^|\/)\.claude\/settings\.local\.json$/.test(rel)) return 'settings-local';
  if (/(?:^|\/)\.claude\/rules\/.+\.[mM][dD]$/.test(rel)) return 'rule';
  if (/(?:^|\/)\.claude\/skills\/[^/]+\/SKILL\.md$/.test(rel)) return 'skill';
  if (/(?:^|\/)\.claude\/agents\/.+\.[mM][dD]$/.test(rel)) return 'agent';
  if (/(?:^|\/)\.claude\/commands\/.+\.[mM][dD]$/.test(rel)) return 'command';
  return null;
}

/**
 * For a file that is not a setup file, the setup path it would be if its letter case were right:
 * claude.md -> CLAUDE.md, .Claude/settings.json -> .claude/settings.json, skills/x/skill.md -> skills/x/SKILL.md.
 * Only names that are clearly meant for Claude Code: a lower-case claude.md only at the root or in .claude/.
 */
function misnamedAs(rel: string): string | null {
  if (kindOf(rel) !== null) return null;
  const parts = rel.split('/');
  if (parts.some((p) => p.startsWith('._'))) return null;
  const at = parts.findIndex((p) => p.toLowerCase() === '.claude');
  const fixed = [...parts];
  if (at >= 0) {
    fixed[at] = '.claude';
    const sub = parts[at + 1]?.toLowerCase();
    if (sub && ['rules', 'skills', 'agents', 'commands'].includes(sub) && at + 2 < parts.length) fixed[at + 1] = sub;
    if (at + 1 === parts.length - 1 && /^settings(?:\.local)?\.json$/i.test(parts[at + 1]!))
      fixed[at + 1] = parts[at + 1]!.toLowerCase();
    if (sub === 'skills' && at + 3 === parts.length - 1 && parts[at + 3]!.toLowerCase() === 'skill.md')
      fixed[at + 3] = 'SKILL.md';
    if (at + 1 === parts.length - 1 && /^claude(?:\.local)?\.md$/i.test(parts[at + 1]!)) {
      fixed[at + 1] = /local/i.test(parts[at + 1]!) ? 'CLAUDE.local.md' : 'CLAUDE.md';
    }
  } else if (parts.length === 1 && /^claude(?:\.local)?\.md$/i.test(parts[0]!)) {
    fixed[0] = /local/i.test(parts[0]!) ? 'CLAUDE.local.md' : 'CLAUDE.md';
  } else if (parts.length === 1 && parts[0]!.toLowerCase() === '.mcp.json') {
    fixed[0] = '.mcp.json';
  }
  const expected = fixed.join('/');
  return expected !== rel && kindOf(expected) !== null ? expected : null;
}

const MARKDOWN_KINDS = new Set<FileKind>(['claude-md', 'claude-local-md', 'rule', 'skill', 'agent', 'command']);

/** True for files written as instructions to Claude (markdown), as opposed to JSON config. */
export const isInstruction = (f: SetupFile): boolean =>
  MARKDOWN_KINDS.has(f.kind) || (f.kind === 'import' && /\.(?:md|mdx|markdown|txt)$/i.test(f.path));

export type ReadResult = { text: string } | { problem: SkippedFile['problem']; detail: string } | null;

/** True when a buffer is UTF-16 text (Windows PowerShell 5 writes it by default), not UTF-8. */
function looksUtf16(buf: Buffer): boolean {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return true;
  const sample = buf.subarray(0, 1000);
  if (sample.length < 4) return false;
  let zeros = 0;
  for (const b of sample) if (b === 0) zeros++;
  return zeros / sample.length > 0.25;
}

const errorText = (err: NodeJS.ErrnoException): string =>
  err.code === 'EACCES' || err.code === 'EPERM'
    ? 'no permission to read it'
    : `${err.code ?? 'error'}: ${err.message.replace(/^\w+: /, '').split(',')[0]}`;

/**
 * Read a setup file safely: only regular files (FIFOs, sockets and devices are skipped without
 * opening them), and never more than `maxBytes` + 1 bytes, even when the size on disk says 0
 * (/proc files). Returns null when there is nothing to read (missing, not a file).
 */
export function readSetupText(abs: string, maxBytes = MAX_BYTES): ReadResult {
  let st;
  try {
    st = statSync(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EIO')
      return { problem: 'unreadable', detail: errorText(err as NodeJS.ErrnoException) };
    return null; // gone, a broken link or a link loop
  }
  if (!st.isFile()) return null;
  if (st.size > maxBytes) return { problem: 'too-big', detail: String(st.size) };
  let fd: number | undefined;
  try {
    fd = openSync(abs, 'r');
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(64 * 1024);
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      chunks.push(chunk.subarray(0, n));
      total += n;
      if (total > maxBytes) return { problem: 'too-big', detail: String(total) };
    }
    const buf = Buffer.concat(chunks, total);
    if (looksUtf16(buf)) return { problem: 'not-utf8', detail: 'UTF-16' };
    return { text: buf.toString('utf8') };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') return null;
    return { problem: 'unreadable', detail: errorText(err as NodeJS.ErrnoException) };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function loadsAtStart(rel: string, kind: FileKind, fm: SetupFile['frontmatter']): boolean {
  switch (kind) {
    case 'claude-md':
      return rel === 'CLAUDE.md' || rel === '.claude/CLAUDE.md';
    case 'claude-local-md':
      return rel === 'CLAUDE.local.md';
    case 'rule': {
      if (!rel.startsWith('.claude/rules/')) return false;
      const paths = fm?.data?.['paths'];
      return paths === undefined || paths === null || paths === '';
    }
    default:
      return false;
  }
}

function makeSetupFile(root: string, rel: string, kind: FileKind, text: string): SetupFile {
  const markdownLike = kind !== 'settings' && kind !== 'settings-local' && kind !== 'mcp';
  const { lines, frontmatter } = toLines(text, markdownLike && kind !== 'claude-md' && kind !== 'claude-local-md');
  return {
    path: rel,
    abs: join(root, rel),
    kind,
    text,
    lines,
    frontmatter,
    loadsAtStart: loadsAtStart(rel, kind, frontmatter),
  };
}

const FILE_LIKE =
  /(?:\.[A-Za-z0-9]{1,10}|\/(?:Makefile|Dockerfile|LICENSE|README))$|^(?:Makefile|Dockerfile|LICENSE|README)$/;
const DOMAIN_LIKE = /^[\w-]+\.(?:com|org|net|io|dev|ai|co|app|me|sh|gg|so|xyz|cloud|in|uk|de|fr|jp|tech|info|biz)$/i;
const IMPORT = /(^|[\s([{"'])@((?:~[/\\]|\.{1,2}[/\\]|[/\\])?[\p{L}\p{N}_.][\p{L}\p{M}\p{N}_.@+\-/\\]*)/gu;
const TRAILING = new Set('.,;:!?)]}"\'');

/** Drop punctuation that ends a sentence, not the path: "see @docs/a.md." */
function trimTrailing(raw: string): string {
  let e = raw.length;
  while (e > 0 && TRAILING.has(raw[e - 1]!)) e--;
  return raw.slice(0, e);
}

/** Find `@path` imports in an instruction file. Imports inside code blocks and `code spans` are ignored, as in Claude Code. */
function findImports(f: SetupFile): { raw: string; line: number; column: number }[] {
  const out: { raw: string; line: number; column: number }[] = [];
  for (const l of f.lines) {
    if (l.inFence || l.inFrontmatter || !l.text.includes('@')) continue;
    const text = stripComments(stripCodeSpans(l.text));
    for (const m of text.matchAll(IMPORT)) {
      const raw = trimTrailing(m[2]!);
      const posix = raw.replaceAll('\\', '/');
      if (!raw || !FILE_LIKE.test(posix) || DOMAIN_LIKE.test(posix) || raw.includes('@')) continue;
      out.push({ raw, line: l.n, column: m.index + m[1]!.length + 1 });
    }
  }
  return out;
}

/** npm scopes people write about in instructions; `@types/node/index.d.ts` is a package path, not an import. */
const NPM_SCOPES = new Set([
  'types',
  'babel',
  'angular',
  'vue',
  'nestjs',
  'nuxt',
  'mui',
  'emotion',
  'testing-library',
  'tanstack',
  'aws-sdk',
  'google-cloud',
  'prisma',
  'sveltejs',
  'storybook',
  'octokit',
  'radix-ui',
  'reduxjs',
  'trpc',
  'vitejs',
  'rollup',
  'swc',
  'jest',
  'eslint',
  'typescript-eslint',
  'anthropic-ai',
  'modelcontextprotocol',
  'apollo',
  'graphql-tools',
  'remix-run',
  'sentry',
  'supabase',
  'vercel',
  'cloudflare',
  'playwright',
  'firebase',
  'fortawesome',
  'headlessui',
  'heroicons',
  'chakra-ui',
  'mantine',
  'nx',
  'expo',
  'react-native',
  'react-navigation',
  'shopify',
  'stripe',
  'aws-cdk',
  'azure',
]);

export interface Discovered {
  files: SetupFile[];
  imports: ImportRef[];
  skipped: SkippedFile[];
  misnamed: MisnamedFile[];
}

export interface DiscoverOptions {
  /** Exact-case lookup inside the root (see exactLookup in walk.ts). Defaults to existsSync. */
  lookup?: (rel: string) => 'file' | 'dir' | null;
}

/**
 * Load every setup file in the repo, then follow `@imports` from CLAUDE.md files.
 * `repoFiles` is the walked file list (relative, forward slashes).
 */
export function discover(root: string, repoFiles: string[], options: DiscoverOptions = {}): Discovered {
  const files: SetupFile[] = [];
  const skipped: SkippedFile[] = [];
  const misnamed: MisnamedFile[] = [];
  const byPath = new Map<string, SetupFile>();
  const lookup =
    options.lookup ??
    ((rel: string) => {
      const abs = join(root, rel);
      if (!existsSync(abs)) return null;
      return statSync(abs).isDirectory() ? 'dir' : 'file';
    });

  let realRoot: string | undefined;
  /** The real path (relative) of a file reached through a symbolic link inside the root, or undefined. */
  const realRel = (rel: string): string | undefined => {
    try {
      realRoot ??= realpathSync(root);
      const r = toPosix(relative(realRoot, realpathSync(join(root, rel))));
      return r && r !== rel && !r.startsWith('../') && !isAbsolute(r) ? r : undefined;
    } catch {
      return undefined;
    }
  };

  const misnamedSeen = new Set<string>();
  for (const rel of repoFiles) {
    const kind = kindOf(rel);
    if (!kind) {
      // A skill must be a folder with SKILL.md in it: .claude/skills/release.md is never loaded.
      const loose = rel.match(/^((?:.*\/)?\.claude\/skills)\/([^/]+)\.[mM][dD]$/);
      if (loose && !loose[2]!.startsWith('._') && !/^readme$/i.test(loose[2]!)) {
        misnamed.push({ path: rel, expected: `${loose[1]}/${loose[2]}/SKILL.md`, reason: 'layout' });
        continue;
      }
      const expected = misnamedAs(rel);
      if (expected) {
        // Report a wrongly named folder once, not once per file inside it.
        const a = rel.split('/');
        const b = expected.split('/');
        const k = a.findIndex((p, i) => p !== b[i]);
        const path = a.slice(0, k + 1).join('/');
        const want = b.slice(0, k + 1).join('/');
        if (!misnamedSeen.has(path)) {
          misnamedSeen.add(path);
          misnamed.push({ path, expected: want, reason: 'case' });
        }
      }
      continue;
    }
    const r = readSetupText(join(root, rel));
    if (r === null) continue;
    if ('problem' in r) {
      skipped.push({ path: rel, kind, problem: r.problem, detail: r.detail });
      continue;
    }
    const f = makeSetupFile(root, rel, kind, r.text);
    const real = realRel(rel);
    if (real) f.realPath = real;
    files.push(f);
    byPath.set(rel, f);
  }

  // Follow @imports breadth-first so each file keeps its shortest hop count.
  const imports: ImportRef[] = [];
  const queue = files
    .filter((f) => f.kind === 'claude-md' || f.kind === 'claude-local-md')
    .map((f) => ({ file: f, depth: 0 }));
  const seen = new Set(queue.map((q) => q.file.path));
  const scopeInstalled = new Map<string, boolean>();

  while (queue.length > 0) {
    const { file, depth } = queue.shift()!;
    if (depth >= MAX_IMPORT_DEPTH) continue;
    for (const imp of findImports(file)) {
      const raw = imp.raw.replaceAll('\\', '/');
      if (raw.startsWith('~/') || raw.startsWith('/') || isAbsolute(imp.raw)) continue; // machine-specific: cannot be checked here
      const resolveFrom = (fromRel: string) => {
        const absTarget = resolve(root, dirOf(fromRel), raw);
        const target = toPosix(relative(root, absTarget)) || '.';
        const outside = target.startsWith('../') || target === '..';
        const exists = outside ? existsSync(absTarget) && statSync(absTarget).isFile() : lookup(target) === 'file';
        return { absTarget, target, outside, exists };
      };
      let r0 = resolveFrom(file.path);
      // A file reached through a folder link: its relative imports may be written from where it really is.
      if (!r0.exists && file.realPath) {
        const r1 = resolveFrom(file.realPath);
        if (r1.exists) r0 = r1;
      }
      const { absTarget, target, outside, exists } = r0;

      if (!exists && !/^\.{1,2}\//.test(raw)) {
        // "@types/node/index.d.ts" names a file inside an npm package, not an import.
        const scope = raw.split('/')[0]!;
        if (raw.includes('/') && lookup(joinRel(dirOf(file.path), scope)) !== 'dir') {
          if (!scopeInstalled.has(scope))
            scopeInstalled.set(scope, NPM_SCOPES.has(scope) || existsSync(join(root, 'node_modules', `@${scope}`)));
          if (scopeInstalled.get(scope)) continue;
        }
      }

      imports.push({
        from: file.path,
        line: imp.line,
        column: imp.column,
        raw: imp.raw,
        target,
        exists,
        depth: depth + 1,
      });
      if (!exists || outside || seen.has(target)) continue;
      seen.add(target);
      const existing = byPath.get(target);
      if (existing) continue; // already a setup file (for example a rules file)
      const r = readSetupText(absTarget);
      if (r === null) continue;
      if ('problem' in r) {
        skipped.push({ path: target, kind: 'import', problem: r.problem, detail: r.detail });
        continue;
      }
      const imported = makeSetupFile(root, target, 'import', r.text);
      imported.importedBy = file.path;
      imported.importDepth = depth + 1;
      imported.loadsAtStart = file.loadsAtStart;
      files.push(imported);
      byPath.set(target, imported);
      queue.push({ file: imported, depth: depth + 1 });
    }
  }

  return { files, imports, skipped, misnamed };
}
