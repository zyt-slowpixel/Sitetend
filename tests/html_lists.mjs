// Lists in hand-written HTML: same-shaped blocks are found, and a new block is a copy of one with its words, link and
// picture replaced. Menus, forms and page sections are not lists; blocks placed by pixel positions cannot take more.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TextSiteAdapter } from '../src/adapters/text-site-adapter.js';
import { take } from '../src/agent/utils.js';
let n = 0;
async function test(name, fn) { await fn(); console.log('✓ ' + name); n++; }
const a = new TextSiteAdapter('html');
const PAGE = `<!doctype html><html><head><title>Me</title></head><body>
<nav><ul><li><a href="index.html">Home</a></li><li><a href="work.html">Work</a></li><li><a href="about.html">About</a></li></ul></nav>
<main>
  <section id="work">
    <h2>Projects</h2>
    <div class="grid">
      <article class="card">
        <img src="img/alpha.jpg" alt="Alpha app">
        <h3 class="card-title">Alpha</h3>
        <p class="role">Designer · 2024</p>
        <p class="note">Won a prize</p>
        <a href="https://alpha.example.com">Visit</a>
      </article>
      <article class="card active">
        <img src="img/beta.jpg" alt="Beta app">
        <h3 class="card-title">Beta</h3>
        <p class="role">Lead · 2025</p>
        <a href="https://beta.example.com">Visit</a>
      </article>
    </div>
  </section>
  <section id="awards"><ul><li>Best Student Project, 2023</li><li>Dean's List, 2024</li></ul></section>
  <form><div class="row"><label>Name</label><input></div><div class="row"><label>Email</label><input></div></form>
  <div id="beams"><div style="position:absolute;top:10px;left:0"><h3>One</h3><p>First line here</p></div><div style="position:absolute;top:80px;left:0"><h3>Two</h3><p>Second line here</p></div></div>
</main></body></html>`;
const files = { 'index.html': PAGE };
const lists = a.listCollections({ files });
const cards = lists.find(c => c.label === 'index.html › Projects'), awards = lists.find(c => c.label.includes('#awards'));

