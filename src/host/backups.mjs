// Daily full-site backups: the whole website folder as one .zip (unzip it and it is the site), kept in the user's
// own folder (~/.sitetend/backups/<site>/), never inside the website. One per day, made before the first change of
// the day (and when the site is opened), the most recent 14 kept within a size limit. A backup can be restored; the
// current site is backed up first, so a restore can itself be taken back.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { userDir } from './user-config.mjs';

export const KEEP_DAYS = 14;
export const MAX_TOTAL_BYTES = 4 * 1024 ** 3;       // per site, all its backups together
const MAX_ZIP_BYTES = 3.5 * 1024 ** 3;              // classic zip (no ZIP64): stay well below 4 GB
const MAX_ENTRIES = 60000;
// Not part of the website: tools' folders, version control, Sitetend's own records, editors' leftovers.
const SKIP_DIR = /^(node_modules|\.git|\.sitetend|\.svn|\.hg|\.next|\.nuxt|\.astro|\.svelte-kit|\.cache|\.parcel-cache|\.turbo|\.vercel|\.output|__pycache__|\.venv|venv)$/;
const SKIP_FILE = /(\.sitetend-tmp-\d+-\d+|~|\.swp|\.DS_Store|Thumbs\.db)$/;
// Already compressed: stored as they are (packing them again costs time and saves nothing).
const STORED = /\.(jpe?g|png|gif|webp|avif|ico|mp4|webm|mov|m4v|mp3|m4a|ogg|zip|gz|7z|rar|pdf|woff2?|docx|xlsx|pptx)$/i;

// ---------------------------------------------------------------- where
const slug = s => String(s).normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'site';
/** One folder per website: its name plus a short fingerprint of its location (two sites can share a name). */
export const backupDirFor = (root, home = userDir()) =>
  path.join(home, 'backups', `${slug(path.basename(root))}-${crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 8)}`);
const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ---------------------------------------------------------------- zip (writing)
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function dosTime(d) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2)),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

/** Every file of the site, relative paths with "/" (folders Sitetend never backs up are skipped). */
export async function siteFiles(root, { publish = false } = {}) {
  const out = [];
  const walk = async (dir, rel, depth) => {
    if (depth > 20) return;
    let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) await walk(path.join(dir, e.name), p, depth + 1); }
      else if (e.isFile() && !SKIP_FILE.test(e.name) && !(publish && /^\.env(\..*)?$|^\.git(ignore|attributes|modules)$/.test(e.name))) out.push(p);   // a zip to publish never carries secrets
    }
  };
  await walk(root, '', 0);
  return out.sort();
}

/** Writes root's files into a .zip at target (via a temporary file, so a cut-off backup never looks complete). */
export async function zipFolder(root, target, { publish = false } = {}) {
  const files = await siteFiles(root, { publish });
  if (files.length > MAX_ENTRIES) throw Object.assign(Error(`The website has more than ${MAX_ENTRIES} files; it is too large for a backup.`), { code: 'BACKUP_TOO_LARGE' });
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = target + '.part';
  const fh = await fs.open(tmp, 'w');
  const central = []; let offset = 0, total = 0;
  try {
    for (const rel of files) {
      const abs = path.join(root, ...rel.split('/'));
      let data, st;
      try { [data, st] = await Promise.all([fs.readFile(abs), fs.stat(abs)]); } catch { continue; }   // removed meanwhile
      const name = Buffer.from(rel, 'utf8');
      const crc = crc32(data);
      const deflated = STORED.test(rel) || data.length < 64 ? null : zlib.deflateRawSync(data, { level: 6 });
      const method = deflated && deflated.length < data.length ? 8 : 0, body = method ? deflated : data;
      if (offset + body.length + 30 + name.length > MAX_ZIP_BYTES) throw Object.assign(Error('The website is too large for a backup (over 3.5 GB).'), { code: 'BACKUP_TOO_LARGE' });
      const { time, date } = dosTime(st.mtime);
      const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(method, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
      await fh.write(local); await fh.write(name); await fh.write(body);
      central.push({ name, method, time, date, crc, csize: body.length, size: data.length, offset });
      offset += 30 + name.length + body.length; total += data.length;
    }
    const cdStart = offset;
    for (const c of central) {
      const h = Buffer.alloc(46); h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(c.method, 10); h.writeUInt16LE(c.time, 12); h.writeUInt16LE(c.date, 14); h.writeUInt32LE(c.crc, 16);
      h.writeUInt32LE(c.csize, 20); h.writeUInt32LE(c.size, 24); h.writeUInt16LE(c.name.length, 28);
      h.writeUInt32LE(c.offset, 42);
      await fh.write(h); await fh.write(c.name); offset += 46 + c.name.length;
    }
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - cdStart, 12); end.writeUInt32LE(cdStart, 16);
    await fh.write(end);
    await fh.sync?.().catch(() => {});
  } catch (e) { await fh.close(); await fs.rm(tmp, { force: true }); throw e; }
  await fh.close();
  await fs.rename(tmp, target);
  return { files: central.length, bytes: total };
}

