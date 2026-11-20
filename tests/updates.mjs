// Checking for a new version: version comparison, the once-a-day cache, turning it off, and no network.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
process.env.SITETEND_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'st-upd-'));
delete process.env.SITETEND_NO_UPDATE_CHECK;
const { compareVersions, checkForUpdate, APP_VERSION } = await import('../src/host/updates.mjs');
let n = 0; const test = async (name, fn) => { await fn(); n++; console.log('✓ ' + name); };

await test('Versions compare as numbers, a pre-release is older than the release', () => {
  assert.equal(compareVersions('1.10.0', '1.9.3'), 1);
  assert.equal(compareVersions('v1.2', '1.2.0'), 0);
  assert.equal(compareVersions('1.2.0-beta.1', '1.2.0'), -1);
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
});

let hits = 0, reply = { tag_name: 'v99.0.0', html_url: 'https://github.com/zyt-slowpixel/Sitetend/releases/tag/v99.0.0' };
const server = http.createServer((req, res) => { hits++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(reply)); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
process.env.SITETEND_UPDATE_URL = `http://127.0.0.1:${server.address().port}/latest`;

await test('A newer release is reported with its GitHub page; asking again the same day uses the saved answer', async () => {
  const u = await checkForUpdate();
  assert.deepEqual([u.current, u.latest, u.newer, u.url], [APP_VERSION, '99.0.0', true, reply.html_url]);
  await checkForUpdate(); assert.equal(hits, 1, 'once a day');
  await checkForUpdate({ force: true }); assert.equal(hits, 2, '"Check now" asks again');
});

await test('Same version: not newer. A link that is not on GitHub is replaced by the releases page', async () => {
  reply = { tag_name: APP_VERSION, html_url: 'https://evil.example/download' };
  const u = await checkForUpdate({ force: true });
  assert.equal(u.newer, false); assert.equal(u.url, 'https://github.com/zyt-slowpixel/Sitetend/releases');
});

await test('Turned off: no request at all. Offline: the last answer is kept and marked', async () => {
  const before = hits;
  assert.equal((await checkForUpdate({ force: true, enabled: false })).off, true);
  assert.equal(hits, before);
  server.close(); await new Promise(r => setTimeout(r, 50));
  const u = await checkForUpdate({ force: true });
  assert.equal(u.error, 'OFFLINE'); assert.equal(u.latest, APP_VERSION);
});
console.log(`${n} update checks passed`);
