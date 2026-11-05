import pc from 'picocolors';
import type { Config } from '../core/config.js';
import { UsageError } from '../core/errors.js';
import { runJson } from '../report/run.js';
import { scoreRun } from '../run/score.js';
import { RunStore } from '../run/store.js';
import { suggest } from '../run/suggest.js';
import { EnvironmentError } from '../sandbox/types.js';
import { gitWithInput } from '../tasks/git.js';
import { startRun, type Log, type RunFlags } from './run.js';

export interface WatchFlags extends Omit<RunFlags, 'setupA' | 'setupB' | 'baseline' | 'resume' | 'tasks' | 'model'> {
  model: string;
  run?: string;
}

const pctOf = (x: number) => `${Math.round(x * 100)}%`;

/** Commits (of the given ones) that this repository no longer has, for example after a rebase or force-push. */
async function missingCommits(dir: string, hashes: string[]): Promise<Set<string>> {
  const unique = [...new Set(hashes)];
  let out: string;
  try {
    out = await gitWithInput(dir, ['cat-file', '--batch-check'], unique.map((h) => `${h}^{commit}\n`).join(''));
  } catch {
    return new Set(); // git itself failed: the run reports it with a clearer message
  }
  const lines = out.split('\n');
  return new Set(unique.filter((_, i) => !/^[0-9a-f]+ commit \d+$/.test(lines[i] ?? '')));
}

/**
 * `setupscore watch --model <id>`: run the same tasks and setups as an earlier run with a new
 * model, then show what got better or worse. Use it before switching models.
 */
