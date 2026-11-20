// New items in lists (a new project, talk, member, tour date): suggestions, checks, accept/replace, undo/redo.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import './../src/host/node-polyfills.mjs';
import { AnalysisEngine } from '../src/agent/analysis-engine.js';
import { SourceParser } from '../src/adapters/source-parser.js';
import { MemoryBackedWorkspaceAdapter } from '../src/adapters/workspace-adapter.js';
import { SiteKeeperCore } from '../src/core/engine.js';
import { JsonGenericSiteAdapter } from '../src/adapters/json-generic-adapter.js';
import { TextSiteAdapter } from '../src/adapters/text-site-adapter.js';
import { take } from '../src/agent/utils.js';

let n = 0; const test = async (name, fn) => { await fn(); n++; console.log('✓ ' + name); };
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const NOVA = `# Nova Board

Nova Board is a shared planning board for small research teams, released in 2026.

- Category: Systems
- Link: https://example.org/nova
`;
const novaItem = (extra = {}) => ({ collection: 'projects', position: 'start', quote: 'Nova Board is a shared planning board for small research teams',
  values: { title: 'Nova Board', summary: 'A shared planning board for small research teams.', year: '2026', link: 'https://example.org/nova', ...extra }, reason: 'New project in the materials.' });
const answer = (items, proposals = []) => ({ decision: 'UPDATE', summary: 's', proposals, newItems: items });

async function setup({ files, adapter, answers, autoApply = true, review }) {
  const ws = new MemoryBackedWorkspaceAdapter(files);
  const core = new SiteKeeperCore({ workspaceAdapter: ws, siteAdapter: adapter }); take(await core.initializeWorkspace()); core.config.autoApply = autoApply;
  const calls = [];
  const provider = { providerId: 'fake', isMock: false, async analyzeSourceDiff(r) { calls.push(r); const a = answers[Math.min(calls.length - 1, answers.length - 1)]; return { ok: true, data: typeof a === 'function' ? a(r) : structuredClone(a) }; },
    ...(review ? { async reviewProposals(r) { return review(r); } } : {}) };
  const engine = new AnalysisEngine({ workspaceAdapter: ws, siteAdapter: adapter, editingCore: core, parser: new SourceParser(), provider });
  take(await engine.initialize()); take(await engine.scan({ baselineOnly: true }));
  return { ws, core, engine, calls };
}
const pending = e => e.state.proposals.filter(p => p.status === 'PENDING');
const json = () => ({ 'website/content.json': JSON.parse(read('demo-workspace/website/content.json')), 'sources/profile.json': JSON.parse(read('demo-workspace/sources/profile.json')) });
const titles = async ws => take(await ws.readJson('website/content.json')).data.projects.map(p => p.title);

await test('JSON site: the model sees the lists, a new project becomes one card, accept adds it at the top, undo/redo work', async () => {
  const { ws, core, engine, calls } = await setup({ files: json(), adapter: new JsonGenericSiteAdapter(), answers: [answer([novaItem()])] });
  const before = await titles(ws);
  take(await ws.writeText('sources/projects/nova-board.md', NOVA)); take(await engine.scan());
  const lists = calls[0].collections; assert.ok(lists.some(c => c.id === 'projects' && c.existing.length === before.length));
  const [p] = pending(engine); assert.equal(p.kind, 'item'); assert.equal(p.title, 'Nova Board'); assert.equal(p.collection, 'projects');
  take(await engine.acceptMany([p.id]));
  assert.deepEqual(await titles(ws), ['Nova Board', ...before]);
  const added = take(await ws.readJson('website/content.json')).data.projects[0];
  assert.equal(added.summary, 'A shared planning board for small research teams.'); assert.equal(added.id, 'nova-board');
  assert.ok(!added.detailOverview, 'fields the source did not give are not copied from another project');
  const log = core.state.maintenanceLogs[0]; assert.ok(log.changes.some(c => c.path === 'items:projects' && c.item?.title === 'Nova Board'), 'history says which item was added');
  take(await core.undo()); assert.deepEqual(await titles(ws), before);
  take(await core.redo()); assert.deepEqual(await titles(ws), ['Nova Board', ...before]);
});

