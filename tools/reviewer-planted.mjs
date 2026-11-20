// Planted-error test for the reviewer.
//
// The reviewer study found only a handful of wrong cards (the generator rarely errs), too few to measure the reviewer.
// Here we build wrong cards on purpose and mix them with right ones:
//   right - the card a real run produced and the case marked as right (from the latest --reviewer-study result)
//   altered - same field and evidence, but a number/date in the value is changed (or a claim is added when there is none)
//   wrong-field - the right value put into a different text field of the same website
//   foreign - a value taken from a different site's case (it has nothing to do with this material)
// The reviewer sees exactly what it sees in Sitetend (material text, previous text, other materials, the cards) and
// gives approve / flag / reject. We count how many wrong cards it stops and how many right cards it disturbs.
//
//   node tools/reviewer-planted.mjs --model openai [--from eval/results/<study>.json] [--json]
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AnalysisEngine } from '../src/agent/analysis-engine.js';
import { SourceParser } from '../src/adapters/source-parser.js';
import { OpenAICompatibleProvider } from '../src/adapters/model-provider.js';
import { MemoryBackedWorkspaceAdapter } from '../src/adapters/workspace-adapter.js';
import { SiteKeeperCore } from '../src/core/engine.js';
import { siteAdapterForWorkspace } from '../src/adapters/site-adapters.js';
import { take } from '../src/agent/utils.js';
import '../src/host/node-polyfills.mjs';
if (!globalThis.DOMMatrix) globalThis.DOMMatrix = class DOMMatrix {};

const args = process.argv.slice(2); const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const root = new URL('../', import.meta.url); const read = p => fs.readFileSync(new URL(p, root));
const SETS = ['eval/cases.json', 'eval/cases-hard.json', 'eval/cases-academic.json', 'eval/cases-multi.json'];
const cases = new Map(SETS.flatMap(f => JSON.parse(read(f)).cases).map(c => [c.name, c]));

// ---- model
const { loadModels, resolveKey } = await import('../src/host/user-config.mjs');
const m = (await loadModels()).profiles.find(p => p.id === (opt('--model') || 'openai'));
if (!m || m.type === 'rule') { console.error('Need a real model: --model <id>'); process.exit(2); }
const provider = new OpenAICompatibleProvider({ endpoint: m.endpoint, model: m.model, apiKey: m.keyRef ? await resolveKey(m.keyRef) : '', jsonMode: m.jsonMode !== false });
const usage = { calls: 0, total: 0 };

// ---- right cards from the latest reviewer study (the generator was the real model)
const resDir = new URL('eval/results/', root);
const studyFile = opt('--from') || fs.readdirSync(resDir).filter(f => f.endsWith('.json')).sort().reverse()
  .map(f => 'eval/results/' + f).find(f => { const d = JSON.parse(read(f)); return d.study && !String(d.provider).startsWith('rule-generator'); });
if (!studyFile) { console.error('No reviewer-study result found. Run: node tools/eval.mjs --model openai --reviewer-study --json'); process.exit(2); }
const study = JSON.parse(read(studyFile));
const rights = study.results.flatMap(r => (r.labels || []).filter(x => x.label === 'right').map(x => ({ caseName: r.name, field: x.field, value: x.value })));
console.log(`Reviewer planted-error test · model ${m.model} · right cards from ${studyFile} (${rights.length})\n`);

// ---- the same in-memory workspace as tools/eval.mjs
const TEXT = /\.(json|html?|md|markdown|ya?ml|toml|txt)$/i;
function seed(site) {
  const out = {}, bin = {};
  const walk = dir => { const d = new URL(`${site}/${dir}/`, root); if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel); else if (/\.pdf$/i.test(rel)) bin[rel] = new Uint8Array(read(`${site}/${rel}`));
    else if (TEXT.test(rel) && !/(^|\/)LICENSE/i.test(rel)) out[rel] = rel === 'website/content.json' || (rel.startsWith('sources/') && rel.endsWith('.json')) ? JSON.parse(read(`${site}/${rel}`)) : read(`${site}/${rel}`).toString('utf8'); } };
  walk('website'); walk('sources'); return { out, bin };
}
async function context(c) {
  const site = c.site || 'demo-workspace'; const { out, bin } = seed(site); const ws = new MemoryBackedWorkspaceAdapter(out);
  for (const [p, b] of Object.entries(bin)) take(await ws.writeBytes(p, b));
  for (const [p, s] of Object.entries(c.initialFiles || {})) take(await ws.writeBytes(p, new Uint8Array(read(s))));
  const adapter = await siteAdapterForWorkspace(ws);
  const core = new SiteKeeperCore({ workspaceAdapter: ws, siteAdapter: adapter }); take(await core.initializeWorkspace());
  const engine = new AnalysisEngine({ workspaceAdapter: ws, siteAdapter: adapter, editingCore: core, parser: new SourceParser(), provider: { providerId: 'none', isMock: true, analyzeSourceDiff: async () => ({ ok: true, data: { decision: 'NO_UPDATE_NEEDED', proposals: [] } }) } });
  take(await engine.initialize()); take(await engine.scan({ baselineOnly: true }));
  const before = structuredClone(engine.state.sources);
  for (const [p, v] of Object.entries(c.writes || {})) take(typeof v === 'string' ? await ws.writeText(p, v) : await ws.writeJson(p, v));
  for (const [p, s] of Object.entries(c.writesFile || {})) take(await ws.writeBytes(p, new Uint8Array(read(s))));
  const docs = (await engine.collect()).docs;
  const changed = Object.keys(docs).find(p => docs[p].doc && docs[p].rawHash !== before[p]?.rawHash);
  const content = take(await core._readLive()).data;
  return { adapter, content, docs, changed, previousText: before[changed]?.doc?.extractedText || null };
}
/** The lines that changed in the material: the evidence a real card would quote. */
function changedLines(prev, cur) {
  const old = new Set(String(prev || '').split('\n').map(s => s.trim()));
  return String(cur).split('\n').map(s => s.trim()).filter(s => s && !old.has(s)).join('\n').slice(0, 600);
}
const asText = v => Array.isArray(v) ? v.join(', ') : String(v ?? '');
function alter(v) {
  const s = asText(v);
  if (/\d/.test(s)) return s.replace(/\d+/, d => String(Number(d) + (d.length >= 4 ? 1 : 3)));   // 2026 -> 2027, 22 -> 25
  return s + ' - award-winning and used by thousands of people';                             // an unsupported claim
}

