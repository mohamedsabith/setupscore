import { forbiddenRules } from './checks.js';
import type { Attempt, RunRecord, SetupRecord } from './store.js';

/**
 * Setup Score, 0 to 100, from five parts. A part that cannot be measured in a run (for example
 * consistency with one repeat) is left out and the others are scaled up, so scores stay comparable.
 *   Task success      40  hidden tests pass after the agent's change
 *   Rule following    20  the agent's new code keeps the setup's "never use X" rules
 *   Consistency       15  a task that passes once passes on every repeat
 *   Efficiency        15  cost per solved task compared with the cheapest setup in the run
 *   Instruction health 10 from setupscore check (not measured for a setup with no files)
 * Every part except health rewards solved tasks, and a setup that solves nothing scores 0.
 */
const WEIGHTS = { success: 40, rules: 20, consistency: 15, efficiency: 15, health: 10 } as const;

interface ScorePart {
  name: keyof typeof WEIGHTS;
  max: number;
  earned: number;
  /** False when the run cannot measure it; it is then left out of the score. */
  measured: boolean;
  note: string;
}

export interface SetupScore {
  label: string;
  source: string;
  /** Scored attempts: infra errors and cancelled ones are left out. */
  attempts: number;
  passed: number;
  successRate: number;
  /** 95% confidence range for the success rate (Wilson). */
  range: [number, number];
  score: number;
  parts: ScorePart[];
  costTotal: number;
  costMedian: number;
  /** Total cost of scored attempts divided by passed attempts; 0 when nothing passed. */
  costPerSolved: number;
  turnsMedian: number;
  durationMedianMs: number;
  ruleBreaks: number;
  ranTestsRate: number;
  skillsUsed: Record<string, number>;
  /** Success rate minus the baseline's, in percentage points. */
  liftPoints?: number;
  infraErrors: number;
  /** The most common reason among the attempts that could not run. */
  infraReason?: string;
}

export interface RunScore {
  setups: SetupScore[];
  verdict: string;
  winner?: string;
  /** Per task: label -> passed/attempts. */
  tasks: { id: string; title: string; results: Record<string, { passed: number; attempts: number }> }[];
  complete: boolean;
}

