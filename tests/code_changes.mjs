// B: code changes written by the model. The checks on an edit, and the whole way through the chat with a fake model:
// read the page, suggest a change, see it refused when unsafe, accept it, undo it.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { condense, expand, around, applyEdits, checkChange, addedWords } from '../src/agent/code-edits.js';
let n = 0;
async function test(name, fn) { await fn(); console.log('✓ ' + name); n++; }
const LONG = 'M0 0 ' + 'L1 1 '.repeat(100);
const PAGE = `<!doctype html><html><head><title>Me</title><style>${'.x{color:red}'.repeat(40)}</style></head><body>
<div id="beam" style="position:absolute;top:248px">
  <div class="row"><div style="width:392px"><div class="t">Psychology Research Lab</div><p>Rebuilt experiments.</p></div></div>
</div>
<svg><path d="${LONG}"/></svg>
<script>${'var a=1;'.repeat(60)}</script>
</body></html>`;

await test('The model reads a short copy: long scripts, styles and attribute values become tokens, and come back exactly', async () => {
  const { view, map } = condense(PAGE);
  assert.ok(view.length < PAGE.length / 2 && /⟦S1⟧/.test(view) && /⟦A\d⟧/.test(view) && /⟦S\d⟧<\/script>/.test(view));
  assert.equal(expand(view, map), PAGE);
  assert.ok(around(view, 'research lab').text.includes('Psychology Research Lab'));
  assert.equal(around(view, 'nowhere'), null);
});
await test('Edits must match once, must not overlap, and must change something', async () => {
  assert.throws(() => applyEdits(PAGE, [{ find: 'Not here', replace: 'x' }]), { code: 'CODE_FIND_MISSING' });
  assert.throws(() => applyEdits(PAGE, [{ find: '<div', replace: 'x' }]), { code: 'CODE_FIND_REPEATED' });
  assert.throws(() => applyEdits(PAGE, [{ find: 'Psychology Research', replace: 'a' }, { find: 'Research Lab', replace: 'b' }]), { code: 'CODE_FIND_OVERLAP' });
  assert.throws(() => applyEdits(PAGE, [{ find: 'Rebuilt', replace: 'Rebuilt' }]), { code: 'NO_CHANGE' });
  assert.equal(applyEdits(PAGE, [{ find: 'Rebuilt experiments.', replace: 'Rebuilt 8,000 records.' }, { find: '<title>Me', replace: '<title>Me too' }]), PAGE.replace('Rebuilt experiments.', 'Rebuilt 8,000 records.').replace('<title>Me', '<title>Me too'));
});
await test('A change may not add scripts, handlers, javascript: links, frames, forms or files from other websites, and must close what it opens', async () => {
  const add = s => PAGE.replace('<p>Rebuilt experiments.</p>', '<p>Rebuilt experiments.</p>' + s);
  for (const [bad, what] of [['<script>alert(1)</script>', 'script'], ['<p onclick="x()">Hi</p>', 'event handler'], ['<a href="javascript:x()">Hi</a>', 'javascript: link'], ['<iframe src="a.html"></iframe>', 'frame'],
    ['<img src="https://evil.example/x.png">', 'outside picture or file'], ['<form action="/x"></form>', 'form'], ['<embed src="a.swf">', 'embedded object']])
    assert.throws(() => checkChange('p.html', PAGE, add(bad)), e => e.code === 'CODE_UNSAFE' && e.what === what, bad);
  assert.throws(() => checkChange('p.html', PAGE, add('<div class="row"><p>Open</p>')), { code: 'CODE_UNBALANCED' });
  assert.throws(() => checkChange('s.css', '.a{}', '.a{}\n@import url(https://evil.example/x.css);'), { code: 'CODE_UNSAFE' });
  checkChange('p.html', PAGE, add('<div style="width:392px"><div class="t">Sitetend</div><p>Built it.<br>Shipped it.</p><img src="img/s.png" alt="Sitetend"></div>'));
  assert.deepEqual(addedWords([{ find: '<p>Rebuilt experiments.</p>', replace: '<p>Rebuilt experiments.</p><div class="t">Sitetend</div><p>Built &amp; shipped.</p>' }]), ['Sitetend', 'Built & shipped.']);
});

// ---- the whole way, through the chat with a fake model
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sitetend-code-'));
process.env.SITETEND_HOME = path.join(tmp, 'home');
const { startHost } = await import('../src/host/server.mjs');
const { saveModels, loadModels, setEnvKey } = await import('../src/host/user-config.mjs');
const site = path.join(tmp, 'web'); await fs.mkdir(path.join(site, 'p'), { recursive: true });
await fs.writeFile(path.join(site, 'index.html'), '<!doctype html><html><head><title>Home</title></head><body><h1>Me</h1><p>Welcome to my site.</p></body></html>');
await fs.writeFile(path.join(site, 'p/experience.html'), PAGE);
const seen = []; let script = [];
const fake = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c; seen.push(JSON.parse(b));
  const step = script.shift() || { content: 'ok' };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: step.content ?? null, tool_calls: step.tool_calls } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const host = await startHost({ port: 0, log: () => {} });
