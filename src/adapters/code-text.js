/**
 * Words in website projects built with a JavaScript framework (Astro, React / Next.js / Vite, Vue, Svelte).
 *
 * These sites keep their words inside component files, next to code. We read three kinds of text and nothing else:
 *   - text between tags in a template            <h1>Hi, I'm Alex</h1>              loc "text.N"
 *   - a few descriptive attributes                alt="..." title="..." aria-label="..." placeholder="..."   loc "attr.N"
 *   - string values that read like human words    { role: "Product designer" }, ["Design", "Research"]      loc "str.N"
 * Code (imports, class names, keys, ids, paths, single lowercase words) is left alone. An edit replaces exactly the
 * characters of one value, written in that spot's own syntax (entities in templates, the same quote in code).
 * Each extractor returns [{ loc, value, type, start, end, write(newValue) -> replacement text }], like the others.
 */

const guessType = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? 'email' : /^https?:\/\/\S+$/i.test(v) ? 'url' : (v.length > 120 || v.includes('\n')) ? 'textarea' : 'text';
import { decodeEntities } from './entities.js';
const decode = decodeEntities;
const stripTags = s => String(s).replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g, '');
/** Template text: characters that would start a tag or an expression are written as entities. */
const encodeTemplate = v => stripTags(String(v)).trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
/** Same length, so every offset still points into the real text. */
const blank = s => s.replace(/[^\n]/g, ' ');

