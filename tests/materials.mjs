// "My materials": drop -> inbox with a checked guess -> confirm -> filed (resume replaces resume, history kept).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path';
import '../src/host/node-polyfills.mjs';
import { WorkspaceSession } from '../src/host/workspace-session.mjs';
import { guessKind, identityCheck, safeName } from '../src/host/materials.mjs';
import { pdfBytes } from './helpers/pdf.mjs';
import { readFileSync } from 'node:fs';
const ZH = JSON.parse(readFileSync(new URL('./fixtures/zh-input.json', import.meta.url), 'utf8'));   // Chinese input samples
let n = 0; const test = async (name, fn) => { await fn(); n++; console.log('✓ ' + name); };
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sitetend-mat-'));
await fs.cp(new URL('../demo-workspace', import.meta.url), root, { recursive: true });
process.env.SITETEND_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'sitetend-home-'));
const events = []; const s = await new WorkspaceSession({ root, emit: t => events.push(t) }).open();

await test('Rules guess the kind from the file name, then from the content', async () => {
  assert.equal(guessKind('Jane_CV_2026.pdf').kind, 'resume'); assert.equal(guessKind('my-portfolio.pdf').kind, 'portfolio');
  assert.equal(guessKind('notes.pdf', 'EXPERIENCE ... EDUCATION ... SKILLS').kind, 'resume');
  assert.equal(guessKind('x.md', 'hello').kind, 'other');
  assert.equal(safeName(ZH.unsafeName), ZH.safeName);
});
await test('Identity check: a file with another person\'s name and email is flagged', async () => {
  const owner = { names: ['Alex Morgan'], emails: ['alex.morgan.demo@northfield.edu'] };
  assert.deepEqual(identityCheck('Alex Morgan — alex.morgan.demo@northfield.edu', owner), []);
  const w = identityCheck('Jamie Lee — jamie@example.com', owner).map(x => x.code).sort();
  assert.deepEqual(w, ['EMAIL_MISMATCH', 'NAME_MISSING']);
  assert.deepEqual(identityCheck('Dr. Alex Morgan, new@x.org', owner, 'old cv: new@x.org').map(x => x.code), []);   // email known from the previous version
});
await test('A dropped resume waits in the inbox (not analysed), names what it replaces, and is checked', async () => {
  const item = await s.materials.receive('Alex Morgan Resume 2026.pdf', pdfBytes(['Alex Morgan - Resume', 'alex.morgan.demo@northfield.edu', 'Experience: Product Designer']));
  assert.equal(item.kind, 'resume'); assert.equal(item.replaces, 'sources/resume.pdf'); assert.deepEqual(item.warnings, []);
  const list = await s.materials.list(); assert.equal(list.inbox.length, 1);
  assert.ok(!list.files.some(f => f.name.includes('2026')));   // not filed yet
});
await test('Confirming files it in place of the old resume (same name, so assets/resume.pdf stays linked); old version kept', async () => {
  const id = (await s.materials.list()).inbox[0].id;
  const r = await s.materials.confirm(id, 'resume');
  assert.equal(r.path, 'sources/resume.pdf'); assert.deepEqual(r.replaced, ['sources/resume.pdf']);
  const text = (await fs.readFile(path.join(root, 'sources/resume.pdf'))).toString('latin1'); assert.ok(text.includes('Product Designer'));
  const hist = await fs.readdir(path.join(root, '.sitetend/materials-history/resume')); assert.equal(hist.length, 1);
  assert.equal((await s.materials.list()).inbox.length, 0);
});
await test("Someone else's resume is flagged; discarding leaves nothing behind", async () => {
  const item = await s.materials.receive('resume.pdf', pdfBytes(['Jamie Lee - Resume', 'jamie@example.com', 'Experience']));
  assert.ok(item.warnings.some(w => w.code === 'NAME_MISSING')); assert.ok(item.warnings.some(w => w.code === 'EMAIL_MISMATCH'));
  await s.materials.discard(item.id); assert.equal((await s.materials.list()).inbox.length, 0);
});
await test('Only the last 3 versions are kept; wrong types and huge files are refused', async () => {
  for (let i = 0; i < 4; i++) { const it = await s.materials.receive('resume.pdf', pdfBytes(['Alex Morgan', 'v' + i])); await s.materials.confirm(it.id, 'resume'); await new Promise(r => setTimeout(r, 5)); }
  assert.equal((await fs.readdir(path.join(root, '.sitetend/materials-history/resume'))).length, 3);
  await assert.rejects(s.materials.receive('x.exe', new Uint8Array(3)), /Only PDF/);
  await assert.rejects(s.materials.receive('big.pdf', new Uint8Array(21 * 1024 * 1024)), /20 MB/);
});
await test('Other kinds can hold several files; a project note is filed under sources/project/', async () => {
  const it = await s.materials.receive('fieldnotes.md', new TextEncoder().encode('# Fieldnotes Studio\nProject ID: fieldnotes\nOverview: new release v1.0\n'));
  assert.equal(it.kind, 'project'); const r = await s.materials.confirm(it.id, 'project'); assert.equal(r.path, 'sources/project/fieldnotes.md');
  assert.ok((await s.materials.list()).files.some(f => f.path === 'sources/projects/orbit-dock.md' && f.kind === 'project'));
});
await test('Dropping a newer profile.json replaces the one already at sources/profile.json (not a second copy), and is compared with it', async () => {
  const cur = JSON.parse(new TextDecoder().decode((await s.ws.readBytes('sources/profile.json')).data.bytes));
  const it = await s.materials.receive('profile.json', new TextEncoder().encode(JSON.stringify({ ...cur, email: 'dropped@example.com' }, null, 2)));
  assert.equal(it.kind, 'profile'); assert.equal(it.replaces, 'sources/profile.json');
  const r = await s.materials.confirm(it.id, 'profile');
  assert.equal(r.path, 'sources/profile.json');
  assert.ok(!(await s.materials.list()).files.some(f => f.path === 'sources/profile/profile.json'));
});
s.close();

