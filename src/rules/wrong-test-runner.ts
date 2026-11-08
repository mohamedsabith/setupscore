import { MAX_LINE } from '../core/markdown.js';
import type { Context, Issue, Rule } from '../core/types.js';
import { ANOTHER_PLACE, clip, instructionFiles, nearestPackage, projectFolder } from './util.js';
import { CI_OR_DOCKER_RUN, CONTRAST } from './wrong-package-manager.js';

type TestRunner = 'jest' | 'vitest' | 'mocha' | 'ava' | 'jasmine';

/** A runner as a whole word: not "jest-dom", "jest.fn", "vitest.config" or "@vitest/ui". */
const RUNNER_WORD = /(?<![\w@/.-])(jest|vitest|mocha|ava|jasmine)(?![\w-]|\.\w)/gi;
/** "we use Jest", "tests are written with vitest", "run the tests with mocha", "Testing: jest". */
const CLAIM =
  /\b(?:use|uses|using|written (?:in|with)|run (?:the )?tests? (?:with|using|via)|tests? (?:with|using|via)|test runner(?: is)?:?|testing:)\s+`?(jest|vitest|mocha|ava|jasmine)`?(?![\w-]|\.\w)/gi;
/** A command: `npx jest`, `pnpm vitest run`, `jest --watch` at the start of a command. */
const COMMAND =
  /(?:^|`|&&|;)\s*(?:\$\s*)?(?:(?:npx|bunx|pnpx)\s+|(?:pnpm|yarn)\s+(?:exec\s+)?)?(jest|vitest|mocha|ava)(?=\s|`|$)/gi;

/**
 * The one runner the project's "test" script uses, or null when it names none or several.
 * The runner must also be a dependency (it is, if the script works), so a script that only
 * prints a name proves nothing.
 */
export function scriptRunner(script: string | undefined, deps: ReadonlySet<string>): TestRunner | null {
  if (!script) return null;
  const named = new Set([...script.matchAll(RUNNER_WORD)].map((m) => m[1]!.toLowerCase() as TestRunner));
  if (named.size !== 1) return null;
  const runner = [...named][0]!;
  return deps.has(runner) ? runner : null;
}

export const wrongTestRunner: Rule = {
  id: 'wrong-test-runner',
  severity: 'warning',
  certainty: 'guess',
  summary: 'Your instructions name a different test runner than the project uses.',
  why: 'Claude writes tests for the runner the instructions name: with the wrong one the imports, mocks and commands do not work.',
  check(ctx: Context): Issue[] {
    const issues: Issue[] = [];
    // Standing instructions only: skills, agents and commands are often copied from other projects.
    for (const f of instructionFiles(ctx).filter((f) => !['skill', 'agent', 'command'].includes(f.kind))) {
      const pkg = nearestPackage(ctx, projectFolder(f.path));
      const uses = pkg ? scriptRunner(pkg.facts.scripts['test'], pkg.facts.deps) : null;
      if (!pkg || !uses) continue;
      for (const l of f.lines) {
        if (l.inFrontmatter || l.text.length > MAX_LINE) continue;
        if (CONTRAST.test(l.text) || ANOTHER_PLACE.test(l.text) || CI_OR_DOCKER_RUN.test(l.text)) continue;
        // "Vitest has a Jest-compatible API": a line that names several runners compares them.
        if (new Set([...l.text.matchAll(RUNNER_WORD)].map((m) => m[1]!.toLowerCase())).size > 1) continue;
        const said = [...l.text.matchAll(CLAIM), ...l.text.matchAll(COMMAND)].find((m) => m[1]!.toLowerCase() !== uses);
        if (!said) continue;
        const other = said[1]!.toLowerCase();
        // Installed too: the project may use both (one package each, end-to-end tests, a migration).
        if (pkg.facts.deps.has(other)) continue;
        issues.push({
          rule: 'wrong-test-runner',
          severity: 'warning',
          file: f.path,
          line: l.n,
          column: said.index + 1,
          message: `"${clip(said[0].trim(), 60)}" names ${other}, but this project tests with ${uses} ("test": "${clip(pkg.facts.scripts['test']!, 40)}" in ${pkg.rel}, and ${other} is not installed).`,
          hint: `Write ${uses} instead. If the project is moving to ${other}, install it and update the "test" script.`,
        });
      }
    }
    return issues;
  },
};
