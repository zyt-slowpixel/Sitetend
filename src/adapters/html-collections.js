/**
 * Collections in hand-written HTML: groups of same-shaped blocks under one parent (project cards, a list of jobs, a
 * photo grid, rows of a publications table). A new item is a copy of one block with its words, link and picture
 * replaced, put next to the others, so it takes the site's own markup and styles. Nothing else on the page changes.
 *
 * Kept out on purpose: menus (blocks that are only links to pages), anything in <nav>, <head>, <svg>, <select> or
 * <template>, whole page sections (large blocks), and blocks placed by fixed pixel positions (they are listed with
 * canAdd false: a copy would sit on top of the last one).
 */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'noscript', 'template', 'code', 'pre', 'textarea', 'svg', 'math']);
const SKIP_IN = new Set(['nav', 'head', 'select', 'svg', 'template', 'thead', 'math', 'datalist', 'map', 'picture', 'video', 'audio', 'form', 'button', 'label']);
// What a block can be. Paragraphs, headings, table cells and buttons side by side are text or controls, not items.
const ITEM_TAGS = new Set(['li', 'div', 'article', 'section', 'figure', 'tr', 'a', 'blockquote', 'details', 'aside', 'dl']);
const MAX_GROUPS_PER_FILE = 12;
const AUTO_CLOSE = { li: ['li'], p: ['p'], tr: ['tr'], td: ['td', 'th'], th: ['td', 'th'], option: ['option'], dt: ['dt', 'dd'], dd: ['dt', 'dd'] };
const STATE_CLASS = /^(active|current|selected|show|open|hidden|visible|first|last|odd|even|is-.*|has-.*|aos-.*|animate.*|fade.*|reveal.*|in-view|wow)$/i;
const HEADING = /^h[1-6]$/;
const MAX_ITEM_CHARS = 1500, MAX_ITEM_NODES = 80;

