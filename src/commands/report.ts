import { lstatSync, realpathSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import pc from 'picocolors';
import { UsageError } from '../core/errors.js';
import { renderRunHtml, renderRunMarkdown, renderRunTerminal, runJson } from '../report/run.js';
import { scoreRun } from '../run/score.js';
import { RunStore } from '../run/store.js';
import { applySuggestion, mainSetup, saveTextFile, suggest } from '../run/suggest.js';
import type { RunScore } from '../run/score.js';
import type { RunRecord } from '../run/store.js';

export interface ReportFlags {
  run?: string;
  format: 'terminal' | 'html' | 'markdown' | 'json';
  output?: string;
  failUnder?: number;
}

/** Show a finished (or partial) run again, in any format. */
/** Prints one line of output. */
export type Log = (message: string) => void;

export function reportCommand(dir: string, flags: ReportFlags, write: Log): number {
  const store = RunStore.open(dir, flags.run ?? 'latest');
  const run = store.readRun();
  const attempts = store.readAttempts((m) => process.stderr.write(`${pc.yellow(m)}\n`));
  const score = scoreRun(run, attempts);
  const suggestions = suggest(run, attempts, score, dir);
  const text =
    flags.format === 'html'
      ? renderRunHtml(run, score, attempts, suggestions)
      : flags.format === 'markdown'
        ? renderRunMarkdown(run, score, suggestions)
        : flags.format === 'json'
          ? JSON.stringify(runJson(run, score, attempts, suggestions), null, 2)
          : renderRunTerminal(run, score, suggestions);
  if (flags.output) {
    // A file holds plain text: no colour codes, even when colours are forced on.
    const plain = flags.format === 'terminal' ? stripVTControlCharacters(text) : text;
    // Write through a link to the file it points to; the write is atomic, so a full disk never leaves half a report.
    let target = flags.output;
    if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
      try {
        target = realpathSync(target);
      } catch {
        // a broken link is replaced by the report
      }
    }
    saveTextFile(target, plain.endsWith('\n') ? plain : `${plain}\n`);
    write(pc.green(`Saved the ${flags.format} report to ${flags.output}`));
  } else {
    write(text);
  }
  if (flags.failUnder !== undefined) return failUnder(run, score, flags.failUnder, write);
  return 0;
}

/**
 * --fail-under: judge the main setup, the first one with instruction files (with A = none and
 * B = your files, that is B), and say which one when it is not simply the first.
 */
export function failUnder(run: RunRecord, score: RunScore, limit: number, write: Log): number {
  const label = mainSetup(run.setups)?.label;
  const main = score.setups.find((s) => s.label === label) ?? score.setups[0];
  if (!main) return 0;
  if (main.label !== score.setups[0]?.label) {
    write(
      pc.dim(
        `--fail-under checks setup ${main.label} (${main.source}): it is the first setup with instruction files, and setup ${score.setups[0]!.label} is "${score.setups[0]!.source}".`,
      ),
    );
  }
  if (main.attempts === 0) {
    write(pc.yellow(`Setup ${main.label} has no finished attempts, so --fail-under ${limit} cannot be met.`));
    return 1;
  }
  if (main.score < limit) {
    write(pc.red(`Setup ${main.label} scored ${main.score}, below --fail-under ${limit}.`));
    return 1;
  }
  return 0;
}

export interface SuggestFlags {
  run?: string;
  apply?: string;
  json?: boolean;
}

/** List evidence-based suggestions, or apply one to CLAUDE.md. */
export function suggestCommand(dir: string, flags: SuggestFlags, write: Log): number {
  const store = RunStore.open(dir, flags.run ?? 'latest');
  const run = store.readRun();
  const attempts = store.readAttempts();
  const list = suggest(run, attempts, scoreRun(run, attempts), dir);

  if (flags.apply) {
    const s = list.find((x) => x.id === flags.apply);
    if (!s)
      throw new UsageError(
        `No suggestion "${flags.apply}" in run ${run.id}.`,
        list.length ? [`Suggestions: ${list.map((x) => x.id).join(', ')}`] : ['This run has no suggestions.'],
      );
    const file = applySuggestion(dir, s);
    write(pc.green(`✔ Added to ${file}:`));
    write(pc.dim(s.append!.trim()));
    write('');
    write(`Prove it helps: ${pc.cyan('npx setupscore run --setup-a HEAD --setup-b working --repeat 3')}`);
    write(pc.dim('  (A = your last commit, B = your files with this change)'));
    return 0;
  }

  if (flags.json) {
    write(JSON.stringify({ schemaVersion: 1, run: run.id, suggestions: list }, null, 2));
    return 0;
  }
  if (!list.length) {
    write(pc.green(`No suggestions for run ${run.id}: nothing in the results points to a change.`));
    return 0;
  }
  write(`${pc.bold('Suggestions')} ${pc.dim(`from run ${run.id}`)}`);
  write('');
  list.forEach((s, i) => {
    write(`${i + 1}. ${pc.bold(s.title)}  ${pc.dim(s.id)}`);
    write(`   ${s.evidence}`);
    write(`   ${pc.dim('→')} ${s.action}`);
    if (s.applied) write(`   ${pc.green('✔ Already added to CLAUDE.md.')}`);
    else if (s.append) write(`   ${pc.dim('Apply with:')} ${pc.cyan(`npx setupscore suggest --apply ${s.id}`)}`);
    write('');
  });
  return 0;
}