// ---------------------------------------------------------------- zip (reading)
/** The entries of a zip made above (or any plain zip): [{ name, read() -> Buffer }]. Checks every file's CRC. */
export async function readZip(file) {
  const buf = await fs.readFile(file);
  let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw Object.assign(Error('Not a zip file.'), { code: 'BACKUP_DAMAGED' });
  const count = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16); const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw Object.assign(Error('The backup is damaged.'), { code: 'BACKUP_DAMAGED' });
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8'); p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    out.push({ name, size, read() {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + csize);
      const data = method === 8 ? zlib.inflateRawSync(raw) : method === 0 ? Buffer.from(raw) : null;
      if (!data || data.length !== size || crc32(data) !== crc) throw Object.assign(Error(`The backup is damaged (${name}).`), { code: 'BACKUP_DAMAGED' });
      return data;
    } });
  }
  return out;
}

// ---------------------------------------------------------------- the backups of one site
export class SiteBackups {
  constructor(root, { home, keepDays = KEEP_DAYS, maxTotal = MAX_TOTAL_BYTES, now = () => new Date() } = {}) {
    this.root = root; this.dir = backupDirFor(root, home); this.keepDays = keepDays; this.maxTotal = maxTotal; this.now = now;
    this.running = null;
  }
  get name() { return slug(path.basename(this.root)); }
  /** Newest first: [{ file, date, kind, bytes, at }]. kind: "daily", "manual" or "before-restore". */
  async list() {
    let names; try { names = await fs.readdir(this.dir); } catch { return []; }
    const out = [];
    for (const f of names) {
      const m = f.match(/^(.+)-(\d{4}-\d{2}-\d{2})(?:-(manual|before-restore)-(\d{6}))?\.zip$/); if (!m) continue;
      const st = await fs.stat(path.join(this.dir, f)).catch(() => null); if (!st) continue;
      out.push({ file: f, date: m[2], kind: m[3] || 'daily', bytes: st.size, at: st.mtime.toISOString() });
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }
  async hasToday() { const d = today(this.now()); return (await this.list()).some(b => b.date === d && b.kind === 'daily'); }
  /** Today's backup, if there is none yet. Concurrent calls share one run. Returns the entry made, or null. */
  daily() {
    if (!this.running) this.running = (async () => { try { return (await this.hasToday()) ? null : await this.make('daily'); } finally { this.running = null; } })();
    return this.running;
  }
  async make(kind = 'manual') {
    const d = this.now(), stamp = kind === 'daily' ? '' : `-${kind}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
    const file = `${this.name}-${today(d)}${stamp}.zip`;
    const r = await zipFolder(this.root, path.join(this.dir, file));
    await this.prune();
    return { file, kind, ...r };
  }
  /** Keeps the backups of the last keepDays days that have one, within the size limit; the newest is always kept. */
  async prune() {
    const all = await this.list(); const days = [...new Set(all.map(b => b.date))];
    const keepDays = new Set(days.slice(0, this.keepDays)); let total = 0;
    for (const [i, b] of all.entries()) {
      total += b.bytes;
      if (i > 0 && (!keepDays.has(b.date) || total > this.maxTotal)) await fs.rm(path.join(this.dir, b.file), { force: true });
    }
  }
  /** Puts the site back as it was in a backup: the current site is backed up first, then every file of the backup is
   *  written and files the backup does not have are removed (folders Sitetend never backs up are left alone). */
  async restore(file) {
    if (!/^[^/\\]+\.zip$/.test(file)) throw Object.assign(Error('Unknown backup.'), { code: 'BACKUP_NOT_FOUND' });
    const zipPath = path.join(this.dir, file);
    if (!fsSync.existsSync(zipPath)) throw Object.assign(Error('Unknown backup.'), { code: 'BACKUP_NOT_FOUND' });
    const entries = await readZip(zipPath);
    for (const e of entries) {                               // check everything before touching the site
      if (e.name.split('/').some(x => x === '..' || x === '') || path.isAbsolute(e.name) || /^[a-z]:/i.test(e.name)) throw Object.assign(Error('The backup is damaged.'), { code: 'BACKUP_DAMAGED' });
      e.data = e.read();
    }
    const safety = await this.make('before-restore');
    const keep = new Set(entries.map(e => e.name));
    for (const e of entries) {
      const abs = path.join(this.root, ...e.name.split('/'));
      const cur = await fs.readFile(abs).catch(() => null);
      if (cur && cur.equals(e.data)) continue;
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const tmp = abs + '.sitetend-tmp-' + process.pid + '-' + Date.now();
      await fs.writeFile(tmp, e.data); await fs.rename(tmp, abs);
    }
    let removed = 0;
    for (const rel of await siteFiles(this.root)) if (!keep.has(rel)) { await fs.rm(path.join(this.root, ...rel.split('/')), { force: true }); removed++; }
    return { restored: entries.length, removed, safety: safety.file };
  }
}
