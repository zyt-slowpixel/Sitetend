// @ts-check
// What Sitetend remembers for the owner: preferences ("write months in full"), decisions ("keep Shelter Map
// in the list") and, later, answers to questions. Every note is visible, editable and removable in
// Settings > Advanced > Memory, and every change is appended to a log, so it is always traceable where a
// note came from. Notes for one website live in <site>/.sitetend/memory.json; notes for all websites in
// ~/.sitetend/memory.json. Nothing here is sent anywhere except the few notes relevant to a model call.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { userDir } from './user-config.mjs';

export const KINDS = ['answer', 'preference', 'decision'];
const STATUSES = ['active', 'paused', 'outdated'];
const FROM = ['question', 'chat', 'reject', 'edits', 'manual'];
const MAX_TEXT = 500, MAX_NOTES = 500, MAX_CANDIDATES = 30;
const EMPTY = () => ({ schemaVersion: 1, seq: 0, items: [], candidates: [], seen: [] });

const fail = (code, message) => Object.assign(new Error(message), { code });
const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();

async function readStore(file) {
  try {
    const d = JSON.parse(await fs.readFile(file, 'utf8'));
    return { ...EMPTY(), ...d, items: Array.isArray(d.items) ? d.items : [], candidates: Array.isArray(d.candidates) ? d.candidates : [], seen: Array.isArray(d.seen) ? d.seen : [] };
  } catch (e) {
    if (e.code === 'ENOENT') return EMPTY();
    // A damaged file is kept aside, never silently overwritten.
    await fs.rename(file, `${file}.damaged-${Date.now()}`).catch(() => {});
    return EMPTY();
  }
}
async function writeStore(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 1));
  await fs.rename(tmp, file);
}

/**
 * The notes of one open website plus the notes shared by all websites.
 * Ids: "m-0007" (this website) and "g-0007" (all websites).
 */
export class Memory {
  /** @param {{ siteDir: string, home?: string }} o siteDir: the website's .sitetend folder */
  constructor({ siteDir, home = userDir() }) {
    this.files = { site: path.join(siteDir, 'memory.json'), all: path.join(home, 'memory.json') };
    this.logs = { site: path.join(siteDir, 'memory-log.jsonl'), all: path.join(home, 'memory-log.jsonl') };
    this.queue = Promise.resolve();
  }
  /** One change at a time, so two quick clicks never lose a note. */
  serial(fn) { const run = this.queue.then(fn, fn); this.queue = run.catch(() => {}); return run; }
  async log(scope, entry) { await fs.mkdir(path.dirname(this.logs[scope]), { recursive: true }); await fs.appendFile(this.logs[scope], JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); }
  scopeOf(id) { return String(id).startsWith('g-') ? 'all' : 'site'; }

  /** Every note (this website's and the shared ones), newest first, plus open "remember this?" questions. */
  async list() {
    const [site, all] = await Promise.all([readStore(this.files.site), readStore(this.files.all)]);
    const items = [...site.items.map(i => ({ ...i, scope: 'site' })), ...all.items.map(i => ({ ...i, scope: 'all' }))]
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return { items, candidates: site.candidates.filter(c => c.status === 'open') };
  }

  /**
   * Adds a note. kind: preference | decision | answer. scope: 'all' (every website) or 'site'; only preferences can be shared.
   * @returns {Promise<any>} the note
   */
  add({ kind, text, scope, from = {}, about = {}, lang = null }) {
    return this.serial(async () => {
      if (!KINDS.includes(kind)) throw fail('MEMORY_BAD', 'Unknown kind of note.');
      const t = clean(text).slice(0, MAX_TEXT);
      if (t.length < 2) throw fail('MEMORY_EMPTY', 'Write what Sitetend should remember.');
      const sc = kind === 'preference' && scope !== 'site' ? 'all' : 'site';   // answers and decisions are about one website's own text
      const store = await readStore(this.files[sc]);
      const norm = x => x.toLowerCase().replace(/[.\u3002!\uff01\s]+$/, '');
      const same = store.items.find(i => i.kind === kind && norm(i.text) === norm(t));
      if (same) return { ...same, scope: sc, existed: true };
      if (store.items.length >= MAX_NOTES) throw fail('MEMORY_FULL', `There are already ${MAX_NOTES} notes. Remove some first.`);
      const now = new Date().toISOString();
      const note = { id: `${sc === 'all' ? 'g' : 'm'}-${String(++store.seq).padStart(4, '0')}`, kind, text: t, lang, status: 'active',
        from: { type: FROM.includes(from.type) ? from.type : 'manual', ...(from.ref ? { ref: String(from.ref).slice(0, 100) } : {}), ...(from.quote ? { quote: String(from.quote).slice(0, 600) } : {}) },
        about: { fields: Array.isArray(about.fields) ? about.fields.filter(f => typeof f === 'string').slice(0, 20) : [], files: Array.isArray(about.files) ? about.files.filter(f => typeof f === 'string').slice(0, 20) : [] },
        createdAt: now, updatedAt: now, usedCount: 0, lastUsedAt: null };
      store.items.push(note);
      await writeStore(this.files[sc], store); await this.log(sc, { op: 'add', note });
      return { ...note, scope: sc };
    });
  }

