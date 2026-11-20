/**
 * Site Adapter: text-files
 *
 * For websites whose words live in ordinary text files instead of one content.json:
 *   - static HTML sites            (index.html, about.html, ...)
 *   - Jekyll sites                  (_config.yml, _data/*.yml, Markdown pages with YAML front matter)
 *   - Hugo sites                    (hugo.toml / config.toml, content/**.md with YAML or TOML front matter)
 *
 * The whole site is held as ONE content object { schemaVersion, siteAdapter, mode, files: { relPath: text } } so the
 * rest of Sitetend (undo/redo, three-way merge, history, snapshots) works unchanged. Fields are found by reading the
 * text; an edit replaces exactly the characters of that one value, so comments, spacing, quoting and markup survive.
 *
 * Field paths look like "<file>::<locator>", e.g.
 *   "_config.yml::author.email"   "about.md::fm.title"   "about.md::body.p2"   "index.html::about.p.0"
 * Nothing here knows any particular website.
 */
import { SUPPORTED_SCHEMA_VERSION, ERROR_CODES, createOk, createErr } from '../contracts.js';
import { componentFields, scriptFields, jsonFields, mdxSource, pythonFields, phpCodeFields, inlineScriptFields } from './code-text.js';
import { TITLE_KEYS, ASSET_KEY, slugify, pickTitleField, cleanValues, insertAt, short, today, isoDate } from './collections.js';
import { htmlGroups, buildHtmlItem, groupScore } from './html-collections.js';
import { decodeEntities } from './entities.js';

const FILE = 'file:';   // structural path: one whole file, e.g. "file:_data/people.yml" (used when items are added/removed)

export const TEXT_SITE_ADAPTER_ID = 'text-files';
const MAX_FILES = 1000, MAX_BYTES = 2 * 1024 * 1024;   // text per page; pictures written into the page do not count
// Pictures and fonts written into a page (data: URLs) are not text and do not count toward the size limit.
const textSize = s => s.length > MAX_BYTES ? s.replace(/data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+/g, '').length : s.length;
const SKIP_DIRS = /(^|\/)(_layouts|_includes|_sass|layouts|themes|assets|static|node_modules|vendor|\.git|\.github|\.sitetend|resources|public|_site|scripts|css|js|fonts|images|img|files|archetypes|i18n|markdown_generator|talkmap)(\/|$)/;

/** Which files hold the words, per kind of site. Paths are relative to website/. */
/** exclude: generated files, or whole output folders written as "public/". */
const excluded = (p, exclude) => Boolean(exclude?.size) && (exclude.has(p) || [...exclude].some(e => e.endsWith('/') && p.startsWith(e)));
export function contentFilesFor(mode, paths, exclude = null) {
  const ok = p => !excluded(p, exclude) && !SKIP_DIRS.test(p) && !/(^|\/)(README|LICENSE|CHANGELOG|HISTORY|CODE_OF_CONDUCT|CONTRIBUTING|AGENTS|SECURITY)(\.|$)/i.test(p);
  let pick;
  if (mode === 'quarto') { const out = quartoOutputDirs(paths); return paths.filter(p => !excluded(p, exclude) && !out.some(d => p.startsWith(d)) && !QUARTO_SKIP.test(p) && (/^_quarto\.ya?ml$/.test(p) || /\.(qmd|md|markdown)$/i.test(p) || /\.ya?ml$/i.test(p) && !/(^|\/)_(quarto|metadata|extension)[\w-]*\.ya?ml$/.test(p))).sort(); }
  if (mode === 'server') return paths.filter(p => !excluded(p, exclude) && SERVER_FILE.test(p) && !SERVER_SKIP.test(p) && (!/\.py$/.test(p) || PY_SERVER.test(p) || /(^|\/)(app|portfolio|site|website)\/[^/]+\.py$/.test(p) && !/(^|\/)(config|settings|utilities|utils|helpers|models|forms|extensions|tests?)\.py$/.test(p))).sort();
  if (mode === 'generic') return paths.filter(p => !excluded(p, exclude) && GENERIC_FILE.test(p) && !GENERIC_SKIP.test(p)).sort();
  if (mode === 'readme') return paths.filter(p => /^README\.md$/i.test(p));
  if (mode === 'hexo') pick = p => /^_config\.ya?ml$/.test(p) || /^source\/_data\/[^/]+\.ya?ml$/.test(p) || /^source\/.+\.(md|markdown)$/i.test(p);
  else if (mode === 'eleventy') return paths.filter(p => !excluded(p, exclude) && ELEVENTY_FILE.test(p) && !ELEVENTY_SKIP.test(p) && !/(^|\/)(README|LICENSE|CHANGELOG|CODE_OF_CONDUCT|CONTRIBUTING|SECURITY)(\.|$)/i.test(p)).sort();
  else if (mode === 'jekyll') pick = p => /^_config\.ya?ml$/.test(p) || /^_data\/[^/]+\.ya?ml$/.test(p) || /\.(md|markdown)$/i.test(p);
  else if (mode === 'app') return paths.filter(p => !excluded(p, exclude) && APP_FILE.test(p) && !APP_SKIP.test(p) && !/(^|\/)(README|LICENSE|CHANGELOG)(\.|$)/i.test(p)).sort();
  else if (mode === 'hugo') pick = p => /^(hugo|config)\.(toml|ya?ml)$/.test(p) || /^config\/_default\/[^/]+\.(toml|ya?ml)$/.test(p) || /^data\/[^/]+\.(toml|ya?ml)$/.test(p) || /^content(\.[\w-]+)?\/.+\.(md|markdown)$/i.test(p);
  else pick = p => /\.html?$/i.test(p);
  return paths.filter(p => ok(p) && pick(p)).sort();
}

// Website projects built with a JavaScript framework: a framework config file, or components under src/ app/ pages/.
const APP_CONFIG = /^(astro|next|vite|svelte|nuxt|remix|gatsby-config|vue)\.config\.(m?[jt]s|cjs)$|^gatsby-config\.[jt]s$/;
export const isAppProject = paths => paths.includes('angular.json') || paths.includes('package.json') && (paths.some(p => /^(client|frontend|web)\/src\/.+\.(jsx|tsx|vue|svelte)$/.test(p)) || paths.some(p => APP_CONFIG.test(p)) || paths.some(p => /^(src|app|pages|components)\/.+\.(astro|jsx|tsx|vue|svelte)$/.test(p))
  || paths.some(p => /^src\/(App|main|index)\.(js|ts)$/.test(p))                                       // Create React App keeps JSX in .js
  || (paths.some(p => /^(src|app|pages|components)\/.+\.(js|ts|mjs)$/.test(p)) && !paths.some(p => /^[^/]+\.html?$/i.test(p))));   // code under src/, no pages at the top
const APP_FILE = /^((client|frontend|web)\/)?(index\.html$|(src|app|pages|components|content|data|lib|config|constants|locales|messages)\/.+\.(astro|jsx|tsx|vue|svelte|md|mdx|markdown|json|ya?ml|js|mjs|ts)$)|\.component\.html$|^site\.config\.[jt]s$|^gatsby-config\.[jt]s$/;
const APP_SKIP = /(^|\/)(node_modules|dist|build|out|\.next|\.astro|\.svelte-kit|\.nuxt|\.output|\.vercel|coverage|__tests__|tests?|api|hooks|utils?|styles?|types?|assets|public|icons?|fonts|server|migrations)(\/|$)|(^|\/)components\/ui(\/|$)|\.(test|spec|stories|d)\.[jt]sx?$|(^|\/)(env|vite-env)\.d\.ts$|\.(config|setup)\.[jt]s$|(^|\/)(utils?|helpers?)\.[jt]sx?$/;

