/**
 * Shared helpers for "collections": groups of same-shaped items on a website (a projects list, a publications folder,
 * a members list). Sitetend can add a new item to a collection, or replace one item, by copying the shape of an item
 * that is already there and filling it with values from the owner's materials. It never invents a new layout.
 *
 * A collection, as returned by an adapter's listCollections(content):
 *   { id, label, kind: 'json'|'yaml'|'list'|'files', items: [{ key, title }],
 *     fields: [{ name, type, required, example }], titleField, canAdd, canReplace, why? }
 * buildItem(content, id, { op: 'add'|'replace', key, position: 'start'|'end', values }) returns
 *   ok { content, title, key, missing: [field names left empty], warnings: [{ code, field, value }] }
 */
export const TITLE_KEYS = ['title', 'name', 'label', 'heading', 'course', 'talkTitle', 'text'];
export const ASSET_KEY = /(image|img|avatar|photo|picture|thumb|thumbnail|cover|logo|banner|teaser|header|icon|Path|File)$/i;

export const normTitle = s => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function slugify(s, taken = new Set()) {
  const base = String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
  let out = base, n = 2;
  while (taken.has(out)) out = `${base}-${n++}`;
  return out;
}
export function pickTitleField(fields) {
  const names = fields.map(f => f.name);
  return TITLE_KEYS.find(k => names.includes(k)) || fields.find(f => f.required && f.type === 'text')?.name || fields.find(f => f.type === 'text')?.name || fields[0]?.name || null;
}
/** Today as YYYY-MM-DD (local time). */
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
/** Turns "March 3, 2026", "2026-03", "2026" into YYYY-MM-DD when possible; otherwise null. */
export function isoDate(v) {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${(m[3] || '1').padStart(2, '0')}`;
  if (/^\d{4}$/.test(s)) return `${s}-01-01`;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  return null;
}
export const short = (v, n = 60) => { const s = Array.isArray(v) ? v.join(', ') : String(v ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
/** Values from a model or the user: strings (trimmed) or lists of strings; anything else is dropped. */
export function cleanValues(values) {
  const out = {};
  for (const [k, v] of Object.entries(values && typeof values === 'object' ? values : {})) {
    if (typeof v === 'string' && v.trim()) out[k] = v.replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g, '').trim();
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = String(v);
    else if (Array.isArray(v)) { const a = v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()); if (a.length) out[k] = a; }
  }
  return out;
}
export function insertAt(list, item, { op, index, position }) {
  const out = list.slice();
  if (op === 'replace') out[index] = item;
  else if (position === 'start') out.unshift(item);
  else out.push(item);
  return out;
}
