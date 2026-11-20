import fsSync from 'node:fs';
import { exec } from 'node:child_process';
// @ts-check
// One open website workspace inside the host: core + analysis + queue + watcher + usage.
import path from 'node:path';
import { CODE_FILE, MAX_VIEW, condense, around } from '../agent/code-edits.js';
import { SiteKeeperCore } from '../core/engine.js';
import { AnalysisEngine, DEFAULT_PRIVACY_PATTERNS } from '../agent/analysis-engine.js';
import { SourceParser } from '../adapters/source-parser.js';
import { MockModelProvider, OpenAICompatibleProvider } from '../adapters/model-provider.js';
import { siteAdapterForWorkspace } from '../adapters/site-adapters.js';
import { MaterialsLibrary } from './materials.mjs';
import { NodeFsWorkspaceAdapter } from '../adapters/node-workspace-adapter.mjs';
import { WriteQueue } from './write-queue.mjs';
import { watchTree } from './tree-watcher.mjs';
import { gitStatus, gitPublish } from './publisher-git.mjs';
import * as cloudflare from './publisher-cloudflare.mjs';
import * as netlify from './publisher-netlify.mjs';
import { Memory } from './memory.mjs';

// Hosts that Publish can upload to. fields: [name, kind, required]. Tokens live in ~/.sitetend/.env under tokenKey.
export const HOSTS = {
  cloudflare: { id: 'cloudflare-pages', tokenKey: cloudflare.CF_TOKEN_KEY, collect: (dir, root) => cloudflare.collectFiles(dir, { root }),
    fields: [['accountId', 'text', true], ['project', 'text', true], ['branch', 'text', false]],
    clean: { accountId: v => v.toLowerCase(), project: v => v.toLowerCase() },
    check: o => cloudflare.cloudflareCheck(o), publish: o => cloudflare.cloudflarePublish(o) },
  netlify: { id: 'netlify', tokenKey: netlify.NETLIFY_TOKEN_KEY, collect: (dir, root) => netlify.collectFiles(dir, { root }),
    fields: [['site', 'text', true], ['draft', 'bool', false]],
    clean: { site: v => netlify.normalizeSite(v) || v },
    check: o => netlify.netlifyCheck(o), publish: o => netlify.netlifyPublish(o) },
};
import { chatTurn } from './chat-agent.mjs';
import { plainMarkdown } from '../ui/markdown-lite.js';
import { loadModels, resolveKey, userDir, loadSettings } from './user-config.mjs';
import { syncSources } from './external-sources.mjs';
import { guard as spendGuard, record as spendRecord } from './spending.mjs';
import { decodeEntities } from '../adapters/entities.js';
import { SiteBackups } from './backups.mjs';

const unwrap = r => { if (!r.ok) { const e = Error(r.error.message); e.code = r.error.code; throw e; } return r.data; };
const IGNORE = /(^|\/)(\.sitetend|\.git|node_modules|\.next|\.astro|\.svelte-kit|\.nuxt|\.turbo|\.cache)(\/|$)|\.sitetend-tmp-|~$|\.swp$/;

/**
 * Which folder layout was opened:
 *  - "project": the folder holds website/ (and usually sources/) - the demos and earlier workspaces;
 *  - "site":    the folder IS a website (index.html, content.json, _config.yml, hugo.toml…) - what people already have.
 */
export function detectLayout(root) {
  if (fsSync.existsSync(path.join(root, 'website')) && fsSync.statSync(path.join(root, 'website')).isDirectory()) return 'project';
  return isSiteFolder(root) || isGenericSiteFolder(root) ? 'site' : 'project';
}

/** True when the folder itself is a website: a page, a JSON site, Jekyll, or Hugo (any of Hugo's config names). */
export function isSiteFolder(root) {
  const has = p => fsSync.existsSync(path.join(root, p));
  const marks = ['content.json', 'index.html', 'index.htm', '_quarto.yml', '_quarto.yaml', '_config.yml', '_config.yaml', 'hugo.toml', 'hugo.yaml', 'hugo.yml', 'hugo.json', 'config.toml'];
  if (marks.some(has)) return true;
  // config.yml / config.yaml / config/_default/ are common names in other projects too: count them only next to Hugo's content/
  if (has('content') && ['config.yml', 'config.yaml', 'config.json', 'config/_default'].some(has)) return true;
  if (isAppFolder(root)) return true;
  if (['.eleventy.js', 'eleventy.config.js', 'eleventy.config.mjs', 'eleventy.config.cjs'].some(has)) return true;   // Eleventy (11ty)
  try { const top = fsSync.readdirSync(root);
    // a page at the top, unless the folder is mostly documents and photos (a Documents folder with one saved web page)
    const pages = top.filter(e => /\.(html?|php)$/i.test(e)).length, docs = top.filter(e => /\.(pdf|docx?|xlsx?|pptx?|key|pages|numbers|jpe?g|png|heic|mov|mp4|zip)$/i.test(e)).length;
    if (pages && docs <= pages * 3) return true;
    if (isServerFolder(root, top)) return true;
    // a GitHub profile: README.md and nothing but images and repo files next to it
    return top.some(e => /^README\.md$/i.test(e)) && top.every(e => /^(README\.md|LICENSE(\.\w+)?|\.git|\.gitignore|\.github|\.sitetend|assets|images|img|media)$|\.(png|jpe?g|gif|svg|webp)$/i.test(e));
  } catch { return false; }
}

/**
 * Any other folder that holds a website's source: web pages or front-end code (or a package.json) near the top,
 * and not mostly documents, photos or other files. A Documents, Desktop or Downloads folder is not one.
 */
export function isGenericSiteFolder(root) {
  if (holdsSites(root)) return false;   // a folder of websites (Documents/projects/…): Sitetend lists them instead

  const WEB = /\.(html?|php|astro|jsx|tsx|vue|svelte|njk|liquid|qmd|mdx|ejs|erb|hbs|handlebars|mustache|twig|jinja2?|j2)$|^(package\.json|Gemfile|mkdocs\.ya?ml)$/i;
  const DOC = /\.(pdf|docx?|xlsx?|pptx?|key|pages|numbers|odt|rtf|jpe?g|png|heic|gif|tiff?|psd|ai|mov|mp4|avi|mp3|wav|m4a|zip|rar|7z|dmg|exe|msi|iso|epub)$/i;
  const SKIP = /^(\.|node_modules$|vendor$|venv$|dist$|build$|out$|AppData$|Library$|Applications$)/;
  let web = 0, doc = 0, seen = 0; const queue = [[root, 0]];
  while (queue.length && seen < 2000) {
    const [dir, depth] = queue.shift();
    let entries; try { entries = fsSync.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++seen > 2000) break;
      if (e.isDirectory()) { if (depth < 2 && !SKIP.test(e.name)) queue.push([path.join(dir, e.name), depth + 1]); continue; }
      if (WEB.test(e.name)) web++; else if (DOC.test(e.name)) doc++;
    }
  }
  // a site generator we do not know by name keeps its pages in Markdown next to its settings file
  try { if (fsSync.readdirSync(root).some(e => /^(mkdocs\.ya?ml|docusaurus\.config\.[jt]s|pelicanconf\.py|zola\.toml|book\.toml|config\.toml|theme\.config\.[jt]sx?|\.vitepress|\.vuepress|docfx\.json|antora\.yml)$/.test(e))) web++; } catch {}
  return web > 0 && doc <= web * 3 && seen < 2000;
}