const api = async (method, p, body) => { const r = await fetch(`http://127.0.0.1:${host.port}${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-Sitetend-Token': host.token }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
const ok = async (...a) => { const r = await api(...a); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.data; };
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const toolResult = (i, id) => JSON.parse(seen[i].messages.find(m => m.role === 'tool' && m.tool_call_id === id).content);
const read = f => fs.readFile(path.join(site, f), 'utf8');
try {
  await ok('POST', '/api/workspace/open', { path: site });
  const m = await loadModels(); m.profiles.push({ id: 'fake', label: 'Fake', type: 'openai-compatible', endpoint: `http://127.0.0.1:${fake.address().port}/v1/chat/completions`, model: 'fake-1', keyRef: 'SITETEND_KEY_FAKE' }); await saveModels(m);
  await setEnvKey('SITETEND_KEY_FAKE', 'k'); await ok('POST', '/api/models/active', { id: 'fake' });

  const entry = '<div style="width:392px"><div class="t">Sitetend</div><p>Built a local agent that keeps a website in sync.</p></div>';
  await test('Chat: the model reads the page with tokens, a refused edit comes back as an error it can fix, then a card is made', async () => {
    seen.length = 0;
    script = [
      { tool_calls: [call('r1', 'read_page', { file: 'p/experience.html', phrase: 'Research Lab' })] },
      { tool_calls: [call('b1', 'propose_code_change', { file: 'p/experience.html', summary: 'Add Sitetend', edits: [{ find: '<p>Rebuilt experiments.</p></div>', replace: '<p>Rebuilt experiments.</p></div><script>x()</script>' }] })] },
      { tool_calls: [call('b2', 'propose_code_change', { file: 'p/experience.html', summary: 'Adds Sitetend to the research list', edits: [{ find: '<p>Rebuilt experiments.</p></div>', replace: '<p>Rebuilt experiments.</p></div>' + entry }] })] },
      { content: 'I suggested adding Sitetend; check it in the preview.' }];
    const r = await ok('POST', '/api/chat', { message: 'Add my Sitetend project next to the research lab' });
    assert.equal(r.proposed, 1);
    assert.ok(seen[0].tools.some(t => t.function.name === 'propose_code_change') && /propose_code_change/.test(seen[0].messages[0].content));
    const page = toolResult(1, 'r1'); assert.ok(page.text.includes('Psychology Research Lab') && /⟦/.test(page.text) && !page.text.includes('L1 1 L1 1'));
    assert.equal(toolResult(2, 'b1').code, 'CODE_UNSAFE');
    const card = (await ok('GET', '/api/state')).workspace.proposals.find(p => p.kind === 'code' && p.status === 'PENDING');
    assert.equal(card.file, 'p/experience.html'); assert.deepEqual(card.words, ['Sitetend', 'Built a local agent that keeps a website in sync.']);
    assert.equal(await read('p/experience.html'), PAGE, 'nothing is written before accepting');
  });
  await test('Accepting writes exactly that change in one step; undo takes it back; the history says where it came from', async () => {
    const card = (await ok('GET', '/api/state')).workspace.proposals.find(p => p.kind === 'code' && p.status === 'PENDING');
    await ok('POST', '/api/proposals/accept', { ids: [card.id] });
    assert.equal(await read('p/experience.html'), PAGE.replace('<p>Rebuilt experiments.</p></div>', '<p>Rebuilt experiments.</p></div>' + entry));
    const h = (await ok('GET', '/api/state')).workspace.history[0];
    assert.ok(JSON.stringify(h).includes('chat'), JSON.stringify(h).slice(0, 300));
    await ok('POST', '/api/undo', {}); assert.equal(await read('p/experience.html'), PAGE);
  });
  await test('A card whose spot changed since it was made is not forced in: it is marked as a conflict', async () => {
    script = [{ tool_calls: [call('c1', 'propose_code_change', { file: 'index.html', summary: 'Longer welcome', edits: [{ find: '<p>Welcome to my site.</p>', replace: '<p>Welcome to my site.</p>\n<p>I design tools.</p>' }] })] }, { content: 'done' }];
    await ok('POST', '/api/chat', { message: 'add a line under the welcome' });
    const card = (await ok('GET', '/api/state')).workspace.proposals.find(p => p.kind === 'code' && p.file === 'index.html');
    await fs.writeFile(path.join(site, 'index.html'), '<!doctype html><html><head><title>Home</title></head><body><h1>Me</h1><p>Hello there.</p></body></html>');
    await new Promise(r => setTimeout(r, 1500));
    const r = await api('POST', '/api/proposals/accept', { ids: [card.id] });
    assert.notEqual(r.status, 200); assert.match(JSON.stringify(r.json), /changed since/);
    assert.ok((await read('index.html')).includes('Hello there.') && !(await read('index.html')).includes('I design tools.'));
  });
  await test('Only pages and style sheets; unknown files are named', async () => {
    script = [{ tool_calls: [call('d1', 'read_page', { file: 'nope.html' }), call('d2', 'propose_code_change', { file: 'nope.js', summary: 'x', edits: [{ find: 'a', replace: 'b' }] })] }, { content: 'ok' }];
    seen.length = 0; await ok('POST', '/api/chat', { message: 'x' });
    assert.match(toolResult(1, 'd1').error, /index\.html/); assert.equal(toolResult(1, 'd2').code, 'CODE_FILE');
  });
} finally { await host.close(); fake.close(); await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {}); }
console.log(`\n${n} code change checks passed`);
