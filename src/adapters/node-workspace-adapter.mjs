// @ts-check
// Node file-system workspace adapter (host only, never bundled into the browser).
// Same contract as MemoryBackedWorkspaceAdapter / BrowserDirectoryWorkspaceAdapter.
// Writes are atomic (temp file + rename); every path is confined to the workspace root.
import fs from 'node:fs/promises';
import path from 'node:path';
import { ERROR_CODES, createOk, createErr } from '../contracts.js';
import { normalizeSafePath } from './workspace-adapter.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.astro', '.svelte-kit', '.nuxt', '.output', '.vercel', '.turbo', '.cache', '.parcel-cache', 'coverage']);   // also framework build caches (thousands of files)
const TEST_WRITE_DELAY = +process.env.SITETEND_TEST_WRITE_DELAY_MS || 0;   // tests only (crash safety): pause inside every write
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });   // ignoreBOM: keep a byte-order mark, so a file is written back exactly as it was
const MAX_FILES = 20000;   // pictures and other files included; more than this is usually the wrong folder (a home folder or a drive)

export class NodeFsWorkspaceAdapter {
  /**
   * @param {string} root absolute path of the folder Sitetend opened
   * @param {string} label
   * @param {'project'|'site'} layout
   *   project: root/website/… is the website, root/sources/… the materials (the demos use this);
   *   site:    root IS the website (the folder people already have); materials live in root/.sitetend/materials/.
   * Everything above this class always uses the logical names website/…, sources/…, .sitetend/….
   */
  constructor(root, label = path.basename(root), layout = 'project') {
    this.mode = 'node-fs';
    this.layout = layout;
    this.root = path.resolve(root);
    this.label = label;
    /** @type {(p:string)=>void} called after every successful write; used to suppress self-triggered watch events */
    this.onWrite = () => {};
  }

  getWorkspaceInfo() { return createOk({ mode: this.mode, label: this.label, root: this.root, writable: true }); }