export async function watchCommand(
  dir: string,
  flags: WatchFlags,
  config: Config,
  log: Log,
  write: Log = (t) => process.stdout.write(t.endsWith('\n') ? t : `${t}\n`),
): Promise<number> {
  const refStore = RunStore.open(dir, flags.run ?? 'latest');
  const ref = refStore.readRun();
  const refAttempts = refStore.readAttempts();
  const refScore = scoreRun(ref, refAttempts);
  if (!refAttempts.some((a) => a.status === 'passed' || a.status === 'failed')) {
    throw new UsageError(`Run ${ref.id} has no finished attempts to compare with.`, [
      'Finish it first: npx setupscore run --resume ' + ref.id,
    ]);
  }
  if ((ref.options.model ?? 'default') === flags.model) {
    throw new UsageError(`Run ${ref.id} already used model ${flags.model}.`, [
      'Pick a different model, or compare with another run: --run <id>',
    ]);
  }
  // The tasks are commits from the history at the time of that run. After a rebase or force-push
  // they may be gone, and nothing could be compared.
  const missing = await missingCommits(
    dir,
    ref.tasks.flatMap((t) => [t.hash, t.parent]),
  );
  if (missing.size) {
    const gone = ref.tasks.filter((t) => missing.has(t.hash) || missing.has(t.parent));
    throw new UsageError(
      `${gone.length === ref.tasks.length ? 'All' : `${gone.length} of`} ${ref.tasks.length} task${ref.tasks.length === 1 ? '' : 's'} in run ${ref.id} use commits that are no longer in this repository (${gone
        .slice(0, 3)
        .map((t) => t.id)
        .join(', ')}${gone.length > 3 ? ', …' : ''}), so the run cannot be repeated with another model.`,
      [
        'The history was probably rewritten (rebase, squash or force-push). Start a new run on the current history, then watch against it:',
        '  npx setupscore tasks && npx setupscore run',
        `  npx setupscore watch --model ${flags.model}`,
      ],
    );
  }
  log(
    pc.dim(
      `Comparing with run ${ref.id} (model ${ref.options.model ?? 'default'}): same ${ref.tasks.length} task${ref.tasks.length === 1 ? '' : 's'} and ${ref.setups.length} setup${ref.setups.length === 1 ? '' : 's'}, model ${flags.model}.`,
    ),
  );

  // With --json, the results go to stdout even when the run stops early.
  let partialJson: string | undefined;
  let result;
  try {
    result = await startRun({
      dir,
      config,
      log,
      flags: {
        ...flags,
        setupA: 'working',
        repeat: flags.repeat || ref.options.repeat,
        model: flags.model,
        failUnder: flags.failUnder,
      },
      reuse: {
        tasks: ref.tasks,
        setups: ref.setups.map(({ label, source, files, executable }) => ({
          label,
          source,
          files,
          ...(executable ? { executable } : {}),
        })),
        comparedTo: ref.id,
      },
      emitJson: (text) => (partialJson = text),
    });
  } catch (err) {
    if (flags.json && partialJson) write(partialJson);
    throw err;
  }

  const before = ref.options.model ?? 'default';
  const setups = [];
  log('');
  log(pc.bold(`Model ${before} → ${flags.model}`));
  for (const now of result.score.setups) {
    const old = refScore.setups.find((s) => s.label === now.label);
    if (!old) continue;
    if (!now.attempts || !old.attempts) {
      log(
        `  Setup ${now.label}: ${!now.attempts ? `no finished attempts with ${flags.model}` : `no finished attempts in run ${ref.id}`}, so it cannot be compared.`,
      );
      setups.push({
        label: now.label,
        compared: false,
        scoreBefore: old.attempts ? old.score : null,
        scoreAfter: now.attempts ? now.score : null,
      });
      continue;
    }
    const delta = now.score - old.score;
    const d = delta > 0 ? pc.green(`+${delta}`) : delta < 0 ? pc.red(String(delta)) : pc.dim('±0');
    log(
      `  Setup ${now.label}: score ${old.score} → ${now.score} (${d}), success ${pctOf(old.successRate)} → ${pctOf(now.successRate)}, median cost $${old.costMedian.toFixed(3)} → $${now.costMedian.toFixed(3)}`,
    );
    setups.push({
      label: now.label,
      compared: true,
      scoreBefore: old.score,
      scoreAfter: now.score,
      successBefore: old.successRate,
      successAfter: now.successRate,
      costMedianBefore: old.costMedian,
      costMedianAfter: now.costMedian,
    });
  }

  const worse: { taskId: string; setup: string; title: string }[] = [];
  let compared = 0;
  let notCompared = 0;
  for (const t of result.score.tasks) {
    const old = refScore.tasks.find((x) => x.id === t.id);
    if (!old) continue;
    for (const [label, r] of Object.entries(t.results)) {
      const o = old.results[label];
      if (!o?.attempts || !r.attempts) {
        notCompared++;
        continue;
      }
      compared++;
      if (o.passed / o.attempts >= 0.5 && r.passed / r.attempts < 0.5)
        worse.push({ taskId: t.id, setup: label, title: t.title });
    }
  }
  // Nothing finished with the new model (the API was down, say): that is not "nothing got worse".
  if (compared === 0) {
    if (flags.json)
      write(
        JSON.stringify(
          {
            ...runJson(
              result.run,
              result.score,
              result.attempts,
              suggest(result.run, result.attempts, result.score, dir),
            ),
            watch: { comparedTo: ref.id, modelBefore: before, modelAfter: flags.model, compared: 0, setups, worse },
          },
          null,
          2,
        ),
      );
    const reason = result.score.setups.find((s) => s.infraReason)?.infraReason;
    throw new EnvironmentError(
      `No task could be compared: no attempt with ${flags.model} finished${reason ? ` (${reason})` : ''}.`,
      [
        `Nothing is known yet about ${flags.model}. Fix the problem, then try the same attempts again:`,
        `  npx setupscore run --resume ${result.run.id}`,
      ],
    );
  }
  if (worse.length) {
    log(pc.yellow(`  Got worse on ${worse.length} task${worse.length === 1 ? '' : 's'}:`));
    for (const w of worse.slice(0, 10)) log(`    ${w.taskId} (setup ${w.setup}) ${w.title}`);
  } else {
    log(
      pc.green(
        `  No task got worse${notCompared ? ` among the ${compared} compared (${notCompared} could not be compared: no attempt finished)` : ''}.`,
      ),
    );
  }
  if (flags.json) {
    write(
      JSON.stringify(
        {
          ...runJson(
            result.run,
            result.score,
            result.attempts,
            suggest(result.run, result.attempts, result.score, dir),
          ),
          watch: { comparedTo: ref.id, modelBefore: before, modelAfter: flags.model, compared, setups, worse },
        },
        null,
        2,
      ),
    );
  }
  return result.exitCode;
}
