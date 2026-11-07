import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { check } from '../src/core/check.js';
import { initGit, issuesOf, lint, makeRepo } from './helpers.js';

const RULE = 'wrong-package-manager';
const PKG = JSON.stringify({ name: 'demo', scripts: { test: 'vitest', build: 'tsc', lint: 'eslint .' } });
const NPM = { 'package.json': PKG, 'package-lock.json': '{}' };
const PNPM = { 'package.json': PKG, 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n' };
const YARN = { 'package.json': PKG, 'yarn.lock': '# yarn lockfile v1\n' };
const BUN = { 'package.json': PKG, 'bun.lock': '{}' };

const found = (files: Record<string, string>) => lint(RULE, files);
const md = (text: string) => `# Project\n\n${text}\n`;

describe('wrong-package-manager: what it catches', () => {
  it('a plain "use pnpm" in an npm project, naming the lockfile as proof', () => {
    const [i, ...rest] = found({ ...NPM, 'CLAUDE.md': md('- Use pnpm for everything.') });
    expect(rest).toEqual([]);
    expect(i).toMatchObject({ rule: RULE, severity: 'warning', file: 'CLAUDE.md', line: 3, column: 3 });
    expect(i!.message).toBe('This says to use pnpm, but this project uses npm (package-lock.json).');
    expect(i!.hint).toContain('Write npm instead');
    expect(i!.hint).toContain('delete package-lock.json');
    expect(i!.fix).toBeUndefined();
  });

  it('an install command for the wrong tool, with the right command in the hint', () => {
    const [i] = found({ ...PNPM, 'CLAUDE.md': md('Run `npm install` after you pull.') });
    expect(i!.message).toBe('"npm install" uses npm, but this project uses pnpm (pnpm-lock.yaml).');
    expect(i!.hint).toContain('Write "pnpm install" instead');
    expect(i!.column).toBe(6);
  });

  it('commands inside code blocks too, with the package names kept', () => {
    const text = md('```bash\npnpm add zod\npnpm remove lodash\n```');
    const issues = found({ ...NPM, 'CLAUDE.md': text });
    expect(issues.map((i) => [i.line, i.hint?.split(' instead')[0]])).toEqual([
      [4, 'Write "npm install zod"'],
      [5, 'Write "npm uninstall lodash"'],
    ]);
  });

  it('every install verb: install, i, add, ci, remove, rm, uninstall, un', () => {
    for (const verb of ['install', 'i', 'add x', 'ci', 'remove x', 'rm x', 'uninstall x', 'un x']) {
      expect(found({ ...YARN, 'CLAUDE.md': md(`Run \`npm ${verb}\`.`) }), verb).toHaveLength(1);
    }
    expect(found({ ...NPM, 'CLAUDE.md': md('Run `yarn add x`.') })[0]!.hint).toContain('"npm install x"');
    expect(found({ ...YARN, 'CLAUDE.md': md('Run `npm ci`.') })[0]!.hint).toContain('"yarn install"');
  });

  it('words after a command in a sentence are not used as package names', () => {
    const [i] = found({ ...NPM, 'CLAUDE.md': md('Run pnpm install to set everything up.') });
    expect(i!.hint).toContain('Write "npm install" instead');
    const [j] = found({ ...NPM, 'CLAUDE.md': md('Then pnpm add the package you need.') });
    expect(j!.hint).toContain('Write "npm install <package>" instead');
  });

  it('the "packageManager" field when there is no lockfile', () => {
    const pkg = JSON.stringify({ name: 'demo', packageManager: 'pnpm@9.12.0' });
    const [i] = found({ 'package.json': pkg, 'CLAUDE.md': md('Run `npm install`.') });
    expect(i!.message).toContain('this project uses pnpm ("packageManager" in package.json)');
  });

  it('"devEngines.packageManager", as an object or a list', () => {
    for (const dev of [{ name: 'yarn' }, [{ name: 'yarn', onFail: 'error' }]]) {
      const pkg = JSON.stringify({ name: 'demo', devEngines: { packageManager: dev } });
      expect(found({ 'package.json': pkg, 'CLAUDE.md': md('Run `npm install`.') })[0]?.message).toContain('uses yarn');
    }
  });

  it('a folder with its own lockfile (langflow: "yarn install" in docs/, which has package-lock.json)', () => {
    const issues = found({
      ...PNPM,
      'CLAUDE.md': md('Use `pnpm install`.'),
      'docs/package.json': PKG,
      'docs/package-lock.json': '{}',
      'docs/CLAUDE.md': md('Run `yarn install` here.'),
    });
    expect(issues.map((i) => [i.file, i.message])).toEqual([
      ['docs/CLAUDE.md', '"yarn install" uses yarn, but this project uses npm (docs/package-lock.json).'],
    ]);
  });

  it('a workspace package without a lockfile uses the lockfile of the workspace root', () => {
    const issues = found({
      ...PNPM,
      'packages/api/package.json': PKG,
      'packages/api/CLAUDE.md': md('Run `npm install` first.'),
    });
    expect(issues.map((i) => [i.file, i.message])).toEqual([
      ['packages/api/CLAUDE.md', '"npm install" uses npm, but this project uses pnpm (pnpm-lock.yaml).'],
    ]);
  });

  it('files in .claude/ belong to the folder that holds .claude/', () => {
    const issues = found({ ...NPM, 'CLAUDE.md': md('Hi.'), '.claude/rules/deps.md': md('- Install with `pnpm add`.') });
    expect(issues.map((i) => i.file)).toEqual(['.claude/rules/deps.md']);
  });

  it('"package manager: …", backticks around the name, upper case, and the "use X, not Y" order', () => {
    expect(found({ ...BUN, 'CLAUDE.md': md('Package manager: yarn') })[0]?.message).toContain('use yarn');
    expect(found({ ...NPM, 'CLAUDE.md': md('We use `yarn`.') })[0]?.message).toContain('use yarn');
    expect(found({ ...PNPM, 'CLAUDE.md': md('Run NPM install.') })[0]?.message).toContain('uses npm');
    expect(found({ ...NPM, 'CLAUDE.md': md('Use pnpm, not npm.') })[0]?.message).toContain('use pnpm');
  });

  it('Bun with both bun.lock and bun.lockb (Bun keeps the old one when it upgrades)', () => {
    const [i] = found({ ...BUN, 'bun.lockb': 'x', 'CLAUDE.md': md('Run `npm install`.') });
    expect(i!.message).toContain('this project uses bun (bun.lock and bun.lockb)');
  });

  it('only the first wrong command on a line is reported', () => {
    expect(found({ ...NPM, 'CLAUDE.md': md('Run `pnpm install && pnpm add zod`.') })).toHaveLength(1);
  });

  it('plain claims in skills, agents and commands', () => {
    const skill = '---\nname: s\ndescription: d\n---\n\nUse pnpm here.\n';
    expect(found({ ...NPM, 'CLAUDE.md': md('Hi.'), '.claude/skills/s/SKILL.md': skill })).toHaveLength(1);
  });
});

describe('wrong-package-manager: `cd` and comments in code blocks (found on real repositories)', () => {
  it('`cd docs` moves the commands after it to that folder (langflow)', () => {
    const files = { ...PNPM, 'docs/package.json': PKG, 'docs/package-lock.json': '{}' };
    const block = md('```bash\ncd docs\nyarn install\nyarn start\n```');
    expect(found({ ...files, 'CLAUDE.md': block }).map((i) => [i.line, i.message])).toEqual([
      [5, '"yarn install" uses yarn, but this project uses npm (docs/package-lock.json).'],
    ]);
    expect(found({ ...files, 'CLAUDE.md': md('Run `cd docs && yarn install`.') })[0]?.message).toContain(
      'docs/package-lock.json',
    );
  });

  it('`cd` into a folder with another lockfile (a bun app in an npm repo)', () => {
    const files = { ...NPM, 'apps/web/package.json': PKG, 'apps/web/bun.lock': '{}' };
    const [i] = found({ ...files, 'CLAUDE.md': md('```bash\ncd apps/web\nnpm install   # Install dependencies\n```') });
    expect(i?.message).toBe('"npm install" uses npm, but this project uses bun (apps/web/bun.lock).');
    expect(i?.hint).toContain('Write "bun install" instead');
  });

  it('`cd` into a folder setupscore cannot know stops checking that block', () => {
    for (const to of ['../other', '$APP_DIR', '~/x', '/srv/app', 'missing-folder'])
      expect(found({ ...PNPM, 'CLAUDE.md': md(`\`\`\`bash\ncd ${to}\nnpm install\n\`\`\``) }), to).toEqual([]);
  });

  it('a block after "# WRONG - do not use these" or "Don\'t run these:" shows what not to do', () => {
    expect(
      found({ ...PNPM, 'CLAUDE.md': md('```bash\n# WRONG - Do not use these\nnpm install\nnpm run dev\n```') }),
    ).toEqual([]);
    expect(found({ ...PNPM, 'CLAUDE.md': md("Don't run these:\n\n```bash\nnpm install\n```") })).toEqual([]);
  });

  it('a later comment without "wrong" or "not" turns checking back on', () => {
    const text = md('```bash\n# Wrong:\nnpm install\n# Right:\npnpm install\nyarn add x\n```');
    expect(found({ ...PNPM, 'CLAUDE.md': text }).map((i) => i.line)).toEqual([8]);
  });
});

describe('wrong-package-manager: what it must not flag', () => {
  const quiet = (files: Record<string, string>, why: string) => {
    expect(found(files), why).toEqual([]);
  };

  it('the tool the project uses', () => {
    quiet({ ...NPM, 'CLAUDE.md': md('Run `npm install`, then `npm ci` in a clean checkout.') }, 'npm in npm');
    quiet({ ...PNPM, 'CLAUDE.md': md('Use pnpm. Run `pnpm add zod`.') }, 'pnpm in pnpm');
  });

  it('no lockfile and no "packageManager": the project does not say', () => {
    quiet({ 'package.json': PKG, 'CLAUDE.md': md('Use pnpm. Run `pnpm install`.') }, 'unknown');
    quiet({ 'CLAUDE.md': md('Run `yarn install`.') }, 'no package.json');
  });

  it('mixed signals: two kinds of lockfile, or a lockfile that disagrees with "packageManager"', () => {
    quiet({ ...NPM, 'pnpm-lock.yaml': 'x', 'CLAUDE.md': md('Run `pnpm install`.') }, 'two lockfiles');
    const pkg = JSON.stringify({ name: 'demo', packageManager: 'pnpm@9.0.0' });
    quiet({ 'package.json': pkg, 'package-lock.json': '{}', 'CLAUDE.md': md('Run `pnpm install`.') }, 'disagree');
  });

  it('tools named for contrast: "pnpm (NOT npm)", "instead of npm", "migrated from yarn"', () => {
    for (const line of [
      '- Use pnpm (NOT npm, NOT yarn).',
      '- Always use pnpm, not npm.',
      '- Never run `npm install`.',
      '- Use pnpm instead of `npm install`.',
      '- We migrated from yarn to pnpm.',
      '- Unlike the old repo, `yarn add` is gone.',
      '- pnpm vs npm: pnpm is faster.',
    ])
      quiet({ ...PNPM, 'CLAUDE.md': md(line) }, line);
  });

  it('script runners, global installs, one-off runners and other packages', () => {
    for (const line of [
      'Run `npm run build` and `npm test`.',
      'Use npm run lint before committing.',
      'Install the CLI with `npm install -g pnpm`.',
      'Run `npm i --global corepack`.',
      'Try it with `npx setupscore check`.',
      'Run `pnpm dlx create-app`.',
      'Use `bunx vitest`.',
      'Run `corepack enable` first.',
      'Run `npm install --workspace api`.',
      'Run `yarn --cwd web add x`.',
    ])
      quiet({ ...PNPM, 'CLAUDE.md': md(line) }, line);
  });

  it('lines about CI, Docker or production', () => {
    for (const line of [
      'In CI we run `npm ci`.',
      'The Dockerfile runs `npm ci --omit=dev`.',
      '```dockerfile\nRUN npm ci\n```',
      'Production installs use `npm ci`.',
      'See .github/workflows/ci.yml: it runs `npm ci`.',
    ])
      quiet({ ...PNPM, 'CLAUDE.md': md(line) }, line);
  });

  it('install snippets for users of the package, and lists of choices', () => {
    quiet({ ...PNPM, 'CLAUDE.md': md('Users install it with `npm install demo`.') }, 'own package');
    quiet({ ...PNPM, 'CLAUDE.md': md('Users install it with `npm install demo@latest`.') }, 'own package, version');
    const scoped = { 'package.json': JSON.stringify({ name: '@acme/demo' }), 'pnpm-lock.yaml': 'x' };
    quiet({ ...scoped, 'CLAUDE.md': md('Install: `npm i @acme/demo`.') }, 'scoped package');
    quiet({ ...PNPM, 'CLAUDE.md': md('`npm i x` / `yarn add x` / `pnpm add x`') }, 'a list of choices');
    quiet({ ...PNPM, 'CLAUDE.md': md('It works with npm, yarn and pnpm.') }, 'a list of tools');
  });

  it('another branch, a choice made on purpose, and "with npm" in a sentence (found on real repositories)', () => {
    quiet({ ...BUN, 'CLAUDE.md': md('On that branch use `npm`, never `bun`.') }, 'cline');
    quiet(
      { ...PNPM, 'CLAUDE.md': md('These commands intentionally use npm because the upstream keeps its own lockfile.') },
      'odh',
    );
    quiet({ ...PNPM, 'CLAUDE.md': md('macOS publication runs in parallel with npm and never blocks it.') }, 'openclaw');
  });

  it('install lines for any package of this repository (motion: `npm install motion` in a yarn monorepo)', () => {
    const files = { ...YARN, 'packages/motion/package.json': JSON.stringify({ name: 'motion' }) };
    quiet({ ...files, 'CLAUDE.md': md('- **motion** - Main public package (`npm install motion`).') }, 'motion');
  });

  it('Bun as a runtime, and words that only look like commands', () => {
    quiet({ ...NPM, 'CLAUDE.md': md('Use bun to run the scripts faster.') }, 'bun runtime');
    quiet({ ...NPM, 'CLAUDE.md': md('Use `bun test` for unit tests.') }, 'bun test');
    quiet({ ...PNPM, 'CLAUDE.md': md('The mynpm install script and ./npm install helper.') }, 'glued words');
    quiet(
      { ...PNPM, 'CLAUDE.md': md('Use npm packages from the registry. Use yarn workspaces.') },
      'not a tool choice',
    );
  });

  it('skills, agents and commands are often copied: their commands are not checked', () => {
    const skill = '---\nname: s\ndescription: d\n---\n\n```bash\npnpm install\n```\n';
    quiet({ ...NPM, 'CLAUDE.md': md('Hi.'), '.claude/skills/s/SKILL.md': skill }, 'skill command');
    quiet(
      {
        ...NPM,
        'CLAUDE.md': md('Hi.'),
        '.claude/agents/a.md': '---\nname: a\ndescription: d\n---\nRun pnpm install.\n',
      },
      'agent',
    );
  });

  it('a nested package with its own lockfile is judged by that lockfile', () => {
    quiet(
      {
        ...PNPM,
        'tools/x/package.json': PKG,
        'tools/x/package-lock.json': '{}',
        'tools/x/CLAUDE.md': md('Run `npm install`.'),
      },
      'nested npm package',
    );
  });

  it('comments, frontmatter, disabled lines and very long lines', () => {
    quiet({ ...PNPM, 'CLAUDE.md': md('<!-- old: npm install -->') }, 'comment');
    quiet({ ...PNPM, '.claude/rules/r.md': '---\npaths: src/**\ndescription: npm install\n---\nHi.\n' }, 'frontmatter');
    quiet(
      { ...PNPM, 'CLAUDE.md': md('<!-- setupscore-disable-next-line wrong-package-manager -->\nRun `npm install`.') },
      'disabled',
    );
    quiet({ ...PNPM, 'CLAUDE.md': md(`Run \`npm install\` ${'x'.repeat(10_001)}`) }, 'too long');
  });

  it('a lockfile that .gitignore ignores exists only on this machine, so it is not proof', () => {
    const root = makeRepo({
      'package.json': PKG,
      'package-lock.json': '{}',
      '.gitignore': 'package-lock.json\n',
      'CLAUDE.md': md('Use pnpm.'),
    });
    initGit(root);
    expect(issuesOf(root, RULE)).toEqual([]);
  });

  it('setupscore itself: npm project, "npm run" in CLAUDE.md', () => {
    const repo = fileURLToPath(new URL('..', import.meta.url));
    expect(check(repo).issues.filter((i) => i.rule === RULE)).toEqual([]);
  });
});
