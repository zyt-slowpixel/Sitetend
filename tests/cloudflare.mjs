// Cloudflare Pages publishing against a local fake of the Cloudflare API that checks what a real deployment needs:
// the right token on each call, file names that match their content (BLAKE3), a manifest for every file, and
// _headers / _redirects sent as their own parts. Then the same through a running Sitetend.
import fs from 'node:fs'; import fsp from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http';
import { spawn } from 'node:child_process'; import { fileURLToPath } from 'node:url';
import { blake3 } from '../src/host/blake3.mjs';

const TOKEN = 'test-token-123', ACCOUNT = '0123456789abcdef0123456789abcdef', PROJECT = 'my-site';
let pass = 0; const ok = (c, m) => { if (!c) { console.error('✗ ' + m); process.exit(1); } pass++; console.log('✓ ' + m); };

// ---- the fake API
const store = new Map();        // hash -> { value, contentType }
const deployments = [];
const log = [];
let jwtN = 0, fail500 = 0, expireNext = false;
const makeJwt = () => { const exp = expireNext ? Math.floor(Date.now() / 1000) - 10 : Math.floor(Date.now() / 1000) + 300; expireNext = false;
  return 'x.' + Buffer.from(JSON.stringify({ exp, n: ++jwtN })).toString('base64url') + '.y'; };
const liveJwts = new Set();
const fake = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c); const raw = Buffer.concat(chunks);
  const url = new URL(req.url, 'http://x'); const p = url.pathname.replace(/^\/client\/v4/, '');
  const auth = String(req.headers.authorization || '').replace(/^Bearer /, '');
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const okr = result => send(200, { success: true, errors: [], result });
  log.push(`${req.method} ${p}`);
  const accountCall = p.startsWith(`/accounts/`);
  if (accountCall && auth !== TOKEN) return send(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] });
  if (!accountCall) {
    const payload = JSON.parse(Buffer.from(auth.split('.')[1] || '', 'base64url').toString() || '{}');
    if (!liveJwts.has(auth) || payload.exp * 1000 < Date.now()) return send(401, { success: false, errors: [{ code: 8000013, message: 'Expired JWT' }] });
  }
  const projBase = `/accounts/${ACCOUNT}/pages/projects/`;
  if (accountCall && !p.startsWith(projBase)) return send(404, { success: false, errors: [{ code: 7003, message: 'Could not route' }] });
  if (req.method === 'GET' && p === projBase + PROJECT) return okr({ name: PROJECT, subdomain: 'my-site.pages.dev', domains: ['my-site.pages.dev', 'www.example.com'], production_branch: 'main' });
  if (req.method === 'GET' && p.startsWith(projBase) && !p.includes('/', projBase.length)) return send(404, { success: false, errors: [{ code: 8000007, message: 'Project not found' }] });
  if (req.method === 'GET' && p === projBase + PROJECT + '/upload-token') { const j = makeJwt(); liveJwts.add(j); return okr({ jwt: j }); }
  if (req.method === 'POST' && p === '/pages/assets/check-missing') { const { hashes } = JSON.parse(raw); return okr(hashes.filter(h => !store.has(h))); }
  if (req.method === 'POST' && p === '/pages/assets/upload') {
    if (fail500 > 0) { fail500--; return send(502, { success: false, errors: [{ message: 'Bad gateway' }] }); }
    for (const f of JSON.parse(raw)) { if (!f.base64 || !/^[0-9a-f]{32}$/.test(f.key) || !f.metadata?.contentType) return send(400, { success: false, errors: [{ message: 'bad file' }] }); store.set(f.key, { value: f.value, contentType: f.metadata.contentType }); }
    return okr(null);
  }
  if (req.method === 'POST' && p === '/pages/assets/upsert-hashes') return okr(null);
  if (req.method === 'POST' && p === projBase + PROJECT + '/deployments') {
    const form = await new Response(raw, { headers: { 'content-type': req.headers['content-type'] } }).formData();
    const manifest = JSON.parse(form.get('manifest'));
    const parts = {}; for (const k of ['_headers', '_redirects', '_routes.json']) { const v = form.get(k); if (v) parts[k] = await v.text(); }
    deployments.push({ manifest, branch: form.get('branch'), parts });
    return okr({ id: 'dep' + deployments.length, url: `https://dep${deployments.length}.my-site.pages.dev` });
  }
  send(404, { success: false, errors: [{ message: 'unknown ' + p }] });
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
process.env.SITETEND_CLOUDFLARE_API = `http://127.0.0.1:${fake.address().port}/client/v4`;
const { cloudflarePublish, cloudflareCheck, collectFiles, pagesHash } = await import('../src/host/publisher-cloudflare.mjs');

