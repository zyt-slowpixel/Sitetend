// Netlify publishing against a local fake of the Netlify API that checks what a real deploy needs: the token on
// every call, a SHA1 for every file, uploads only of what was asked for, uploaded bytes that match their SHA1,
// and a deploy that only goes live when everything arrived. Then the same through a running Sitetend.
import fs from 'node:fs'; import fsp from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http';
import crypto from 'node:crypto'; import { spawn } from 'node:child_process'; import { fileURLToPath } from 'node:url';

const TOKEN = 'nf-token-123', SITE_ID = '3970e0fe-8564-4903-9a55-c5f8de49fb8b';
let pass = 0; const ok = (c, m) => { if (!c) { console.error('✗ ' + m); process.exit(1); } pass++; console.log('✓ ' + m); };
const sha1 = b => crypto.createHash('sha1').update(b).digest('hex');

// ---- the fake API
const store = new Map();              // sha1 -> bytes
const deploys = new Map();            // id -> { files, draft, required: Set, polls, state }
const live = { deploy: null };
let n = 0, rate429 = 0, put502 = 0, puts = 0, badPut = null, wrongUA = false;
const site = { id: SITE_ID, name: 'my-site', url: 'http://www.example.com', ssl_url: 'https://www.example.com', custom_domain: 'www.example.com' };
const fake = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c); const raw = Buffer.concat(chunks);
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/^\/api\/v1/, ''));
  const send = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { code: 401, message: 'Access Denied' });
  if (!req.headers['user-agent']) wrongUA = true;
  let m;
  if (req.method === 'GET' && (m = p.match(/^\/sites\/([^/]+)$/))) return [SITE_ID, 'my-site.netlify.app', 'www.example.com'].includes(m[1]) ? send(200, site) : send(404, { code: 404, message: 'Not Found' });
  if (req.method === 'POST' && (m = p.match(/^\/sites\/([^/]+)\/deploys$/))) {
    if (![SITE_ID, 'my-site.netlify.app'].includes(m[1])) return send(404, { message: 'Not Found' });
    if (rate429 > 0) { rate429--; return send(429, { message: 'Rate limit' }, { 'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000)) }); }
    const body = JSON.parse(raw); if (!body.files || typeof body.files !== 'object') return send(422, { message: 'files required' });
    const id = 'd' + ++n; const required = new Set(Object.values(body.files).filter(h => !store.has(h)));
    deploys.set(id, { files: body.files, draft: Boolean(body.draft), required, polls: 0, state: body.async ? 'preparing' : 'prepared' });
    return send(200, body.async ? { id, state: 'preparing', required: [] } : { id, state: 'prepared', required: [...required] });   // while preparing, the list is empty and not final
  }
  if (req.method === 'GET' && (m = p.match(/^\/deploys\/([^/]+)$/))) {
    const d = deploys.get(m[1]); if (!d) return send(404, { message: 'Not Found' });
    d.polls++;
    if (d.state === 'preparing' && d.polls >= 2) d.state = 'prepared';
    if (d.state === 'prepared' && d.required.size === 0 && d.uploadedAny !== undefined) d.state = 'processing';
    else if (d.state === 'processing') { d.state = 'ready'; if (!d.draft) live.deploy = m[1]; }
    else if (d.state === 'prepared' && d.required.size === 0) { d.state = 'processing'; }
    return send(200, { id: m[1], state: d.state, required: d.state !== 'preparing' ? [...d.required] : [], deploy_ssl_url: `https://${m[1]}--my-site.netlify.app` });
  }
  if (req.method === 'PUT' && (m = p.match(/^\/deploys\/([^/]+)\/files\/(.+)$/))) {
    const d = deploys.get(m[1]); if (!d) return send(404, { message: 'Not Found' });
    if (req.headers['content-type'] !== 'application/octet-stream') return send(415, { message: 'octet-stream required' });
    if (put502 > 0) { put502--; return send(502, { message: 'Bad gateway' }); }
    const want = d.files['/' + m[2]];
    if (!want) { badPut = 'not in deploy: ' + m[2]; return send(422, { message: 'not in deploy' }); }
    if (sha1(raw) !== want) { badPut = 'wrong bytes: ' + m[2]; return send(422, { message: 'sha mismatch' }); }
    if (!d.required.has(want)) { badPut = 'not required: ' + m[2]; }
    store.set(want, raw); d.required.delete(want); d.uploadedAny = true; puts++;
    return send(200, { id: want });
  }
  send(404, { message: 'unknown ' + p });
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
process.env.SITETEND_NETLIFY_API = `http://127.0.0.1:${fake.address().port}/api/v1`;
const { netlifyPublish, netlifyCheck, collectFiles, normalizeSite } = await import('../src/host/publisher-netlify.mjs');

const verify = (id, dir) => { const d = deploys.get(id); return d.state === 'ready' && Object.entries(d.files).every(([p, h]) => store.has(h) && store.get(h).equals(fs.readFileSync(path.join(dir, p.slice(1))))); };

// ---- a site
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitetend-nl-'));
const dir = path.join(tmp, 'site');
const put = (p, c) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), c); };
put('index.html', '<!doctype html><html><head><title>Me</title></head><body><h1>Alex Doe</h1><p>alex@example.org</p><a href="about.html">About</a></body></html>');
put('about.html', '<!doctype html><html><body><p>About me</p></body></html>');
put('css/site.css', 'body{font-family:sans-serif}');
put('img/photo one.png', Buffer.from([137, 80, 78, 71, 1, 2, 3]));
put('img/copy.png', Buffer.from([137, 80, 78, 71, 1, 2, 3]));           // same bytes as photo one.png: uploaded once
put('_redirects', '/old /about.html 301\n'); put('_headers', '/*\n  X-Frame-Options: DENY\n'); put('netlify.toml', '[build]\n  publish = "."\n');
put('.env', 'SECRET=1'); put('.sitetend/notes.txt', 'private'); put('.netlify/state.json', '{}'); put('node_modules/x/index.js', 'x'); put('.DS_Store', 'x');

