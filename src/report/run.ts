import pc from 'picocolors';
import type { RunScore, SetupScore } from '../run/score.js';
import type { Attempt, RunRecord } from '../run/store.js';
import type { Suggestion } from '../run/suggest.js';
import { VERSION } from '../version.js';

export const RUN_REPORT_SCHEMA_VERSION = 1;

const pct = (x: number) => `${Math.round(x * 100)}%`;
const money = (x: number) => `$${x < 0.1 && x > 0 ? x.toFixed(3) : x.toFixed(2)}`;
const secs = (ms: number) =>
  ms >= 60_000
    ? `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`
    : `${Math.round(ms / 1000)}s`;
const totalCost = (s: RunScore) => s.setups.reduce((t, x) => t + x.costTotal, 0);

function headline(run: RunRecord): string {
  return `${run.tasks.length} task${run.tasks.length === 1 ? '' : 's'} × ${run.setups.length} setup${run.setups.length === 1 ? '' : 's'} × ${run.options.repeat} repeat${run.options.repeat === 1 ? '' : 's'}${run.options.model ? ` · model ${run.options.model}` : ''}`;
}

const lift = (s: SetupScore) =>
  s.liftPoints === undefined ? '' : `${s.liftPoints >= 0 ? '+' : ''}${s.liftPoints} pts`;

function partialReason(run: RunRecord, score: RunScore): string {
  if (run.status === 'running') return 'the run is still going';
  if (run.status !== 'completed')
    return `the run ${run.status}${run.stopReason ? ` (${run.stopReason})` : ''}; continue it with: npx setupscore run --resume ${run.id}`;
  const infra = score.setups.reduce((t, s) => t + s.infraErrors, 0);
  return `${infra || 'some'} attempt${infra === 1 ? '' : 's'} could not run (see below)`;
}

