import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { UsageError } from '../core/errors.js';
import { writeFileAtomic } from '../core/fsx.js';
import { EnvironmentError } from '../sandbox/types.js';
import { detectPm } from '../tasks/pm.js';
import type { RunScore } from './score.js';
import type { Attempt, RunRecord } from './store.js';

/**
 * Suggestions come only from evidence in the run, never from guessing: each one says what
 * happened, how often, and what to change. Some can be applied with `setupscore suggest --apply <id>`,
 * then proven with a new run that compares the old and new setup.
 */
export interface Suggestion {
  id: string;
  title: string;
  evidence: string;
  action: string;
  /** Text appended to CLAUDE.md by --apply. Absent when the change needs a person. */
  append?: string;
  /** True when CLAUDE.md in the project already has the text (it was applied). */
  applied?: boolean;
}

const pct = (a: number, b: number) => `${a} of ${b}`;
const scored = (a: Attempt) => a.status === 'passed' || a.status === 'failed';

/**
 * The setup a run is judged by (suggestions, --fail-under): the first one with instruction files,
 * so a run with A = none and B = your files is judged by B. Falls back to the first setup.
 */
export function mainSetup<T extends { label: string; source: string; files?: Record<string, string> }>(
  setups: T[],
): T | undefined {
  return (
    setups.find((s) => s.source !== 'none' && Object.keys(s.files ?? {}).length > 0) ??
    setups.find((s) => s.source !== 'none') ??
    setups[0]
  );
}

/** Suggestions for the main setup (the first one with instruction files, usually A). */
export function suggest(run: RunRecord, attempts: Attempt[], score: RunScore, projectDir: string): Suggestion[] {
  const out = suggestFor(run, attempts, score, projectDir);
  // A suggestion already added to CLAUDE.md is not offered again.
  const current = out.some((s) => s.append) ? currentInstructions(projectDir) : null;
  if (current !== null) for (const s of out) if (s.append && current.includes(s.append.trim())) s.applied = true;
  return out;
}

