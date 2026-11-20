// Chat agent tests: rule mode offline, and a fake OpenAI-compatible model that uses tool calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
const ZH = JSON.parse(readFileSync(new URL('./fixtures/zh-input.json', import.meta.url), 'utf8'));   // Chinese input samples
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sitetend-chat-'));
process.env.SITETEND_HOME = path.join(tmp, 'home');
process.env.SITETEND_ANALYZE_DELAY_MS = '300';
const { startHost } = await import('../src/host/server.mjs');
const { saveModels, loadModels, setEnvKey } = await import('../src/host/user-config.mjs');
let count = 0;
async function test(name, fn) { await fn(); console.log('✓ ' + name); count++; }
const site = path.join(tmp, 'site');
await fs.cp(new URL('../demo-workspace', import.meta.url), site, { recursive: true });

// Fake model: scripted replies; records requests.
const seen = []; let script = [];
const fake = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c; const body = JSON.parse(b); seen.push({ body, auth: req.headers.authorization });
  const step = script.shift() || { content: 'ok' };
  if (step.status) { res.writeHead(step.status, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: step.error } })); }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: step.content ?? null, tool_calls: step.tool_calls } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const fakeUrl = `http://127.0.0.1:${fake.address().port}/v1/chat/completions`;

const host = await startHost({ port: 0, workspace: site, log: () => {} });
const api = async (method, p, body) => { const r = await fetch(`http://127.0.0.1:${host.port}${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-Sitetend-Token': host.token }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() }; };
const ok = async (...a) => { const r = await api(...a); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.data; };
const pending = async () => (await ok('GET', '/api/state')).workspace.proposals.filter(p => p.status === 'PENDING');

try {
  await test('Rule mode understands "change <field> to <value>" in English and Chinese', async () => {
    let r = await ok('POST', '/api/chat', { message: 'Change my email to chat@example.com' });
    assert.equal(r.proposed, 1);
    let p = (await pending()).find(x => x.field === 'contact.email');
    assert.equal(p.value, 'chat@example.com'); assert.equal(p.kind, 'chat'); assert.equal(p.quote, 'Change my email to chat@example.com');
    r = await ok('POST', '/api/chat', { message: ZH.chatChangeRole });
    assert.equal(r.proposed, 1); assert((await pending()).some(x => x.field === 'profile.role' && x.value === ZH.roleValue));
    r = await ok('POST', '/api/chat', { message: 'make it nicer' });
    assert.equal(r.proposed, 0); assert.match(r.reply, /rule demo/i);
  });

  await test('Chat suggestions survive a materials scan and nothing is written before accepting', async () => {
    await ok('POST', '/api/check', {});
    assert((await pending()).some(x => x.kind === 'chat' && x.field === 'contact.email'));
    const d = JSON.parse(await fs.readFile(path.join(site, 'website/content.json'), 'utf8'));
    assert.notEqual(d.contact.email, 'chat@example.com');
  });

  await test('Model mode: tool calls create a reviewed suggestion; usage is counted', async () => {
    const m = await loadModels(); m.profiles.push({ id: 'fake', label: 'Fake', type: 'openai-compatible', endpoint: fakeUrl, model: 'fake-1', keyRef: 'SITETEND_KEY_FAKE' }); await saveModels(m);
    await setEnvKey('SITETEND_KEY_FAKE', 'k-123'); await ok('POST', '/api/models/active', { id: 'fake' });
    script = [
      { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_fields', arguments: '{}' } }] },
      { tool_calls: [{ id: 'c2', type: 'function', function: { name: 'propose_edit', arguments: JSON.stringify({ field: 'about.headline', value: 'Tools that respect your time', reason: 'Shorter headline as requested.' }) } }] },
      { content: 'I suggested a shorter About headline.' },
    ];
    seen.length = 0;
    const before = (await ok('GET', '/api/state')).workspace.usage.totalTokens;
    const r = await ok('POST', '/api/chat', { message: 'Make the About headline shorter' });
    assert.equal(r.reply, 'I suggested a shorter About headline.'); assert.equal(r.proposed, 1); assert.equal(r.tokens, 360);
    assert.equal(seen[0].auth, 'Bearer k-123'); assert(seen[0].body.tools.some(t => t.function.name === 'propose_edit'));
    assert(seen[1].body.messages.some(m => m.role === 'tool' && /about\.headline/.test(m.content)), 'tool results are sent back');
    const p = (await pending()).find(x => x.field === 'about.headline'); assert.equal(p.value, 'Tools that respect your time'); assert.equal(p.client, 'you');
    assert.equal((await ok('GET', '/api/state')).workspace.usage.totalTokens - before, 360);
    const log = (await ok('GET', '/api/chat')).messages; assert.equal(log.at(-1).tokens, 360); assert.equal(log.at(-2).content, 'Make the About headline shorter');
  });

  await test('Previous turns are sent as context', async () => {
    script = [{ content: 'Sure.' }]; seen.length = 0;
    await ok('POST', '/api/chat', { message: 'Thanks' });
    assert(seen[0].body.messages.some(m => m.role === 'user' && m.content === 'Make the About headline shorter'));
  });

  await test('Models without tool calling fall back to a JSON answer', async () => {
    script = [{ status: 400, error: 'tools are not supported by this model' }, { content: JSON.stringify({ reply: 'Done.', edits: [{ field: 'contact.location', value: 'Detroit, MI', reason: 'Moved.' }] }) }];
    const r = await ok('POST', '/api/chat', { message: 'I moved to Detroit' });
    assert.equal(r.reply, 'Done.'); assert.equal(r.proposed, 1);
    assert((await pending()).some(x => x.field === 'contact.location' && x.value === 'Detroit, MI'));
  });

  await test('Invalid tool arguments are reported back to the model, not crashing the chat', async () => {
    script = [{ tool_calls: [{ id: 'x', type: 'function', function: { name: 'propose_edit', arguments: JSON.stringify({ field: 'contact.email', value: 'nope', reason: 'r' }) } }] }, { content: 'That email looks invalid.' }];
    seen.length = 0;
    const r = await ok('POST', '/api/chat', { message: 'set email to nope' });
    assert.equal(r.proposed, 1 - 1); assert.equal(r.reply, 'That email looks invalid.');
    assert(seen[1].body.messages.some(m => m.role === 'tool' && /"ok":false/.test(m.content)));
  });

  await test('Chat can add a new item to a list (and replace one); it is reviewed like any other card', async () => {
    const titles = async () => JSON.parse(await fs.readFile(path.join(site, 'website/content.json'), 'utf8')).projects.map(p => p.title);
    const before = await titles();
    script = [
      { tool_calls: [{ id: 'l1', type: 'function', function: { name: 'list_lists', arguments: '{}' } }] },
      { tool_calls: [{ id: 'l2', type: 'function', function: { name: 'propose_new_item', arguments: JSON.stringify({ list: 'projects', position: 'start', values: { title: 'Nova Board', summary: 'A shared planning board.', year: '2026' }, reason: 'New project from the chat.' }) } }] },
      { content: 'I suggested adding Nova Board.' }];
    seen.length = 0;
    const r = await ok('POST', '/api/chat', { message: 'Add my new project Nova Board (2026): a shared planning board.' });
    assert.equal(r.proposed, 1); assert(seen[0].body.tools.some(t => t.function.name === 'propose_new_item'));
    assert(seen[1].body.messages.some(m => m.role === 'tool' && /"id":"projects"/.test(m.content)), 'the model sees the lists');
    await ok('POST', '/api/check', { reanalyze: true });   // an analysis of the materials must not drop chat cards
    const card = (await pending()).find(p => p.kind === 'item');
    assert.equal(card.title, 'Nova Board'); assert.equal(card.sourcePath, 'chat:you'); assert.equal(await titles().then(t => t.length), before.length, 'nothing written yet');
    await ok('POST', '/api/proposals/accept', { ids: [card.id] });
    assert.deepEqual(await titles(), ['Nova Board', ...before]);
    // replace by title; unknown list / duplicate are reported back to the model
    script = [{ tool_calls: [
      { id: 'r1', type: 'function', function: { name: 'propose_new_item', arguments: JSON.stringify({ list: 'projects', replace: before[1], values: { title: 'Atlas Notes' }, reason: 'Swap.' }) } },
      { id: 'r2', type: 'function', function: { name: 'propose_new_item', arguments: JSON.stringify({ list: 'nope', values: { title: 'X' }, reason: 'r' }) } },
      { id: 'r3', type: 'function', function: { name: 'propose_new_item', arguments: JSON.stringify({ list: 'projects', values: { title: 'Nova Board' }, reason: 'r' }) } }] }, { content: 'ok' }];
    seen.length = 0;
    assert.equal((await ok('POST', '/api/chat', { message: 'Replace it' })).proposed, 1);
    const tools = seen[1].body.messages.filter(m => m.role === 'tool').map(m => m.content).join('\n');
    assert.match(tools, /"ok":false.*LIST_NOT_EDITABLE/s); assert.match(tools, /NO_CHANGE/);
    const swap = (await pending()).find(p => p.kind === 'item' && p.title === 'Atlas Notes');
    assert.equal(swap.op, 'replace'); assert.equal(swap.replacedTitle, before[1]);
    await ok('POST', '/api/proposals/accept', { ids: [swap.id] });
    const now = await titles(); assert.equal(now.length, before.length + 1); assert(now.includes('Atlas Notes') && !now.includes(before[1]));
    const h = (await ok('GET', '/api/state')).workspace.history[0]; assert(h.changes.some(c => c.item?.title === 'Atlas Notes' && c.origin === 'chat'));
  });

  await test('Model errors in chat say what happened (wrong key, server unreachable)', async () => {
    script = [{ status: 401, error: 'bad key' }];
    let r = await api('POST', '/api/chat', { message: 'Hello' });
    assert.equal(r.json.ok, false); assert.equal(r.json.error.code, 'PROVIDER_AUTH');
    const m = await loadModels(); m.profiles.push({ id: 'down', label: 'Down', type: 'openai-compatible', endpoint: 'http://127.0.0.1:9/v1/chat/completions', model: 'x', keyRef: 'SITETEND_KEY_FAKE' }); await saveModels(m);
    await ok('POST', '/api/models/active', { id: 'down' });
    r = await api('POST', '/api/chat', { message: 'Hello' });
    assert.equal(r.json.ok, false); assert.equal(r.json.error.code, 'PROVIDER_UNREACHABLE'); assert.doesNotMatch(r.json.error.message, /^fetch failed$/);
    await ok('POST', '/api/models/active', { id: 'fake' });
  });

  await test('Clearing the conversation', async () => {
    await ok('POST', '/api/chat/clear', {}); assert.equal((await ok('GET', '/api/chat')).messages.length, 0);
  });
  console.log(`${count} chat checks passed`);
} finally { await host.close(); fake.close(); await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
