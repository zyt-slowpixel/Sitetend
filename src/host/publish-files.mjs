// @ts-check
// What gets uploaded when publishing to a host (Cloudflare Pages, Netlify): the files of one folder, minus everything
// private or not part of a website. Shared by the host publishers.
import fs from 'node:fs/promises';
import path from 'node:path';

// Never uploaded: Sitetend data (materials, history), version control, packages, secrets, system files, half-written temporary files.
const SKIP_DIR = new Set(['.sitetend', '.git', 'node_modules', '.wrangler', '.netlify', '.vercel', '.svn', '.hg', '__pycache__']);
export const skipFile = name => name === '.DS_Store' || name === 'Thumbs.db' || name === 'desktop.ini' || /^\.git(ignore|attributes|modules)$/.test(name)
  || /^\.env(\..*)?$/.test(name) || /\.sitetend-tmp-\d+-\d+$/.test(name);

const TYPES = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'application/javascript', mjs: 'application/javascript', json: 'application/json',
  map: 'application/json', webmanifest: 'application/manifest+json', xml: 'application/xml', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  ico: 'image/vnd.microsoft.icon', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
  otf: 'font/otf', eot: 'application/vnd.ms-fontobject', pdf: 'application/pdf', zip: 'application/zip', wasm: 'application/wasm',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
export const typeOf = name => TYPES[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream';

export const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Retries a call whose error says `retry` (network trouble, 5xx, 429), waiting a little longer each time. */
export async function retrying(fn, { attempts = 4, quick = false } = {}) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) { if (!e.retry || i >= attempts - 1) throw e; await sleep(quick ? 10 : (e.wait || 1000 * 2 ** i)); }
  }
}

/**
 * The files to upload from `dir`: [{ path, size }] with forward slashes, plus `special` (root files a host wants
 * as their own parts, read as text). Throws PUB_FOLDER_MISSING, PUB_EMPTY, PUB_TOO_MANY_FILES, and whatever `check` throws.
 * @param {string} dir
 * @param {{ maxFiles?: number, special?: Set<string>, check?: (f: {path: string, size: number}) => void }} [opts]
 */
export async function collectFiles(dir, { maxFiles = 20000, special: specialNames = new Set(), check = () => {} } = {}) {
  const st = await fs.stat(dir).catch(() => null);
  if (!st?.isDirectory()) throw fail('PUB_FOLDER_MISSING', `The folder to upload was not found: ${dir}`);
  const files = [], special = {};
  const walk = async (rel, depth) => {
    if (depth > 30) return;
    const entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) { if (!SKIP_DIR.has(ent.name)) await walk(r, depth + 1); continue; }
      if (!ent.isFile() || skipFile(ent.name)) continue;
      if (!rel && specialNames.has(ent.name)) { special[ent.name] = await fs.readFile(path.join(dir, r), 'utf8'); continue; }
      const f = { path: r, size: (await fs.stat(path.join(dir, r))).size };
      check(f);
      files.push(f);
      if (files.length > maxFiles) throw fail('PUB_TOO_MANY_FILES', `More than ${maxFiles} files, the limit for one upload to this host.`);
    }
  };
  await walk('', 0);
  if (!files.length) throw fail('PUB_EMPTY', 'There are no files to upload in this folder.');
  return { files, special };
}
