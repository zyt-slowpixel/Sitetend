// Text-file websites (HTML, Jekyll YAML/Markdown, Hugo TOML/Markdown): fields, exact edits, and the full edit loop.
import assert from 'node:assert/strict';
import './../src/host/node-polyfills.mjs';
import { TextSiteAdapter, _fieldsOfFile, detectTextMode, contentFilesFor } from '../src/adapters/text-site-adapter.js';
import { MemoryBackedWorkspaceAdapter } from '../src/adapters/workspace-adapter.js';
import { SiteKeeperCore } from '../src/core/engine.js';
import { take } from '../src/agent/utils.js';
let n = 0; const test = async (name, fn) => { await fn(); n++; console.log('✓ ' + name); };
const val = (file, text) => Object.fromEntries(_fieldsOfFile(file, text).map(f => [f.loc, f.value]));

const YML = `# Site settings
title                    : "Jane Doe / Site"   # shown in the header
name                     : &name "Jane Doe"
description: Research on tides, coasts and people
url: https://jane.example.org
author:
  # sidebar
  bio      : 'It''s me'
  email    : "jane@example.org"
  location : Earth
  avatar   : "profile.png"
nav:
  - title: "Publications"
    url: /publications/
  - title: Talks
footer: |
  multi line text
  is left alone
`;
const TOML = `baseURL = "https://example.org"
title = "johndoe"
[params]
author = "John Doe"
info = ["Full Stack DevOps", "Magician"]
[[params.social]]
name = "Github"
url = "https://github.com/johndoe"
`;
const MD = `---
title: "About me"
permalink: /about/
excerpt: 'Short intro'
---

Welcome to my page. I study
coastal tides.

My research
======

- First point with a [link](https://x.org)
- Second point

{% include base_path %}
\`\`\`
code: not a field
\`\`\`
`;
const HTML = `<!DOCTYPE html><html><head><title>Jane &amp; Co</title><style>.a{}</style></head>
<body><nav id="nav"><a href="#about">About</a></nav>
<section id="about"><h1>Jane <span class="x">Doe</span></h1>
<p>  I build   tools for &lt;tiny&gt; teams.  </p><a href="mailto:jane@example.org">Email me</a><i class="fa fa-x"></i>
<script>var s = "fade-in-up"; const projects = [{ title: "Tide Atlas", blurb: "A map of every tide pool in Maine." }];</script></section></body></html>`;

