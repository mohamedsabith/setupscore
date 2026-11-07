// Which folders of src/ may import which. Run with `npm run deps`.
// The rules describe the layers setupscore already has, so they stop new shortcuts, not old code.
// Lowest layer first: core <- rules, sandbox <- tasks <- agent <- run <- commands <- main.ts / cli.ts.
const not = (from, to, comment) => ({
  name: `${from.replaceAll(/[^a-z]+/g, '-')}-not-to-${to.replaceAll(/[^a-z]+/g, '-')}`.replaceAll(/-+/g, '-'),
  comment,
  severity: 'error',
  from: { path: `^src/${from}` },
  to: { path: `^src/(?:${to})` },
});

export default {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'Import loops make start-up order fragile and hide which part depends on which.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      comment: 'A file nothing imports is dead code (or a forgotten entry point).',
      severity: 'error',
      from: { orphan: true, path: '^src/', pathNot: ['^src/(?:cli|index)\\.ts$', '\\.d\\.ts$'] },
      to: {},
    },
    {
      name: 'not-to-test',
      comment: 'The published code must never need the tests.',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^test/' },
    },
    {
      name: 'not-to-unresolvable',
      comment: 'An import that does not point to a file or an installed package.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-non-package-json',
      comment: 'A package that is not in package.json works here by luck and breaks for users.',
      severity: 'error',
      from: {},
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
    },
    {
      name: 'src-not-to-dev-dep',
      comment: 'devDependencies are not installed for users. Types only (import type) are fine.',
      severity: 'error',
      from: { path: '^src/' },
      to: { dependencyTypes: ['npm-dev'], dependencyTypesNot: ['type-only', 'type-import'] },
    },

    // Layers.
    not(
      'core/',
      'run|tasks|agent|commands|report|main|cli|index',
      'core is the base; it cannot use the parts built on it.',
    ),
    {
      ...not('core/', 'rules|sandbox', ''),
      comment: 'Known exceptions: check() runs the rules, and fix.ts throws the shared EnvironmentError.',
      from: { path: '^src/core/', pathNot: ['^src/core/(?:check|fix)\\.ts$'] },
    },
    not(
      'rules/',
      'run|tasks|agent|commands|report|sandbox|main|cli|index',
      'A rule only reads the project (core), nothing else.',
    ),
    not('sandbox/', 'rules|run|tasks|agent|commands|report|main|cli|index', 'The sandbox only needs core.'),
    not('tasks/', 'rules|run|agent|commands|report|main|cli|index', 'tasks only needs core and the sandbox.'),
    not(
      'agent/',
      'rules|run|commands|report|main|cli|index',
      'The agent adapter does not know about runs, reports or commands.',
    ),
    not('run/', 'rules|commands|report|main|cli|index', 'Runs do not print; commands and report do.'),
    not('report/', 'tasks|agent|sandbox|commands|main|cli|index', 'Reports only format results.'),
    not('commands/', 'main|cli|index', 'Commands are called by main.ts, never the other way round.'),
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // `import type` counts too: a type from the wrong layer is still the wrong layer.
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'] },
  },
};