export function wilson(passed: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = passed / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const pct = (x: number) => `${Math.round(x * 100)}%`;
const scored = (a: Attempt) => a.status === 'passed' || a.status === 'failed';

export function scoreRun(run: RunRecord, attempts: Attempt[]): RunScore {
  const bySetup = new Map<string, Attempt[]>();
  for (const s of run.setups) bySetup.set(s.label, []);
  for (const a of attempts) bySetup.get(a.setup)?.push(a);

  // Efficiency compares cost per solved task. It needs at least two setups with measured costs.
  const withCost = run.setups.filter((s) =>
    (bySetup.get(s.label) ?? []).some((a) => scored(a) && (a.metrics?.costUsd ?? 0) > 0),
  );
  const perSolved = withCost.map((s) => costPerSolved(bySetup.get(s.label) ?? [])).filter((c) => c > 0);
  const cheapest = perSolved.length ? Math.min(...perSolved) : 0;

  const setups = run.setups.map((s) => scoreSetup(s, bySetup.get(s.label) ?? [], cheapest, withCost.length >= 2));
  const baseline = setups.find((s) => run.setups.find((r) => r.label === s.label)?.source === 'none');
  if (baseline && baseline.attempts > 0)
    for (const s of setups)
      if (s !== baseline && s.attempts > 0) s.liftPoints = Math.round((s.successRate - baseline.successRate) * 100);

  const tasks = run.tasks.map((t) => {
    const results: Record<string, { passed: number; attempts: number }> = {};
    for (const s of run.setups) {
      const list = (bySetup.get(s.label) ?? []).filter((a) => a.taskId === t.id && scored(a));
      results[s.label] = { passed: list.filter((a) => a.status === 'passed').length, attempts: list.length };
    }
    return { id: t.id, title: t.title, results };
  });

  const planned = run.tasks.length * run.setups.length * run.options.repeat;
  const complete = attempts.filter(scored).length >= planned;
  const { verdict, winner } = decide(setups, run);
  return { setups, verdict, winner, tasks, complete };
}

function mostCommon(xs: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function costPerSolved(list: Attempt[]): number {
  const done = list.filter(scored);
  const passed = done.filter((a) => a.status === 'passed').length;
  const cost = done.reduce((t, a) => t + (a.metrics?.costUsd ?? 0), 0);
  return passed && cost > 0 ? cost / passed : 0;
}

function scoreSetup(s: SetupRecord, list: Attempt[], cheapest: number, compareCost: boolean): SetupScore {
  const done = list.filter(scored);
  const passed = done.filter((a) => a.status === 'passed').length;
  const n = done.length;
  const successRate = n ? passed / n : 0;

  // Rule following is only measured when the setup has checkable "never use X" rules.
  const hasRules = forbiddenRules(s.files).length > 0;
  const withForbidden = done.filter((a) => a.checks);
  const breaks = withForbidden.filter((a) => (a.checks?.ruleViolations.length ?? 0) > 0).length;
  const solvedChecked = withForbidden.filter((a) => a.status === 'passed');
  const solvedBreaks = solvedChecked.filter((a) => (a.checks?.ruleViolations.length ?? 0) > 0).length;

  const byTask = new Map<string, Attempt[]>();
  for (const a of done) {
    const list = byTask.get(a.taskId);
    if (list) list.push(a);
    else byTask.set(a.taskId, [a]);
  }
  // Consistency: of the tasks this setup solved at least once, how many it solved every time.
  const repeated = [...byTask.values()].filter((l) => l.length >= 2);
  const solvedOnce = repeated.filter((l) => l.some((a) => a.status === 'passed'));
  const solvedAlways = solvedOnce.filter((l) => l.every((a) => a.status === 'passed')).length;

  const costMedian = median(done.map((a) => a.metrics?.costUsd ?? 0).filter((c) => c > 0));
  const perSolved = costPerSolved(list);
  const hasFiles = Object.keys(s.files ?? {}).length > 0;
  const parts: ScorePart[] = [
    {
      name: 'success',
      max: WEIGHTS.success,
      earned: WEIGHTS.success * successRate,
      measured: n > 0,
      note: `${passed} of ${n} attempt${n === 1 ? '' : 's'} passed`,
    },
    {
      name: 'rules',
      max: WEIGHTS.rules,
      // Only solved attempts count: keeping a rule while solving nothing earns nothing.
      earned: solvedChecked.length ? WEIGHTS.rules * (1 - solvedBreaks / solvedChecked.length) : 0,
      measured: hasRules && withForbidden.length > 0,
      note: !hasRules
        ? 'no checkable "never use X" rules'
        : solvedChecked.length
          ? `${solvedBreaks} of ${solvedChecked.length} solved attempt${solvedChecked.length === 1 ? '' : 's'} broke a rule`
          : 'no attempt was solved',
    },
    {
      name: 'consistency',
      max: WEIGHTS.consistency,
      earned: solvedOnce.length ? (WEIGHTS.consistency * solvedAlways) / solvedOnce.length : 0,
      measured: repeated.length > 0,
      note: !repeated.length
        ? 'needs --repeat 2 or more'
        : solvedOnce.length
          ? `${solvedAlways} of ${solvedOnce.length} solved tasks passed on every try`
          : 'no task was solved, so there is nothing to repeat',
    },
    {
      name: 'efficiency',
      max: WEIGHTS.efficiency,
      earned: compareCost && perSolved > 0 && cheapest > 0 ? WEIGHTS.efficiency * Math.min(1, cheapest / perSolved) : 0,
      measured: compareCost,
      note: !compareCost
        ? 'needs two setups to compare'
        : perSolved > 0
          ? `$${perSolved.toFixed(3)} per solved task`
          : 'no task was solved',
    },
    {
      name: 'health',
      max: WEIGHTS.health,
      earned: s.health,
      measured: hasFiles,
      note: hasFiles
        ? `${s.lintErrors} error${s.lintErrors === 1 ? '' : 's'}, ${s.lintWarnings} warning${s.lintWarnings === 1 ? '' : 's'} from setupscore check`
        : 'no setup files to check',
    },
  ];
  const available = parts.filter((p) => p.measured).reduce((t, p) => t + p.max, 0);
  const earned = parts.filter((p) => p.measured).reduce((t, p) => t + p.earned, 0);

  const skillsUsed: Record<string, number> = {};
  for (const a of done) for (const sk of a.metrics?.skillsUsed ?? []) skillsUsed[sk] = (skillsUsed[sk] ?? 0) + 1;

  return {
    label: s.label,
    source: s.source,
    attempts: n,
    passed,
    successRate,
    range: wilson(passed, n),
    // Nothing solved (or nothing measured) scores 0: instruction health alone is not a Setup Score.
    score: passed > 0 && available ? Math.round((earned / available) * 100) : 0,
    parts,
    costTotal: list.reduce((t, a) => t + (a.metrics?.costUsd ?? 0), 0),
    costMedian,
    costPerSolved: perSolved,
    turnsMedian: median(done.map((a) => a.metrics?.turns ?? 0)),
    durationMedianMs: median(done.map((a) => a.ms)),
    ruleBreaks: breaks,
    ranTestsRate: n ? done.filter((a) => a.checks?.ranTests).length / n : 0,
    skillsUsed,
    infraErrors: list.filter((a) => a.status === 'error').length,
    infraReason: mostCommon(list.filter((a) => a.status === 'error').map((a) => a.reason ?? 'unknown')),
  };
}

/** Plain-English verdict. A winner is named only when the confidence ranges do not overlap. */
function decide(setups: SetupScore[], run: RunRecord): { verdict: string; winner?: string } {
  const measured = setups.filter((s) => s.attempts > 0);
  if (!measured.length) return { verdict: 'No attempts finished, so there is nothing to compare yet.' };
  const real = measured.filter((s) => run.setups.find((r) => r.label === s.label)?.source !== 'none');
  if (measured.length === 1 || real.length === 1) {
    const s = real[0] ?? measured[0]!;
    const base = measured.find((m) => m !== s && run.setups.find((r) => r.label === m.label)?.source === 'none');
    let lift = '';
    if (base && s.liftPoints !== undefined) {
      const sign = s.liftPoints >= 0 ? '+' : '';
      if (s.range[0] > base.range[1])
        lift = ` That is ${sign}${s.liftPoints} points over no instructions, and the ranges do not overlap: your setup clearly helps.`;
      else if (s.range[1] < base.range[0])
        lift = ` That is ${Math.abs(s.liftPoints)} points below no instructions, and the ranges do not overlap: your setup is getting in Claude's way.`;
      else
        lift = ` That is ${sign}${s.liftPoints} points compared with no instructions, but the ranges overlap, so the difference could still be chance. Add repeats (--repeat 5) or tasks to be sure.`;
    }
    return {
      verdict: `Setup ${s.label} passed ${pct(s.successRate)} of attempts (likely between ${pct(s.range[0])} and ${pct(s.range[1])}).${lift}`,
    };
  }
  const sorted = [...real].sort((a, b) => b.successRate - a.successRate || b.score - a.score);
  const [best, second] = sorted as [SetupScore, SetupScore];
  if (best.range[0] > second.range[1]) {
    return {
      verdict: `Setup ${best.label} is better: ${pct(best.successRate)} vs ${pct(second.successRate)} success, and the ranges do not overlap.`,
      winner: best.label,
    };
  }
  const gap = Math.abs(best.successRate - second.successRate);
  return {
    verdict:
      gap === 0
        ? `No difference yet: setups ${best.label} and ${second.label} both passed ${pct(best.successRate)}. Add repeats (--repeat 5) or tasks to see a smaller difference.`
        : `Setup ${best.label} looks better (${pct(best.successRate)} vs ${pct(second.successRate)}), but the difference could still be chance. Add repeats (--repeat 5) or tasks to be sure.`,
  };
}
