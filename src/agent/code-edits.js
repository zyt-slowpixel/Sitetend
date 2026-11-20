/**
 * Code changes written by the model (B): small find-and-replace edits to one page or style sheet, for what a field
 * or a list cannot do (a new section, an entry in a list laid out by hand, a small layout fix). The model reads a
 * condensed copy of the file, where long script and style blocks and long attribute values (drawn shapes, inline
 * pictures) are shown as short tokens; its edits are mapped back to the real text before anything is checked.
 *
 * Checks before a change is shown: every edit's "find" text occurs exactly once; edits do not overlap; the change
 * adds no script, no event handler, no javascript: link, no frame or embedded object, no <base>/<meta refresh>, and
 * no style sheet or picture from another website; in a page, every element it opens it also closes. The owner then
 * sees it in the live preview and accepts or rejects it; accepting is one step that can be undone.
 */
export const CODE_FILE = /\.(html?|css)$/i;
export const MAX_EDITS = 20, MAX_ADDED = 60000, MAX_VIEW = 56000;
const TOKEN = /⟦[SA]\d+⟧/g;

/** A short copy of the file for the model, and the tokens to put the long parts back. */
export function condense(text) {
  const map = new Map(); let n = 0;
  const keep = (orig, kind) => { const k = `⟦${kind}${++n}⟧`; map.set(k, orig); return k; };
  let view = text.replace(/(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi, (all, open, tag, body, close) => body.length > 300 ? open + keep(body, 'S') + close : all);
  view = view.replace(/(\s[\w:-]+\s*=\s*)(["'])([^"']{200,})\2/g, (all, pre, q, v) => pre + q + keep(v, 'A') + q);
  return { view, map };
}
export const expand = (s, map) => String(s).replace(TOKEN, t => map.has(t) ? map.get(t) : t);

/** Part of a condensed view around a phrase (the first place it appears), for files too long to read whole. */
export function around(view, phrase, size = 6000) {
  const i = phrase ? view.toLowerCase().indexOf(String(phrase).toLowerCase()) : -1;
  if (i < 0) return null;
  const from = Math.max(0, view.lastIndexOf('\n', Math.max(0, i - size / 2)) + 1), to = Math.min(view.length, i + size / 2);
  return { from, to, text: view.slice(from, to) };
}

const err = (code, message, extra = {}) => Object.assign(Error(message), { code, ...extra });

/** Applies edits (real text, not tokens) to text. Throws CODE_FIND_* when a "find" is missing, repeated or overlapping. */
export function applyEdits(text, edits) {
  if (!Array.isArray(edits) || !edits.length) throw err('CODE_NO_EDITS', 'No edits.');
  if (edits.length > MAX_EDITS) throw err('CODE_TOO_MANY', `At most ${MAX_EDITS} edits in one change.`);
  const spots = edits.map((e, i) => {
    const find = String(e?.find ?? ''), replace = String(e?.replace ?? '');
    if (!find.trim()) throw err('CODE_FIND_EMPTY', `Edit ${i + 1}: "find" is empty.`);
    const at = text.indexOf(find);
    if (at < 0) throw err('CODE_FIND_MISSING', `Edit ${i + 1}: the "find" text is not in the file (copy it exactly).`, { edit: i });
    if (text.indexOf(find, at + 1) >= 0) throw err('CODE_FIND_REPEATED', `Edit ${i + 1}: the "find" text appears more than once; include more of the surrounding text.`, { edit: i });
    return { at, end: at + find.length, replace };
  }).sort((a, b) => a.at - b.at);
  for (let i = 1; i < spots.length; i++) if (spots[i].at < spots[i - 1].end) throw err('CODE_FIND_OVERLAP', 'Two edits change the same text.');
  let out = text;
  for (const s of spots.slice().reverse()) out = out.slice(0, s.at) + s.replace + out.slice(s.end);
  if (out === text) throw err('NO_CHANGE', 'The file already says this.');
  if (out.length - text.length > MAX_ADDED) throw err('CODE_TOO_LARGE', 'The change adds too much at once.');
  return out;
}

const RISKY = [
  ['script', /<script\b/gi], ['event handler', /\son[a-z]+\s*=/gi], ['javascript: link', /javascript\s*:/gi], ['frame', /<i?frame\b/gi],
  ['embedded object', /<(object|embed|applet)\b/gi], ['<base>', /<base\b/gi], ['<meta refresh>', /<meta[^>]+http-equiv/gi], ['form', /<form\b/gi],
  ['outside style sheet', /<link\b[^>]*rel\s*=\s*["']?stylesheet[^>]*href\s*=\s*["']?(https?:)?\/\//gi], ['outside picture or file', /\s(src|srcset|poster|data)\s*=\s*["']?(https?:)?\/\//gi],
  ['CSS import', /@import\b/gi], ['CSS expression', /expression\s*\(/gi], ['outside CSS file', /url\(\s*["']?(https?:)?\/\//gi],
];
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'use', 'stop']);
function balance(html) {
  const out = new Map(), body = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][\w-]*)[^>]*?(\/?)>/g)) {
    const tag = m[2].toLowerCase(); if (VOID.has(tag) || m[3]) continue;
    out.set(tag, (out.get(tag) || 0) + (m[1] ? -1 : 1));
  }
  return out;
}
/** Throws CODE_UNSAFE / CODE_UNBALANCED when the change adds something it must not. */
export function checkChange(file, before, after) {
  for (const [name, re] of RISKY) {
    const a = (before.match(re) || []).length, b = (after.match(re) || []).length;
    if (b > a) throw err('CODE_UNSAFE', `The change adds a ${name}, which Sitetend does not allow in suggested code.`, { what: name });
  }
  if (/\.html?$/i.test(file)) {
    const x = balance(before), y = balance(after);
    for (const tag of new Set([...x.keys(), ...y.keys()])) if ((x.get(tag) || 0) !== (y.get(tag) || 0)) throw err('CODE_UNBALANCED', `The change opens or closes <${tag}> without the other half.`, { tag });
  }
}

/** The words a change adds (what to highlight in the preview), from the edits' new text. */
export function addedWords(edits) {
  const words = s => String(s).replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').split('\n').map(x => x.replace(/\s+/g, ' ').trim()).filter(x => x.length >= 2);
  const out = [];
  for (const e of edits || []) { const old = new Set(words(e.find)); for (const w of words(e.replace)) if (!old.has(w) && !out.includes(w)) out.push(w); }
  return out.slice(0, 10);
}
