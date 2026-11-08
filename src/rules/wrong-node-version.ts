import { MAX_LINE } from '../core/markdown.js';
import type { Context, Issue, Rule } from '../core/types.js';
import { ANOTHER_PLACE, clip, instructionFiles, nearestPackage, projectFolder } from './util.js';
import { CI_OR_DOCKER_RUN, CONTRAST } from './wrong-package-manager.js';

/** "Node 18", "Node.js v18", "NodeJS 18.x", "Node >= 18", "Node 18+", "Node version 18". */
const NODE_VERSION =
  /\bnode(?:\.js|js)?\s+(?:version\s+)?(?:>=?\s*)?v?(\d{1,2})(?:\.(?:\d{1,3}|x)){0,2}\+?(?![\w-]|\.\w)/gi;

/**
 * The lowest Node major version an "engines.node" range allows, for the simple forms only:
 * ">=22.12", "^22.12.0", "~22", "22.x", "22", ">=22.12 <25". Null for anything else ("||", ">21", "*").
 */
export function minNodeMajor(range: string): number | null {
  const m = /^(?:>=\s*|\^|~)?v?(\d{1,2})(?:\.(?:\d{1,3}|x|\*)){0,2}(?:\s+<=?\s*v?\d[\d.x]*)?$/i.exec(range.trim());
  return m ? Number(m[1]) : null;
}

export const wrongNodeVersion: Rule = {
  id: 'wrong-node-version',
  severity: 'warning',
  summary: 'Your instructions name a Node.js version that the project no longer allows.',
  why: 'Claude follows the version in the instructions: it may avoid newer Node features the project relies on, or suggest setting up an old Node.',
  check(ctx: Context): Issue[] {
    const issues: Issue[] = [];
    // Standing instructions only: skills, agents and commands are often copied from other projects.
    for (const f of instructionFiles(ctx).filter((f) => !['skill', 'agent', 'command'].includes(f.kind))) {
      const pkg = nearestPackage(ctx, projectFolder(f.path));
      const range = pkg?.facts.engineNode;
      const min = range === undefined ? null : minNodeMajor(range);
      if (!pkg || range === undefined || min === null) continue;
      for (const l of f.lines) {
        if (l.inFence || l.inFrontmatter || l.text.length > MAX_LINE) continue;
        // Old versions named for contrast ("dropped Node 18"), other places (Docker, CI), or as a list.
        if (CONTRAST.test(l.text) || ANOTHER_PLACE.test(l.text) || CI_OR_DOCKER_RUN.test(l.text)) continue;
        if (/@types\/node|\bdropped\b|\bremoved\b|\bend[- ]of[- ]life\b|\bEOL\b/i.test(l.text)) continue;
        const named = [...l.text.matchAll(NODE_VERSION)];
        if (named.length !== 1) continue;
        const m = named[0]!;
        const major = Number(m[1]);
        if (major >= min) continue;
        issues.push({
          rule: 'wrong-node-version',
          severity: 'warning',
          file: f.path,
          line: l.n,
          column: m.index + 1,
          message: `"${clip(m[0], 40)}" is older than this project allows ("engines": { "node": "${clip(range, 40)}" } in ${pkg.rel}).`,
          hint: `Write Node ${min} or newer. If the project supports Node ${major} again, change "engines" in ${pkg.rel}.`,
        });
      }
    }
    return issues;
  },
};
