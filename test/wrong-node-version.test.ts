import { describe, expect, it } from 'vitest';
import { minNodeMajor } from '../src/rules/wrong-node-version.js';
import { lint } from './helpers.js';

const RULE = 'wrong-node-version';
const pkg = (node: unknown) => JSON.stringify({ name: 'demo', engines: { node } });

describe('wrong-node-version: what it catches', () => {
  it('names a Node version below "engines.node", in every common spelling', () => {
    for (const said of [
      'Node 18',
      'Node.js 18',
      'NodeJS 18.x',
      'node v18',
      'Node >= 18',
      'Node 18+',
      'Node version 16.20.2',
    ]) {
      const issues = lint(RULE, { 'package.json': pkg('>=22.12'), 'CLAUDE.md': `- This project needs ${said}.\n` });
      expect(issues, said).toHaveLength(1);
      expect(issues[0]!.message).toContain('"engines": { "node": ">=22.12" } in package.json');
    }
  });

  it('reads the simple engines ranges, and uses the package.json closest to the file', () => {
    expect(minNodeMajor('>=22.12')).toBe(22);
    expect(minNodeMajor('^20.11.0')).toBe(20);
    expect(minNodeMajor('~18')).toBe(18);
    expect(minNodeMajor('22.x')).toBe(22);
    expect(minNodeMajor('>=20 <25')).toBe(20);
    for (const hard of ['^18 || ^20', '>21', '*', 'lts/*', 'latest', '']) expect(minNodeMajor(hard), hard).toBeNull();
    const issues = lint(RULE, {
      'package.json': pkg('>=16'),
      'packages/api/package.json': pkg('>=22'),
      'packages/api/CLAUDE.md': '- Runs on Node 18.\n',
      'CLAUDE.md': '- Runs on Node 18.\n',
    });
    expect(issues.map((i) => i.file)).toEqual(['packages/api/CLAUDE.md']);
  });
});

describe('wrong-node-version: what it must not flag', () => {
  const quiet = (text: string, node: unknown = '>=22.12') => {
    expect(lint(RULE, { 'package.json': pkg(node), 'CLAUDE.md': text }), text).toEqual([]);
  };
  it('leaves alone allowed versions, contrast, other places, lists and code', () => {
    quiet('- Use Node 22 or newer.\n');
    quiet('- Node 24 is what CI uses locally too.\n');
    quiet('- Node 18 is not supported any more.\n');
    quiet('- We dropped Node 18 in v3.\n');
    quiet('- The Docker image uses Node 18.\n');
    quiet('- Tested on Node 18, Node 20 and Node 22.\n');
    quiet('- Install @types/node 18 for the old typings.\n');
    quiet('```sh\nnvm use node 18\n```\n');
    quiet('- Requires Node 18.\n', '^18 || ^20');
    quiet('- Requires Node 18.\n', 42);
  });
  it('needs a package.json with "engines"', () => {
    expect(lint(RULE, { 'CLAUDE.md': '- Requires Node 18.\n' })).toEqual([]);
    expect(lint(RULE, { 'package.json': '{"name":"x"}', 'CLAUDE.md': '- Requires Node 18.\n' })).toEqual([]);
  });
  it('skips skills, agents and commands, which are often copied from other projects', () => {
    expect(
      lint(RULE, {
        'package.json': pkg('>=22'),
        '.claude/skills/x/SKILL.md': '---\nname: x\ndescription: d\n---\n- Requires Node 18.\n',
      }),
    ).toEqual([]);
  });
});
