// The owner's materials library.
//
// People drop a file (resume, portfolio, project notes…) onto the Sitetend window. It is NOT used right away:
//   1. it waits in an inbox (.sitetend/inbox/) with a guess of what it is,
//   2. the guess is checked: simple rules -> the AI (when a model is connected) -> an identity check (does the name /
//      email in the file match the owner's website and previous version?),
//   3. the owner confirms (or changes) the kind; only then is it filed under sources/<kind>/ and analysed.
// Dropping a newer resume replaces the old one; the last 3 versions are kept in .sitetend/materials-history/.
import { LEXICON, words } from './lexicon.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SourceParser } from '../adapters/source-parser.js';

export const KINDS = ['resume', 'portfolio', 'project', 'profile', 'other'];
const SINGLE = new Set(['resume', 'profile']);          // one current file per kind (a new one replaces it)
export const MAX_MATERIAL_BYTES = 20 * 1024 * 1024;
const KEEP_VERSIONS = 3;
const INBOX = '.sitetend/inbox';
const HISTORY = '.sitetend/materials-history';
const TEXT_EXT = /\.(md|markdown|txt|json)$/i;
const ALLOWED = /\.(pdf|docx|md|markdown|txt|json)$/i;

const unwrap = r => { if (!r.ok) throw Object.assign(Error(r.error.message), { code: r.error.code }); return r.data; };
const formatOf = n => /\.json$/i.test(n) ? 'json' : /\.pdf$/i.test(n) ? 'pdf' : /\.docx$/i.test(n) ? 'docx' : 'markdown';
/** Keeps letters (any script), digits, dot, dash, underscore and spaces; never a path. */
export const safeName = n => {
  const clean = String(n || 'file').split(/[\\/]/).pop().replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/^\.+/, '') || 'file';
  if (clean.length <= 120) return clean;
  const ext = /\.[\p{L}\p{N}]{1,8}$/u.exec(clean)?.[0] || '';      // a long name is shortened, its extension kept
  return clean.slice(0, 120 - ext.length) + ext;
};

/** Rule-based guess from the file name and the first part of its text. Returns { kind, confidence, why }. */
const N = LEXICON.materialNames;
export function guessKind(name, text = '') {
  const n = name.toLowerCase(), t = text.slice(0, 4000).toLowerCase();
  const has = words => words.filter(w => t.includes(w)).length;
  if (new RegExp('(resume|résumé|cv|curriculum|' + words(N.resume) + ')').test(n)) return { kind: 'resume', confidence: 'high', why: 'file name' };
  if (new RegExp('(portfolio|' + words(N.portfolio) + ')').test(n)) return { kind: 'portfolio', confidence: 'high', why: 'file name' };
  if (new RegExp('(profile|about|bio|' + words(N.profile) + ')').test(n)) return { kind: 'profile', confidence: 'high', why: 'file name' };
  const resume = has(['experience', 'education', 'skills', 'curriculum vitae', 'resume', 'employment', 'publications', ...LEXICON.resumeWords]);
  const portfolio = has(['portfolio', 'case study', 'selected work', 'projects', 'client']);
  const project = has(['project id', 'overview', 'changelog', 'highlights', 'release', 'version']);
  const profile = /"(email|name|github|linkedin|location)"\s*:/.test(t) ? 2 : has(['bio', 'about me', 'contact', 'email:']);
  const best = [['resume', resume], ['portfolio', portfolio], ['project', project], ['profile', profile]].sort((a, b) => b[1] - a[1])[0];
  if (best[1] >= 3) return { kind: best[0], confidence: 'high', why: 'content' };
  if (best[1] >= 1) return { kind: best[0], confidence: 'low', why: 'content' };
  return { kind: 'other', confidence: 'low', why: 'nothing recognisable' };
}

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
/** Who the website belongs to: names and emails shown on the site (fields called name/fullName/author/email). */
function ownerIdentity(site, content) {
  const names = new Set(), emails = new Set();
  for (const f of site.listEditableFields(content)) {
    const v = site.getFieldValue(content, f.path); if (!v.ok || typeof v.data.value !== 'string') continue;
    const key = f.path.split(/[.:]/).pop().toLowerCase(), val = v.data.value.trim();
    if (f.type === 'email') emails.add(val.toLowerCase());
    else if (/^(name|fullname|author|owner)$/.test(key) && val.length <= 60 && /\p{L}/u.test(val) && val.split(/\s+/).length <= 5) names.add(val);
  }
  return { names: [...names], emails: [...emails] };
}

