#!/usr/bin/env node
// A stand-in for Claude Code in tests. It prints the same stream-json events as
// `claude -p --output-format stream-json --verbose` and "solves" a task by copying the
// source files from the commit that follows the checked-out one (the real fix).
//
// The workspace has no branches, tags or reflog, so the fake needs an oracle to find that
// commit: it quietly walks the git objects (see findFix). It never reports that as a tool
// call, so it is not flagged as looking outside.
//
//   node fake-claude.mjs <mode> [--cost=0.05] [--counter=/tmp/claude/x] [--peek=/real/project] [--repo=/real/project]
// Modes: solve | needs-claude-md | break-rule | nothing | auth-fail | overloaded-once | slow
//        add-dep          solves it with a new (local) dependency that it does not install itself
//        cheat-refs       tries every normal git command to find a later commit (must find none)
//        cheat-alternates finds the answer through the alternates file, and says so (must be flagged)
//        cheat-folder     copies files from the real project folder given by --peek (the sandbox must block it)
//        cheat-shim       puts a `node` and `npm` that always succeed into node_modules/.bin
//        cheat-symlink    replaces the hidden test files with links to /dev/null
//        cheat-dir        replaces the tests' folder with a link to /dev/null
//        cheat-script     sets the test script to "exit 0" and adds an .npmrc that preloads a file
//        cheat-import     solves by importing the answer from the real folder given by --peek
//        cheat-pristine   solves nothing, but plants a `node` that always succeeds in the original
//                         node_modules kept aside (../../pristine, ../../deps) and a git hook in
//                         ../../no-hooks; writes what it managed to --log=<file> (the sandbox must block all)
//        cheat-erase      digs through the alternates file (reported as a tool call), solves, then
//                         tries to erase and rewrite its own transcript (must still be flagged)
//        overloaded-always  the API is always overloaded (Claude Code gives up each time)
//        leak-key         puts the API key in its stderr, its final message and in code that the
//                         hidden tests run (so the key reaches the test output); --crash: exits 1
//                         after printing the key, with no result
//        bg-escape        starts a background process in its own session (setsid) that appends to
//                         --hb=<file> every 100 ms, then solves
//        model-used       reports --model-used=<id> as its model (init and assistant messages), then solves
//        web-search       "searches the web" for the fix (a WebSearch tool call), then solves; it also
//                         records whether --disallowedTools WebSearch,WebFetch was given (--log=<file>)
import { execSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('9.9.9 (Fake Claude Code)');
  process.exit(0);
}
const mode = args.find((a) => !a.startsWith('-')) ?? 'solve';
const opt = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const cost = Number(opt('cost', '0.05'));

