/**
 * Workspace Adapter (v0.3 Spec Section 5.1)
 *
 * Responsibilities:
 * - File reading, writing, permissions, and snapshots inside the authorized workspace folder.
 * - Strictly excludes UI interaction logic or site-specific field rules.
 *
 * Implementations provided:
 * 1. BrowserDirectoryWorkspaceAdapter: Uses Chrome/Edge File System Access API (`FileSystemDirectoryHandle`).
 * 2. MemoryBackedWorkspaceAdapter: Uses in-memory + optional localStorage persistence (for Demo Workspace & automated tests).
 */

import {
  SUPPORTED_SCHEMA_VERSION,
  ERROR_CODES,
  createOk,
  createErr,
} from '../contracts.js';

const FORBIDDEN_SEGMENTS = new Set(['.env', '.git', 'node_modules', 'id_rsa']);

export function normalizeSafePath(relPath) {
  const clean = String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();
  if (!clean) return null;
  const parts = clean.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || FORBIDDEN_SEGMENTS.has(part)) {
      return null;
    }
  }
  return parts.join('/');
}

export function createDefaultConfig() {
  return {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    workspaceName: 'SiteKeeper Workspace',
    siteAdapter: 'json-generic',
    modelProvider: 'mock',
    autoCheckIntervalSeconds: 60,
    autoApply: true,
  };
}

export function createDefaultState(initialHash = '') {
  return {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    baselineContentHash: initialHash,
    lastAppliedAt: new Date().toISOString(),
    snapshots: [],
    maintenanceLogs: [],
    dismissedProposalSignatures: [],
  };
}

/**
 * In-memory / LocalStorage workspace adapter used for the built-in Demo Workspace
 * and automated Node unit tests.
 */
export class MemoryBackedWorkspaceAdapter {
  constructor(initialFiles = {}, storageKey = null, label = 'Built-in Demo Workspace') {
    this.mode = 'memory';
    this.label = label;
    this.storageKey = storageKey;
    this.files = new Map();

    const restored = this._loadFromStorage();
    const seed = restored || initialFiles;
    for (const [k, v] of Object.entries(seed)) {
      const norm = normalizeSafePath(k);
      if (norm) {
        this.files.set(norm, typeof v === 'string' ? v : JSON.stringify(v, null, 2));
      }
    }
  }

  getWorkspaceInfo() {
    return createOk({
      mode: this.mode,
      label: this.label,
      writable: true,
    });
  }

  async exists(relPath) {
    const norm = normalizeSafePath(relPath);
    if (!norm) {
      return createErr(ERROR_CODES.PATH_OUT_OF_SCOPE, 'WorkspaceAdapter', `Path not allowed: "${relPath}"`, { relPath }, false);
    }
    return createOk({ exists: this.files.has(norm) });
  }

  async readText(relPath) {
    const norm = normalizeSafePath(relPath);
    if (!norm) {
      return createErr(ERROR_CODES.PATH_OUT_OF_SCOPE, 'WorkspaceAdapter', `Path not allowed: "${relPath}"`, { relPath }, false);
    }
    if (!this.files.has(norm)) {
      return createErr(ERROR_CODES.WORKSPACE_FILE_NOT_FOUND, 'WorkspaceAdapter', `File not found: "${norm}"`, { path: norm });
    }
    return createOk({ path: norm, content: this.files.get(norm) });
  }

  async readBytes(path) {
    const res = await this.readText(path);
    if (!res.ok) return res;
    const raw = res.data.content;
    const bytes = raw.startsWith('SK_BINARY:')
      ? Uint8Array.from(atob(raw.slice(10)), c => c.charCodeAt(0)) : new TextEncoder().encode(raw);
    return createOk({ bytes });
  }
  async writeBytes(path, bytes) {
    let binary = ''; for (const b of bytes) binary += String.fromCharCode(b);
    return this.writeText(path, 'SK_BINARY:' + btoa(binary));
  }
  async readJson(relPath) {
    const textRes = await this.readText(relPath);
    if (!textRes.ok) return textRes;
    try {
      const parsed = JSON.parse(textRes.data.content);
      return createOk({ path: textRes.data.path, data: parsed, raw: textRes.data.content });
    } catch (err) {
      return createErr(
        ERROR_CODES.INVALID_CONTENT_FORMAT,
        'WorkspaceAdapter',
        `Not valid JSON (${relPath}): ${err.message}`,
        { path: relPath }
      );
    }
  }

