// @ts-check
// Publish backend: deploy the website folder to a Netlify site through Netlify's API ("file digest" deploys, the
// same requests the Netlify CLI makes). Netlify is told every file with its SHA1, answers which ones it does not
// have yet, and only those are uploaded. _headers, _redirects and netlify.toml travel as ordinary files.
// The token is read from ~/.sitetend/.env (NETLIFY_AUTH_TOKEN, the name the Netlify CLI uses too).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { collectFiles as collect, fail, retrying as retryingBase } from './publish-files.mjs';

export const NETLIFY_TOKEN_KEY = 'NETLIFY_AUTH_TOKEN';
const API = () => process.env.SITETEND_NETLIFY_API || 'https://api.netlify.com/api/v1';   // tests point this at a local fake
const testing = () => Boolean(process.env.SITETEND_NETLIFY_API);
const retrying = fn => retryingBase(fn, { attempts: 5, quick: testing() });
const READY_WAIT = () => (testing() ? 5000 : 10 * 60 * 1000);

/** A site is named by its address (mysite.netlify.app or a custom domain) or its Project ID. */
export function normalizeSite(input) {
  let s = String(input || '').trim();
  s = s.replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '').toLowerCase();
  if (!s) return '';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)) return s;     // Project ID
  if (!s.includes('.')) s += '.netlify.app';                                                    // just the site name
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s) ? s : '';
}