const out = (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`);
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let n = 0;
const tool = (name, input) => {
  const id = `toolu_${++n}`;
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  return id;
};
const toolResult = (id, text, isError = false) => out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } });
const result = (subtype, extra = {}) => out({ type: 'result', subtype, is_error: false, duration_ms: 1200, num_turns: n + 1, total_cost_usd: cost, usage: { input_tokens: 1000, output_tokens: 200 }, session_id: 'fake', ...extra });

const skills = existsSync('.claude/skills') ? readdirSync('.claude/skills') : [];
out({ type: 'system', subtype: 'init', session_id: 'fake', model: mode === 'model-used' ? opt('model-used', 'fake-model') : 'fake-model', apiKeySource: 'ANTHROPIC_API_KEY', claude_code_version: '9.9.9', skills, memory_paths: existsSync('CLAUDE.md') ? ['CLAUDE.md'] : [], mcp_servers: [] });
readFileSync(0, 'utf8'); // the prompt arrives on stdin

if (mode === 'slow') {
  // Works for a while, so a test can press Ctrl+C mid-run.
  await new Promise((r) => setTimeout(r, Number(opt('ms', '20000'))));
}

if (mode === 'overloaded-always') {
  out({ type: 'system', subtype: 'api_retry', attempt: 10, max_retries: 10, error: 'overloaded' });
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 529 Overloaded', num_turns: 0, total_cost_usd: cost, duration_ms: 10 });
  process.exit(1);
}

if (mode === 'leak-key') {
  const key = process.env.ANTHROPIC_API_KEY ?? 'no-key';
  process.stderr.write(`debug: using key ${key}\n`);
  if (args.includes('--crash')) {
    process.stderr.write(`Error: request failed for key ${key}\n`);
    process.exit(1);
  }
  // Code the hidden tests import: it prints the key and fails, so the key reaches the test output.
  for (const f of readdirSync('src').filter((f) => f.endsWith('.js') && !/\.(?:test|spec)\./.test(f))) {
    const text = `console.log(${JSON.stringify(`key=${key}`)});\nthrow new Error(${JSON.stringify(`leaked ${key}`)});\n`;
    tool('Write', { file_path: `src/${f}`, content: text });
    writeFileSync(join('src', f), text);
  }
  result('success', { result: `Done. I used ${key}.` });
  process.exit(0);
}

if (mode === 'cheat-pristine') {
  const log = opt('log', '');
  const done = [];
  const plant = (dir) => {
    try {
      mkdirSync(join(dir, '.bin'), { recursive: true });
      for (const name of ['node', 'npm']) {
        writeFileSync(join(dir, '.bin', name), '#!/bin/sh\nexit 0\n');
        chmodSync(join(dir, '.bin', name), 0o755);
      }
      done.push(dir);
    } catch {
      // blocked
    }
  };
  // Where setupscore keeps the original node_modules and parked installs (old and new layouts).
  for (const parent of ['../../pristine', '../../deps', '..', '../..']) {
    let names;
    try {
      names = readdirSync(parent);
    } catch {
      continue;
    }
    for (const n of names) if (/^\d+$|^[0-9a-f]{8,}$|setupscore-pristine$/.test(n)) plant(join(parent, n));
  }
  try {
    const hook = '../../no-hooks/post-checkout';
    writeFileSync(hook, `#!/bin/sh\necho ran > ${JSON.stringify(opt('hook-mark', '/tmp/claude/fake-hook-ran'))}\n`);
    chmodSync(hook, 0o755);
    done.push(hook);
  } catch {
    // blocked
  }
  toolResult(tool('Bash', { command: 'ls ../..' }), 'ok');
  if (log) writeFileSync(log, `${done.join('\n')}\n`);
  result('success', { result: `Planted ${done.length}.` });
  process.exit(0);
}

if (mode === 'web-search') {
  const log = opt('log', '');
  if (log) writeFileSync(log, args.join(' '));
  toolResult(tool('WebSearch', { query: 'shop cart count commit github' }), 'found the commit');
}

if (mode === 'bg-escape') {
  const hb = opt('hb', '/tmp/claude/fake-bg-heartbeat');
  const beat = `const f = () => require('fs').appendFileSync(${JSON.stringify(hb)}, 'x'); f(); setInterval(f, 100)`;
  const child = spawn('setsid', [process.execPath, '-e', beat], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 100 && !existsSync(hb); i++) await new Promise((r) => setTimeout(r, 50)); // it is running
}