const attr = (attrs, name) => { const m = attrs.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')); return m ? (m[1] ?? m[2] ?? m[3]) : null; };
const classesOf = attrs => (attr(attrs, 'class') || '').split(/\s+/).filter(c => c && !STATE_CLASS.test(c) && !/\{\{|\{%/.test(c));

/** Element tree with offsets: { tag, attrs, start, openEnd, closeStart, end, children, parent }. */
export function parseTree(text) {
  const root = { tag: '#root', attrs: '', start: 0, openEnd: 0, closeStart: text.length, end: text.length, children: [], parent: null };
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/?([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/gi;
  let cur = root, m;
  const close = (node, at, end) => { node.closeStart = at; node.end = end; };
  while ((m = re.exec(text))) {
    const tag = m[1]?.toLowerCase(); if (!tag) continue;
    if (m[0][1] === '/') {
      let n = cur; while (n !== root && n.tag !== tag) n = n.parent;
      if (n === root) continue;                                   // a stray end tag
      for (let x = cur; x !== n; x = x.parent) close(x, m.index, m.index);   // unclosed children end here
      close(n, m.index, re.lastIndex); cur = n.parent; continue;
    }
    for (const k of AUTO_CLOSE[tag] ? [tag] : []) if (AUTO_CLOSE[k].includes(cur.tag)) { close(cur, m.index, m.index); cur = cur.parent; }
    const node = { tag, attrs: m[2] || '', start: m.index, openEnd: re.lastIndex, closeStart: re.lastIndex, end: re.lastIndex, children: [], parent: cur };
    cur.children.push(node);
    if (VOID.has(tag) || /\/>$/.test(m[0])) continue;
    if (RAW.has(tag)) {                                            // its content is not markup: jump to its end tag
      const endRe = new RegExp(`</${tag}\\s*>`, 'ig'); endRe.lastIndex = re.lastIndex; const e = endRe.exec(text);
      if (e) { close(node, e.index, endRe.lastIndex); re.lastIndex = endRe.lastIndex; } else close(node, text.length, text.length);
      continue;
    }
    cur = node;
  }
  for (let x = cur; x !== root; x = x.parent) close(x, text.length, text.length);
  return root;
}

const sig = n => n.tag + (classesOf(n.attrs).sort().map(c => '.' + c).join(''));
function shape(n, out = new Map(), depth = 0) {
  for (const c of n.children) { const k = c.tag + (depth < 2 ? (classesOf(c.attrs)[0] ? '.' + classesOf(c.attrs)[0] : '') : ''); out.set(k, (out.get(k) || 0) + 1); shape(c, out, depth + 1); }
  return out;
}
const similar = (a, b) => { let lo = 0, hi = 0; for (const k of new Set([...a.keys(), ...b.keys()])) { lo += Math.min(a.get(k) || 0, b.get(k) || 0); hi += Math.max(a.get(k) || 0, b.get(k) || 0); } return hi ? lo / hi : 1; };
const count = n => n.children.reduce((s, c) => s + 1 + count(c), 0);
const within = (f, n) => f.start >= n.openEnd && f.end <= n.closeStart;
const inner = (n, f) => { for (const c of n.children) if (f.start >= c.start && f.end <= c.end) return inner(c, f); return n; };
const fixed = (n, text) => { const st = attr(n.attrs, 'style') || ''; return /position\s*:\s*(absolute|fixed)/i.test(st) || /(^|;)\s*(top|left)\s*:\s*-?\d/.test(st); };
const isLocalLink = h => h != null && !/^(https?:|mailto:|tel:|#$)/i.test(h);

/** The slots of one block: its words, links and pictures, named by the element that holds them. */
function slotsOf(item, fields) {
  const out = [], used = new Map();
  const name = (base) => { const n = (used.get(base) || 0) + 1; used.set(base, n); return n > 1 ? `${base}-${n}` : base; };
  const own = fields.filter(f => within(f, item) && !/^page\.title\./.test(f.loc) && !f.svg);
  const imgs = [];
  (function walk(n) { for (const c of n.children) { if (c.tag === 'img' && attr(c.attrs, 'src')) imgs.push(c); walk(c); } })(item);
  const items = [...own.map(f => ({ at: f.start, f })), ...imgs.map(n => ({ at: n.start, img: n }))].sort((a, b) => a.at - b.at);
  for (const x of items) {
    if (x.img) {
      const n = x.img, cls = classesOf(n.attrs)[0], src = attr(n.attrs, 'src'), m = n.attrs.match(/\ssrc\s*=\s*(["'])([^"']*)\1/i);
      if (!m) continue;
      const at = n.start + 1 + n.tag.length + n.attrs.indexOf(m[0]) + m[0].indexOf(m[2]);
      out.push({ name: name('image' + (cls ? '.' + cls : '')), type: 'image', value: src, start: at, end: at + m[2].length, node: n });
      continue;
    }
    const f = x.f, el = inner(item, f);
    let ctl = false; for (let q = el; q && q !== item.parent; q = q.parent) if (q.tag === 'button' || q.tag === 'label' || q.tag === 'option') ctl = true;
    if (ctl) continue;   // a button's or a form's words: part of the page's controls
    if (f.type === 'url' || f.type === 'email') { out.push({ name: name(f.type === 'email' ? 'email' : 'link'), type: f.type, value: f.value, start: f.start, end: f.end, write: f.write, node: el }); continue; }
    const cls = classesOf(el.attrs)[0], tag = el === item ? 'text' : el.tag;
    out.push({ name: name(tag + (cls ? '.' + cls : '')), type: f.value.length > 100 ? 'textarea' : f.type === 'date' ? 'date' : 'text', value: f.value, start: f.start, end: f.end, write: f.write, node: el, heading: HEADING.test(el.tag) || /title|name|heading/i.test(cls || '') });
  }
  return out;
}

/** How much a group looks like a list someone keeps adding to (more entries, a heading, a picture). */
export const groupScore = g => g.items.length * (g.fields.length + (g.fields.some(f => f.type === 'image') ? 2 : 0) + (g.fields.some(f => /^h[1-6]/.test(f.name)) ? 2 : 0));

/** The groups of one HTML file. fields: the file's text fields (see fieldsOf). */
export function htmlGroups(file, text, fields) {
  const root = parseTree(text), out = [];
  (function walk(n, path) {
    if (SKIP_IN.has(n.tag) || RAW.has(n.tag)) return;
    const bySig = new Map();
    for (const c of n.children) { if (SKIP_IN.has(c.tag) || RAW.has(c.tag) || VOID.has(c.tag) || !ITEM_TAGS.has(c.tag)) continue; const k = sig(c); if (!bySig.has(k)) bySig.set(k, []); bySig.get(k).push(c); }
    let g = 0;
    for (const [k, items] of bySig) {
      if (items.length < 2) continue;
      if (items.some(i => i.end - i.start > MAX_ITEM_CHARS * 3 || count(i) > MAX_ITEM_NODES)) continue;   // page sections, not items
      const shapes = items.map(i => shape(i)), slots = items.map(i => slotsOf(i, fields));
      if (shapes.some(s => similar(s, shapes.at(-1)) < 0.5)) continue;
      if (slots.some(s => !s.some(x => x.type !== 'image' && x.type !== 'url' && x.type !== 'email') && !s.some(x => x.type === 'image'))) continue;   // nothing to fill in
      if (items[0].tag !== 'li' && items[0].tag !== 'tr' && slots.every(s => s.length < 2 && !s.some(x => x.type === 'image'))) continue;   // one line each: text, not items (list items are fine)
      const words = slots.map(s => s.filter(x => x.type === 'text' || x.type === 'textarea').reduce((a, x) => a + x.value.length, 0));
      if (words.every(w => w < 3) && !slots.some(s => s.some(x => x.type === 'image'))) continue;
      // a menu: every block is one short link to a page of the site
      const menu = items.every(i => { const a = i.tag === 'a' ? i : i.children.length === 1 && i.children[0].tag === 'a' ? i.children[0] : null; return a && isLocalLink(attr(a.attrs, 'href')) && (text.slice(a.openEnd, a.closeStart).replace(/<[^>]+>/g, '').trim().length < 40); });
      if (menu) continue;
      const id = `html:${file}::${path}>${k}${g++ ? '~' + g : ''}`;
      const names = new Map();
      slots.forEach(s => s.forEach(x => { const e = names.get(x.name) || { name: x.name, type: x.type, n: 0, example: x.value }; e.n++; if (x.type === 'textarea') e.type = 'textarea'; names.set(x.name, e); }));
      // words that are the same in every block ("Read more", "Visit") are copied as they are unless new words are given
      const fixedWords = new Set([...names.values()].filter(e => (e.type === 'text' || e.type === 'textarea') && e.n === items.length && new Set(slots.map(sl => sl.find(x => x.name === e.name)?.value)).size === 1).map(e => e.name));
      const fieldsList = [...names.values()].map(e => ({ name: e.name, label: friendly(e.name), type: e.type, required: e.n === items.length && e.type !== 'image' && !fixedWords.has(e.name), example: String(e.example).slice(0, 60), ...(fixedWords.has(e.name) ? { same: true } : {}) }));
      const titleOf = s => (s.find(x => x.heading) || s.find(x => x.type === 'text' || x.type === 'textarea'))?.name;
      const titleField = titleOf(slots.at(-1)) || fieldsList[0]?.name || null;
      const pinned = items.some(i => fixed(i, text));
      const coll = { id, kind: 'html', file, label: `${file} › ${headingBefore(n, items[0], text) || labelOf(n, k)}`,
        items: items.map((i, x) => ({ key: String(x), title: (slots[x].find(s => s.name === titleField) || slots[x].find(s => s.type === 'text'))?.value || String(x + 1) })),
        fields: fieldsList, titleField, canAdd: !pinned, canReplace: !pinned, ...(pinned ? { why: 'FIXED_LAYOUT' } : {}) };
      Object.defineProperty(coll, 'nodes', { value: items }); Object.defineProperty(coll, '_slots', { value: slots });   // not sent anywhere
      out.push(coll);
    }
    n.children.forEach((c, i) => walk(c, path + '>' + c.tag + (attr(c.attrs, 'id') ? '#' + attr(c.attrs, 'id') : ':' + i)));
  })(root, 'root');
  // a group inside an item of another group is the real list (a timeline's entries, not the timeline boxes)
  const keep = out.filter(g => !g.nodes.some(gn => out.some(h => h !== g && h.nodes.some(hn => hn !== gn && hn.start >= gn.start && hn.end <= gn.end))));
  return keep.sort((a, b) => groupScore(b) - groupScore(a)).slice(0, MAX_GROUPS_PER_FILE);
}
/** The words of the nearest heading above the group, inside its section ("Portfolio", "Experience"). */
function headingBefore(parent, first, text) {
  for (let n = parent, hops = 0; n && n.tag !== '#root' && hops < 4; n = n.parent, hops++) {
    let best = null;
    (function find(x, d) { for (const c of x.children) { if (c.start >= first.start) return; if (/^h[1-4]$/.test(c.tag)) best = c; else if (d < 2 && /^(header|hgroup|div)$/.test(c.tag) && !(first.start >= c.start && first.end <= c.end)) find(c, d + 1); } })(n, 0);   // headings of this section, not of the entries of another list
    if (best) { const w = text.slice(best.openEnd, best.closeStart).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim(); if (w && w.length <= 60) return w; }
  }
  return null;
}
const WORD = { h1: 'Heading', h2: 'Heading', h3: 'Heading', h4: 'Heading', h5: 'Heading', h6: 'Heading', p: 'Text', span: 'Text', div: 'Text', text: 'Text', li: 'Text', time: 'Date', small: 'Small text', em: 'Text', strong: 'Text', b: 'Text', td: 'Cell', th: 'Cell', figcaption: 'Caption', a: 'Link text', blockquote: 'Quote', cite: 'Name', image: 'Picture', link: 'Link', email: 'Email' };
/** A slot name people can read: its class in words ("project-title" → "Project title"), else what kind of element. */
function friendly(name) {
  const m = name.match(/^([a-z0-9]+)(?:\.([\w-]+))?(?:-(\d+))?$/i); if (!m) return name;
  const cls = m[2] && !/^(h\d|mb-\d|mt-\d|text-[a-z]+|col.*|row|d-.*|p-\d|m-\d|fs-\d|fw-.*|small|lead|img-fluid)$/i.test(m[2]) ? m[2].replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim() : null;
  const base = cls ? cls[0].toUpperCase() + cls.slice(1).toLowerCase() : (WORD[m[1].toLowerCase()] || m[1]);
  return m[3] ? `${base} ${m[3]}` : base;
}
function labelOf(parent, k) {
  for (let n = parent; n && n.tag !== '#root'; n = n.parent) { const id = attr(n.attrs, 'id'); if (id) return '#' + id + ' ' + k.split('.')[0]; }
  return k.replace(/\./g, ' .');
}

const encodeAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * A new block for a group, as text, and the file with it in place.
 * values: { slotName: text }; image slots take a site path (kept from the copied block otherwise, with a warning).
 */
export function buildHtmlItem(text, group, { op = 'add', key = null, position = 'end', values = {} }, encodeHtml) {
  const items = group.nodes, slots = group._slots;
  const index = op === 'replace' ? Number(key) : -1;
  const t = op === 'replace' ? index : slots.reduce((b, s, i) => s.length >= slots[b].length ? i : b, 0);
  const item = items[t], base = item.start, missing = [], warnings = [];
  let block = text.slice(item.start, item.end);
  const edits = [];   // [start, end, replacement] relative to the block
  const removeNode = n => { let s = n.start - base; const m = block.slice(0, s).match(/\n[ \t]*$/); if (m) s -= m[0].length; return [s, n.end - base]; };   // with its line
  for (const sl of slots[t]) {
    const v = values[sl.name];
    if (group.fields.find(f => f.name === sl.name)?.same && !(typeof v === 'string' && v.trim())) continue;   // words every block shares: kept
    if (sl.type === 'image') {
      const alt = sl.node.attrs.match(/\salt\s*=\s*(["'])([^"']*)\1/i), title = values[group.titleField];
      if (alt && alt[2].trim() && typeof title === 'string' && title.trim()) { const at = sl.node.start + 1 + sl.node.tag.length + sl.node.attrs.indexOf(alt[0]) + alt[0].indexOf(alt[2]) - base; edits.push([at, at + alt[2].length, encodeAttr(title.trim())]); }   // the copied picture's description named the old item
      if (typeof v === 'string' && v.trim()) edits.push([sl.start - base, sl.end - base, encodeAttr(v.trim())]);
      else warnings.push({ code: 'ASSET_FROM_TEMPLATE', field: sl.name, value: sl.value });
      continue;
    }
    if (sl.type === 'url' || sl.type === 'email') {
      if (typeof v === 'string' && v.trim()) edits.push([sl.start - base, sl.end - base, sl.write(v.trim())]);
      else if (sl.type === 'url') { edits.push([sl.start - base, sl.end - base, '#']); warnings.push({ code: 'LINK_EMPTY', field: sl.name, value: sl.value }); }
      else { const [s, e] = removeNode(sl.node); if (sl.node !== item) edits.push([s, e, '']); }
      continue;
    }
    const val = Array.isArray(v) ? v.join(', ') : v;
    if (typeof val === 'string' && val.trim()) { edits.push([sl.start - base, sl.end - base, sl.write(val.trim())]); continue; }
    const req = group.fields.find(f => f.name === sl.name)?.required;
    const onlyThis = sl.node !== item && text.slice(sl.node.openEnd, sl.node.closeStart).replace(/<[^>]+>/g, '').trim() === text.slice(sl.start, sl.end).trim();
    if (req) missing.push(sl.name);
    if (!req && onlyThis) edits.push([...removeNode(sl.node), '']);   // an optional line this item has no words for
    else edits.push([sl.start - base, sl.end - base, '']);
  }
  // apply from the end; edits inside a removed element are dropped
  edits.sort((a, b) => b[0] - a[0]);
  let lastStart = Infinity;
  for (const [s, e, r] of edits) { if (e > lastStart) continue; block = block.slice(0, s) + r + block.slice(e); lastStart = s; }
  // ids must stay unique on the page: x → x-2 (and links to it inside the block follow)
  const ids = new Set([...text.matchAll(/\sid\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]));
  const renamed = new Map();
  block = block.replace(/(\sid\s*=\s*["'])([^"']+)(["'])/gi, (all, a, id, b) => { let n = 2, nid = `${id}-${n}`; while (ids.has(nid)) nid = `${id}-${++n}`; ids.add(nid); renamed.set(id, nid); return a + nid + b; });
  for (const [o, nw] of renamed) block = block.replace(new RegExp(`((?:href|data-bs-target|data-target)\\s*=\\s*["']#|(?:for|aria-controls|aria-labelledby|aria-describedby)\\s*=\\s*["'])${o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(["'])`, 'g'), `$1${nw}$2`);
  // put it in place, with the same spacing the blocks already have
  const first = items[0], last = items.at(-1);
  let out, at;
  if (op === 'replace') { out = text.slice(0, item.start) + block + text.slice(item.end); at = index; }
  else {
    const gap = items.length > 1 ? text.slice(items.at(-2).end, last.start) : '\n';
    const sep = /^\s*$/.test(gap) ? gap : '\n' + (text.slice(0, last.start).match(/[ \t]*$/)[0]);
    if (position === 'start') { out = text.slice(0, first.start) + block + sep + text.slice(first.start); at = 0; }
    else { out = text.slice(0, last.end) + sep + block + text.slice(last.end); at = items.length; }
  }
  return { text: out, key: String(at), missing, warnings };
}