  async writeText(relPath, content) {
    const norm = normalizeSafePath(relPath);
    if (!norm) {
      return createErr(ERROR_CODES.PATH_OUT_OF_SCOPE, 'WorkspaceAdapter', `Writing is not allowed here: "${relPath}"`, { relPath }, false);
    }
    const old = this.files.get(norm);
    this.files.set(norm, String(content));
    try { this._saveToStorage(); } catch (err) {
      if (old === undefined) this.files.delete(norm); else this.files.set(norm, old);
      return createErr(ERROR_CODES.WORKSPACE_IO_ERROR, "WorkspaceAdapter", err.message);
    }
    return createOk({ path: norm, bytesWritten: String(content).length });
  }

  async writeJson(relPath, data) {
    const serialized = JSON.stringify(data, null, 2) + '\n';
    return this.writeText(relPath, serialized);
  }

  async deleteFile(relPath) {
    const norm = normalizeSafePath(relPath);
    if (!norm) {
      return createErr(ERROR_CODES.PATH_OUT_OF_SCOPE, 'WorkspaceAdapter', `Path not allowed: "${relPath}"`, { relPath }, false);
    }
    const old = this.files.get(norm);
    this.files.delete(norm);
    try { this._saveToStorage(); } catch (err) {
      if (old !== undefined) this.files.set(norm, old);
      return createErr(ERROR_CODES.WORKSPACE_IO_ERROR, "WorkspaceAdapter", err.message);
    }
    return createOk({ deleted: norm });
  }

  async listFiles(prefix = '') {
    const cleanPrefix = prefix ? normalizeSafePath(prefix) : '';
    if(prefix && !cleanPrefix) return createErr(ERROR_CODES.PATH_OUT_OF_SCOPE,'WorkspaceAdapter','Folder not allowed for listing.');
    const matched = [];
    for (const key of this.files.keys()) {
      if (!cleanPrefix || key.startsWith(cleanPrefix + '/') || key === cleanPrefix) {
        matched.push(key);
      }
    }
    return createOk({ files: matched.sort() });
  }

  exportAllFiles() {
    const out = {};
    for (const [k, v] of this.files.entries()) {
      out[k] = v;
    }
    return out;
  }

  _loadFromStorage() {
    if (!this.storageKey || typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(this.storageKey);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  _saveToStorage() {
    if (!this.storageKey || typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.exportAllFiles()));
    } catch (_) {
      throw new Error("The browser could not save (space or permission). Export the draft or choose a local folder.");
    }
  }
}

/**
 * Browser File System Access API Adapter (`window.showDirectoryPicker`) for Windows/Mac Chrome & Edge.
 */
export class BrowserDirectoryWorkspaceAdapter {
  constructor(rootHandle) {
    this.mode = 'native-fs';
    this.rootHandle = rootHandle;
    this.label = rootHandle?.name || 'Local Folder';
  }

  getWorkspaceInfo() {
    return createOk({
      mode: this.mode,
      label: this.label,
      writable: true,
    });
  }

  async exists(relPath) {
    const norm = normalizeSafePath(relPath);
    if (!norm) {
      return createErr(ERROR_CODES.PATH_OUT_OF_SCOPE, 'WorkspaceAdapter', `Path not allowed: "${relPath}"`, { relPath }, false);
    }
    try {
      await this._resolveFileHandle(norm, false);
      return createOk({ exists: true });
    } catch (err) {
      if (err.name !== "NotFoundError") return createErr(ERROR_CODES.WORKSPACE_PERMISSION_DENIED, "WorkspaceAdapter", err.message);
      return createOk({ exists: false });
    }
  }

  async readText(relPath) {
    const norm = normalizeSafePath(relPath);
    if (!norm) {
      return createErr(ERROR_CODES.PATH_OUT_OF_SCOPE, 'WorkspaceAdapter', `Path not allowed: "${relPath}"`, { relPath }, false);
    }
    try {
      const fileHandle = await this._resolveFileHandle(norm, false);
      const file = await fileHandle.getFile();
      const text = await file.text();
      return createOk({ path: norm, content: text });
    } catch (err) {
      return createErr(
        ERROR_CODES.WORKSPACE_FILE_NOT_FOUND,
        'WorkspaceAdapter',
        `Could not read "${norm}": ${err.message}`,
        { path: norm }
      );
    }
  }

