// The step log in the conversation: accepting a suggestion is followed by a check that the words reached the
// website's files (and the built pages when the site is built); a check records what the model concluded.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path';
import '../src/host/node-polyfills.mjs';
import { WorkspaceSession } from '../src/host/workspace-session.mjs';
let n = 0; const test = async (name, fn) => { await fn(); n++; console.log('✓ ' + name); };
process.env.SITETEND_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'sitetend-home-'));
const last = (events, kind) => events.filter(e => e.t === 'activity' && e.d.kind === kind).map(e => e.d).pop();

await test('Accepting a suggestion: steps are logged, the file is checked, the log turns green and is kept (under History, not in the conversation)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'act-html-'));
  await fs.writeFile(path.join(root, 'index.html'), '<html><body><h1>Lena Varga</h1><p id="bio">PhD student at UW.</p></body></html>');
  const events = []; const s = await new WorkspaceSession({ root, emit: (t, d) => events.push({ t, d: d && JSON.parse(JSON.stringify(d)) }) }).open();
  const field = s.fields().find(f => f.value === 'PhD student at UW.').path;
  const p = await s.analysis.proposeDirect({ field, value: 'Postdoc at UW.', reason: 'test' });
  assert.ok(p.ok, JSON.stringify(p));
  const id = s.analysis.state.proposals.find(x => x.status === 'PENDING').id;
  await s.accept([id]);
  const a = last(events, 'apply');
  assert.equal(a.status, 'ok', JSON.stringify(a));
  assert.deepEqual(a.steps.map(x => x.code), ['apply.accepted', 'apply.written', 'verify.files', 'verify.page.same']);
  assert.equal(a.steps[2].status, 'ok');
  await new Promise(r => setTimeout(r, 50));
  assert.ok((await s.activityLog()).some(m => m.id === a.id && m.status === 'ok'));
  assert.ok(!(await s.chatLog()).length);   // the conversation is only for talking
  s.close();
});

await test('A built site: after the build, the new words are looked for on the built page; missing words turn the log red', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'act-build-'));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'index.html'), '<html><body><p id="bio">Old words here.</p></body></html>');
  // a "build" that copies the page into out/ (a good build) — then one that writes a stale page (a bad build)
  const good = `node -e "require('fs').mkdirSync('out',{recursive:true});require('fs').copyFileSync('index.html','out/index.html')"`;
  const events = []; const s = await new WorkspaceSession({ root, emit: (t, d) => events.push({ t, d: d && JSON.parse(JSON.stringify(d)) }), build: { command: good, generated: ['out/'] } }).open();
  const field = s.fields().find(f => f.value === 'Old words here.').path;
  await s.analysis.proposeDirect({ field, value: 'New words, **now** live.', reason: 'test' });
  await s.accept([s.analysis.state.proposals.find(x => x.status === 'PENDING').id]);
  let a = last(events, 'apply');
  assert.equal(a.status, 'ok', JSON.stringify(a.steps));
  assert.deepEqual(a.steps.map(x => x.code), ['apply.accepted', 'apply.written', 'verify.files', 'build.done', 'verify.page']);
  s.build.command = `node -e "require('fs').writeFileSync('out/index.html','<p>Old words here.</p>')"`;
  await s.analysis.proposeDirect({ field, value: 'Third version.', reason: 'test' });
  await s.accept([s.analysis.state.proposals.find(x => x.status === 'PENDING').id]);
  a = last(events, 'apply');
  assert.equal(a.status, 'fail'); assert.deepEqual(a.steps.at(-1).missing, ['Third version.']);
  s.close();
});
await test('A build that writes to dist/ (Vite, React): the new words are still looked for on the built page', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'act-dist-'));
  await fs.writeFile(path.join(root, 'index.html'), '<html><body><p>I design calm tools.</p></body></html>');
  const build = `node -e "require('fs').mkdirSync('dist',{recursive:true});require('fs').copyFileSync('index.html','dist/index.html')"`;
  const events = []; const s = await new WorkspaceSession({ root, emit: (t, d) => events.push({ t, d: d && JSON.parse(JSON.stringify(d)) }), build: { command: build, generated: ['dist/'] } }).open();
  const field = s.fields().find(f => f.value === 'I design calm tools.').path;
  await s.analysis.proposeDirect({ field, value: 'I design calm tools for libraries.', reason: 'test' });
  await s.accept([s.analysis.state.proposals.find(x => x.status === 'PENDING').id]);
  const a = last(events, 'apply');
  assert.equal(a.status, 'ok', JSON.stringify(a.steps));
  assert.equal(a.steps.at(-1).code, 'verify.page');   // not verify.page.skip: dist/ is read even though the file list leaves it out
  s.close();
});
console.log(`${n} activity checks passed`);