/** Whether a folder has websites we know by name inside it (up to three folders down). */
function holdsSites(root) {
  const SKIP = /^(\.|node_modules$|vendor$|venv$|dist$|build$|out$|_site$|public$)/; const queue = [[root, 0]]; let seen = 0;
  while (queue.length && seen < 400) {
    const [dir, depth] = queue.shift();
    let entries; try { entries = fsSync.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.test(e.name)) continue;
      const sub = path.join(dir, e.name); seen++;
      if (isSiteFolder(sub) && !/^(src|app|pages|components|content|templates|client|frontend|web|docs|static|assets|lib|data|source|layouts|_includes|_layouts|views|resources)$/i.test(e.name)) return true;
      if (depth < 2) queue.push([sub, depth + 1]);
    }
  }
  return false;
}
/** A website project built with a JavaScript framework: package.json that uses one, and its source folder. */
/** Flask / Django: a Python project with Jinja templates (templates/ at the top or one folder down). */
function isServerFolder(root, top) {
  if (!top.some(e => /^(requirements\.txt|pyproject\.toml|Pipfile|manage\.py|app\.py|main\.py)$/.test(e))) return false;
  const hasHtml = d => { try { return fsSync.readdirSync(d, { recursive: true }).some(f => /\.html?$/i.test(String(f))); } catch { return false; } };
  if (top.includes('templates') && hasHtml(path.join(root, 'templates'))) return true;
  return top.some(e => !e.startsWith('.') && fsSync.existsSync(path.join(root, e, 'templates')) && hasHtml(path.join(root, e, 'templates')));
}
/**
 * The website inside a folder that is not one itself: a project whose only website is one folder down
 * (my-portfolio/profolio/, a repo with frontend/ next to backend/). Null when there is none or more than one.
 */
