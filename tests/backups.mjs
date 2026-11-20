// Daily full-site backups: zip format, one a day, pruning, restore, damaged or unsafe zips refused.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SiteBackups, zipFolder, readZip, backupDirFor } from '../src/host/backups.mjs';
let n = 0; const test = async (name, fn) => { await fn(); n++; console.log('✓ ' + name); };
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'st-bk-'));
async function site() {
  const root = path.join(await tmp(), 'my site');
  const files = { 'index.html': '<h1>Jane</h1>', 'p/about.html': '<p>About me. Café ünïcode \u4e2d\u6587</p>', 'img/a.png': Buffer.alloc(3000, 7),
    'big.txt': 'word '.repeat(20000), 'node_modules/x/index.js': 'skip', '.git/HEAD': 'skip', '.sitetend/state.json': '{}', 'old.html~': 'skip' };
  for (const [f, c] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, f)), { recursive: true }); await fs.writeFile(path.join(root, f), c); }
  return root;
}
const read = (root, f) => fs.readFile(path.join(root, f), 'utf8').catch(() => null);

await test('A backup is a plain zip of the website (opens with other tools; tool folders and leftovers are left out)', async () => {
  const root = await site(); const z = path.join(await tmp(), 'b.zip');
  const r = await zipFolder(root, z); assert.equal(r.files, 4);
  const names = (await readZip(z)).map(e => e.name).sort();
  assert.deepEqual(names, ['big.txt', 'img/a.png', 'index.html', 'p/about.html']);
  const py = execFileSync('python3', ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;sys.stdout.buffer.write(z.read("p/about.html"))', z]).toString().trim();   // raw bytes: a Windows console cannot print every character
  assert.equal(py, await read(root, 'p/about.html'));
  assert.ok((await fs.stat(z)).size < 20000, 'text is compressed');
});
await test('One daily backup per day; kept outside the website; old days and the size limit prune older ones', async () => {
  const root = await site(), home = await tmp(); let day = new Date('2026-11-01T09:00:00');
  const b = new SiteBackups(root, { home, now: () => day, keepDays: 3 });
  assert.ok(b.dir.startsWith(home) && !b.dir.startsWith(root));
  assert.ok(await b.daily()); assert.equal(await b.daily(), null);                       // once a day
  for (let i = 2; i <= 5; i++) { day = new Date(`2026-11-0${i}T09:00:00`); await b.daily(); }
  assert.deepEqual((await b.list()).map(x => x.date), ['2026-11-05', '2026-11-04', '2026-11-03']);
  const tiny = new SiteBackups(root, { home, now: () => day, maxTotal: 1 }); await tiny.prune();
  assert.equal((await tiny.list()).length, 1, 'the newest is always kept');
  assert.notEqual(backupDirFor('/a/site'), backupDirFor('/b/site'), 'two sites with one name get their own folders');
});
await test('Restore puts the whole site back, removes files added since, and backs up the current site first', async () => {
  const root = await site(), home = await tmp(); let t0 = new Date('2026-11-12T08:00:00');
  const b = new SiteBackups(root, { home, now: () => t0 });
  const first = await b.make('daily');
  await fs.writeFile(path.join(root, 'index.html'), '<h1>Changed</h1>'); await fs.writeFile(path.join(root, 'new.html'), 'new');
  await fs.rm(path.join(root, 'img/a.png'));
  t0 = new Date('2026-11-12T10:00:00');
  const r = await b.restore(first.file);
  assert.equal(await read(root, 'index.html'), '<h1>Jane</h1>'); assert.equal(await read(root, 'new.html'), null);
  assert.equal((await fs.readFile(path.join(root, 'img/a.png'))).length, 3000);
  assert.equal(await read(root, 'node_modules/x/index.js'), 'skip', 'tool folders are not touched');
  const safety = (await readZip(path.join(b.dir, r.safety))).map(e => e.name);
  assert.ok(safety.includes('new.html'), 'the site before the restore is in a backup too');
});
await test('A damaged backup, or one with paths that leave the folder, changes nothing', async () => {
  const root = await site(), home = await tmp();
  const b = new SiteBackups(root, { home }); const made = await b.make('daily');
  const zp = path.join(b.dir, made.file); const buf = await fs.readFile(zp);
  const i = buf.indexOf(Buffer.from('<h1>Jane')); if (i > 0) { buf[i + 1] = 0x58; } else buf[200] ^= 0xff;    // flip a byte inside the stored page
  await fs.writeFile(zp, buf);
  await fs.writeFile(path.join(root, 'index.html'), '<h1>Now</h1>');
  await assert.rejects(b.restore(made.file), e => e.code === 'BACKUP_DAMAGED');
  assert.equal(await read(root, 'index.html'), '<h1>Now</h1>');
  // a zip with "../" in a name
  const evil = path.join(b.dir, 'my-site-2026-01-01.zip'); const src = await tmp();
  await fs.writeFile(path.join(src, 'zzza.html'), 'x'); await zipFolder(src, evil);
  const e2 = await fs.readFile(evil); e2.write('../', e2.indexOf('zzza.html')); e2.write('../', e2.lastIndexOf('zzza.html')); await fs.writeFile(evil, e2);   // now "../a.html"
  assert.equal((await readZip(evil))[0].name, '../a.html');
  await assert.rejects(b.restore('my-site-2026-01-01.zip'), e => e.code === 'BACKUP_DAMAGED');
  await assert.rejects(b.restore('../../etc/passwd'), e => e.code === 'BACKUP_NOT_FOUND');
});
console.log(`${n} backup checks passed`);