/** What the user sees at the end of a run and from `setupscore report`. */
export function renderRunTerminal(
  run: RunRecord,
  score: RunScore,
  suggestions: Suggestion[],
  paths: { html?: string } = {},
): string {
  const out: string[] = [];
  out.push(`${pc.bold('setupscore run')} ${pc.dim(`${run.id} · ${headline(run)} · ${money(totalCost(score))} spent`)}`);
  if (!score.complete) out.push(pc.yellow(`Partial results: ${partialReason(run, score)}.`));
  out.push('');

  const rows = score.setups.map((s) => [
    `${s.label}`,
    s.source.length > 24 ? `${s.source.slice(0, 23)}…` : s.source,
    s.attempts ? String(s.score) : '-',
    s.attempts ? `${pct(s.successRate)} (${pct(s.range[0])}–${pct(s.range[1])})` : 'no results',
    s.costMedian ? money(s.costMedian) : '-',
    s.attempts ? String(Math.round(s.turnsMedian)) : '-',
    s.attempts ? String(s.ruleBreaks) : '-',
    lift(s),
  ]);
  const head = ['Setup', 'Source', 'Score', 'Success (95% range)', 'Cost/try', 'Turns', 'Rule breaks', 'vs none'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => `  ${cells.map((c, i) => c.padEnd(widths[i]!)).join('  ')}`.trimEnd();
  out.push(pc.dim(line(head)));
  for (const r of rows) out.push(line(r));
  out.push('');
  out.push(`${pc.bold('Verdict:')} ${score.verdict}`);
  const infra = score.setups.reduce((t, s) => t + s.infraErrors, 0);
  if (infra) {
    const reason = score.setups.find((s) => s.infraReason)?.infraReason;
    out.push(
      pc.yellow(
        `  ${infra} attempt${infra === 1 ? '' : 's'} could not run (not the setup's fault) and ${infra === 1 ? 'is' : 'are'} not scored.${reason ? ` Most common reason: ${reason}.` : ''}`,
      ),
    );
    out.push(pc.dim(`  Try them again with: npx setupscore run --resume ${run.id}`));
  }

  if (score.tasks.length) {
    out.push('');
    out.push(pc.bold('Tasks'));
    for (const t of score.tasks) {
      const cells = run.setups.map((s) => {
        const r = t.results[s.label]!;
        const txt = `${s.label} ${r.passed}/${r.attempts}`;
        return r.attempts === 0
          ? pc.dim(txt)
          : r.passed === r.attempts
            ? pc.green(txt)
            : r.passed === 0
              ? pc.red(txt)
              : pc.yellow(txt);
      });
      out.push(
        `  ${pc.dim(t.id)}  ${t.title.length > 48 ? `${t.title.slice(0, 47)}…` : t.title.padEnd(48)}  ${cells.join('  ')}`,
      );
    }
  }

  if (suggestions.length) {
    out.push('');
    out.push(pc.bold('Suggestions') + pc.dim('  (details: npx setupscore suggest)'));
    suggestions
      .slice(0, 5)
      .forEach((s, i) =>
        out.push(
          `  ${i + 1}. ${s.title} ${pc.dim(`— ${s.evidence}${s.applied ? ' (already added to CLAUDE.md)' : ''}`)}`,
        ),
      );
  }
  if (paths.html) {
    out.push('');
    out.push(`Report: ${pc.cyan(paths.html)}`);
  }
  return out.join('\n');
}

/** Markdown punctuation that could start a link, emphasis, HTML, an entity or a new table cell. */
const escMdPlain = (s: string) =>
  s.replace(/[\\`*_[\]<>|&~]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : `\\${c}`));

/**
 * Text from outside setupscore (git refs, model names, rule text, commit titles) for a Markdown
 * comment: it shows as written and can never add HTML, links or table cells. `code` spans in it
 * stay code when they hold nothing that needs escaping.
 */
export function mdText(value: unknown): string {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  let out = '';
  let at = 0;
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    out += escMdPlain(text.slice(at, m.index));
    out += /[<>|\\]/.test(m[1]!) ? escMdPlain(m[0]) : m[0];
    at = m.index! + m[0].length;
  }
  return out + escMdPlain(text.slice(at));
}

/** A code span for a table cell (| escaped for the table), or escaped plain text when it holds backticks or < >. */
export function mdCodeCell(value: unknown): string {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || /[`<>]/.test(text)) return mdText(text);
  return `\`${text.replace(/\|/g, '\\|')}\``;
}

/** A short Markdown summary for a pull request comment. Everything that comes from outside is escaped. */
export function renderRunMarkdown(run: RunRecord, score: RunScore, suggestions: Suggestion[]): string {
  const out: string[] = ['<!-- setupscore -->'];
  out.push(`### setupscore: ${mdText(score.verdict)}`);
  out.push('');
  out.push(`${mdText(headline(run))} · ${money(totalCost(score))}${score.complete ? '' : ' · **partial results**'}`);
  out.push('');
  out.push('| Setup | Source | Score | Success (95% range) | Cost per try | Rule breaks | vs no instructions |');
  out.push('| --- | --- | ---: | --- | ---: | ---: | --- |');
  for (const s of score.setups) {
    out.push(
      `| ${mdText(s.label)} | ${mdCodeCell(s.source)} | ${s.attempts ? `**${s.score}**` : '-'} | ${s.attempts ? `${pct(s.successRate)} (${pct(s.range[0])}–${pct(s.range[1])})` : '-'} | ${s.costMedian ? money(s.costMedian) : '-'} | ${s.attempts ? s.ruleBreaks : '-'} | ${lift(s) || '-'} |`,
    );
  }
  if (suggestions.length) {
    out.push('');
    out.push('<details><summary>Suggestions</summary>');
    out.push('');
    for (const s of suggestions.slice(0, 5))
      out.push(
        `- **${mdText(s.title)}.** ${mdText(s.evidence)} ${mdText(s.action)}${s.applied ? ' _(already added to CLAUDE.md)_' : ''}`,
      );
    out.push('');
    out.push('</details>');
  }
  out.push('');
  out.push(`<sub>setupscore ${mdText(VERSION)} · run ${mdText(run.id)}</sub>`);
  return out.join('\n');
}

