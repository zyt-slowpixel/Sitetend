// Spending: cost from token counts and price, the month's total, and the monthly limit stopping model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
process.env.SITETEND_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'st-spend-'));
const { costOf, record, status, guard } = await import('../src/host/spending.mjs');
const { saveSettings, loadSettings, loadModels, saveModels, setEnvKey } = await import('../src/host/user-config.mjs');
let n = 0; const test = async (name, fn) => { await fn(); n++; console.log('✓ ' + name); };
const pricey = { id: 'openai', type: 'openai-compatible', price: { in: 1, out: 5 } };

await test('Cost = tokens × price per million; a model without a price is counted as unpriced', async () => {
  assert.equal(costOf(pricey, { prompt_tokens: 1_000_000, completion_tokens: 200_000 }), 2);
  assert.equal(costOf({ id: 'x', type: 'openai-compatible' }, { prompt_tokens: 10 }), null);
  await record(pricey, { prompt_tokens: 400_000, completion_tokens: 20_000 });   // $0.50
  await record({ id: 'custom-1', type: 'openai-compatible', custom: true }, { prompt_tokens: 5000, completion_tokens: 100 });
  await record({ id: 'rule', type: 'rule' }, { prompt_tokens: 5000 });   // the rule demo is never counted
  const st = await status();
  assert.deepEqual([st.dollars, st.calls, st.unpriced, st.limit, st.reached], [0.5, 2, 1, 0, false]);
});

await test('The limit stops paid models once reached; local models and the rule demo keep running', async () => {
  const s = await loadSettings(); s.monthlyLimit = 0.5; await saveSettings(s);
  await assert.rejects(guard(pricey), e => e.code === 'PROVIDER_BUDGET_REACHED');
  await guard({ id: 'ollama', type: 'openai-compatible', local: true });
  await guard({ id: 'rule', type: 'rule' });
  s.monthlyLimit = 10; await saveSettings(s); await guard(pricey);
});

await test('In a check, a used-up limit means no call is made: the provider answers PROVIDER_BUDGET_REACHED', async () => {
  const s = await loadSettings(); s.monthlyLimit = 0.25; await saveSettings(s);
  const m = await loadModels();
  m.profiles.push({ id: 'fake', label: 'Fake', type: 'openai-compatible', custom: true, endpoint: 'http://127.0.0.1:9/v1/chat/completions', model: 'x', keyRef: 'SITETEND_KEY_FAKE', price: { in: 1, out: 1 } });
  m.active = 'fake'; await saveModels(m); await setEnvKey('SITETEND_KEY_FAKE', 'not-a-real-key');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'st-spend-site-'));
  await fs.writeFile(path.join(root, 'index.html'), '<p>Hello there, this is my site.</p>');
  const { WorkspaceSession } = await import('../src/host/workspace-session.mjs');
  const ws = await new WorkspaceSession({ root, emit: () => {} }).open();
  await ws.useActiveModel();
  const t0 = Date.now();
  const r = await ws.provider.analyzeSourceDiff({ source: { path: 'sources/a.md' } });
  assert.equal(r.ok, false); assert.equal(r.error.code, 'PROVIDER_BUDGET_REACHED');
  assert.ok(Date.now() - t0 < 1000, 'no network call was attempted');
  ws.close();
});
console.log(`${n} spending checks passed`);