/** The files that would be uploaded from `dir`. Throws NL_FUNCTIONS, NL_BAD_NAME and the PUB_* errors of collectFiles. */
export async function collectFiles(dir, { root = dir } = {}) {
  // Netlify Functions are bundled by Netlify's own tools, and a deploy without them would take them off the site.
  // They usually sit next to the build output, so the website folder is checked too.
  for (const base of new Set([dir, root])) for (const f of ['netlify/functions', 'netlify/edge-functions']) if (await fs.stat(path.join(base, f)).catch(() => null)) throw fail('NL_FUNCTIONS', `This site has Netlify Functions (${f}). Publish it with Git or the Netlify CLI instead.`);
  return collect(dir, { maxFiles: 25000, check: f => {
    if (/[#?]/.test(f.path)) throw fail('NL_BAD_NAME', `Netlify cannot take a file whose name contains # or ?: ${f.path}`, { file: f.path });
  } });
}

async function call(token, method, url, body, { raw = false } = {}) {
  let res;
  try {
    res = await fetch(API() + url, { method, signal: AbortSignal.timeout(120000),
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'Sitetend', ...(body ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' } : {}) },
      body: body ? (raw ? body : JSON.stringify(body)) : undefined });
  } catch { throw fail('NL_NETWORK', 'Could not reach Netlify. Check the internet connection and try again.', { retry: true }); }
  let data = null; try { data = await res.json(); } catch {}
  if (res.ok) return data;
  const raw0 = data?.message || data?.errors || `HTTP ${res.status}`;
  const msg = typeof raw0 === 'string' ? raw0 : JSON.stringify(raw0);
  if (res.status === 401) throw fail('NL_AUTH', `Netlify did not accept the access token (${msg}).`, { detail: msg });
  if (res.status === 403) throw fail('NL_FORBIDDEN', `This access token cannot change that site (${msg}).`, { detail: msg });
  if (res.status === 404) throw fail('NL_NOT_FOUND', `Netlify could not find it (${msg}).`);
  if (res.status === 429) { const reset = Number(res.headers.get('x-ratelimit-reset')); throw fail('NL_RATE', 'Netlify allows 3 deploys a minute. Wait a moment and publish again.', { retry: true, wait: reset ? Math.min(65000, Math.max(1000, reset * 1000 - Date.now())) : 20000 }); }
  throw fail('NL_FAILED', `Netlify refused the upload: ${msg}`, { retry: res.status >= 500, detail: msg });
}

const siteUrl = s => s?.ssl_url || s?.url || (s?.custom_domain ? `https://${s.custom_domain}` : null);

/** Checks the token and site. Returns { name, url, id }. */
export async function netlifyCheck({ token, site }) {
  if (!token) throw fail('NL_NO_TOKEN', 'No Netlify access token is saved yet.');
  const id = normalizeSite(site);
  if (!id) throw fail('NL_BAD_SITE', 'Enter the site address, for example mysite.netlify.app, or its Project ID.');
  let s;
  try { s = await retrying(() => call(token, 'GET', `/sites/${encodeURIComponent(id)}`)); }
  catch (e) { if (e.code === 'NL_NOT_FOUND') throw fail('NL_NO_SITE', `This account has no Netlify site at "${id}".`); throw e; }
  return { name: s?.name || id, url: siteUrl(s), id: s?.id || id };
}

const PREPARED = ['prepared', 'uploading', 'uploaded', 'ready'];
const sha1 = bytes => crypto.createHash('sha1').update(bytes).digest('hex');
const encodePath = p => p.split('/').map(encodeURIComponent).join('/');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Waits until the deploy reaches one of `states`; throws if it fails. */
async function waitFor(token, deployId, states) {
  const until = Date.now() + READY_WAIT();
  for (let i = 0; ; i++) {
    const d = await retrying(() => call(token, 'GET', `/deploys/${deployId}`));
    if (d?.state === 'error') throw fail('NL_FAILED', `Netlify could not finish the deploy: ${d.error_message || 'unknown error'}`, { detail: d.error_message || '' });
    if (states.includes(d?.state)) return d;
    if (Date.now() > until) throw fail('NL_SLOW', 'Netlify is taking unusually long to finish this deploy. Check the site in Netlify; it may still go live.');
    await sleep(testing() ? 20 : Math.min(5000, 800 + i * 400));
  }
}

/**
 * Deploys `dir` to the site. Only files Netlify does not have yet are sent. `draft` makes a preview that does not
 * change the live site. Returns { url, live, id, files, uploaded, production }. Progress: onProgress({ done, total }).
 */
export async function netlifyPublish({ token, site, draft = false, dir, root = dir, onProgress = () => {} }) {
  const { files } = await collectFiles(dir, { root });   // local checks first, before Netlify is called
  const info = await netlifyCheck({ token, site });
  for (const f of files) f.sha = sha1(await fs.readFile(path.join(dir, f.path)));
  const digest = Object.fromEntries(files.map(f => ['/' + f.path, f.sha]));
  // async: large sites would pass Netlify's 30-second limit for one request; the list of missing files comes after.
  let dep = await retrying(() => call(token, 'POST', `/sites/${encodeURIComponent(info.id)}/deploys`, { files: digest, async: true, draft: Boolean(draft) }));
  if (!dep?.id) throw fail('NL_FAILED', 'Netlify did not start the deploy.');
  // Go by the state, not by whether a list is present: while Netlify is still comparing, the list is not final (as the Netlify CLI does).
  if (!PREPARED.includes(dep.state)) dep = await waitFor(token, dep.id, PREPARED);
  const need = new Set(dep.required || []);
  const todo = []; const seen = new Set();
  for (const f of files) if (need.has(f.sha) && !seen.has(f.sha)) { seen.add(f.sha); todo.push(f); }
  let done = 0; onProgress({ done, total: todo.length });
  const queue = [...todo];
  const worker = async () => {
    for (let f; (f = queue.shift());) {
      const bytes = await fs.readFile(path.join(dir, f.path));
      if (sha1(bytes) !== f.sha) throw fail('NL_CHANGED', `${f.path} changed while uploading. Publish again.`, { file: f.path });
      await retrying(() => call(token, 'PUT', `/deploys/${dep.id}/files/${encodePath(f.path)}`, bytes, { raw: true }));
      onProgress({ done: ++done, total: todo.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));
  const ready = await waitFor(token, dep.id, ['ready']);
  const preview = ready.deploy_ssl_url || ready.deploy_url || null;
  return { url: draft ? preview : info.url, live: info.url, preview, id: dep.id, files: files.length, uploaded: todo.length, production: !draft };
}