export function nestedSiteFolder(root) {
  let dirs; try { dirs = fsSync.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && !/^(\.|node_modules$|vendor$|venv$|dist$|build$|docs$|\.?sitetend)/.test(d.name)); } catch { return null; }
  const found = dirs.map(d => path.join(root, d.name)).filter(d => isSiteFolder(d));
  return found.length === 1 ? found[0] : null;
}
export function isAppFolder(root) {
  let pkg; try { pkg = JSON.parse(fsSync.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { return false; }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const uses = ['astro', 'next', 'react', 'vue', 'svelte', '@sveltejs/kit', 'vite', 'gatsby', 'nuxt', '@remix-run/react', 'solid-js', 'preact', '@angular/core', 'react-router', '@tanstack/react-router', 'qwik', '@builder.io/qwik'].some(d => d in deps);
  return uses && ['src', 'app', 'pages', 'components', 'client/src', 'frontend/src', 'web/src'].some(d => fsSync.existsSync(path.join(root, d)));
}

/** A model profile as saved now (its price may have been corrected after the model was chosen). */
const currentProfile = async p => (await loadModels()).profiles.find(x => x.id === p.id) || p;
const sameContent = (a, b) => {
  if (a === b) return true; if (!a || !b) return false;
  if (a.files && b.files) { const ka = Object.keys(a.files), kb = Object.keys(b.files); return ka.length === kb.length && ka.every(k => a.files[k] === b.files[k]); }
  return JSON.stringify(a) === JSON.stringify(b);
};
export class WorkspaceSession {
  /** @param {{root:string, emit:(type:string,data?:any)=>void, build?:{command?:string, generated?:string[]}|null}} opts */
  constructor({ root, emit, build = null, sources = [] }) {
    this.sources = Array.isArray(sources) ? sources : [];   // external materials (MCP), from the owner's settings
    // Build step (from the owner's own settings, never from the website folder): the command to run after each change,
    // and the files it makes (never edited; the main one is what the preview shows).
    const generated = (build?.generated || []).map(p => String(p).replace(/\\/g, '/').replace(/^\.?\//, '').trim()).filter(p => p && !p.includes('..'));
    this.build = build?.command ? { command: String(build.command), generated, running: false, last: null } : null;
    this.buildGenerated = generated;
    this.root = path.resolve(root);
    this.emit = emit;
    this.queue = new WriteQueue();
    this.site = null;                   // chosen in open() from website/content.json
    this.layout = detectLayout(this.root);
    this.ws = new NodeFsWorkspaceAdapter(this.root, path.basename(this.root), this.layout);
    this.recentWrites = new Map();      // relPath -> timestamp of our own write
    this.ws.onWrite = p => this.recentWrites.set(p, Date.now());
    this.ws.cleanTemp().catch(() => {});   // leftovers of a write cut off last time (never half-written real files)
    // Daily full-site backup (a .zip in the user's folder): made when the site is opened and, if the day has changed
    // since, before Sitetend's first write of the day. Writing waits for it, so the backup is the site before the change.
    this.backups = new SiteBackups(this.root);
    for (const m of ['writeText', 'writeBytes', 'deleteFile']) {
      const orig = this.ws[m].bind(this.ws);
      this.ws[m] = async (p, ...rest) => { if (/^website\//.test(p) || this.layout === 'site' && !/^\.sitetend\//.test(p)) await this.backupToday(); return orig(p, ...rest); };
    }
    this.usage = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, ms: 0, last: null };
    this.sentLog = [];                  // which files were sent to which model
    this.modelInfo = { id: 'rule', label: 'Rule demo (offline)', local: true, isMock: true };
    this.analyzeTimer = null;
    this.watcher = null;
    this.memory = new Memory({ siteDir: path.join(this.root, '.sitetend') });   // what the owner asked Sitetend to remember
  }

  async open() {
    this.site = await siteAdapterForWorkspace(this.ws, { exclude: this.buildGenerated });
    this.core = new SiteKeeperCore({ workspaceAdapter: this.ws, siteAdapter: this.site });
    unwrap(await this.core.initializeWorkspace());
    // A write cut off last time (power loss, forced quit): finish the changes the owner had accepted.
    this.backupToday().catch(() => {});    // the site as it is when opened (once a day); writes wait for it
    this.backupTimer = setInterval(() => this.backupToday().catch(() => {}), 60 * 60 * 1000);   // Sitetend left open past midnight
    this.backupTimer.unref?.();
    const fin = await this.core.finishInterruptedApply();
    this.recovered = fin.ok && fin.data.finished;
    this.openedContent = structuredClone(this.core.liveContent);   // "before this session" comparison base
    await this.useActiveModel();
    this.analysis = new AnalysisEngine({ workspaceAdapter: this.ws, siteAdapter: this.site, editingCore: this.core, parser: new SourceParser(), provider: this.provider });
    this.analysis.notesFor = fields => this.memory.relevant({ fields }).catch(() => []);
    this.analysis.onNotesUsed = ids => { this.memory.used(ids).catch(() => {}); };
    unwrap(await this.analysis.initialize());
    this.materials = new MaterialsLibrary(this);
    // First open: establish the source baseline automatically (users never see the word "baseline").
    if (!this.analysis.state.initialized) unwrap(await this.analysis.scan({ baselineOnly: true }));
    await this.ensureGitignore();
    this.startWatching();
    const st = await this.ws.readJson('.sitetend/external.json'); this.sourceStatus = st.ok ? st.data.data.status || {} : {};
    this.startSourceTimer();
    this.buildSuggestion = this.build ? null : await this.detectBuild();
    return this;
  }

  // ---- build step (sites whose pages are generated by a script) ----
  /** A build script next to the site (build.py, package.json "build", Makefile) and the files it seems to write. */
  async detectBuild() {
    const read = async p => { const r = await this.ws.readText('website/' + p); return r.ok ? r.data.content : null; };
    const py = process.platform === 'win32' ? 'python' : 'python3';
    const has = async p => { const r = await this.ws.exists('website/' + p); return r.ok && r.data.exists; };
    let command = null, script = '';
    for (const f of ['build.py', 'generate.py', 'make_site.py']) { const s = await read(f); if (s != null) { command = `${py} ${f}`; script = s; break; } }
    if (!command) { const pkg = await read('package.json'); try { if (pkg && JSON.parse(pkg).scripts?.build) command = 'npm run build'; } catch {} }
    // A framework project (Astro, Vite, Next.js, SvelteKit, Create React App): its build writes a whole output folder.
    if (command === 'npm run build' && (this.site.mode === 'app' || this.site.mode === 'generic')) {
      let deps = {}; try { const p = JSON.parse(await read('package.json')); deps = { ...p.dependencies, ...p.devDependencies }; } catch {}
      const nextCfg = (await read('next.config.js')) || (await read('next.config.mjs')) || (await read('next.config.ts')) || '';
      let out = 'next' in deps ? (/output\s*:\s*['"]export['"]/.test(nextCfg) ? 'out/' : null)
        : '@sveltejs/kit' in deps || 'react-scripts' in deps ? 'build/' : 'dist/';
      if ('@angular/core' in deps) {   // Angular: angular.json says where; the newer builder puts the pages in browser/
        try { const a = JSON.parse(await read('angular.json')); const [name, proj] = Object.entries(a.projects || {})[0] || []; const b = proj?.architect?.build || {};
          const op = b.options?.outputPath ?? (/:application$/.test(b.builder || '') ? 'dist/' + name : undefined); const base = typeof op === 'string' ? op : op?.base;
          if (base) out = base.replace(/^\.\//, '').replace(/\/$/, '') + (/:application$/.test(b.builder || '') && typeof op === 'string' ? '/browser/' : typeof op === 'object' ? '/' + (op.browser ?? 'browser') + '/' : '/');
          out = out.replace(/\/+/g, '/');
        } catch {}
      } else if (out === 'dist/') {    // Vite: root and build.outDir in vite.config (a Replit project builds client/ into dist/public/)
        const vc = (await read('vite.config.ts')) || (await read('vite.config.js')) || (await read('vite.config.mjs')) || '';
        const root = vc.match(/\broot\s*:\s*["'`]([^"'`]+)["'`]/)?.[1] || vc.match(/\broot\s*:\s*path\.resolve\([^)]*["'`]([\w./-]+)["'`]\s*\)/)?.[1] || '';
        const od = vc.match(/\boutDir\s*:\s*["'`]([^"'`]+)["'`]/)?.[1] || vc.match(/\boutDir\s*:\s*path\.resolve\([^)]*["'`]([\w./-]+)["'`]\s*\)/)?.[1];
        if (od) { const rel = path.posix.normalize(path.posix.join(/path\.resolve/.test(vc) && /outDir\s*:\s*path\.resolve/.test(vc) ? '' : root, od)).replace(/^\.\//, ''); if (!rel.startsWith('..')) out = rel.replace(/\/$/, '') + '/'; }
      }
      return { command: (await has('node_modules')) ? command : 'npm install && npm run build', generated: out ? [out] : [] };
    }
    // Hexo and Eleventy: "npm run build" writes the whole site into public/ (Hexo) or _site/ (Eleventy).
    if (command === 'npm run build' && (this.site.mode === 'hexo' || this.site.mode === 'eleventy'))
      return { command: (await has('node_modules')) ? command : 'npm install && npm run build', generated: [this.site.mode === 'hexo' ? 'public/' : '_site/'] };
    if (!command) { const mk = await read('Makefile'); if (mk && /^(build|all)\s*:/m.test(mk)) command = 'make'; }
    // Hugo / Jekyll built on this computer (the output folder is there): preview the real pages instead of a text list.
    if (!command && this.site.mode === 'hugo' && await has('public/index.html')) return { command: 'hugo', generated: ['public/'] };
    if (!command && this.site.mode === 'quarto') {   // Quarto: only when the site was rendered on this computer before (Quarto is installed)
      const out = ((await read('_quarto.yml')) || (await read('_quarto.yaml')) || '').match(/^\s*output-dir:\s*["']?([\w./-]+?)["']?\s*$/m)?.[1]?.replace(/^\.\//, '').replace(/\/$/, '') || '_site';
      if (await has(out + '/index.html')) return { command: 'quarto render', generated: [out + '/'] };
    }
    if (!command && this.site.mode === 'jekyll' && await has('_site/index.html')) return { command: (await has('Gemfile')) ? 'bundle exec jekyll build' : 'jekyll build', generated: ['_site/'] };
    if (!command) return null;
    const list = await this.ws.listFiles('website');
    const html = list.ok ? list.data.files.map(p => p.replace(/^website\//, '')).filter(p => /\.html?$/i.test(p) && !/\//.test(p)) : [];
    const generated = html.filter(p => script.includes(p));   // pages the script names, e.g. open('index.html', 'w')
    return { command, generated: generated.length ? generated : html.filter(p => /^index\.html?$/i.test(p)) };
  }
  /** Runs the build command in the website folder. Never throws; the result is kept in state and announced. */
  runBuild(reason = 'change') {
    if (!this.build) return Promise.resolve(null);
    if (this.build.running) { this.build.again = true; return this.build.running; }
    const cwd = this.ws._resolve('website').abs;
    const installs = /^npm (install|i|ci)\s*&&/.test(this.build.command) && !fsSync.existsSync(path.join(cwd, 'node_modules'));
    this.emit('build.started', { reason, installs });
    const t0 = Date.now();
    this.build.startedAt = Date.now();
    this.build.running = new Promise(resolve => {
      // "npm install && npm run build" installs only the first time: once node_modules is there, the build alone runs
      const command = /^npm (install|i|ci)\s*&&\s*/.test(this.build.command) && fsSync.existsSync(path.join(cwd, 'node_modules')) ? this.build.command.replace(/^npm (install|i|ci)\s*&&\s*/, '') : this.build.command;
      exec(command, { cwd, timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (err, stdout, stderr) => {
        const output = (String(stdout || '') + String(stderr || '')).trim().split('\n').slice(-12).join('\n').slice(-2000);
        this.build.last = { ok: !err, at: new Date().toISOString(), ms: Date.now() - t0, output, code: err ? (err.killed ? 'TIMEOUT' : err.code ?? 'ERROR') : 0 };
        this.build.running = false;
        this.emit(err ? 'build.failed' : 'build.done', this.build.last);
        resolve(this.build.last);
        if (this.build.again) { this.build.again = false; this.runBuild('again'); }
      });
    });
    return this.build.running;
  }

  async ensureGitignore() {
    const r = await this.ws.readText('.gitignore');
    const text = r.ok ? r.data.content : '';
    if (!/^\.sitetend\/?\s*$/m.test(text)) await this.ws.writeText('.gitignore', (text && !text.endsWith('\n') ? text + '\n' : text) + '.sitetend/\n');
  }

  /** Builds the provider for the active model profile and wraps it with usage + privacy logging. */
  async useActiveModel() {
    const models = await loadModels();
    const p = models.profiles.find(x => x.id === models.active) || models.profiles[0];
    let inner;
    if (p.type === 'openai-compatible') {
      const apiKey = await resolveKey(p.keyRef);
      if (p.keyRef && !apiKey) throw Object.assign(Error(`No key saved for the model "${p.label}".`), { code: 'PROVIDER_UNAVAILABLE' });
      inner = new OpenAICompatibleProvider({ endpoint: p.endpoint, model: p.model, apiKey, timeoutMs: 90000, jsonMode: p.jsonMode !== false, extraBody: p.extraBody || null });
    } else inner = new MockModelProvider();
    this.modelInfo = { id: p.id, label: p.label, local: Boolean(p.local || p.type === 'rule'), isMock: inner.isMock, model: p.model || null };
    const session = this;
    // Every model call (generate, locate, review) is logged and counted the same way.
    const tracked = (fn, label) => async (request) => {
      // the monthly spending limit: when it is used up, no call is made (the check reports it like an unreachable model)
      const priced = await currentProfile(p);   // the price as it is now (the user may have corrected it since)
      try { await spendGuard(priced); } catch (e) { return { ok: false, error: { code: e.code, message: e.message } }; }
      const t0 = Date.now();
      session.sentLog.unshift({ at: new Date().toISOString(), model: p.id, step: label, files: [request.source?.path].filter(Boolean), local: session.modelInfo.local });
      session.sentLog = session.sentLog.slice(0, 200);
      const res = await fn.call(inner, request);
      const u = res.ok ? res.data._usage : null;
      session.usage.calls++; session.usage.ms += Date.now() - t0;
      if (u) {
        spendRecord(priced, u).then(() => session.emit('spending', {})).catch(() => {});
        session.usage.promptTokens += u.prompt_tokens || 0;
        session.usage.completionTokens += u.completion_tokens || 0;
        session.usage.totalTokens += u.total_tokens || 0;
      }
      session.usage.last = { at: new Date().toISOString(), ms: Date.now() - t0, tokens: u?.total_tokens ?? null, ok: res.ok, step: label };
      session.emit('usage', session.usage);
      return res;
    };
    this.provider = {
      providerId: inner.providerId, isMock: inner.isMock,
      analyzeSourceDiff: tracked(inner.analyzeSourceDiff, 'analyze'),
      ...(inner.locateFields ? { locateFields: tracked(inner.locateFields, 'locate') } : {}),
      ...(inner.reviewProposals ? { reviewProposals: tracked(inner.reviewProposals, 'review') } : {}),
      ...(inner.classifyMaterial ? { classifyMaterial: tracked(inner.classifyMaterial, 'classify') } : {}),
    };
    if (this.analysis) this.analysis.provider = this.provider;
    return this.modelInfo;
  }

  // ---- file watching -> automatic analysis ----
  startWatching() {
    try {
      this.watcher = watchTree(this.root, physical => {
        const rel = this.ws.toLogical(physical);
        // Website files: always check. Absorbing compares content, so Sitetend's own writes are a no-op,
        // while a quick edit right after ours is still caught.
        if (rel.startsWith('website/')) return this.onWebsiteChanged(rel);
        const own = this.recentWrites.get(rel);
        if (own && Date.now() - own < 3000) return;       // our own write to a source file (e.g. demo tools)
        if (rel.startsWith('sources/')) { this.emit('source.changed', { path: rel }); this.scheduleAnalysis(); }
      }, { ignore: IGNORE, onError: e => this.emit('watch.error', { message: e.message }) });
    } catch (e) { this.emit('watch.error', { message: `Watching files is not available: ${e.message}. Use "Check for updates".` }); }
  }

  analysisDelayMs() {
    if (process.env.SITETEND_ANALYZE_DELAY_MS) return Number(process.env.SITETEND_ANALYZE_DELAY_MS);
    if (this.modelInfo.local) return 1500;
    return (Number.isFinite(this.analyzeDelaySec) ? this.analyzeDelaySec : 10) * 1000;   // cloud models wait for the user to stop editing (Advanced setting)
  }

  scheduleAnalysis() {
    if (this.core.config.autoAnalyze === 'manual') { this.emit('analysis.pending', {}); return; }
    clearTimeout(this.analyzeTimer);
    const delay = this.analysisDelayMs();
    this.emit('analysis.scheduled', { inMs: delay });
    this.analyzeTimer = setTimeout(() => this.check().catch(e => this.emit('error', { message: e.message })), delay);
  }

  /** Website files changed outside Sitetend: record the change in history right away (coalesced). */
  onWebsiteChanged(rel) {
    if (rel !== 'website/content.json' && !rel.startsWith('website/assets/') && !this.site.isContentFile?.(rel)) return;
    clearTimeout(this.externalTimer);
    this.externalTimer = setTimeout(() => {
      this.op('external', async () => {
        const r = await this.core.absorbExternal();
        if (r.ok && r.data.absorbed) {
          const conflicts = await this.analysis.markConflicts(r.data.changes.map(c => c.path)).catch(() => 0);
          this.emit('site.external_change', { changes: r.data.changes.length, conflicts });
        }
        else if (!r.ok) this.emit('site.external_change', { invalid: true, message: r.error.message });
        return r;
      }).catch(() => {});
    }, 400);   // editors often write a file several times in a row
  }

  // ---- write operations (all serialized) ----
  op(label, fn) {
    return this.queue.run(label, async () => {
      const before = this.core?.state?.baselineContentHash;
      const out = await fn();
      this.emit('state', { reason: label });
      if (this.build && this.core?.state?.baselineContentHash !== before) this.runBuild(label);   // the generated pages follow every change
      return out;
    });
  }
  /** Reads the external sources (MCP) into sources/external/. Called inside an op. Returns the paths that changed. */
  async syncExternal() {
    if (!this.sources.length) return [];
    this.emit('sources.syncing', {});
    const { report, changed } = await syncSources(this.ws, this.sources, userDir());
    for (const r of report) this.sourceStatus[r.id] = r;
    for (const id of Object.keys(this.sourceStatus)) if (!this.sources.some(x => x.id === id)) delete this.sourceStatus[id];
    await this.ws.writeJson('.sitetend/external.json', { schemaVersion: 1, status: this.sourceStatus });
    const failed = report.filter(r => !r.ok);
    this.emit('sources.synced', { changed: changed.length, files: changed, failed: failed.map(r => ({ id: r.id, name: this.sources.find(x => x.id === r.id)?.name, code: r.code, error: r.error })) });
    return changed;
  }
  /** Sources with a schedule are read again every N minutes; new content starts the usual (delayed) analysis. */
  startSourceTimer() {
    clearInterval(this.sourceTimer);
    const mins = this.sources.map(x => x.interval).filter(n => n > 0);
    if (!mins.length) return;
    this.sourceTimer = setInterval(() => {
      this.op('sync', () => this.syncExternal()).then(changed => { if (changed.length) this.scheduleAnalysis(); }).catch(e => this.emit('error', { message: e.message }));
    }, Math.min(...mins) * 60000);
    this.sourceTimer.unref?.();
  }
  check(opts = {}) {
    clearTimeout(this.analyzeTimer);
    return this.op('check', async () => {
      this.emit('analysis.started', {});
      const act = this.startActivity('check', {});
      if (opts.sync) await this.syncExternal();   // "Check for updates" also reads the external sources; automatic checks after a local edit do not
      let r;
      try { r = unwrap(await this.analysis.scan(opts)); } catch (e) { act.step({ code: 'error', status: 'fail', message: e.message }); act.end('fail'); throw e; }
      const pending = r.proposals.filter(p => p.status === 'PENDING').length;
      const results = r.scans[0]?.results || [];
      this.traceCheck(act, results);
      const failed = results.find(x => x.status === 'ERROR' && /^PROVIDER_/.test(x.code || ''));   // the model could not be reached: not "nothing to update"
      this.emit('analysis.completed', { pending, results, ...(failed ? { errorCode: failed.code } : {}) });
      return { pending, ...(failed ? { errorCode: failed.code } : {}) };
    });
  }
  accept(ids, edits = {}) { return this.tracked(ids, edits, () => this.op('accept', async () => unwrap(await this.analysis.acceptMany(ids, edits)))).then(r => this.learnFromEdits(ids, r)); }
  acceptEdited(id, value) { return this.tracked([id], { [id]: value }, () => this.op('accept', async () => unwrap(await this.analysis.acceptEdited(id, value)))).then(r => this.learnFromEdits([id], r)); }

  // ---- memory: what the owner asked Sitetend to remember (Settings > Advanced > Memory) ----
  /** After an accept: when the owner changed the suggested words the same way twice, ask whether to remember it. Rules only, no model. */
  async learnFromEdits(ids, result) {
    try {
      for (const p of this.analysis.state.proposals.filter(x => ids.includes(x.id) && x.status === 'ACCEPTED' && typeof x.editedValue === 'string' && typeof x.value === 'string')) {
        const made = await this.memory.observeEdit({ proposalId: p.id, field: p.field, suggested: p.value, final: p.editedValue });
        if (made) this.emit('memory', { candidate: made.id });
      }
    } catch { /* learning is a convenience; it never fails an accept */ }
    return result;
  }
  memoryList() { return this.memory.list(); }
  async memoryAdd(b) { const note = await this.memory.add({ kind: b.kind, text: b.text, scope: b.scope, from: { type: b.from?.type || 'manual', ref: b.from?.ref, quote: b.from?.quote }, about: b.about, lang: b.lang || null }); this.emit('memory', { added: note.id }); return note; }
  async memoryUpdate(id, b) { const note = await this.memory.update(String(id), { text: b.text, status: b.status, scope: b.scope }); this.emit('memory', { updated: note.id }); return note; }
  async memoryRemove(id) { const r = await this.memory.remove(String(id)); this.emit('memory', { removed: id }); return r; }
  async memoryCandidate(id, b) { const r = await this.memory.resolveCandidate(String(id), { remember: Boolean(b.remember), text: b.text, scope: b.scope }); this.emit('memory', { candidate: id }); return r; }
  /** From the chat ("from now on…"): remembered right away; the reply shows it with an undo button. */
  async remember({ text, kind, fields, quote }) {
    const known = new Set(this.fields().map(f => f.path));
    return this.memoryAdd({ kind: kind === 'decision' ? 'decision' : 'preference', text, from: { type: 'chat', quote }, about: { fields: (Array.isArray(fields) ? fields : []).filter(f => known.has(f)) } });
  }
  /** Why a suggestion was rejected (optional). "Not yet" and "not on my website" become a decision the model sees next time. */
  async rejectReason(id, reason, text) {
    const allowed = ['wrong', 'notYet', 'private', 'wording', 'other'];
    if (!allowed.includes(reason)) throw Object.assign(Error('Unknown reason.'), { code: 'BAD_REQUEST' });
    const { proposal } = await this.op('reject', async () => unwrap(await this.analysis.setRejectReason(String(id), reason)));
    let note = null;
    if ((reason === 'notYet' || reason === 'private') && typeof text === 'string' && text.trim())
      note = await this.memoryAdd({ kind: 'decision', text, from: { type: 'reject', ref: proposal.id, quote: proposal.quote }, about: { fields: proposal.field && !String(proposal.field).startsWith('item:') ? [proposal.field] : [] } });
    return { reason, note };
  }

  // ---- activity: what Sitetend did, step by step, shown in the conversation (like a running command you can open) ----
  /** Starts a record; steps arrive live over 'activity' events; the record is kept in the conversation when it ends. */
  startActivity(kind, params) {
    const rec = { role: 'activity', id: globalThis.crypto.randomUUID(), kind, params, status: 'running', steps: [], at: new Date().toISOString() };
    const t0 = Date.now(); let ended = false;
    this.emit('activity', rec);
    return {
      rec,
      step: s => { rec.steps.push({ status: 'ok', ...s }); this.emit('activity', rec); },
      end: status => { if (ended) return; ended = true; rec.status = status; rec.ms = Date.now() - t0; this.emit('activity', rec); this.saveActivity(rec).catch(() => {}); },
      drop: () => { ended = true; this.emit('activity.removed', { id: rec.id }); },
    };
  }
  /** Finished step logs, newest last, kept in .sitetend/activity.json (shown under History). One write at a time. */
  async activityLog() { const r = await this.ws.readJson('.sitetend/activity.json'); return r.ok && Array.isArray(r.data.data.items) ? r.data.data.items : []; }
  saveActivity(rec) {
    this.activityWrites = (this.activityWrites || Promise.resolve()).then(async () => {
      const log = await this.activityLog(); const i = log.findIndex(m => m.id === rec.id);
      if (i >= 0) log[i] = rec; else log.push(rec);
      unwrap(await this.ws.writeJson('.sitetend/activity.json', { schemaVersion: 1, items: log.slice(-100) }));
    }).catch(() => {});
    return this.activityWrites;
  }
  /** The check's log: per material, what the model concluded and what the checks around it removed. Nothing analyzed: no entry. */
  traceCheck(act, results) {
    const real = results.filter(x => x.path && !x.reused && !(x.status === 'NO_UPDATE_NEEDED' && x.unchanged));
    if (!real.length) { act.drop(); return; }
    for (const x of real) {
      // Only the model's own summary is shown: it is written in the interface language. Fixed messages from the
      // engine and the rule demo are not, and the step line already says the same thing in the right language.
      const base = { path: x.path, summary: x.byModel ? (x.message || '').replace(/\uff08[^\uff09]*\uff09$/, '').slice(0, 300) : undefined, lang: this.analysis.replyLanguage || null };
      if (x.status === 'UPDATE') act.step({ ...base, code: 'check.update', n: x.proposalCount || 0, fields: x.suggested || [] });
      else if (x.status === 'NEEDS_CLARIFICATION') act.step({ ...base, code: 'check.clarify', status: 'warn', deleted: x.kind === 'DELETED' });
      else if (x.status === 'ERROR') act.step({ ...base, code: 'check.error', status: 'fail', reason: x.code || null });
      else if (x.status === 'EXCLUDED') act.step({ path: x.path, code: 'check.private', status: 'warn' });
      else act.step({ ...base, code: 'check.none' });
      if (x.dropped) act.step({ code: 'check.dropped', n: x.dropped, status: 'warn' });
      if (x.locked) act.step({ code: 'check.locked', n: x.locked });
      for (const why of x.reviewRejected || []) act.step({ code: 'check.reviewer', status: 'warn', why });
    }
    act.end(real.some(x => x.status === 'ERROR') ? 'fail' : real.some(x => x.status === 'NEEDS_CLARIFICATION') ? 'warn' : 'ok');
  }
  /**
   * Accept, then check the result: the new words are in the website's files, and (when the site is built) on the
   * built pages. The step log turns green when everything is there, red when something is missing.
   */
  async tracked(ids, edits, run) {
    const site = this.analysis.site;
    const disk0 = (() => { try { return this.analysis.editor.draftContent; } catch { return null; } })();
    const label = f => (disk0 && site.listEditableFields(disk0).find(x => x.path === f)?.label) || String(f || '').split('::').pop();
    const props = this.analysis.state.proposals.filter(p => ids.includes(p.id) && p.status === 'PENDING')
      .map(p => ({ ...p, value: Object.hasOwn(edits, p.id) && p.kind !== 'item' ? edits[p.id] : p.value, name: p.kind === 'item' ? p.title : label(p.field) }));
    const act = this.startActivity('apply', { n: props.length, ids: props.map(p => p.id) });
    act.step({ code: 'apply.accepted', items: props.map(p => p.name) });
    let r;
    try { r = await run(); } catch (e) { act.step({ code: 'error', status: 'fail', message: e.message }); act.end('fail'); throw e; }
    if (!r?.applied) { act.step({ code: 'apply.draft', status: 'warn' }); act.end(r?.accepted ? 'warn' : 'fail'); return r; }
    const files = [...new Set(props.filter(p => p.field).map(p => String(p.field).includes('::') ? String(p.field).split('::')[0] : 'content.json'))];   // a JSON site keeps every field in content.json
    act.step({ code: 'apply.written', files: files.length ? files : ['content.json'] });
    try {
      const disk = unwrap(await this.analysis.editor._readLive()).data;
      const norm = v => JSON.stringify(v ?? null).replace(/\s+/g, ' ');
      const missing = props.filter(p => p.kind === 'asset' ? false : p.kind === 'item' ? !this.analysis.itemOnSite(p, disk)
        : norm(unwrap(site.getFieldValue(disk, p.field)).value) !== norm(p.value)).map(p => p.name);
      act.step({ code: 'verify.files', status: missing.length ? 'fail' : 'ok', n: props.length, missing });
      if (missing.length) { act.end('fail'); return r; }
      if (!this.build) { act.step({ code: 'verify.page.same' }); act.end('ok'); return r; }
      act.step({ code: 'build.running', status: 'running' });
      const b = await (this.build.running || this.runBuild('verify'));
      act.rec.steps.pop();
      if (!b?.ok) { act.step({ code: 'build.failed', status: 'fail', output: (b?.output || '').slice(-400) }); act.end('fail'); return r; }
      act.step({ code: 'build.done', ms: b.ms });
      const one = v => String(v).replace(/\s+/g, ' ').trim();
      const words = props.flatMap(p => p.kind === 'item' ? [p.title] : p.kind === 'asset' ? [] : [].concat(p.value)).map(one).filter(v => v.length > 1);
      const pages = await this.builtText();
      if (!pages) { act.step({ code: 'verify.page.skip' }); act.end('ok'); return r; }
      // as written, or as a reader sees it once Markdown is rendered (links and emphasis marks gone); long text: its start
      const absent = words.filter(w => !pages.includes(w.slice(0, 80)) && !pages.includes(one(plainMarkdown(w)).slice(0, 80)));
      act.step({ code: 'verify.page', status: absent.length ? 'fail' : 'ok', n: words.length, missing: absent.map(w => w.slice(0, 60)) });
      act.end(absent.length ? 'fail' : 'ok');
    } catch (e) { act.step({ code: 'error', status: 'fail', message: e.message }); act.end('fail'); }
    return r;
  }
  /** The words of the built pages (all generated .html files, up to a limit), tags removed, entities decoded. */
  async builtText() {
    const outs = this.build?.generated || [];
    if (!outs.length) return null;
    // Read the build output folders directly: the normal file list leaves out dist/, build/ and the like on purpose
    // (they are not the site's own files), which is exactly where most builds put their pages.
    const base = this.ws._resolve('website').abs, files = [];
    const walk = async dir => {
      for (const e of await fsSync.promises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (files.length >= 300) return;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.')) await walk(p); }
        else if (/\.html?$/i.test(e.name)) files.push(p);
      }
    };
    for (const o of outs) {
      const abs = path.resolve(base, o); if (abs !== base && !abs.startsWith(base + path.sep)) continue;   // stays inside the site
      if (o.endsWith('/')) await walk(abs); else if (/\.html?$/i.test(o)) files.push(abs);
    }
    if (!files.length) return null;
    let text = '';
    for (const f of files) { const t = await fsSync.promises.readFile(f, 'utf8').catch(() => null); if (t != null) text += ' ' + t; if (text.length > 8e6) break; }
    return decodeEntities(text.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
  }
  resolve(id, action) {
    return this.op('resolve', async () => {
      const r = unwrap(await this.analysis.resolve(id, action));
      if (action === 'retry') { this.queue.run('check', async () => { unwrap(await this.analysis.scan()); this.emit('state', { reason: 'check' }); }).catch(e => this.emit('error', { message: e.message })); }
      return r;
    });
  }
  propose(args) { return this.op('propose', async () => unwrap(await this.analysis.proposeDirect(args))); }
  proposeItem(args) { return this.op('propose', async () => unwrap(await this.analysis.proposeDirectItem(args))); }
  proposeCode(args) { return this.op('propose', async () => unwrap(await this.analysis.proposeDirectCode(args))); }
  /**
   * A page or style sheet as the chat's model reads it before writing a code change: long scripts, styles and
   * attribute values are shown as tokens (see code-edits.js). Long files: only the part around a phrase.
   */
  readPage(file, phrase = '') {
    const text = this.core.liveContent?.files?.[file];
    if (typeof text !== 'string') return { error: 'Unknown file. Pages and style sheets: ' + Object.keys(this.core.liveContent?.files || {}).filter(f => CODE_FILE.test(f)).slice(0, 60).join(', ') };
    if (!CODE_FILE.test(file)) return { error: 'Only pages (.html) and style sheets (.css) can be changed this way.' };
    const { view } = condense(text);
    if (view.length <= MAX_VIEW && !phrase) return { file, text: view };
    const part = around(view, phrase || '', 12000);
    if (part) return { file, part: true, from: part.from, text: part.text, note: 'Only part of the file (it is long). Copy "find" texts from here exactly.' };
    return { file, part: true, text: view.slice(0, MAX_VIEW), note: phrase ? `"${phrase}" is not in this file; this is its beginning.` : 'The file is long; this is its beginning. Ask again with a phrase near the place to change.' };
  }
  /** Lists on the website that can take a new item (projects, publications, members…). */
  lists() { return this.analysis.lists(); }
  /**
   * A picture for a new list item (a project card, a photo in a grid): saved next to the pictures the list already
   * uses, under a name not taken yet. Returns the address to put in the item, written like the others ("./img/x.jpg").
   */
  async itemImage(collection, field, name, bytes) {
    const coll = (this.site.listCollections?.(this.core.liveContent) || []).find(c => c.id === String(collection));
    const slot = coll?.kind === 'html' && coll.fields.find(f => f.name === String(field) && f.type === 'image');
    if (!slot) throw Object.assign(Error('This list has no picture there.'), { code: 'ITEM_IMAGE_SLOT' });
    const ext = (/\.(png|jpe?g|webp|gif|avif)$/i.exec(String(name)) || [])[1]?.toLowerCase();
    if (!ext) throw Object.assign(Error('Choose a PNG, JPG, WebP, GIF or AVIF picture.'), { code: 'ITEM_IMAGE_TYPE' });
    if (bytes.length > 15 * 1024 * 1024) throw Object.assign(Error('This picture is larger than 15 MB.'), { code: 'ITEM_IMAGE_TOO_LARGE' });
    const like = coll._slots.flat().find(x => x.name === slot.name)?.value || '';
    if (/^([a-z][\w+.-]*:|\/\/)/i.test(like)) throw Object.assign(Error('The pictures of this list are on another website, so a new one cannot be saved next to them.'), { code: 'ITEM_IMAGE_REMOTE' });
    const clean = like.split(/[?#]/)[0], dirPart = clean.includes('/') ? clean.slice(0, clean.lastIndexOf('/') + 1) : '';
    const htmlDir = path.posix.dirname(coll.file) === '.' ? '' : path.posix.dirname(coll.file) + '/';
    const folder = path.posix.normalize(dirPart.startsWith('/') ? dirPart.slice(1) : htmlDir + dirPart);
    if (folder.startsWith('..') || path.posix.isAbsolute(folder)) throw Object.assign(Error('The pictures of this list are outside the website folder.'), { code: 'ITEM_IMAGE_OUTSIDE' });
    const stem = String(name).replace(/\.[^.]+$/, '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'picture';
    let file, n = 1;
    do { file = `${stem}${n > 1 ? '-' + n : ''}.${ext === 'jpeg' ? 'jpg' : ext}`; n++; } while ((await this.ws.readBytes(path.posix.join('website', folder, file))).ok);
    unwrap(await this.ws.writeBytes(path.posix.join('website', folder, file), bytes));
    return { src: dirPart + file, file: path.posix.join(folder, file) };
  }

  // ---- chat (one conversation per workspace, stored in .sitetend/chats/) ----
  async chatLog() { const r = await this.ws.readJson('.sitetend/chats/current.json'); return r.ok && Array.isArray(r.data.data.messages) ? r.data.data.messages : []; }
  async chat(message, lang) {
    if (typeof message !== 'string' || !message.trim()) throw Object.assign(Error('Empty message'), { code: 'FIELD_VALIDATION_FAILED' });
    if (this.chatBusy) throw Object.assign(Error('Busy'), { code: 'BUSY' });
    this.chatBusy = true;
    try {
      const models = await loadModels();
      const profile = models.profiles.find(p => p.id === models.active);
      const log = await this.chatLog();
      const turnUsage = { tokens: 0 };
      await spendGuard(await currentProfile(profile));   // the monthly limit stops the chat too (rule demo and local models always run)
      const t0 = Date.now();
      this.emit('chat.thinking', {});
      const r = await chatTurn(this, { profile, history: log.map(m => ({ role: m.role, content: m.content })), message: message.slice(0, 4000), lang, notes: await this.memory.relevant({}).catch(() => []),
        onUsage: u => { if (!u) return; currentProfile(profile).then(cur => spendRecord(cur, u)).then(() => this.emit('spending', {})).catch(() => {}); this.usage.calls++; this.usage.promptTokens += u.prompt_tokens || 0; this.usage.completionTokens += u.completion_tokens || 0;
          this.usage.totalTokens += u.total_tokens || 0; turnUsage.tokens += u.total_tokens || 0; this.emit('usage', this.usage); } });
      if (profile?.type !== 'rule') { this.sentLog.unshift({ at: new Date().toISOString(), model: profile.id, files: ['(chat)'], local: this.modelInfo.local }); this.sentLog = this.sentLog.slice(0, 200); }
      const at = new Date().toISOString();
      const next = [...log, { role: 'user', content: message, at }, { role: 'assistant', content: r.reply, at: new Date().toISOString(), proposed: r.proposed, tokens: turnUsage.tokens, ms: Date.now() - t0, ...(r.remembered?.length ? { remembered: r.remembered } : {}) }].slice(-200);
      unwrap(await this.ws.writeJson('.sitetend/chats/current.json', { schemaVersion: 1, messages: next }));
      this.emit('state', { reason: 'chat' });
      return { reply: r.reply, proposed: r.proposed, tokens: turnUsage.tokens, ...(r.remembered?.length ? { remembered: r.remembered } : {}) };
    } finally { this.chatBusy = false; }
  }
  async clearChat() { unwrap(await this.ws.writeJson('.sitetend/chats/current.json', { schemaVersion: 1, messages: [] })); return {}; }
  /** Editable fields with their current values (for agents deciding what to change). */
  fields() {
    return this.core.getStatusSummary().editableFields.filter(f => !['image', 'file'].includes(f.type)).map(f => ({
      path: f.path, type: f.type, label: f.label, locked: this.core.isFieldLocked(f.path),
      value: this.site.getFieldValue(this.core.liveContent, f.path).data?.value }));
  }
  reject(id) { return this.op('reject', async () => unwrap(await this.analysis.decide(id, 'reject'))); }
  edit(field, value) {
    return this.op('edit', async () => {
      unwrap(await this.core.editDraftField(field, value));
      return unwrap(await this.core.applyIfAuto({ note: 'Manual edit: ' + field }));
    });
  }
  undo() { return this.op('undo', async () => unwrap(await this.core.undo())).then(r => { this.scheduleAnalysis(); return r; }); }
  redo() { return this.op('redo', async () => unwrap(await this.core.redo())).then(r => { this.scheduleAnalysis(); return r; }); }
  revertEntry(logId) { return this.op('revert', async () => unwrap(await this.core.revertEntry(String(logId)))).then(r => { this.scheduleAnalysis(); return r; }); }
  revertExternal(logId) { return this.op('revert', async () => unwrap(await this.core.revertExternal(String(logId)))).then(r => { this.scheduleAnalysis(); return r; }); }
  lock(field, locked) { return this.op('lock', async () => unwrap(await this.core.setFieldLock(field, locked))); }
  adoptDisk() { return this.op('adopt', async () => { unwrap(await this.core.discardDraft()); return {}; }); }
  ackDeletion(p) { return this.op('ack', async () => unwrap(await this.analysis.acknowledgeDeletion(p))); }
  setPrivacyExclude(list) {
    return this.op('settings', async () => {
      const clean = (Array.isArray(list) ? list : []).map(x => String(x).trim()).filter(x => x && x.length < 200).slice(0, 50);
      const next = { ...this.core.config, privacyExclude: clean };
      unwrap(await this.ws.writeJson('.sitetend/config.json', next)); this.core.config = next; return { privacyExclude: clean };
    });
  }
  setAutoAnalyze(mode) {
    return this.op('settings', async () => {
      const next = { ...this.core.config, autoAnalyze: mode === 'manual' ? 'manual' : 'auto' };
      unwrap(await this.ws.writeJson('.sitetend/config.json', next)); this.core.config = next; return { autoAnalyze: next.autoAnalyze };
    });
  }
  get publishMode() { const m = this.core.config.publishMode; return m === 'git' || HOSTS[m] ? m : 'manual'; }
  /** Settings for one host (no secrets: tokens are in ~/.sitetend/.env). */
  hostSettings(host) {
    const c = this.core.config[host] || {};
    return Object.fromEntries(HOSTS[host].fields.map(([k, kind]) => [k, kind === 'bool' ? Boolean(c[k]) : String(c[k] ?? '')]));
  }
  /** The folder to upload or zip, relative to the website folder: the saved choice, else the build's output folder, else the website itself. */
  get publishFolder() {
    const generated = ((this.build?.generated || []).find(g => g.endsWith('/')) || '').replace(/\/$/, '');
    return { folder: this.core.config.publishFolder ?? generated, suggestedFolder: generated };
  }
  /** A short file name for this site (for the downloaded zip). */
  siteSlug() { return path.basename(this.root).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60); }
  /** The folder whose files are published (uploaded to a host or zipped). Never outside the website folder. */
  /** The website folder itself. */
  siteDir() { return path.join(this.root, this.layout === 'site' ? '' : 'website'); }
  publishDir() {
    const base = this.siteDir();
    const dir = path.resolve(base, this.publishFolder.folder || '.');
    if (dir !== base && !dir.startsWith(base + path.sep)) throw Object.assign(Error('The folder to upload must be inside the website folder.'), { code: 'PUB_FOLDER_OUTSIDE' });
    return dir;
  }
  async publishStatus() {
    const out = { mode: this.publishMode, git: await gitStatus(this.root), ...this.publishFolder };
    for (const [host, h] of Object.entries(HOSTS)) {
      const set = this.hostSettings(host), hasToken = Boolean(await resolveKey(h.tokenKey));
      let files = null;
      if (host === this.publishMode || set[h.fields[0][0]]) { try { files = (await h.collect(this.publishDir(), this.siteDir())).files.length; } catch (e) { files = { error: e.code, file: e.file }; } }
      out[host] = { ...set, hasToken, ready: hasToken && h.fields.filter(f => f[2]).every(([k]) => set[k]), files, last: this.core.config.hostLast?.[host] || null };
    }
    return out;
  }
  /** Saves a host's settings and the folder to upload. */
  setHost(host, b) {
    const h = HOSTS[host]; if (!h) throw Object.assign(Error('Unknown host.'), { code: 'BAD_REQUEST' });
    return this.op('settings', async () => {
      const clean = v => String(v ?? '').trim().slice(0, 200);
      const set = {};
      for (const [k, kind] of h.fields) set[k] = kind === 'bool' ? Boolean(b[k]) : h.clean?.[k] ? h.clean[k](clean(b[k])) : clean(b[k]);
      const next = { ...this.core.config, [host]: set };
      if (typeof b.folder === 'string') {
        const folder = clean(b.folder).replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '');
        if (folder.split('/').includes('..') || path.isAbsolute(folder) || /^[a-z]:/i.test(folder)) throw Object.assign(Error('The folder to upload must be inside the website folder.'), { code: 'PUB_FOLDER_OUTSIDE' });
        next.publishFolder = folder;
      }
      unwrap(await this.ws.writeJson('.sitetend/config.json', next)); this.core.config = next; return this.publishStatus();
    });
  }
  async checkHost(host) {
    const h = HOSTS[host]; if (!h) throw Object.assign(Error('Unknown host.'), { code: 'BAD_REQUEST' });
    const info = await h.check({ token: await resolveKey(h.tokenKey), ...this.hostSettings(host) });
    const files = (await h.collect(this.publishDir(), this.siteDir())).files.length;
    return { ...info, files };
  }
  setPublishMode(mode) {
    return this.op('settings', async () => {
      const next = { ...this.core.config, publishMode: mode === 'git' || HOSTS[mode] ? mode : 'manual' };
      unwrap(await this.ws.writeJson('.sitetend/config.json', next)); this.core.config = next; return { publishMode: next.publishMode };
    });
  }
  /** Git mode: commit website/ and push, then record the version as live. Manual mode: just record it. */
  publish() {
    return this.op('publish', async () => {
      const ab = await this.core.absorbExternal(); if (!ab.ok) unwrap(ab);
      const s = this.core.getStatusSummary();
      if (s.hasUnsavedDraft) throw Object.assign(Error('There are changes not written yet. Apply them first.'), { code: 'STALE_DRAFT_DETECTED' });
      let detail = null;
      if (this.publishMode === 'git') detail = await gitPublish(this.root, { paths: [this.layout === 'site' ? '.' : 'website'], message: `Sitetend: publish ${new Date().toISOString()}` });
      const host = HOSTS[this.publishMode];
      if (host) {
        // A site with a build step: upload what the latest build wrote, and only if it worked.
        if (this.build?.running) await this.build.running.catch(() => {});
        if (this.build?.last && !this.build.last.ok) throw Object.assign(Error('The last build failed, so the uploaded site would be out of date. Fix the build first.'), { code: 'PUB_BUILD_FAILED' });
        detail = await host.publish({ token: await resolveKey(host.tokenKey), ...this.hostSettings(this.publishMode), dir: this.publishDir(), root: this.siteDir(), onProgress: p => this.emit('publish.progress', p) });
        const last = { at: new Date().toISOString(), url: detail.url, live: detail.live, files: detail.files, uploaded: detail.uploaded, production: detail.production };
        const next = { ...this.core.config, hostLast: { ...(this.core.config.hostLast || {}), [this.publishMode]: last } };
        unwrap(await this.ws.writeJson('.sitetend/config.json', next)); this.core.config = next;
      }
      const r = unwrap(await this.core.markPublished({ publishedHash: s.baselineHash, publisherId: this.publishMode === 'git' ? 'git-push' : host ? host.id : 'manual-git', detail }));
      unwrap(await this.ws.writeJson('.sitetend/published.json', { schemaVersion: 1, hash: s.baselineHash, at: new Date().toISOString(), content: this.core.liveContent }));
      return { ...detail, mode: this.publishMode, status: r };
    });
  }
  markPublished() {
    return this.op('publish', async () => {
      const s = this.core.getStatusSummary();
      const r = unwrap(await this.core.markPublished({ publishedHash: s.baselineHash, publisherId: 'manual-git' }));
      unwrap(await this.ws.writeJson('.sitetend/published.json', { schemaVersion: 1, hash: s.baselineHash, at: new Date().toISOString(), content: this.core.liveContent }));
      return r;
    });
  }

  /** What "Original" means when no suggestion is selected: the published version, else the version when this session opened. */
  async compareBase() {
    const pub = this.core.state.published;
    if (pub) {
      const r = await this.ws.readJson('.sitetend/published.json');
      if (r.ok && r.data.data.hash === pub.hash) return { kind: 'published', at: pub.at, content: r.data.data.content };
    }
    return { kind: 'opened', content: this.openedContent };
  }

  /** Compact state for the UI (no full file contents except the site content needed for preview). */
  async fullState() {
    const st = this.state(), base = await this.compareBase();
    // The same as the current site (the usual case): the UI falls back to the current content, so it is not sent twice.
    if (base?.content && sameContent(base.content, st.content)) base.content = null;
    return { ...st, compareBase: base };
  }
  state() {
    const s = this.core.getStatusSummary();
    const a = this.analysis.summary();
    return {
      workspace: { root: this.root, label: path.basename(this.root) }, siteAdapter: this.site.adapterId, siteMode: this.site.mode || null,
      model: this.modelInfo, usage: this.usage,
      queue: { busy: !this.queue.idle, running: this.queue.running },
      autoAnalyze: this.core.config.autoAnalyze || 'auto',
      publishMode: this.publishMode,
      privacy: { defaults: DEFAULT_PRIVACY_PATTERNS, extra: this.core.config.privacyExclude || [] },
      canUndo: s.canUndo, canRedo: s.canRedo,
      published: s.published, liveIsPublished: s.liveIsPublished, undoLeavesPublished: s.undoLeavesPublished,
      externalEditDetected: s.externalEditDetected,
      skippedFiles: this.site.skipped || [],   // too large to read, or beyond 1,000 pages
      notUtf8Files: this.site.notUtf8 || [],
      recovered: Boolean(this.recovered),   // a write cut off last time was finished when the site was opened   // saved in an older encoding: left alone so their characters are not damaged
      lockedFields: s.lockedFields,
      editableFields: s.editableFields.map(f => ({ path: f.path, label: f.label, section: f.section, type: f.type })),
      content: s.liveContent,
      proposals: a.proposals.filter(p => ['PENDING', 'CONFLICT', 'STALE'].includes(p.status)).slice(-50),
      lastScan: a.scans[0] || null,
      history: s.state.maintenanceLogs.slice(0, 50),
      sentLog: this.sentLog.slice(0, 20),
      build: this.build ? { command: this.build.command, generated: this.build.generated, running: Boolean(this.build.running), startedAt: this.build.running ? this.build.startedAt : null, last: this.build.last } : null,
      buildSuggestion: this.buildSuggestion || null,
      sources: this.sources.map(x => ({ id: x.id, name: x.name, transport: x.transport, url: x.url || null, command: x.command || null, tokenEnv: x.tokenEnv || null,
        hasKey: Boolean(x.keyRef), interval: x.interval, items: x.items, last: this.sourceStatus?.[x.id] || null })),
    };
  }

  /** Today's backup, if backups are on and there is none yet. A failed backup is reported once and does not stop work. */
  async backupToday() {
    const day = new Date().toDateString(); if (this.backupDay === day) return;
    if ((await loadSettings()).backups === false) { this.backupDay = day; return; }
    try { const made = await this.backups.daily(); this.backupDay = day; if (made) this.emit('backup.made', { file: made.file }); }
    catch (e) { this.backupDay = day; this.emit('backup.failed', { message: e.message, code: e.code || null }); }
  }
  async listBackups() { return { dir: this.backups.dir, list: await this.backups.list() }; }
  backupNow() { return this.op('backup', async () => { const made = await this.backups.make('manual'); this.emit('backup.made', { file: made.file }); return made; }); }
  /** Puts the whole site back as it was in a backup (the current site is backed up first); recorded in history. */
  restoreBackup(file) {
    return this.op('restore-backup', async () => {
      if (this.core.hasUnsavedDraft) throw Object.assign(Error('There are changes not written yet. Apply them first.'), { code: 'STALE_DRAFT_DETECTED' });
      const r = await this.backups.restore(file);
      const date = (file.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || file;
      this.recentWrites.set('*', Date.now());
      unwrap(await this.core.absorbExternal({ note: `Restored the backup of ${date}` }));
      return { ...r, date };
    });
  }
  close() { clearInterval(this.backupTimer); clearInterval(this.sourceTimer); clearTimeout(this.analyzeTimer); clearTimeout(this.externalTimer); this.watcher?.close(); }
}