await test('Checks: invented words, unknown fields, missing title and duplicates are refused; other items still pass', async () => {
  const items = [novaItem({ summary: 'An award-winning planning board.' }), { ...novaItem(), values: { title: 'Nova Board', colour: 'red' } },
    { ...novaItem(), values: { summary: 'Shared planning board' } }];
  const { engine, calls } = await setup({ files: json(), adapter: new JsonGenericSiteAdapter(), answers: [answer(items), answer([novaItem({ year: '2031' })])] });
  const ws = engine.workspace; take(await ws.writeText('sources/projects/nova-board.md', NOVA)); take(await engine.scan());
  assert.equal(pending(engine).length, 0);
  const why = calls[1].feedback;   // all refused -> one retry that tells the model why
  assert.match(why, /award/); assert.match(why, /unknown fields.*colour/); assert.match(why, /needs "title"/);
  assert.match(engine.state.scans[0].results.find(r => r.path === 'sources/projects/nova-board.md').rejected.join('\n'), /2031/);
  // A project that is already on the site is not added again.
  const { engine: e2 } = await setup({ files: json(), adapter: new JsonGenericSiteAdapter(), answers: [answer([{ ...novaItem(), values: { title: 'Orbit Dock' }, quote: 'Nova Board is a shared' }])] });
  take(await e2.workspace.writeText('sources/projects/nova-board.md', NOVA)); take(await e2.scan());
  assert.equal(pending(e2).length, 0);
});

await test('Accepting another card first does not make the new-item card conflict; replace swaps one item instead', async () => {
  const files = json();
  const { ws, engine } = await setup({ files, adapter: new JsonGenericSiteAdapter(), answers: [answer([novaItem()], [{ targetField: 'projects.orbit-dock.year', value: '2026', quote: 'released in 2026', reason: 'r' }])] });
  const first = take(await ws.readJson('website/content.json')).data.projects;
  take(await ws.writeText('sources/projects/nova-board.md', NOVA)); take(await engine.scan());
  const field = pending(engine).find(p => p.kind !== 'item'), item = pending(engine).find(p => p.kind === 'item');
  if (field) take(await engine.acceptMany([field.id]));
  const victim = first[1];
  take(await engine.acceptMany([item.id], { [item.id]: { op: 'replace', key: victim.id } }));
  const now = take(await ws.readJson('website/content.json')).data.projects;
  assert.equal(now.length, first.length); assert.equal(now[1].title, 'Nova Board'); assert.ok(!now.some(p => p.title === victim.title));
  assert.equal(engine.state.proposals.find(p => p.id === item.id).replacedTitle, victim.title);
});

