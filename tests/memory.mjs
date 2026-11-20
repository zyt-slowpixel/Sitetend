// Memory: what the owner asked Sitetend to remember. The store, how notes reach a model (and that nothing changes
// when there are none), learning from repeated edits, reject reasons, the chat, and the API.
import assert from 'node:assert/strict';
import fs from 'node:fs'; import fsp from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto';
import { spawn } from 'node:child_process'; import { fileURLToPath } from 'node:url';
import './../src/host/node-polyfills.mjs';
import { Memory, editPatterns } from '../src/host/memory.mjs';
import { AnalysisEngine } from '../src/agent/analysis-engine.js';
import { SourceParser } from '../src/adapters/source-parser.js';
import { MemoryBackedWorkspaceAdapter } from '../src/adapters/workspace-adapter.js';
import { SiteKeeperCore } from '../src/core/engine.js';
import { JsonGenericSiteAdapter } from '../src/adapters/json-generic-adapter.js';
import { OpenAICompatibleProvider } from '../src/adapters/model-provider.js';
import { take } from '../src/agent/utils.js';

let n = 0; const test = async (name, fn) => { await fn(); n++; console.log('✓ ' + name); };
const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'st-mem-'));
const mem = name => new Memory({ siteDir: path.join(tmp, name, 'site', '.sitetend'), home: path.join(tmp, name, 'home') });
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url));