/** Does the file look like it belongs to the same person? Returns warnings (empty = fine). */
export function identityCheck(text, owner, previousText = '') {
  const warn = [], low = text.toLowerCase();
  const fileEmails = [...new Set((text.match(EMAIL) || []).map(e => e.toLowerCase()))];
  const known = new Set([...owner.emails, ...((previousText.match(EMAIL) || []).map(e => e.toLowerCase()))]);
  if (fileEmails.length && known.size && !fileEmails.some(e => known.has(e))) warn.push({ code: 'EMAIL_MISMATCH', file: fileEmails.slice(0, 2), known: [...known].slice(0, 2) });
  const names = owner.names.filter(n => !/^(your|my|some|name)\b/i.test(n));
  const strip = s => s.replace(/^(dr|prof|mr|ms|mrs)\.?\s+/i, '').toLowerCase();
  if (names.length && !names.some(n => strip(n).split(/\s+/).filter(p => p.length > 1).every(p => low.includes(p)))) warn.push({ code: 'NAME_MISSING', known: names.slice(0, 2) });
  return warn;
}

export class MaterialsLibrary {
  /** @param {import('./workspace-session.mjs').WorkspaceSession} session */
  constructor(session) { this.s = session; this.parser = new SourceParser(); }

  async _text(name, bytes) {
    if (TEXT_EXT.test(name)) return new TextDecoder().decode(bytes);
    const r = await this.parser.parseFile({ path: name, format: formatOf(name), rawContent: bytes });
    return r.ok ? r.data.extractedText : '';
  }