await test('A Word (.docx) résumé is read: paragraphs, tabs and entities come through as text', async () => {
  const { docxText } = await import('../src/adapters/docx-text.js');
  const zlib = await import('node:zlib');
  // smallest valid .docx-like ZIP: one deflated word/document.xml entry
  const xml = '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>Jordan Lee</w:t></w:r></w:p><w:p><w:r><w:t>Product Designer</w:t><w:tab/><w:t>Acme &amp; Co</w:t></w:r></w:p></w:body></w:document>';
  const data = zlib.deflateRawSync(Buffer.from(xml)), name = Buffer.from('word/document.xml'), crc = zlib.crc32(Buffer.from(xml));
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(xml.length, 22); local.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(xml.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(0, 42);
  const cdOff = 30 + name.length + data.length, cdLen = 46 + name.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cdLen, 12); end.writeUInt32LE(cdOff, 16);
  const docx = new Uint8Array(Buffer.concat([local, name, data, cd, name, end]));
  assert.equal(docxText(docx), 'Jordan Lee\nProduct Designer\tAcme & Co');
  const r2 = await fs.mkdtemp(path.join(os.tmpdir(), 'sitetend-docx-'));
  await fs.cp(new URL('../demo-workspace', import.meta.url), r2, { recursive: true });
  const s2 = await new WorkspaceSession({ root: r2, emit: () => {} }).open();
  const it = await s2.materials.receive('Jordan-Lee-Resume.docx', docx);
  assert.equal(it.kind, 'resume'); assert.ok(!it.warnings.some(w => w.code === 'NO_TEXT'));
  assert.throws(() => docxText(new Uint8Array(30)), /not a Word file/);
  s2.close();
});

await test('Opening the website folder itself (no website/ inside): edits go to the real files, materials to .sitetend/materials', async () => {
  const site = await fs.mkdtemp(path.join(os.tmpdir(), 'sitetend-site-'));
  await fs.cp(new URL('../eval/sites/ext-sb-resume/website', import.meta.url), site, { recursive: true });
  const ss = await new WorkspaceSession({ root: site, emit: () => {} }).open();
  assert.equal(ss.layout, 'site'); assert.equal(ss.site.adapterId, 'text-files');
  await ss.edit('index.html::about.p.0', 'I build calm, accessible websites.');
  assert.ok((await fs.readFile(path.join(site, 'index.html'), 'utf8')).includes('I build calm, accessible websites.'));
  const it = await ss.materials.receive('Clarence-Taylor-CV.pdf', pdfBytes(['Clarence Taylor', 'name@email.com', 'Experience']));
  await ss.materials.confirm(it.id, 'resume');
  assert.ok(await fs.stat(path.join(site, '.sitetend/materials/resume/Clarence-Taylor-CV.pdf')));
  assert.match(await fs.readFile(path.join(site, '.gitignore'), 'utf8'), /^\.sitetend\/$/m);   // never published
  assert.ok(!(await ss.core._readLive()).data.data.files['.gitignore']);
  ss.close();
});
console.log(`${n} materials checks passed`);