// Hexo: Jekyll-like _config.yml, with posts and pages under source/ (scaffolds/ holds empty templates for new posts).
const isHexo = paths => paths.some(p => /^_config\.ya?ml$/.test(p)) && paths.some(p => /^scaffolds\/|^source\/_posts\//.test(p));
// Eleventy (11ty): Markdown and Nunjucks/Liquid templates anywhere, data in _data/; _includes/ holds the header and footer.
export const ELEVENTY_CONFIG = /^(\.eleventy|eleventy\.config)\.(c|m)?js$/;
const ELEVENTY_FILE = /\.(md|markdown|njk|liquid|html)$|(^|\/)_data\/[^/]+\.(json|ya?ml|js|cjs|mjs)$/i;
const ELEVENTY_SKIP = /(^|\/)(node_modules|_site|\.git|\.github|\.sitetend|css|js|fonts|img|images|public|dist|feed)(\/|$)|\.(xml|json|txt|css|js|svg|webmanifest)\.(njk|liquid)$|(^|\/)(htaccess|robots|sitemap)\.(njk|liquid)$/i;

/** Guesses the kind of text site from the files under website/ (relative paths). */
export function detectTextMode(paths) {
  if (paths.some(p => /^_quarto\.ya?ml$/.test(p))) return 'quarto';
  if (paths.some(p => ELEVENTY_CONFIG.test(p))) return 'eleventy';
  if (isHexo(paths)) return 'hexo';
  if (paths.some(p => /^_config\.ya?ml$/.test(p))) return 'jekyll';
  if (paths.some(p => /^(hugo|config)\.(toml|ya?ml)$/.test(p) || /^config\/_default\//.test(p))) return 'hugo';
  if (isAppProject(paths)) return 'app';
  if (isServerProject(paths)) return 'server';
  if (paths.some(p => /\.html?$/i.test(p))) return 'html';
  if (isReadmeOnly(paths)) return 'readme';
  if (contentFilesFor('generic', paths).length) return 'generic';   // a kind of site we have not met: read every file that can hold words
  return null;
}
// Any other website project: words are read from every file type we can parse; dependencies, build output,
// media, tests and tool settings are skipped. The preview is the list of the site's words.
const GENERIC_FILE = /\.(html?|php|md|markdown|mdx|qmd|njk|liquid|ejs|erb|hbs|handlebars|mustache|twig|jinja2?|j2|astro|jsx|tsx|vue|svelte|js|mjs|ts|py|json|ya?ml|toml)$/i;
const GENERIC_SKIP = /(^|\/)(node_modules|bower_components|vendor|venv|\.venv|env|__pycache__|site-packages|dist|build|out|_site|public\/build|\.next|\.nuxt|\.output|\.svelte-kit|\.astro|\.vercel|\.netlify|\.cache|\.turbo|coverage|tests?|__tests__|e2e|cypress|migrations|\.git|\.github|\.vscode|\.idea|\.sitetend|\.husky|css|scss|fonts|img|images|icons|media|videos|components\/ui|hooks|utils?|types?)(\/|$)|(^|\/)(package(-lock)?|composer(\.lock)?|tsconfig[\w.-]*|jsconfig|components|vercel|netlify|firebase|manifest|site\.webmanifest|renovate|\.?eslintrc[\w.]*|\.?prettierrc[\w.]*|\.?babelrc|pnpm-lock|yarn\.lock|bun\.lock|deno\.lock|\.?stylelintrc[\w.]*)\.(json|ya?ml|toml|lock|js|cjs)$|\.(config|setup|test|spec|stories|d|min)\.[\w]+$|(^|\/)(README|LICENSE|CHANGELOG|HISTORY|CODE_OF_CONDUCT|CONTRIBUTING|SECURITY|AGENTS|CLAUDE)(\.|$)|(^|\/)(docker-compose|\.?gitlab-ci|\.?travis|Procfile|pyproject|Pipfile|requirements)\b/i;
// Quarto: pages are .qmd / .md, settings in _quarto.yml, lists (publications, people, projects) in .yml next to them.
// The rendered site (_site/, or docs/ for GitHub Pages) has site_libs/ and search.json: never content.
const QUARTO_SKIP = /(^|\/)(_site|_freeze|_extensions|\.quarto|site_libs|node_modules|renv|\.github|\.sitetend|images|img|files|assets|css|js)(\/|$)|(^|\/)(README|LICENSE|CHANGELOG|CODE_OF_CONDUCT|CONTRIBUTING)(\.|$)/i;
function quartoOutputDirs(paths) {
  const dirs = new Set();
  for (const p of paths) { const m = p.match(/^(.*?)(?:^|\/)(site_libs\/|search\.json$)/); if (m && m[1]) dirs.add(m[1].replace(/\/$/, '') + '/'); }
  return [...dirs];
}
// A site made by a small web server: Flask / Django (Python with Jinja templates/) or PHP pages.
// The words are in the templates, in the Python that fills them, and in data files next to them.
const PY_SERVER = /^(app|main|wsgi|server|manage|run)\.py$|(^|\/)(views|routes|data|content)\.py$/;
export const isServerProject = paths => paths.some(p => /^[^/]+\.php$/i.test(p)) || paths.some(p => /(^|\/)(views|templates|layouts|partials)\/.+\.(ejs|erb|hbs|handlebars|mustache|twig|jinja2?|j2)$/i.test(p)) || paths.some(p => /(^|\/)templates\/.+\.html?$/i.test(p)) && paths.some(p => /(^|\/)(requirements\.txt|pyproject\.toml|Pipfile|manage\.py|app\.py|main\.py)$/.test(p));
const SERVER_SKIP = /(^|\/)(node_modules|vendor|venv|\.venv|env|__pycache__|site-packages|migrations|tests?|\.git|\.github|\.sitetend|\.vscode|css|fonts|img|images|instance|build|dist)(\/|$)|(^|\/)(README|LICENSE|CHANGELOG|CONTRIBUTING|requirements)(\.|$)|(^|\/)(package(-lock)?|composer(\.lock)?|tsconfig)\.json$/i;
const SERVER_FILE = /(^|\/)templates\/.+\.html?$|\.(php|py|ejs|erb|hbs|handlebars|mustache|twig|jinja2?|j2)$|(^|\/)(static|data|content)\/.+\.(json|ya?ml|md)$|^[^/]+\.(json|ya?ml|md)$|\.html?$/i;

// A GitHub profile (the username/username repository): the README is the whole page.
const README_ONLY_OK = /^(README\.md|LICENSE(\.\w+)?|\.gitignore|\.github\/.*|\.sitetend\/.*|[^/]+\.(png|jpe?g|gif|svg|webp)|(assets|images|img|media)\/.*)$/i;
export const isReadmeOnly = paths => paths.some(p => /^README\.md$/i.test(p)) && paths.every(p => README_ONLY_OK.test(p));

// ---------------------------------------------------------------------------------------------- small helpers
/** Settings that steer the build, not words a visitor reads. Generic names used across static-site generators. */
const TECH_KEY = /(^|\.)(fm\.)?(layout|permalink|url|baseurl|base_url|baseURL|theme|site_theme|locale|languageCode|defaultContentLanguage|lang|collection|redirect_from|aliases|type|slug|weight|draft|date|lastmod|publishDate|expiryDate|id|image|images|avatar|avatarURL|logo|favicon|icon|icons|class|classes|css|js|style|layout_.*|sidebar|toc|toc_.*|comments|share|related|read_time|author_profile|markup|highlight|paginate|pagerSize|output|outputs|format|encoding|timezone|plugins|exclude|include|kramdown|sass|defaults|repository|analytics|google_.*|disqus.*|shortname|github_username|twitter_username|markdown|highlighter|date_format|input|identifier|contentTypeName|weight|language|\w+_dir|new_post_name|default_layout|default_category|time_format|updated_option|order_by|field|per_page|filename_case|render_drafts|post_asset_folder|relative_link|future|syntax_highlighter|skip_render|titlecase|meta_generator|permalink_defaults|eleventyExcludeFromCollections|templateClass|pagination\.\w+|eleventyNavigation\.(order|parent)|eleventyComputed\.\w+|theme\.[\w-]+|project(\.[\w-]+)*|output-dir|image-[\w-]+|target|editor|draft-mode|grid-item-align|field-display-names\.\w+|grid-columns|execute|freeze|engine|jupyter|knitr|page-layout|title-block-banner|listing(\.[\w-]+)*|template|toc-.*|code-.*|number-sections|bibliography|csl|filters|search|site-url|repo-url|repo-actions|favicon|open-graph|twitter-card|pinned|align|background|collapse-below|tools\.\d+\.icon|links\.\d+\.icon|href|path|feed|sort|fields|format(\.[\w-]+)*|search(\.[\w-]+)*|max-items|image-height|image-placeholder|date-format|reading-time|src|srcset|icon|color|variant|size|orientation|trailingIcon|leadingIcon)$/i;   // last lines: Hexo, Eleventy and Quarto settings
const TECH_VALUE = v => /^(\/|\.\/|#)|\.(png|jpe?g|gif|svg|webp|ico|css|js|pdf|xml|json)$/i.test(v) || /^[\w./-]+\.(md|markdown|html?|ya?ml|toml|php|py|ts|tsx|jsx)$/i.test(v) || /^\d{4}-\d{2}-\d{2}([T ][\d:.+Z-]*)?$/.test(v);
const humanize = s => String(s).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ');
const guessType = (v, long) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? 'email' : /^https?:\/\/\S+$/i.test(v) ? 'url' : (long || v.length > 120 || v.includes('\n')) ? 'textarea' : 'text';
const decode = decodeEntities;
const encodeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
const stripTags = s => String(s).replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g, '');

// Each extractor returns [{ loc, value, type, start, end, write(newValue) -> replacement text, tags? }]
// start/end are character offsets of the replaceable span inside the file text.

// ---- YAML (line based: scalars, lists of scalars, lists of mappings; comments, anchors and quoting are preserved)
function yamlFields(text, base = 0, prefix = '') {
  const out = [], stack = [], counters = new Map();
  const lines = text.split('\n'); let off = 0, inBlock = -1;
  for (const line of lines) {
    const lineStart = off; off += line.length + 1;
    if (inBlock >= 0) { if (!line.trim() || line.search(/\S/) > inBlock) continue; inBlock = -1; }
    if (!line.trim() || /^\s*#/.test(line) || /^\s*---\s*$/.test(line)) continue;
    let indent = line.search(/\S/), rest = line.slice(indent), restOff = lineStart + indent, item = null;
    const dash = rest.match(/^-\s+/);
    if (dash || rest === '-') {
      while (stack.length && stack.at(-1).indent >= indent) stack.pop();
      const parent = stack.map(x => x.key).join('.');
      const ck = parent + '@' + indent; const n = counters.has(ck) ? counters.get(ck) + 1 : 0; counters.set(ck, n);
      item = { indent, key: String(n) }; stack.push(item);
      if (!dash) continue;
      rest = rest.slice(dash[0].length); restOff += dash[0].length; indent += dash[0].length;
      const kv = rest.match(/^([A-Za-z0-9_][\w\-]*)\s*:(\s|$)/);
      if (!kv) { const f = scalar(rest, restOff); if (f) out.push({ loc: prefix + stack.map(x => x.key).join('.'), ...f }); continue; }
    }
    const kv = rest.match(/^([A-Za-z0-9_][\w\-]*)(\s*):(\s*)(.*)$/);
    if (!kv) continue;
    while (stack.length && stack.at(-1).indent >= indent && stack.at(-1) !== item) stack.pop();
    const [, key, , sp, valRaw] = kv;
    const path = [...stack.map(x => x.key), key].join('.');
    const valOff = restOff + key.length + kv[2].length + 1 + sp.length;
    if (!valRaw || valRaw.startsWith('#') || /^&[\w-]+\s*(#.*)?$/.test(valRaw)) { stack.push({ indent, key }); continue; }
    if (/^[|>][+-]?\s*(#.*)?$/.test(valRaw)) { inBlock = indent; continue; }        // block scalars: left alone
    const f = scalar(valRaw, valOff);
    if (f) out.push({ loc: prefix + path, ...f });
  }
  return out;
  function scalar(raw, at) {
    let s = raw, pos = at;
    const anchor = s.match(/^&[\w-]+\s+/); if (anchor) { s = s.slice(anchor[0].length); pos += anchor[0].length; }
    if (/^[*\[{!]/.test(s)) return null;                                        // aliases, flow collections, tags
    let value, len, style;
    if (s[0] === '"') { const m = s.match(/^"((?:[^"\\]|\\.)*)"/); if (!m) return null; value = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'); len = m[0].length; style = '"'; }
    else if (s[0] === "'") { const m = s.match(/^'((?:[^']|'')*)'/); if (!m) return null; value = m[1].replace(/''/g, "'"); len = m[0].length; style = "'"; }
    else { const m = s.match(/^(.*?)(\s+#.*)?$/); value = m[1].trim(); len = m[1].replace(/\s+$/, '').length; style = ''; }
    if (!value || /^(true|false|yes|no|null|~|-?\d+(\.\d+)?)$/i.test(value)) return null;
    if (style === '' && /^\d{4}-\d{2}-\d{2}/.test(value)) return null;           // dates are data, not words
    return { value, type: guessType(value), start: base + pos, end: base + pos + len,
      write: v => style === "'" ? `'${String(v).replace(/'/g, "''")}'` : (style === '"' || /[:#]\s|^[\s'"&*!|>%@`\[{-]|\s$/.test(v) || /^(true|false|yes|no|null|~|-?\d+(\.\d+)?)$/i.test(v)) ? JSON.stringify(String(v)) : String(v) };
  }
}

// ---- TOML (line based: [tables], [[arrays]], key = "string" / 'string' / ["a", "b"])
function tomlFields(text, base = 0, prefix = '') {
  const out = [], counters = new Map(); let table = '', off = 0, inMulti = false;
  for (const line of text.split('\n')) {
    const ls = off; off += line.length + 1;
    if (inMulti) { if (/("""|''')\s*$/.test(line)) inMulti = false; continue; }
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    let m;
    if ((m = t.match(/^\[\[\s*([\w.\-]+)\s*\]\]/))) { const n = (counters.get(m[1]) ?? -1) + 1; counters.set(m[1], n); table = m[1] + '.' + n; continue; }
    if ((m = t.match(/^\[\s*([\w.\-]+)\s*\]/))) { table = m[1]; continue; }
    m = line.match(/^(\s*)([\w\-]+)(\s*=\s*)(.*)$/); if (!m) continue;
    const [, ind, key, eq, raw] = m; const at = ls + ind.length + key.length + eq.length;
    const path = prefix + (table ? table + '.' : '') + key;
    if (/^("""|''')/.test(raw)) { if (!/^("""|''').*\1\s*$/.test(raw.slice(3)) ) inMulti = true; continue; }
    const str = raw.match(/^"((?:[^"\\]|\\.)*)"/) || raw.match(/^'([^']*)'/);
    if (str) {
      const value = raw[0] === '"' ? str[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : str[1];
      if (!value) continue;
      out.push({ loc: path, value, type: guessType(value), start: base + at, end: base + at + str[0].length, write: v => JSON.stringify(String(v)) });
    } else if (/^\[\s*("|')/.test(raw)) {
      const arr = raw.match(/^\[(.*)\]/); if (!arr) continue;
      const items = [...arr[1].matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map(x => x[1] ?? x[2]);
      if (!items.length) continue;
      out.push({ loc: path, value: items, type: 'tags', start: base + at, end: base + at + arr[0].length, write: v => '[' + v.map(x => JSON.stringify(String(x))).join(', ') + ']' });
    }
  }
  return out;
}

// ---- Markdown: front matter (YAML --- or TOML +++) + body blocks (headings, paragraphs, list items)
// A paragraph that is only images (or linked images): nothing to reword.
// A fenced code block ends only at a fence of the same character that is at least as long as the opening one, so a
// ````markdown block can show a ``` example inside it (CommonMark). step(line) is true for a fence line.
const fenceTracker = () => { let open = null; return {
  get open() { return Boolean(open); },
  step(line) {
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/); if (!m) return false;
    if (!open) { if (m[1][0] === '`' && m[2].includes('`')) return false; open = { ch: m[1][0], len: m[1].length }; return true; }
    if (m[1][0] === open.ch && m[1].length >= open.len && !m[2].trim()) { open = null; return true; }
    return false;                                                     // a shorter or different fence inside the block: code
  } }; };
const onlyImages = v => !v.replace(/!\[[^\]]*\]\([^)]*\)(\{[^}]*\})?/g, '').replace(/\]\([^)]*\)/g, '').replace(/[\[\]\s]/g, '') && /!\[/.test(v);
function markdownFields(text) {
  const out = [];
  let body = 0;
  const fm = text.match(/^(---|\+\+\+)[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*(\r?\n|$)/);
  if (fm) {
    const inner = text.indexOf('\n') + 1;
    out.push(...(fm[1] === '---' ? yamlFields(fm[2], inner, 'fm.') : tomlFields(fm[2], inner, 'fm.')));
    body = fm[0].length;
  }
  const counts = { h: 0, p: 0, li: 0 };
  text = text.slice(0, body) + blankRe(text.slice(body), /<!--[\s\S]*?-->/g);       // HTML comments are notes, not page text
  const lines = text.slice(body).split('\n'); let off = body, para = null; const fence = fenceTracker();
  const flush = () => {
    if (!para) return;
    const raw = text.slice(para.start, para.end), value = raw.replace(/\s*\n\s*/g, ' ').trim();
    if (value && !/^[<{]/.test(value) && onlyImages(value) === false) out.push({ loc: 'body.p' + counts.p++, value, type: guessType(value, true), start: para.start, end: para.end, write: v => String(v) });
    para = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], ls = off; off += line.length + 1;
    if (fence.step(line)) { flush(); continue; }
    if (fence.open) continue;
    if (!line.trim()) { flush(); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); continue; }                                  // a rule (---), not words
    if (/^\s*(<|\{[%{]|\||:::)/.test(line) || /^\s{4,}\S/.test(line) && !para) { flush(); continue; }   // HTML, Liquid/shortcodes, tables, Quarto ::: blocks, code
    let m;
    if ((m = line.match(/^(#{1,6}[ \t]+)(.*?)(\s+#+\s*)?$/))) {
      flush(); const s = ls + m[0].length - m[2].length, value = m[2].trim();   // after the marker and any task box "[x] "
      if (value) out.push({ loc: 'body.h' + counts.h++, value, type: 'text', start: s, end: s + m[2].length, write: v => String(v).replace(/\n/g, ' ') });
      continue;
    }
    if (para && /^(=+|-+)\s*$/.test(line)) {                                       // setext heading
      const value = text.slice(para.start, para.end).trim();
      out.push({ loc: 'body.h' + counts.h++, value, type: 'text', start: para.start, end: para.end, write: v => String(v).replace(/\n/g, ' ') });
      para = null; continue;
    }
    if ((m = line.match(/^(\s*(?:[-*+]|\d+[.)])[ \t]+)(?:\[[ xX]\][ \t]+)?(.*)$/))) {
      flush(); const s = ls + m[0].length - m[2].length, value = m[2].trim();   // after the marker and any task box "[x] "
      if (value && !/^[<{]/.test(value)) out.push({ loc: 'body.li' + counts.li++, value, type: guessType(value), start: s, end: s + m[2].trimEnd().length, write: v => String(v).replace(/\n/g, ' ') });
      continue;
    }
    if (!para) para = { start: ls + line.search(/\S/), end: ls + line.length };
    else para.end = ls + line.length;
  }
  flush();
  return out;
}

// ---- HTML: every visible text run, plus mailto:/http links. Located by the nearest element id ("scope").
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'noscript', 'template', 'code', 'pre', 'textarea']);
// Inside an <svg>, only the words of <text> / <tspan> are text (a heading drawn as SVG text, a label in a diagram); shapes have none.
const SVG_TEXT = new Set(['text', 'tspan', 'textpath']);
function htmlFields(text) {
  const out = [], stack = [], counters = new Map();
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/?([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/gi;
  let last = 0, m, skipUntil = null;
  const scope = () => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].id) return stack[i].id; return 'page'; };
  const inHead = () => stack.some(x => x.tag === 'head') && !stack.some(x => x.tag === 'title');
  const next = (s, tag) => { const k = s + '.' + tag; const n = counters.has(k) ? counters.get(k) + 1 : 0; counters.set(k, n); return n; };
  const text_ = (from, to) => {
    if (skipUntil || inHead()) return;
    const inSvg = stack.some(x => x.tag === 'svg');
    if (inSvg && !SVG_TEXT.has(stack.at(-1)?.tag)) return;
    const raw = text.slice(from, to); if (!raw.trim()) return;
    const value = decode(raw).replace(/\s+/g, ' ').trim();
    if (!value || /^[\W\d_]+$/.test(value) || /\{\{|\{%/.test(raw)) return;          // icons/punctuation only, templates
    const lead = raw.length - raw.trimStart().length, trail = raw.length - raw.trimEnd().length;
    const parent = stack.at(-1)?.tag || 'body', s = scope();
    out.push({ loc: `${s}.${parent}.${next(s, parent)}`, value, type: guessType(value), start: from + lead, end: to - trail, write: v => encodeHtml(stripTags(v)), ...(inSvg ? { svg: true } : {}) });
  };
  while ((m = re.exec(text))) {
    text_(last, m.index); last = re.lastIndex;
    const tag = m[1]?.toLowerCase(); if (!tag) continue;
    const closing = m[0][1] === '/';
    if (skipUntil) { if (closing && tag === skipUntil) skipUntil = null; continue; }
    if (closing) { const i = stack.map(x => x.tag).lastIndexOf(tag); if (i >= 0) stack.length = i; continue; }
    const attrs = m[2] || '';
    const id = attrs.match(/\sid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i); const idv = id && (id[1] || id[2] || id[3]);
    if (tag === 'a') {
      const h = attrs.match(/\shref\s*=\s*(")((?:mailto:|https?:)[^"]*)"/i);
      if (h) {
        const at = m.index + 1 + m[1].length + attrs.indexOf(h[0]) + h[0].indexOf(h[2]); const s = scope();   // '<' + tag name, then the attributes
        const isMail = h[2].toLowerCase().startsWith('mailto:'); const value = isMail ? h[2].slice(7) : h[2];
        if (!/\{\{/.test(value)) out.push({ loc: `${s}.link.${next(s, 'link')}`, value: decode(value), type: isMail ? 'email' : 'url',
          start: at + (isMail ? 7 : 0), end: at + h[2].length, write: v => encodeHtml(String(v)).replace(/"/g, '&quot;') });
      }
    }
    if (RAW.has(tag) && !/\/>$/.test(m[0])) { skipUntil = tag; continue; }
    if (!VOID.has(tag) && !/\/>$/.test(m[0])) stack.push({ tag, id: idv && /^[\w-]+$/.test(idv) ? idv : null });
  }
  text_(last, text.length);
  return out;
}


// ---------------------------------------------------------------------------------------------- collections
// Groups of same-shaped items that can take a new item, copied from the shape of an existing one:
//   yaml  - a list of mappings in a data file (_data/people.yml)
//   list  - a run of single-line Markdown list items (a tour list, a schedule)
//   files - a folder of short Markdown files with front matter (Jekyll _publications/, Hugo content/talks/)
const CONFIG_FILE = /^(_config\.ya?ml|(hugo|config)\.(toml|ya?ml)|config\/_default\/.*)$/;
const ARTICLE_DIR = /^_?(posts|blog|drafts|pages|docs|articles)$/i;
const PROSE_DIR = /^_?(posts|blog|drafts|docs|articles)$/i;   // lists inside articles are part of the article
const LANG_TWIN = /\.[a-z]{2}(-[a-z]{2,4})?\.(md|markdown)$/i;
const DATE_KEY = /^(date|lastmod|publishDate|published)$/i;
const REGEN_KEY = /^(permalink|slug)$/i;

/** Lines of a YAML mapping (one list item, or front matter) -> entries. Unsupported shapes are marked. */
function mappingEntries(lines) {
  const out = [], stack = [];
  lines.forEach((line, idx) => {
    if (!line.trim() || /^\s*#/.test(line)) return;
    const m = line.match(/^(\s*)(-\s+)?([A-Za-z0-9_][\w\-]*)(\s*:)(\s*)(.*)$/);
    if (!m || (m[2] && idx > 0)) { out.push({ idx, kind: 'other' }); return; }
    const indent = m[1].length + (m[2] ? m[2].length : 0);
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    const name = [...stack.map(x => x.name), m[3]].join('.');
    const raw = m[6].replace(/\s+#.*$/, '').trimEnd();
    if (!raw) { stack.push({ indent, name: m[3] }); out.push({ idx, kind: 'parent', name, indent }); return; }
    if (/^[|>][+-]?$/.test(raw) || /^[\[{&*!]/.test(raw)) { out.push({ idx, kind: 'other', name }); return; }
    out.push({ idx, kind: 'scalar', name, raw, at: m[1].length + (m[2] || '').length + m[3].length + m[4].length + m[5].length, dash: Boolean(m[2]) });
  });
  return out;
}
const unquote = raw => raw[0] === '"' ? raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\') : raw[0] === "'" ? raw.slice(1, -1).replace(/''/g, "'") : raw;
const yamlScalar = (v, like) => like?.[0] === "'" ? `'${String(v).replace(/'/g, "''")}'` : (like?.[0] === '"' || /[:#]\s|^[\s'"&*!|>%@`\[{-]|\s$|^(true|false|yes|no|null|~|-?\d+(\.\d+)?)$/i.test(v) || /^\d{4}-\d{2}-\d{2}/.test(v)) ? JSON.stringify(String(v)) : String(v);
/** What a front-matter / list-item key is for. */
function roleOf(name, raw) {
  const last = name.split('.').pop(), v = unquote(raw);
  if (DATE_KEY.test(last)) return 'date';
  if (REGEN_KEY.test(last)) return 'regen';
  if (/^url$/i.test(last)) return /^https?:\/\//i.test(v) ? 'field' : 'regen';
  if (ASSET_KEY.test(last)) return 'asset';
  if (/^https?:\/\//i.test(v)) return 'field';
  if (TECH_VALUE(v)) return 'asset';
  if (/year/i.test(last)) return 'field';
  if (TECH_KEY.test(last) || /^(true|false|yes|no|null|~|-?\d+(\.\d+)?)$/i.test(v)) return 'keep';
  return 'field';
}
/** Field list shared by every item of a collection (union; required = in every item). */
function unionFields(perItem) {
  const fields = [];
  for (const entries of perItem) for (const e of entries) {
    if (e.kind !== 'scalar') continue;
    const role = roleOf(e.name, e.raw); if (role !== 'field' && role !== 'date') continue;
    const name = role === 'date' ? e.name : e.name, v = unquote(e.raw);
    if (!fields.some(f => f.name === name)) fields.push({ name, type: role === 'date' ? 'date' : guessType(v), example: short(v) });
  }
  for (const f of fields) {
    const vals = perItem.map(es => es.find(e => e.kind === 'scalar' && e.name === f.name)).filter(Boolean).map(e => unquote(e.raw));
    f.required = vals.length === perItem.length;
    // A short label shared by the items (a category, a type): offered as choices, kept from the template if not given.
    const distinct = [...new Set(vals)];
    if (f.type === 'text' && perItem.length >= 2 && distinct.length <= Math.min(3, perItem.length - 1) && distinct.every(v => v.length <= 24)) f.choices = distinct;
  }
  return fields;
}
/**
 * Fills a copy of a template mapping (array of lines) with values. Lines of text fields without a value are
 * dropped (or emptied when they cannot be dropped); dates, slugs and permalinks are regenerated; pictures and
 * other files are kept but reported, so the card can say "this still uses the old picture".
 */
function fillMapping(lines, entries, values, { fields, stem, newStem, date }) {
  const out = lines.slice(), drop = new Set(), missing = [], warnings = [];
  for (const e of entries) {
    if (e.kind === 'other' && e.name) { warnings.push({ code: 'KEPT_FROM_TEMPLATE', field: e.name }); continue; }
    if (e.kind === 'other') continue;
    if (e.kind !== 'scalar') continue;
    const role = roleOf(e.name, e.raw), line = out[e.idx], head = line.slice(0, e.at);
    const put = v => { out[e.idx] = head + yamlScalar(v, e.raw); };
    if (role === 'date') { if (date) out[e.idx] = head + (/^["']/.test(e.raw) ? yamlScalar(date, e.raw) : date); else if (!e.dash) drop.add(e.idx); continue; }
    if (role === 'regen') { const v = unquote(e.raw); put(stem && v.includes(stem) ? v.split(stem).join(newStem) : v.replace(/[^/]+(\/?)$/, newStem + '$1')); continue; }
    if (role === 'asset') { warnings.push({ code: 'ASSET_FROM_TEMPLATE', field: e.name, value: unquote(e.raw) }); continue; }
    if (role === 'keep') continue;
    const v = values[e.name];
    const f = fields.find(x => x.name === e.name);
    if (v !== undefined) put(Array.isArray(v) ? v.join(', ') : v);
    else if (f?.choices) warnings.push({ code: 'KEPT_FROM_TEMPLATE', field: e.name, value: unquote(e.raw) });
    else if (fields.find(f => f.name === e.name)?.required || e.dash) { put(''); missing.push(e.name); }
    else drop.add(e.idx);
  }
  // A parent key ("links:") whose children were all dropped goes too.
  for (const e of entries.filter(x => x.kind === 'parent')) {
    const kids = entries.filter(x => x.name?.startsWith(e.name + '.'));
    if (kids.length && kids.every(k => drop.has(k.idx))) drop.add(e.idx);
  }
  return { lines: out.filter((_, i) => !drop.has(i)), missing, warnings };
}
/** Runs of "- key: value" items at the same indent in a YAML file. */
function yamlLists(text) {
  const raw = text.split('\n'), lines = raw.map(l => l.replace(/\r$/, '')), offs = []; let o = 0; for (const l of raw) { offs.push(o); o += l.length + 1; }
  const isItem = l => /^(\s*)-\s+[A-Za-z0-9_][\w\-]*\s*:/.test(l), ind = l => l.search(/\S/), blank = l => !l.trim() || /^\s*#/.test(l);
  const out = []; let i = 0;
  while (i < lines.length) {
    if (!isItem(lines[i])) { i++; continue; }
    const d = ind(lines[i]), items = []; let j = i;
    while (j < lines.length && isItem(lines[j]) && ind(lines[j]) === d) {
      let k = j + 1; while (k < lines.length && (blank(lines[k]) || ind(lines[k]) > d)) k++;
      let e = k - 1; while (e > j && blank(lines[e])) e--;
      items.push({ first: j, last: e }); j = k;
    }
    let parent = '@';
    for (let u = i - 1; u >= 0; u--) { const l = lines[u]; if (blank(l)) continue; const m = l.match(/^(\s*)([A-Za-z0-9_][\w\-]*)\s*:\s*$/); if (m && m[1].length <= d) parent = m[2]; if (ind(l) <= d) break; }
    out.push({ parent, items: items.map(it => ({ lines: lines.slice(it.first, it.last + 1), start: offs[it.first], end: offs[it.last] + lines[it.last].length })) });
    i = j;
  }
  return out;
}
/** Runs of two or more single-line Markdown list items (body only, outside code blocks). */
function mdLists(text) {
  const fm = text.match(/^(---|\+\+\+)[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*(\r?\n|$)/), body = fm ? fm[0].length : 0;
  const lines = text.slice(body).split('\n'), out = []; let off = body, run = null; const fence = fenceTracker();
  const end = () => { if (run && run.items.length >= 2 && !run.bad) out.push(run); run = null; };
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, ''), ls = off; off += rawLine.length + 1;
    if (fence.step(line)) { end(); continue; }
    if (fence.open) continue;
    const m = line.match(/^(\s*(?:[-*+]|\d+[.)])[ \t]+)(?!\[[ xX]\])(.*\S)\s*$/);
    if (m && !/^[<{]/.test(m[2])) {
      if (run && run.indent !== m[1].search(/\S/)) end();
      run ||= { indent: m[1].search(/\S/), items: [] };
      run.items.push({ prefix: m[1], value: m[2], start: ls, end: ls + line.length });
      continue;
    }
    if (run && line.trim() && /^\s/.test(line)) run.bad = true;   // multi-line items: not supported
    end();
  }
  end();
  return out;
}
const eolOf = text => /\r\n/.test(text) ? '\r\n' : '\n';
function frontMatter(text) {
  const m = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/);
  return m ? { lines: m[1].split(/\r?\n/), body: text.slice(m[0].length), nl: /\r\n/.test(m[0]) ? '\r\n' : '\n' } : null;
}

// React projects often keep JSX in .js files (Create React App): read those like .jsx
const JSX_IN_JS = /(return|=>)\s*\(?\s*<[A-Za-z>]/;
const PARSERS = { yml: yamlFields, yaml: yamlFields, toml: tomlFields, md: markdownFields, markdown: markdownFields, html: htmlFields, htm: htmlFields,
  // website projects built with a JavaScript framework (Astro, React / Next.js / Vite, Vue, Svelte)
  astro: t => componentFields(t, 'astro'), jsx: t => componentFields(t, 'jsx'), tsx: t => componentFields(t, 'tsx'), vue: t => componentFields(t, 'vue'), svelte: t => componentFields(t, 'svelte'),
  js: t => JSX_IN_JS.test(t) ? componentFields(t, 'jsx') : scriptFields(t), mjs: scriptFields, ts: scriptFields,
  json: t => t.length > 200 * 1024 ? [] : jsonFields(t),   // very big JSON files are fetched or generated data, not words someone wrote (lock and config files are excluded elsewhere)
  mdx: t => markdownFields(mdxSource(t)) };
// Same-length blanking keeps every offset pointing into the real text.
const blankOut = s => s.replace(/[^\n]/g, ' ');
const blankRe = (text, re) => text.replace(re, blankOut);
// Eleventy also allows JavaScript or JSON front matter ("---js" … "---"): its strings are read like a .js / .json file.
function codeFrontMatter(fn) {
  return text => {
    const m = text.match(/^---[ \t]*(js|javascript|json)[ \t]*\n([\s\S]*?)\n---[ \t]*(\n|$)/);
    if (!m) return fn(text);
    const start = text.indexOf('\n') + 1, inner = blankOut(text.slice(0, start)) + m[2] + blankOut(text.slice(start + m[2].length));
    const head = m[1] === 'json' ? jsonFields(inner) : scriptFields(inner);
    return [...head.map(f => ({ ...f, loc: 'fm.' + f.loc })), ...fn(blankOut(m[0]) + text.slice(m[0].length))];
  };
}
// Nunjucks / Liquid templates (Eleventy): front matter, then HTML with {{ }} and {% %} tags (text holding a tag is left alone)
function templateFields(text) {
  const fm = text.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(\n|$)/);
  text = blankRe(text, /\{#[\s\S]*?#\}/g);                                     // {# comments #}
  if (!fm) return htmlFields(text);
  const blank = fm[0].replace(/[^\n]/g, ' ') + text.slice(fm[0].length);   // same length: offsets stay right
  return [...yamlFields(fm[1], text.indexOf('\n') + 1, 'fm.'), ...htmlFields(blank)];
}
PARSERS.njk = PARSERS.liquid = codeFrontMatter(templateFields);
PARSERS.md = PARSERS.markdown = codeFrontMatter(markdownFields);
PARSERS.qmd = markdownFields;   // Quarto
// Plain HTML pages: also the strings in their own <script> blocks; PHP: HTML plus the strings inside <?php ?>; Python: strings.
const tagLoc = (pre, list) => list.map(f => ({ ...f, loc: pre + f.loc }));
const htmlAndScripts = text => [...htmlFields(text), ...tagLoc('js.', inlineScriptFields(text))];
PARSERS.html = PARSERS.htm = htmlAndScripts;
// Server-side templates: the template code is blanked out (same length, so offsets stay right) before the page is
// read, and a piece of text that had template code inside it ("Hello <?= $name ?>!") is left alone: changing it
// would overwrite the code.
const PHP_TAG = /<\?(?:php|=)?[\s\S]*?(?:\?>|$)/g, ERB_TAG = /<%[\s\S]*?(?:%>|$)/g,
  CURLY_TAG = /\{\{[\s\S]*?(?:\}\}|$)|\{%[\s\S]*?(?:%\}|$)|\{#[\s\S]*?(?:#\}|$)/g;
const outsideTags = (re, read) => text => {
  const page = blankRe(text, re);
  const clean = f => {   // the whole run of text around the field, from the tag before it to the tag after it
    if (f.start == null || f.loc.startsWith('php.')) return true;
    const html = !f.loc.startsWith('js.'), a = html ? page.lastIndexOf('>', f.start - 1) + 1 : f.start;
    let b = html ? page.indexOf('<', f.end) : f.end; if (b < 0) b = page.length;
    return text.slice(a, b) === page.slice(a, b);
  };
  return read(page, text).filter(clean);
};
const pageAndScripts = page => [...htmlFields(page), ...tagLoc('js.', inlineScriptFields(page))];
PARSERS.php = outsideTags(PHP_TAG, (page, text) => [...pageAndScripts(page), ...tagLoc('php.', phpCodeFields(text))]);
// EJS (Node / Express) and ERB (Ruby): <% %>; Handlebars / Mustache, Twig, Jinja: {{ }} {% %} {# #}
PARSERS.ejs = PARSERS.erb = outsideTags(ERB_TAG, pageAndScripts);
PARSERS.hbs = PARSERS.handlebars = PARSERS.mustache = PARSERS.twig = PARSERS.jinja = PARSERS.j2 = PARSERS.jinja2 = outsideTags(CURLY_TAG, pageAndScripts);
PARSERS.py = pythonFields;
// Angular templates: HTML with {{ }} and @if / @for blocks (the block lines are code)
const angularFields = text => htmlFields(text.replace(/^[ \t]*(@(if|else|for|empty|switch|case|default|defer|placeholder|loading)\b[^{\n]*\{|\}[ \t]*(@else[^{\n]*\{)?)[ \t]*$/gm, blankOut).replace(/@(if|for|switch)\s*\([^)\n]*\)\s*\{|\}\s*@else\s*\{/g, blankOut));
// A GitHub profile README: Markdown, plus the HTML blocks profiles open with (<h1 align="center">…) and table cells.
function readmeFields(text) {
  const out = markdownFields(text), lines = text.split('\n');
  let off = 0, inHtml = false, inCode = false, cells = 0; const keep = []; const fence = fenceTracker();
  for (const line of lines) {
    inCode = fence.step(line) || fence.open;
    if (!inCode && /^\s*</.test(line)) inHtml = true; else if (!line.trim()) inHtml = false;
    keep.push(inHtml && !inCode ? line : blankOut(line));
    if (!inCode && /^\s*\|.*\|\s*$/.test(line) && !/^\s*\|[\s:|-]+\|\s*$/.test(line)) {
      const re = /\|([^|]*)(?=\|)/g; let m;
      while ((m = re.exec(line))) {
        const raw = m[1], lead = raw.length - raw.trimStart().length, value = raw.trim();
        if (value && !onlyImages(value)) out.push({ loc: 'body.td' + cells++, value, type: guessType(value), start: off + m.index + 1 + lead, end: off + m.index + 1 + lead + value.length, write: v => String(v).replace(/\n/g, ' ').replace(/\|/g, '\\|') });
      }
    }
    off += line.length + 1;
  }
  return [...htmlFields(keep.join('\n')), ...out];
}
const cache = new Map();
function fieldsOf(file, text) {
  const ext = file.split('.').pop().toLowerCase(); const fn = /^README\.md$/i.test(file) ? readmeFields : /\.component\.html$/.test(file) ? angularFields : /(^|\/)templates\/.+\.html?$/i.test(file) ? PARSERS.jinja : PARSERS[ext];   // Flask / Django templates are Jinja if (!fn) return [];
  const key = file + '\u0000' + text;
  if (cache.has(key)) return cache.get(key);
  // Windows line endings: the parsers read lines up to \n, so a CR is read as a space (same length: every offset still
  // points into the real text, and an edit never touches the line ending).
  let list; try { list = fn(text.replace(/\r(?=\n)/g, ' ')); } catch { list = []; }
  list = list.filter(f => !(typeof f.value === 'string' && /\{\{|\{%/.test(f.value)));   // template code ({{ tag }}), not words
  list = list.filter(f => /^((fm|js|php)\.)?(str|text|attr)\./.test(f.loc) || (!TECH_KEY.test(f.loc.replace(/\.\d+(?=\.|$)/g, '')) && !(typeof f.value === 'string' && TECH_VALUE(f.value))));   // code files: code-text.js already chose
  const seen = new Map();
  for (const f of list) { const n = seen.get(f.loc) || 0; seen.set(f.loc, n + 1); if (n) f.loc += '~' + (n + 1); }   // unique locators
  if (cache.size > 400) cache.delete(cache.keys().next().value);
  cache.set(key, list); return list;
}
const groupCache = new Map();
function htmlGroupsCached(file, text) {
  const key = file + '\u0000' + text;
  if (!groupCache.has(key)) { let g; try { g = htmlGroups(file, text, fieldsOf(file, text)); } catch { g = []; } if (groupCache.size > 200) groupCache.delete(groupCache.keys().next().value); groupCache.set(key, g); }
  return groupCache.get(key);
}
const split = path => { const i = String(path).indexOf('::'); return i < 0 ? [null, null] : [path.slice(0, i), path.slice(i + 2)]; };

export class TextSiteAdapter {
  /** exclude: files (relative to website/) made by the site's build command. They are never read or edited:
   *  the next build would overwrite them. Suggestions go to the source files instead. */
  constructor(mode = 'html', { exclude = [] } = {}) { this.adapterId = TEXT_SITE_ADAPTER_ID; this.mode = mode; this.supportedSchemaVersion = SUPPORTED_SCHEMA_VERSION; this.exclude = new Set(exclude); }

  // ---- reading and writing the site
  async readContent(workspace) {
    const list = await workspace.listFiles('website'); if (!list.ok) return list;
    const rel = list.data.files.map(p => p.replace(/^website\//, ''));
    const files = {}, skipped = [], notUtf8 = [], all = contentFilesFor(this.mode, rel, this.exclude);
    skipped.push(...all.slice(MAX_FILES));                     // more pages than Sitetend reads: named to the owner, never silently ignored
    for (const p of all.slice(0, MAX_FILES)) {
      const r = await workspace.readText('website/' + p); if (!r.ok) return r;
      if (r.data.notUtf8) notUtf8.push(p);                     // editing it would damage its characters: left alone, and the owner is told
      else if (textSize(r.data.content) <= MAX_BYTES) files[p] = r.data.content; else skipped.push(p);
    }
    this.skipped = skipped;   // too large to read: shown to the owner, never silently ignored
    this.notUtf8 = notUtf8;
    return createOk({ path: 'website', data: { schemaVersion: 1, siteAdapter: TEXT_SITE_ADAPTER_ID, mode: this.mode, files } });
  }
  async writeContent(workspace, content) {
    const before = await this.readContent(workspace); if (!before.ok) return before;
    const old = before.data.data.files, done = [];
    for (const [p, text] of Object.entries(content.files)) {
      if (old[p] === text) continue;
      const w = await workspace.writeText('website/' + p, text);
      if (!w.ok) { for (const q of done) await workspace.writeText('website/' + q, old[q]); return w; }   // undo the files already written
      done.push(p);
    }
    for (const p of Object.keys(old)) {   // a file that is no longer part of the site (an item that was removed / an add that was undone)
      if (Object.hasOwn(content.files, p)) continue;
      const d = await workspace.deleteFile('website/' + p);
      if (!d.ok) { for (const q of done) await workspace.writeText('website/' + q, old[q]); return d; }
      done.push(p);
    }
    return createOk({ written: done });
  }
  canWriteContent() { return true; }
  isContentFile(relPath) { const p = String(relPath).replace(/^website\//, ''); return contentFilesFor(this.mode, [p], this.exclude).length === 1; }
  getAllowedWritableFiles() { return ['website/']; }
  isFileWritable(relativePath) {
    const n = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    return !n.includes('..') && n.startsWith('website/') && (this.isContentFile(n) || n.startsWith('website/assets/') || /^website\/(files|static|images)\//.test(n));
  }
  validateContent(content) {
    if (!content || typeof content !== 'object' || !content.files || typeof content.files !== 'object') return createErr(ERROR_CODES.INVALID_CONTENT_FORMAT, 'SiteAdapter', 'Website content could not be read.');
    if (Object.values(content.files).some(t => typeof t !== 'string')) return createErr(ERROR_CODES.INVALID_CONTENT_FORMAT, 'SiteAdapter', 'Website files must be text.');
    return createOk({ valid: true });
  }

  // ---- fields
  listEditableFields(content) {
    const out = [];
    for (const [file, text] of Object.entries(content?.files || {})) {
      for (const f of fieldsOf(file, text)) out.push({ path: `${file}::${f.loc}`, type: f.type, section: file, label: `${file} › ${f.label ? humanize(f.label) : humanize(f.loc.replace(/^fm\./, '').replace(/^body\./, ''))}`, description: '' });
    }
    return out;
  }
  _find(content, fieldPath) {
    const [file, loc] = split(fieldPath); const text = content?.files?.[file];
    if (typeof text !== 'string') return null;
    const f = fieldsOf(file, text).find(x => x.loc === loc);
    return f ? { file, text, f } : null;
  }
  getFieldValue(content, fieldPath) {
    if (String(fieldPath).startsWith(FILE)) {
      const file = fieldPath.slice(FILE.length), text = content?.files?.[file];
      return createOk({ field: { path: fieldPath, type: 'file', section: file, label: file }, value: typeof text === 'string' ? text : undefined });
    }
    const hit = this._find(content, fieldPath);
    if (!hit) return createErr(ERROR_CODES.FIELD_NOT_EDITABLE, 'SiteAdapter', `"${fieldPath}" is not an editable field of this website.`, { fieldPath });
    const field = { path: fieldPath, type: hit.f.type, section: hit.file, label: `${hit.file} › ${humanize(hit.f.label || hit.f.loc)}` };
    return createOk({ field, value: structuredClone(hit.f.value) });
  }
  setFieldValue(content, fieldPath, raw) {
    const hit = this._find(content, fieldPath);
    if (!hit) return createErr(ERROR_CODES.FIELD_NOT_EDITABLE, 'SiteAdapter', `"${fieldPath}" is not an editable field of this website.`, { fieldPath });
    const clean = this._sanitize(hit.f, raw, fieldPath); if (!clean.ok) return clean;
    return this._replace(content, hit, clean.data);
  }
  setFieldRaw(content, fieldPath, value) {
    if (String(fieldPath).startsWith(FILE)) {
      const file = fieldPath.slice(FILE.length);
      if (!file || file.includes('..') || (value !== undefined && typeof value !== 'string') || !contentFilesFor(this.mode, [file]).length)
        return createErr(ERROR_CODES.FIELD_NOT_EDITABLE, 'SiteAdapter', `"${fieldPath}" is not a website text file.`, { fieldPath });
      const updated = structuredClone(content);
      if (value === undefined) delete updated.files[file]; else updated.files[file] = value;
      return createOk({ content: updated });
    }
    const hit = this._find(content, fieldPath);
    if (!hit) return createErr(ERROR_CODES.FIELD_NOT_EDITABLE, 'SiteAdapter', `"${fieldPath}" is not an editable field of this website.`, { fieldPath });
    const r = this._replace(content, hit, value); return r.ok ? createOk({ content: r.data.content }) : r;
  }
  _replace(content, { file, text, f }, value) {
    const updated = structuredClone(content);
    updated.files[file] = text.slice(0, f.start) + f.write(value) + text.slice(f.end);
    return createOk({ content: updated, field: { path: `${file}::${f.loc}`, type: f.type }, value });
  }
  diffContent(base, target) {
    const changes = [];
    const files = new Set([...Object.keys(base?.files || {}), ...Object.keys(target?.files || {})]);
    for (const file of files) {
      const a = base?.files?.[file], b = target?.files?.[file];
      if (a === b) continue;
      const whole = { path: FILE + file, label: file, section: file, type: 'file', before: a, after: b };
      if (typeof a !== 'string' || typeof b !== 'string') { changes.push(whole); continue; }   // file added or removed
      const fa = new Map(fieldsOf(file, a).map(f => [f.loc, f])), fb = new Map(fieldsOf(file, b).map(f => [f.loc, f]));
      const mine = [];
      for (const loc of new Set([...fa.keys(), ...fb.keys()])) {
        const va = fa.get(loc)?.value, vb = fb.get(loc)?.value;
        if (JSON.stringify(va) !== JSON.stringify(vb)) mine.push({ path: `${file}::${loc}`, label: `${file} › ${humanize(loc)}`, section: file, type: (fb.get(loc) || fa.get(loc)).type, before: va, after: vb });
      }
      // Field changes are used only when they explain the whole file change (same set of fields, nothing else
      // touched). Otherwise (items added or removed, lines dropped, dates changed) the file changes as one unit.
      let tmp = { files: { [file]: a } };
      const explains = fa.size === fb.size && [...fa.keys()].every(k => fb.has(k)) && mine.every(c => { const r = this.setFieldRaw(tmp, c.path, c.after); if (r.ok) tmp = r.data.content; return r.ok; }) && tmp.files[file] === b;
      if (explains) changes.push(...mine); else changes.push(whole);
    }
    return createOk({ hasChanges: changes.length > 0, changeCount: changes.length, changes });
  }

  // ---- collections
  listCollections(content) {
    const files = content?.files || {}, out = [], html = [];
    for (const [file, text] of Object.entries(files)) {
      if (/\.ya?ml$/i.test(file) && !CONFIG_FILE.test(file)) {
        const seen = new Map();
        for (const list of yamlLists(text)) {
          const n = (seen.get(list.parent) || 0) + 1; seen.set(list.parent, n);
          const per = list.items.map(it => mappingEntries(it.lines)), fields = unionFields(per);
          const nested = per.some(es => es.some(e => e.kind === 'other'));
          if (!fields.some(f => f.type !== 'date')) continue;
          if (per.some(es => es.some(e => e.kind === 'scalar' && roleOf(e.name, e.raw) === 'regen'))) continue;   // menus: links to pages = site structure
          const titleField = pickTitleField(fields);
          out.push({ id: `yaml:${file}::${list.parent}${n > 1 ? '~' + n : ''}`, kind: 'yaml', file, label: `${file} › ${humanize(list.parent === '@' ? 'list' : list.parent)}`,
            items: per.map((es, i) => ({ key: String(i), title: unquote(es.find(e => e.name === titleField)?.raw || '') || String(i + 1) })),
            fields, titleField, canAdd: !nested, canReplace: !nested, ...(nested ? { why: 'NESTED' } : {}) });
        }
      }
      if (this.mode === 'html' && /\.html?$/i.test(file) && typeof text === 'string') html.push(...htmlGroupsCached(file, text));
      if (/\.(md|markdown)$/i.test(file) && !LANG_TWIN.test(file) && !file.split('/').slice(0, -1).some(d => PROSE_DIR.test(d))) {
        mdLists(text).forEach((run, k) => out.push({ id: `list:${file}::${k}`, kind: 'list', file, label: `${file} › ${run.items[0].value.slice(0, 24)}…`,
          items: run.items.map((it, i) => ({ key: String(i), title: it.value })), fields: [{ name: 'text', type: 'text', required: true, example: short(run.items[0].value) }],
          titleField: 'text', canAdd: true, canReplace: true }));
      }
    }
    // folders of short Markdown files with front matter
    const dirs = new Map();
    for (const file of Object.keys(files)) {
      const i = file.lastIndexOf('/'); if (i < 0) continue;
      const dir = file.slice(0, i), base = file.slice(i + 1);
      if (!/\.(md|markdown|mdx)$/i.test(base) || /^_?index\./i.test(base)) continue;
      if (/^---[ \t]*(js|javascript|json)\b/.test(files[file] || '')) continue;   // Eleventy JavaScript front matter: not a fill-in-the-blanks item
      const top = dir.split('/')[0];
      const ok = this.mode === 'jekyll' ? /^_[\w-]+$/.test(dir) && !/^_(data|layouts|includes|sass|site)$/.test(dir) : this.mode === 'hugo' ? /^content(\.[\w-]+)?\//.test(dir) : this.mode === 'app' ? /^(src\/)?(content|data)\/[\w-]+$/.test(dir)
        : this.mode === 'hexo' ? /^source\/_?[\w-]+$/.test(dir) && dir !== 'source/_data' : this.mode === 'eleventy' ? !/(^|\/)_/.test(dir) : false;   // app: Astro content collections, data/blog
      if (!ok || top === undefined) continue;
      if (!dirs.has(dir)) dirs.set(dir, []); dirs.get(dir).push(file);
    }
    for (const [dir, list] of dirs) {
      if (list.length < 2) continue;
      const name = dir.split('/').pop(), fms = list.map(f => frontMatter(files[f]));
      const avgBody = list.reduce((n, f, i) => n + (fms[i]?.body.trim().length || 0), 0) / list.length;
      let why = null;
      if (fms.some(x => !x)) why = 'NO_FRONT_MATTER';
      else if (list.some(f => LANG_TWIN.test(f))) why = 'TRANSLATIONS';
      else if (ARTICLE_DIR.test(name) || avgBody > 700) why = 'ARTICLES';
      const per = fms.map(x => x ? mappingEntries(x.lines) : []), fields = unionFields(per);
      if (avgBody > 0) fields.push({ name: 'body', type: 'textarea', required: fms.every(x => x?.body.trim()), example: short(fms.find(x => x?.body.trim())?.body.trim()) });
      const titleField = pickTitleField(fields);
      out.push({ id: `dir:${dir}`, kind: 'files', dir, label: `${dir}/`, items: list.map((f, i) => ({ key: f, title: unquote(per[i].find(e => e.name === titleField)?.raw || '') || f.split('/').pop() })),
        fields, titleField, canAdd: !why, canReplace: !why, ...(why ? { why } : {}) });
    }
    return out.concat(html.sort((a, b) => groupScore(b) - groupScore(a)));   // hand-written HTML: the most list-like first
  }
  buildItem(content, collectionId, { op = 'add', key = null, position = 'end', values = {} } = {}) {
    const coll = this.listCollections(content).find(c => c.id === collectionId);
    const fail = msg => createErr(ERROR_CODES.FIELD_NOT_EDITABLE, 'SiteAdapter', msg, { collection: collectionId });
    if (!coll || !coll.canAdd) return fail('This list cannot take new items.');
    const vals = cleanValues(values), title = vals[coll.titleField] ? String(vals[coll.titleField]) : '';
    const index = op === 'replace' ? coll.items.findIndex(i => i.key === key) : -1;
    if (op === 'replace' && index < 0) return fail('The item to replace was not found.');
    const updated = structuredClone(content), files = updated.files;
    const date = vals.date ? isoDate(vals.date) || vals.date : null;
    if (coll.kind === 'list') {
      const text = files[coll.file], run = mdLists(text)[Number(collectionId.split('::').pop())];
      const v = Array.isArray(vals.text) ? vals.text.join(', ') : vals.text;
      if (!v) return fail('The new item needs its text.');
      const list = insertAt(run.items.map(it => it.prefix + it.value), (op === 'replace' ? run.items[index] : position === 'start' ? run.items[0] : run.items.at(-1)).prefix + String(v).replace(/\n+/g, ' '), { op, index, position });
      files[coll.file] = text.slice(0, run.items[0].start) + list.join(eolOf(text)) + text.slice(run.items.at(-1).end);
      return createOk({ content: updated, title: v, key: String(op === 'replace' ? index : position === 'start' ? 0 : list.length - 1), missing: [], warnings: [], paths: [FILE + coll.file] });
    }
    if (coll.kind === 'html') {
      const r = buildHtmlItem(files[coll.file], coll, { op, key, position, values: vals }, encodeHtml);
      files[coll.file] = r.text;
      return createOk({ content: updated, title, key: r.key, missing: r.missing, warnings: r.warnings, paths: [FILE + coll.file] });
    }
    if (coll.kind === 'yaml') {
      const text = files[coll.file], [, parentPart] = collectionId.split('::'), [parent, nth] = parentPart.split('~');
      const lists = yamlLists(text).filter(l => l.parent === parent), list = lists[(Number(nth) || 1) - 1];
      const per = list.items.map(it => mappingEntries(it.lines));
      const t = op === 'replace' ? index : per.reduce((b, es, i) => es.length > per[b].length ? i : b, 0);
      const filled = fillMapping(list.items[t].lines, per[t], vals, { fields: coll.fields, date });
      const nl = eolOf(text), chunks = insertAt(list.items.map(it => it.lines.join(nl)), filled.lines.join(nl), { op, index, position });
      files[coll.file] = text.slice(0, list.items[0].start) + chunks.join(nl) + text.slice(list.items.at(-1).end);
      return createOk({ content: updated, title, key: String(op === 'replace' ? index : position === 'start' ? 0 : chunks.length - 1), missing: filled.missing, warnings: filled.warnings, paths: [FILE + coll.file] });
    }
    // files: write a new file shaped like a sibling (and, when replacing, remove the old one)
    const sib = coll.items.map(i => i.key);
    const t = op === 'replace' ? sib[index] : sib.reduce((b, f) => (frontMatter(files[f])?.lines.length || 0) > (frontMatter(files[b])?.lines.length || 0) ? f : b, sib[0]);
    const fm = frontMatter(files[t]), base = t.split('/').pop(), ext = base.split('.').pop(), stem = base.replace(/\.[^.]+$/, '');
    const dated = /^\d{4}-\d{2}-\d{2}-/.test(stem), hasDate = mappingEntries(fm.lines).some(e => e.kind === 'scalar' && DATE_KEY.test(e.name));
    const warnings = [];
    let useDate = date;
    if (!useDate && (dated || hasDate)) { useDate = today(); warnings.push({ code: 'DATE_TODAY', field: 'date', value: useDate }); }
    const taken = new Set(Object.keys(files).filter(f => f.startsWith(coll.dir + '/')).map(f => f.split('/').pop().replace(/\.[^.]+$/, '')));
    if (op === 'replace') taken.delete(stem);
    const slug = slugify(title || 'item', new Set([...taken].map(x => x.replace(/^\d{4}-\d{2}-\d{2}-/, ''))));
    const newStem = dated ? `${useDate}-${slug}` : slug, newFile = `${coll.dir}/${newStem}.${ext}`;
    if (files[newFile] !== undefined && newFile !== t) return fail('A file with that name already exists.');
    const filled = fillMapping(fm.lines, mappingEntries(fm.lines), vals, { fields: coll.fields, stem, newStem, date: useDate });
    const body = vals.body ? (Array.isArray(vals.body) ? vals.body.join('\n') : vals.body) : '';
    if (op === 'replace') delete files[t];
    const nl = fm.nl;   // a new file takes its sibling's line endings
    files[newFile] = `---${nl}${filled.lines.join(nl)}${nl}---${nl}${body ? nl + body.trim().replace(/\r?\n/g, nl) + nl : ''}`;
    const missing = filled.missing.concat(coll.fields.some(f => f.name === 'body' && f.required) && !body ? ['body'] : []);
    return createOk({ content: updated, title, key: newFile, missing, warnings: [...warnings, ...filled.warnings], paths: [...(op === 'replace' ? [FILE + t] : []), FILE + newFile] });
  }
  buildPreviewPayload(content, { mode = 'draft', editable = true, activeFieldPath = null } = {}) {
    const check = this.validateContent(content); if (!check.ok) return check;
    return createOk({ adapterId: this.adapterId, mode, editable: Boolean(editable && mode === 'draft'), activeFieldPath, content: structuredClone(content) });
  }
  getSourceMappings() { return []; }
  getSourceHints() { return []; }
  _sanitize(f, raw, fieldPath) {
    if (f.type === 'tags') {
      const arr = (Array.isArray(raw) ? raw : String(raw ?? '').split(/[,\uff0c\n]/)).map(v => stripTags(v).trim()).filter(Boolean);
      return arr.length ? createOk(arr) : createErr(ERROR_CODES.FIELD_VALIDATION_FAILED, 'SiteAdapter', 'Needs at least one item.', { fieldPath });
    }
    const v = (this.mode === 'html' ? stripTags(String(raw ?? '')) : String(raw ?? '')).trim();
    if (!v) return createErr(ERROR_CODES.FIELD_VALIDATION_FAILED, 'SiteAdapter', 'Cannot be empty.', { fieldPath });
    if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return createErr(ERROR_CODES.FIELD_VALIDATION_FAILED, 'SiteAdapter', 'Please enter a valid email address.', { fieldPath, value: v });
    if (f.type === 'url' && !/^https?:\/\/\S+$/i.test(v)) return createErr(ERROR_CODES.FIELD_VALIDATION_FAILED, 'SiteAdapter', 'Links must start with http:// or https://.', { fieldPath, value: v });
    return createOk(v);
  }
}

/** Preview: wraps every editable text run of an HTML file in <span data-sk-field> so it can be outlined and edited. */
export function annotateHtml(file, text) {
  const runs = fieldsOf(file, text).filter(f => f.type !== 'url' && !/\.link\.\d+/.test(f.loc) && !/^page\.title\./.test(f.loc)).sort((a, b) => b.start - a.start);
  let out = text;
  for (const f of runs) { const tag = f.svg ? 'tspan' : 'span'; out = out.slice(0, f.start) + `<${tag} data-sk-field="${file}::${f.loc}">` + out.slice(f.start, f.end) + `</${tag}>` + out.slice(f.end); }   // inside SVG text, a span would not be drawn
  return out;
}

/** For tests and tools: the field list of one text file. */
export const _fieldsOfFile = (file, text) => fieldsOf(file, text).map(({ loc, value, type, label }) => (label ? { loc, value, type, label } : { loc, value, type }));