function suggestFor(run: RunRecord, attempts: Attempt[], score: RunScore, projectDir: string): Suggestion[] {
  const setup = mainSetup(run.setups);
  if (!setup) return [];
  const mine = attempts.filter((a) => a.setup === setup.label && scored(a));
  const total = mine.length;
  const out: Suggestion[] = [];
  const claudeMd = Object.entries(setup.files).find(([p]) => p === 'CLAUDE.md' || p === '.claude/CLAUDE.md')?.[1] ?? '';

  // 1. The setup has problems the linter can see.
  if (setup.lintErrors > 0) {
    out.push({
      id: 'fix-check',
      title: `Fix the ${setup.lintErrors} error${setup.lintErrors === 1 ? '' : 's'} that "setupscore check" finds`,
      evidence: `Instruction health is ${setup.health}/10.`,
      action: 'Run "npx setupscore check" and fix what it reports. Broken paths that moved can be fixed with --fix.',
    });
  }

  if (total === 0) return out;

  // 2. Claude often finishes without running the tests.
  const skipped = mine.filter((a) => a.checks && !a.checks.ranTests).length;
  if (skipped >= Math.max(2, total * 0.4)) {
    const pm = detectPm(projectDir);
    const cmd = 'error' in pm ? 'npm test' : pm.name === 'npm' ? 'npm test' : `${pm.name} test`;
    // eslint-disable-next-line security/detect-non-literal-regexp -- cmd is "npm test", "pnpm test", "yarn test" or "bun test"
    const mentions = new RegExp(`\\b${cmd.replace(/\s+/g, '\\s+')}\\b`).test(claudeMd);
    out.push({
      id: 'run-tests',
      title: 'Tell Claude to run the tests before it finishes',
      evidence: `Claude did not run the tests in ${pct(skipped, total)} attempts.${mentions ? ' CLAUDE.md mentions the command, but not as a step to always do.' : ''}`,
      action: `Add a short "Before you finish" section to CLAUDE.md that says to run \`${cmd}\` and fix failures.`,
      append: `\n## Before you finish\n- Run \`${cmd}\` and make sure it passes. Fix any failing test before you stop.\n`,
    });
  }

  // 3. Rules that keep getting broken.
  const breaks = new Map<string, { rule: string; count: number }>();
  for (const a of mine)
    for (const v of a.checks?.ruleViolations ?? [])
      breaks.set(v.token, { rule: v.rule, count: (breaks.get(v.token)?.count ?? 0) + 1 });
  for (const [token, { rule, count }] of breaks) {
    if (count < 2) continue;
    out.push({
      id: `rule-${token.replace(/[^\w]+/g, '-').toLowerCase()}`,
      title: `Make the rule about \`${token}\` stick`,
      evidence: `"${rule}" was broken in ${pct(count, total)} attempts.`,
      action:
        'Say why the rule exists and what to use instead, move it near the top of CLAUDE.md, and enforce it with a lint rule or a hook so it cannot be missed.',
    });
  }

  // 4. Commands in the instructions that fail.
  const failed = new Map<string, number>();
  for (const a of mine) {
    // Count attempts, not commands: one attempt may run the same failing script many times.
    const scripts = new Set<string>();
    for (const c of a.metrics?.failedCommands ?? []) {
      const m = typeof c === 'string' ? c.match(/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[\w:.-]+/) : null;
      if (m) scripts.add(m[0].replace(/\s+/g, ' '));
    }
    for (const cmd of scripts) failed.set(cmd, (failed.get(cmd) ?? 0) + 1);
  }
  for (const [cmd, count] of failed) {
    if (count < 2 || !claudeMd.includes(cmd)) continue;
    out.push({
      id: `command-${cmd.replace(/[^\w]+/g, '-').toLowerCase()}`,
      title: `Fix the command "${cmd}" in CLAUDE.md`,
      evidence: `It failed in ${pct(count, total)} attempts.`,
      action: 'Check that the script exists and works on a fresh clone, then update CLAUDE.md.',
    });
  }

  // 5. Claude edits its own instructions.
  const touched = mine.filter((a) => a.checks?.touchedSetup).length;
  if (touched > 0) {
    out.push({
      id: 'protect-setup',
      title: 'Stop Claude from editing its own instructions',
      evidence: `Claude changed CLAUDE.md or .claude/ in ${pct(touched, total)} attempts.`,
      action: 'Add a rule, or deny Edit on those files in .claude/settings.json.',
      append: '\n- Do not edit CLAUDE.md or files in .claude/ unless you are asked to.\n',
    });
  }

  // 6. Skills that are never used.
  const used = new Set(mine.flatMap((a) => a.metrics?.skillsUsed ?? []));
  const skills = Object.keys(setup.files)
    .map((p) => p.match(/(?:^|\/)\.claude\/skills\/([^/]+)\/SKILL\.md$/)?.[1])
    .filter((s): s is string => !!s);
  const unused = skills.filter((s) => !used.has(s));
  if (skills.length && unused.length && total >= 4) {
    out.push({
      id: 'unused-skills',
      title: `Rewrite the description of ${unused.length === 1 ? 'a skill Claude never uses' : `${unused.length} skills Claude never uses`}`,
      evidence: `${unused.map((s) => `"${s}"`).join(', ')} ${unused.length === 1 ? 'was' : 'were'} not used in any of ${total} attempts.`,
      action:
        'Claude picks skills by their description. Write it as "<What it does>. Use when <situation>." If the skill is not needed for these tasks, that is fine.',
    });
  }

  // 7. Running out of turns.
  const outOfTurns = mine.filter((a) => a.metrics?.outcome === 'max_turns').length;
  if (outOfTurns >= Math.max(2, total * 0.3)) {
    out.push({
      id: 'turns',
      title: 'Help Claude find its way around faster',
      evidence: `Claude hit the turn limit (${run.options.maxTurns}) in ${pct(outOfTurns, total)} attempts.`,
      action:
        'Add a short "Where things are" section to CLAUDE.md (main folders and what is in them), or allow more turns with --max-turns.',
    });
  }

  // 8. Worse than no instructions.
  const s = score.setups.find((x) => x.label === setup.label);
  if (s?.liftPoints !== undefined && s.liftPoints <= -10) {
    out.push({
      id: 'negative-lift',
      title: 'Your instructions make Claude worse on these tasks',
      evidence: `Setup ${setup.label} passed ${s.liftPoints} points less than Claude with no instructions.`,
      action:
        'Look for rules that are outdated or conflict with how the code is written now. Run "setupscore check" and remove rules you are not sure about, then run again.',
    });
  }

  // 9. Heavy start-up context.
  if (setup.startupTokens > 5000) {
    out.push({
      id: 'trim',
      title: 'Trim what loads into every session',
      evidence: `About ${setup.startupTokens.toLocaleString('en-US')} tokens load before Claude reads your request.`,
      action:
        'Move rules for some folders into .claude/rules/ with "paths:", and long procedures into skills. See "setupscore check --cost".',
    });
  }
  return out;
}

