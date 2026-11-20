// @ts-check
// Publish backend: upload the website folder to a Cloudflare Pages project (the same "Direct Upload" that
// dragging a folder or zip into the Cloudflare dashboard does, and the same requests as `wrangler pages deploy`).
// The API token is read from ~/.sitetend/.env (CLOUDFLARE_API_TOKEN); it is never stored in the website or in settings.
import fs from 'node:fs/promises';
import path from 'node:path';
import { blake3 } from './blake3.mjs';
import { collectFiles as collect, typeOf, fail, retrying as retryingBase } from './publish-files.mjs';

export const CF_TOKEN_KEY = 'CLOUDFLARE_API_TOKEN';
const API = () => process.env.SITETEND_CLOUDFLARE_API || 'https://api.cloudflare.com/client/v4';   // tests point this at a local fake
const MAX_FILE = 25 * 1024 * 1024;          // Cloudflare Pages: 25 MiB per file
const MAX_FILES_DEFAULT = 20000;            // unless the upload token allows more
const BUCKET_BYTES = 40 * 1024 * 1024, BUCKET_FILES = 1000;

// Sent as their own parts of the deployment, not as files (as wrangler does).
const SPECIAL = new Set(['_headers', '_redirects', '_routes.json']);

/** Cloudflare's name for a file: BLAKE3 of the base64 text plus the extension, first 32 hex characters (as wrangler does). */
export const pagesHash = (bytes, name) => blake3(Buffer.from(bytes).toString('base64') + path.extname(name).slice(1)).slice(0, 32);

/** A functions/ folder is Cloudflare Functions only if it holds code that handles requests (onRequest…); a plain folder of pages is not. */
async function hasPagesFunctions(dir, depth = 0) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 5 && await hasPagesFunctions(p, depth + 1)) return true;
    if (e.isFile() && /\.(m?js|ts|jsx|tsx)$/.test(e.name) && /\bonRequest(Get|Post|Put|Patch|Delete|Head|Options)?\b/.test(await fs.readFile(p, 'utf8').catch(() => ''))) return true;
  }
  return false;
}

/** The files that would be uploaded from `dir`. Throws CF_FUNCTIONS, CF_FILE_TOO_LARGE and the PUB_* errors of collectFiles. */
export async function collectFiles(dir, { maxFiles = MAX_FILES_DEFAULT, root = dir } = {}) {
  // Cloudflare Functions need wrangler to bundle them, and a deployment without them would take them off the site.
  // functions/ usually sits next to the build output, so the website folder is checked too.
  if (await fs.stat(path.join(dir, '_worker.js')).catch(() => null)) throw fail('CF_FUNCTIONS', 'This site uses Cloudflare Functions (_worker.js). Publish it with wrangler or Git instead.');
  for (const base of new Set([dir, root])) if (await hasPagesFunctions(path.join(base, 'functions'))) throw fail('CF_FUNCTIONS', 'This site uses Cloudflare Functions (functions). Publish it with wrangler or Git instead.');
  return collect(dir, { maxFiles, special: SPECIAL, check: f => {
    if (f.size > MAX_FILE) throw fail('CF_FILE_TOO_LARGE', `${f.path} is larger than 25 MB, the limit for one file on Cloudflare Pages.`, { file: f.path });
  } });
}

