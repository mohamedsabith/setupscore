import { join } from 'node:path';
import { gitIgnored } from '../core/git.js';
import { LOCKFILES, type PmName } from '../core/lockfiles.js';
import { MAX_LINE } from '../core/markdown.js';
import { dirOf } from '../core/paths.js';
import { trimEndWhile } from '../core/text.js';
import type { Context, Issue, Line, Rule, SetupFile } from '../core/types.js';
import { OTHER_PACKAGE } from './missing-script.js';
import { clip, instructionFiles, packageOf } from './util.js';

/**
 * A command that installs or changes dependencies, so it writes a lockfile. `npm run x` and
 * `npm test` are left out on purpose: many yarn, pnpm and bun projects use them as plain script runners.
 */
const INSTALL =
  /(?<![\w./@-])(npm|pnpm|yarn|bun)\s+(install|i|add|ci|remove|rm|uninstall|un)(?![\w-])((?:\s+[^\s;&|`#]+){0,3})/gi;

/**
 * "Use pnpm", "we use `yarn`", "package manager: pnpm". Not "use npm install/run …" (commands are
 * checked on their own, and npm run is a plain script runner) and not bun (also a runtime).
 */
const CLAIM =
  /\b(?:use|uses|using|prefer|prefers)\s+`?(npm|pnpm|yarn)`?(?![\w-])(?!`?\s+(?:install|i|add|ci|remove|rm|uninstall|un|run|test|start|exec|create|init|scripts?|workspaces?|registry|packages?|link|publish|pack|version|audit|login)\b)/gi;
const MANAGER = /\bpackage[ -]manager\s*(?:is|:)\s*`?(npm|pnpm|yarn|bun)`?(?![\w-])/gi;

/** Words after which a tool is named for contrast, not as the one to use: "pnpm (NOT npm)", "migrated from yarn". */
export const CONTRAST =
  /\b(?:never|not|don't|dont|do not|avoid|no longer|instead of|rather than|except|unless|stop|vs|versus|unlike|migrated from|migrating from|moved from|switched from|used to|legacy|deprecated|formerly|previously|old|replaces?|replaced|wrong|bad)\b/i;
/**
 * Lines about somewhere else than this checkout (global installs, one-off runners, containers, CI,
 * another branch), or a choice made on purpose ("these commands intentionally use npm").
 */
const ELSEWHERE =
  /(?:^|\s)(?:-g|--global)(?![\w-])|\b(?:npx|pnpx|dlx|bunx|corepack|docker|dockerfile|container|github actions|production|branch|intentionally|deliberately|on purpose)\b|\.github\//i;
/** `cd docs` at the start of a command: the commands after it run in that folder. */
const CD = /(?:^|&&|;|`)\s*(?:\$\s*)?cd\s+([^\s;&|`]+)/;
/** A comment line in a code block: "# WRONG - do not use these". */
const CODE_COMMENT = /^\s*(?:#|\/\/)/;
/** Case matters for these: "CI" (not "ci" as in `npm ci`) and a Dockerfile's RUN (not "Run"). */
export const CI_OR_DOCKER_RUN = /\bCI\b|^\s*RUN\s/;

const isCommentLine = (text: string): boolean => /^\s*<!--.*-->\s*$/.test(text);

/** The command to write instead, in the project's package manager. `args` only when they are surely code. */
function equivalent(pm: PmName, verb: string, args: string): string {
  const v = verb.toLowerCase();
  const rest = args.trim() || (['add', 'remove', 'rm', 'uninstall', 'un'].includes(v) ? '<package>' : '');
  if (['add', 'i', 'install'].includes(v) && rest) return `${pm} ${pm === 'npm' ? 'install' : 'add'} ${rest}`;
  if (['remove', 'rm', 'uninstall', 'un'].includes(v))
    return `${pm} ${pm === 'npm' ? 'uninstall' : 'remove'} ${rest}`.trim();
  return `${pm} install`;
}

interface ProjectPm {
  pm: PmName;
  /** The files that prove it: "package-lock.json", or `"packageManager" in package.json`. */
  proof: string;
}

export const wrongPackageManager: Rule = {
  id: 'wrong-package-manager',
  severity: 'warning',
  certainty: 'guess',
  summary: 'Your instructions use a different package manager than the project does.',
  why: 'Claude tends to follow the instructions over the lockfile. It runs the wrong tool, which can install other versions and leave a second lockfile.',
  check(ctx: Context): Issue[] {
    const ignoredCache = new Map<string, boolean>();
    const ignored = (rel: string): boolean => {
      if (!ignoredCache.has(rel)) ignoredCache.set(rel, gitIgnored(ctx.root, [rel]).has(rel));
      return ignoredCache.get(rel)!;
    };

    const cache = new Map<string, ProjectPm | null>();
    /** The package manager of a folder (from it or the closest folder above it), or null when unknown or mixed. */
    const pmOf = (start: string): ProjectPm | null => {
      if (cache.has(start)) return cache.get(start)!;
      let found: ProjectPm | null = null;
      for (let dir = start; ; dir = dirOf(dir)) {
        const rel = (f: string) => (dir ? `${dir}/${f}` : f);
        // A lockfile .gitignore ignores is only on this machine; it says nothing about the project.
        const locks = LOCKFILES.filter(([f]) => ctx.existsRel(rel(f)) && !ignored(rel(f)));
        const pkg = ctx.existsRel(rel('package.json')) ? packageOf(join(ctx.root, rel('package.json'))) : null;
        const declared = pkg?.declaredPms ?? [];
        if (locks.length > 0 || declared.length > 0) {
          // Only a clear answer counts: every lockfile and every "packageManager" names the same tool.
          const names = new Set<PmName>([...locks.map(([, pm]) => pm), ...declared]);
          if (names.size === 1) {
            const proof = locks.length
              ? locks.map(([f]) => rel(f)).join(' and ')
              : `"packageManager" in ${rel('package.json')}`;
            found = { pm: [...names][0]!, proof };
          }
          break;
        }
        if (!dir) break;
      }
      cache.set(start, found);
      return found;
    };
    /** The folder an instruction file is about: its own, or the one that holds .claude/. */
    const folderOf = (fileRel: string): string => {
      const parts = dirOf(fileRel).split('/');
      return parts.includes('.claude') ? parts.slice(0, parts.indexOf('.claude')).join('/') : dirOf(fileRel);
    };
    /** Where `cd x` goes: x in the file's folder, or x in the project root. Unknown (`cd ..`, `cd $DIR`): undefined. */
    const cdTarget = (base: string, to: string): string | undefined => {
      if (to.includes('..') || /[$~*]/.test(to) || to.startsWith('/')) return undefined;
      const clean = trimEndWhile(to.replace(/^\.\//, ''), (c) => c === '/');
      if (clean === '' || clean === '.') return base;
      for (const dir of [base ? `${base}/${clean}` : clean, clean]) if (ctx.isDir(dir)) return dir;
      return undefined;
    };
    // Install lines written for the users of a package in this repo: "npm install motion".
    const ownNames = new Set<string>();
    for (const p of ctx.repoFiles().filter((f) => f === 'package.json' || f.endsWith('/package.json'))) {
      const name = packageOf(join(ctx.root, p))?.name;
      if (name) ownNames.add(name).add(name.replace(/^@[^/]+\//, ''));
    }

    const issues: Issue[] = [];
    const report = (
      f: SetupFile,
      l: Line,
      index: number,
      said: string,
      project: ProjectPm,
      what: string,
      instead: string,
    ) =>
      issues.push({
        rule: 'wrong-package-manager',
        severity: 'warning',
        file: f.path,
        line: l.n,
        column: index + 1,
        message: `${what}, but this project uses ${project.pm} (${project.proof}).`,
        hint: `Write ${instead} instead. If the project is moving to ${said}, delete ${project.proof} and update package.json.`,
      });

    for (const f of instructionFiles(ctx)) {
      const base = folderOf(f.path);
      // Skills, agents and commands are often copied from other projects: only their plain claims count.
      const commandsToo = !['skill', 'agent', 'command'].includes(f.kind);
      // Inside one code block: the folder after `cd`, and whether a comment said "wrong" or "don't".
      let fenceDir: string | undefined = base;
      let fenceOff = false;
      let lastProse = '';

      for (const l of f.lines) {
        if (!l.inFence) {
          fenceDir = base;
          fenceOff = false;
        } else if (/^\s*(?:`{3,}|~{3,})/.test(l.text)) {
          // The fence line itself. A block right after "Don't run these:" shows what not to do.
          fenceOff ||= CONTRAST.test(lastProse);
          continue;
        }
        if (l.inFrontmatter || l.text.length > MAX_LINE || isCommentLine(l.text)) continue;
        if (!l.inFence && l.text.trim()) lastProse = l.text;
        if (l.inFence && CODE_COMMENT.test(l.text)) {
          fenceOff = CONTRAST.test(l.text);
          continue;
        }
        if (fenceOff) continue;

        // `cd docs` (alone, or before && on this line) moves the commands after it to that folder.
        const cd = l.text.match(CD);
        let dir: string | undefined = l.inFence ? fenceDir : base;
        if (cd) {
          dir = dir === undefined ? undefined : cdTarget(dir, cd[1]!);
          if (l.inFence) fenceDir = dir;
        }
        if (dir === undefined) continue;
        const project = pmOf(dir);
        if (!project) continue;

        if (ELSEWHERE.test(l.text) || CI_OR_DOCKER_RUN.test(l.text) || OTHER_PACKAGE.test(l.text)) continue;
        // Text after "not", "instead of", "migrated from" … names tools for contrast.
        const contrastAt = l.text.search(CONTRAST);
        const before = contrastAt === -1 ? l.text : l.text.slice(0, contrastAt);

        const commands = commandsToo ? [...before.matchAll(INSTALL)] : [];
        // "npm i x / yarn add x / pnpm add x": a list of choices for the reader, not an instruction.
        if (new Set(commands.map((m) => m[1]!.toLowerCase())).size > 1) continue;
        const command = commands.find((m) => {
          const args = m[3]!.trim().split(/\s+/).filter(Boolean);
          return m[1]!.toLowerCase() !== project.pm && !args.some((a) => ownNames.has(a.replace(/(?<=.)@[^@/]*$/, '')));
        });
        if (command) {
          const said = command[1]!.toLowerCase();
          // Words after a command in a sentence ("run pnpm install to set up") are not its arguments.
          const args = l.inFence || before[command.index - 1] === '`' ? command[3]! : '';
          report(
            f,
            l,
            command.index,
            said,
            project,
            `"${clip(command[0].trim(), 80)}" uses ${said}`,
            `"${clip(equivalent(project.pm, command[2]!, args), 80)}"`,
          );
          continue;
        }
        if (l.inFence || commands.length > 0) continue;
        // "works with npm, yarn and pnpm": a line that names several tools is a list, not a choice.
        if (new Set([...before.matchAll(/\b(npm|pnpm|yarn|bun)\b/gi)].map((m) => m[1]!.toLowerCase())).size > 1)
          continue;
        const claim = [...before.matchAll(CLAIM), ...before.matchAll(MANAGER)]
          .sort((a, b) => a.index - b.index)
          .find((m) => m[1]!.toLowerCase() !== project.pm);
        if (claim) {
          const said = claim[1]!.toLowerCase();
          report(f, l, claim.index, said, project, `This says to use ${said}`, project.pm);
        }
      }
    }
    return issues;
  },
};