/** The file --apply writes to: CLAUDE.md, or .claude/CLAUDE.md when only that one exists. */
function instructionsFile(projectDir: string): string {
  const root = join(projectDir, 'CLAUDE.md');
  const nested = join(projectDir, '.claude', 'CLAUDE.md');
  try {
    return !lstatSync(root, { throwIfNoEntry: false }) && statSync(nested, { throwIfNoEntry: false })?.isFile()
      ? nested
      : root;
  } catch {
    return root; // .claude is not a folder
  }
}

/** CLAUDE.md as it is now (line endings as \n), or null when it is missing or not a readable file. */
function currentInstructions(projectDir: string): string | null {
  try {
    const file = instructionsFile(projectDir);
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return null;
    return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
}

/** Remove trailing white space with a plain loop: a regex such as /\s*$/ takes minutes on a long line of spaces. */
export function trimEnd(text: string): string {
  let end = text.length;
  while (end > 0 && /\s/.test(text[end - 1]!)) end--;
  return text.slice(0, end);
}

/**
 * Save a file the user asked for (a report, CLAUDE.md) so it is never left half-written: on a full
 * disk or without permission the original stays as it was, and the message says so (exit code 3).
 */
export function saveTextFile(file: string, text: string, mode?: number): void {
  try {
    writeFileAtomic(file, text, mode);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const kept = 'The file was left as it was.';
    if (e.code === 'ENOSPC' || e.code === 'EDQUOT')
      throw new EnvironmentError(`The disk is full, so ${file} could not be saved. ${kept}`, [
        'Free some space and try again.',
      ]);
    if (e.code === 'EROFS')
      throw new EnvironmentError(`${file} is on a read-only file system, so it could not be saved. ${kept}`, [
        'Save it somewhere writable instead.',
      ]);
    if (e.code === 'EACCES' || e.code === 'EPERM')
      throw new EnvironmentError(`No permission to write ${file}. ${kept}`, [
        'Check the permissions of the file and its folder, and do not run setupscore with sudo.',
      ]);
    if (e.code === 'ENOENT')
      throw new UsageError(`Cannot write ${file}: the folder does not exist.`, [
        'Create the folder first, or choose another path.',
      ]);
    if (e.code === 'EISDIR' || e.code === 'ENOTDIR')
      throw new UsageError(
        `Cannot write ${file}: ${e.code === 'EISDIR' ? 'it is a folder' : 'part of the path is a file, not a folder'}.`,
        ['Choose a file path instead.'],
      );
    if (e.code)
      throw new EnvironmentError(`Cannot write ${file}: ${e.message}. ${kept}`, [
        'Check the disk and the folder, then try again.',
      ]);
    throw err;
  }
}

/** Apply a suggestion that has a ready text: append it to CLAUDE.md in the project. */
export function applySuggestion(projectDir: string, s: Suggestion): string {
  if (!s.append)
    throw new UsageError(
      `Suggestion "${s.id}" needs a person to make the change; it cannot be applied automatically.`,
      [s.action],
    );
  const file = instructionsFile(projectDir);
  // CLAUDE.md is often a link (to AGENTS.md): change the file it points to and keep the link.
  let target = file;
  const link = lstatSync(file, { throwIfNoEntry: false });
  if (link?.isSymbolicLink()) {
    try {
      target = realpathSync(file);
    } catch {
      target = resolve(dirname(file), readlinkSync(file)); // a link to a file that does not exist yet
    }
  }
  const st = statSync(target, { throwIfNoEntry: false });
  if (st && !st.isFile()) {
    throw new UsageError(
      `${file} is not a file (it is a folder or something else), so the suggestion cannot be added to it.`,
      [
        'Add this to your instructions by hand:',
        ...s.append
          .trim()
          .split('\n')
          .map((l) => `  ${l}`),
      ],
    );
  }
  let before = '# Project instructions\n';
  if (st) {
    try {
      before = readFileSync(target, 'utf8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'EACCES' || e.code === 'EPERM')
        throw new EnvironmentError(`No permission to read ${file}. It was left as it was.`, [
          'Check the permissions of the file, and do not run setupscore with sudo.',
        ]);
      if (e.code !== 'ENOENT') throw err; // ENOENT: deleted a moment ago, so start a new one
    }
  }
  if (before.replace(/\r\n/g, '\n').includes(s.append.trim()))
    throw new UsageError(`Suggestion "${s.id}" is already in ${file}.`);
  // Keep the file's line endings: Windows files use CRLF.
  const added = `\n${s.append}`;
  saveTextFile(
    target,
    `${trimEnd(before)}${before.includes('\r\n') ? added.replace(/\n/g, '\r\n') : added}`,
    st ? st.mode & 0o777 : undefined,
  );
  return file;
}