  async readBytes(path) {
    const norm = normalizeSafePath(path);
    if (!norm) return createErr(ERROR_CODES.PATH_OUT_OF_SCOPE, 'WorkspaceAdapter', 'Path not allowed.');
    try {
      const h = await this._resolveFileHandle(norm);
      return createOk({bytes: new Uint8Array(await (await h.getFile()).arrayBuffer())});
    } catch(err) { return createErr(ERROR_CODES.WORKSPACE_IO_ERROR, 'WorkspaceAdapter', err.message); }
  }
  async writeBytes(path, bytes) {
    const norm = normalizeSafePath(path);
    if (!norm) return createErr(ERROR_CODES.PATH_OUT_OF_SCOPE, 'WorkspaceAdapter', 'Path not allowed.');
    try {
      const h = await this._resolveFileHandle(norm, true);
      const w = await h.createWritable(); await w.write(bytes); await w.close();
      return createOk({path:norm});
    } catch(err) { return createErr(ERROR_CODES.WORKSPACE_IO_ERROR, 'WorkspaceAdapter', err.message); }
  }
  async readJson(relPath) {
    const textRes = await this.readText(relPath);
    if (!textRes.ok) return textRes;
    try {
      const parsed = JSON.parse(textRes.data.content);
      return createOk({ path: textRes.data.path, data: parsed, raw: textRes.data.content });
    } catch (err) {
      return createErr(
        ERROR_CODES.INVALID_CONTENT_FORMAT,
        'WorkspaceAdapter',
        `Not valid JSON (${relPath}): ${err.message}`,
        { path: relPath }
      );
    }
  }

  async writeText(relPath, content) {
    const norm = normalizeSafePath(relPath);
    if (!norm) {
      return createErr(ERROR_CODES.PATH_OUT_OF_SCOPE, 'WorkspaceAdapter', `Writing is not allowed here: "${relPath}"`, { relPath }, false);
    }
    try {
      const fileHandle = await this._resolveFileHandle(norm, true);
      const writable = await fileHandle.createWritable();
      await writable.write(String(content));
      await writable.close();
      return createOk({ path: norm, bytesWritten: String(content).length });
    } catch (err) {
      return createErr(
        ERROR_CODES.WORKSPACE_IO_ERROR,
        'WorkspaceAdapter',
        `Could not write "${norm}": ${err.message}`,
        { path: norm }
      );
    }
  }

  async writeJson(relPath, data) {
    const serialized = JSON.stringify(data, null, 2) + '\n';
    return this.writeText(relPath, serialized);
  }

  async deleteFile(relPath) {
    const norm = normalizeSafePath(relPath);
    if (!norm) {
      return createErr(ERROR_CODES.PATH_OUT_OF_SCOPE, 'WorkspaceAdapter', `Path not allowed: "${relPath}"`, { relPath }, false);
    }
    try {
      const parts = norm.split('/');
      const fileName = parts.pop();
      let dir = this.rootHandle;
      for (const seg of parts) {
        dir = await dir.getDirectoryHandle(seg, { create: false });
      }
      await dir.removeEntry(fileName);
      return createOk({ deleted: norm });
    } catch (err) {
      if (err.name !== "NotFoundError") return createErr(ERROR_CODES.WORKSPACE_IO_ERROR, "WorkspaceAdapter", err.message);
      return createOk({ deleted: norm });
    }
  }

  async listFiles(prefix = '') {
    const norm=prefix?normalizeSafePath(prefix):'';
    if(prefix && !norm) return createErr(ERROR_CODES.PATH_OUT_OF_SCOPE,'WorkspaceAdapter','Folder not allowed for listing.');
    try {
      let dir=this.rootHandle;
      for(const part of norm.split('/').filter(Boolean)) dir=await dir.getDirectoryHandle(part);
      const files=[];
      const walk=async(d,base,depth)=>{
        if(depth>8)throw Error('Folders are nested more than 8 levels deep.');
        for await(const [name,handle] of d.entries()) {
          if(name.startsWith('.')||FORBIDDEN_SEGMENTS.has(name)||name==='dist'||name==='build')continue;
          const path=base?base+'/'+name:name;
          if(handle.kind==='directory')await walk(handle,path,depth+1);else files.push(path);
          if(files.length>150)throw Error('More than 150 files.');
        }
      };
      await walk(dir,norm,0);return createOk({files:files.sort()});
    }catch(e){return createErr(ERROR_CODES.WORKSPACE_IO_ERROR,'WorkspaceAdapter',e.message)}
  }

  async _resolveFileHandle(normPath, create = false) {
    const parts = normPath.split('/');
    const fileName = parts.pop();
    let dir = this.rootHandle;
    for (const seg of parts) {
      dir = await dir.getDirectoryHandle(seg, { create });
    }
    return dir.getFileHandle(fileName, { create });
  }
}