await test('Cards and a plain list are found; the menu and the form are not', async () => {
  assert.ok(cards && awards, lists.map(c => c.label).join(' | '));
  assert.deepEqual(cards.items.map(i => i.title), ['Alpha', 'Beta']);
  assert.equal(cards.titleField, 'h3.card-title');
  assert.deepEqual(cards.fields.map(f => [f.name, f.type, f.required]), [['image', 'image', false], ['h3.card-title', 'text', true], ['p.role', 'text', true], ['p.note', 'text', false], ['link', 'url', true], ['a', 'text', false]]);
  assert.deepEqual(cards.fields.map(f => f.label), ['Picture', 'Card title', 'Role', 'Note', 'Link', 'Link text']);
  assert.ok(!lists.some(c => /nav|row/.test(c.label)), 'no menu, no form rows');
  assert.ok(cards.fields.find(f => f.name === 'a').same, '"Visit", the same on every card, is kept unless new words are given');
  assert.ok(!JSON.stringify(lists).includes('"nodes"'), 'internal parts are not sent anywhere');
});
await test('Blocks placed by pixel positions are listed but cannot take a new one', async () => {
  const b = lists.find(c => c.label.includes('#beams'));
  assert.ok(b && !b.canAdd && b.why === 'FIXED_LAYOUT');
});
await test('A new card: a copy in the same markup, at the end, with its words, link and picture description replaced', async () => {
  const r = take(a.buildItem({ files }, cards.id, { values: { 'h3.card-title': 'Gamma & Co', 'p.role': 'Founder · 2026', link: 'https://gamma.example.com' } }));
  const out = r.content.files['index.html'];
  assert.ok(out.includes(`</article>
      <article class="card">
        <img src="img/alpha.jpg" alt="Gamma &amp; Co">
        <h3 class="card-title">Gamma &amp; Co</h3>
        <p class="role">Founder · 2026</p>
        <a href="https://gamma.example.com">Visit</a>
      </article>
    </div>`), out);
  assert.deepEqual(r.warnings.map(w => w.code), ['ASSET_FROM_TEMPLATE']);
  assert.equal(r.key, '2');
  assert.deepEqual(a.listCollections(r.content).find(c => c.id === cards.id).items.map(i => i.title), ['Alpha', 'Beta', 'Gamma & Co']);
  assert.equal(out.replace(/\n      <article class="card">\n        <img src="img\/alpha.jpg" alt="Gamma[\s\S]*?<\/article>/, ''), PAGE, 'nothing else changed');
  assert.ok(!out.match(/Gamma[\s\S]*?<\/article>/)[0].includes('Won a prize'), 'the copy keeps no words of the copied block');
});
await test('The copy is the block with the most parts; a missing optional line is left out; no link is #; a chosen picture is used', async () => {
  const r = take(a.buildItem({ files }, cards.id, { position: 'start', values: { 'h3.card-title': 'Zero', 'p.role': 'Intern', image: 'img/zero.png' } }));
  const out = r.content.files['index.html'];
  const block = out.slice(out.indexOf('<div class="grid">') + 18, out.indexOf('<article class="card">\n        <img src="img/alpha.jpg"'));
  assert.ok(block.includes('<img src="img/zero.png" alt="Zero">') && block.includes('<h3 class="card-title">Zero</h3>') && block.includes('<a href="#">Visit</a>'), block);
  assert.ok(!block.includes('Won a prize') && !block.includes('class="note"'), 'the optional line is removed, with its line');
  assert.deepEqual(r.warnings.map(w => w.code), ['LINK_EMPTY']);
});
await test('Missing required words are reported; replacing one card keeps the others', async () => {
  const r = take(a.buildItem({ files }, cards.id, { values: { 'h3.card-title': 'Only a title' } }));
  assert.deepEqual(r.missing, ['p.role']);
  const rep = take(a.buildItem({ files }, cards.id, { op: 'replace', key: '0', values: { 'h3.card-title': 'Alpha 2', 'p.role': 'Designer · 2026', link: 'https://alpha.example.com' } }));
  const items = a.listCollections(rep.content).find(c => c.id === cards.id).items.map(i => i.title);
  assert.deepEqual(items, ['Alpha 2', 'Beta']);
});
await test('A plain list item; ids in a copy stay unique and links to them follow', async () => {
  const r = take(a.buildItem({ files }, awards.id, { values: { [awards.titleField]: 'Hackathon winner, 2026' } }));
  assert.ok(r.content.files['index.html'].includes("<li>Dean's List, 2024</li><li>Hackathon winner, 2026</li></ul>"));
  const page = '<ul><li id="a1"><a href="#a1">Alpha project here</a><p>One</p></li><li id="b1"><a href="#b1">Beta project here</a><p>Two</p></li></ul>';
  const l = a.listCollections({ files: { 'x.html': page } })[0];
  const out = take(a.buildItem({ files: { 'x.html': page } }, l.id, { values: { [l.titleField]: 'Gamma project here', p: 'Three' } })).content.files['x.html'];
  assert.ok(out.includes('<li id="b1-2"><a href="#b1-2">'), out);
});
await test('Real sites: the projects of a one-page portfolio, not its menu; nothing found in a page without lists', async () => {
  const site = new URL('../eval/sites/ext2-html-vcard/website/index.html', import.meta.url);
  const text = await fs.readFile(site, 'utf8');
  const l = a.listCollections({ files: { 'index.html': text } });
  const proj = l.find(c => c.label === 'index.html › Portfolio');
  assert.ok(proj && proj.items.length === 9 && proj.canAdd);
  assert.ok(!l.some(c => c.label.includes('navbar')));
  assert.deepEqual(a.listCollections({ files: { 'a.html': '<html><body><h1>Hi</h1><p>Just words.</p><p>More words.</p></body></html>' } }), []);
});
await test('A picture for a new item is saved next to the list\'s pictures under a free name', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sitetend-lists-'));
  process.env.SITETEND_HOME = path.join(tmp, 'home');
  const site = path.join(tmp, 'web'); await fs.mkdir(path.join(site, 'img'), { recursive: true });
  await fs.writeFile(path.join(site, 'index.html'), PAGE); await fs.writeFile(path.join(site, 'img/alpha.jpg'), 'x'); await fs.writeFile(path.join(site, 'img/my-photo.png'), 'taken');
  const { startHost } = await import('../src/host/server.mjs');
  const host = await startHost({ port: 0, log: () => {} });
  try {
    const call = async (p, body, headers = {}) => { const r = await fetch(`http://127.0.0.1:${host.port}${p}`, { method: 'POST', headers: { 'X-Sitetend-Token': host.token, ...headers }, body }); return { status: r.status, j: await r.json() }; };
    assert.equal((await call('/api/workspace/open', JSON.stringify({ path: site }), { 'Content-Type': 'application/json' })).status, 200);
    const up = (name, field = 'image') => call('/api/item-image', new Uint8Array([137, 80, 78, 71]), { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name), 'X-Collection': encodeURIComponent(cards.id), 'X-Field': field });
    const r = await up('My Photo.PNG');
    assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.data.src, 'img/my-photo-2.png');
    assert.deepEqual([...await fs.readFile(path.join(site, 'img/my-photo-2.png'))], [137, 80, 78, 71]);
    assert.equal(await fs.readFile(path.join(site, 'img/my-photo.png'), 'utf8'), 'taken', 'an existing picture is never replaced');
    assert.equal((await up('virus.exe')).status, 400);
    assert.equal((await up('a.png', 'h3.card-title')).status, 400);
    const noTok = await fetch(`http://127.0.0.1:${host.port}/api/item-image`, { method: 'POST', body: 'x' }); assert.equal(noTok.status, 401);
    // and the whole way: a new card suggested, accepted, written
    const prop = await call('/api/proposals/propose-item', JSON.stringify({ collection: cards.id, values: { 'h3.card-title': 'Delta', 'p.role': 'Maker · 2026', link: 'https://delta.example.com', image: r.j.data.src }, reason: 'resume' }), { 'Content-Type': 'application/json' });
    assert.equal(prop.status, 200, JSON.stringify(prop.j));
    const st = await (await fetch(`http://127.0.0.1:${host.port}/api/state`, { headers: { 'X-Sitetend-Token': host.token } })).json();
    const card = st.data.workspace.proposals.find(p => p.kind === 'item' && p.status === 'PENDING');
    assert.equal((await call('/api/proposals/accept', JSON.stringify({ ids: [card.id] }), { 'Content-Type': 'application/json' })).status, 200);
    const page = await fs.readFile(path.join(site, 'index.html'), 'utf8');
    assert.ok(page.includes('<img src="img/my-photo-2.png" alt="Delta">') && page.includes('<h3 class="card-title">Delta</h3>'), page);
  } finally { await host.close(); await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {}); }
});
console.log(`\n${n} HTML list checks passed`);