  /** Lists filed materials (sources/), the inbox, and the space used. */
  async list() {
    const ws = this.s.ws, files = [];
    const src = unwrap(await ws.listFiles('sources')).files;
    let bytes = 0;
    for (const p of src) {
      const st = await ws.stat?.(p);
      const rel = p.replace(/^sources\//, ''); const dir = rel.includes('/') ? rel.split('/')[0] : '';
      const kind = KINDS.includes(dir) ? dir : dir === 'projects' ? 'project' : guessKind(rel.split('/').pop()).kind;
      files.push({ path: p, name: rel.split('/').pop(), kind, size: st?.ok ? st.data.size : null, modified: st?.ok ? st.data.mtime : null });
      bytes += st?.ok ? st.data.size : 0;
    }
    const inbox = [];
    const ib = await ws.listFiles(INBOX);
    for (const p of ib.ok ? ib.data.files.filter(f => f.endsWith('.json')) : []) {
      const m = await ws.readJson(p); if (m.ok) inbox.push(m.data.data);
    }
    const hist = await ws.listFiles(HISTORY);
    for (const p of hist.ok ? hist.data.files : []) { const st = await ws.stat?.(p); bytes += st?.ok ? st.data.size : 0; }
    return { files, inbox: inbox.sort((a, b) => a.at.localeCompare(b.at)), bytes, kinds: KINDS };
  }

  /** Step 1+2: a dropped file goes to the inbox with a checked guess. Nothing is analysed yet. */
  async receive(name, bytes) {
    name = safeName(name);
    if (!ALLOWED.test(name)) throw Object.assign(Error('Only PDF, Word (.docx), Markdown, text and JSON files can be added.'), { code: 'MATERIAL_TYPE' });
    if (bytes.byteLength > MAX_MATERIAL_BYTES) throw Object.assign(Error('This file is larger than 20 MB.'), { code: 'MATERIAL_TOO_LARGE' });
    const text = await this._text(name, bytes);
    const rule = guessKind(name, text);
    let ai = null;
    if (!this.s.provider.isMock && this.s.provider.classifyMaterial && text.trim()) {
      const r = await this.s.provider.classifyMaterial({ fileName: name, excerpt: text.slice(0, 1500), kinds: KINDS, replyLanguage: this.s.analysis.replyLanguage });
      if (r.ok && KINDS.includes(r.data.kind)) ai = { kind: r.data.kind, confidence: r.data.confidence || 'medium', why: String(r.data.why || '').slice(0, 200) };
    }
    const kind = ai && (rule.confidence === 'low' || ai.confidence === 'high') ? ai.kind : rule.kind;
    const content = unwrap(await this.s.core._readLive()).data;
    const current = (await this.list()).files.find(f => f.kind === kind && SINGLE.has(kind));
    let previousText = '';
    if (current) { const b = await this.s.ws.readBytes(current.path); if (b.ok) previousText = await this._text(current.name, b.data.bytes); }
    const warnings = identityCheck(text, ownerIdentity(this.s.site, content), previousText);
    if (ai && ai.kind !== rule.kind) warnings.push({ code: 'KIND_DISAGREE', rule: rule.kind, ai: ai.kind, why: ai.why });
    if (!text.trim()) warnings.push({ code: 'NO_TEXT' });
    const id = crypto.randomUUID();
    unwrap(await this.s.ws.writeBytes(`${INBOX}/${id}.bin`, bytes));
    const item = { id, name, size: bytes.byteLength, at: new Date().toISOString(), kind, rule, ai, warnings, replaces: current ? current.path : null };
    unwrap(await this.s.ws.writeJson(`${INBOX}/${id}.json`, item));
    this.s.emit('materials', {});
    return item;
  }

  /** Step 3: the owner confirms the kind. The file is filed under sources/<kind>/ and the normal analysis runs. */
  async confirm(id, kind) {
    if (!KINDS.includes(kind)) throw Object.assign(Error('Unknown kind'), { code: 'MATERIAL_KIND' });
    const ws = this.s.ws;
    const item = unwrap(await ws.readJson(`${INBOX}/${safeName(id)}.json`)).data;
    const bytes = unwrap(await ws.readBytes(`${INBOX}/${item.id}.bin`)).bytes;
    const existing = (await this.list()).files.filter(f => f.kind === kind);
    // A new resume/profile takes the place (and the file name) of the current one, so links such as assets/resume.pdf
    // stay in step and nothing looks "deleted". Other kinds only replace a file with the same name.
    // A file with the same name anywhere in the materials is the one being updated (e.g. sources/profile.json),
    // so it is replaced in place and compared with its previous version.
    const all = (await this.list()).files;
    const old = all.find(f => f.name.toLowerCase() === item.name.toLowerCase()) || (SINGLE.has(kind) ? existing[0] : null);
    if (old) {
      const b = await ws.readBytes(old.path);
      if (b.ok) unwrap(await ws.writeBytes(`${HISTORY}/${kind}/${Date.now()}-${old.name}`, b.data.bytes));
      await this._trimHistory(kind);
    }
    const target = old && /\.[^.]+$/.exec(old.name)?.[0].toLowerCase() === /\.[^.]+$/.exec(item.name)?.[0].toLowerCase() ? old.path : `sources/${kind}/${item.name}`;
    const replaced = old ? [old.path] : [];
    if (old && old.path !== target) {
      unwrap(await ws.deleteFile(old.path));
      await this.s.analysis.acknowledgeDeletion(old.path);   // replaced by the new file, not deleted: no "a material was deleted" question
    }
    unwrap(await ws.writeBytes(target, bytes));
    await ws.deleteFile(`${INBOX}/${item.id}.bin`); await ws.deleteFile(`${INBOX}/${item.id}.json`);
    // Keep the published download in step when the site already offers a file with the old name (e.g. assets/resume.pdf)
    this.s.emit('materials', {}); this.s.scheduleAnalysis?.();
    return { path: target, replaced };
  }

  async discard(id) {
    const ws = this.s.ws;
    await ws.deleteFile(`${INBOX}/${safeName(id)}.bin`); await ws.deleteFile(`${INBOX}/${safeName(id)}.json`);
    this.s.emit('materials', {});
    return {};
  }

  async _trimHistory(kind) {
    const ws = this.s.ws, h = await ws.listFiles(`${HISTORY}/${kind}`);
    const files = h.ok ? h.data.files.sort() : [];
    for (const p of files.slice(0, Math.max(0, files.length - KEEP_VERSIONS))) await ws.deleteFile(p);
  }
}
