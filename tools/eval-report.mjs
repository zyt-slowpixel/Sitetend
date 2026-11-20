#!/usr/bin/env node
// Reads the result files written by `node tools/eval.mjs --json` (eval/results/*.json) and reports, per
// configuration (model + reviewer on/off + set):
//   - pass rate of every run, the mean and spread across runs, and which cases pass only sometimes;
//   - card precision: of the suggestions that can be judged, how many were right;
//   - recall: of the cases where a change was expected, how often the change was suggested at all;
//   - false alarms: of the cases where nothing should change, how often an (unflagged) suggestion appeared;
//   - cost and speed: model tokens and seconds per case (mean and 95th percentile).
// Usage: node tools/eval-report.mjs [--set ext7] [--since 2026-11-13] [--tag final] [--md report.md] [--all: also result files written before
// per-card labels existed]
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const args = process.argv.slice(2), opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const dir = new URL('eval/results/', root);
if (!fs.existsSync(dir)) { console.error('No results yet. Run: node tools/eval.mjs --model <id> --set <set> --json'); process.exit(2); }
const runs = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => ({ file: f, ...JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8')) }))
  .filter(r => Array.isArray(r.results) && (args.includes('--all') || r.usage?.calls) && (args.includes('--all') || 'expects' in (r.results[0] || {})) && (!opt('--set') || (r.set || 'all') === opt('--set')) && (!opt('--since') || r.at >= opt('--since')) && (!opt('--tag') || r.tag === opt('--tag')));
if (!runs.length) { console.error('No result files match.'); process.exit(2); }
const files = runs.length;
// A run of every set at once (set "all") is split into one run per set, so it reads like the per-set runs.
const cost = runs.filter(r => r.dollars != null).map(r => `- ${r.at.slice(0, 16).replace('T', ' ')} · ${r.model || r.provider} · reviewer ${r.reviewer ? 'on' : 'off'} · set ${r.set || 'all'}: $${r.dollars.toFixed(2)}${r.stopped ? ' (stopped at the spending cap, ' + r.results.length + ' cases run)' : ''}`);
for (let i = runs.length - 1; i >= 0; i--) {
  const r = runs[i]; if ((r.set || 'all') !== 'all') continue;
  const sets = [...new Set(r.results.map(x => x.set))];
  runs.splice(i, 1, ...sets.map(set => ({ ...r, set, results: r.results.filter(x => x.set === set) })));
}

const key = r => `${r.model || r.provider} · reviewer ${r.reviewer ? 'on' : 'off'} · set ${r.set || 'all'}`;
const groups = new Map(); for (const r of runs) { const k = key(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
// One more row per model and reviewer setting when several sets were run: run i of every set pooled into one run.
const pooled = new Map();
for (const [k, rs] of groups) { const head = k.replace(/ · set .*$/, ''); if (!pooled.has(head)) pooled.set(head, []); pooled.get(head).push(rs); }
for (const [head, lists] of pooled) if (lists.length > 1) {
  const n = Math.min(...lists.map(l => l.length));
  groups.set(`${head} · all ${lists.length} sets`, Array.from({ length: n }, (_, i) => ({ at: lists[0][i].at, results: lists.flatMap(l => l[i].results) })));
}
const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '–';
const mean = xs => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sd = xs => xs.length < 2 ? 0 : Math.sqrt(xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / (xs.length - 1));
const p95 = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] : 0; };

const lines = ['# Sitetend evaluation report', '', `${files} result file(s), ${groups.size} configuration(s).`, ''];
const table = [['Configuration', 'Runs', 'Pass rate (mean ± sd)', 'Card precision', 'Recall', 'False alarms', 'Tokens / case', 'Seconds / case (mean, p95)']];
for (const [k, rs] of groups) {
  const rates = rs.map(r => r.results.filter(x => x.pass).length / r.results.length);
  const all = rs.flatMap(r => r.results);
  const cards = all.flatMap(x => x.labels || []);
  const right = cards.filter(c => c.label === 'right').length, wrong = cards.filter(c => c.label === 'wrong').length;
  const change = all.filter(x => x.expects === 'change'), nothing = all.filter(x => x.expects === 'nothing');
  const alarms = nothing.filter(x => !x.pass).length;
  const ms = all.map(x => x.ms || 0), tok = all.map(x => x.tokens || 0);
  table.push([k, String(rs.length), `${(100 * mean(rates)).toFixed(1)}% ± ${(100 * sd(rates)).toFixed(1)}`, `${pct(right, right + wrong)} (${right}/${right + wrong})`,
    `${pct(change.filter(x => !x.missed).length, change.length)}`, `${pct(alarms, nothing.length)} (${alarms}/${nothing.length})`,
    tok.some(Boolean) ? Math.round(mean(tok)).toLocaleString('en') : '–', `${(mean(ms) / 1000).toFixed(1)}, ${(p95(ms) / 1000).toFixed(1)}`]);
  // per-case consistency across runs
  const byCase = new Map(); for (const r of rs) for (const x of r.results) { const n = `${x.set} · ${x.name}`; if (!byCase.has(n)) byCase.set(n, []); byCase.get(n).push(x.pass); }
  const flaky = [...byCase].filter(([, ps]) => ps.some(Boolean) && !ps.every(Boolean)), never = [...byCase].filter(([, ps]) => !ps.some(Boolean));
  lines.push(`## ${k}`, '', ...rs.map((r, i) => `- Run ${i + 1} (${r.at?.slice(0, 16).replace('T', ' ')}): ${r.results.filter(x => x.pass).length}/${r.results.length}`), '');
  if (flaky.length) lines.push('Passes only sometimes:', ...flaky.map(([n, ps]) => `- ${n} (${ps.filter(Boolean).length}/${ps.length})`), '');
  if (never.length) lines.push('Never passes:', ...never.map(([n]) => `- ${n}`), '');
  const cats = [...new Set(all.map(x => x.category))];
  lines.push('By category: ' + cats.map(c => { const xs = all.filter(x => x.category === c); return `${c} ${xs.filter(x => x.pass).length}/${xs.length}`; }).join(' · '), '');
}
const md = ['| ' + table[0].join(' | ') + ' |', '|' + table[0].map(() => '---').join('|') + '|', ...table.slice(1).map(r => '| ' + r.join(' | ') + ' |')];
lines.splice(4, 0, ...md, '', 'Card precision: suggestions judged right ÷ suggestions that could be judged. Recall: cases expecting a change where it was suggested. False alarms: cases expecting no change that got an unflagged suggestion. A flagged card (the reviewer asks you to double-check) is not counted as a false alarm.', '');
if (cost.length) lines.push('', '## Cost', '', 'Estimated from the token counts at the prices given to eval.mjs (default: $2 input and $12 output per 1M tokens).', '', ...cost);
const text = lines.join('\n');
console.log(text);
if (opt('--md')) { fs.writeFileSync(opt('--md'), text + '\n'); console.log('\nWritten to ' + opt('--md')); }
else { const f = new URL('eval/REPORT.md', root); fs.writeFileSync(f, text + '\n'); console.log('\nWritten to ' + fileURLToPath(f)); }