// Does every manifest entry point at uploaded bytes that are exactly the file, named by its BLAKE3 hash?
const verify = (dep, dir) => Object.entries(dep.manifest).every(([p, h]) => {
  const bytes = fs.readFileSync(path.join(dir, p.slice(1))); const st = store.get(h);
  return st && Buffer.from(st.value, 'base64').equals(bytes) && blake3(st.value + path.extname(p).slice(1)).slice(0, 32) === h;
});

// ---- a site
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitetend-cf-'));
const site = path.join(tmp, 'site');
const put = (p, c) => { fs.mkdirSync(path.dirname(path.join(site, p)), { recursive: true }); fs.writeFileSync(path.join(site, p), c); };
put('index.html', '<!doctype html><html><head><title>Me</title></head><body><h1>Alex Doe</h1><p>alex@example.org</p><a href="about.html">About</a></body></html>');
put('about.html', '<!doctype html><html><body><p>About me</p></body></html>');
put('css/site.css', 'body{font-family:sans-serif}');
put('img/photo.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]));
put('docs/resume.pdf', Buffer.alloc(3000, 7));
put('_headers', '/*\n  X-Frame-Options: DENY\n');
put('_redirects', '/old /about.html 301\n'); put('_routes.json', '{"version":1,"include":["/*"],"exclude":[]}');
put('.well-known/security.txt', 'Contact: mailto:alex@example.org\n');
put('.env', 'SECRET=1'); put('.DS_Store', 'x'); put('.sitetend/notes.txt', 'private'); put('node_modules/x/index.js', 'x'); put('.git/HEAD', 'ref');
put('index.html.sitetend-tmp-99999-1', 'half');

// file list
const { files, special } = await collectFiles(site);
const names = files.map(f => f.path).sort();
ok(names.join(',') === '.well-known/security.txt,about.html,css/site.css,docs/resume.pdf,img/photo.png,index.html', 'uploads the pages, styles, images and .well-known; skips .env, .sitetend, .git, node_modules, system and temporary files: ' + names.join(','));
ok(special._headers && special._redirects && !names.includes('_headers'), '_headers and _redirects are sent as their own parts');
ok(pagesHash(Buffer.from('Hello'), 'a.txt') === blake3(Buffer.from('Hello').toString('base64') + 'txt').slice(0, 32), 'file names follow wrangler (BLAKE3 of base64 plus extension, 32 characters)');

// checks
const bad = async (fn, code, m) => { try { await fn(); ok(false, m); } catch (e) { ok(e.code === code, `${m} (${e.code}: ${e.message.slice(0, 90)})`); } };
await bad(() => cloudflareCheck({ token: 'wrong', accountId: ACCOUNT, project: PROJECT }), 'CF_AUTH', 'a wrong token is reported as such');
await bad(() => cloudflareCheck({ token: TOKEN, accountId: ACCOUNT, project: 'nope' }), 'CF_NO_PROJECT', 'a project name that does not exist is reported');
await bad(() => cloudflareCheck({ token: TOKEN, accountId: 'abc', project: PROJECT }), 'CF_BAD_ACCOUNT', 'a malformed account ID is caught before calling Cloudflare');
await bad(() => cloudflareCheck({ token: '', accountId: ACCOUNT, project: PROJECT }), 'CF_NO_TOKEN', 'no token saved yet');
const info = await cloudflareCheck({ token: TOKEN, accountId: ACCOUNT, project: PROJECT });
ok(info.url === 'https://my-site.pages.dev' && info.productionBranch === 'main', 'the check returns the project address');

// first deployment: everything uploaded
let r = await cloudflarePublish({ token: TOKEN, accountId: ACCOUNT, project: PROJECT, dir: site });
let d = deployments.at(-1);
ok(r.files === 6 && r.uploaded === 6 && Object.keys(d.manifest).length === 6, `first deployment uploads all 6 files (${r.uploaded})`);
ok(verify(d, site), 'every file in the manifest is the exact file, under its BLAKE3 name');
ok(d.parts._headers.includes('X-Frame-Options') && d.parts._redirects.includes('/old'), '_headers and _redirects arrive with the deployment');
ok(!d.parts['_routes.json'] && !d.manifest['/_routes.json'], '_routes.json (only meaningful with Functions) is left out, as wrangler does');
ok(d.branch === null && r.production && r.live === 'https://www.example.com', 'no branch means production; the custom domain is reported as the live address');
ok(store.get(d.manifest['/index.html']).contentType === 'text/html' && store.get(d.manifest['/img/photo.png']).contentType === 'image/png', 'content types are sent');

// second deployment after one edit: only the changed file goes up
put('index.html', fs.readFileSync(path.join(site, 'index.html'), 'utf8').replace('alex@example.org', 'hello@example.org'));
r = await cloudflarePublish({ token: TOKEN, accountId: ACCOUNT, project: PROJECT, dir: site });
d = deployments.at(-1);
ok(r.uploaded === 1 && r.files === 6 && verify(d, site), `after one edit only 1 file is uploaded (${r.uploaded}), and the deployment is complete`);

// gateway errors are retried; an expired upload token is renewed
fail500 = 2; put('about.html', '<p>About me, updated</p>');
r = await cloudflarePublish({ token: TOKEN, accountId: ACCOUNT, project: PROJECT, dir: site });
ok(r.uploaded === 1 && verify(deployments.at(-1), site), 'two gateway errors in a row are retried and the upload still completes');
expireNext = true; put('css/site.css', 'body{font-family:serif}');
const before = jwtN;
r = await cloudflarePublish({ token: TOKEN, accountId: ACCOUNT, project: PROJECT, dir: site });
ok(r.uploaded === 1 && jwtN === before + 2 && verify(deployments.at(-1), site), 'an expired upload token is renewed');

// preview branch
r = await cloudflarePublish({ token: TOKEN, accountId: ACCOUNT, project: PROJECT, branch: 'preview', dir: site });
ok(deployments.at(-1).branch === 'preview' && !r.production, 'a branch other than production makes a preview deployment');

// refusals
put('functions/api.js', 'export function onRequest(){}');
await bad(() => cloudflarePublish({ token: TOKEN, accountId: ACCOUNT, project: PROJECT, dir: site }), 'CF_FUNCTIONS', 'a site with Cloudflare Functions is not half-uploaded');
fs.rmSync(path.join(site, 'functions'), { recursive: true });
put('functions/limits.html', '<h1>Limits of functions</h1>'); put('functions/notes.js', 'console.log(1)');
r = await cloudflarePublish({ token: TOKEN, accountId: ACCOUNT, project: PROJECT, dir: site });
ok(r.files === 8 && deployments.at(-1).manifest['/functions/limits.html'], 'a plain folder that happens to be called functions is uploaded as pages');
fs.rmSync(path.join(site, 'functions'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'withfn/functions/api'), { recursive: true }); fs.writeFileSync(path.join(tmp, 'withfn/functions/api/hello.ts'), 'export const onRequestGet = () => new Response("hi");'); fs.mkdirSync(path.join(tmp, 'withfn/dist')); fs.writeFileSync(path.join(tmp, 'withfn/dist/index.html'), 'x');
await bad(() => cloudflarePublish({ token: TOKEN, accountId: ACCOUNT, project: PROJECT, dir: path.join(tmp, 'withfn/dist'), root: path.join(tmp, 'withfn') }), 'CF_FUNCTIONS', 'Functions next to the build output (not inside it) are noticed too');
fs.writeFileSync(path.join(site, 'big.mp4'), Buffer.alloc(26 * 1024 * 1024));
const n = deployments.length;
await bad(() => cloudflarePublish({ token: TOKEN, accountId: ACCOUNT, project: PROJECT, dir: site }), 'CF_FILE_TOO_LARGE', 'a file over 25 MB stops the upload before anything is deployed');
ok(deployments.length === n, 'nothing was deployed');
fs.rmSync(path.join(site, 'big.mp4'));
await bad(() => cloudflarePublish({ token: TOKEN, accountId: ACCOUNT, project: PROJECT, dir: path.join(tmp, 'missing') }), 'PUB_FOLDER_MISSING', 'a missing folder is reported');

// ---- through a running Sitetend: settings, token storage, publish, zip download
const home = path.join(tmp, 'home'); fs.mkdirSync(home);
const port = 56000 + Math.floor(Math.random() * 900);
const host = spawn(process.execPath, ['bin/sitetend.mjs', '--no-open'], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, HOME: home, USERPROFILE: home, SITETEND_HOME: path.join(home, '.sitetend'), PORT: String(port) }, stdio: 'pipe' });
let out = ''; host.stdout.on('data', c => out += c); host.stderr.on('data', c => out += c);
for (let i = 0; i < 100 && !/running/.test(out); i++) await new Promise(r => setTimeout(r, 100));
const tok = JSON.parse(fs.readFileSync(path.join(home, '.sitetend/host.json'), 'utf8')).token;
const api = async (method, p, body) => { const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', 'x-sitetend-token': tok }, body: body ? JSON.stringify(body) : undefined }); return res.json(); };
try {
  let j = await api('POST', '/api/workspace/open', { path: site }); if (!j.ok) console.error(JSON.stringify(j), out); ok(j.ok, 'Sitetend opens the site');
  j = await api('POST', '/api/settings', { publishMode: 'cloudflare' }); ok(j.ok, 'publish mode can be set to Cloudflare');
  j = await api('POST', '/api/publish/host', { host: 'cloudflare', accountId: ACCOUNT.toUpperCase(), project: ' My-Site ', token: TOKEN });
  ok(j.ok && j.data.cloudflare.hasToken && j.data.cloudflare.ready && j.data.cloudflare.project === 'my-site' && j.data.cloudflare.accountId === ACCOUNT && j.data.cloudflare.files === 6, 'settings are saved and cleaned up; the token is saved; 6 files would be uploaded');
  ok(!JSON.stringify(j).includes(TOKEN), 'the token is never sent back to the page');
  ok(fs.readFileSync(path.join(home, '.sitetend/.env'), 'utf8').includes('CLOUDFLARE_API_TOKEN=' + TOKEN) && !fs.readFileSync(path.join(site, '.sitetend/config.json'), 'utf8').includes(TOKEN), 'the token is in ~/.sitetend/.env only, not in the website');
  j = await api('POST', '/api/publish/host', { host: 'cloudflare', accountId: ACCOUNT, project: PROJECT, folder: '../..' }); ok(!j.ok && j.error.code === 'PUB_FOLDER_OUTSIDE', 'the folder to upload cannot point outside the website');
  j = await api('POST', '/api/publish/host/check', { host: 'cloudflare' }); ok(j.ok && j.data.url === 'https://my-site.pages.dev' && j.data.files === 6, 'connection test works');
  // an edit through Sitetend, then publish
  const k = deployments.length;
  j = await api('POST', '/api/publish', {}); ok(j.ok && j.data.mode === 'cloudflare' && j.data.files === 6 && deployments.length === k + 1, 'Publish uploads to Cloudflare');
  ok(verify(deployments.at(-1), site), 'the deployment from Sitetend is complete and exact');
  j = await api('GET', '/api/state'); ok(j.data.workspace?.liveIsPublished === true && j.data.workspace.published?.publisherId === 'cloudflare-pages', 'the version is recorded as published (by Cloudflare Pages)');
  j = await api('GET', '/api/publish/status'); ok(j.data.cloudflare.last?.live === 'https://www.example.com', 'the last upload is remembered');
  // zip download
  const zres = await fetch(`http://127.0.0.1:${port}/api/publish/zip?t=${tok}`);
  const zbuf = Buffer.from(await zres.arrayBuffer());
  const zpath = path.join(tmp, 'w.zip'); fs.writeFileSync(zpath, zbuf);
  const { readZip } = await import('../src/host/backups.mjs');
  const entries = (await readZip(zpath)).map(e => e.name).sort();
  ok(zres.headers.get('content-type') === 'application/zip' && /attachment; filename="site\.zip"/.test(zres.headers.get('content-disposition')), 'the website downloads as site.zip');
  ok(entries.includes('index.html') && entries.includes('_headers') && entries.includes('css/site.css') && !entries.some(e => /\.env$|\.sitetend|node_modules|\.git\//.test(e)), 'files sit at the top of the zip, without secrets or Sitetend data: ' + entries.join(','));
  // wrong token through Sitetend
  await api('POST', '/api/publish/host', { host: 'cloudflare', accountId: ACCOUNT, project: PROJECT, token: 'bad' });
  fs.appendFileSync(path.join(site, 'about.html'), '<!-- x -->');
  j = await api('POST', '/api/publish', {}); ok(!j.ok && j.error.code === 'CF_AUTH' && j.error.detail === 'Authentication error', "a wrong token gives a clear error with Cloudflare's own words, not an internal one");
} finally { host.kill(); fake.close(); }
await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
console.log(`${pass} Cloudflare checks passed`);