  /** Changes a note's text, status (active | paused) or scope. Moving between scopes gives it a new id. */
  update(id, { text, status, scope }) {
    return this.serial(async () => {
      const sc = this.scopeOf(id); const store = await readStore(this.files[sc]);
      const note = store.items.find(i => i.id === id);
      if (!note) throw fail('MEMORY_NOT_FOUND', 'This note no longer exists.');
      const before = { text: note.text, status: note.status };
      if (text !== undefined) { const t = clean(text).slice(0, MAX_TEXT); if (t.length < 2) throw fail('MEMORY_EMPTY', 'Write what Sitetend should remember.'); note.text = t; }
      if (status !== undefined) { if (!STATUSES.includes(status)) throw fail('MEMORY_BAD', 'Unknown status.'); note.status = status; }
      note.updatedAt = new Date().toISOString();
      const want = scope === 'all' || scope === 'site' ? scope : sc;
      if (want !== sc) {
        if (note.kind !== 'preference') throw fail('MEMORY_BAD', 'Only preferences can apply to all websites.');
        const other = await readStore(this.files[want]);
        const moved = { ...note, id: `${want === 'all' ? 'g' : 'm'}-${String(++other.seq).padStart(4, '0')}` };
        other.items.push(moved); store.items = store.items.filter(i => i.id !== id);
        await writeStore(this.files[want], other); await writeStore(this.files[sc], store);
        await this.log(sc, { op: 'move-out', id, to: moved.id }); await this.log(want, { op: 'move-in', note: moved, was: id });
        return { ...moved, scope: want };
      }
      await writeStore(this.files[sc], store); await this.log(sc, { op: 'update', id, before, after: { text: note.text, status: note.status } });
      return { ...note, scope: sc };
    });
  }

  /** Removes a note (it stays in the log). */
  remove(id) {
    return this.serial(async () => {
      const sc = this.scopeOf(id); const store = await readStore(this.files[sc]);
      const note = store.items.find(i => i.id === id);
      if (!note) return { removed: false };
      store.items = store.items.filter(i => i.id !== id);
      await writeStore(this.files[sc], store); await this.log(sc, { op: 'remove', note });
      return { removed: true };
    });
  }

  /**
   * The notes to give a model for one piece of work: active only; preferences always, decisions and answers when
   * they are about no particular field or about one of `fields`. Newest first, within a size budget.
   * @returns {Promise<{id: string, kind: string, text: string}[]>}
   */
  async relevant({ fields = null, limit = 20, budget = 6000 } = {}) {
    const { items } = await this.list();
    const set = fields ? new Set(fields) : null;
    const out = []; let size = 0;
    for (const n of items) {
      if (n.status !== 'active') continue;
      if (n.kind !== 'preference' && set && n.about?.fields?.length && !n.about.fields.some(f => set.has(f))) continue;
      if (out.length >= limit || size + n.text.length > budget) break;
      out.push({ id: n.id, kind: n.kind, text: n.text, ...(n.about?.fields?.length ? { fields: n.about.fields } : {}) }); size += n.text.length;
    }
    return out;
  }

  /** Counts a use (shown on the memory page: "used 3 times"). */
  used(ids) {
    return this.serial(async () => {
      const now = new Date().toISOString();
      for (const sc of ['site', 'all']) {
        const mine = ids.filter(id => this.scopeOf(id) === sc); if (!mine.length) continue;
        const store = await readStore(this.files[sc]); let hit = false;
        for (const n of store.items) if (mine.includes(n.id)) { n.usedCount = (n.usedCount || 0) + 1; n.lastUsedAt = now; hit = true; }
        if (hit) await writeStore(this.files[sc], store);
      }
    });
  }

  // ---- learning from the owner's own edits (rules only, no model): the same change twice becomes a question ----

