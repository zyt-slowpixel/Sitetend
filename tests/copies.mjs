// The same words in two places (a page and its phone version): accepting a suggestion for one updates the other copies.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sitetend-copies-'));
process.env.SITETEND_HOME = path.join(tmp, 'home');
const { startHost } = await import('../src/host/server.mjs');
let count = 0;
async function test(name, fn) { await fn(); console.log('✓ ' + name); count++; }
const site = path.join(tmp, 'web');
await fs.mkdir(path.join(site, 'p'), { recursive: true });
const page = '<!doctype html><html><head><title>Experience</title></head><body><h2>7 Cups</h2><p>Volunteer Listener · 2022–2025</p><h3>Volunteer Listener · 2022–2025</h3><p>Short</p><a href="https://example.com/listener-2022-2025">Volunteer Listener · 2022–2025</a></body></html>';
const phone = '<!doctype html><html><head><title>Phone</title></head><body><div><span>Volunteer Listener · 2022–2025</span></div><p>Volunteer Listener · 2022–2025 and more</p><p>Short</p></body></html>';
await fs.writeFile(path.join(site, 'p/experience.html'), page);
await fs.writeFile(path.join(site, 'm.html'), phone);
const host = await startHost({ port: 0, log: () => {} });
const api = async (method, p, body) => { const res = await fetch(`http://127.0.0.1:${host.port}${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-Sitetend-Token': host.token }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, json: await res.json().catch(() => null) }; };
const ok = async (...a) => { const r = await api(...a); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.data; };
const read = f => fs.readFile(path.join(site, f), 'utf8');
try {
  await ok('POST', '/api/workspace/open', { path: site });
  const fields = await ok('GET', '/api/fields');
  const pick = (file, v) => fields.find(f => f.path.startsWith(file + '::') && f.value === v).path;
  await test('Accepting one copy updates the other copies of exactly the same words, and marks their own card done', async () => {
    const a = pick('p/experience.html', 'Volunteer Listener · 2022–2025'), b = pick('m.html', 'Volunteer Listener · 2022–2025');
    await ok('POST', '/api/proposals/propose', { field: a, value: 'Volunteer Listener · 2022–2026', reason: 'resume' });
    await ok('POST', '/api/proposals/propose', { field: b, value: 'Volunteer Listener · 2022–2026', reason: 'resume' });
    const ws = (await ok('GET', '/api/state')).workspace, card = ws.proposals.find(p => p.field === a && p.status === 'PENDING');
    assert.ok(ws.proposals.some(p => p.field === b && p.status === 'PENDING'));
    await ok('POST', '/api/proposals/accept', { ids: [card.id] });
    const e = await read('p/experience.html'), m = await read('m.html');
    assert.ok(e.includes('<p>Volunteer Listener · 2022–2026</p>') && m.includes('<span>Volunteer Listener · 2022–2026</span>'));
    assert.ok(e.includes('<h3>Volunteer Listener · 2022–2025</h3>'), 'the same words in the same file are left alone');
    assert.ok(e.includes('href="https://example.com/listener-2022-2025"'), 'links are not touched');
    assert.ok(m.includes('Volunteer Listener · 2022–2025 and more'), 'only exactly the same words');
    const after = (await ok('GET', '/api/state')).workspace.proposals;
    assert.ok(!after.some(p => p.field === b && p.status === 'PENDING'), 'the card for the other copy is done');
  });
  await test('Reverting it from the history takes back the change and its copies', async () => {
    const h = (await ok('GET', '/api/state')).workspace;
    const entry = (h.history || []).find(x => /2022–2026/.test(JSON.stringify(x)));
    assert.ok(entry, 'a history entry for the change');
    await ok('POST', '/api/history/revert', { id: entry.logId });
    assert.equal(await read('p/experience.html'), page); assert.equal(await read('m.html'), phone);
    await ok('POST', '/api/undo', {});   // takes back the revert: the change is in place again
    assert.ok((await read('m.html')).includes('2022–2026'));
  });
  await test('One undo takes back the change and its copies', async () => {
    await ok('POST', '/api/undo', {});
    assert.equal(await read('p/experience.html'), page); assert.equal(await read('m.html'), phone);
  });
  await test('Short words are not treated as copies', async () => {
    const s = fields.find(f => f.path.startsWith('p/experience.html::') && f.value === 'Short').path;
    await ok('POST', '/api/proposals/propose', { field: s, value: 'Longer now', reason: 'x' });
    const card = (await ok('GET', '/api/state')).workspace.proposals.find(p => p.field === s && p.status === 'PENDING');
    await ok('POST', '/api/proposals/accept', { ids: [card.id] });
    assert.ok((await read('p/experience.html')).includes('<p>Longer now</p>') && (await read('m.html')).includes('<p>Short</p>'));
  });
} finally { await host.close(); await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {}); }
console.log(`\n${count} copy checks passed`);