/** A Cloudflare API call. `auth` is the API token or the upload token. */
async function call(auth, method, url, body, { form = false } = {}) {
  let res;
  try {
    res = await fetch(API() + url, { method, headers: { Authorization: `Bearer ${auth}`, ...(body && !form ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? (form ? body : JSON.stringify(body)) : undefined, signal: AbortSignal.timeout(120000) });
  } catch (e) { throw fail('CF_NETWORK', 'Could not reach Cloudflare. Check the internet connection and try again.', { retry: true }); }
  let data = null; try { data = await res.json(); } catch {}
  if (res.ok && data?.success !== false) return data?.result;
  const msg = (data?.errors || []).map(e => e.message).filter(Boolean).join('; ') || `HTTP ${res.status}`;
  if (res.status === 401 || res.status === 403 || (data?.errors || []).some(e => e.code === 10000 || e.code === 9109))
    throw fail('CF_AUTH', `Cloudflare did not accept the API token (${msg}). It needs the "Cloudflare Pages: Edit" permission for this account.`, { detail: msg });
  if (res.status === 404 || (data?.errors || []).some(e => e.code === 8000007)) throw fail('CF_NOT_FOUND', `Cloudflare could not find it (${msg}).`, { detail: msg });
  throw fail('CF_FAILED', `Cloudflare refused the upload: ${msg}`, { retry: res.status >= 500 || res.status === 429, detail: msg });
}
const retrying = fn => retryingBase(fn, { quick: Boolean(process.env.SITETEND_CLOUDFLARE_API) });
const jwtPayload = jwt => { try { return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8')); } catch { return {}; } };
const jwtExpired = jwt => { const exp = jwtPayload(jwt).exp; return typeof exp === 'number' && exp * 1000 < Date.now() + 30000; };

const liveUrl = info => { const d = (info.domains || []).find(x => !/\.pages\.dev$/i.test(x)); return d ? `https://${d}` : info.url; };

/** Checks the token, account and project. Returns { project, url, productionBranch }. */
export async function cloudflareCheck({ token, accountId, project }) {
  if (!token) throw fail('CF_NO_TOKEN', 'No Cloudflare API token is saved yet.');
  if (!/^[0-9a-f]{32}$/i.test(String(accountId || ''))) throw fail('CF_BAD_ACCOUNT', 'The account ID is 32 letters and digits (Cloudflare dashboard, Workers & Pages, right side).');
  if (!/^[a-z0-9][a-z0-9-]{0,57}$/i.test(String(project || ''))) throw fail('CF_BAD_PROJECT', 'Enter the Pages project name as it appears in Cloudflare (letters, digits and dashes).');
  let p;
  try { p = await retrying(() => call(token, 'GET', `/accounts/${accountId}/pages/projects/${encodeURIComponent(project)}`)); }
  catch (e) { if (e.code === 'CF_NOT_FOUND') throw fail('CF_NO_PROJECT', `There is no Pages project named "${project}" in this account. Check the name under Workers & Pages.`); throw e; }
  return { project: p?.name || project, url: p?.subdomain ? `https://${p.subdomain}` : null, domains: p?.domains || [], productionBranch: p?.production_branch || 'main',
    gitConnected: Boolean(p?.source?.type) };
}

/**
 * Uploads `dir` as a new deployment. Only files Cloudflare does not have yet are sent.
 * Returns { url, id, files, uploaded, branch }. Progress: onProgress({ done, total }).
 */
export async function cloudflarePublish({ token, accountId, project, branch, dir, root = dir, onProgress = () => {} }) {
  await collectFiles(dir, { maxFiles: Infinity, root });   // what can be checked here (Functions, a file too large) is, before Cloudflare is called
  const info = await cloudflareCheck({ token, accountId, project });
  let jwt = (await retrying(() => call(token, 'GET', `/accounts/${accountId}/pages/projects/${encodeURIComponent(project)}/upload-token`)))?.jwt;
  if (!jwt) throw fail('CF_FAILED', 'Cloudflare did not return an upload token.');
  const maxFiles = Number(jwtPayload(jwt).max_file_count_allowed) || MAX_FILES_DEFAULT;
  const { files, special } = await collectFiles(dir, { maxFiles, root });
  for (const f of files) { const bytes = await fs.readFile(path.join(dir, f.path)); f.hash = pagesHash(bytes, f.path); }
  const fresh = async () => { if (jwtExpired(jwt)) jwt = (await call(token, 'GET', `/accounts/${accountId}/pages/projects/${encodeURIComponent(project)}/upload-token`)).jwt; return jwt; };
  const hashes = [...new Set(files.map(f => f.hash))];
  const missing = new Set(await retrying(async () => call(await fresh(), 'POST', '/pages/assets/check-missing', { hashes })) || []);
  const todo = []; const seen = new Set();
  for (const f of files) if (missing.has(f.hash) && !seen.has(f.hash)) { seen.add(f.hash); todo.push(f); }
  // Upload in batches of at most 1,000 files and 40 MB (as wrangler does).
  const buckets = []; let cur = null;
  for (const f of todo) {
    if (!cur || cur.files.length >= BUCKET_FILES || cur.bytes + f.size > BUCKET_BYTES) buckets.push(cur = { files: [], bytes: 0 });
    cur.files.push(f); cur.bytes += f.size;
  }
  let done = 0; onProgress({ done, total: todo.length });
  for (const b of buckets) {
    await retrying(async () => {
      const payload = await Promise.all(b.files.map(async f => ({ key: f.hash, value: (await fs.readFile(path.join(dir, f.path))).toString('base64'), metadata: { contentType: typeOf(f.path) }, base64: true })));
      return call(await fresh(), 'POST', '/pages/assets/upload', payload);
    });
    done += b.files.length; onProgress({ done, total: todo.length });
  }
  await retrying(async () => call(await fresh(), 'POST', '/pages/assets/upsert-hashes', { hashes }));
  const form = new FormData();
  form.append('manifest', JSON.stringify(Object.fromEntries(files.map(f => ['/' + f.path, f.hash]))));
  const br = String(branch || '').trim(); if (br) form.append('branch', br);
  // _routes.json only means something together with Functions, which are not uploaded here; wrangler leaves it out too.
  for (const [name, text] of Object.entries(special)) if (name !== '_routes.json') form.append(name, new Blob([text]), name);
  const dep = await retrying(() => call(token, 'POST', `/accounts/${accountId}/pages/projects/${encodeURIComponent(project)}/deployments`, form, { form: true }));
  return { url: dep?.url || info.url, live: liveUrl(info), id: dep?.id || null, files: files.length, uploaded: todo.length,
    branch: br || info.productionBranch, production: !br || br === info.productionBranch };
}