ok(normalizeSite('https://My-Site.netlify.app/about') === 'my-site.netlify.app' && normalizeSite('my-site') === 'my-site.netlify.app' && normalizeSite(SITE_ID) === SITE_ID && normalizeSite('www.example.com') === 'www.example.com' && normalizeSite('bad site!') === '', 'site addresses, bare names and Project IDs are understood');
const { files } = await collectFiles(dir);
const names = files.map(f => f.path).sort();
ok(names.join(',') === '_headers,_redirects,about.html,css/site.css,img/copy.png,img/photo one.png,index.html,netlify.toml', 'uploads pages, _headers, _redirects and netlify.toml as files; skips .env, .sitetend, .netlify, node_modules, system files: ' + names.join(','));

const bad = async (fn, code, m) => { try { await fn(); ok(false, m); } catch (e) { ok(e.code === code, `${m} (${e.code}: ${e.message.slice(0, 90)})`); } };
await bad(() => netlifyCheck({ token: 'wrong', site: 'my-site' }), 'NL_AUTH', 'a wrong token is reported as such');
await bad(() => netlifyCheck({ token: TOKEN, site: 'other-site' }), 'NL_NO_SITE', 'a site that does not exist is reported');
await bad(() => netlifyCheck({ token: TOKEN, site: '' }), 'NL_BAD_SITE', 'an empty site is caught before calling Netlify');
await bad(() => netlifyCheck({ token: '', site: 'my-site' }), 'NL_NO_TOKEN', 'no token saved yet');
const info = await netlifyCheck({ token: TOKEN, site: 'my-site' });
ok(info.url === 'https://www.example.com' && info.id === SITE_ID, 'the check returns the site address and ID');

let r = await netlifyPublish({ token: TOKEN, site: 'my-site', dir });
ok(r.files === 8 && r.uploaded === 7 && puts === 7, `first deploy: 8 files, 7 uploads (two images share bytes) (${r.uploaded})`);
ok(verify(r.id, dir) && live.deploy === r.id && r.production && r.url === 'https://www.example.com', 'the deploy is complete, exact, live, and reports the live address');
ok(!badPut && !wrongUA, 'only asked-for files were uploaded, each with matching bytes, with a User-Agent');
ok(deploys.get(r.id).files['/img/photo one.png'], 'file names with spaces arrive intact');

put('index.html', fs.readFileSync(path.join(dir, 'index.html'), 'utf8').replace('alex@', 'hello@'));
const p0 = puts; r = await netlifyPublish({ token: TOKEN, site: 'my-site.netlify.app', dir });
ok(r.uploaded === 1 && puts === p0 + 1 && verify(r.id, dir) && live.deploy === r.id, 'after one edit only 1 file is uploaded and the new deploy is live');

rate429 = 1; put502 = 2; put('about.html', '<p>About, updated</p>');
r = await netlifyPublish({ token: TOKEN, site: 'my-site', dir });
ok(r.uploaded === 1 && verify(r.id, dir), 'a rate limit and two gateway errors are retried and the deploy still completes');

const liveBefore = live.deploy; put('css/site.css', 'body{font-family:serif}');
r = await netlifyPublish({ token: TOKEN, site: 'my-site', draft: true, dir });
ok(deploys.get(r.id).draft && live.deploy === liveBefore && !r.production && /--my-site\.netlify\.app/.test(r.url), 'a preview does not change the live site and returns its own address');

