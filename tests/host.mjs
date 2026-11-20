// Host API tests: real HTTP server, real files in a temp folder.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sitetend-host-'));
process.env.SITETEND_HOME = path.join(tmp, 'home');
process.env.SITETEND_ANALYZE_DELAY_MS = '300';
const { startHost } = await import('../src/host/server.mjs');

let count = 0;
async function test(name, fn) { await fn(); console.log('✓ ' + name); count++; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const site = path.join(tmp, 'site');
await fs.cp(new URL('../demo-workspace', import.meta.url), site, { recursive: true });

let host = await startHost({ port: 0, log: () => {} });
const api = async (method, p, body, { token = host.token, hostHeader, client } = {}) => {
  const res = await fetch(`http://127.0.0.1:${host.port}${p}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Sitetend-Token': token } : {}), ...(hostHeader ? { Host: hostHeader } : {}), ...(client ? { 'X-Sitetend-Client': client } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const ok = async (...a) => { const r = await api(...a); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.data; };
const readSite = async () => JSON.parse(await fs.readFile(path.join(site, 'website/content.json'), 'utf8'));
const editProfile = async patch => { const f = path.join(site, 'sources/profile.json'); const p = JSON.parse(await fs.readFile(f, 'utf8')); await fs.writeFile(f, JSON.stringify({ ...p, ...patch }, null, 2)); };
async function waitFor(pred, ms = 6000) { const t = Date.now(); while (Date.now() - t < ms) { const s = (await ok('GET', '/api/state')).workspace; if (s && pred(s)) return s; await sleep(150); } throw Error('timeout'); }
const pending = s => s.proposals.filter(p => p.status === 'PENDING');

try {
  await test('API rejects missing or wrong session token', async () => {
    assert.equal((await api('GET', '/api/state', null, { token: null })).status, 401);
    assert.equal((await api('GET', '/api/state', null, { token: 'x'.repeat(32) })).status, 401);
    for (const t of ['short', 'x'.repeat(200)]) assert.equal((await api('GET', '/api/state', null, { token: t })).status, 401, 'a token of another length is refused the same way');
  });

  await test('Static UI is served without a token; dotfiles and unknown paths are not', async () => {
    const r = await fetch(`http://127.0.0.1:${host.port}/`); assert.equal(r.status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${host.port}/.gitignore`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${host.port}/package.json`)).status, 404);
  });

  await test('Phones get the "open on a computer" page', async () => {
    const r = await fetch(`http://127.0.0.1:${host.port}/`, { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile' } });
    assert.match(await r.text(), /computer/i);
  });

  await test('Opening a workspace creates the baseline automatically and gitignores .sitetend/', async () => {
    const s = await ok('POST', '/api/workspace/open', { path: site });
    assert.equal(s.workspace.label, 'site'); assert.equal(pending(s).length, 0);
    assert.match(await fs.readFile(path.join(site, '.gitignore'), 'utf8'), /^\.sitetend\/$/m);
    assert(await fs.stat(path.join(site, '.sitetend/analysis.json')));
  });

  await test('Editing a source file on disk triggers analysis automatically', async () => {
    await editProfile({ email: 'disk@example.com' });
    const s = await waitFor(s => pending(s).some(p => p.field === 'contact.email'));
    assert.equal(pending(s).find(p => p.field === 'contact.email').value, 'disk@example.com');
  });

  await test('Accept writes the real file; undo and redo restore it', async () => {
    let s = (await ok('GET', '/api/state')).workspace;
    await ok('POST', '/api/proposals/accept', { ids: pending(s).map(p => p.id) });
    assert.equal((await readSite()).contact.email, 'disk@example.com');
    await ok('POST', '/api/undo'); assert.notEqual((await readSite()).contact.email, 'disk@example.com');
    await ok('POST', '/api/redo'); assert.equal((await readSite()).contact.email, 'disk@example.com');
  });

  await test("Sitetend's own writes do not trigger another analysis", async () => {
    await sleep(800);
    const before = (await ok('GET', '/api/state')).workspace.lastScan.id;
    await ok('POST', '/api/edit', { field: 'profile.role', value: 'Host test role' });
    await sleep(900);
    assert.equal((await ok('GET', '/api/state')).workspace.lastScan.id, before);
    assert.equal((await readSite()).profile.role, 'Host test role');
  });

  await test('Concurrent writes are serialized, none is lost', async () => {
    const results = await Promise.all([
      api('POST', '/api/edit', { field: 'profile.badge', value: 'A' }),
      api('POST', '/api/edit', { field: 'contact.location', value: 'B' }),
      api('POST', '/api/edit', { field: 'profile.tagline', value: 'C' }),
    ]);
    results.forEach(r => assert.equal(r.status, 200, JSON.stringify(r.json)));
    const d = await readSite(); assert.equal(d.profile.badge, 'A'); assert.equal(d.contact.location, 'B'); assert.equal(d.profile.tagline, 'C');
  });

  await test('Manual analysis mode waits for "check"', async () => {
    await ok('POST', '/api/settings', { autoAnalyze: 'manual' });
    await editProfile({ github: 'https://github.com/manual-mode' });
    await sleep(900);
    assert(!pending((await ok('GET', '/api/state')).workspace).some(p => p.field === 'contact.github'));
    await ok('POST', '/api/check', {});
    assert(pending((await ok('GET', '/api/state')).workspace).some(p => p.field === 'contact.github'));
    await ok('POST', '/api/settings', { autoAnalyze: 'auto' });
  });

  await test('Model keys are stored in the user folder with private permissions, never returned', async () => {
    await ok('POST', '/api/models/key', { id: 'openai', key: 'secret-test-key' });
    const env = path.join(process.env.SITETEND_HOME, '.env');
    assert.match(await fs.readFile(env, 'utf8'), /SITETEND_KEY_OPENAI=secret-test-key/);
    if (process.platform !== 'win32') assert.equal((await fs.stat(env)).mode & 0o777, 0o600);
    const models = await ok('GET', '/api/models');
    assert.equal(models.profiles.find(p => p.id === 'openai').hasKey, true);
    assert(!JSON.stringify(models).includes('secret-test-key'));
    await ok('POST', '/api/models/key', { id: 'openai', key: '' });
  });

  await test('Switching to a cloud model without a key is refused and keeps the old model', async () => {
    const r = await api('POST', '/api/models/active', { id: 'openai' });
    assert.equal(r.status, 400);
    assert.equal((await ok('GET', '/api/models')).active, 'rule');
  });

  await test('Preview file access is limited to website/', async () => {
    assert.equal((await fetch(`http://127.0.0.1:${host.port}/api/file?path=website/content.json&t=${host.token}`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${host.port}/api/file?path=sources/profile.json&t=${host.token}`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${host.port}/api/file?path=.sitetend/state.json&t=${host.token}`)).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${host.port}/api/file?path=website/../../etc/passwd&t=${host.token}`)).status, 404);
  });

  await test('Events stream reports analysis and state changes', async () => {
    const ctl = new AbortController(); const got = [];
    const res = await fetch(`http://127.0.0.1:${host.port}/api/events?t=${host.token}`, { signal: ctl.signal });
    const reader = res.body.getReader(); const dec = new TextDecoder();
    (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; got.push(dec.decode(value)); } } catch {} })();
    await ok('POST', '/api/check', {}); await sleep(200); ctl.abort();
    const text = got.join(''); assert.match(text, /event: analysis.completed/); assert.match(text, /event: state/);
  });

  await test('History and undo survive a host restart', async () => {
    await host.close();
    host = await startHost({ port: 0, workspace: site, log: () => {} });
    const s = (await ok('GET', '/api/state')).workspace;
    assert(s.canUndo); assert(s.history.length > 3);
    await ok('POST', '/api/undo');
  });

  await test('Edits made outside Sitetend are recorded in history automatically', async () => {
    const d = await readSite(); d.about.headline = 'Edited in another tool';
    await fs.writeFile(path.join(site, 'website/content.json'), JSON.stringify(d, null, 2));
    const s = await waitFor(s => s.history.some(h => h.action === 'EXTERNAL_CHANGE' && h.changes.some(c => c.path === 'about.headline')));
    assert.equal(s.content.about.headline, 'Edited in another tool');
    assert.equal(s.externalEditDetected, false);
    await ok('POST', '/api/edit', { field: 'profile.badge', value: 'Still works' });   // not blocked
    assert.equal((await readSite()).about.headline, 'Edited in another tool');
  });

  await test('A waiting suggestion whose spot is changed outside Sitetend becomes a conflict right away', async () => {
    await ok('POST', '/api/proposals/propose', { field: 'profile.tagline', value: 'From a suggestion', reason: 't', quote: 't' });
    const id = (await ok('GET', '/api/state')).workspace.proposals.find(p => p.field === 'profile.tagline' && p.status === 'PENDING').id;
    const d = await readSite(); d.profile.tagline = 'Changed in another tool';
    await fs.writeFile(path.join(site, 'website/content.json'), JSON.stringify(d, null, 2));
    const s = await waitFor(s => s.proposals.some(p => p.id === id && p.status === 'CONFLICT'));
    assert.equal(s.proposals.find(p => p.id === id).conflict.current, 'Changed in another tool');
    const r = await api('POST', '/api/proposals/accept', { ids: [id] });
    assert.equal(r.json.ok, false); assert.equal((await readSite()).profile.tagline, 'Changed in another tool');   // never overwritten silently
    await ok('POST', '/api/proposals/resolve', { id, action: 'dismiss' });
  });

  await test('A change made outside Sitetend can be reverted from history; the revert is undoable; a field changed again is not overwritten', async () => {
    const before = (await readSite()).about.headline;
    const d = await readSite(); d.about.headline = 'Typo from the editor'; d.profile.tagline = 'Outside tagline';
    await fs.writeFile(path.join(site, 'website/content.json'), JSON.stringify(d, null, 2));
    let s = await waitFor(s => s.history.some(h => h.action === 'EXTERNAL_CHANGE' && h.changes.some(c => c.path === 'about.headline' && c.after === 'Typo from the editor')));
    const ext = s.history.find(h => h.action === 'EXTERNAL_CHANGE' && h.changes.some(c => c.after === 'Typo from the editor'));
    const oldTagline = ext.changes.find(c => c.path === 'profile.tagline').before;
    await ok('POST', '/api/history/revert-external', { id: ext.logId });
    let site1 = await readSite(); assert.equal(site1.about.headline, before); assert.equal(site1.profile.tagline, oldTagline);
    s = (await ok('GET', '/api/state')).workspace; assert.equal(s.history[0].action, 'REVERT_EXTERNAL'); assert.equal(s.history[0].reverts, ext.logId);
    let r = await api('POST', '/api/history/revert-external', { id: ext.logId }); assert.equal(r.json.error.code, 'ALREADY_REVERTED');
    await ok('POST', '/api/undo');   // the outside change comes back
    site1 = await readSite(); assert.equal(site1.about.headline, 'Typo from the editor');
    await ok('POST', '/api/edit', { field: 'about.headline', value: 'Newer text' });
    r = await api('POST', '/api/history/revert-external', { id: ext.logId });
    assert.equal(r.json.error.code, 'REVERT_CONFLICT'); assert.equal((await readSite()).about.headline, 'Newer text', 'not overwritten');
    assert.equal((await readSite()).profile.tagline, 'Outside tagline', 'nothing reverted when one field conflicts');
    r = await api('POST', '/api/history/revert-external', { id: s.history.find(h => h.action !== 'EXTERNAL_CHANGE').logId });
    assert.equal(r.json.ok, false); assert.equal(r.json.error.code, 'WORKSPACE_FILE_NOT_FOUND', 'only outside changes can be reverted this way');
  });

  await test('Any one earlier change can be reverted on its own, out of order; later changes to other fields stay', async () => {
    await ok('POST', '/api/edit', { field: 'profile.badge', value: 'Badge A' });
    const first = (await ok('GET', '/api/state')).workspace.history[0];
    const badgeBefore = first.changes.find(c => c.path === 'profile.badge').before;
    await ok('POST', '/api/edit', { field: 'contact.location', value: 'Somewhere new' });   // a later, unrelated change
    await ok('POST', '/api/history/revert', { id: first.logId });
    const d = await readSite(); assert.equal(d.profile.badge, badgeBefore); assert.equal(d.contact.location, 'Somewhere new', 'the later change stays');
    const s = (await ok('GET', '/api/state')).workspace; assert.equal(s.history[0].action, 'REVERT_ENTRY'); assert.equal(s.history[0].reverts, first.logId);
    await ok('POST', '/api/undo'); assert.equal((await readSite()).profile.badge, 'Badge A', 'the revert is undoable');
    const undoEntry = s.history.find(h => h.action === 'UNDO');
    if (undoEntry) assert.equal((await api('POST', '/api/history/revert', { id: undoEntry.logId })).json.error.code, 'WORKSPACE_FILE_NOT_FOUND', 'undo steps are not reverted this way');
  });

  await test('An in-place edit right after a Sitetend write is still detected (Linux watcher regression)', async () => {
    await ok('POST', '/api/edit', { field: 'contact.headline', value: 'Written by Sitetend' });   // atomic rename write
    const d = await readSite(); d.contact.headline = 'Then edited in place';
    const fh = await fs.open(path.join(site, 'website/content.json'), 'w'); await fh.write(JSON.stringify(d, null, 2)); await fh.close();
    await waitFor(s => s.content.contact.headline === 'Then edited in place');
  });

  await test('The saved site opens in the browser: own key, website files only, sandboxed so its scripts cannot reach the API', async () => {
    const view = (await ok('GET', '/api/state')).host.view; assert.match(view, /^\/view\/[\w-]{20,}\/$/);
    const get = p => fetch(`http://127.0.0.1:${host.port}${p}`);
    const r = await get(view + 'index.html'); assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /^sandbox allow-scripts/); assert.ok(!/allow-same-origin/.test(r.headers.get('content-security-policy')));
    assert.match(await r.text(), /<html/i);
    assert.equal((await get(view)).status, 200);                                            // a folder shows its index.html
    assert.equal((await get('/view/wrong-key-wrong-key-wrong/index.html')).status, 404);
    assert.equal((await get(view + '.sitetend/state.json')).status, 404);                     // Sitetend's own records stay private
    assert.equal((await get(view + '..%2F..%2Fpackage.json')).status, 404);
    assert.equal((await get(view + '../sources/profile.json')).status, 404);
    const part = await fetch(`http://127.0.0.1:${host.port}${view}index.html`, { headers: { range: 'bytes=0-9' } });   // videos ask for parts
    assert.equal(part.status, 206); assert.equal((await part.arrayBuffer()).byteLength, 10);
  });

  await test('A suggestion can be seen in the browser before it is accepted: changed pages from memory, words highlighted, nothing saved', async () => {
    const view = (await ok('GET', '/api/state')).host.view, root = site;
    const disk = await fs.readFile(path.join(root, 'website', 'index.html'), 'utf8');
    const changed = disk.replace(/<\/body>/i, '<p>Brand new words here</p></body>');
    const r = await ok('POST', '/api/preview/stage', { files: { 'index.html': changed }, marks: ['Brand new words here'], label: 'Email <b>' });
    assert.match(r.url, /^\/view\/[\w-]+\/~s\/[\w-]+\/$/);
    const get = p => fetch(`http://127.0.0.1:${host.port}${p}`);
    const page = await (await get(r.url + 'index.html')).text();
    assert.ok(page.includes('Brand new words here') && page.includes('data-sitetend') && page.includes('Email \\u003cb>'), 'the change, the highlight script, the label without raw <');
    assert.equal(await fs.readFile(path.join(root, 'website', 'index.html'), 'utf8'), disk, 'nothing was written');
    assert.equal((await get(r.url + 'content.json')).status, 200, 'other files come from the website folder');
    assert.equal((await get(view + 'index.html').then(x => x.text())).includes('Brand new words here'), false, 'the plain view stays the saved site');
    assert.equal((await get(view + '~s/nope/index.html')).status, 404);
    for (const bad of [{ '../x.html': 'a' }, { '.sitetend/x.json': '{}' }, { 'a.exe': 'x' }, { 'index.html': 5 }])
      assert.equal((await api('POST', '/api/preview/stage', { files: bad })).status, 400, JSON.stringify(bad));
    assert.equal((await api('POST', '/api/preview/stage', { files: {} }, { client: 'mcp:agent' })).status, 403, 'not for agents');
  });

  await test('Daily backup when a site is opened; restore brings the site back, is recorded in history and can be taken back', async () => {
    let b; for (let i = 0; i < 40 && !(b = await ok('GET', '/api/backups')).list.length; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(b.enabled, true); assert.equal(b.list.length, 1); assert.equal(b.list[0].kind, 'daily'); assert.ok(!b.dir.startsWith(site));
    const before = (await readSite()).profile.tagline;
    const manual = await ok('POST', '/api/backups/now', {});                                // the site as it is now
    await ok('POST', '/api/edit', { field: 'profile.tagline', value: 'Edited after the backup' });
    const r = await ok('POST', '/api/backups/restore', { file: manual.file });
    assert.ok(r.safety); assert.equal((await readSite()).profile.tagline, before);
    const s = (await ok('GET', '/api/state')).workspace; const h = s.history[0];
    assert.equal(h.action, 'EXTERNAL_CHANGE'); assert.match(h.note, /^Restored the backup of \d{4}-\d{2}-\d{2}$/);
    await ok('POST', '/api/history/revert-external', { id: h.logId });                  // take the restore back
    assert.equal((await readSite()).profile.tagline, 'Edited after the backup');
    assert.ok((await ok('GET', '/api/backups')).list.some(x => x.kind === 'before-restore'));
  });

  await test('Compare base is the session-start version, then the published version', async () => {
    let s = (await ok('GET', '/api/state')).workspace;
    assert.equal(s.compareBase.kind, 'opened');
    await ok('POST', '/api/publish/mark', {});
    s = (await ok('GET', '/api/state')).workspace;
    assert.equal(s.compareBase.kind, 'published'); assert.equal(s.compareBase.content, null);   // same as the current site: not sent twice
    const f = (await ok('GET', '/api/fields')).find(x => x.type === 'text');
    await ok('POST', '/api/edit', { field: f.path, value: 'Changed after publishing' });
    s = (await ok('GET', '/api/state')).workspace;
    assert.ok(s.compareBase.content && JSON.stringify(s.compareBase.content) !== JSON.stringify(s.content));   // different: sent
    await ok('POST', '/api/undo', {});
  });

  await test('Conflict cards can be overwritten or dismissed', async () => {
    await ok('POST', '/api/settings', { autoAnalyze: 'manual' });
    await editProfile({ location: 'Conflict City' }); await ok('POST', '/api/check', {});
    let s = (await ok('GET', '/api/state')).workspace;
    const p = pending(s).find(x => x.field === 'contact.location');
    await ok('POST', '/api/edit', { field: 'contact.location', value: 'Hand edited' });
    assert.equal((await api('POST', '/api/proposals/accept', { ids: [p.id] })).status, 400);
    s = (await ok('GET', '/api/state')).workspace;
    assert.equal(s.proposals.find(x => x.id === p.id).status, 'CONFLICT');
    await ok('POST', '/api/proposals/resolve', { id: p.id, action: 'overwrite' });
    assert.equal((await readSite()).contact.location, 'Conflict City');
    s = (await ok('GET', '/api/state')).workspace;
    assert(!s.proposals.some(x => x.id === p.id));
    await ok('POST', '/api/settings', { autoAnalyze: 'auto' });
  });

  await test('Closing the workspace returns to the welcome state', async () => {
    await ok('POST', '/api/workspace/close', {});
    assert.equal((await ok('GET', '/api/state')).workspace, null);
    await ok('POST', '/api/workspace/open', { path: site });
  });

  await test('Git publishing commits only website/ and pushes to the remote', async () => {
    const { execFileSync } = await import('node:child_process');
    const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }).trim();
    const remote = path.join(tmp, 'remote.git'); g(tmp, 'init', '--bare', '-q', remote);
    g(site, 'init', '-q', '-b', 'main'); g(site, 'config', 'user.name', 'Sitetend Test'); g(site, 'config', 'user.email', 'test@example.com');
    g(site, 'remote', 'add', 'origin', remote); g(site, 'add', 'website', '.gitignore'); g(site, 'commit', '-q', '-m', 'init'); g(site, 'push', '-q', '-u', 'origin', 'main');
    let st = await ok('GET', '/api/publish/status');
    assert.equal(st.git.available, true); assert.equal(st.git.remote, 'origin'); assert.equal(st.mode, 'manual');
    await ok('POST', '/api/settings', { publishMode: 'git' });
    await ok('POST', '/api/edit', { field: 'profile.badge', value: 'Published by git' });
    const r = await ok('POST', '/api/publish', {});
    assert.equal(r.pushed, true); assert.equal(r.mode, 'git');
    assert.match(g(remote, 'log', '-1', '--format=%s', 'main'), /^Sitetend: publish/);
    const files = g(remote, 'ls-tree', '-r', '--name-only', 'main');
    assert.match(files, /website\/content\.json/); assert.doesNotMatch(files, /sources\//); assert.doesNotMatch(files, /\.sitetend\//);
    assert.match(g(remote, 'show', 'main:website/content.json'), /Published by git/);
    const s = (await ok('GET', '/api/state')).workspace; assert(s.liveIsPublished);
    // Nothing new: publishing again just pushes (no empty commit).
    const again = await ok('POST', '/api/publish', {}); assert.equal(again.nothingToCommit, true);
    await ok('POST', '/api/settings', { publishMode: 'manual' });
  });

  await test('Git publishing reports a missing remote clearly', async () => {
    const lone = path.join(tmp, 'lone'); await fs.cp(new URL('../demo-workspace', import.meta.url), lone, { recursive: true });
    const { execFileSync } = await import('node:child_process'); execFileSync('git', ['init', '-q'], { cwd: lone });
    await ok('POST', '/api/workspace/open', { path: lone }); await ok('POST', '/api/settings', { publishMode: 'git' });
    const r = await api('POST', '/api/publish', {}); assert.equal(r.status, 400); assert.equal(r.json.error.code, 'NO_REMOTE');
    await ok('POST', '/api/workspace/open', { path: site });
  });

  await test('Paths outside the workspace are rejected by the file adapter', async () => {
    const { NodeFsWorkspaceAdapter } = await import('../src/adapters/node-workspace-adapter.mjs');
    const ws = new NodeFsWorkspaceAdapter(site);
    for (const p of ['../escape.txt', '/etc/passwd', 'C:/Windows/x', '\\\\server\\share', 'a/../../b', '.git/config', '.env']) assert.equal((await ws.writeText(p, 'x')).ok, false, p);
  });

  await test('Built-in model profiles added later (Claude) appear for users with an older models.json', async () => {
    const { loadModels, saveModels } = await import('../src/host/user-config.mjs');
    const m = await loadModels(); const old = { active: m.active, profiles: m.profiles.filter(p => p.id !== 'claude').map(p => p.id === 'openai' ? { ...p, model: 'my-edited-model' } : p) };
    await saveModels(old);
    const list = (await ok('GET', '/api/models')).profiles;
    const claude = list.find(p => p.id === 'claude'); assert.ok(claude, 'Claude profile is added'); assert.equal(claude.jsonMode, false); assert.equal(claude.hasKey, false);
    assert.equal(list.find(p => p.id === 'openai').model, 'my-edited-model', 'the user\'s own edits are kept');
    assert.ok(list.findIndex(p => p.id === 'claude') < list.findIndex(p => p.id === 'ollama'));
  });
  await test('A profile that is no longer built in stays, as the user\'s own, and can be removed', async () => {
    const { loadModels, saveModels } = await import('../src/host/user-config.mjs');
    const m = await loadModels(); m.profiles.push({ id: 'oldone', label: 'Old built-in', type: 'openai-compatible', endpoint: 'https://example.com/v1/chat/completions', model: 'm', keyRef: 'SITETEND_KEY_OLDONE' }); await saveModels(m);
    const p = (await ok('GET', '/api/models')).profiles.find(x => x.id === 'oldone');
    assert.ok(p && p.custom && p.model === 'm');
    await ok('POST', '/api/models/remove', { id: 'oldone' });
    assert.ok(!(await ok('GET', '/api/models')).profiles.some(x => x.id === 'oldone'));
  });

  await test('Build step: generated pages are never edited, the build runs after every change and undo, failures are reported', async () => {
    const b = path.join(tmp, 'built'); await fs.mkdir(path.join(b, 'parts'), { recursive: true });
    await fs.writeFile(path.join(b, 'parts/about.html'), '<section><h2>About</h2><p>I design calm tools.</p></section>\n');
    await fs.writeFile(path.join(b, 'build.js'), "const fs=require('fs');fs.writeFileSync('index.html','<!doctype html><html><head><title>Built</title></head><body>'+fs.readFileSync('parts/about.html','utf8')+'</body></html>');\n");
    await fs.writeFile(path.join(b, 'package.json'), JSON.stringify({ name: 'built', private: true, scripts: { build: 'node build.js' } }));
    await fs.writeFile(path.join(b, 'index.html'), '<!doctype html><html><body><section><h2>About</h2><p>I design calm tools.</p></section></body></html>');
    let s = await ok('POST', '/api/workspace/open', { path: b });
    assert.deepEqual(s.buildSuggestion, { command: 'npm run build', generated: ['index.html'] }, 'found the build script and the page it makes');
    assert(s.editableFields.some(f => f.path.startsWith('index.html::')), 'before: the generated page looks editable');
    s = await ok('POST', '/api/build/config', { command: 'node build.js', generated: 'index.html' });
    assert.equal(s.build.command, 'node build.js'); assert.deepEqual(s.build.generated, ['index.html']); assert.equal(s.buildSuggestion, null);
    assert(!s.editableFields.some(f => f.path.startsWith('index.html::')), 'the generated page is left alone');
    const field = s.editableFields.find(f => f.path.startsWith('parts/about.html::') && /calm/.test(JSON.stringify(s.content.files['parts/about.html'])) && f.type !== 'url' && !/h2/.test(f.path));
    s = await waitFor(x => x.build?.last?.ok, 8000);
    const at1 = s.build.last.at;
    await ok('POST', '/api/edit', { field: field.path, value: 'I build quiet software.' });
    s = await waitFor(x => x.build?.last?.at !== at1 && !x.build.running, 8000);
    assert.equal(s.build.last.ok, true); assert.match(await fs.readFile(path.join(b, 'index.html'), 'utf8'), /I build quiet software\./);
    const at2 = s.build.last.at;
    await ok('POST', '/api/undo');
    s = await waitFor(x => x.build?.last?.at !== at2 && !x.build.running, 8000);
    assert.match(await fs.readFile(path.join(b, 'index.html'), 'utf8'), /I design calm tools\./, 'undo regenerates too');
    const { loadSettings } = await import('../src/host/user-config.mjs');
    assert.equal((await loadSettings()).siteBuild[b].command, 'node build.js', 'kept in the owner\'s settings');
    assert.equal(await fs.stat(path.join(b, '.sitetend/config.json')).then(x => fs.readFile(path.join(b, '.sitetend/config.json'), 'utf8')).catch(() => '').then(t => t.includes('build.js')), false, 'not in the website folder');
    s = await ok('POST', '/api/build/config', { command: 'node -e "process.stderr.write(\'boom\');process.exit(3)"', generated: 'index.html' });
    s = await waitFor(x => x.build?.last && !x.build.running && x.build.last.ok === false, 8000);
    assert.match(s.build.last.output, /boom/);
    assert.equal((await api('POST', '/api/build/config', { command: 'x', generated: '../escape.html' })).json.error.code, 'BAD_PATH');
    s = await ok('POST', '/api/build/config', { command: '' }); assert.equal(s.build, null);
    await ok('POST', '/api/workspace/open', { path: site });
  });

  await test('Owner-added models: any OpenAI-compatible endpoint; keys stay in .env; only added ones can be removed', async () => {
    const { loadModels } = await import('../src/host/user-config.mjs');
    let r = await ok('POST', '/api/models/add', { label: 'My Router', endpoint: 'https://openrouter.example/api/v1', model: 'some/model', key: 'sk-test-123' });
    let m = await loadModels(); let p = m.profiles.find(x => x.id === r.id);
    assert.equal(p.endpoint, 'https://openrouter.example/api/v1/chat/completions', 'a base URL gets the chat path');
    assert.equal(p.custom, true); assert.ok(p.keyRef); assert(!JSON.stringify(m).includes('sk-test-123'), 'the key is not in models.json');
    const env = await fs.readFile(path.join(process.env.SITETEND_HOME, '.env'), 'utf8'); assert.match(env, new RegExp(p.keyRef + '=sk-test-123'));
    assert.equal((await ok('GET', '/api/models')).profiles.find(x => x.id === r.id).hasKey, true);
    assert.equal((await api('POST', '/api/models/add', { label: 'x', endpoint: 'http://remote.example/v1', model: 'm' })).json.error.code, 'BAD_ENDPOINT', 'no plain http to the internet');
    const nokey = await ok('POST', '/api/models/add', { label: 'Later', endpoint: 'https://later.example/v1', model: 'm' }); assert.equal(nokey.needsKey, true);
    const nk = (await ok('GET', '/api/models')).profiles.find(x => x.id === nokey.id); assert.ok(nk.keyRef); assert.equal(nk.hasKey, false, 'an internet service without a key shows "needs key"');
    await ok('POST', '/api/models/remove', { id: nokey.id });
    const lan = await ok('POST', '/api/models/add', { label: 'LM Studio', endpoint: 'http://127.0.0.1:1234/v1', model: 'local-model' });
    assert.equal((await loadModels()).profiles.find(x => x.id === lan.id).local, true);
    assert.equal((await api('POST', '/api/models/add', { label: '', endpoint: 'https://a.example', model: '' })).json.error.code, 'BAD_MODEL');
    assert.equal((await api('POST', '/api/models/remove', { id: 'openai' })).json.error.code, 'NOT_CUSTOM');
    await ok('POST', '/api/models/active', { id: r.id });
    assert.equal((await ok('POST', '/api/models/remove', { id: r.id })).active, 'rule', 'removing the active one falls back to the offline rule mode');
    m = await loadModels(); assert(!m.profiles.some(x => x.id === r.id));
    assert(!(await fs.readFile(path.join(process.env.SITETEND_HOME, '.env'), 'utf8')).includes('sk-test-123'), 'its key is deleted too');
    await ok('POST', '/api/models/remove', { id: lan.id });
  });

  await test('Saved websites: named from the site, renamed, removed without touching files, missing folders kept', async () => {
    const second = path.join(tmp, 'second'); await fs.mkdir(second);
    await fs.writeFile(path.join(second, 'index.html'), '<html><head><title>Jamie &amp; Co</title></head><body>hi</body></html>');
    await ok('POST', '/api/workspace/open', { path: site });
    await ok('POST', '/api/workspace/open', { path: second });
    let list = (await ok('GET', '/api/state')).sites;
    assert.equal(list[0].path, second); assert.equal(list[0].name, 'Jamie & Co'); assert.equal(list[0].current, true);
    assert.equal(list.find(x => x.path === site).name, 'Alex Morgan', 'name from content.json');
    list = await ok('POST', '/api/sites/rename', { path: site, name: '  My   portfolio ' });
    assert.equal(list.find(x => x.path === site).name, 'My portfolio'); assert.equal(list.find(x => x.path === site).custom, true);
    list = await ok('POST', '/api/sites/rename', { path: site, name: '' });
    assert.equal(list.find(x => x.path === site).name, 'Alex Morgan', 'empty name goes back to the automatic one');
    assert.equal((await api('POST', '/api/sites/rename', { path: '/nope', name: 'x' })).status, 404);
    await fs.rename(second, second + '-moved');
    list = (await ok('GET', '/api/state')).sites; assert.equal(list.find(x => x.path === second).missing, true);
    await fs.rename(second + '-moved', second);
    list = await ok('POST', '/api/sites/remove', { path: second });
    assert(!list.some(x => x.path === second)); assert.ok(await fs.stat(path.join(second, 'index.html')), 'files are not touched');
    assert.equal((await api('GET', '/api/sites', null, { token: 'x'.repeat(32) })).status, 401);
    await ok('POST', '/api/workspace/open', { path: site });
  });

  console.log(`${count} host checks passed`);
} finally {
  await host.close();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