/** Does this string read like words a visitor sees (not code, a class list, a key or a path)? */
export function humanText(v) {
  const s = String(v).trim().replace(/\s*\n\s*/g, ' ');                                     // a class list split over lines reads as one line
  if (s.length < 2 || !/\p{L}/u.test(s)) return false;
  if (/^\.[a-z0-9]{2,5}$/i.test(s)) return false;                                   // a file extension (".mp4")
  if (/^use (client|server|strict)$/.test(s)) return false;                         // directives
  if (/\{[^}]*:[^}]*;/.test(s) || /^\s*[.#@][\w-]+\s*\{/.test(s)) return false;     // CSS in a string
  if (/^https?:\/\/\S+$/i.test(s)) return true;                                     // links people change (profiles, projects)
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return true;                            // email
  if (/^(\.{0,2}\/|#|@\/|~\/)/.test(s)) return false;                                     // paths, anchors
  if (!/\s/.test(s) && (s.includes('/') || /^[a-z0-9_-]+\.[a-z0-9]+$/.test(s)) && /\.(png|jpe?g|gif|svg|webp|ico|css|scss|js|mjs|ts|tsx|jsx|json|astro|vue|svelte|woff2?|pdf|mp4|html?)$/i.test(s)) return false;   // file names ("Node.js" stays)
  if (/^[\w$.-]+\(|=>|^(const|let|var|function|import|export|return)\s|^use[A-Z]\w*$|^on[A-Z]\w*$|^[\w-]+=\S/.test(s)) return false;   // code, key=value settings
  if (/^[a-z0-9:_\-\/\[\]\.#%!=&>()*]+( [a-z0-9:_\-\/\[\]\.#%!=&>()*]+)*$/.test(s) && /[-:\/\[]/.test(s)) return false;   // class lists: "flex items-center md:px-4 data-[state=active]:text-x"
  if (/\n/.test(String(v)) && /[{}]/.test(s)) return false;                       // a query or code block over several lines (checked before lines were joined)
  if (/^(<{7}|>{7}|={7})/.test(s)) return false;                                      // git merge-conflict markers                                   // GraphQL / code blocks in a string
  if (/^::?[a-z-]+/.test(s) || /^(ASC|DESC)$/.test(s)) return false;                 // CSS selectors, sort orders
  if (!/\s/.test(s) && /^_?[a-z][\w.-]*$/.test(s)) return false;                      // one lowercase word: keys, ids, tags ("blog", "en", "nav.home")
  if (!/\s/.test(s) && /^[A-Z0-9_]+$/.test(s) && s.length > 1 && /_/.test(s)) return false;   // CONSTANT_NAMES
  if (!/\s/.test(s) && /^[A-Z]\w*(Img|Image|Icon|Logo|Svg|Pic|Component|Page|Section|Layout|Provider|Context)$/.test(s)) return false;   // component / asset names
  if (/^#[0-9a-f]{3,8}$/i.test(s) || /^\d+(\.\d+)?(px|rem|em|%|vh|vw|ms|s)?$/.test(s)) return false;   // colours, sizes
  if (/^data:/i.test(s) || /^(\d[a-z]|webgl2?|bitmaprenderer)$/i.test(s)) return false;   // inline files, canvas contexts ("2d")
  if (/^[a-z-]+\s*:\s*[^;]*;/i.test(s) || /;\s*[a-z-]+\s*:\s*$/i.test(s)) return false;     // style text without braces ("display:flex;gap:")
  if (/^(\d{3}\s+)?(italic\s+)?\d+(\.\d+)?px(\/[\d.]+(px)?)?\s+["']?[\w -]+["']?$/i.test(s)) return false;   // a font ("400 16px Inter")
  if (/^[a-z-]+\s+[\d.]+m?s\b/i.test(s) && /\b(ease(-in|-out|-in-out)?|linear|cubic-bezier|steps)\b|^[a-z-]+\s+[\d.]+m?s\s*$/i.test(s)) return false;   // a transition ("opacity .25s ease")
  if (/^\s*<[a-z!\/]/i.test(s) && />\s*$/.test(s)) return false;                   // markup built in a script
  if (/\$\d|\/[gimsuy]+\s*,|['"]\s*\+|\+\s*['"]|\.replace\(/.test(s)) return false;   // pieces of code (regex, string building)
  if (/^\s*[.#@\[][^{]*\{[^}]*\}/.test(s) || /^[.#][\w-]+\[/.test(s)) return false;  // CSS rules and selectors (".a,.b{cursor:pointer}")
  if (/^&#?\w+;$/.test(s) || /^[a-z-]+(,[a-z-]+)+$/.test(s)) return false;            // a lone entity; keyword lists ("no-repeat,repeat-y")
  if (!/\s/.test(s) && s.length >= 60 && /^[\w+\/=,.-]+$/.test(s)) return false;        // encoded data (base64)
  return true;
}

// ---- string literals in code ------------------------------------------------------------------------------------
/**
 * String literals whose place says "value" (after : , [ = ? or return), never import specifiers, object keys,
 * class names or arguments of calls. skip(from, to) tells whether a span is inside a template tag already read.
 */
function stringFields(text, { skip = () => false, base = 0 } = {}) {
  const out = []; let n = 0;
  // comments | a regex literal (it may hold quotes: /(src=")x/g) | "…" '…' | `…` without ${} | `…` with ${}
  const re = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|\/(?![*\/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^\/\\\n\[])+\/[dgimsuyv]*|(["'])((?:\\.|(?!\1)[^\\\n])*)\1|`((?:\\.|[^\\`$]|\$(?!\{))*)`|`(?:\\.|[^\\`])*`/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[0].startsWith('//') || m[0].startsWith('/*')) continue;
    if (m[0][0] === '/') {                                   // a regex only where a value can start; otherwise it was a division sign
      const before = text.slice(Math.max(0, m.index - 12), m.index);
      if (!/(^|[(,=:[!&|?{};+\-*%<>~^]|\breturn|\btypeof|\bcase|\bin|\bof|=>)\s*$/.test(before)) re.lastIndex = m.index + 1;
      continue;
    }
    const quote = m[1] || (m[3] !== undefined ? '`' : null); if (!quote) continue;          // template with ${} : not a plain value
    const raw = m[1] ? m[2] : m[3], at = m.index, end = at + m[0].length;
    if (skip(at, end)) continue;
    const before = text.slice(Math.max(0, at - 40), at), after = text.slice(end, end + 3);
    const prev = before.replace(/\s+$/, '');
    if (/(\bfrom|\bimport|\brequire\s*\(|\bimport\s*\()\s*$/.test(prev)) continue;          // module specifiers
    if (/^\s*:/.test(after) && !/\?\s*$/.test(prev)) continue;                             // object key  { "name": ... }
    if (/\b(className|class|style|id|key|href|src|type|rel|target|role|lang|name|for|variant|size|color|as|slot|client:\w+)\s*=\s*\{?\s*$/.test(prev)) continue;   // attributes in a template
    if (/\b(className|class|classes|style|id|key|src|type|rel|target|lang|variant|size|color|slot|icon|image|img|component|layout|align|theme|mode|method|path|route|locale|slug|format|sizes)\s*:\s*$/.test(prev)) continue;   // code-like keys
    if (!/(^|[:,\[=?(]|=>|\breturn|\b(?:default|case))\s*$/.test(prev) || /[=!<>]=\s*$/.test(prev)) continue;
    if (/\.displayName\s*=\s*$/.test(prev)) continue;                                      // a component's name for dev tools
    if (/[(]\s*$/.test(prev) && /\b(console\.\w+|throw|Error|t|i18n\.t|fetch|require|querySelector\w*|getElement\w*|addEventListener|emit|log)\s*\(\s*$/.test(prev)) continue;
    const value = unescapeJs(raw, quote);
    if (!humanText(value)) continue;
    out.push({ loc: 'str.' + n++, at, label: null, value, type: guessType(value), start: base + at + 1, end: base + end - 1, write: v => escapeJs(String(v), quote) });
  }
  return withLabels(text, out);
}
const withLabels = (text, out) => {
  const labels = keyPaths(text, out.map(f => f.at));
  return out.map(({ at, ...f }) => ({ ...f, label: labels.get(at) ?? null }));
};
function keyPaths(text, positions) {
  const labels = new Map(), stack = [];
  let p = 0;
  const label = at => {
    const keys = [];
    const own = text.slice(Math.max(0, at - 80), at).match(/([A-Za-z_$][\w$]*)["']?\s*(?::|=>)\s*$/);
    if (own) keys.unshift(own[1]);
    for (let j = stack.length - 1; j >= 0 && keys.length < 4; j--) {
      const { c, i, commas } = stack[j];
      if (c === '(') break;
      const before = text.slice(Math.max(0, i - 80), i).match(/([A-Za-z_$][\w$]*)["']?\s*(?:[:=]|=>)\s*$/);
      if (c === '[' && !/^\s*["'][\w-]+["']\s*=>/.test(text.slice(i + 1, i + 80))) keys.unshift(String(commas));
      if (before) keys.unshift(before[1].replace(/^\$/, ''));
    }
    return keys.filter((k, j) => !(j === 0 && /^(siteConfig|config|site|data|default|exports?|props|const)$/i.test(k))).join('.') || null;
  };
  for (let k = 0; k < text.length && p < positions.length; k++) {
    while (p < positions.length && positions[p] <= k) labels.set(positions[p], label(positions[p++]));
    const c = text[k];
    if (c === '/' && text[k + 1] === '/') { while (k < text.length && text[k] !== '\n') k++; continue; }   // comments ("don't" in one is not a quote)
    if (c === '/' && text[k + 1] === '*') { const e = text.indexOf('*/', k + 2); k = e < 0 ? text.length : e + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let e = k + 1; while (e < text.length && !(text[e] === c && text[e - 1] !== '\\') && (c === '`' || text[e] !== '\n')) e++;
      if (c !== '`' && text[e] !== c) continue;          // ' or " cannot cross a line: an apostrophe in text, not a string
      k = e; continue;
    }
    if (c === '{' || c === '[' || c === '(') stack.push({ c, i: k, commas: 0 });
    else if (c === '}' || c === ']' || c === ')') stack.pop();
    else if (c === ',' && stack.length) stack[stack.length - 1].commas++;
  }
  while (p < positions.length) labels.set(positions[p], label(positions[p++]));
  return labels;
}
const unescapeJs = (s, q) => s.replace(/\\(u\{[0-9a-f]+\}|u[0-9a-f]{4}|x[0-9a-f]{2}|.)/gi, (_, e) =>
  e[0] === 'u' ? String.fromCodePoint(parseInt(e.replace(/[u{}]/g, ''), 16)) : e[0] === 'x' ? String.fromCharCode(parseInt(e.slice(1), 16)) : ({ n: '\n', t: '\t', r: '\r' })[e] ?? e);
const escapeJs = (s, q) => s.replace(/\\/g, '\\\\').replace(q === '`' ? /`|\$\{/g : new RegExp(q, 'g'), m => '\\' + m).replace(q === '`' ? /(?!)/ : /\n/g, '\\n').replace(/<(?=[A-Za-z\/!])/g, '\\u003c');   // "<b>" or "</script>" in a string must not read as a tag or end a script

// ---- templates (JSX, Astro, Vue, Svelte) ------------------------------------------------------------------------
const TAG = /<\/?([A-Za-z][\w.:-]*)((?:\s+(?:[^\s"'{}<>=\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|\{(?:[^{}]|\{[^{}]*\})*\}|[^\s"'{}<>=`]+))?|\{(?:[^{}]|\{[^{}]*\})*\}))*)\s*\/?>|<>|<\/>/g;
const ATTRS = /\s(alt|title|aria-label|placeholder|label|description|content|subtitle|caption)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const CODE_TAGS = /^(script|style|code|pre|template|svg|path|math)$/i;

/** Text between tags and a few descriptive attributes; returns the fields and the tag spans (code lives elsewhere). */
function templateFields(text) {
  const out = [], tags = []; let t = 0, a = 0, m, skipTag = null;
  TAG.lastIndex = 0;
  while ((m = TAG.exec(text))) tags.push({ start: m.index, end: TAG.lastIndex, name: (m[1] || '').toLowerCase(), closing: m[0][1] === '/', self: /\/>$/.test(m[0]), attrs: m[2] || '', raw: m[0] });
  for (let i = 0; i < tags.length; i++) {
    const tg = tags[i];
    if (skipTag) { if (tg.closing && tg.name === skipTag) skipTag = null; continue; }
    if (!tg.closing && !tg.self && CODE_TAGS.test(tg.name)) { skipTag = tg.name; continue; }
    // descriptive attributes with a quoted value
    ATTRS.lastIndex = 0; let am;
    while ((am = ATTRS.exec(tg.attrs))) {
      const q = am[2] !== undefined ? '"' : "'", raw = am[2] ?? am[3], value = decode(raw).trim();
      if (!humanText(value)) continue;
      const at = tg.start + tg.raw.indexOf(tg.attrs) + am.index + am[0].indexOf(q) + 1;
      out.push({ loc: 'attr.' + a++, value, type: guessType(value), start: at, end: at + raw.length, write: v => String(v).replace(/&/g, '&amp;').replace(q === '"' ? /"/g : /'/g, q === '"' ? '&quot;' : '&#39;') });
    }
    // text up to the next tag, split around {expressions}
    const next = tags[i + 1]; if (!next) continue;
    const gap = text.slice(tg.end, next.start);
    const plain = gap.replace(/&(#\w+|\w+);/g, '');   // entities are words, not code
    if (!/\p{L}/u.test(gap) || /=>|;\s*$|;\s*\n|^\s*\)|\breturn\b|\bconst\b|\bfunction\b/.test(plain)) continue;
    const parts = []; let depth = 0, from = 0;
    for (let k = 0; k < gap.length; k++) {
      if (gap[k] === '{') { if (depth === 0) parts.push([from, k]); depth++; }
      else if (gap[k] === '}') { depth--; if (depth === 0) from = k + 1; if (depth < 0) { parts.length = 0; break; } }
    }
    if (depth !== 0) continue;
    parts.push([from, gap.length]);
    for (const [s, e] of parts) {
      const raw = gap.slice(s, e); if (!raw.trim()) continue;
      const value = decode(raw).replace(/\s+/g, ' ').trim();
      if (!value || !/\p{L}/u.test(value) || /^[\W\d_]+$/u.test(value) || /\{\{|\{%|\(\)|\?\.|&&|\|\|/.test(raw) || /^(<{7}|>{7}|={7})/.test(value)) continue;
      if (/<\/?[A-Za-z]|=\s*$|="|\w=\s*\{?$/.test(raw)) continue;   // a tag we could not read (deeply nested attributes): code, not words
      const lead = raw.length - raw.trimStart().length, trail = raw.length - raw.trimEnd().length;
      out.push({ loc: 'text.' + t++, value, type: guessType(value), start: tg.end + s + lead, end: tg.end + e - trail, write: encodeTemplate });
    }
  }
  return { fields: out, tags };
}

/** A component file: template text, attributes, and human-looking strings in its code. */
export function componentFields(text, ext) {
  let src = text.replace(/<!--[\s\S]*?-->/g, blank).replace(/<style\b[\s\S]*?<\/style>/gi, blank);
  let code = '', tmpl = src;
  if (ext === 'astro') {                                   // --- front matter (code) --- then the template
    const fm = src.match(/^(\s*---[ \t]*\r?\n)([\s\S]*?)\r?\n---/);
    if (fm) { code = src.slice(0, fm[0].length); tmpl = blank(code) + src.slice(fm[0].length); code = code + blank(src.slice(fm[0].length)); }
  } else if (ext === 'vue' || ext === 'svelte') {          // <script> blocks are code, the rest is template
    code = blank(src); tmpl = src;
    src.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (all, body, at) => { const s = at + all.indexOf(body); code = code.slice(0, s) + body + code.slice(s + body.length); tmpl = tmpl.slice(0, s) + blank(body) + tmpl.slice(s + body.length); return all; });
    if (ext === 'vue') { const m = tmpl.match(/<template\b[^>]*>([\s\S]*)<\/template>/i); if (m) { const s = m.index + m[0].indexOf(m[1]); tmpl = blank(tmpl.slice(0, s)) + m[1] + blank(tmpl.slice(s + m[1].length)); } }
  } else code = src;                                       // jsx / tsx: one file, templates inside the code
  const { fields, tags } = templateFields(tmpl);
  const starts = tags.map(t => t.start).sort((a, b) => a - b), byStart = [...tags].sort((a, b) => a.start - b.start);
  const inTag = (s, e) => {                                // binary search: the last tag starting at or before s
    let lo = 0, hi = starts.length - 1, k = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= s) { k = mid; lo = mid + 1; } else hi = mid - 1; }
    for (let j = k; j >= 0 && j > k - 8; j--) if (e <= byStart[j].end && s >= byStart[j].start) return true;   // a few back, in case spans overlap
    return false;
  };
  const strs = code ? stringFields(code, { skip: inTag }) : [];
  return [...fields, ...strs];
}

/** Plain code / data files (.js .ts .mjs): human-looking string values only. */
export const scriptFields = text => stringFields(text);

/** JSON data: string values that read like words (keys and code-like values are left alone). */
export function jsonFields(text) {
  const out = []; let n = 0, m;
  const re = /"((?:\\.|[^"\\])*)"(\s*:)?/g;
  while ((m = re.exec(text))) {
    if (m[2]) continue;                                    // a key
    const value = unescapeJs(m[1], '"'); if (!humanText(value)) continue;
    out.push({ loc: 'str.' + n++, at: m.index, label: null, value, type: guessType(value), start: m.index + 1, end: m.index + 1 + m[1].length, write: v => JSON.stringify(String(v)).slice(1, -1) });
  }
  return withLabels(text, out);
}

/** MDX: Markdown with import/export lines and components; those lines are hidden from the Markdown reader. */
export const mdxSource = text => text.replace(/^(import|export)\b[^\n]*$/gm, blank).replace(/^<[A-Z][\s\S]*?\/>\s*$/gm, blank);

/** Python (Flask / Django views, data modules): human-looking strings; comments and docstrings are notes, not page text. */
export function pythonFields(text) {
  let src = text.replace(/("""|\'\'\')[\s\S]*?\1/g, blank);                      // docstrings and long strings
  src = src.split('\n').map(line => {                                            // # comments (a # outside quotes)
    let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; }
      else if (c === '"' || c === "'") q = c;
      else if (c === '#') return line.slice(0, i) + blank(line.slice(i));
    }
    return line;
  }).join('\n');
  src = src.replace(/\b[fF][rR]?(["'])(?:\\.|(?!\1).)*\1/g, blank);                 // f-strings: words mixed with code
  return stringFields(src);
}
/** PHP: the page is HTML; inside <?php ?> only human-looking strings (arrays of projects, echo "…"). */
export function phpCodeFields(text) {
  let code = blank(text);
  text.replace(/<\?(?:php|=)?([\s\S]*?)(?:\?>|$)/g, (all, body, at) => { const s = at + all.indexOf(body); code = code.slice(0, s) + body.replace(/(^|\s)#[^\n]*/g, m => blank(m)) + code.slice(s + body.length); return all; });
  return stringFields(code);
}
/** A plain HTML page: the strings in its own <script> blocks too (a page written by a chat assistant often keeps its projects in a script). */
export function inlineScriptFields(text) {
  let code = blank(text), any = false;
  text.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (all, attrs, body, at) => {
    if (/\bsrc\s*=/.test(attrs) || /type\s*=\s*["']?(?!text\/javascript|module|application\/(ld\+)?json)[\w/+-]+/i.test(attrs) || !body.trim()) return all;
    const s = at + all.indexOf(body); code = code.slice(0, s) + body + code.slice(s + body.length); any = true; return all;
  });
  return any ? stringFields(code) : [];
}
