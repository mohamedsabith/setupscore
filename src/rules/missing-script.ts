import { join } from 'node:path';
import { MAX_LINE } from '../core/markdown.js';
import { baseOf, dirOf } from '../core/paths.js';
import { closest } from '../core/suggest.js';
import type { Context, Issue, Rule } from '../core/types.js';
import { clip, instructionFiles, packageOf } from './util.js';

const RUN = /\b(npm|pnpm|yarn|bun)\s+(?:run|run-script)\s+([A-Za-z0-9][\w:.\-/@]*[\w])/g;
const TEST = /\b(npm|pnpm|yarn)\s+(?:test|t)\b(?![-:\w])/g;
/** Flags that send the command to another package in a monorepo. */
const OTHER_PACKAGE = /(?:^|\s)(?:-w|--workspace|--workspaces|--filter|-F|--prefix|-C|--cwd|--dir|workspace)\b/;
/** "npm run with the --silent flag": English words after "npm run" are prose, not a script name. */
const PROSE = new Set([
  'with',
  'the',
  'to',
  'in',
  'on',
  'for',
  'and',
  'or',
  'it',
  'its',
  'this',
  'that',
  'your',
  'our',
  'my',
  'any',
  'each',
  'some',
  'them',
  'these',
  'those',
  'their',
  'scripts',
  'script',
  'commands',
  'command',
  'first',
  'again',
  'before',
  'after',
  'from',
  'inside',
  'locally',
  'here',
  'there',
  'instead',
  'only',
  'now',
  'as',
  'by',
  'then',
  'when',
  'if',
  'without',
  'which',
  'whatever',
  'whichever',
  'one',
  'something',
  'anything',
  'everything',
  'alone',
  'itself',
]);

export const missingScript: Rule = {
  id: 'missing-script',
  severity: 'error',
  summary: 'Your instructions tell Claude to run a package.json script that does not exist.',
  why: 'Claude runs the command, it fails, and Claude either gives up on checking its work or invents another command.',
  check(ctx: Context): Issue[] {
    const allPackages = ctx.repoFiles().filter((f) => f === 'package.json' || f.endsWith('/package.json'));
    if (allPackages.length === 0) return [];
    // Script name -> the packages that have it, for monorepo instructions about other packages.
    const owners = new Map<string, string[]>();
    for (const p of allPackages) {
      for (const name of Object.keys(packageOf(join(ctx.root, p))?.scripts ?? {})) {
        const list = owners.get(name) ?? [];
        list.push(p);
        owners.set(name, list);
      }
    }
    /** True when the line names the package (its folder or its "name"), like "(in the api package)". */
    const mentions = (line: string, pkgPath: string): boolean => {
      const folder = baseOf(dirOf(pkgPath));
      const name = packageOf(join(ctx.root, pkgPath))?.name;
      const words = [folder, name, name?.replace(/^@[^/]+\//, '')].filter((w): w is string => !!w && w.length >= 2);
      return words.some((w) =>
        // eslint-disable-next-line security/detect-non-literal-regexp -- the package name is escaped on this line
        new RegExp(`(?<![\\w-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').test(line),
      );
    };

    const nearest = (fileRel: string): string | undefined => {
      let dir = dirOf(fileRel);
      // A file inside .claude/ belongs to the folder that holds .claude/.
      const claudeAt = dir.split('/').indexOf('.claude');
      if (claudeAt >= 0) dir = dir.split('/').slice(0, claudeAt).join('/');
      for (;;) {
        const candidate = dir ? `${dir}/package.json` : 'package.json';
        if (ctx.existsRel(candidate)) return candidate;
        if (!dir) return undefined;
        dir = dirOf(dir);
      }
    };

    const issues: Issue[] = [];
    for (const f of instructionFiles(ctx)) {
      const pkg = nearest(f.path);
      if (!pkg) continue;
      const scripts = packageOf(join(ctx.root, pkg))?.scripts;
      if (!scripts) continue;
      const names = Object.keys(scripts);

      for (const l of f.lines) {
        if (l.inFrontmatter || l.text.length > MAX_LINE) continue;
        const otherPackage = OTHER_PACKAGE.test(l.text);
        const found: { pm: string; script: string; index: number; written: string }[] = [];
        for (const m of l.text.matchAll(RUN)) found.push({ pm: m[1]!, script: m[2]!, index: m.index, written: m[0] });
        for (const m of l.text.matchAll(TEST)) found.push({ pm: m[1]!, script: 'test', index: m.index, written: m[0] });

        for (const { script, index, written } of found) {
          if (Object.hasOwn(scripts, script) || otherPackage) continue;
          if (PROSE.has(script.toLowerCase())) continue;
          const elsewhere = owners.get(script) ?? [];
          if (elsewhere.length > 0) {
            if (elsewhere.some((p) => mentions(l.text, p))) continue;
            // A root CLAUDE.md often lists the scripts of the workspace packages. "npm test" is
            // different: it clearly means the package the instructions are for.
            if (pkg === 'package.json' && script !== 'test') continue;
          }
          const near = closest(script, names, 0.4);
          const list = names.length
            ? `Scripts in ${pkg}: ${names.slice(0, 10).join(', ')}${names.length > 10 ? ', …' : ''}.`
            : `${pkg} has no scripts.`;
          const where =
            elsewhere.length > 0
              ? ` Only ${elsewhere.slice(0, 3).join(', ')} ${elsewhere.length === 1 ? 'has' : 'have'} it.`
              : '';
          issues.push({
            rule: 'missing-script',
            severity: 'error',
            file: f.path,
            line: l.n,
            column: index + 1,
            message: `"${clip(written, 80)}" will fail: ${pkg} has no "${clip(script, 60)}" script.${where}`,
            hint: near ? `Did you mean "${near}"? ${list}` : list,
          });
        }
      }
    }
    return issues;
  },
};