await test('Jekyll folder: a new talk is a new file shaped like the others; undo removes the file', async () => {
  const talk = (d, t) => `---\ntitle: "${t}"\ncollection: talks\ntype: "Talk"\npermalink: /talks/${d}-talk\nvenue: "Old Venue"\ndate: ${d}\nlocation: "Old City"\n---\n\nOld description.\n`;
  const files = { 'website/_config.yml': 'title: "Lab"\n', 'website/_talks/2014-02-01-talk.md': talk('2014-02-01', 'Old Talk A'), 'website/_talks/2015-03-01-talk.md': talk('2015-03-01', 'Old Talk B'),
    'website/_posts/2020-01-01-a.md': '---\ntitle: A\n---\n' + 'Long text. '.repeat(100), 'website/_posts/2020-01-02-b.md': '---\ntitle: B\n---\n' + 'Long text. '.repeat(100),
    'sources/cv.md': '# CV\n\nTalks\n' };
  const item = { collection: 'dir:_talks', position: 'end', quote: 'Designing Calm Interfaces, CHI 2026, Yokohama, Japan, April 2026',
    values: { title: 'Designing Calm Interfaces', venue: 'CHI 2026', location: 'Yokohama, Japan', date: 'April 2026' }, reason: 'New talk.' };
  const { ws, core, engine, calls } = await setup({ files, adapter: new TextSiteAdapter('jekyll'), answers: [answer([item])] });
  take(await ws.writeText('sources/cv.md', '# CV\n\nTalks\n\n- Designing Calm Interfaces, CHI 2026, Yokohama, Japan, April 2026\n')); take(await engine.scan());
  assert.ok(calls[0].collections.some(c => c.id === 'dir:_talks')); assert.ok(!calls[0].collections.some(c => c.id === 'dir:_posts'), 'blog posts are articles, not items');
  const [p] = pending(engine); take(await engine.acceptMany([p.id]));
  const text = take(await ws.readText('website/_talks/2026-04-01-designing-calm-interfaces.md')).content;
  assert.match(text, /title: "Designing Calm Interfaces"/); assert.match(text, /date: 2026-04-01/); assert.match(text, /permalink: \/talks\/2026-04-01-designing-calm-interfaces/);
  assert.doesNotMatch(text, /Old (Venue|City|description)/, 'nothing from the old talk is left in the new file');
  take(await core.undo());
  assert.equal(take(await ws.exists('website/_talks/2026-04-01-designing-calm-interfaces.md')).exists, false);
  take(await core.redo());
  assert.equal(take(await ws.exists('website/_talks/2026-04-01-designing-calm-interfaces.md')).exists, true);
});

await test('YAML member list and Markdown list: new entries keep the file\'s own style', async () => {
  const files = { 'website/_config.yml': 'title: "Lab"\n', 'website/_data/people.yml': '# lab members\n- name: "Ann Lee"\n  role: "PI"\n- name: "Bo Chen"\n  role: "Student"\n',
    'website/tour.md': '---\ntitle: Tour\n---\n\n- Nov 21 — Majestic, Detroit\n- Dec 5 — Blind Pig, Ann Arbor\n\nSee you there.\n', 'sources/news.md': '# News\n' };
  const items = [{ collection: 'yaml:_data/people.yml::@', position: 'end', quote: 'Priya Natarajan joined as a Postdoc', values: { name: 'Priya Natarajan', role: 'Postdoc' }, reason: 'r' },
    { collection: 'list:tour.md::0', position: 'end', quote: 'Dec 19 — Loving Touch, Ferndale', values: { text: 'Dec 19 — Loving Touch, Ferndale' }, reason: 'r' }];
  const { ws, engine } = await setup({ files, adapter: new TextSiteAdapter('jekyll'), answers: [answer(items)] });
  take(await ws.writeText('sources/news.md', '# News\n\nPriya Natarajan joined as a Postdoc.\n\nNew show: Dec 19 — Loving Touch, Ferndale\n')); take(await engine.scan());
  take(await engine.acceptMany(pending(engine).map(p => p.id)));
  assert.equal(take(await ws.readText('website/_data/people.yml')).content, '# lab members\n- name: "Ann Lee"\n  role: "PI"\n- name: "Bo Chen"\n  role: "Student"\n- name: "Priya Natarajan"\n  role: "Postdoc"\n');
  assert.match(take(await ws.readText('website/tour.md')).content, /- Dec 5 — Blind Pig, Ann Arbor\n- Dec 19 — Loving Touch, Ferndale\n\nSee you there\./);
});

await test('Lists that are site structure or translations are not offered', async () => {
  const a = new TextSiteAdapter('hugo');
  const c = { files: { 'hugo.toml': 'title = "x"\n', 'content/posts/a.en.md': '---\ntitle: A\n---\nx', 'content/posts/a.fr.md': '---\ntitle: A\n---\nx',
    'content/talks/a.md': '---\ntitle: A\n---\nx', 'content/talks/b.md': '---\ntitle: B\n---\nx', 'data/menu.yml': '- title: Home\n  url: /\n- title: About\n  url: /about/\n' } };
  const ids = a.listCollections(c).filter(x => x.canAdd).map(x => x.id);
  assert.deepEqual(ids, ['dir:content/talks']);
});

console.log(`\n${n} item checks passed`);
