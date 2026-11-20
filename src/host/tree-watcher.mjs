// @ts-check
// Watches a folder tree and reports changed files as workspace-relative paths ("a/b/c.json").
//
// macOS / Windows: native recursive fs.watch.
// Linux: Node's recursive watcher loses track of a file after it is replaced by rename (which is how Sitetend
// writes atomically), so later in-place edits by other tools would go unnoticed. There we watch every directory
// non-recursively instead; directory watches survive renames and new directories are picked up as they appear.
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} root
 * @param {(rel: string) => void} onChange
 * @param {{ ignore?: RegExp, onError?: (e: Error) => void, maxDirs?: number }} [opts]
 * @returns {{ close(): void }}
 */
export function watchTree(root, onChange, { ignore = /^$/, onError = () => {}, maxDirs = 2000 } = {}) {
  const toRel = abs => path.relative(root, abs).split(path.sep).join('/');
  if (process.platform === 'darwin' || process.platform === 'win32') {
    const w = fs.watch(root, { recursive: true }, (_e, f) => { if (f) { const rel = String(f).split(path.sep).join('/'); if (!ignore.test(rel)) onChange(rel); } });
    w.on('error', onError);
    return { close: () => w.close() };
  }
  const watchers = new Map();
  const add = dir => {
    if (watchers.has(dir) || watchers.size >= maxDirs) return;
    const rel = toRel(dir);
    if (rel && ignore.test(rel + '/')) return;
    let w;
    try {
      w = fs.watch(dir, (_e, name) => {
        if (!name) return;
        const abs = path.join(dir, String(name)), r = toRel(abs);
        if (ignore.test(r)) return;
        fs.stat(abs, (err, st) => {
          if (!err && st.isDirectory()) { walk(abs); return; }   // new folder: start watching it
          onChange(r);
        });
      });
    } catch (e) { onError(/** @type {Error} */ (e)); return; }
    w.on('error', () => { w.close(); watchers.delete(dir); });   // folder removed
    watchers.set(dir, w);
  };
  const walk = dir => {
    add(dir);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory()) walk(path.join(dir, e.name));
  };
  walk(root);
  return { close() { for (const w of watchers.values()) w.close(); watchers.clear(); } };
}
