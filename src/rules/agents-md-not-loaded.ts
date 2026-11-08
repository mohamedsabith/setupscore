import { readFileSync, realpathSync } from 'node:fs';
import { join, posix } from 'node:path';
import { MAX_BYTES } from '../core/discover.js';
import { dirOf } from '../core/paths.js';
import type { Context, Issue, Rule, SetupFile } from '../core/types.js';

// How Claude Code reads AGENTS.md (code.claude.com/docs/en/memory#agents-md, Claude Code 2.1.277+).
// By default it reads AGENTS.md (and .claude/AGENTS.md) only when there is no CLAUDE.md,
// .claude/CLAUDE.md or CLAUDE.local.md in the working directory or above it. A subfolder's
// AGENTS.md is read when Claude opens a file there and that folder has none of those three files.
// An AGENTS.md that a CLAUDE.md imports (@AGENTS.md) or links to is always read.
// We assume Claude is started in the checked folder: we can't see folders above it or the
// user's "Project instructions" setting, which lives in their own settings.

const AGENTS = /(?:^|\/)(?:\.claude\/)?AGENTS\.md$/;
/** The three files that stop Claude from reading AGENTS.md, in the order we name them. */
const BLOCKERS = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];

/** The folder an AGENTS.md belongs to: "" for AGENTS.md and .claude/AGENTS.md at the root. */
const ownerDir = (agents: string): string => {
  const d = dirOf(agents);
  return d === '.claude' ? '' : d.endsWith('/.claude') ? d.slice(0, -'/.claude'.length) : d;
};

const real = (abs: string): string | null => {
  try {
    return realpathSync(abs);
  } catch {
    return null;
  }
};

/** False for an empty or whitespace-only AGENTS.md: there is nothing to miss. */
function hasText(abs: string): boolean {
  try {
    return readFileSync(abs).subarray(0, MAX_BYTES).toString('utf8').trim().length > 0;
  } catch {
    return false;
  }
}

export const agentsMdNotLoaded: Rule = {
  id: 'agents-md-not-loaded',
  severity: 'warning',
  certainty: 'sure',
  summary:
    'An AGENTS.md that Claude Code never reads, because a CLAUDE.md or CLAUDE.local.md next to it or above it does not import it.',
  why: 'Claude Code reads AGENTS.md on its own only when there is no CLAUDE.md. When there is one, Claude reads only the CLAUDE.md files, so everything in AGENTS.md is silently missing unless CLAUDE.md imports it with @AGENTS.md.',
  check(ctx: Context): Issue[] {
    const claudeFiles = ctx.files.filter((f) => f.kind === 'claude-md' || f.kind === 'claude-local-md');
    if (claudeFiles.length === 0) return [];
    const byPath = new Map(claudeFiles.map((f) => [f.path, f]));
    const blockersIn = (dir: string): SetupFile[] =>
      BLOCKERS.map((b) => byPath.get(dir ? `${dir}/${b}` : b)).filter((f): f is SetupFile => !!f);
    const imported = new Set(ctx.imports.filter((i) => i.exists).map((i) => i.target));
    const claudeReal = new Set(claudeFiles.map((f) => real(f.abs)).filter((p): p is string => !!p));

    /** True when Claude reads this AGENTS.md through a CLAUDE.md: an import, or a link either way. */
    const covered = (agents: string): boolean => {
      if (imported.has(agents)) return true;
      if (claudeFiles.some((f) => f.realPath === agents)) return true;
      const r = real(join(ctx.root, agents)); // AGENTS.md -> CLAUDE.md: Claude reads the same text
      return r !== null && claudeReal.has(r);
    };

    const agentsFiles = ctx
      .repoFiles()
      .filter((p) => AGENTS.test(p) && !/(?:^|\/)\.agents\//.test(p)) // Claude never reads .agents/
      .filter((p) => !covered(p) && hasText(join(ctx.root, p)));
    const rootBlockers = blockersIn('');
    const issues: Issue[] = [];
    const hiddenByRoot: string[] = [];

    for (const agents of agentsFiles) {
      const dir = ownerDir(agents);
      // The folder's own CLAUDE.md wins; a subfolder without one is hidden only by the root's.
      const own = dir ? blockersIn(dir) : rootBlockers;
      if (own.length > 0) issues.push(issueFor(agents, own));
      else if (dir && rootBlockers.length > 0) hiddenByRoot.push(agents);
    }

    if (hiddenByRoot.length > 0) {
      const blocker = rootBlockers[0]!;
      const first = hiddenByRoot[0]!;
      const more = hiddenByRoot.length - 1;
      const which =
        more > 0 ? `${first} and ${more} more AGENTS.md file${more === 1 ? '' : 's'} in subfolders are` : `${first} is`;
      issues.push({
        rule: 'agents-md-not-loaded',
        severity: 'warning',
        file: blocker.path,
        line: 1,
        message: `${which} not read by Claude Code: because ${blocker.path} exists, Claude reads only CLAUDE.md files (the default).`,
        hint: `Add a CLAUDE.md with the line "@AGENTS.md" next to each one (for example ${dirOf(first)}/CLAUDE.md), or import them from ${blocker.path}.`,
      });
    }
    return issues;
  },
};

/** One AGENTS.md hidden by the CLAUDE.md files in its own folder. */
function issueFor(agents: string, blockers: SetupFile[]): Issue {
  const blocker = blockers[0]!;
  const importPath = posix.relative(dirOf(blocker.path) || '.', agents);
  const base: Pick<Issue, 'rule' | 'severity' | 'file'> = {
    rule: 'agents-md-not-loaded',
    severity: 'warning',
    file: blocker.path,
  };
  // A link checked out as a plain file (Windows, or git's core.symlinks off): its whole text is the target.
  if (!blocker.realPath && blocker.text.trim() === importPath) {
    const line = blocker.lines.find((l) => l.text.trim() === importPath)!;
    return {
      ...base,
      line: line.n,
      message: `${blocker.path} only contains the text "${importPath}", so Claude reads that one word instead of ${agents}. It is probably a link that git saved as a plain file (Windows, or core.symlinks off).`,
      hint: `Write "@${importPath}" instead: an import works on every system.`,
      fix: { file: blocker.path, line: line.n, from: importPath, to: `@${importPath}` },
    };
  }
  const personal = blocker.kind === 'claude-local-md';
  const mentions = blocker.lines.some((l) => !l.inFrontmatter && l.text.includes('AGENTS.md'));
  return {
    ...base,
    line: 1,
    message: personal
      ? `${agents} is not read by Claude Code: your personal ${blocker.path} exists, and then Claude reads only CLAUDE.md files (the default).`
      : `${agents} is not read by Claude Code: because ${blocker.path} exists, Claude reads only CLAUDE.md files (the default).`,
    hint:
      (mentions ? `${blocker.path} mentions ${importPath}, but only an import makes Claude read it. ` : '') +
      `Add the line "@${importPath}" to ${blocker.path}` +
      (personal ? ', or set Project instructions to "claude-md-and-agents-md" in /config.' : '.'),
  };
}