// ------------------------------------------------------------------ the store
await test('Notes: preferences are shared by all websites, decisions belong to one; same text is not saved twice', async () => {
  const m = mem('a');
  const pref = await m.add({ kind: 'preference', text: '  Write months   in full ' });
  const dec = await m.add({ kind: 'decision', text: 'Keep Shelter Map in the list', scope: 'all', about: { fields: ['projects.0.title'] }, from: { type: 'chat', quote: 'keep it' } });
  assert.equal(pref.id, 'g-0001'); assert.equal(pref.scope, 'all'); assert.equal(pref.text, 'Write months in full');
  assert.equal(dec.id, 'm-0001'); assert.equal(dec.scope, 'site', 'a decision is about one website, whatever was asked');
  const again = await m.add({ kind: 'preference', text: 'write months in full.' });
  assert.equal(again.id, pref.id); assert.equal(again.existed, true);
  assert.equal((await m.list()).items.length, 2);
  await assert.rejects(m.add({ kind: 'preference', text: ' ' }), e => e.code === 'MEMORY_EMPTY');
  await assert.rejects(m.add({ kind: 'secret', text: 'x y' }), e => e.code === 'MEMORY_BAD');
  // another website sees the shared preference, not the decision
  const other = new Memory({ siteDir: path.join(tmp, 'a', 'site2', '.sitetend'), home: path.join(tmp, 'a', 'home') });
  assert.deepEqual((await other.list()).items.map(i => i.id), ['g-0001']);
});
await test('Notes can be edited, paused, moved between "all websites" and "this website", and removed; every step is logged', async () => {
  const m = mem('b');
  const a = await m.add({ kind: 'preference', text: 'Job titles in English' });
  const e = await m.update(a.id, { text: 'Job titles always in English', status: 'paused' });
  assert.equal(e.text, 'Job titles always in English'); assert.equal(e.status, 'paused');
  assert.deepEqual(await m.relevant({}), [], 'a paused note is not used');
  const moved = await m.update(a.id, { scope: 'site', status: 'active' });
  assert.equal(moved.id, 'm-0001'); assert.equal(moved.scope, 'site');
  assert.deepEqual((await m.list()).items.map(i => i.id), ['m-0001']);
  const d = await m.add({ kind: 'decision', text: 'No phone number on the site' });
  await assert.rejects(m.update(d.id, { scope: 'all' }), e2 => e2.code === 'MEMORY_BAD');
  assert.deepEqual(await m.remove(d.id), { removed: true }); assert.deepEqual(await m.remove(d.id), { removed: false });
  await assert.rejects(m.update('m-0099', { text: 'x y' }), e2 => e2.code === 'MEMORY_NOT_FOUND');
  const log = (await fsp.readFile(path.join(tmp, 'b', 'site', '.sitetend', 'memory-log.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l).op);
  assert.deepEqual(log, ['move-in', 'add', 'remove']);
  const glog = (await fsp.readFile(path.join(tmp, 'b', 'home', 'memory-log.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l).op);
  assert.deepEqual(glog, ['add', 'update', 'move-out']);
});
await test('Relevant notes: preferences always; decisions only for the fields they are about; within a size budget', async () => {
  const m = mem('c');
  await m.add({ kind: 'preference', text: 'Months in full' });
  await m.add({ kind: 'decision', text: 'Do not list the phone number', about: { fields: ['contact.phone'] } });
  await m.add({ kind: 'decision', text: 'Never mention the old employer' });
  const ids = async f => (await m.relevant({ fields: f })).map(x => x.text).sort();
  assert.deepEqual(await ids(['profile.role']), ['Months in full', 'Never mention the old employer']);
  assert.deepEqual(await ids(['contact.phone']), ['Do not list the phone number', 'Months in full', 'Never mention the old employer']);
  for (let i = 0; i < 30; i++) await m.add({ kind: 'preference', text: 'Preference number ' + i + ' ' + 'x'.repeat(300) });
  const many = await m.relevant({});
  assert.ok(many.length <= 20 && many.reduce((s, x) => s + x.text.length, 0) <= 6000, 'at most 20 notes and 6,000 characters go to a model');
});
await test('Many changes at once lose nothing; a damaged file is set aside, not overwritten silently', async () => {
  const m = mem('d');
  await Promise.all(Array.from({ length: 25 }, (_, i) => m.add({ kind: 'preference', text: 'Note ' + i })));
  assert.equal((await m.list()).items.length, 25);
  await fsp.writeFile(path.join(tmp, 'd', 'home', 'memory.json'), '{ broken');
  assert.equal((await m.list()).items.length, 0);
  assert.ok((await fsp.readdir(path.join(tmp, 'd', 'home'))).some(f => f.startsWith('memory.json.damaged-')));
});

// ------------------------------------------------------------------ learning from edits (rules, no model)
await test('Edit patterns: month written out, end period, one word replaced; a rewritten sentence is not a pattern', async () => {
  const keys = (a, b) => editPatterns(a, b).map(p => p.key);
  assert.deepEqual(keys('Joined in Sept 2026 as designer', 'Joined in September 2026 as designer'), ['month-full']);
  assert.deepEqual(keys('Since October 2025', 'Since Oct 2025'), ['month-short']);
  assert.deepEqual(keys('Product Designer at Lumen.', 'Product Designer at Lumen'), ['no-end-period']);
  assert.deepEqual(keys('Product Designer at Lumen', 'Product Designer at Lumen.'), ['end-period']);
  assert.deepEqual(keys('Sr. Designer, Lumen Labs', 'Senior Designer, Lumen Labs'), ['replace:sr.=>Senior']);
  assert.deepEqual(keys('I build tools for people.', 'A different sentence about something else entirely, much longer than before.'), []);
  assert.deepEqual(keys('Designer', 'Designer at Lumen Labs'), [], 'adding facts is not a wording pattern');
  assert.deepEqual(keys('same', 'same'), []); assert.deepEqual(keys(['a'], ['b']), []);
  assert.deepEqual(keys('May 2026', 'March 2026'), ['replace:may=>March'], 'a different month is a correction, not a format');
});
await test('The same change in two different suggestions becomes one "remember this?" question; answering saves or drops it', async () => {
  const m = mem('e');
  assert.equal(await m.observeEdit({ proposalId: 'p1', field: 'a', suggested: 'Sept 2026', final: 'September 2026' }), null);
  assert.equal(await m.observeEdit({ proposalId: 'p1', field: 'a', suggested: 'Sept 2026', final: 'September 2026' }), null, 'the same suggestion does not count twice');
  const c = await m.observeEdit({ proposalId: 'p2', field: 'b', suggested: 'Since Oct 2025', final: 'Since October 2025' });
  assert.equal(c.key, 'month-full'); assert.equal(c.rule.type, 'month-full'); assert.equal(c.examples.length, 2);
  assert.equal(await m.observeEdit({ proposalId: 'p3', field: 'c', suggested: 'Nov 2025', final: 'November 2025' }), null, 'asked once only');
  assert.equal((await m.list()).candidates.length, 1);
  const r = await m.resolveCandidate(c.id, { remember: true, text: 'Write months in full: September 2026.' });
  assert.equal(r.note.kind, 'preference'); assert.equal(r.note.from.type, 'edits'); assert.match(r.note.from.quote, /Sept -> September/);
  assert.equal((await m.list()).candidates.length, 0);
  await assert.rejects(m.resolveCandidate(c.id, { remember: false }), e2 => e2.code === 'MEMORY_NOT_FOUND');
  // "No thanks": not asked again for the same pattern
  await m.observeEdit({ proposalId: 'q1', field: 'a', suggested: 'Lead.', final: 'Lead' });
  const c2 = await m.observeEdit({ proposalId: 'q2', field: 'b', suggested: 'Designer.', final: 'Designer' });
  assert.deepEqual(await m.resolveCandidate(c2.id, { remember: false }), {});
  assert.equal(await m.observeEdit({ proposalId: 'q3', field: 'c', suggested: 'Writer.', final: 'Writer' }), null);
});

// ------------------------------------------------------------------ what a model receives
// The line with today's date differs by day and time zone, so it is left out of the fingerprint.
const sha = s => crypto.createHash('sha256').update(s.split('\n').filter(l => !l.startsWith('Today is ')).join('\n')).digest('hex').slice(0, 16);
const capture = async (fn) => { let body; const p = new OpenAICompatibleProvider({ endpoint: 'https://example.invalid/v1/chat/completions', model: 'm', fetchImpl: async (u, o) => { body = o.body; return new Response(JSON.stringify({ choices: [{ message: { content: '{"decision":"NO_UPDATE_NEEDED","summary":"","proposals":[],"reviews":[],"paths":[]}' } }] })); } }); await fn(p); return body; };
await test('Without notes, the instructions a model gets are exactly those of the evaluated release (change them only together with a new evaluation)', async () => {
  const was = process.env.SITETEND_TODAY; process.env.SITETEND_TODAY = '2027-01-05';
  try {
    const req = { source: { path: 'a.md', extractedText: 'x' }, previousText: null, fields: [{ path: 'a', label: 'A', type: 'text', current: 'v' }], hints: [], replyLanguage: 'zh-Hans' };
    const gen = await capture(p => p.analyzeSourceDiff(structuredClone(req)));
    const rev = await capture(p => p.reviewProposals({ replyLanguage: 'es', source: req.source, previousText: null, otherMaterials: [], proposals: [{ id: 'p', field: 'a', proposed: 'w', quote: 'x', reason: 'r' }] }));
    const loc = await capture(p => p.locateFields({ source: req.source, previousText: null, fields: [{ path: 'a', label: 'A', preview: 'v' }] }));
    // Fingerprints of the instructions in release 1.1.0, the version the evaluation reports describe.
    assert.equal(sha(JSON.parse(gen).messages[0].content), 'f90981529ee5a0b0', 'generator instructions changed');
    assert.equal(sha(JSON.parse(rev).messages[0].content), '47d33c75b74e4c13', 'reviewer instructions changed');
    assert.equal(sha(JSON.parse(loc).messages[0].content), '9c46afad83b13b0c', 'locator instructions changed');
    assert.ok(!gen.includes('ownerNotes') && !rev.includes('ownerNotes'));
    // with notes: one extra block at the end, and the notes in the data
    const gen2 = await capture(p => p.analyzeSourceDiff({ ...structuredClone(req), ownerNotes: [{ id: 'g-0001', kind: 'preference', text: 'Months in full' }] }));
    const a = JSON.parse(gen).messages[0].content, b = JSON.parse(gen2).messages[0].content;
    assert.ok(b.startsWith(a) && b.length > a.length && /usedNotes/.test(b.slice(a.length)), 'the note rules are added after the unchanged instructions');
    assert.match(JSON.parse(gen2).messages[1].content, /"ownerNotes":\[\{"id":"g-0001"/);
  } finally { if (was === undefined) delete process.env.SITETEND_TODAY; else process.env.SITETEND_TODAY = was; }
});

const OD = read('demo-workspace/sources/projects/orbit-dock.md').toString('utf8');
const adapter = new JsonGenericSiteAdapter();
async function run(write, answer, { notes, review } = {}) {
  const ws = new MemoryBackedWorkspaceAdapter({ 'website/content.json': JSON.parse(read('demo-workspace/website/content.json')),
    'sources/profile.json': JSON.parse(read('demo-workspace/sources/profile.json')), 'sources/projects/orbit-dock.md': OD });
  const core = new SiteKeeperCore({ workspaceAdapter: ws, siteAdapter: adapter }); take(await core.initializeWorkspace()); core.config.autoApply = false;
  const calls = [], reviews = [], used = [];
  const provider = { providerId: 'fake', isMock: false, async analyzeSourceDiff(r) { calls.push(structuredClone(r)); return { ok: true, data: typeof answer === 'function' ? answer(r) : answer }; },
    ...(review ? { async reviewProposals(r) { reviews.push(structuredClone(r)); return review(r); } } : {}) };
  const engine = new AnalysisEngine({ workspaceAdapter: ws, siteAdapter: adapter, editingCore: core, parser: new SourceParser(), provider });
  if (notes !== undefined) { engine.notesFor = async () => notes; engine.onNotesUsed = ids => used.push(...ids); }
  take(await engine.initialize()); take(await engine.scan({ baselineOnly: true }));
  for (const [p, v] of Object.entries(write)) take(await ws.writeText(p, v));
  take(await engine.scan());
  return { calls, reviews, used, pending: engine.state.proposals.filter(p => p.status === 'PENDING'), scan: engine.state.scans[0].results.filter(x => x.path === 'sources/projects/orbit-dock.md') };
}
const MD = OD + '\nShipped v1.6 in Sept 2026.\n';
const up = (value, extra = {}) => ({ decision: 'UPDATE', summary: 's', proposals: [{ targetField: 'projects.orbit-dock.year', value, quote: 'Shipped v1.6 in Sept 2026.', reason: 'r', ...extra }] });
const PREF = { id: 'g-0001', kind: 'preference', text: 'Write months in full' };
await test('A check sends the same request with no notes as before the memory existed', async () => {
  const before = await run({ 'sources/projects/orbit-dock.md': MD }, up('2026 · v1.6'));
  const empty = await run({ 'sources/projects/orbit-dock.md': MD }, up('2026 · v1.6'), { notes: [] });
  assert.deepEqual(empty.calls, before.calls); assert.ok(!('ownerNotes' in empty.calls[0]));
  assert.ok(!('notesGiven' in empty.scan[0]) && !empty.pending[0].memory);
});
await test('Notes reach the model; a suggestion that followed one says so and may write out an abbreviated word', async () => {
  const r = await run({ 'sources/projects/orbit-dock.md': MD }, up('September 2026 · v1.6', { usedNotes: ['g-0001', 'made-up'] }), { notes: [PREF] });
  assert.deepEqual(r.calls[0].ownerNotes, [PREF]);
  assert.equal(r.pending[0].value, 'September 2026 · v1.6'); assert.deepEqual(r.pending[0].memory, ['g-0001'], 'only notes that were really given count');
  assert.deepEqual(r.used, ['g-0001']); assert.equal(r.scan[0].notesGiven, 1); assert.deepEqual(r.scan[0].notesUsed, ['g-0001']);
});
await test('Without citing a note, the usual rule holds: words that are not in the material are refused', async () => {
  const noCite = await run({ 'sources/projects/orbit-dock.md': MD }, up('September 2026 · v1.6'), { notes: [PREF] });
  assert.equal(noCite.pending.length, 0); assert.equal(noCite.calls.length, 2, 'retried once with the reason');
  const invented = await run({ 'sources/projects/orbit-dock.md': MD }, up('December 2027 · v1.6', { usedNotes: ['g-0001'] }), { notes: [PREF] });
  assert.equal(invented.pending.length, 0, 'a note never excuses an invented fact');
  const noNotes = await run({ 'sources/projects/orbit-dock.md': MD }, up('September 2026 · v1.6', { usedNotes: ['g-0001'] }));
  assert.equal(noNotes.pending.length, 0, 'usedNotes means nothing when no notes were given');
});
await test('A note may bring its own words (a term the owner prefers)', async () => {
  const term = { id: 'm-0001', kind: 'preference', text: 'Call releases "edition", not "version"' };
  const r = await run({ 'sources/projects/orbit-dock.md': MD }, up('2026 · edition v1.6', { usedNotes: ['m-0001'] }), { notes: [term] });
  assert.equal(r.pending[0]?.value, '2026 · edition v1.6');
});
await test('The reviewer sees the notes and which suggestion followed them', async () => {
  const r = await run({ 'sources/projects/orbit-dock.md': MD }, up('September 2026 · v1.6', { usedNotes: ['g-0001'] }),
    { notes: [PREF], review: q => ({ ok: true, data: { reviews: q.proposals.map(p => ({ id: p.id, verdict: 'approve', note: 'ok' })) } }) });
  assert.deepEqual(r.reviews[0].ownerNotes, [PREF]); assert.deepEqual(r.reviews[0].proposals[0].followsNotes, ['g-0001']);
  const plain = await run({ 'sources/projects/orbit-dock.md': MD }, up('2026 · v1.6'), { notes: [], review: q => ({ ok: true, data: { reviews: q.proposals.map(p => ({ id: p.id, verdict: 'approve', note: 'ok' })) } }) });
  assert.ok(!('ownerNotes' in plain.reviews[0]) && !('followsNotes' in plain.reviews[0].proposals[0]));
});

// ------------------------------------------------------------------ through a running Sitetend
const home = path.join(tmp, 'host-home'); await fsp.mkdir(path.join(home, '.sitetend'), { recursive: true });
await fsp.writeFile(path.join(home, '.sitetend', 'settings.json'), JSON.stringify({ mcp: { enabled: true, allowWrites: true } }));   // agents switched on, with writes: the memory must still be closed to them
const site = path.join(tmp, 'host-site'); await fsp.cp(fileURLToPath(new URL('../demo-workspace', import.meta.url)), site, { recursive: true });
const port = 56900 + Math.floor(Math.random() * 90);
const host = spawn(process.execPath, ['bin/sitetend.mjs', '--no-open'], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, HOME: home, USERPROFILE: home, SITETEND_HOME: path.join(home, '.sitetend'), PORT: String(port) }, stdio: 'pipe' });
let out = ''; host.stdout.on('data', c => out += c); host.stderr.on('data', c => out += c);
for (let i = 0; i < 100 && !/running/.test(out); i++) await new Promise(r => setTimeout(r, 100));
const tok = JSON.parse(fs.readFileSync(path.join(home, '.sitetend/host.json'), 'utf8')).token;
const api = async (method, p, body, headers = {}) => { const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', 'x-sitetend-token': tok, ...headers }, body: body ? JSON.stringify(body) : undefined }); return res.json(); };
try {
  await test('API: add, list, edit, pause, remove; agents have no access to the memory', async () => {
    assert.ok((await api('POST', '/api/workspace/open', { path: site })).ok);
    let j = await api('GET', '/api/memory'); assert.deepEqual(j.data, { items: [], candidates: [] });
    j = await api('POST', '/api/memory', { kind: 'preference', text: 'Keep the bio under two sentences' }); assert.equal(j.data.id, 'g-0001'); assert.equal(j.data.from.type, 'manual');
    j = await api('POST', '/api/memory/update', { id: 'g-0001', status: 'paused' }); assert.equal(j.data.status, 'paused');
    j = await api('POST', '/api/memory/update', { id: 'g-0001', scope: 'site', status: 'active' }); assert.equal(j.data.id, 'm-0001');
    j = await api('POST', '/api/memory', { kind: 'preference', text: '' }); assert.equal(j.error.code, 'MEMORY_EMPTY');
    j = await api('POST', '/api/memory/remove', { id: 'm-0001' }); assert.equal(j.data.removed, true);
    for (const [m2, p] of [['GET', '/api/memory'], ['POST', '/api/memory'], ['POST', '/api/memory/remove'], ['POST', '/api/proposals/reject-reason']]) {
      j = await api(m2, p, m2 === 'POST' ? { kind: 'preference', text: 'x y' } : undefined, { 'x-sitetend-client': 'mcp:some-agent' });
      assert.equal(j.error.code, 'MCP_FORBIDDEN', `${m2} ${p} is closed to agents`);
    }
    assert.ok(fs.existsSync(path.join(site, '.sitetend', 'memory-log.jsonl')) && fs.existsSync(path.join(home, '.sitetend', 'memory-log.jsonl')));
  });
  await test('Chat (offline demo): "remember …" / "from now on …" in English, Chinese and Spanish is kept as a note with an undo id', async () => {
    const ZH = JSON.parse(read('tests/fixtures/zh-input.json').toString('utf8'));
    for (const [say, want] of [['Remember: write job titles in English', 'write job titles in English'], ['From now on, keep the bio under two sentences', 'keep the bio under two sentences'],
      [ZH.rememberSay, ZH.rememberWant], ['Recuerda que los meses van completos', 'los meses van completos']]) {
      const j = await api('POST', '/api/chat', { message: say });
      assert.equal(j.data.remembered?.[0].text, want, say); assert.equal(j.data.proposed, 0);
    }
    const list = (await api('GET', '/api/memory')).data.items;
    assert.equal(list.length, 4); assert.ok(list.every(i => i.kind === 'preference' && i.scope === 'all' && i.from.type === 'chat'));
    const log = (await api('GET', '/api/chat')).data.messages;
    assert.ok(log.at(-1).remembered[0].id, 'the conversation keeps what was remembered, so undo still works after a restart');
    const j = await api('POST', '/api/chat', { message: 'change my email to a@b.example' }); assert.ok(!j.data.remembered, 'an ordinary request is not remembered');
    for (const i of list) await api('POST', '/api/memory/remove', { id: i.id });
  });
  await test('Reject reasons: optional; "not yet" and "not on my website" become a decision about that field', async () => {
    const p = JSON.parse(await fsp.readFile(path.join(site, 'sources/profile.json'), 'utf8')); p.email = 'new.address@example.org'; p.title = 'Staff Designer';
    await fsp.writeFile(path.join(site, 'sources/profile.json'), JSON.stringify(p, null, 2));
    await api('POST', '/api/check', {});
    const cards = (await api('GET', '/api/state')).data.workspace.proposals.filter(x => x.status === 'PENDING');
    assert.ok(cards.length >= 2, 'the rule demo suggests both changes');
    let j = await api('POST', '/api/proposals/reject-reason', { id: cards[0].id, reason: 'private' }); assert.ok(!j.ok, 'only a rejected suggestion can get a reason');
    await api('POST', '/api/proposals/reject', { id: cards[0].id });
    j = await api('POST', '/api/proposals/reject-reason', { id: cards[0].id, reason: 'nonsense' }); assert.equal(j.error.code, 'BAD_REQUEST');
    j = await api('POST', '/api/proposals/reject-reason', { id: cards[0].id, reason: 'private', text: 'Do not put this on the website: ' + JSON.stringify(cards[0].value) });
    assert.equal(j.data.note.kind, 'decision'); assert.equal(j.data.note.from.type, 'reject'); assert.equal(j.data.note.from.ref, cards[0].id); assert.deepEqual(j.data.note.about.fields, [cards[0].field]);
    await api('POST', '/api/proposals/reject', { id: cards[1].id });
    j = await api('POST', '/api/proposals/reject-reason', { id: cards[1].id, reason: 'wording', text: 'ignored' }); assert.equal(j.data.note, null, '"wording" is recorded but makes no note');
    const st = JSON.parse(await fsp.readFile(path.join(site, '.sitetend', 'analysis.json'), 'utf8')).proposals;
    assert.equal(st.find(x => x.id === cards[0].id).rejectReason, 'private'); assert.equal(st.find(x => x.id === cards[1].id).rejectReason, 'wording');
  });
  await test('Accepting two suggestions after the same small change raises one "remember this?" question; answering saves a preference', async () => {
    const edit = async (field, mk) => {
      const p = JSON.parse(await fsp.readFile(path.join(site, 'sources/profile.json'), 'utf8')); mk(p);
      await fsp.writeFile(path.join(site, 'sources/profile.json'), JSON.stringify(p, null, 2));
      await api('POST', '/api/check', {});
      return (await api('GET', '/api/state')).data.workspace.proposals.find(x => x.status === 'PENDING' && x.field === field);
    };
    const a = await edit('contact.location', p => { p.location = 'Detroit, MI.'; });
    assert.equal(a.value, 'Detroit, MI.');
    let j = await api('POST', '/api/proposals/accept-edited', { id: a.id, value: 'Detroit, MI' }); assert.ok(j.ok, JSON.stringify(j));
    assert.equal((await api('GET', '/api/memory')).data.candidates.length, 0, 'once is not a habit');
    const b = await edit('profile.tagline', p => { p.tagline = 'Designing calm tools.'; });
    j = await api('POST', '/api/proposals/accept-edited', { id: b.id, value: 'Designing calm tools' }); assert.ok(j.ok, JSON.stringify(j));
    const c = (await api('GET', '/api/memory')).data.candidates;
    assert.equal(c.length, 1); assert.equal(c[0].rule.type, 'no-end-period'); assert.equal(c[0].examples.length, 2);
    j = await api('POST', '/api/memory/candidate', { id: c[0].id, remember: true, text: 'No full stop at the end of short lines.' });
    assert.equal(j.data.note.kind, 'preference'); assert.equal(j.data.note.from.type, 'edits');
    const m = (await api('GET', '/api/memory')).data; assert.equal(m.candidates.length, 0); assert.ok(m.items.some(i => i.text === 'No full stop at the end of short lines.'));
  });
} finally { host.kill(); }
await fsp.rm(tmp, RM);
console.log(`${n} memory checks passed`);