// ---- run
const foreignPool = rights.map(r => asText(r.value)).filter(v => v.length > 3);
const rows = []; let k = 0;
for (const right of rights) {
  const c = cases.get(right.caseName); if (!c) continue;
  let ctx; try { ctx = await context(c); } catch (e) { console.log('skip', right.caseName, e.message); continue; }
  if (!ctx.changed) continue;
  const cur = ctx.docs[ctx.changed].doc;
  const quote = changedLines(ctx.previousText, cur.extractedText) || cur.extractedText.slice(0, 300);
  const fields = ctx.adapter.listEditableFields(ctx.content);
  const meta = path => fields.find(f => f.path === path) || { label: path, type: 'text' };
  const current = path => ctx.adapter.getFieldValue(ctx.content, path).data?.value;
  const other = fields.filter(f => f.path !== right.field && ['text', 'textarea'].includes(f.type) && typeof current(f.path) === 'string');
  const wrongField = other.length ? other[(k * 7) % other.length] : null;
  const foreign = foreignPool[(k * 13 + 5) % foreignPool.length]; k++;
  const cards = [
    { kind: 'right', field: right.field, value: right.value },
    { kind: 'altered', field: right.field, value: alter(right.value) },
    ...(wrongField ? [{ kind: 'wrong-field', field: wrongField.path, value: right.value }] : []),
    ...(foreign && foreign !== asText(right.value) ? [{ kind: 'foreign', field: right.field, value: foreign }] : []),
  ].map((x, i) => ({ ...x, id: `p${i}` }));
  // One card per call, so the reviewer judges each on its own (as it would see one card among many in real use).
  for (const card of cards) {
    const req = { replyLanguage: 'en', source: { path: ctx.changed, extractedText: cur.extractedText.slice(0, 8000) }, previousText: ctx.previousText?.slice(0, 8000) ?? null,
      otherMaterials: Object.entries(ctx.docs).filter(([p, d]) => p !== ctx.changed && d.doc).slice(0, 8).map(([p, d]) => ({ path: p, excerpt: d.doc.extractedText.slice(0, 1500) })),
      proposals: [{ id: card.id, field: card.field, label: meta(card.field).label, type: meta(card.field).type, current: current(card.field), proposed: card.value, quote, reason: 'The material changed.' }] };
    const r = await provider.reviewProposals(req); usage.calls++; usage.total += r.ok ? r.data._usage?.total_tokens || 0 : 0;
    const v = r.ok ? r.data.reviews.find(x => x.id === card.id) : null;
    rows.push({ case: right.caseName, kind: card.kind, field: card.field, value: asText(card.value).slice(0, 120), verdict: !r.ok ? 'error' : ['approve', 'remind', 'flag', 'reject'].includes(v?.verdict) ? v.verdict : 'flag', note: v?.note || (r.ok ? '' : r.error.message) });
  }
  process.stdout.write('.');
}
console.log('\n');
const kinds = ['right', 'altered', 'wrong-field', 'foreign'];
const n = (kind, v) => rows.filter(r => r.kind === kind && (!v || r.verdict === v)).length;
console.log('              cards  reject doubt  remind approve error');
for (const kind of kinds) console.log(kind.padEnd(12) + [n(kind), n(kind, 'reject'), n(kind, 'flag'), n(kind, 'remind'), n(kind, 'approve'), n(kind, 'error')].map(x => String(x).padStart(7)).join(''));
const wrong = rows.filter(r => r.kind !== 'right' && r.verdict !== 'error'), right = rows.filter(r => r.kind === 'right' && r.verdict !== 'error');
const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '-';
const stopped = wrong.filter(r => !['approve', 'remind'].includes(r.verdict)).length, rejected = wrong.filter(r => r.verdict === 'reject').length;
console.log(`\nWrong cards stopped or marked: ${stopped}/${wrong.length}(${pct(stopped, wrong.length)}), rejected outright${rejected}(${pct(rejected, wrong.length)})`);
console.log(`Right cards: approved${right.filter(r => r.verdict === 'approve').length}/${right.length}, reminded${right.filter(r => r.verdict === 'remind').length}, doubted${right.filter(r => r.verdict === 'flag').length}, wrongly rejected${right.filter(r => r.verdict === 'reject').length}(${pct(right.filter(r => r.verdict === 'reject').length, right.length)})`);
for (const r of wrong.filter(r => ['approve', 'remind'].includes(r.verdict)).slice(0, 15)) console.log(`  missed [${r.kind}] ${r.case} · ${r.field} = ${r.value.slice(0, 60)}`);
console.log(`Model calls ${usage.calls} · tokens ${usage.total.toLocaleString()}`);
if (args.includes('--json')) {
  const f = new URL(`eval/results/planted-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, root);
  fs.writeFileSync(f, JSON.stringify({ model: m.model, from: studyFile, usage, rows }, null, 2)); console.log('Results written to  ' + fileURLToPath(f));
}