  /**
   * Call when the owner accepted a suggestion after changing its words. Returns a new "remember this?" question
   * when the same kind of change has now been made twice (in two different suggestions), else null.
   */
  observeEdit({ proposalId, field, suggested, final }) {
    return this.serial(async () => {
      const found = editPatterns(suggested, final); if (!found.length) return null;
      const store = await readStore(this.files.site); let made = null;
      for (const p of found) {
        if (store.seen.some(s => s.key === p.key && s.proposalId === proposalId)) continue;
        store.seen.push({ key: p.key, proposalId, field, at: new Date().toISOString(), example: p.example });
        const times = store.seen.filter(s => s.key === p.key);
        const known = store.candidates.find(c => c.key === p.key);
        if (times.length >= 2 && !known) {
          made = { id: 'c-' + crypto.randomBytes(4).toString('hex'), key: p.key, rule: p.rule, status: 'open', examples: times.slice(-3).map(s => s.example), createdAt: new Date().toISOString() };
          store.candidates.push(made);
        }
      }
      store.seen = store.seen.slice(-200); store.candidates = store.candidates.slice(-MAX_CANDIDATES);
      await writeStore(this.files.site, store);
      if (made) await this.log('site', { op: 'candidate', candidate: made });
      return made;
    });
  }

  /** Answers a "remember this?" question. remember: text is the note to save (written by the interface in the owner's language). */
  resolveCandidate(id, { remember, text, scope }) {
    return this.serial(async () => {
      const store = await readStore(this.files.site);
      const c = store.candidates.find(x => x.id === id && x.status === 'open');
      if (!c) throw fail('MEMORY_NOT_FOUND', 'This question no longer exists.');
      c.status = remember ? 'remembered' : 'dismissed'; c.resolvedAt = new Date().toISOString();
      await writeStore(this.files.site, store); await this.log('site', { op: 'candidate-' + c.status, id });
      return c;
    }).then(async c => (remember ? { note: await this.add({ kind: 'preference', text, scope, from: { type: 'edits', ref: c.id, quote: c.examples.map(e => `${e.from} -> ${e.to}`).join(' | ') } }) } : {}));
  }
}

// ------------------------------------------------------------------ edit patterns
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthOf = w => { const t = w.toLowerCase().replace(/\.$/, ''); if (t.length < 3) return -1; const i = MONTHS.findIndex(m => m === t || (t.length >= 3 && t.length < m.length && m.startsWith(t))); return i < 0 ? -1 : MONTHS[i] === t ? i + 100 : i; };

const split = s => String(s).split(/(\s+)/).filter(x => x !== '');
/** Longest common subsequence over tokens; returns the replaced runs as [{ from, to }]. */
function replacedRuns(a, b) {
  const A = split(a), B = split(b), n = A.length, m = B.length;
  if (n > 400 || m > 400) return [];
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const runs = []; let i = 0, j = 0, cur = null;
  const flush = () => { if (cur) { runs.push({ from: cur.from.join('').trim(), to: cur.to.join('').trim() }); cur = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { if (cur && /^\s+$/.test(A[i])) { cur.from.push(A[i]); cur.to.push(B[j]); } else flush(); i++; j++; }
    else { cur = cur || { from: [], to: [] }; if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) cur.to.push(B[j++]); else cur.from.push(A[i++]); }
  }
  flush();
  return runs.filter(r => r.from !== r.to);
}

/**
 * What kind of change did the owner make to a suggested text? Returns [{ key, rule, example }].
 * rule: { type: 'month-full' | 'month-short' | 'no-end-period' | 'end-period' | 'replace', from?, to? }.
 * Only clear, small changes count; a rewritten sentence is not a pattern.
 */
export function editPatterns(suggested, final) {
  if (typeof suggested !== 'string' || typeof final !== 'string' || suggested === final) return [];
  const out = [];
  const a = suggested.trim(), b = final.trim();
  if (a.replace(/[.\u3002]$/, '') === b && /[.\u3002]$/.test(a)) return [{ key: 'no-end-period', rule: { type: 'no-end-period' }, example: { from: a.slice(-25), to: b.slice(-25) } }];
  if (b.replace(/[.\u3002]$/, '') === a && /[.\u3002]$/.test(b)) return [{ key: 'end-period', rule: { type: 'end-period' }, example: { from: a.slice(-25), to: b.slice(-25) } }];
  const runs = replacedRuns(a, b);
  if (!runs.length || runs.length > 3) return [];
  for (const r of runs) {
    if (!r.from || !r.to || r.from.length > 40 || r.to.length > 40) return [];   // text added, removed or rewritten: not a pattern
    const strip = w => w.replace(/[,;:)]+$/, '');
    const fa = monthOf(strip(r.from)), fb = monthOf(strip(r.to));
    if (fa >= 0 && fb >= 0 && fa % 100 === fb % 100 && fa !== fb) { const key = fb >= 100 ? 'month-full' : 'month-short'; if (!out.some(o => o.key === key)) out.push({ key, rule: { type: key }, example: r }); continue; }
    const key = 'replace:' + r.from.toLowerCase() + '=>' + r.to;
    out.push({ key, rule: { type: 'replace', from: r.from, to: r.to }, example: r });
  }
  return out;
}