put('netlify/functions/hello.js', 'export default () => new Response("hi")');
await bad(() => netlifyPublish({ token: TOKEN, site: 'my-site', dir }), 'NL_FUNCTIONS', 'a site with Netlify Functions is not half-uploaded');
fs.rmSync(path.join(dir, 'netlify'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'withfn/netlify/functions'), { recursive: true }); fs.mkdirSync(path.join(tmp, 'withfn/dist')); fs.writeFileSync(path.join(tmp, 'withfn/dist/index.html'), 'x');
await bad(() => netlifyPublish({ token: TOKEN, site: 'my-site', dir: path.join(tmp, 'withfn/dist'), root: path.join(tmp, 'withfn') }), 'NL_FUNCTIONS', 'Functions next to the build output (not inside it) are noticed too');
put('a#b.html', 'x');
await bad(() => netlifyPublish({ token: TOKEN, site: 'my-site', dir }), 'NL_BAD_NAME', 'a file name Netlify cannot take is reported before deploying');
fs.rmSync(path.join(dir, 'a#b.html'));

// ---- through a running Sitetend
const home = path.join(tmp, 'home'); fs.mkdirSync(home);
const port = 56000 + Math.floor(Math.random() * 900);
const host = spawn(process.execPath, ['bin/sitetend.mjs', '--no-open'], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, HOME: home, USERPROFILE: home, SITETEND_HOME: path.join(home, '.sitetend'), PORT: String(port) }, stdio: 'pipe' });
let out = ''; host.stdout.on('data', c => out += c); host.stderr.on('data', c => out += c);
for (let i = 0; i < 100 && !/running/.test(out); i++) await new Promise(r => setTimeout(r, 100));
const tok = JSON.parse(fs.readFileSync(path.join(home, '.sitetend/host.json'), 'utf8')).token;
const api = async (method, p, body) => { const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', 'x-sitetend-token': tok }, body: body ? JSON.stringify(body) : undefined }); return res.json(); };
try {
  let j = await api('POST', '/api/workspace/open', { path: dir }); ok(j.ok, 'Sitetend opens the site');
  j = await api('POST', '/api/settings', { publishMode: 'netlify' }); ok(j.ok, 'publish mode can be set to Netlify');
  j = await api('GET', '/api/publish/status'); ok(j.data.netlify.ready === false && j.data.netlify.hasToken === false, 'not ready before setup');
  j = await api('POST', '/api/publish/host', { host: 'netlify', site: 'https://My-Site.netlify.app/', token: TOKEN });
  ok(j.ok && j.data.netlify.ready && j.data.netlify.site === 'my-site.netlify.app' && j.data.netlify.files === 8, 'settings are saved and cleaned up; 8 files would be uploaded');
  ok(!JSON.stringify(j).includes(TOKEN) && fs.readFileSync(path.join(home, '.sitetend/.env'), 'utf8').includes('NETLIFY_AUTH_TOKEN=' + TOKEN), 'the token is in ~/.sitetend/.env only and never sent back');
  j = await api('POST', '/api/publish/host', { host: 'nope' }); ok(!j.ok && j.error.code === 'BAD_REQUEST', 'an unknown host is refused');
  j = await api('POST', '/api/publish/host/check', { host: 'netlify' }); ok(j.ok && j.data.url === 'https://www.example.com' && j.data.files === 8, 'connection test works');
  j = await api('POST', '/api/publish', {}); ok(j.ok && j.data.mode === 'netlify' && j.data.files === 8 && live.deploy === j.data.id && verify(j.data.id, dir), 'Publish deploys to Netlify, complete and live');
  j = await api('GET', '/api/state'); ok(j.data.workspace?.liveIsPublished === true && j.data.workspace.published?.publisherId === 'netlify', 'the version is recorded as published (by Netlify)');
  j = await api('GET', '/api/publish/status'); ok(j.data.netlify.last?.live === 'https://www.example.com', 'the last upload is remembered');
  // the folder setting is shared: point it at a subfolder that does not exist
  j = await api('POST', '/api/publish/host', { host: 'netlify', site: 'my-site', folder: 'dist' }); ok(j.ok && j.data.folder === 'dist' && j.data.netlify.files?.error === 'PUB_FOLDER_MISSING', 'a missing upload folder is shown before publishing');
  j = await api('POST', '/api/publish/host', { host: 'netlify', site: 'my-site', folder: 'C:/Windows' }); ok(!j.ok && j.error.code === 'PUB_FOLDER_OUTSIDE', 'an absolute folder is refused');
  await api('POST', '/api/publish/host', { host: 'netlify', site: 'my-site', folder: '' });
  // Cloudflare settings live next to Netlify's without mixing
  j = await api('POST', '/api/publish/host', { host: 'cloudflare', accountId: '0123456789abcdef0123456789abcdef', project: 'x' });
  ok(j.ok && j.data.netlify.site === 'my-site.netlify.app' && j.data.cloudflare.project === 'x' && j.data.mode === 'netlify', 'Cloudflare and Netlify settings are kept apart');
  await api('POST', '/api/publish/host', { host: 'netlify', site: 'my-site', token: 'bad' });
  fs.appendFileSync(path.join(dir, 'about.html'), '<!-- x -->');
  j = await api('POST', '/api/publish', {}); ok(!j.ok && j.error.code === 'NL_AUTH', 'a wrong token gives a clear error, not an internal one');
} finally { host.kill(); fake.close(); }
await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
console.log(`${pass} Netlify checks passed`);