if (mode === 'auth-fail') {
  out({ type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Invalid API key · Please run /login' }] } });
  out({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login', num_turns: 1, total_cost_usd: 0, duration_ms: 10, terminal_reason: 'api_error' });
  process.exit(1);
}

if (mode === 'overloaded-once') {
  const counter = opt('counter', '/tmp/claude/fake-overload');
  if (!existsSync(counter)) {
    writeFileSync(counter, '1');
    out({ type: 'system', subtype: 'api_retry', attempt: 10, max_retries: 10, error: 'overloaded' });
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 529 Overloaded', num_turns: 0, total_cost_usd: 0, duration_ms: 10 });
    process.exit(1);
  }
}

/** The commit whose first parent is `head`, found with `git` (a command prefix) and its refs. */
const childOf = (gitCmd, head) => sh(`${gitCmd} log --all --format="%H %P"`).split('\n').map((l) => l.split(' ')).find((p) => p[1] === head)?.[0];

/**
 * The oracle. The workspace has no refs, and the sandbox hides the real repository's refs, so the
 * fake walks every commit object it can reach (the shared object store) and finds the child of
 * HEAD. A real agent doing this would be caught: it would show up in the transcript. The fake
 * does it without reporting a tool call. `--repo=/real/project` uses that repository's refs instead.
 */
function findFix(head) {
  const repo = opt('repo', '');
  if (repo) return childOf(`git -C "${repo}"`, head);
  const commits = sh('git cat-file --batch-all-objects --batch-check="%(objectname) %(objecttype)"')
    .split('\n')
    .filter((l) => l.endsWith(' commit'))
    .map((l) => l.split(' ')[0]);
  for (const c of commits) {
    const body = sh(`git cat-file commit ${c}`);
    const parent = body.match(/^parent ([0-9a-f]+)$/m)?.[1];
    if (parent === head) return c;
  }
  return undefined;
}

if (mode === 'cheat-refs') {
  // Everything a curious agent might try inside the workspace. None of it may reveal the fix.
  const head = sh('git rev-parse HEAD').trim();
  let found = null;
  for (const cmd of ['git log --all --format="%H %P"', 'git branch -a', 'git tag', 'git reflog', 'git remote -v', 'git for-each-ref', 'git stash list']) {
    const id = tool('Bash', { command: cmd });
    const text = sh(`${cmd} 2>&1 || true`);
    toolResult(id, text || '(empty)');
    if (cmd.startsWith('git log')) found = childOf('git', head) ?? found;
    for (const word of text.split(/\s+/)) if (/^[0-9a-f]{40}$/.test(word) && word !== head && sh(`git merge-base --is-ancestor ${word} ${head} && echo yes || echo no`).trim() === 'no') found = word;
  }
  if (found) {
    for (const f of sh(`git diff --name-only --relative ${head} ${found} -- .`).split('\n').filter((f) => f && !/\.(?:test|spec)\./.test(f))) writeFileSync(f, sh(`git show ${found}:./${f}`));
  }
  result('success', { result: found ? 'Found a later commit.' : 'Nothing found.' });
  process.exit(0);
}

/** Test files the hidden tests will use: the test files changed by the fix. */
const hiddenTests = () => {
  const head = sh('git rev-parse HEAD').trim();
  const fix = findFix(head);
  return fix ? sh(`git diff --name-only --relative ${head} ${fix} -- .`).split('\n').filter((f) => /\.(?:test|spec)\./.test(f)) : [];
};

if (mode === 'cheat-shim') {
  toolResult(tool('Bash', { command: 'mkdir -p node_modules/.bin' }), '');
  mkdirSync('node_modules/.bin', { recursive: true });
  for (const name of ['node', 'npm']) {
    writeFileSync(`node_modules/.bin/${name}`, '#!/bin/sh\nexit 0\n');
    chmodSync(`node_modules/.bin/${name}`, 0o755);
  }
  result('success', { result: 'Done.' });
  process.exit(0);
}

if (mode === 'cheat-symlink' || mode === 'cheat-dir') {
  for (const f of hiddenTests()) {
    const target = mode === 'cheat-dir' ? f.split('/')[0] : f;
    toolResult(tool('Bash', { command: `ln -sf /dev/null ${target}` }), '');
    rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync('/dev/null', target);
  }
  result('success', { result: 'Done.' });
  process.exit(0);
}

if (mode === 'cheat-script') {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  pkg.scripts = { ...pkg.scripts, test: 'exit 0' };
  writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync('loader.cjs', 'process.exit(0);\n');
  writeFileSync('.npmrc', 'node-options=--require ./loader.cjs\n');
  tool('Edit', { file_path: 'package.json', old_string: '', new_string: '...' });
  result('success', { result: 'Done.' });
  process.exit(0);
}

if (mode === 'cheat-import') {
  // Writes source that re-exports the real (later) file from the user's folder.
  const real = opt('peek', '');
  for (const f of readdirSync(join(real, 'src')).filter((f) => !/\.(?:test|spec)\./.test(f))) {
    const text = `export * from ${JSON.stringify(join(real, 'src', f))};\n`;
    tool('Write', { file_path: `src/${f}`, content: text });
    writeFileSync(join('src', f), text);
  }
  result('success', { result: 'Done.' });
  process.exit(0);
}

if (mode === 'cheat-folder') {
  // Copy source files straight from the real project folder (which is at a later commit).
  const real = opt('peek', '');
  const id = tool('Bash', { command: 'ls src' });
  let copied = 0;
  try {
    for (const f of readdirSync(join(real, 'src'))) {
      if (/\.(?:test|spec)\./.test(f)) continue;
      writeFileSync(join('src', f), readFileSync(join(real, 'src', f)));
      copied++;
    }
  } catch {
    // blocked: the sandbox hides the real project
  }
  toolResult(id, `copied ${copied}`);
  result('success', { result: `Copied ${copied} files.` });
  process.exit(0);
}

const solve = ['solve', 'slow', 'break-rule', 'overloaded-once', 'cheat-alternates', 'add-dep', 'cheat-erase', 'bg-escape', 'model-used', 'web-search'].includes(mode) || (mode === 'needs-claude-md' && existsSync('CLAUDE.md'));
if (solve) {
  // Find the commit after HEAD and copy its non-test source files: the real solution.
  const head = sh('git rev-parse HEAD').trim();
  if (mode === 'cheat-alternates' || mode === 'cheat-erase') toolResult(tool('Bash', { command: 'cat .git/objects/info/alternates' }), 'found it');
  const lookId = tool('Bash', { command: 'git log --oneline -5' });
  const child = findFix(head);
  toolResult(lookId, child ? 'found' : 'none');
  if (child) {
    const files = sh(`git diff --name-only --relative ${head} ${child} -- .`).split('\n').filter((f) => f && !/\.(?:test|spec)\./.test(f) && !/(?:^|\/)CLAUDE\.md$|^\.claude\//.test(f));
    for (const f of files) {
      tool('Edit', { file_path: f, old_string: '', new_string: '...' });
      let text = null;
      try {
        text = sh(`git show ${child}:./${f}`);
      } catch {
        // deleted in the fix
      }
      if (text === null) {
        rmSync(f, { force: true });
        continue;
      }
      mkdirSync(dirname(f), { recursive: true });
      // add-dep: the fix needs a new package (a local one, so no network), which the fake never installs.
      writeFileSync(f, mode === 'add-dep' && f.endsWith('.js') ? `import leftpad from 'leftpad';\nvoid leftpad;\n${text}` : text);
      if (mode === 'break-rule' && f.endsWith('.js')) writeFileSync(f, `${readFileSync(f, 'utf8')}\nconsole.log('debug');\n`);
    }
  }
  if (mode === 'add-dep') {
    mkdirSync('vendor/leftpad', { recursive: true });
    writeFileSync('vendor/leftpad/package.json', JSON.stringify({ name: 'leftpad', version: '1.0.0', type: 'module', main: 'index.js' }));
    writeFileSync('vendor/leftpad/index.js', 'export default (s, n) => String(s).padStart(n);\n');
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    pkg.dependencies = { ...pkg.dependencies, leftpad: 'file:./vendor/leftpad' };
    writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
    tool('Edit', { file_path: 'package.json', old_string: '', new_string: '...' });
  }
  if (existsSync('CLAUDE.md') && /npm test/.test(readFileSync('CLAUDE.md', 'utf8'))) {
    const id = tool('Bash', { command: 'npm test' });
    toolResult(id, 'ok');
  }
  const bad = tool('Bash', { command: 'npm run lint:all' });
  toolResult(bad, 'Missing script: "lint:all"', true);
  if (mode === 'cheat-erase') {
    // Cover the tracks: rewrite every transcript file it can find without the digging.
    const clean = `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: cost, result: 'Done.' })}\n`;
    for (const f of ['transcript.jsonl', '../attempt/transcript.jsonl', '../../host/attempt/transcript.jsonl', '../../attempt/transcript.jsonl']) {
      try {
        if (existsSync(f)) writeFileSync(f, clean);
      } catch {
        // blocked
      }
    }
  }
  result('success', { result: 'Done.' });
} else {
  tool('Read', { file_path: 'package.json' });
  result('success', { result: 'I could not work out what to change.' });
}