await test('YAML: quoted, bare, anchored, nested, list items; comments, block scalars and settings skipped', async () => {
  const v = val('_config.yml', YML);
  assert.equal(v.title, 'Jane Doe / Site'); assert.equal(v.name, 'Jane Doe'); assert.equal(v.description, 'Research on tides, coasts and people');
  assert.equal(v['author.bio'], "It's me"); assert.equal(v['author.email'], 'jane@example.org'); assert.equal(v['author.location'], 'Earth');
  assert.equal(v['nav.0.title'], 'Publications'); assert.equal(v['nav.1.title'], 'Talks');
  assert.ok(!('url' in v) && !('author.avatar' in v) && !('nav.0.url' in v) && !('footer' in v));
});
await test('TOML: tables, arrays of tables, string arrays as tags', async () => {
  const v = val('hugo.toml', TOML);
  assert.equal(v.title, 'johndoe'); assert.equal(v['params.author'], 'John Doe'); assert.deepEqual(v['params.info'], ['Full Stack DevOps', 'Magician']);
  assert.equal(v['params.social.0.name'], 'Github'); assert.ok(!('baseURL' in v));
});
await test('Markdown: front matter + paragraphs, setext/ATX headings, list items; Liquid and code skipped', async () => {
  const v = val('about.md', MD);
  assert.equal(v['fm.title'], 'About me'); assert.equal(v['fm.excerpt'], 'Short intro'); assert.ok(!('fm.permalink' in v));
  assert.equal(v['body.p0'], 'Welcome to my page. I study coastal tides.'); assert.equal(v['body.h0'], 'My research');
  assert.equal(v['body.li0'], 'First point with a [link](https://x.org)'); assert.equal(Object.keys(v).filter(k => k.startsWith('body.')).length, 4);
});
await test('Named entities (arrows, accented letters) are decoded; unknown ones stay as written', async () => {
  const v = Object.values(val('index.html', '<p>Get in touch &darr;</p><p>&copy; 2026 &mdash; caf&eacute; &Eacute;cole</p><p>Odd &foo; stays</p>'));
  assert.deepEqual(v, ['Get in touch ↓', '© 2026 — café École', 'Odd &foo; stays']);
});
await test('HTML: visible text by element id scope, entities decoded, mailto links; head skipped, words in its own scripts read', async () => {
  const v = val('index.html', HTML);
  assert.equal(v['page.title.0'], 'Jane & Co'); assert.equal(v['about.h1.0'], 'Jane'); assert.equal(v['about.span.0'], 'Doe');
  assert.equal(v['about.p.0'], 'I build tools for <tiny> teams.'); assert.equal(v['about.link.0'], 'jane@example.org'); assert.equal(v['nav.a.0'], 'About');
  assert.ok(!Object.values(v).includes('fade-in-up'));
  assert.equal(v['js.str.0'], 'Tide Atlas'); assert.equal(v['js.str.1'], 'A map of every tide pool in Maine.');   // a page that keeps its projects in a script
});
await test('Edits replace exactly one value and keep everything else byte-for-byte', async () => {
  const a = new TextSiteAdapter('jekyll'); const c = { schemaVersion: 1, siteAdapter: 'text-files', mode: 'jekyll', files: { '_config.yml': YML, 'about.md': MD } };
  let r = take(a.setFieldValue(c, '_config.yml::author.email', 'jane@new.org'));
  assert.equal(r.content.files['_config.yml'], YML.replace('"jane@example.org"', '"jane@new.org"'));
  r = take(a.setFieldValue(c, '_config.yml::author.location', 'Lisbon: Portugal'));     // bare value that now needs quotes
  assert.ok(r.content.files['_config.yml'].includes('location : "Lisbon: Portugal"'));
  r = take(a.setFieldValue(c, '_config.yml::author.bio', "Still me, it's fine"));
  assert.ok(r.content.files['_config.yml'].includes("bio      : 'Still me, it''s fine'"));
  r = take(a.setFieldValue(c, '_config.yml::name', 'J. Doe'));
  assert.ok(r.content.files['_config.yml'].includes('name                     : &name "J. Doe"'));
  r = take(a.setFieldValue(c, 'about.md::body.p0', 'New intro.'));
  assert.equal(r.content.files['about.md'], MD.replace('Welcome to my page. I study\ncoastal tides.', 'New intro.'));
  assert.equal(a.diffContent(c, r.content).data.changes.map(x => x.path).join(), 'about.md::body.p0');
  const h = new TextSiteAdapter('html'); const hc = { files: { 'index.html': HTML } };
  const hr = take(h.setFieldValue(hc, 'index.html::about.p.0', 'I build <b>big</b> tools & more'));
  assert.ok(hr.content.files['index.html'].includes('<p>  I build big tools &amp; more  </p>'));
  assert.equal(h.setFieldValue(hc, 'index.html::about.link.0', 'not-an-email').ok, false);
  const t = new TextSiteAdapter('hugo'); const tc = { files: { 'hugo.toml': TOML } };
  assert.ok(take(t.setFieldValue(tc, 'hugo.toml::params.info', ['Writer', 'Runner'])).content.files['hugo.toml'].includes('info = ["Writer", "Runner"]'));
});
await test('Site kind is detected from the files; theme internals are not content', async () => {
  assert.equal(detectTextMode(['_config.yml', 'index.md']), 'jekyll'); assert.equal(detectTextMode(['hugo.toml', 'content/a.md']), 'hugo'); assert.equal(detectTextMode(['index.html', 'css/x.css']), 'html');
  assert.deepEqual(contentFilesFor('jekyll', ['_config.yml', '_layouts/x.md', 'README.md', '_posts/a.md', 'assets/x.md', '_data/nav.yml']), ['_config.yml', '_data/nav.yml', '_posts/a.md']);
});
await test('Full edit loop on a multi-file site: open, edit, apply, undo, redo; other files untouched', async () => {
  const ws = new MemoryBackedWorkspaceAdapter({ 'website/_config.yml': YML, 'website/about.md': MD, 'website/_layouts/default.html': '<html>{{ content }}</html>' });
  const core = new SiteKeeperCore({ workspaceAdapter: ws, siteAdapter: new TextSiteAdapter('jekyll') }); take(await core.initializeWorkspace());
  take(await core.editDraftField('_config.yml::author.email', 'jane@new.org')); take(await core.applyIfAuto());
  const read = async p => take(await ws.readText(p)).content;
  assert.ok((await read('website/_config.yml')).includes('"jane@new.org"')); assert.equal(await read('website/about.md'), MD);
  take(await core.undo()); assert.equal(await read('website/_config.yml'), YML);
  take(await core.redo()); assert.ok((await read('website/_config.yml')).includes('"jane@new.org"'));
  assert.equal(await read('website/_layouts/default.html'), '<html>{{ content }}</html>');
});
await test('Edits made outside Sitetend in another file are absorbed, not overwritten', async () => {
  const ws = new MemoryBackedWorkspaceAdapter({ 'website/_config.yml': YML, 'website/about.md': MD });
  const core = new SiteKeeperCore({ workspaceAdapter: ws, siteAdapter: new TextSiteAdapter('jekyll') }); take(await core.initializeWorkspace());
  take(await ws.writeText('website/about.md', MD.replace('Short intro', 'Edited by hand')));
  take(await core.editDraftField('_config.yml::author.location', 'Mars')); take(await core.applyIfAuto());
  assert.ok(take(await ws.readText('website/about.md')).content.includes('Edited by hand'));
  assert.ok(take(await ws.readText('website/_config.yml')).content.includes('location : Mars'));
});
await test('Build output: a generated folder ("out/") or file is never content; Hugo / Jekyll output folders are suggested only when built locally', async () => {
  const all = ['index.html', 'about.html', 'out/index.html', 'out/blog/a.html', 'gen.html'];
  assert.deepEqual(contentFilesFor('html', all, new Set(['out/', 'gen.html'])), ['about.html', 'index.html']);
  const fs = await import('node:fs/promises'); const os = await import('node:os'); const path = await import('node:path');
  const { WorkspaceSession } = await import('../src/host/workspace-session.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sitetend-hugo-'));
  await fs.cp(new URL('../eval/sites/own-hugo-band/website', import.meta.url), root, { recursive: true });
  process.env.SITETEND_HOME = process.env.SITETEND_HOME || path.join(root, '.home');
  let s = await new WorkspaceSession({ root, emit: () => {} }).open();
  assert.equal(s.buildSuggestion, null, 'not built here: no suggestion (it may be built by GitHub Pages)'); s.close();
  await fs.mkdir(path.join(root, 'public'), { recursive: true }); await fs.writeFile(path.join(root, 'public/index.html'), '<html><body>built</body></html>');
  s = await new WorkspaceSession({ root, emit: () => {} }).open();
  assert.deepEqual(s.buildSuggestion, { command: 'hugo', generated: ['public/'] }); s.close();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
await test('Windows line endings (CRLF): fields are read, edits and new entries keep CRLF', async () => {
  const crlf = t => t.replace(/\n/g, '\r\n');
  const a = new TextSiteAdapter('jekyll');
  const files = { '_config.yml': crlf(YML), 'about.md': crlf(MD), '_data/people.yml': crlf('- name: "Ann Lee"\n  role: "PI"\n- name: "Bo Chen"\n  role: "Student"\n'),
    'tour.md': crlf('---\ntitle: Tour\n---\n\n- Nov 21, Majestic\n- Dec 5, Blind Pig\n\nSee you.\n') };
  assert.deepEqual(val('_config.yml', files['_config.yml']), val('_config.yml', YML));   // same fields and values as with \n
  assert.deepEqual(val('about.md', files['about.md']), val('about.md', MD));
  const c = { schemaVersion: 1, siteAdapter: 'text-files', mode: 'jekyll', files };
  let r = take(a.setFieldValue(c, '_config.yml::author.email', 'jane@new.org'));
  assert.equal(r.content.files['_config.yml'], crlf(YML).replace('"jane@example.org"', '"jane@new.org"'));
  r = take(a.setFieldValue(c, '_config.yml::description', 'Tides and people'));
  assert.ok(r.content.files['_config.yml'].includes('description: Tides and people\r\n'));
  const ids = a.listCollections(c).filter(x => x.canAdd).map(x => x.id);
  const y = take(a.buildItem(c, ids.find(i => i.startsWith('yaml:')), { values: { name: 'Priya N', role: 'Postdoc' } }));
  assert.equal(y.content.files['_data/people.yml'], crlf('- name: "Ann Lee"\n  role: "PI"\n- name: "Bo Chen"\n  role: "Student"\n- name: "Priya N"\n  role: "Postdoc"\n'));
  const l = take(a.buildItem(c, 'list:tour.md::0', { values: { text: 'Dec 19, Loving Touch' } }));
  assert.equal(l.content.files['tour.md'], crlf('---\ntitle: Tour\n---\n\n- Nov 21, Majestic\n- Dec 5, Blind Pig\n- Dec 19, Loving Touch\n\nSee you.\n'));
  const h = new TextSiteAdapter('hugo'), hc = { files: { 'hugo.toml': crlf('title = "Site"\n[params]\n  tagline = "Old line"\n') } };
  assert.equal(val('hugo.toml', hc.files['hugo.toml'])['params.tagline'], 'Old line');
  assert.equal(take(h.setFieldValue(hc, 'hugo.toml::params.tagline', 'New line')).content.files['hugo.toml'], crlf('title = "Site"\n[params]\n  tagline = "New line"\n'));
});
await test('A Hugo site with config.yml (next to content/) is recognised as a website; a stray config.yml alone is not', async () => {
  const { isSiteFolder } = await import('../src/host/workspace-session.mjs');
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  const a = await fs.mkdtemp(path.join(os.tmpdir(), 'st-hugo-')); await fs.writeFile(path.join(a, 'config.yml'), 'title: X\n'); 
  assert.equal(isSiteFolder(a), false);
  await fs.mkdir(path.join(a, 'content')); await fs.writeFile(path.join(a, 'content', 'about.md'), '---\ntitle: About\n---\nHi\n');
  assert.equal(isSiteFolder(a), true); assert.equal(detectTextMode(['config.yml', 'content/about.md']), 'hugo');
  await fs.rm(a, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
await test('Framework projects (Astro, React/Next, Vue, Svelte): words are found, code is not, edits keep the code valid', async () => {
  assert.equal(detectTextMode(['package.json', 'astro.config.mjs', 'src/pages/index.astro']), 'app');
  assert.equal(detectTextMode(['package.json', 'src/App.js', 'src/index.js']), 'app');            // Create React App
  assert.equal(detectTextMode(['package.json', 'index.html', 'src/main.ts', 'src/App.vue']), 'app');
  assert.deepEqual(contentFilesFor('app', ['package.json', 'src/pages/index.astro', 'node_modules/x/a.js', 'dist/index.html', 'src/env.d.ts', 'vite.config.ts', 'src/utils.ts', 'src/data/site.ts']),
    ['src/data/site.ts', 'src/pages/index.astro']);
  const astro = `---\nimport Layout from "../layouts/Layout.astro";\nconst title = "Hi, I'm Alex";\nconst cls = "flex items-center md:px-4";\n---\n<Layout title={title}>\n  <h1 class="text-xl">Product designer in Detroit</h1>\n  <img src="/me.jpg" alt="Alex at work" />\n  <p>I design {count} calm tools &amp; services.</p>\n</Layout>\n<style>h1{color:red}</style>\n`;
  const af = val('src/pages/index.astro', astro);
  assert.deepEqual(Object.values(af).sort(), ['Alex at work', "Hi, I'm Alex", 'I design', 'Product designer in Detroit', 'calm tools & services.'].sort());
  const jsx = `import React from 'react';\nexport const site = { name: "Sam Lee", role: 'Writer', links: ["https://sam.example"], id: "hero" };\nexport default function Hero({ n }) {\n  if (n < 2 && n > 0) console.log("debug message here");\n  return (<section className="py-8"><h2>Stories about cities</h2><p title="About me">Hello {n} there</p></section>);\n}\n`;
  const jf = _fieldsOfFile('src/Hero.jsx', jsx).map(f => [f.loc, f.label || '', f.value]);
  assert.deepEqual(jf.map(x => x[2]).sort(), ['About me', 'Hello', 'Sam Lee', 'Stories about cities', 'Writer', 'https://sam.example', 'there'].sort());
  assert.ok(jf.some(x => x[1] === 'name' && x[2] === 'Sam Lee') && jf.some(x => x[1] === 'links.0'));
  const vue = `<script setup>\nconst items = [{ title: 'Picture books', slug: 'books' }];\n</script>\n<template>\n  <h1>Mira Okafor</h1>\n  <p v-if="ok">{{ tagline }} and more</p>\n</template>\n<style>p{margin:0}</style>\n`;
  assert.deepEqual(Object.values(val('src/App.vue', vue)).sort(), ['Mira Okafor', 'Picture books', 'and more'].sort());
  const svelte = `<script>\n  const band = { bio: 'Surf rock from Michigan.' };\n</script>\n<h1>{band.bio}</h1>\n{#each shows as s}<li>{s.date} - {s.venue}</li>{/each}\n<p>New record this winter.</p>\n`;
  assert.deepEqual(Object.values(val('src/routes/+page.svelte', svelte)).sort(), ['New record this winter.', 'Surf rock from Michigan.']);
  // writing: quotes, braces and tags are escaped in that spot's own syntax; reading back gives the same words
  const a = new TextSiteAdapter('app');
  const c = { files: { 'src/pages/index.astro': astro, 'src/Hero.jsx': jsx } };
  const path = (file, value) => a.listEditableFields(c).find(f => f.path.startsWith(file) && a.getFieldValue(c, f.path).data.value === value).path;
  for (const [file, from, to] of [['src/pages/index.astro', "Hi, I'm Alex", 'He said "hi" & {left}'], ['src/pages/index.astro', 'Product designer in Detroit', 'Designer {now} <b>in</b> Ann Arbor & more'],
    ['src/Hero.jsx', 'Writer', "Writer's room `x` ${y}"], ['src/Hero.jsx', 'About me', 'About "me"']]) {
    const p = path(file, from), r = take(a.setFieldValue(c, p, to));
    assert.equal(a.getFieldValue(r.content, p).data.value, to.replace(/<\/?b>/g, ''));
    const changed = Object.keys(c.files).filter(f => c.files[f] !== r.content.files[f]); assert.deepEqual(changed, [file]);
  }
  const r = take(a.setFieldValue(c, path('src/Hero.jsx', 'Writer'), "Writer's room"));
  assert.ok(r.content.files['src/Hero.jsx'].includes(`role: 'Writer\\'s room'`));
  assert.ok(r.content.files['src/Hero.jsx'].includes('id: "hero"') && r.content.files['src/Hero.jsx'].includes('className="py-8"'));
});
await test('A website project folder is recognised by its package.json; a plain Node project is not', async () => {
  const { isSiteFolder } = await import('../src/host/workspace-session.mjs');
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  const a = await fs.mkdtemp(path.join(os.tmpdir(), 'st-app-'));
  await fs.writeFile(path.join(a, 'package.json'), JSON.stringify({ dependencies: { express: '4' } })); await fs.mkdir(path.join(a, 'src'));
  assert.equal(isSiteFolder(a), false);
  await fs.writeFile(path.join(a, 'package.json'), JSON.stringify({ dependencies: { astro: '5' } }));
  assert.equal(isSiteFolder(a), true);
  await fs.rm(a, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
await test('Hexo and Eleventy: detected, settings and theme internals skipped, templates and JS front matter read, edits exact', async () => {
  assert.equal(detectTextMode(['_config.yml', 'scaffolds/post.md', 'source/_posts/a.md']), 'hexo');
  assert.equal(detectTextMode(['_config.yml', '_posts/a.md']), 'jekyll');
  assert.equal(detectTextMode(['package.json', '.eleventy.js', 'src/index.njk']), 'eleventy');
  assert.deepEqual(contentFilesFor('hexo', ['_config.yml', 'scaffolds/post.md', 'source/_posts/a.md', 'source/_data/talks.yml', 'themes/x/layout.md', 'public/index.html']),
    ['_config.yml', 'source/_data/talks.yml', 'source/_posts/a.md']);
  assert.deepEqual(contentFilesFor('eleventy', ['src/index.njk', 'src/_includes/base.njk', 'src/_data/site.json', 'src/about.md', 'src/sitemap.xml.njk', 'feed/feed.njk', '_site/index.html', 'node_modules/x/a.md', 'eleventy.config.js', 'README.md']),
    ['src/_data/site.json', 'src/_includes/base.njk', 'src/about.md', 'src/index.njk']);
  assert.deepEqual(val('_config.yml', 'title: Lena\nsource_dir: source\nnew_post_name: :title.md\nlanguage: en\ntime_format: HH:mm:ss\n'), { title: 'Lena' });
  const NJK = '---\nlayout: base.njk\ntitle: Home\n---\n{# a note for me #}\n<h1>{{ site.name }}</h1>\n<p>Calm tools for clinics.</p>\n{% for p in posts %}<li>{{ p.title }}</li>{% endfor %}\n';
  assert.deepEqual(val('index.njk', NJK), { 'fm.title': 'Home', 'page.p.0': 'Calm tools for clinics.' });
  const JSFM = '---js\nconst title = "My fifth post";\nconst eleventyComputed = { title: "Tagged {{ tag }}" };\n---\nA draft & more.\n';
  assert.deepEqual(Object.values(val('post.md', JSFM)), ['My fifth post', 'A draft & more.']);
  assert.deepEqual(Object.values(val('a.md', 'Text\n\n<!-- note\nto self -->\n')), ['Text']);
  const a = new TextSiteAdapter('eleventy'), c = { files: { 'index.njk': NJK, 'post.md': JSFM, '_data/site.json': '{\n  "intro": "I design calm tools."\n}\n' } };
  assert.equal(take(a.setFieldValue(c, 'index.njk::page.p.0', 'Tools for nurses.')).content.files['index.njk'], NJK.replace('Calm tools for clinics.', 'Tools for nurses.'));
  const loc = _fieldsOfFile('post.md', JSFM)[0].loc;
  assert.equal(take(a.setFieldValue(c, 'post.md::' + loc, 'Say "hi"')).content.files['post.md'], JSFM.replace('"My fifth post"', '"Say \\"hi\\""'));
  assert.equal(_fieldsOfFile('_data/site.json', c.files['_data/site.json'])[0].label, 'intro');
});
await test('Quarto and GitHub profile README: detected, rendered output and settings skipped, HTML header and table cells read', async () => {
  assert.equal(detectTextMode(['_quarto.yml', 'index.qmd']), 'quarto');
  assert.equal(detectTextMode(['README.md', 'LICENSE', 'banner.png', '.github/workflows/x.yml']), 'readme');
  assert.equal(detectTextMode(['README.md', 'src/main.py']), 'generic');   // a code project, not a profile
  assert.deepEqual(contentFilesFor('quarto', ['_quarto.yml', 'index.qmd', 'about.md', 'people/pi.yml', 'posts/_metadata.yml', 'docs/index.html', 'docs/search.json', 'docs/site_libs/x.js', 'docs/about.md', '_freeze/a/b.json', 'README.md']),
    ['_quarto.yml', 'about.md', 'index.qmd', 'people/pi.yml']);
  assert.deepEqual(val('_quarto.yml', 'project:\n  type: website\n  output-dir: docs\nwebsite:\n  title: "Lena Varga"\nformat:\n  html:\n    theme: cosmo\n'), { 'website.title': 'Lena Varga' });
  const QMD = '---\ntitle: "About"\nabout:\n  template: jolla\n---\nI study sea stars.\n\n::: {.callout-note}\n\n![](me.jpg){width=50%}\n\n```{r}\nx <- 1\n```\n';
  assert.deepEqual(val('about.qmd', QMD), { 'fm.title': 'About', 'body.p0': 'I study sea stars.' });
  const README = '<h1 align="center">Hi, I am Priya</h1>\n\n### About\n\n- Working on **Shelter Map**\n\n| Project | What |\n| --- | --- |\n| Shelter Map | Bed counts |\n';
  assert.deepEqual(Object.values(val('README.md', README)), ['Hi, I am Priya', 'About', 'Working on **Shelter Map**', 'Project', 'What', 'Shelter Map', 'Bed counts']);
  const a = new TextSiteAdapter('readme'), c = { files: { 'README.md': README } };
  const td = _fieldsOfFile('README.md', README).find(f => f.value === 'Bed counts').loc;
  assert.equal(take(a.setFieldValue(c, 'README.md::' + td, 'Beds | rooms')).content.files['README.md'], README.replace('Bed counts', 'Beds \\| rooms'));
});
await test('Sites made by AI builders: shadcn primitives skipped, client/ projects, Angular templates, Flask and PHP read', async () => {
  assert.equal(detectTextMode(['package.json', 'client/index.html', 'client/src/App.tsx', 'server/index.ts']), 'app');
  assert.deepEqual(contentFilesFor('app', ['package.json', 'client/index.html', 'client/src/App.tsx', 'server/index.ts', 'src/components/ui/button.tsx', 'src/components/Hero.tsx']),
    ['client/index.html', 'client/src/App.tsx', 'src/components/Hero.tsx']);
  assert.equal(detectTextMode(['angular.json', 'package.json', 'src/app/app.component.html']), 'app');
  assert.deepEqual(Object.values(val('about.component.html', '@if (show) {\n  <p>I build tools for nurses.</p>\n} @else {\n  <p>{{ fallback }}</p>\n}\n')), ['I build tools for nurses.']);
  assert.equal(detectTextMode(['app.py', 'requirements.txt', 'templates/index.html', 'static/site.json']), 'server');
  assert.equal(detectTextMode(['index.php', 'header.php', 'style.css']), 'server');
  assert.deepEqual(contentFilesFor('server', ['app.py', 'requirements.txt', 'templates/index.html', 'static/site.json', 'static/css/x.css', 'venv/lib/a.py', 'tests/test_app.py', 'config.py']),
    ['app.py', 'static/site.json', 'templates/index.html']);
  const PY = '"""The app."""\nfrom flask import Flask, render_template\n# a note: don\'t ship\nPROFILE = {"name": "Aisha Bello", "tagline": "I teach kids to code."}\n@app.route("/")\ndef index():\n    return render_template("index.html", title=f"Hi {name}", profile=PROFILE)\n';
  assert.deepEqual(_fieldsOfFile('app.py', PY).map(f => [f.label, f.value]), [['PROFILE.name', 'Aisha Bello'], ['PROFILE.tagline', 'I teach kids to code.']]);
  const PHP = "<?php $cafe = ['name' => 'Little Fern', 'hours' => 'Open 7am to 3pm']; # note\n?>\n<h1><?= $cafe['name'] ?></h1><p>Soup every day.</p>\n";
  assert.deepEqual(_fieldsOfFile('index.php', PHP).map(f => [f.label || f.loc, f.value]), [['page.p.0', 'Soup every day.'], ['cafe.name', 'Little Fern'], ['cafe.hours', 'Open 7am to 3pm']]);
  const a = new TextSiteAdapter('server'), c = { files: { 'index.php': PHP } };
  const loc = _fieldsOfFile('index.php', PHP).find(f => f.value === 'Open 7am to 3pm').loc;
  assert.equal(take(a.setFieldValue(c, 'index.php::' + loc, "Open 7am to 4pm, Sunday's too")).content.files['index.php'], PHP.replace('Open 7am to 3pm', "Open 7am to 4pm, Sunday\\'s too"));
});
await test('A website one folder down is found; a repo with two is not guessed', async () => {
  const { nestedSiteFolder } = await import('../src/host/workspace-session.mjs');
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nested-'));
  await fs.mkdir(path.join(root, 'profolio', 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'profolio', 'package.json'), '{"dependencies":{"react":"18"}}'); await fs.writeFile(path.join(root, 'README.md'), '# repo');
  assert.equal(nestedSiteFolder(root), path.join(root, 'profolio'));
  await fs.mkdir(path.join(root, 'docs-site')); await fs.writeFile(path.join(root, 'docs-site', 'index.html'), '<h1>Docs</h1>');
  assert.equal(nestedSiteFolder(root), null);
});
await test('Any other website project opens in a general mode; a Documents folder, a folder of websites or a plain program does not', async () => {
  const { isGenericSiteFolder, isSiteFolder } = await import('../src/host/workspace-session.mjs');
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  assert.equal(detectTextMode(['mkdocs.yml', 'docs/index.md']), 'generic');
  assert.deepEqual(contentFilesFor('generic', ['mkdocs.yml', 'docs/index.md', 'src/App.jsx', 'src/components/ui/button.jsx', 'node_modules/x/a.md', 'package.json', 'vite.config.js', 'dist/index.html', 'README.md', 'tests/a.test.js', 'src/data.ts']),
    ['docs/index.md', 'mkdocs.yml', 'src/App.jsx', 'src/data.ts']);
  assert.deepEqual(val('mkdocs.yml', 'site_name: Lab Notes\nnav:\n  - Home: index.md\ntheme:\n  name: material\n'), { site_name: 'Lab Notes' });
  const t = await fs.mkdtemp(path.join(os.tmpdir(), 'generic-'));
  const mk = async (rel, body = '') => { await fs.mkdir(path.dirname(path.join(t, rel)), { recursive: true }); await fs.writeFile(path.join(t, rel), body); };
  await mk('docsite/mkdocs.yml', 'site_name: x'); await mk('docsite/docs/index.md', '# Hi');
  await mk('webapp/package.json', '{}'); await mk('webapp/src/main.js', 'document.title = "Hello there"');
  for (const f of ['a.pdf', 'b.pdf', 'c.docx', 'd.jpg', 'e.jpg', 'f.png', 'g.xlsx', 'saved.html']) await mk('Documents/' + f);
  await mk('program/pyproject.toml', '[project]'); await mk('program/pkg/main.py', 'print(1)');
  await mk('Projects/old/resume/index.html', '<h1>Me</h1>'); await mk('Projects/notes.md', '# notes');
  assert.equal(isGenericSiteFolder(path.join(t, 'docsite')), true);
  assert.equal(isGenericSiteFolder(path.join(t, 'webapp')), true);
  assert.equal(isSiteFolder(path.join(t, 'Documents')) || isGenericSiteFolder(path.join(t, 'Documents')), false);
  assert.equal(isGenericSiteFolder(path.join(t, 'program')), false);
  assert.equal(isGenericSiteFolder(path.join(t, 'Projects')), false);   // it holds a website: Sitetend lists it instead
});
await test('Framework project end to end: edit a value in config.ts, the build runs, the built page changes; undo rebuilds the old page', async () => {
  const { WorkspaceSession } = await import('../src/host/workspace-session.mjs');
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  process.env.SITETEND_HOME ||= await fs.mkdtemp(path.join(os.tmpdir(), 'st-home-'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'st-app-e2e-'));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'mini', scripts: { build: 'node build.mjs' }, devDependencies: { astro: '5' } }));
  await fs.writeFile(path.join(root, 'src', 'config.ts'), 'export const siteConfig = {\n  name: "Ryan Fitzgerald",\n  title: "Senior Software Engineer",\n};\n');
  // stands in for "astro build": reads the config, writes dist/index.html
  await fs.writeFile(path.join(root, 'build.mjs'), "import fs from 'node:fs';\nconst t = fs.readFileSync('src/config.ts', 'utf8');\nfs.mkdirSync('dist', { recursive: true });\nfs.writeFileSync('dist/index.html', '<p>' + t.match(/title: \"([^\"]*)\"/)[1] + '</p>');\n");
  const s = await new WorkspaceSession({ root, emit: () => {}, build: { command: 'npm run build', generated: ['dist/'] } }).open();
  assert.equal(s.site.mode, 'app');
  const f = (await s.fields()).find(x => x.value === 'Senior Software Engineer');
  await s.edit(f.path, 'Staff Software Engineer'); assert.equal((await s.runBuild('change')).ok, true);
  assert.equal(await fs.readFile(path.join(root, 'dist', 'index.html'), 'utf8'), '<p>Staff Software Engineer</p>');
  await s.undo(); await s.runBuild('undo');
  assert.equal(await fs.readFile(path.join(root, 'dist', 'index.html'), 'utf8'), '<p>Senior Software Engineer</p>');
  assert.equal(await fs.readFile(path.join(root, 'src', 'config.ts'), 'utf8'), 'export const siteConfig = {\n  name: "Ryan Fitzgerald",\n  title: "Senior Software Engineer",\n};\n');
  s.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
await test('Server templates (EJS, ERB, Handlebars, Twig, Jinja, PHP): words are read, template code is never touched', async () => {
  const { WorkspaceSession } = await import('../src/host/workspace-session.mjs');
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  assert.deepEqual(val('a.php', '<h1>Hello <?= $name ?>!</h1><p>Welcome to the cafe.</p>'), { 'page.p.0': 'Welcome to the cafe.' });   // "Hello !" would overwrite the PHP
  assert.deepEqual(val('views/index.ejs', '<h1>Hi <%= name %></h1><% if (x) { %><p>I fix bikes.</p><% } %><%# a note to myself %>'), { 'page.p.0': 'I fix bikes.' });
  assert.deepEqual(val('views/home.hbs', '{{!-- page notes --}}<h1>{{title}}</h1><p>I build tools for libraries.</p>{{#each items}}<li>{{this}}</li>{{/each}}'), { 'page.p.0': 'I build tools for libraries.' });
  assert.deepEqual(val('templates/a.twig', '{% block body %}<h2>About me</h2><p>Hi, I am {{ name }}.</p>{# old: I teach design #}{% endblock %}'), { 'page.h2.0': 'About me' });
  assert.deepEqual(val('templates/index.html', '<h1>{{ title }}</h1><p>Welcome to my lab.</p>{% for p in pubs %}<li>{{ p }}</li>{% endfor %}'), { 'page.p.0': 'Welcome to my lab.' });
  assert.equal(detectTextMode(['package.json', 'app.js', 'views/index.ejs']), 'server');
  assert.equal(detectTextMode(['Gemfile', 'app/views/home/index.html.erb']), 'server');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'st-ejs-'));
  process.env.SITETEND_HOME ||= await fs.mkdtemp(path.join(os.tmpdir(), 'st-home-'));
  await fs.mkdir(path.join(root, 'views'));
  await fs.writeFile(path.join(root, 'package.json'), '{"dependencies":{"express":"4","ejs":"3"}}');
  const page = '<%- include("header") %>\n<p>I build accessible tools for public libraries.</p>\n<p>Email: <%= email %></p>\n';
  await fs.writeFile(path.join(root, 'views', 'index.ejs'), page);
  const s = await new WorkspaceSession({ root, emit: () => {} }).open();
  assert.equal(s.site.mode, 'server');
  const f = (await s.fields()).find(x => x.value === 'I build accessible tools for public libraries.');
  await s.edit(f.path, 'I build accessible tools for public libraries and schools.');
  assert.equal(await fs.readFile(path.join(root, 'views', 'index.ejs'), 'utf8'), page.replace('libraries.</p>', 'libraries and schools.</p>'));
  s.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

await test('HTML links: editing a mailto/http link changes only the address and keeps the attribute quotes', async () => {
  const h = new TextSiteAdapter('html');
  for (const [html, value, want] of [
    ['<p><a href="mailto:a@b.org">Mail</a></p>', 'new@x.org', '<p><a href="mailto:new@x.org">Mail</a></p>'],
    ['<p><a class="x" href="mailto:a@b.org" style="c">Mail</a></p>', 'new@x.org', '<p><a class="x" href="mailto:new@x.org" style="c">Mail</a></p>'],
    ['<p><a href="https://old.example/x">Site</a></p>', 'https://new.example/', '<p><a href="https://new.example/">Site</a></p>'],
    ['<p><A\n  HREF="mailto:a@b.org">Mail</A></p>', 'new@x.org', '<p><A\n  HREF="mailto:new@x.org">Mail</A></p>'],
  ]) {
    const c = { files: { 'index.html': html } };
    const f = h.listEditableFields(c).find(x => x.path.includes('.link.'));
    assert.equal(take(h.setFieldValue(c, f.path, value)).content.files['index.html'], want);
  }
});
await test('Pictures written into a page do not count toward the 2 MB limit; pages too large or beyond 1,000 are reported', async () => {
  const pic = 'data:image/webp;base64,' + 'A'.repeat(3 * 1024 * 1024);
  const ws = new MemoryBackedWorkspaceAdapter({ 'website/index.html': `<h1>Jane</h1><img src="${pic}">`, 'website/big.html': '<p>' + 'word '.repeat(500 * 1024) + '</p>' });
  const a = new TextSiteAdapter('html'); const r = take(await a.readContent(ws));
  assert.ok('index.html' in r.data.files); assert.ok(!('big.html' in r.data.files)); assert.deepEqual(a.skipped, ['big.html']);
  const many = Object.fromEntries(Array.from({ length: 1003 }, (_, i) => [`website/p${String(i).padStart(4, '0')}.html`, `<p>Page ${i}</p>`]));
  const b = new TextSiteAdapter('html'); const rb = take(await b.readContent(new MemoryBackedWorkspaceAdapter(many)));
  assert.equal(Object.keys(rb.data.files).length, 1000); assert.deepEqual(b.skipped, ['p1000.html', 'p1001.html', 'p1002.html']);
});
await test('Script strings that are code (canvas contexts, style text, fonts, transitions, markup, regex pieces) are not text to edit', async () => {
  const v = Object.values(val('index.html', `<p>Hi</p><script>const a=c.getContext('2d');el.style.cssText='display:flex;gap:';ctx.font='400 16px Inter';el.style.transition='opacity .25s ease';
    box.innerHTML='<p class="m">Loading…</p>';s=s.replace(/(src=")images\\//g,'$1cases/'+slug+'/');const half=w/2,q=h/d;const T={title:'Within Reach',tag:'UI & UX · Product'};
    st.textContent='.lay.k-red,.lay.k-yel{cursor:pointer}';q=P.querySelector('.lay[data-k="'+k+'"]');b.style.backgroundRepeat=['no-repeat,repeat-y'][0];x=['&amp;'];g=['225,128,8,${'A'.repeat(80)}'];</script>`));
  for (const bad of ['2d', 'display:flex;gap:', '400 16px Inter', 'opacity .25s ease', '<p class="m">Loading…</p>', '.lay.k-red,.lay.k-yel{cursor:pointer}', 'no-repeat,repeat-y', '&amp;']) assert.ok(!v.includes(bad), bad);
  assert.ok(v.includes('Within Reach')); assert.ok(v.includes('UI & UX · Product'));
});
await test('Write-back: task-list items, tags in code strings, and multi-line queries', async () => {
  const j = new TextSiteAdapter('jekyll'); const c = { files: { 'a.md': '# T\n\n- [ ] Milk\n- [x] Cookies\n' } };
  const li = j.listEditableFields(c).filter(f => f.path.includes('.li'));
  assert.equal(take(j.setFieldValue(c, li[0].path, 'Bread')).content.files['a.md'], '# T\n\n- [ ] Bread\n- [x] Cookies\n');
  const a = new TextSiteAdapter('app'); const ac = { files: { 'src/App.jsx': 'const P=[{title:"Old"}];\nexport default ()=>(<main><h1>Projects</h1><p>Intro text here.</p></main>);\n' } };
  const s0 = a.listEditableFields(ac).find(f => f.path.includes('::str.'));
  const out = take(a.setFieldValue(ac, s0.path, 'Has <b>tag</b>')).content;
  assert.equal(take(a.getFieldValue(out, s0.path)).value, 'Has <b>tag</b>');
  assert.deepEqual(a.listEditableFields(out).map(f => f.path), a.listEditableFields(ac).map(f => f.path));   // no new "tags" in the template
  assert.ok(!Object.values(val('gatsby-config.js', 'module.exports={plugins:[{options:{query:`\n  {\n    site { siteMetadata { title } }\n  }\n`, title:"My blog"}}]}')).some(v => /siteMetadata/.test(v)));
});
await test('Pages not saved as UTF-8 are left alone (not damaged); byte-order marks and Windows line ends survive an edit', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { NodeFsWorkspaceAdapter } = await import('../src/adapters/node-workspace-adapter.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-enc-'));
  const gbk = Buffer.from([0x3c,0x70,0x3e,0xd5,0xc5,0xc8,0xfd,0x3c,0x2f,0x70,0x3e,0x3c,0x70,0x3e,0x48,0x69,0x20,0x74,0x68,0x65,0x72,0x65,0x3c,0x2f,0x70,0x3e]);   // <p>(GBK name)</p><p>Hi there</p>
  fs.writeFileSync(path.join(dir, 'old.html'), gbk);
  fs.writeFileSync(path.join(dir, 'bom.html'), '﻿<p>Hello there</p>\r\n<p>Second line</p>\r\n');
  const ws = new NodeFsWorkspaceAdapter(dir, 'enc', 'site'); const a = new TextSiteAdapter('html');
  let c = take(await a.readContent(ws)).data; assert.deepEqual(Object.keys(c.files), ['bom.html']); assert.deepEqual(a.notUtf8, ['old.html']);
  const f = a.listEditableFields(c).find(x => take(a.getFieldValue(c, x.path)).value === 'Hello there');
  assert.ok((await a.writeContent(ws, take(a.setFieldValue(c, f.path, 'Changed')).content)).ok);
  assert.equal(fs.readFileSync(path.join(dir, 'bom.html'), 'utf8'), '﻿<p>Changed</p>\r\n<p>Second line</p>\r\n');
  assert.ok(fs.readFileSync(path.join(dir, 'old.html')).equals(gbk));
  const { decodeText } = await import('../src/adapters/text-decode.js');
  assert.equal(decodeText(new Uint8Array([0xd5,0xc5,0xc8,0xfd,0xb5,0xc4,0xbc,0xf2,0xc0,0xfa])).text, JSON.parse(fs.readFileSync(new URL('./fixtures/zh-input.json', import.meta.url), 'utf8')).gbkResumeTitle);   // a GBK material is read correctly
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
await test('Markdown: a ````markdown block that shows a ``` example inside is code to the end', async () => {
  assert.deepEqual(Object.values(val('a.md', 'Intro para.\n\n````markdown\n```diff\n+ added line\n- removed line\n```\n````\n\nAfter para.\n\n~~~\ncode\n~~~\n\nEnd para.\n')), ['Intro para.', 'After para.', 'End para.']);
});
await test('SVG: words in <text>/<tspan> are fields (and stay SVG when marked for the preview); shapes, titles and styles are not', async () => {
  const { annotateHtml } = await import('../src/adapters/text-site-adapter.js');
  const page = '<p>Hi</p><svg viewBox="0 0 10 10"><title>Logo</title><path d="M0 0L5 5"/><text x="1">Hello <tspan>World</tspan></text><style>.a{fill:red}</style></svg><p>After</p>';
  assert.deepEqual(Object.values(val('a.html', page)), ['Hi', 'Hello', 'World', 'After']);
  const marked = annotateHtml('a.html', page);
  assert.ok(/<text x="1"><tspan data-sk-field="a\.html::[^"]+">Hello<\/tspan>/.test(marked) && /<p><span data-sk-field=[^>]+>Hi<\/span>/.test(marked));
  const ws = new MemoryBackedWorkspaceAdapter({ 'website/a.html': page });
  const core = new SiteKeeperCore({ workspaceAdapter: ws, siteAdapter: new TextSiteAdapter('html') }); take(await core.initializeWorkspace());
  take(await core.editDraftField('a.html::page.text.0', 'Hey & you')); take(await core.applyIfAuto());
  assert.equal(take(await ws.readText('website/a.html')).content, page.replace('>Hello <', '>Hey &amp; you <'));
});
console.log(`${n} text-site checks passed`);
