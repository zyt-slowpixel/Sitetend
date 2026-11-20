/**
 * Site Adapter: json-generic
 *
 * Works with ANY website whose text lives in website/content.json, whatever its structure.
 * Editable fields are discovered from the data itself:
 *   - string            -> text / textarea / email / url (guessed from the value)
 *   - array of strings  -> tags (one item per line or comma)
 *   - array of objects  -> each item addressed by its `id` / `slug` / `key` (stable), else by position
 * Keys starting with "_" and structural keys (id, slug, key, schemaVersion, siteAdapter, theme, icon, color, image)
 * are not editable. A site can give friendlier names with an optional `_sitetend.labels` map: { "path": "Label" }.
 *
 * No knowledge of any particular site lives here: no field names, no source-file mappings.
 */
import { SUPPORTED_SCHEMA_VERSION, ERROR_CODES, createOk, createErr, validateSchemaVersion } from '../contracts.js';
import { TITLE_KEYS, ASSET_KEY, slugify, pickTitleField, cleanValues, insertAt, short } from './collections.js';

const ITEMS = 'items:';   // structural path: a whole array of items, e.g. "items:projects"

export const JSON_GENERIC_ADAPTER_ID = 'json-generic';
const SKIP = /^(id|slug|key|schemaVersion|siteAdapter|theme|visualTheme|icon|color|colour|image|img|avatar|avatarUrl|layout|template)$/i;
const ITEM_KEYS = ['id', 'slug', 'key'];
const SEGMENT_OK = /^[^.\s]+$/;   // keys used in paths may not contain dots or spaces