  _resolve(relPath) {
    const raw = String(relPath || '');
    if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith('\\')) return null;   // absolute / drive / UNC paths
    const norm = normalizeSafePath(relPath);
    if (!norm) return null;
    const abs = path.resolve(this.root, this._toPhysical(norm));
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) return null;
    return { norm, abs };
  }
  /** Logical path -> path inside the root folder (only differs in the 'site' layout). */
  _toPhysical(norm) {
    if (this.layout !== 'site') return norm;
    if (norm === 'website') return '.';
    if (norm.startsWith('website/')) return norm.slice(8);
    if (norm === 'sources') return '.sitetend/materials';
    if (norm.startsWith('sources/')) return '.sitetend/materials/' + norm.slice(8);
    return norm;
  }
  /** Path inside the root folder (as a watcher reports it) -> logical path. */
  toLogical(rel) {
    if (this.layout !== 'site') return rel;
    if (rel.startsWith('.sitetend/materials/')) return 'sources/' + rel.slice(20);
    if (rel.startsWith('.sitetend/') || rel === '.gitignore') return rel;
    return 'website/' + rel;
  }
  _scope(relPath) { return createErr(ERROR_CODES.PATH_OUT_OF_SCOPE, 'WorkspaceAdapter', `Path not allowed: "${relPath}"`, { relPath }, false); }
  _io(e, p) {
    if (e?.code === 'ENOENT') return createErr(ERROR_CODES.WORKSPACE_FILE_NOT_FOUND, 'WorkspaceAdapter', `File not found: "${p}"`, { path: p });
    if (e?.code === 'EACCES' || e?.code === 'EPERM') return createErr(ERROR_CODES.WORKSPACE_PERMISSION_DENIED, 'WorkspaceAdapter', `No permission: "${p}"`, { path: p });
    return createErr(ERROR_CODES.WORKSPACE_IO_ERROR, 'WorkspaceAdapter', `${p}: ${e?.message || e}`, { path: p });
  }

  async exists(relPath) {
    const r = this._resolve(relPath); if (!r) return this._scope(relPath);
    try { const st = await fs.stat(r.abs); return createOk({ exists: st.isFile() }); }
    catch (e) { return e.code === 'ENOENT' ? createOk({ exists: false }) : this._io(e, r.norm); }
  }
  async readBytes(relPath) {
    const r = this._resolve(relPath); if (!r) return this._scope(relPath);
    try { return createOk({ bytes: new Uint8Array(await fs.readFile(r.abs)) }); } catch (e) { return this._io(e, r.norm); }
  }
  async readText(relPath) {
    const r = this._resolve(relPath); if (!r) return this._scope(relPath);
    try {
      const bytes = await fs.readFile(r.abs);
      // Not UTF-8 (an older page saved as GBK, Big5, Shift-JIS or Latin-1): readable as a rough copy, but marked, because
      // writing the rough copy back would turn every non-English character into "?" for good.
      try { return createOk({ path: r.norm, content: UTF8.decode(bytes) }); }
      catch { return createOk({ path: r.norm, content: bytes.toString('utf8'), notUtf8: true }); }
    } catch (e) { return this._io(e, r.norm); }
  }
  async readJson(relPath) {
    const t = await this.readText(relPath); if (!t.ok) return t;
    try { return createOk({ path: t.data.path, data: JSON.parse(t.data.content), raw: t.data.content }); }
    catch (e) { return createErr(ERROR_CODES.INVALID_CONTENT_FORMAT, 'WorkspaceAdapter', `Not valid JSON (${relPath}): ${e.message}`, { path: relPath }); }
  }
  /** Temporary files left by a write that was cut off (power loss, a forced quit). The real file was never replaced
   *  by a half-written one, so these are only leftovers; they are removed so they are not published. Returns how many. */
  async cleanTemp() {
    let n = 0;
    const walk = async (dir, depth) => {
      if (depth > 12) return;
      let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        if (ent.isDirectory()) { if (!SKIP_DIRS.has(ent.name) || ent.name === 'dist' || ent.name === 'build') await walk(path.join(dir, ent.name), depth + 1); }
        else if (/\.sitetend-tmp-(\d+)-\d+$/.test(ent.name) && RegExp.$1 !== String(process.pid)) { await fs.rm(path.join(dir, ent.name), { force: true }).catch(() => {}); n++; }
      }
    };
    await walk(this.root, 0); return n;
  }
  async _atomicWrite(relPath, data) {
    const r = this._resolve(relPath); if (!r) return this._scope(relPath);
    // A file the owner marked read-only is left alone (replacing it with a new file would otherwise get around that).
    const st = await fs.stat(r.abs).catch(() => null);
    if (st?.isFile() && !(st.mode & 0o222)) return createErr(ERROR_CODES.WORKSPACE_PERMISSION_DENIED, 'WorkspaceAdapter', `"${r.norm}" is read-only, so it was not changed.`, { path: r.norm });
    const tmp = `${r.abs}.sitetend-tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.mkdir(path.dirname(r.abs), { recursive: true });
      await fs.writeFile(tmp, data);
      if (TEST_WRITE_DELAY) await new Promise(res => setTimeout(res, TEST_WRITE_DELAY));   // tests only: widen the moment between writing and replacing
      // Windows: a file held open by an editor, antivirus or sync client can briefly refuse replacement.
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(tmp, r.abs); break; }
        catch (e) { if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || attempt >= 5) throw e; await new Promise(res => setTimeout(res, 60 * (attempt + 1))); }
      }
      this.onWrite(r.norm);
      return createOk({ path: r.norm, bytesWritten: data.length });
    } catch (e) { await fs.rm(tmp, { force: true }).catch(() => {}); return this._io(e, r.norm); }
  }
  async writeBytes(relPath, bytes) { return this._atomicWrite(relPath, Buffer.from(bytes)); }
  async writeText(relPath, content) { return this._atomicWrite(relPath, Buffer.from(String(content), 'utf8')); }
  async writeJson(relPath, data) { return this.writeText(relPath, JSON.stringify(data, null, 2) + '\n'); }
  async deleteFile(relPath) {
    const r = this._resolve(relPath); if (!r) return this._scope(relPath);
    try { await fs.rm(r.abs, { force: true }); this.onWrite(r.norm); return createOk({ deleted: r.norm }); } catch (e) { return this._io(e, r.norm); }
  }
  async stat(relPath) {
    const r = this._resolve(relPath); if (!r) return this._scope(relPath);
    try { const st = await fs.stat(r.abs); return createOk({ size: st.size, mtime: st.mtime.toISOString() }); } catch (e) { return this._io(e, relPath); }
  }
  async listFiles(prefix = '') {
    let base = this.root, norm = '';
    if (prefix) { const r = this._resolve(prefix); if (!r) return this._scope(prefix); base = r.abs; norm = r.norm; }
    const files = [];
    const walk = async (dir, rel, depth) => {
      if (depth > 12) return;
      let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
      for (const ent of entries) {
        if (SKIP_DIRS.has(ent.name) || ent.name.includes('.sitetend-tmp-')) continue;
        if (this.layout === 'site' && dir === this.root && (ent.name === '.sitetend' || ent.name === '.gitignore')) continue;   // Sitetend's own folder is not part of the website
        const p = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) await walk(path.join(dir, ent.name), p, depth + 1);
        else if (ent.isFile()) { files.push(p); if (files.length > MAX_FILES) throw Error(`More than ${MAX_FILES} files.`); }
      }
    };
    try { await walk(base, norm, 0); return createOk({ files: files.sort() }); } catch (e) { return this._io(e, norm || '.'); }
  }
}
