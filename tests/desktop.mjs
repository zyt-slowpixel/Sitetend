// Opening like an app: one Sitetend per user (the shortcut opens the running one), background start, quit,
// and the shortcut / sign-in entries (checked on this platform; Linux writes .desktop files).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sitetend-desk-'));
const HOME = path.join(tmp, 'home'); const DESK = path.join(tmp, 'user');
process.env.SITETEND_HOME = HOME; process.env.SITETEND_DESKTOP_HOME = DESK;
await fs.mkdir(path.join(DESK, 'Desktop'), { recursive: true });
const BIN = fileURLToPath(new URL('../bin/sitetend.mjs', import.meta.url));
const PORT = String(54600 + Math.floor(Math.random() * 300));
const env = { ...process.env, SITETEND_HOME: HOME, PORT };
const run = (...args) => new Promise(r => execFile(process.execPath, [BIN, ...args], { env, timeout: 30000 }, (err, out) => r({ code: err ? err.code : 0, out: String(out) })));
const host = async () => JSON.parse(await fs.readFile(path.join(HOME, 'host.json'), 'utf8'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let count = 0;
async function test(name, fn) { await fn(); console.log('✓ ' + name); count++; }
const call = async (method, p, body, h) => {
  const r = await fetch(`http://127.0.0.1:${h.port}${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-Sitetend-Token': h.token }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};

let first = null;
try {
  await test('--launch starts Sitetend in the background and returns', async () => {
    const t0 = Date.now(); const r = await run('--launch', '--no-browser');
    assert.equal(r.code, 0); assert(Date.now() - t0 < 25000);
    first = await host(); assert.equal(String(first.port), PORT); assert(alive(first.pid));
    assert.equal((await call('GET', '/api/ping', null, first)).json.data.app, 'sitetend');
  });

  await test('A second --launch (double-clicking again) and a plain start reuse the running one', async () => {
    assert.equal((await run('--launch', '--no-browser')).code, 0);
    assert.equal((await host()).pid, first.pid);
    const r = await run('--no-open'); assert.equal(r.code, 0); assert.match(r.out, /already running/);
    assert.equal((await host()).pid, first.pid);
  });

  await test('Shortcut and sign-in entries (this platform) are created and removed; agents cannot touch them', async () => {
    let a = (await call('GET', '/api/app', null, first)).json.data;
    assert.equal(a.shortcut, false); assert.equal(a.login, false); assert.equal(a.canQuit, true); assert.equal(a.tray, true);
    if (process.platform === 'linux') {
      a = (await call('POST', '/api/app/shortcut', {}, first)).json.data; assert.equal(a.shortcut, true);
      const entry = await fs.readFile(path.join(DESK, '.local/share/applications/sitetend.desktop'), 'utf8');
      assert.match(entry, /^Exec=".*node.*" ".*bin\/sitetend\.mjs" --launch$/m); assert.match(entry, /Icon=.*sitetend\.png/);
      assert(await fs.stat(path.join(DESK, 'Desktop/sitetend.desktop')));
      a = (await call('POST', '/api/app/login', { enabled: true }, first)).json.data; assert.equal(a.login, true);
      assert.match(await fs.readFile(path.join(DESK, '.config/autostart/sitetend.desktop'), 'utf8'), /--launch --no-browser/);
      a = (await call('POST', '/api/app/login', { enabled: false }, first)).json.data; assert.equal(a.login, false);
    }
    a = (await call('POST', '/api/app/tray', { enabled: false }, first)).json.data; assert.equal(a.tray, false);
    assert.equal(JSON.parse(await fs.readFile(path.join(HOME, 'settings.json'), 'utf8')).tray, false);
    await call('POST', '/api/settings', { mcp: { enabled: true, allowWrites: true } }, first);
    for (const p of ['/api/app/shortcut', '/api/app/login', '/api/host/quit']) {
      const r = await fetch(`http://127.0.0.1:${first.port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sitetend-Token': first.token, 'X-Sitetend-Client': 'mcp:x' }, body: '{}' });
      assert.equal(r.status, 403, p);
    }
  });

  await test('Quit stops the background Sitetend and clears host.json', async () => {
    assert.equal((await call('POST', '/api/host/quit', {}, first)).status, 200);
    for (let i = 0; i < 50 && alive(first.pid); i++) await sleep(100);
    assert(!alive(first.pid)); await assert.rejects(fs.stat(path.join(HOME, 'host.json')));
  });

  await test('A busy port falls back to a free one, and --launch still finds it', async () => {
    const http = await import('node:http');
    const blocker = http.createServer(() => {}); await new Promise(r => blocker.listen(Number(PORT), '127.0.0.1', r));
    try {
      assert.equal((await run('--launch', '--no-browser')).code, 0);
      const h = await host(); assert.notEqual(String(h.port), PORT);
      assert.equal((await call('GET', '/api/ping', null, h)).status, 200);
      await call('POST', '/api/host/quit', {}, h); for (let i = 0; i < 50 && alive(h.pid); i++) await sleep(100);
    } finally { blocker.close(); }
  });
} finally {
  try { const h = await host(); if (alive(h.pid)) process.kill(h.pid); } catch {}
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
}
console.log(`\n${count} desktop checks passed`);
