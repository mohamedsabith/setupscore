#!/usr/bin/env node
// Run `setupscore check --json` on real public repositories with a released version and with this
// build, and print every finding that was added or removed. Use it before changing how a rule matches.
//
//   npm run build && node scripts/corpus-diff.mjs                      # against setupscore@latest
//   node scripts/corpus-diff.mjs --base 1.0.0 --limit 10
//   node scripts/corpus-diff.mjs --base ../old/dist/cli.js --repos my-list.txt
//
// Repositories are cloned once (depth 1) into ~/.cache/setupscore-corpus and reused, so results
// stay comparable. Pass --refresh to pull the newest commit. `check` only reads files: nothing from
// these repositories is run.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const reposFile = resolve(opt('repos', join(here, 'corpus-repos.txt')));
const base = opt('base', 'latest');
const limit = Number(opt('limit', '0')) || Infinity;
const cache = resolve(opt('cache', join(homedir(), '.cache', 'setupscore-corpus')));
const refresh = args.includes('--refresh');
const newCli = resolve(here, '..', 'dist', 'cli.js');

if (!existsSync(newCli)) {
  console.error('dist/cli.js is missing. Run "npm run build" first.');
  process.exit(2);
}

/** The released version as a cli.js path, installed once into the cache. */
function baseCli() {
  if (base.endsWith('.js')) return isAbsolute(base) ? base : resolve(base);
  const dir = join(cache, `base-${base.replace(/[^\w.-]/g, '_')}`);
  const cli = join(dir, 'node_modules', 'setupscore', 'dist', 'cli.js');
  if (!existsSync(cli) || (base === 'latest' && refresh)) {
    mkdirSync(dir, { recursive: true });
    execFileSync('npm', ['install', '--prefix', dir, '--no-save', '--silent', `setupscore@${base}`], {
      stdio: 'inherit',
    });
  }
  return cli;
}

function checkout(repo) {
  const dir = join(cache, 'repos', repo.replace('/', '__'));
  if (!existsSync(dir)) {
    mkdirSync(dirname(dir), { recursive: true });
    const r = spawnSync('git', ['clone', '--quiet', '--depth', '1', `https://github.com/${repo}.git`, dir], {
      stdio: 'ignore',
      timeout: 120_000,
    });
    if (r.status !== 0) return null;
  } else if (refresh) {
    spawnSync('git', ['-C', dir, 'pull', '--quiet', '--depth', '1'], { stdio: 'ignore', timeout: 120_000 });
  }
  return dir;
}

/** Findings as "rule  file:line  message", or null when the run failed. */
function findings(cli, dir) {
  const r = spawnSync(process.execPath, [cli, 'check', dir, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  try {
    const json = JSON.parse(r.stdout);
    return new Set((json.issues ?? []).map((i) => `${i.rule}  ${i.file}:${i.line}  ${i.message}`));
  } catch {
    return null;
  }
}

const repos = readFileSync(reposFile, 'utf8')
  .split('\n')
  .map((l) => l.replace(/#.*/, '').trim())
  .filter(Boolean)
  .slice(0, limit);
const oldCli = baseCli();
const byRule = new Map();
let changed = 0;
let skipped = 0;

for (const repo of repos) {
  const dir = checkout(repo);
  const before = dir && findings(oldCli, dir);
  const after = dir && findings(newCli, dir);
  if (!before || !after) {
    skipped++;
    console.log(`? ${repo}: could not clone or check`);
    continue;
  }
  const added = [...after].filter((f) => !before.has(f));
  const removed = [...before].filter((f) => !after.has(f));
  if (!added.length && !removed.length) continue;
  changed++;
  const sha = spawnSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  console.log(`\n${repo} @ ${sha}`);
  for (const [sign, list] of [
    ['+', added],
    ['-', removed],
  ]) {
    for (const f of list) {
      console.log(`  ${sign} ${f}`);
      const rule = f.split('  ')[0];
      const counts = byRule.get(rule) ?? { added: 0, removed: 0 };
      counts[sign === '+' ? 'added' : 'removed']++;
      byRule.set(rule, counts);
    }
  }
}

console.log(`\n${repos.length} repositories, ${changed} with changed findings, ${skipped} skipped.`);
for (const [rule, c] of [...byRule].sort()) console.log(`  ${rule}: +${c.added} -${c.removed}`);
console.log('Read every + line: each one is a new finding a user will see.');
