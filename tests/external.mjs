// External sources (Sitetend as an MCP client) and webhooks, against a real host, a fake MCP server (stdio and
// Streamable HTTP) and a local webhook receiver.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sitetend-ext-'));
process.env.SITETEND_HOME = path.join(tmp, 'home');
process.env.SITETEND_ANALYZE_DELAY_MS = '300';
const { startHost } = await import('../src/host/server.mjs');
const { mapEvent } = await import('../src/host/webhooks.mjs');

let count = 0;
async function test(name, fn) { await fn(); console.log('✓ ' + name); count++; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FAKE = fileURLToPath(new URL('./helpers/fake-mcp-server.mjs', import.meta.url));
const notesFile = path.join(tmp, 'notes.md');
process.env.NOTES_FILE = notesFile;
const site = path.join(tmp, 'site');
await fs.cp(new URL('../demo-workspace', import.meta.url), site, { recursive: true });

const host = await startHost({ port: 0, log: () => {} });
const api = async (method, p, body, headers = {}) => {
  const res = await fetch(`http://127.0.0.1:${host.port}${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-Sitetend-Token': host.token, ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const ok = async (...a) => { const r = await api(...a); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.data; };
const ext = p => path.join(site, 'sources/external', p);
await fs.writeFile(notesFile, '# Notes\n\nEmail: alex.updated@example.com\n');
const stdioCmd = `"${process.execPath}" "${FAKE}"`;

// webhook receiver
const received = [];
const recv = http.createServer(async (req, res) => { let b = ''; for await (const c of req) b += c; received.push({ headers: req.headers, body: b }); res.writeHead(200); res.end('ok'); });
await new Promise(r => recv.listen(0, '127.0.0.1', r));
const hookUrl = `http://127.0.0.1:${recv.address().port}/hook`;

// HTTP MCP server (with a key)
const httpPort = 40000 + Math.floor(Math.random() * 20000);
const httpProc = spawn(process.execPath, [FAKE, 'http', String(httpPort), 'sekret'], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => httpProc.stdout.once('data', r));

try {
  await ok('POST', '/api/workspace/open', { path: site });

  await test('Discover lists a stdio server\'s resources (all pages) and tools', async () => {
    const d = await ok('POST', '/api/sources/discover', { transport: 'stdio', command: stdioCmd });
    assert.equal(d.server.name, 'fake-notes');
    assert.deepEqual(d.resources.map(r => r.uri), ['notes://profile', 'notes://data.json']);
    assert.deepEqual(d.tools.map(t => [t.name, t.readOnly]), [['get_bio', true], ['broken', false]]);
    assert.deepEqual(d.tools[0].required, ['lang']);
  });

  await test('A saved source is read into sources/external/ on "Check for updates"', async () => {
    const list = await ok('POST', '/api/sources/save', { name: 'My Notes', transport: 'stdio', command: stdioCmd,
      items: [{ type: 'resource', uri: 'notes://profile', label: 'Profile notes' }, { type: 'resource', uri: 'notes://data.json', label: 'Data' }, { type: 'tool', name: 'get_bio', args: { lang: 'en' }, label: 'Bio' }] });
    assert.equal(list.length, 1); assert.equal(list[0].items.length, 3);
    await ok('POST', '/api/check', {});
    assert.match(await fs.readFile(ext('my-notes/profile-notes.md'), 'utf8'), /alex\.updated@example\.com/);
    assert.equal(await fs.readFile(ext('my-notes/data.json'), 'utf8'), '{"github":"alexm"}');
    assert.equal(await fs.readFile(ext('my-notes/bio.md'), 'utf8'), 'Bio (en): designer.');
    const s = (await ok('GET', '/api/state')).workspace;
    assert.equal(s.sources[0].last.ok, true); assert.equal(s.sources[0].last.files, 3); assert.equal(s.sources[0].last.changed, 3);
  });

  await test('Unchanged content is not rewritten; changed content is, becomes a suggestion, and a failing tool is reported', async () => {
    // A new material only becomes the comparison point once a change is written (the rule mode compares old → new values),
    // so first write the demo's own email change, which the site then shows: alex.updated@example.com.
    await ok('POST', '/api/demo/change', { kind: 'email' }); await ok('POST', '/api/check', {});
    const first = (await ok('GET', '/api/state')).workspace.proposals.find(p => p.status === 'PENDING' && p.field === 'contact.email');
    await ok('POST', '/api/proposals/accept', { ids: [first.id] });
    const st1 = await fs.stat(ext('my-notes/data.json'));
    await fs.writeFile(notesFile, '# Notes\n\nEmail: alex.new@example.com\n');
    const cur = (await ok('GET', '/api/state')).workspace.sources[0];
    await ok('POST', '/api/sources/save', { ...cur, items: [...cur.items, { type: 'tool', name: 'broken', args: {}, label: 'Broken' }] });
    await ok('POST', '/api/sources/sync', {});
    assert.equal((await fs.stat(ext('my-notes/data.json'))).mtimeMs, st1.mtimeMs);
    assert.match(await fs.readFile(ext('my-notes/profile-notes.md'), 'utf8'), /alex\.new@/);
    const last = (await ok('GET', '/api/state')).workspace.sources[0].last;
    assert.equal(last.ok, false); assert.equal(last.changed, 1); assert.match(last.error, /Broken: boom/);
    const s = (await ok('GET', '/api/state')).workspace;
    assert(s.proposals.some(p => p.status === 'PENDING' && p.value === 'alex.new@example.com' && p.sourcePath.includes('external/my-notes')), 'the changed email became a suggestion');
  });

  await test('Streamable HTTP server with a key: the key goes to .env only, never settings.json', async () => {
    const url = `http://127.0.0.1:${httpPort}/mcp`;
    assert.equal((await api('POST', '/api/sources/discover', { transport: 'http', url })).json.error.code, 'MCP_AUTH');
    const d = await ok('POST', '/api/sources/discover', { transport: 'http', url, token: 'sekret' });
    assert.equal(d.resources.length, 2);
    const list = await ok('POST', '/api/sources/save', { name: 'Cloud', transport: 'http', url, token: 'sekret', items: [{ type: 'resource', uri: 'notes://data.json', label: 'Cloud data' }] });
    assert.equal(list[1].hasKey, true);
    await ok('POST', '/api/sources/sync', {});
    assert.equal(await fs.readFile(ext('cloud/cloud-data.json'), 'utf8'), '{"github":"alexm"}');
    const settings = await fs.readFile(path.join(process.env.SITETEND_HOME, 'settings.json'), 'utf8');
    assert(!settings.includes('sekret')); assert.match(await fs.readFile(path.join(process.env.SITETEND_HOME, '.env'), 'utf8'), /SITETEND_MCP_SRC_\w+=sekret/);
    // discover on the saved source reuses the saved key
    assert.equal((await ok('POST', '/api/sources/discover', { id: list[1].id })).resources.length, 2);
  });

  await test('Plain http to an internet address and agent (MCP) access are refused; removing a source drops its key', async () => {
    assert.equal((await api('POST', '/api/sources/save', { name: 'X', transport: 'http', url: 'http://example.com/mcp' })).json.error.code, 'BAD_ENDPOINT');
    await ok('POST', '/api/settings', { mcp: { enabled: true, allowWrites: true } });
    for (const p of ['/api/sources/save', '/api/sources/discover', '/api/webhooks/save', '/api/webhooks/incoming'])
      assert.equal((await api('POST', p, { name: 'x', transport: 'stdio', command: 'echo hi', url: hookUrl, events: ['change.applied'], enabled: true }, { 'X-Sitetend-Client': 'mcp:agent' })).status, 403, p);
    const id = (await ok('GET', '/api/state')).workspace.sources[1].id;
    await ok('POST', '/api/sources/remove', { id });
    assert(!(await fs.readFile(path.join(process.env.SITETEND_HOME, '.env'), 'utf8')).includes('sekret'));
    assert(await fs.stat(ext('cloud/cloud-data.json')), 'files already read stay');
  });

  await test('Sources are per website and come back after a restart of the session', async () => {
    await ok('POST', '/api/workspace/open', { path: site });
    const s = (await ok('GET', '/api/state')).workspace;
    assert.equal(s.sources.length, 1); assert.equal(s.sources[0].name, 'My Notes'); assert(s.sources[0].last?.at, 'last read is remembered');
  });

  await test('Webhook: signed, carries counts but no material content; test button; wrong events refused', async () => {
    assert.equal((await api('POST', '/api/webhooks/save', { url: hookUrl, events: ['nope'] })).json.error.code, 'BAD_HOOK');
    const h = await ok('POST', '/api/webhooks/save', { url: hookUrl, events: ['suggestions.ready', 'change.applied'] });
    const hook = h.hooks[0]; assert.equal(hook.secret.length, 48);
    assert(!(await fs.readFile(path.join(process.env.SITETEND_HOME, 'settings.json'), 'utf8')).includes(hook.secret));
    const t = await ok('POST', '/api/webhooks/test', { id: hook.id }); assert.equal(t.ok, true); assert.equal(t.status, 200);
    const p = (await ok('GET', '/api/state')).workspace.proposals.find(x => x.status === 'PENDING');
    received.length = 0; await ok('POST', '/api/proposals/accept', { ids: [p.id] });
    for (let i = 0; i < 40 && !received.some(x => x.headers['x-sitetend-event'] === 'change.applied'); i++) await sleep(100);
    assert(received.some(x => x.headers['x-sitetend-event'] === 'change.applied'));
    received.length = 0;
    await fs.writeFile(notesFile, '# Notes\n\nEmail: alex.hook@example.com\n');
    await ok('POST', '/api/check', {});
    for (let i = 0; i < 40 && !received.length; i++) await sleep(100);
    const r = received.find(x => x.headers['x-sitetend-event'] === 'suggestions.ready'); assert(r, 'delivered');
    assert.equal(r.headers['x-sitetend-signature'], 'sha256=' + crypto.createHmac('sha256', hook.secret).update(r.body).digest('hex'));
    const body = JSON.parse(r.body); assert(body.data.n >= 1); assert.equal(body.text, body.summary); assert.equal(body.site.name, 'Alex Morgan');
    assert(!r.body.includes('alex.hook@example.com'), 'no content in the payload');
    assert.equal((await ok('GET', '/api/webhooks')).hooks[0].last.ok, true);
    await ok('POST', '/api/webhooks/remove', { id: hook.id });
    assert.equal((await ok('GET', '/api/webhooks')).hooks.length, 0);
  });

  await test('Event mapping', async () => {
    assert.equal(mapEvent('analysis.completed', { pending: 0 }), null);
    assert.equal(mapEvent('analysis.completed', { pending: 0, errorCode: 'PROVIDER_AUTH' }).event, 'analysis.failed');
    assert.equal(mapEvent('state', { reason: 'undo' }).event, 'change.undone');
    assert.equal(mapEvent('state', { reason: 'publish' }).event, 'site.published');
    assert.equal(mapEvent('state', { reason: 'settings' }), null);
    assert.equal(mapEvent('sources.synced', { changed: 0, failed: [] }), null);
  });

  await test('Incoming webhook: only with its own key, runs a check, off by default', async () => {
    const post = (headers = {}) => fetch(`http://127.0.0.1:${host.port}/hooks/check`, { method: 'POST', headers });
    assert.equal((await post({ Authorization: 'Bearer x' })).status, 401);
    const inc = (await ok('POST', '/api/webhooks/incoming', { enabled: true })).incoming;
    assert.equal(inc.enabled, true); assert.match(inc.url, /\/hooks\/check$/);
    assert.equal((await post({ Authorization: 'Bearer wrong-' + inc.key.slice(6) })).status, 401);
    const r = await post({ Authorization: 'Bearer ' + inc.key }); assert.equal(r.status, 202);
    assert.equal((await post({ 'X-Sitetend-Key': inc.key })).status, 202);
    await ok('POST', '/api/webhooks/incoming', { enabled: false });
    assert.equal((await post({ Authorization: 'Bearer ' + inc.key })).status, 401);
  });
  await test('Choosing a folder that is not a website: Sitetend lists the websites inside it', async () => {
    const parent = path.join(tmp, 'Documents'); await fs.mkdir(path.join(parent, 'photos'), { recursive: true });
    await fs.cp(new URL('../demo-workspace', import.meta.url), path.join(parent, 'projects', 'portfolio'), { recursive: true });
    await fs.cp(new URL('../eval/sites/ext-sb-resume/website', import.meta.url), path.join(parent, 'old', 'resume'), { recursive: true });
    assert.equal((await api('POST', '/api/workspace/open', { path: parent })).json.error.code, 'NOT_A_SITE');
    const r = await ok('POST', '/api/workspace/find', { path: parent });
    assert.deepEqual(r.sites.map(x => x.rel.replace(/\\/g, '/')).sort(), ['old/resume', 'projects/portfolio']);
    assert.equal(r.sites.find(x => x.rel.includes('portfolio')).name, 'Alex Morgan');
    assert.equal((await ok('POST', '/api/workspace/find', { path: path.join(parent, 'photos') })).sites.length, 0);
  });
} finally {
  httpProc.kill(); recv.close(); await host.close();
  await sleep(300); await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
}
console.log(`\n${count} external-source and webhook checks passed`);