const itemKey = (item, i, list) => {
  for (const k of ITEM_KEYS) {
    const v = item?.[k];
    if (typeof v === 'string' && SEGMENT_OK.test(v) && list.filter(x => x?.[k] === v).length === 1) return { seg: v, by: k };
  }
  return { seg: String(i), by: null };
};
const guessType = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? 'email' : /^https?:\/\/\S+$/i.test(v) ? 'url' : (v.length > 120 || v.includes('\n')) ? 'textarea' : 'text';
const titleOf = item => TITLE_KEYS.map(k => item?.[k]).find(x => typeof x === 'string' && x.trim());
const humanize = parts => parts.map(p => p.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ')).join(' › ');

export class JsonGenericSiteAdapter {
  constructor() { this.adapterId = JSON_GENERIC_ADAPTER_ID; this.supportedSchemaVersion = SUPPORTED_SCHEMA_VERSION; }
  getAllowedWritableFiles() { return ['website/content.json']; }
  isFileWritable(relativePath) {
    const n = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    return !n.includes('..') && (n === 'website/content.json' || n.startsWith('website/assets/'));
  }
  validateContent(content) {
    const v = validateSchemaVersion(content, 'website/content.json', this.supportedSchemaVersion);
    if (!v.ok) return v;
    if (Array.isArray(content)) return createErr(ERROR_CODES.INVALID_CONTENT_FORMAT, 'SiteAdapter', 'website/content.json must be a JSON object.');
    return createOk({ valid: true });
  }

  /** Walks the content and returns every editable text value with a stable path. */
  listEditableFields(content) {
    const out = [], labels = content?._sitetend?.labels || {};
    const short = t => t.length > 36 ? t.slice(0, 34).trimEnd() + '…' : t;
    // disp: human-readable names for each level ("Publications › Edit Trails: Making AI… › venue")
    const walk = (node, parts, disp, section) => {
      if (Array.isArray(node)) {
        if (node.every(x => typeof x === 'string')) { if (parts.length) out.push(this._field(parts, 'tags', section, labels, disp)); return; }
        node.forEach((item, i) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return;
          const { seg } = itemKey(item, i, node);
          const title = ['title', 'name', 'label', 'heading', 'course', 'text'].map(k => item[k]).find(x => typeof x === 'string');
          const name = title ? short(title) : seg;
          walk(item, [...parts, seg], [...disp, name], `${disp.join(' › ')}: ${name}`);
        });
        return;
      }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (k.startsWith('_') || SKIP.test(k) || /(Path|File)$/.test(k) || !SEGMENT_OK.test(k)) continue;   // file paths are not text
          const d = [...disp, humanize([k])];
          if (typeof v === 'string') out.push(this._field([...parts, k], guessType(v), section || disp.join(' › ') || 'Page', labels, d));
          else if (v && typeof v === 'object') walk(v, [...parts, k], d, parts.length ? section : humanize([k]));
        }
      }
    };
    walk(content, [], [], '');
    return out;
  }
  _field(parts, type, section, labels, disp) {
    const path = parts.join('.');
    const label = disp.join(' › ');
    return { path, type, section, label: labels[path] || label.charAt(0).toUpperCase() + label.slice(1), description: '' };
  }

  /** Resolves a path to { parent, key } inside content (array items matched by id/slug/key, then position). */
  _locate(content, fieldPath) {
    const parts = String(fieldPath).split('.');
    let cur = content;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (Array.isArray(cur)) {
        const byKey = cur.findIndex((x, j) => x && typeof x === 'object' && itemKey(x, j, cur).seg === seg);
        cur = cur[byKey];
      } else cur = cur?.[seg];
      if (cur === undefined || cur === null || typeof cur !== 'object') return null;
    }
    return { parent: cur, key: parts.at(-1) };
  }
  getFieldValue(content, fieldPath) {
    if (String(fieldPath).startsWith(ITEMS)) {
      const path = fieldPath.slice(ITEMS.length), arr = this._resolve(content, path);
      return createOk({ field: { path: fieldPath, type: 'items', section: path, label: this._listLabel(content, path) }, value: arr === undefined ? undefined : structuredClone(arr) });
    }
    const field = this.listEditableFields(content).find(f => f.path === fieldPath);
    if (!field) return createErr(ERROR_CODES.FIELD_NOT_EDITABLE, 'SiteAdapter', `"${fieldPath}" is not an editable field of this website.`, { fieldPath });
    const at = this._locate(content, fieldPath);
    return createOk({ field, value: at ? structuredClone(at.parent[at.key]) : '' });
  }
  setFieldValue(content, fieldPath, raw) {
    const check = this.validateContent(content); if (!check.ok) return check;
    const field = this.listEditableFields(content).find(f => f.path === fieldPath);
    if (!field) return createErr(ERROR_CODES.FIELD_NOT_EDITABLE, 'SiteAdapter', `"${fieldPath}" is not an editable field of this website.`, { fieldPath });
    const clean = this._sanitize(field, raw); if (!clean.ok) return clean;
    const updated = structuredClone(content); const at = this._locate(updated, fieldPath);
    if (!at) return createErr(ERROR_CODES.FIELD_NOT_EDITABLE, 'SiteAdapter', `"${fieldPath}" was not found.`, { fieldPath });
    at.parent[at.key] = clean.data;
    return createOk({ content: updated, field, value: clean.data });
  }
  setFieldRaw(content, fieldPath, value) {
    if (String(fieldPath).startsWith(ITEMS)) {
      const path = fieldPath.slice(ITEMS.length), updated = structuredClone(content), at = this._locate(updated, path);
      if (!at || (value !== undefined && !Array.isArray(value))) return createErr(ERROR_CODES.FIELD_NOT_EDITABLE, 'SiteAdapter', `"${fieldPath}" was not found.`, { fieldPath });
      if (value === undefined) delete at.parent[at.key]; else at.parent[at.key] = structuredClone(value);
      return createOk({ content: updated });
    }
    if (!this.listEditableFields(content).some(f => f.path === fieldPath)) return createErr(ERROR_CODES.FIELD_NOT_EDITABLE, 'SiteAdapter', `"${fieldPath}" is not an editable field of this website.`, { fieldPath });
    const updated = structuredClone(content); const at = this._locate(updated, fieldPath);
    if (!at) return createErr(ERROR_CODES.FIELD_NOT_EDITABLE, 'SiteAdapter', `"${fieldPath}" was not found.`, { fieldPath });
    at.parent[at.key] = structuredClone(value);
    return createOk({ content: updated });
  }
  diffContent(base, target) {
    const paths = new Map();
    for (const f of [...this.listEditableFields(base || {}), ...this.listEditableFields(target || {})]) paths.set(f.path, f);
    const changes = [];
    for (const f of paths.values()) {
      const a = this.getFieldValue(base, f.path), b = this.getFieldValue(target, f.path);
      const va = a.ok ? a.data.value : undefined, vb = b.ok ? b.data.value : undefined;
      if (JSON.stringify(va) !== JSON.stringify(vb)) changes.push({ path: f.path, label: f.label, section: f.section, type: f.type, before: va, after: vb });
    }
    return createOk(this._structural(base || {}, target || {}, changes));
  }
  /**
   * When items were added, removed or reordered (or changed in ways the text fields do not cover), report the whole
   * list as one change ("items:<path>") instead of field changes, so merge and undo stay exact.
   */
  _structural(base, target, changes) {
    const paths = [...new Set([...this._arrays(base), ...this._arrays(target)].map(a => a.path))].sort((a, b) => a.length - b.length);
    const whole = [];
    for (const path of paths) {
      if (whole.some(w => path.startsWith(w + '.'))) continue;
      const A = this._resolve(base, path), B = this._resolve(target, path);
      if (JSON.stringify(A) === JSON.stringify(B)) continue;
      const keys = arr => Array.isArray(arr) ? arr.map((x, i) => itemKey(x, i, arr).seg).join('\u0000') : null;
      let structural = !Array.isArray(A) || !Array.isArray(B) || keys(A) !== keys(B);
      if (!structural) {   // do the field changes explain the whole difference?
        let tmp = base;
        for (const c of changes.filter(c => c.path.startsWith(path + '.'))) { const r = this.setFieldRaw(tmp, c.path, c.after); if (r.ok) tmp = r.data.content; }
        structural = JSON.stringify(this._resolve(tmp, path)) !== JSON.stringify(B);
      }
      if (!structural) continue;
      whole.push(path);
      for (let i = changes.length - 1; i >= 0; i--) if (changes[i].path.startsWith(path + '.')) changes.splice(i, 1);
      changes.push({ path: ITEMS + path, label: this._listLabel(target, path) || this._listLabel(base, path), section: path, type: 'items', before: A, after: B });
    }
    return { hasChanges: changes.length > 0, changeCount: changes.length, changes };
  }
  // ---- collections: arrays of same-shaped objects (projects, publications, menu items…)
  /** Every array of objects, with the same path segments the field paths use. */
  _arrays(content) {
    const out = [];
    const walk = (node, parts, disp) => {
      if (Array.isArray(node)) {
        if (node.length && parts.length && node.every(x => x && typeof x === 'object' && !Array.isArray(x))) out.push({ path: parts.join('.'), node, disp });
        node.forEach((item, i) => { if (item && typeof item === 'object' && !Array.isArray(item)) walk(item, [...parts, itemKey(item, i, node).seg], [...disp, short(titleOf(item) || String(i + 1), 36)]); });
        return;
      }
      if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) {
        if (k.startsWith('_') || SKIP.test(k) || /(Path|File)$/.test(k) || !SEGMENT_OK.test(k)) continue;
        if (v && typeof v === 'object') walk(v, [...parts, k], [...disp, humanize([k])]);
      }
    };
    walk(content, [], []);
    return out;
  }
  _resolve(content, path) {
    let cur = content;
    for (const seg of String(path).split('.')) {
      if (Array.isArray(cur)) cur = cur[cur.findIndex((x, j) => x && typeof x === 'object' && itemKey(x, j, cur).seg === seg)];
      else cur = cur?.[seg];
      if (cur === undefined || cur === null) return undefined;
    }
    return cur;
  }
  _listLabel(content, path) {
    const labels = content?._sitetend?.labels || {};
    const a = this._arrays(content).find(x => x.path === path);
    const name = labels[path] || (a ? a.disp.join(' › ') : humanize(path.split('.')));
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  /** Text-like leaves of one item: strings, lists of strings, numbers. Nested objects use dotted names. */
  _leaves(item, prefix = '') {
    const out = [];
    for (const [k, v] of Object.entries(item || {})) {
      if (k.startsWith('_') || SKIP.test(k) || /(Path|File)$/.test(k) || !SEGMENT_OK.test(k)) continue;
      const name = prefix + k;
      if (typeof v === 'string') out.push({ name, type: guessType(v), value: v });
      else if (typeof v === 'number') out.push({ name, type: 'number', value: v });
      else if (Array.isArray(v)) { if (v.every(x => typeof x === 'string')) out.push({ name, type: 'tags', value: v }); }
      else if (v && typeof v === 'object') out.push(...this._leaves(v, name + '.'));
    }
    return out;
  }
  listCollections(content) {
    return this._arrays(content).map(a => {
      const per = a.node.map(it => this._leaves(it)), fields = [];
      for (const leaves of per) for (const l of leaves) if (!fields.some(f => f.name === l.name)) fields.push({ name: l.name, type: l.type, example: short(l.value) });
      for (const f of fields) {
        f.required = per.every(ls => ls.some(l => l.name === f.name && (Array.isArray(l.value) ? l.value.length : String(l.value).trim())));
        const distinct = [...new Set(per.map(ls => ls.find(l => l.name === f.name)?.value).filter(v => typeof v === 'string'))];
        if (f.type === 'text' && per.length >= 2 && distinct.length <= Math.min(3, per.length - 1) && distinct.every(v => v.length <= 24)) f.choices = distinct;
      }
      const usable = fields.some(f => f.type !== 'number');
      return { id: a.path, kind: 'json', label: this._listLabel(content, a.path), items: a.node.map((it, i) => ({ key: itemKey(it, i, a.node).seg, title: titleOf(it) || String(i + 1) })),
        fields, titleField: pickTitleField(fields), canAdd: usable, canReplace: usable };
    });
  }
  /** A new item copied from the shape of an existing one and filled with `values` (op 'add'), or one item replaced. */
  buildItem(content, collectionId, { op = 'add', key = null, position = 'end', values = {} } = {}) {
    const coll = this.listCollections(content).find(c => c.id === collectionId);
    const fail = msg => createErr(ERROR_CODES.FIELD_NOT_EDITABLE, 'SiteAdapter', msg, { collection: collectionId });
    if (!coll || !coll.canAdd) return fail('This list cannot take new items.');
    const arr = this._resolve(content, collectionId), vals = cleanValues(values);
    const index = op === 'replace' ? coll.items.findIndex(i => i.key === key) : -1;
    if (op === 'replace' && index < 0) return fail('The item to replace was not found.');
    const richest = arr.reduce((best, it) => this._leaves(it).length > this._leaves(best).length ? it : best, arr[0]);
    const item = structuredClone(op === 'replace' ? arr[index] : richest), missing = [], warnings = [];
    const getD = (o, n) => n.split('.').reduce((x, k) => x?.[k], o);
    const setD = (o, n, v) => { const ks = n.split('.'); let x = o; for (const k of ks.slice(0, -1)) x = x[k] ??= {}; x[ks.at(-1)] = v; };
    const delD = (o, n) => { const ks = n.split('.'); const x = ks.slice(0, -1).reduce((y, k) => y?.[k], o); if (x) delete x[ks.at(-1)]; };
    for (const f of coll.fields) {
      const v = vals[f.name];
      if (v !== undefined) {
        if (f.type === 'tags') setD(item, f.name, Array.isArray(v) ? v : v.split(/[,\uff0c\n]/).map(x => x.trim()).filter(Boolean));
        else if (f.type === 'number') { const n = Number(String(v).replace(/[^\d.-]/g, '')); setD(item, f.name, Number.isFinite(n) && String(v).trim() ? n : v); }
        else setD(item, f.name, Array.isArray(v) ? v.join(', ') : v);
      } else if (getD(item, f.name) !== undefined) {
        if (!f.required) delD(item, f.name);
        else if (f.type === 'number' || f.choices) warnings.push({ code: 'KEPT_FROM_TEMPLATE', field: f.name, value: getD(item, f.name) });
        else { setD(item, f.name, f.type === 'tags' ? [] : ''); missing.push(f.name); }
      }
    }
    const title = vals[coll.titleField] ? String(vals[coll.titleField]) : '';
    if (op === 'add') for (const k of ['id', 'slug', 'key']) if (typeof item[k] === 'string') item[k] = slugify(title || 'item', new Set(arr.map(x => x?.[k]).filter(Boolean)));
    const scan = (o, prefix) => { for (const [k, v] of Object.entries(o || {})) {
      if (typeof v === 'string' && v && (ASSET_KEY.test(k) || /^(image|img|avatar|icon)$/i.test(k))) warnings.push({ code: 'ASSET_FROM_TEMPLATE', field: prefix + k, value: v });
      else if (Array.isArray(v) && v.some(x => x && typeof x === 'object')) { o[k] = []; warnings.push({ code: 'NESTED_CLEARED', field: prefix + k }); }
      else if (v && typeof v === 'object' && !Array.isArray(v)) scan(v, prefix + k + '.');
    } };
    scan(item, '');
    const list = insertAt(arr, item, { op, index, position });
    const set = this.setFieldRaw(content, ITEMS + collectionId, list); if (!set.ok) return set;
    const at = op === 'replace' ? index : position === 'start' ? 0 : list.length - 1;
    return createOk({ content: set.data.content, title, key: itemKey(item, at, list).seg, missing, warnings, paths: [ITEMS + collectionId] });
  }
  buildPreviewPayload(content, { mode = 'draft', editable = true, activeFieldPath = null } = {}) {
    const check = this.validateContent(content); if (!check.ok) return check;
    return createOk({ adapterId: this.adapterId, mode, editable: Boolean(editable && mode === 'draft'), activeFieldPath, content: structuredClone(content) });
  }
  getSourceMappings() { return []; }
  getSourceHints() { return []; }
  _sanitize(field, raw) {
    const strip = s => String(s).replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g, '');
    if (field.type === 'tags') {
      const arr = (Array.isArray(raw) ? raw : String(raw ?? '').split(/[,\uff0c\n]/)).map(v => strip(v).trim()).filter(Boolean);
      return arr.length ? createOk(arr) : createErr(ERROR_CODES.FIELD_VALIDATION_FAILED, 'SiteAdapter', `"${field.label}" needs at least one item.`, { fieldPath: field.path });
    }
    const v = strip(raw ?? '').trim();
    if (!v) return createErr(ERROR_CODES.FIELD_VALIDATION_FAILED, 'SiteAdapter', `"${field.label}" cannot be empty.`, { fieldPath: field.path });
    if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return createErr(ERROR_CODES.FIELD_VALIDATION_FAILED, 'SiteAdapter', 'Please enter a valid email address.', { fieldPath: field.path, value: v });
    if (field.type === 'url' && !/^https?:\/\/\S+$/i.test(v)) return createErr(ERROR_CODES.FIELD_VALIDATION_FAILED, 'SiteAdapter', `"${field.label}" must start with http:// or https://.`, { fieldPath: field.path, value: v });
    return createOk(v);
  }
}
