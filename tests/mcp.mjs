// MCP bridge tests: a real `sitetend mcp` child process speaking JSON-RPC over stdio to a real host.
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sitetend-mcp-'));
process.env.SITETEND_HOME = path.join(tmp, 'home');
process.env.SITETEND_ANALYZE_DELAY_MS = '300';
const { startHost } = await import('../src/host/server.mjs');
const BIN = fileURLToPath(new URL('../bin/sitetend.mjs', import.meta.url));
let count = 0;
async function test(name, fn) { await fn(); console.log('✓ ' + name); count++; }
const site = path.join(tmp, 'site');
await fs.cp(new URL('../demo-workspace', import.meta.url), site, { recursive: true });

function startMcp(args = []) {
  const child = spawn(process.execPath, [BIN, 'mcp', ...args], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); const raw = []; let nextId = 1;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    raw.push(line);
    const msg = JSON.parse(line);           // every stdout line must be JSON-RPC
    pending.get(msg.id)?.(msg); pending.delete(msg.id);
  });
  child.stderr.on('data', () => {});
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(Error('timeout ' + method)), 20000);
  });
  const tool = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;
  return { child, rpc, tool, raw, close: () => new Promise(r => { child.on('exit', r); child.stdin.end(); }) };
}
const text = r => r.content.map(c => c.text).join('\n');

let host = await startHost({ port: 0, workspace: site, log: () => {} });
const api = async (method, p, body, headers = {}) => {
  const res = await fetch(`http://127.0.0.1:${host.port}${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-Sitetend-Token': host.token, ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() };
};
const readSite = async () => JSON.parse(await fs.readFile(path.join(site, 'website/content.json'), 'utf8'));
let m;
try {
  await test('initialize negotiates the protocol and lists tools', async () => {
    m = startMcp();
    const init = await m.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-agent', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-06-18'); assert.equal(init.result.serverInfo.name, 'sitetend');
    m.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await m.rpc('tools/list', {});
    assert(list.result.tools.some(t => t.name === 'sitetend_propose_edit'));
    assert(!list.result.tools.some(t => /publish/.test(t.name)), 'no publish tool');
  });

  await test('Agent access is off by default', async () => {
    const r = await m.tool('sitetend_status');
    assert.equal(r.isError, true); assert.match(text(r), /MCP_DISABLED/);
  });

  await test('Enabled (read + suggest): status, fields, propose; the suggestion waits for the user', async () => {
    assert.equal((await api('POST', '/api/settings', { mcp: { enabled: true, allowWrites: false } })).status, 200);
    assert.match(text(await m.tool('sitetend_status')), /Website: site/);
    assert.match(text(await m.tool('sitetend_list_fields')), /contact\.email = /);
    const r = await m.tool('sitetend_propose_edit', { field: 'contact.headline', value: 'Say hello', reason: 'Friendlier call to action.' });
    assert(!r.isError, text(r));
    const s = (await api('GET', '/api/state')).json.data.workspace;
    const p = s.proposals.find(x => x.field === 'contact.headline' && x.status === 'PENDING');
    assert(p); assert.equal(p.kind, 'agent'); assert.equal(p.client, 'test-agent');
    assert.notEqual((await readSite()).contact.headline, 'Say hello', 'nothing written yet');
    assert.match(text(await m.tool('sitetend_list_suggestions')), /Say hello/);
  });

  await test('Agents can list the site\'s lists and suggest a new item; it waits for the user', async () => {
    assert.match(text(await m.tool('sitetend_list_lists')), /projects - Projects[\s\S]*fields: title\*/);
    const r = await m.tool('sitetend_propose_item', { list: 'projects', position: 'start', values: { title: 'Nova Board', year: '2026' }, reason: 'New project.' });
    assert(!r.isError, text(r)); assert.match(text(r), /add "Nova Board" in Projects/);
    const p = (await api('GET', '/api/state')).json.data.workspace.proposals.find(x => x.kind === 'item' && x.status === 'PENDING');
    assert.equal(p.via, 'agent'); assert.equal(p.client, 'test-agent');
    assert(!(await readSite()).projects.some(x => x.title === 'Nova Board'), 'nothing written yet');
    assert.match(text(await m.tool('sitetend_list_suggestions')), /new item in Projects/);
    assert.match(text(await m.tool('sitetend_propose_item', { list: 'nope', values: { title: 'X' }, reason: 'r' })), /LIST_NOT_EDITABLE/);
  });

  await test('Invalid suggestions are refused with a readable error', async () => {
    assert.match(text(await m.tool('sitetend_propose_edit', { field: 'contact.email', value: 'not-an-email', reason: 'x' })), /Error/);
    assert.match(text(await m.tool('sitetend_propose_edit', { field: 'nope.field', value: 'x', reason: 'x' })), /FIELD_NOT_EDITABLE/);
  });

  await test('Accept/undo are refused until the user allows agent writes', async () => {
    const id = (await api('GET', '/api/state')).json.data.workspace.proposals.find(x => x.field === 'contact.headline').id;
    assert.match(text(await m.tool('sitetend_accept', { ids: [id] })), /MCP_READ_ONLY/);
    await api('POST', '/api/settings', { mcp: { enabled: true, allowWrites: true } });
    assert(!(await m.tool('sitetend_accept', { ids: [id] })).isError);
    assert.equal((await readSite()).contact.headline, 'Say hello');
    const h = (await api('GET', '/api/state')).json.data.workspace.history[0];
    assert.equal(h.changes[0].origin, 'agent'); assert.equal(h.changes[0].client, 'test-agent');
    assert(!(await m.tool('sitetend_undo')).isError);
    assert.notEqual((await readSite()).contact.headline, 'Say hello');
  });

  await test('Agents cannot reach settings, keys, direct edits or publishing', async () => {
    const hdr = { 'X-Sitetend-Client': 'mcp:sneaky' };
    for (const [method, p, body] of [['POST', '/api/edit', { field: 'profile.name', value: 'x' }], ['POST', '/api/settings', { mcp: { enabled: true, allowWrites: true } }],
      ['POST', '/api/models/key', { id: 'openai', key: 'x' }], ['POST', '/api/publish', {}], ['GET', '/api/models']]) {
      const r = await api(method, p, body, hdr); assert.equal(r.status, 403, p); assert.equal(r.json.error.code, 'MCP_FORBIDDEN', p);
    }
  });

  await test('stdout carried only JSON-RPC', async () => {
    assert(m.raw.length > 5); for (const l of m.raw) assert.doesNotThrow(() => JSON.parse(l));
    await m.close();
  });

  await test('Without a running host, the bridge starts one in the background', async () => {
    await host.close();
    await assert.rejects(fs.stat(path.join(process.env.SITETEND_HOME, 'host.json')));
    m = startMcp([site]);
    await m.rpc('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'cursor' } });
    const r = await m.tool('sitetend_status');
    assert(!r.isError, text(r)); assert.match(text(r), /Website: site/);
    await m.close();
  });
  console.log(`${count} MCP checks passed`);
} finally {
  try { m?.child.kill(); } catch {}
  try { await host.close(); } catch {}
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