export function runJson(run: RunRecord, score: RunScore, attempts: Attempt[], suggestions: Suggestion[]) {
  return {
    schemaVersion: RUN_REPORT_SCHEMA_VERSION,
    tool: { name: 'setupscore', version: VERSION },
    run: {
      id: run.id,
      status: run.status,
      stopReason: run.stopReason,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
      head: run.head,
      options: run.options,
      comparedTo: run.comparedTo,
    },
    verdict: score.verdict,
    winner: score.winner ?? null,
    complete: score.complete,
    setups: score.setups,
    tasks: score.tasks,
    suggestions,
    attempts: attempts.map((a) => ({
      key: a.key,
      taskId: a.taskId,
      setup: a.setup,
      repeat: a.repeat,
      status: a.status,
      failureKind: a.failureKind,
      reason: a.reason,
      costUsd: a.metrics?.costUsd ?? 0,
      turns: a.metrics?.turns ?? 0,
      ms: a.ms,
      ranTests: a.checks?.ranTests ?? null,
      ruleViolations: a.checks?.ruleViolations ?? [],
      filesChanged: a.checks?.filesChanged ?? [],
      skillsUsed: a.metrics?.skillsUsed ?? [],
    })),
  };
}

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** A single self-contained HTML file: no scripts, no outside requests. */
export function renderRunHtml(run: RunRecord, score: RunScore, attempts: Attempt[], suggestions: Suggestion[]): string {
  const bar = (x: number, lo: number, hi: number) =>
    `<div class="bar"><span class="range" style="left:${(lo * 100).toFixed(1)}%;width:${((hi - lo) * 100).toFixed(1)}%"></span><span class="dot" style="left:${(x * 100).toFixed(1)}%"></span></div>`;
  const cards = score.setups
    .map(
      (s) => `<section class="card${score.winner === s.label ? ' win' : ''}">
  <h3>Setup ${esc(s.label)} <small>${esc(s.source)}</small></h3>
  <div class="big">${s.attempts ? s.score : '–'}<small>/100</small></div>
  <p>${s.attempts ? `${pct(s.successRate)} success · likely ${pct(s.range[0])}–${pct(s.range[1])}` : 'no finished attempts'}</p>
  ${s.attempts ? bar(s.successRate, s.range[0], s.range[1]) : ''}
  <table class="parts">${s.parts.map((p) => `<tr class="${p.measured ? '' : 'off'}"><td>${esc(p.name)}</td><td>${p.measured ? `${p.earned.toFixed(1)} / ${p.max}` : 'not measured'}</td><td>${esc(p.note)}</td></tr>`).join('')}</table>
  <p class="meta">median ${s.costMedian ? money(s.costMedian) : '–'} and ${Math.round(s.turnsMedian)} turns per attempt · ran the tests in ${pct(s.ranTestsRate)} · ${s.ruleBreaks} rule breaks${s.liftPoints !== undefined ? ` · ${esc(lift(s))} vs no instructions` : ''}</p>
</section>`,
    )
    .join('\n');
  const taskRows = score.tasks
    .map(
      (t) =>
        `<tr><td><code>${esc(t.id)}</code></td><td>${esc(t.title)}</td>${run.setups
          .map((s) => {
            const r = t.results[s.label]!;
            const cls = r.attempts === 0 ? '' : r.passed === r.attempts ? 'ok' : r.passed === 0 ? 'bad' : 'mid';
            return `<td class="${cls}">${r.passed}/${r.attempts}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('\n');
  const attemptRows = attempts
    .slice()
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(
      (a) =>
        `<tr><td><code>${esc(a.taskId)}</code></td><td>${esc(a.setup)}</td><td>${a.repeat}</td><td class="${a.status === 'passed' ? 'ok' : a.status === 'failed' ? 'bad' : 'mid'}">${esc(a.status)}</td><td>${a.metrics ? money(a.metrics.costUsd) : '–'}</td><td>${a.metrics?.turns ?? '–'}</td><td>${secs(a.ms)}</td><td>${esc(a.reason ?? '')}${a.checks?.ruleViolations.length ? ` <em>broke: ${esc(a.checks.ruleViolations.map((v) => v.token).join(', '))}</em>` : ''}</td></tr>`,
    )
    .join('\n');
  const sugg = suggestions.length
    ? `<h2>Suggestions</h2><ol>${suggestions.map((s) => `<li><b>${esc(s.title)}.</b> ${esc(s.evidence)} <span class="dim">${esc(s.action)}</span>${s.applied ? ' <span class="dim">(already added to CLAUDE.md)</span>' : s.append ? ` <code>npx setupscore suggest --apply ${esc(s.id)}</code>` : ''}</li>`).join('')}</ol>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>setupscore report ${esc(run.id)}</title>
<style>
:root{color-scheme:light dark;--fg:#1d1d1f;--dim:#6e6e73;--line:#d2d2d7;--ok:#1a7f37;--bad:#c62828;--mid:#b26a00;--accent:#3b5bdb;--bg:#fff;--card:#f6f7f9}
@media(prefers-color-scheme:dark){:root{--fg:#ececf1;--dim:#a1a1aa;--line:#3f3f46;--bg:#18181b;--card:#232327;--ok:#4ade80;--bad:#f87171;--mid:#fbbf24;--accent:#8ea2ff}}
body{font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:var(--fg);background:var(--bg);max-width:1040px;margin:32px auto;padding:0 20px}
h1{font-size:22px;margin:0}h2{font-size:17px;margin-top:32px}h3{margin:0 0 6px;font-size:16px}small,.dim,.meta{color:var(--dim)}
.verdict{font-size:17px;padding:12px 16px;border-left:4px solid var(--accent);background:var(--card);border-radius:6px;margin:16px 0}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}.card{background:var(--card);border-radius:10px;padding:16px;border:1px solid var(--line)}.card.win{border:2px solid var(--accent)}
.big{font-size:40px;font-weight:700}.big small{font-size:16px;font-weight:400}
.bar{position:relative;height:10px;background:var(--line);border-radius:5px;margin:8px 0 12px}.bar .range{position:absolute;top:0;height:10px;background:var(--accent);opacity:.35;border-radius:5px}.bar .dot{position:absolute;top:-3px;width:4px;height:16px;margin-left:-2px;background:var(--accent);border-radius:2px}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--dim);font-weight:600}
.parts td{border:0;padding:2px 6px 2px 0}.parts tr.off{color:var(--dim)}
td.ok{color:var(--ok);font-weight:600}td.bad{color:var(--bad);font-weight:600}td.mid{color:var(--mid);font-weight:600}code{font-size:13px}
details{margin-top:24px}
</style></head><body>
<h1>setupscore report</h1>
<p class="dim">Run ${esc(run.id)} · ${esc(headline(run))} · ${money(totalCost(score))} spent · ${esc(run.status)}${run.stopReason ? ` (${esc(run.stopReason)})` : ''}</p>
<div class="verdict">${esc(score.verdict)}</div>
<div class="cards">${cards}</div>
<h2>Tasks</h2>
<table><tr><th>Task</th><th>Title</th>${run.setups.map((s) => `<th>${esc(s.label)}</th>`).join('')}</tr>${taskRows}</table>
${sugg}
<details><summary>Every attempt (${attempts.length})</summary>
<table><tr><th>Task</th><th>Setup</th><th>#</th><th>Result</th><th>Cost</th><th>Turns</th><th>Time</th><th>Notes</th></tr>${attemptRows}</table></details>
<p class="dim" style="margin-top:32px">Made by setupscore ${esc(VERSION)}. Success ranges are 95% Wilson intervals: when two ranges overlap, the difference may be chance. Transcripts are in .setupscore/runs/${esc(run.id)}/transcripts.</p>
</body></html>
`;
}
