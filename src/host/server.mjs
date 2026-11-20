// @ts-check
// Sitetend host: local HTTP API + SSE + static UI. Listens on 127.0.0.1 only.
import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import './node-polyfills.mjs';
import { WorkspaceSession, HOSTS, isSiteFolder, nestedSiteFolder, isGenericSiteFolder } from './workspace-session.mjs';
import { MAX_MATERIAL_BYTES } from './materials.mjs';
import { checkForUpdate, APP_VERSION } from './updates.mjs';
import { status as spendingStatus } from './spending.mjs';
import { zipFolder } from './backups.mjs';
import { loadModels, saveModels, loadSettings, saveSettings, setEnvKey, resolveKey, userDir, hostFile } from './user-config.mjs';
import { cleanSource, clientConfig, discover } from './external-sources.mjs';
import { Webhooks, EVENTS as HOOK_EVENTS } from './webhooks.mjs';
import { checkServerUrl } from './mcp-client.mjs';
import * as desktop from './desktop.mjs';
import { LANGUAGE_CODES } from './languages.mjs';

const APP_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.pdf': 'application/pdf', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.woff': 'font/woff', '.woff2': 'font/woff2', '.webp': 'image/webp', '.wasm': 'application/wasm', '.gif': 'image/gif', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.htm': 'text/html; charset=utf-8', '.ttf': 'font/ttf', '.otf': 'font/otf', '.bcmap': 'application/octet-stream', '.md': 'text/plain; charset=utf-8' };
const MOBILE_UA = /Android|iPhone|iPod|Mobile|IEMobile|Opera Mini/i;
const MAX_BODY = 2 * 1024 * 1024;
// What an outside agent (MCP) may call. Everything else (settings, keys, publishing, direct edits) is refused.
const MCP_READ = new Set(['GET /api/state', 'GET /api/fields', 'GET /api/lists', 'POST /api/check', 'POST /api/proposals/propose', 'POST /api/proposals/propose-item', 'POST /api/proposals/propose-code', 'POST /api/page']);
const MCP_WRITE = new Set(['POST /api/proposals/accept', 'POST /api/proposals/reject', 'POST /api/undo', 'POST /api/redo']);

// Windows: the modern Explorer-style "Select folder" dialog (IFileOpenDialog + FOS_PICKFOLDERS) instead of the old
// tree-view FolderBrowserDialog that Windows PowerShell 5.1 (.NET Framework) shows. Owned by the foreground window
// (the browser the user just clicked in) so it opens on top, and DPI-aware so it is sharp on high-resolution screens. No fallback to the old dialog: if this fails, the
// welcome page tells the user to paste the folder path instead.
const WIN_PICKER = String.raw`
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$src = @"
using System; using System.Runtime.InteropServices;
public static class SitetendPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogCo {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint c, IntPtr f); void SetFileTypeIndex(uint i); void GetFileTypeIndex(out uint i);
    void Advise(IntPtr p, out uint c); void Unadvise(uint c);
    void SetOptions(uint fos); void GetOptions(out uint fos);
    void SetDefaultFolder(IShellItem si); void SetFolder(IShellItem si);
    void GetFolder(out IShellItem si); void GetCurrentSelection(out IShellItem si);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string n); void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string n);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string t); void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void GetResult(out IShellItem si);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv); void GetParent(out IShellItem si);
    void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
    void GetAttributes(uint mask, out uint attr); void Compare(IShellItem si, uint hint, out int order);
  }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  // Windows PowerShell is not DPI-aware, so on a high-resolution screen Windows draws the dialog small and scales it
  // up (blurry). Declaring per-monitor awareness first makes it draw at the screen's real resolution.
  static void Sharp() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch {}   // PER_MONITOR_AWARE_V2 (Windows 10 1703+)
    try { SetProcessDPIAware(); } catch {}
  }
  public static string Pick(string title) {
    Sharp();
    IFileDialog d = (IFileDialog)new FileOpenDialogCo();
    uint o; d.GetOptions(out o); d.SetOptions(o | 0x20 | 0x40); // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
    if (!String.IsNullOrEmpty(title)) d.SetTitle(title);
    if (d.Show(GetForegroundWindow()) != 0) return null; // cancelled
    IShellItem r; d.GetResult(out r); string p; r.GetDisplayName(0x80058000, out p); return p; // SIGDN_FILESYSPATH
  }
}
"@
Add-Type -TypeDefinition $src -ErrorAction Stop; $p = [SitetendPicker]::Pick($env:SITETEND_PICK_TITLE); if ($p) { $p }`;

/** Native folder picker on the user's machine (the host runs locally).
 * Returns { path } on a pick, { path: null } when the user cancels, { path: null, unavailable: true } when no picker could open. */
async function pickFolder(title = 'Choose your website folder') {
  const run = (cmd, args, env) => new Promise(resolve => execFile(cmd, args, { timeout: 5 * 60 * 1000, windowsHide: true, env: env ? { ...process.env, ...env } : process.env },
    (err, out) => resolve(err ? (err.code === 1 && cmd !== 'powershell' ? { path: null } : { path: null, unavailable: true }) : { path: String(out).trim() || null })));
  // osascript / zenity / kdialog exit with code 1 on Cancel; PowerShell prints nothing on Cancel and exits non-zero only on failure.
  if (process.platform === 'darwin') return run('osascript', ['-e', `POSIX path of (choose folder with prompt ${JSON.stringify(title)})`]);
  if (process.platform === 'win32') return run('powershell', ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(WIN_PICKER, 'utf16le').toString('base64')], { SITETEND_PICK_TITLE: title });
  const z = await run('zenity', ['--file-selection', '--directory', `--title=${title}`]);
  return z.unavailable ? run('kdialog', ['--getexistingdirectory', process.env.HOME || '/', '--title', title]) : z;
}

const stagedViews = new Map();   // id -> { files, marks, label }: a suggestion shown in the browser before it is accepted

/** Adds a small banner and a highlight of the changed words to a page shown with a suggestion in place. */
function markChange(html, staged) {
  const data = JSON.stringify({ marks: staged.marks, label: staged.label }).replace(/</g, '\\u003c');
  const js = `(function(){var D=${data};var done=false;function bar(){try{if(window.self!==window.top)return}catch(e){return}if(document.getElementById('sitetend-bar')||!document.body)return;var b=document.createElement('div');b.id='sitetend-bar';b.setAttribute('style','position:fixed;z-index:2147483647;left:50%;bottom:16px;transform:translateX(-50%);max-width:90vw;background:#1d2733;color:#fff;font:13px/1.4 system-ui,sans-serif;padding:8px 12px;border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,.3);display:flex;gap:10px;align-items:center');var t=document.createElement('span');t.textContent=D.label||'Sitetend';var x=document.createElement('button');x.textContent='\\u00d7';x.setAttribute('style','background:none;border:0;color:#fff;font-size:16px;cursor:pointer');x.onclick=function(){b.remove()};b.append(t,x);document.body.append(b)}
function mark(root){if(!D.marks.length)return;var w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),n,hit=[];while(n=w.nextNode()){var v=n.nodeValue.replace(/\\s+/g,' ');for(var i=0;i<D.marks.length;i++){if(v.indexOf(D.marks[i].slice(0,60))>=0){var e=n.parentElement;if(e&&!e.hasAttribute('data-sitetend-mark')&&e.closest('#sitetend-bar')==null){e.setAttribute('data-sitetend-mark','');e.style.outline='3px solid #f2b705';e.style.outlineOffset='3px';e.style.background='rgba(242,183,5,.18)';hit.push(e)}break}}}if(hit.length&&!done){done=true;setTimeout(function(){hit[0].scrollIntoView({block:'center',behavior:'smooth'})},400)}}
function go(){bar();mark(document.body);new MutationObserver(function(m){for(var i=0;i<m.length;i++)for(var j=0;j<m[i].addedNodes.length;j++){var a=m[i].addedNodes[j];if(a.nodeType===1)mark(a);else if(a.nodeType===3&&a.parentElement)mark(a.parentElement)}}).observe(document.body,{childList:true,subtree:true})}
if(document.body)go();else document.addEventListener('DOMContentLoaded',go)})();`;
  const tag = `<script data-sitetend>${js}</script>`;
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, tag + '</head>') : tag + html;
}

/** Compares two secrets in constant time; different lengths are simply unequal (timingSafeEqual would throw). */
const sameSecret = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };

class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }

/**
 * @param {{ port?: number, token?: string, workspace?: string|null, log?: (s:string)=>void, onQuit?: (()=>void)|null }} opts
 */
export async function startHost({ port = 54321, token = crypto.randomBytes(24).toString('base64url'), viewKey = crypto.randomBytes(18).toString('base64url'), workspace = null, log = console.log, onQuit = null } = {}) {
  let traySwitch = null;   // set by the launcher (bin/sitetend.mjs), which owns the tray icon
  /** @type {WorkspaceSession|null} */
  let session = null;
  const clients = new Set();
  let siteLabel = null;   // the open site's display name, for webhook messages
  const hooks = new Webhooks({
    list: async () => (await loadSettings()).webhooks || [],
    secret: async h => resolveKey(h.secretRef),
    lang: async () => (await loadSettings()).language,
  });
  const emit = (type, data = {}) => {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
    hooks.onHostEvent(type, data, siteLabel).catch(() => {});
  };
  const INCOMING_KEY = 'SITETEND_INCOMING_KEY';
  const keyName = (prefix, id) => prefix + id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  async function hookList() {
    const s = await loadSettings();
    return {
      events: HOOK_EVENTS,
      hooks: await Promise.all((s.webhooks || []).map(async h => ({ id: h.id, url: h.url, events: h.events, secret: await resolveKey(h.secretRef), last: hooks.last.get(h.id) || null }))),
      incoming: { enabled: Boolean(s.incomingHook), key: s.incomingHook ? await resolveKey(INCOMING_KEY) : null, url: `http://127.0.0.1:${actualPort}/hooks/check` },
    };
  }
  /** Saves this site's external sources and hands them to the open session. */
  async function saveSources(list) {
    const root = need().root; const s = await loadSettings();
    s.siteSources = { ...(s.siteSources || {}) };
    if (list.length) s.siteSources[root] = list; else delete s.siteSources[root];
    await saveSettings(s);
    session.sources = list; session.startSourceTimer();
    emit('state', { reason: 'sources' });
    return session.state().sources;
  }

  /** A website folder, or a project folder with website/ inside. */
  async function looksLikeSite(root) {
    if (await fs.stat(path.join(root, 'website')).catch(() => null)) return true;
    return isSiteFolder(root);
  }
  /** A readable name for a site: the site's own title (content.json name/title, _config.yml, hugo config, <title>), else the folder name. */
  async function siteTitle(root) {
    const read = async p => fs.readFile(path.join(root, p), 'utf8').catch(() => null);
    // a config value: the text inside quotes, else the bare value without a trailing # comment; "blank" (al-folio) = no title
    const clean = s => { let v = String(s || '').trim(); const q = /^(["'])(.*?)\1/.exec(v); v = q ? q[2] : v.replace(/\s+#.*$/, '');
      v = v.replace(/\s+/g, ' ').trim(); return v && !/^(blank|~|null)$/i.test(v) ? v.slice(0, 60) : null; };
    for (const base of ['website/', '']) {
      const json = await read(base + 'content.json');
      if (json) { try { const d = JSON.parse(json); const n = d.profile?.name || d.site?.title || d.site?.name || d.title || d.name || d.person?.name; if (typeof n === 'string' && clean(n)) return clean(n); } catch {} }
      for (const f of ['_quarto.yml', '_quarto.yaml']) { const y = await read(base + f); const m = y && /^website:[\s\S]*?^\s+title:\s*(.+)$/m.exec(y); if (m && clean(m[1])) return clean(m[1]); }
      { const y = await read(base + 'mkdocs.yml'); const m = y && /^site_name:\s*(.+)$/m.exec(y); if (m && clean(m[1])) return clean(m[1]); }
      for (const f of ['_config.yml', '_config.yaml']) { const y = await read(base + f); const m = y && /^title:\s*(.+)$/m.exec(y); if (m && clean(m[1])) return clean(m[1]); }
      for (const f of ['hugo.toml', 'config.toml']) { const t = await read(base + f); const m = t && /^title\s*=\s*(.+)$/m.exec(t); if (m && clean(m[1])) return clean(m[1]); }
      for (const f of ['hugo.yaml', 'hugo.yml', 'config.yml', 'config.yaml']) { const y = await read(base + f); const m = y && /^title:\s*(.+)$/m.exec(y); if (m && clean(m[1])) return clean(m[1]); }
      for (const f of ['index.html', 'index.htm', 'index.php', 'header.php', 'templates/base.html', 'templates/index.html']) { const h = await read(base + f); const t = h && /<title[^>]*>([^<]+)<\/title>/i.exec(h); if (t && clean(t[1])) return clean(t[1].replace(/&amp;/g, '&')); }
      // a framework project: its package name ("the-low-tides" -> "The Low Tides"), unless it is a template's default
      { const p = await read(base + 'package.json'); try { const n = p && JSON.parse(p).name; if (typeof n === 'string' && !/^(my-|vite-|astro-|next-|create-|app$|site$|website$|portfolio$|template)/i.test(n.replace(/^@[^/]+\//, ''))) { const t = n.replace(/^@[^/]+\//, '').split(/[-_]+/).map(w => w[0]?.toUpperCase() + w.slice(1)).join(' '); if (clean(t)) return clean(t); } } catch {} }
    }
    return null;
  }
  const demoKind = root => Object.entries(DEMOS).find(([, dir]) => path.resolve(root) === path.resolve(path.join(userDir(), dir)))?.[0] || null;
  /** The saved websites (most recent first), with display names. A folder that no longer exists is kept but marked missing. */
  async function listSites() {
    const s = await loadSettings(); let learned = false;
    const out = await Promise.all((s.recentWorkspaces || []).map(async p => {
      const missing = !(await fs.stat(p).catch(() => null))?.isDirectory();
      if (!missing && !(p in (s.siteTitles || {}))) { s.siteTitles = { ...(s.siteTitles || {}), [p]: await siteTitle(p) }; learned = true; }   // saved before names existed
      const custom = s.siteNames?.[p] || null, auto = s.siteTitles?.[p] || null;
      return { path: p, name: custom || auto || path.basename(p), custom: Boolean(custom), demo: demoKind(p), missing, current: Boolean(session && path.resolve(session.root) === path.resolve(p)) };
    }));
    if (learned) await saveSettings(s);
    return out;
  }

  async function openWorkspace(root) {
    const st = await fs.stat(root).catch(() => null);
    if (!st?.isDirectory()) throw new HttpError(400, `Folder not found: ${root}`, 'WORKSPACE_FILE_NOT_FOUND');
    if (!(await looksLikeSite(root))) { const inner = nestedSiteFolder(root); if (inner) root = inner; }   // the website is one folder down
    // a kind of site Sitetend does not know by name: open it if it holds web pages or front-end code (not a Documents folder)
    if (!(await looksLikeSite(root)) && !isGenericSiteFolder(root)) throw new HttpError(400, 'No web pages or website files in this folder.', 'NOT_A_SITE');
    const s = await loadSettings();
    const next = await new WorkspaceSession({ root, emit, build: s.siteBuild?.[root] || null, sources: s.siteSources?.[root] || [] }).open();
    session?.close();
    session = next;
    session.analyzeDelaySec = s.analyzeDelaySec;
    session.analysis.replyLanguage = s.language;
    session.analysis.reviewer = s.reviewer;
    s.recentWorkspaces = [root, ...s.recentWorkspaces.filter(x => x !== root)].slice(0, 30);   // the saved-sites list
    s.siteTitles = { ...(s.siteTitles || {}), [root]: await siteTitle(root) };
    siteLabel = s.siteNames?.[root] || s.siteTitles[root] || path.basename(root);
    for (const k of Object.keys(s.siteTitles)) if (!s.recentWorkspaces.includes(k)) delete s.siteTitles[k];
    await saveSettings(s);
    emit('state', { reason: 'open' });
    return session.fullState();
  }

  // Two demo websites with different structures (portfolio, academic homepage); both use the generic adapter.
  const DEMOS = { portfolio: 'demo-workspace', academic: 'demo-academic' };
  async function openDemo(reset = false, kind = 'portfolio') {
    const name = DEMOS[kind] || DEMOS.portfolio;
    const dir = path.join(userDir(), name);
    if (reset) await fs.rm(dir, { recursive: true, force: true });
    const exists = await fs.stat(path.join(dir, 'website/content.json')).catch(() => null);
    if (!exists) await fs.cp(path.join(APP_ROOT, name), dir, { recursive: true });
    else {   // keep an older copy's look up to date. These three files hold no words the user can change
      // (every editable word of a sample site lives in website/content.json); content.json and the materials stay.
      for (const file of ['website/style.css', 'website/app.js', 'website/index.html']) {
        const shipped = await fs.readFile(path.join(APP_ROOT, name, file), 'utf8').catch(() => null);
        const mine = await fs.readFile(path.join(dir, file), 'utf8').catch(() => null);
        if (shipped != null && shipped !== mine) await fs.writeFile(path.join(dir, file), shipped);
      }
    }
    return openWorkspace(dir);
  }

  const need = () => { if (!session) throw new HttpError(409, 'No website is open.', 'NO_WORKSPACE'); return session; };

  /** @type {Record<string, (body:any, url:URL)=>Promise<any>>} */
  const routes = {
    'GET /api/state': async () => ({ host: { version: APP_VERSION, view: '/view/' + viewKey + '/', userDir: userDir(), platform: process.platform, bin: path.join(APP_ROOT, 'bin', 'sitetend.mjs'), node: process.execPath }, settings: await loadSettings(), sites: await listSites(), workspace: session ? await session.fullState() : null }),
    'POST /api/workspace/pick': async body => pickFolder(typeof body?.title === 'string' && body.title.trim() ? body.title.slice(0, 120) : undefined),
    // Daily full-site backups (.zip files in the user's folder)
    'GET /api/backups': async () => ({ enabled: (await loadSettings()).backups !== false, ...(await need().listBackups()) }),
    'POST /api/backups/now': async () => need().backupNow(),
    'POST /api/backups/restore': async b => need().restoreBackup(String(b.file || '')),
    'POST /api/backups/reveal': async () => {
      const dir = need().backups.dir; await fs.mkdir(dir, { recursive: true });
      const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      execFile(cmd, [dir], () => {}); return { dir };
    },
    'POST /api/workspace/reveal': async b => {
      const sub = ['sources', 'website'].includes(b.which) ? b.which : 'sources';
      const dir = need().ws._resolve(sub).abs;
      const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      execFile(cmd, [dir], () => {});   // explorer.exe exits non-zero even on success; nothing to report
      return { path: dir };
    },
    'GET /api/sites': async () => listSites(),
    'GET /api/ping': async () => ({ app: 'sitetend', pid: process.pid }),
    // Open like an app: shortcut, start at sign-in, tray icon, quit. Owner only (not MCP).
    'GET /api/app': async () => ({ ...(await desktop.status()), tray: (await loadSettings()).tray !== false, canQuit: Boolean(onQuit) }),
    'POST /api/app/shortcut': async () => { try { return { ...(await desktop.createShortcut()), tray: (await loadSettings()).tray !== false, canQuit: Boolean(onQuit) }; } catch (e) { throw new HttpError(400, e.message, 'DESKTOP_FAILED'); } },
    'POST /api/app/login': async b => { try { return { ...(await desktop.setLogin(Boolean(b.enabled))), tray: (await loadSettings()).tray !== false, canQuit: Boolean(onQuit) }; } catch (e) { throw new HttpError(400, e.message, 'DESKTOP_FAILED'); } },
    'POST /api/app/tray': async b => {
      const s = await loadSettings(); s.tray = Boolean(b.enabled); await saveSettings(s); traySwitch?.(s.tray);
      return { ...(await desktop.status()), tray: s.tray, canQuit: Boolean(onQuit) };
    },
    'POST /api/host/quit': async () => { if (!onQuit) throw new HttpError(400, 'Not available here.', 'NOT_AVAILABLE'); setTimeout(onQuit, 150); return { quitting: true }; },
    // Build step: set by the owner here (stored in ~/.sitetend/settings.json, not in the website folder, so a downloaded
    // site cannot make Sitetend run a command). Not available to MCP agents.
    'POST /api/build/config': async b => {
      const root = need().root; const s = await loadSettings();
      const command = String(b.command || '').trim().slice(0, 500);
      const generated = (Array.isArray(b.generated) ? b.generated : String(b.generated || '').split(/[,\n]/)).map(x => String(x).trim()).filter(Boolean).slice(0, 50);
      if (generated.some(g => g.includes('..') || path.isAbsolute(g))) throw new HttpError(400, 'Generated files must be inside the website folder.', 'BAD_PATH');
      s.siteBuild = { ...(s.siteBuild || {}) };
      if (command) s.siteBuild[root] = { command, generated }; else delete s.siteBuild[root];
      await saveSettings(s);
      const st = await openWorkspace(root);   // the adapter must leave the generated files alone from now on
      if (command) session.runBuild('setup');   // not awaited: the first build (npm install) can take minutes; progress comes as events
      return st;
    },
    'POST /api/build/run': async () => { const s = need(); if (!s.build) throw new HttpError(400, 'No build command is set.', 'NO_BUILD'); s.runBuild('manual'); return { started: true }; },   // progress and result come as build.* events
    'POST /api/sites/rename': async b => {   // empty name: back to the automatic one
      const s = await loadSettings(); const p = String(b.path || ''); const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!s.recentWorkspaces.includes(p)) throw new HttpError(404, 'Not a saved website.', 'NOT_FOUND');
      s.siteNames = { ...(s.siteNames || {}) }; if (name) s.siteNames[p] = name; else delete s.siteNames[p];
      await saveSettings(s); return listSites();
    },
    'POST /api/sites/remove': async b => {   // only forgets it: no file is touched
      const s = await loadSettings(); const p = String(b.path || '');
      s.recentWorkspaces = s.recentWorkspaces.filter(x => x !== p);
      if (s.siteNames) delete s.siteNames[p]; if (s.siteTitles) delete s.siteTitles[p];
      await saveSettings(s); return listSites();
    },
    // External materials through MCP servers (owner only: commands and addresses are never accepted from MCP agents).
    'POST /api/sources/discover': async b => {
      const saved = b.id ? (need().sources.find(x => x.id === b.id) || null) : null;
      const src = cleanSource({ ...(saved || {}), ...b, name: b.name || saved?.name || 'source', items: [] }, saved);
      if (src.transport === 'http') checkServerUrl(src.url);
      const token = typeof b.token === 'string' && b.token.trim() ? b.token.trim() : undefined;
      try { return await discover(await clientConfig(src, userDir(), token)); }
      catch (e) { throw new HttpError(400, e.message, e.code || 'MCP_ERROR'); }
    },
    'POST /api/sources/save': async b => {
      const list = [...need().sources]; const i = list.findIndex(x => x.id === b.id);
      const src = cleanSource(b, i >= 0 ? list[i] : null);
      if (src.transport === 'http') checkServerUrl(src.url);
      if (typeof b.token === 'string' && b.token.trim()) { src.keyRef = keyName('SITETEND_MCP_', src.id); await setEnvKey(src.keyRef, b.token.trim()); }
      else if (b.clearToken && src.keyRef) { await setEnvKey(src.keyRef, ''); src.keyRef = null; }
      if (i >= 0) list[i] = src; else list.push(src);
      return saveSources(list);
    },
    'POST /api/sources/remove': async b => {
      const list = need().sources; const src = list.find(x => x.id === b.id);
      if (!src) throw new HttpError(404, 'Not found', 'NOT_FOUND');
      if (src.keyRef) await setEnvKey(src.keyRef, '');
      return saveSources(list.filter(x => x !== src));   // files already read stay in sources/external/ (they are the owner's materials now)
    },
    'POST /api/sources/sync': async () => need().check({ sync: true }),
    // Webhooks (owner only).
    'GET /api/webhooks': async () => hookList(),
    'POST /api/webhooks/save': async b => {
      const s = await loadSettings(); const list = [...(s.webhooks || [])];
      const url = checkServerUrl(b.url).href;
      const events = (Array.isArray(b.events) ? b.events : []).filter(e => HOOK_EVENTS.includes(e));
      if (!events.length) throw new HttpError(400, 'Pick at least one event.', 'BAD_HOOK');
      const i = list.findIndex(h => h.id === b.id);
      if (i >= 0) list[i] = { ...list[i], url, events };
      else {
        if (list.length >= 10) throw new HttpError(400, 'At most 10 webhooks.', 'BAD_HOOK');
        const id = 'hook-' + crypto.randomBytes(4).toString('hex'); const secretRef = keyName('SITETEND_HOOK_', id);
        await setEnvKey(secretRef, crypto.randomBytes(24).toString('hex'));
        list.push({ id, url, events, secretRef });
      }
      s.webhooks = list; await saveSettings(s); return hookList();
    },
    'POST /api/webhooks/remove': async b => {
      const s = await loadSettings(); const h = (s.webhooks || []).find(x => x.id === b.id);
      if (!h) throw new HttpError(404, 'Not found', 'NOT_FOUND');
      await setEnvKey(h.secretRef, ''); s.webhooks = s.webhooks.filter(x => x !== h); hooks.last.delete(h.id);
      await saveSettings(s); return hookList();
    },
    'POST /api/webhooks/test': async b => {
      const h = ((await loadSettings()).webhooks || []).find(x => x.id === b.id);
      if (!h) throw new HttpError(404, 'Not found', 'NOT_FOUND');
      return hooks.deliver(h, 'test', siteLabel, {});
    },
    'POST /api/webhooks/incoming': async b => {
      const s = await loadSettings(); s.incomingHook = Boolean(b.enabled);
      if (s.incomingHook && (b.regenerate || !(await resolveKey(INCOMING_KEY)))) await setEnvKey(INCOMING_KEY, crypto.randomBytes(24).toString('base64url'));
      if (!s.incomingHook) await setEnvKey(INCOMING_KEY, '');
      await saveSettings(s); return hookList();
    },
    'POST /api/workspace/close': async () => { session?.close(); session = null; emit('state', { reason: 'close' }); return {}; },
    'POST /api/proposals/resolve': async b => need().resolve(String(b.id), ['dismiss', 'overwrite', 'retry'].includes(b.action) ? b.action : 'dismiss'),
    'POST /api/workspace/open': async b => openWorkspace(String(b.path || '')),
    // The chosen folder is not a website (e.g. Desktop or a parent folder): look inside it for websites.
    'POST /api/workspace/find': async b => {
      const start = path.resolve(String(b.path || ''));
      if (!(await fs.stat(start).catch(() => null))?.isDirectory()) throw new HttpError(400, 'Not a folder', 'WORKSPACE_FILE_NOT_FOUND');
      const SKIP = /^(\.|node_modules$|_site$|dist$|build$|vendor$|AppData$|Library$|Applications$|Program Files|Windows$|\$Recycle\.Bin$|System Volume Information$)/i;
      const found = [], queue = [[start, 0]]; let seen = 0;
      while (queue.length && seen < 3000 && found.length < 12) {
        const [dir, depth] = queue.shift(); seen++;
        if (dir !== start && await looksLikeSite(dir)) { found.push(dir); continue; }   // do not look inside a website
        if (depth >= 4) continue;
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const e of entries) if (e.isDirectory() && !SKIP.test(e.name)) queue.push([path.join(dir, e.name), depth + 1]);
      }
      return { folder: start, sites: await Promise.all(found.map(async p => ({ path: p, name: (await siteTitle(p)) || path.basename(p), rel: path.relative(start, p) }))) };
    },
    'POST /api/workspace/demo': async b => openDemo(Boolean(b.reset), b.kind === 'academic' || (b.reset && session && path.basename(session.root) === 'demo-academic') ? 'academic' : 'portfolio'),
    'POST /api/check': async b => need().check({ reanalyze: Boolean(b.reanalyze), sync: true }),
    'POST /api/proposals/accept': async b => need().accept(Array.isArray(b.ids) ? b.ids.map(String) : [], b.edits && typeof b.edits === 'object' ? Object.fromEntries(Object.entries(b.edits).map(([k, v]) => [String(k), v])) : {}),
    'POST /api/proposals/accept-edited': async b => need().acceptEdited(String(b.id), b.value),
    'POST /api/proposals/reject': async b => need().reject(String(b.id)),
    'POST /api/proposals/reject-reason': async b => need().rejectReason(String(b.id), String(b.reason || ''), b.text),
    // Memory: what the owner asked Sitetend to remember. Owner only (agents have no access to these routes).
    'GET /api/memory': async () => need().memoryList(),
    'POST /api/memory': async b => need().memoryAdd(b),
    'POST /api/memory/update': async b => need().memoryUpdate(b.id, b),
    'POST /api/memory/remove': async b => need().memoryRemove(String(b.id || '')),
    'POST /api/memory/candidate': async b => need().memoryCandidate(b.id, b),
    'GET /api/fields': async () => need().fields(),
    'GET /api/chat': async () => ({ messages: await need().chatLog() }),
    'GET /api/activity': async () => ({ items: await need().activityLog() }),
    'POST /api/chat': async b => need().chat(String(b.message || ''), (await loadSettings()).language),
    'POST /api/chat/clear': async () => need().clearChat(),
    'POST /api/proposals/propose': async (b, _u, client) => need().propose({ field: String(b.field || ''), value: b.value, reason: String(b.reason || ''),
      kind: client ? 'agent' : 'chat', client: client || 'you', quote: String(b.quote || '') }),
    'GET /api/lists': async () => need().lists(),
    'POST /api/proposals/propose-code': async (b, _u, client) => need().proposeCode({ file: String(b.file || ''), edits: Array.isArray(b.edits) ? b.edits.slice(0, 50).map(e => ({ find: String(e?.find ?? ''), replace: String(e?.replace ?? '') })) : [],
      summary: String(b.summary || ''), kind: client ? 'agent' : 'chat', client: client || 'you', quote: String(b.quote || '') }),
    'POST /api/page': async b => need().readPage(String(b.file || ''), String(b.phrase || '')),
    'POST /api/proposals/propose-item': async (b, _u, client) => need().proposeItem({ collection: String(b.collection || ''), values: b.values && typeof b.values === 'object' ? b.values : {},
      position: b.position === 'start' ? 'start' : 'end', replace: b.replace == null ? null : String(b.replace), reason: String(b.reason || ''),
      kind: client ? 'agent' : 'chat', client: client || 'you', quote: String(b.quote || '') }),
    'POST /api/edit': async b => need().edit(String(b.field), b.value),
    'GET /api/materials': async () => need().materials.list(),
    'POST /api/materials/confirm': async b => need().materials.confirm(String(b.id || ''), String(b.kind || '')),
    'POST /api/materials/discard': async b => need().materials.discard(String(b.id || '')),
    'POST /api/undo': async () => need().undo(),
    'POST /api/history/revert-external': async b => need().revertExternal(String(b.id || '')),
    'POST /api/history/revert': async b => need().revertEntry(String(b.id || '')),
    'POST /api/redo': async () => need().redo(),
    'POST /api/lock': async b => need().lock(String(b.field), Boolean(b.locked)),
    'POST /api/adopt-disk': async () => need().adoptDisk(),
    'POST /api/acknowledge-deletion': async b => need().ackDeletion(String(b.path)),
    'POST /api/publish/mark': async () => need().markPublished(),
    'GET /api/publish/status': async () => need().publishStatus(),
    'POST /api/publish': async () => need().publish(),
    // The site with one suggestion in place, for "Open in browser" (pages that need their own scripts to show).
    'POST /api/preview/stage': async b => {
      const sess = need();
      if (!b.files || typeof b.files !== 'object' || Array.isArray(b.files)) throw new HttpError(400, 'files must be an object.', 'BAD_REQUEST');
      const files = {}; let size = 0;
      for (const [f, text] of Object.entries(b.files)) {
        if (typeof text !== 'string' || typeof f !== 'string' || !/\.(html?|css|js|mjs|json|md|txt|xml|svg)$/i.test(f) || f.split('/').some(x => !x || x === '..' || x.startsWith('.')) || path.isAbsolute(f)) throw new HttpError(400, 'Not a website text file.', 'BAD_REQUEST');
        if ((size += text.length) > 20e6) throw new HttpError(413, 'Too large.', 'BAD_REQUEST');
        files[f] = text;
      }
      const marks = (Array.isArray(b.marks) ? b.marks : []).map(String).map(x => x.replace(/\s+/g, ' ').trim()).filter(x => x.length >= 2).slice(0, 10).map(x => x.slice(0, 200));
      const id = crypto.randomBytes(12).toString('base64url');
      stagedViews.set(id, { files, marks, label: String(b.label || '').slice(0, 120), root: sess.root });
      while (stagedViews.size > 5) stagedViews.delete(stagedViews.keys().next().value);   // only the latest few
      return { url: `/view/${viewKey}/~s/${id}/` };
    },
    'POST /api/publish/host': async b => {   // settings for one host; its token goes to ~/.sitetend/.env only and is never sent back
      const s = need(), h = HOSTS[b.host];
      if (!h) throw new HttpError(400, 'Unknown host.', 'BAD_REQUEST');
      if (typeof b.token === 'string' && b.token.trim()) await setEnvKey(h.tokenKey, b.token.trim());
      else if (b.clearToken) await setEnvKey(h.tokenKey, '');
      return s.setHost(b.host, b);
    },
    'POST /api/publish/host/check': async b => {
      if (!HOSTS[b.host]) throw new HttpError(400, 'Unknown host.', 'BAD_REQUEST');
      return need().checkHost(b.host);
    },
    'GET /api/spending': async () => spendingStatus(),
    'GET /api/update': async (_b, url) => checkForUpdate({ force: url.searchParams.get('force') === '1', enabled: (await loadSettings()).updateCheck !== false }),
    'POST /api/settings': async b => {
      const s = await loadSettings();
      if (LANGUAGE_CODES.includes(b.language)) { s.language = b.language; if (session) session.analysis.replyLanguage = s.language; }
      if (typeof b.tourDone === 'boolean') s.tourDone = b.tourDone;
      if (typeof b.updateCheck === 'boolean') s.updateCheck = b.updateCheck;
      if (typeof b.backups === 'boolean') s.backups = b.backups;
      if (b.monthlyLimit != null && Number.isFinite(Number(b.monthlyLimit)) && Number(b.monthlyLimit) >= 0 && Number(b.monthlyLimit) <= 100000) s.monthlyLimit = Math.round(Number(b.monthlyLimit) * 100) / 100;
      if (typeof b.reviewer === 'boolean') { s.reviewer = b.reviewer; if (session) session.analysis.reviewer = s.reviewer; }
      if (b.analyzeDelaySec != null && [5, 10, 15, 30, 60].includes(Number(b.analyzeDelaySec))) { s.analyzeDelaySec = Number(b.analyzeDelaySec); if (session) session.analyzeDelaySec = s.analyzeDelaySec; }
      await saveSettings(s);
      if (b.autoAnalyze && session) await session.setAutoAnalyze(b.autoAnalyze);
      if (b.publishMode && session) await session.setPublishMode(b.publishMode);
      if (Array.isArray(b.privacyExclude) && session) await session.setPrivacyExclude(b.privacyExclude);
      if (b.mcp && typeof b.mcp === 'object') { s.mcp = { enabled: Boolean(b.mcp.enabled), allowWrites: Boolean(b.mcp.enabled && b.mcp.allowWrites) }; await saveSettings(s); }
      emit('state', { reason: 'settings' });
      return s;
    },
    'GET /api/models': async () => {
      const m = await loadModels();
      const profiles = await Promise.all(m.profiles.map(async p => ({ ...p, hasKey: p.keyRef ? Boolean(await resolveKey(p.keyRef)) : true })));
      return { active: m.active, profiles };
    },
    'POST /api/models/active': async b => {
      const m = await loadModels();
      if (!m.profiles.some(p => p.id === b.id)) throw new HttpError(400, 'Unknown model.');
      const prev = m.active; m.active = b.id; await saveModels(m);
      if (session) { try { await session.useActiveModel(); } catch (e) { m.active = prev; await saveModels(m); throw new HttpError(400, e.message, e.code); } }
      emit('state', { reason: 'model' });
      return { active: m.active };
    },
    // Owner-added models: any OpenAI-compatible chat-completions endpoint. Not available to MCP agents.
    'POST /api/models/price': async b => {   // US dollars per million tokens; prices change, so the user can correct them
      const m = await loadModels(); const p = m.profiles.find(x => x.id === b.id);
      if (!p || p.type === 'rule') throw new HttpError(404, 'Unknown model.', 'BAD_MODEL');
      const n = v => { const x = Number(v); if (!Number.isFinite(x) || x < 0 || x > 1000) throw new HttpError(400, 'Not a price.', 'FIELD_VALIDATION_FAILED'); return Math.round(x * 10000) / 10000; };
      p.price = { in: n(b.in), out: n(b.out) }; await saveModels(m); emit('state', { reason: 'model' });
      return { id: p.id, price: p.price };
    },
    'POST /api/models/add': async b => {
      const label = String(b.label || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const model = String(b.model || '').trim().slice(0, 120);
      let endpoint;
      try { endpoint = new URL(String(b.endpoint || '').trim()); } catch { throw new HttpError(400, 'Not a web address.', 'BAD_ENDPOINT'); }
      const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/i.test(endpoint.hostname);
      // Keys only travel encrypted: plain http is allowed for this computer or the local network only.
      if (!(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && local)) || endpoint.username || endpoint.password) throw new HttpError(400, 'Use an https:// address (http:// only for this computer or the local network).', 'BAD_ENDPOINT');
      // A base URL (".../v1") gets the chat-completions path.
      if (!/\/chat\/completions\/?$/.test(endpoint.pathname)) endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + '/chat/completions';
      if (!label || !model) throw new HttpError(400, 'A name and a model are needed.', 'BAD_MODEL');
      const m = await loadModels();
      const id = 'custom-' + (label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'model') + '-' + crypto.randomBytes(2).toString('hex');
      const key = String(b.key || '').trim();
      // An internet service always gets a key slot (it can be filled in later from the menu); a local model may have none.
      const keyRef = key || !local ? 'SITETEND_KEY_' + id.toUpperCase().replace(/[^A-Z0-9]/g, '_') : null;
      if (key) await setEnvKey(keyRef, key);
      const profile = { id, label, type: 'openai-compatible', endpoint: endpoint.href, model, keyRef, custom: true,
        ...(local && !key ? { local: true } : {}), ...(/(^|\.)anthropic\.com$/i.test(endpoint.hostname) ? { jsonMode: false, extraBody: { max_tokens: 16000 } } : {}) };
      m.profiles.push(profile); await saveModels(m);
      return { id, needsKey: Boolean(keyRef && !key) };
    },
    'POST /api/models/remove': async b => {
      const m = await loadModels(); const p = m.profiles.find(x => x.id === b.id);
      if (!p?.custom) throw new HttpError(400, 'Only models you added can be removed.', 'NOT_CUSTOM');
      m.profiles = m.profiles.filter(x => x.id !== p.id);
      const wasActive = m.active === p.id; if (wasActive) m.active = 'rule';
      await saveModels(m);
      if (p.keyRef) await setEnvKey(p.keyRef, '');
      if (wasActive && session) await session.useActiveModel().catch(() => {});
      emit('state', { reason: 'model' });
      return { active: m.active };
    },
    'POST /api/models/key': async b => {
      const m = await loadModels(); const p = m.profiles.find(x => x.id === b.id);
      if (!p?.keyRef) throw new HttpError(400, 'This model does not need a key.');
      await setEnvKey(p.keyRef, String(b.key || '').trim());
      if (session && m.active === p.id) await session.useActiveModel().catch(() => {});
      return { saved: true };
    },
    'POST /api/models/test': async () => {
      const s = need();
      if (s.modelInfo.isMock) return { ok: true, latencyMs: 0, model: 'rule' };
      const t0 = Date.now();
      const r = await s.provider.analyzeSourceDiff({ source: { path: '(connection test)', extractedText: 'test' }, fields: [], hints: [], change: 'MODIFIED' });
      return { ok: r.ok, latencyMs: Date.now() - t0, model: s.modelInfo.model, error: r.ok ? null : r.error.message };
    },
    // Demo helpers (advanced settings): modify demo source files to try the flow.
    'POST /api/demo/change': async b => {
      const s = need(); const ws = s.ws;
      if (b.kind === 'email') {
        // Always a real change, even after the demo email was already accepted once: switch between two addresses.
        const p = (await ws.readJson('sources/profile.json')).data.data;
        p.email = p.email === 'alex.updated@example.com' ? 'alex.morgan.new@example.com' : 'alex.updated@example.com';
        await ws.writeJson('sources/profile.json', p);
      }
      else if (b.kind === 'project') { const t = (await ws.readText('sources/projects/orbit-dock.md')).data.content; await ws.writeText('sources/projects/orbit-dock.md', t + '\n- **Summary**: A keyboard-first workspace launcher with a clearer project overview.\n'); }
      else if (b.kind === 'space') { const t = (await ws.readText('sources/projects/orbit-dock.md')).data.content; await ws.writeText('sources/projects/orbit-dock.md', t + '\n\n'); }
      else throw new HttpError(400, 'Unknown sample change.');
      s.scheduleAnalysis();   // demo writes go through the adapter, so the watcher ignores them
      return { changed: b.kind };
    },
  };

  async function readBody(req) {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > MAX_BODY) throw new HttpError(413, 'Request too large.'); chunks.push(c); }
    if (!chunks.length) return {};
    let v; try { v = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Not valid JSON.', 'BAD_REQUEST'); }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'A JSON object is required.', 'BAD_REQUEST');
    return v;
  }

  function send(res, status, body, type = 'application/json; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  }

  async function serveStatic(res, urlPath, ua) {
    if (urlPath === '/' || urlPath === '/index.html') urlPath = MOBILE_UA.test(ua || '') ? '/ui/mobile.html' : '/ui/index.html';
    const rel = decodeURIComponent(urlPath);
    if (rel.split('/').some(p => p.startsWith('.') && p !== '')) throw new HttpError(404, 'Not found');
    const allowed = ['/ui/', '/src/', '/vendor/', '/demo-workspace/'];
    if (!allowed.some(a => rel.startsWith(a))) throw new HttpError(404, 'Not found');
    const file = path.resolve(APP_ROOT, '.' + rel);
    if (!file.startsWith(APP_ROOT + path.sep)) throw new HttpError(404, 'Not found');
    const bytes = await fs.readFile(file).catch(() => { throw new HttpError(404, 'Not found'); });
    send(res, 200, bytes, TYPES[path.extname(file)] || 'application/octet-stream');
  }

  const server = http.createServer(async (req, res) => {
    try {
      // DNS-rebinding guard: only accept our own host names.
      const host = String(req.headers.host || '');
      if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(host)) throw new HttpError(403, 'Forbidden host');
      const url = new URL(req.url || '/', `http://${host}`);
      // Incoming webhook: a local script (a git hook, a scheduled task, an export from another app) asks for a check.
      // Its own key, separate from the session token, so it keeps working across restarts.
      if (url.pathname === '/hooks/check') {
        if (req.method !== 'POST') throw new HttpError(405, 'Use POST.', 'METHOD');
        const s = await loadSettings(); const want = s.incomingHook ? await resolveKey(INCOMING_KEY) : '';
        const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.headers['x-sitetend-key'] || '');
        if (!want || !given || given.length !== want.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want))) throw new HttpError(401, 'Wrong or missing key.', 'UNAUTHORIZED');
        if (!session) throw new HttpError(409, 'No website is open in Sitetend.', 'NO_WORKSPACE');
        session.check({ sync: true }).catch(e => emit('error', { message: e.message }));
        emit('hook.received', {});
        return send(res, 202, { ok: true, data: { accepted: true, site: siteLabel } });
      }
      // The saved website, opened in the browser with its own scripts running (animations, canvases, videos).
      // Read-only, website files only, behind its own random key (not the session token), and sent as a sandboxed
      // page: it gets an origin of its own, so its scripts cannot use Sitetend's API.
      if (url.pathname.startsWith('/view/')) {
        const [, , key, ...rest0] = url.pathname.split('/');
        // /view/<key>/~s/<id>/…: the site with one suggestion in place (pages changed by it come from memory, everything else from disk).
        let staged = null, rest = rest0;
        if (rest0[0] === '~s') { staged = stagedViews.get(rest0[1] || ''); if (staged && staged.root !== session?.root) staged = null; if (!staged) throw new HttpError(404, 'This preview has expired. Open it again from Sitetend.'); rest = rest0.slice(2); }
        if (!key || key.length !== viewKey.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(viewKey))) throw new HttpError(404, 'Not found.');
        if (!session) throw new HttpError(409, 'No website is open.', 'NO_WORKSPACE');
        let rel = rest.map(x => decodeURIComponent(x)).join('/');
        if (!rel || rel.endsWith('/')) rel += 'index.html';
        if (rel.split('/').some(x => x === '..' || x.startsWith('.'))) throw new HttpError(404, 'Not found.');
        const read = async f => staged && Object.hasOwn(staged.files, f) ? { ok: true, data: { bytes: Buffer.from(staged.files[f], 'utf8') } } : session.ws.readBytes('website/' + f);
        let r = await read(rel);
        if (!r.ok && !path.extname(rel)) { rel += '/index.html'; r = await read(rel); }
        if (!r.ok) throw new HttpError(404, 'Not found.');
        let bytes = Buffer.from(r.data.bytes); const type = TYPES[path.extname(rel).toLowerCase()] || 'application/octet-stream';
        if (staged && /\.html?$/i.test(rel)) bytes = Buffer.from(markChange(bytes.toString('utf8'), staged), 'utf8');
        const head = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes',
          'Content-Security-Policy': 'sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads', 'Referrer-Policy': 'no-referrer',
          'Access-Control-Allow-Origin': '*' };   // the sandboxed page may read its own site's files (no credentials, read-only)
        const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
        if (range && (range[1] || range[2])) {                    // videos ask for parts of the file
          let start = range[1] ? +range[1] : Math.max(0, bytes.length - +range[2]), end = range[1] && range[2] ? Math.min(+range[2], bytes.length - 1) : bytes.length - 1;
          if (start >= bytes.length || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` }); return res.end(); }
          res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1 });
          return res.end(bytes.subarray(start, end + 1));
        }
        res.writeHead(200, { ...head, 'Content-Length': bytes.length }); return res.end(bytes);
      }
      if (!url.pathname.startsWith('/api/')) return await serveStatic(res, url.pathname, req.headers['user-agent']);

      const given = req.headers['x-sitetend-token'] || url.searchParams.get('t');
      if (!given || !sameSecret(String(given), token)) throw new HttpError(401, 'Invalid session token. Use the link Sitetend opened when it started.', 'UNAUTHORIZED');
      // Materials dropped on the window arrive as raw bytes (not JSON); never from outside agents.
      if (url.pathname === '/api/item-image' && req.method === 'POST') {
        if (req.headers['x-sitetend-client']) throw new HttpError(403, 'Agents cannot add pictures.', 'MCP_FORBIDDEN');
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > 15 * 1024 * 1024) throw new HttpError(413, 'This picture is larger than 15 MB.', 'ITEM_IMAGE_TOO_LARGE'); chunks.push(c); }
        const h = k => { const v = String(req.headers[k] || ''); try { return decodeURIComponent(v); } catch { return v; } };
        return send(res, 200, { ok: true, data: await need().itemImage(h('x-collection'), h('x-field'), h('x-file-name') || 'picture', new Uint8Array(Buffer.concat(chunks))) });
      }
      if (url.pathname === '/api/materials/upload' && req.method === 'POST') {
        if (req.headers['x-sitetend-client']) throw new HttpError(403, 'Agents cannot add materials.', 'MCP_FORBIDDEN');
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > MAX_MATERIAL_BYTES) throw new HttpError(413, 'This file is larger than 20 MB.', 'MATERIAL_TOO_LARGE'); chunks.push(c); }
        const rawName = String(req.headers['x-file-name'] || 'file'); let name; try { name = decodeURIComponent(rawName); } catch { name = rawName; }   // a badly encoded name is used as it came
        return send(res, 200, { ok: true, data: await need().materials.receive(name, new Uint8Array(Buffer.concat(chunks))) });
      }
      if (req.method === 'POST' && !String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'JSON required.');

      if (url.pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('event: hello\ndata: {}\n\n'); clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }
      // The website as one .zip (files at the top level), for hosts where you drag a zip in (Cloudflare, Netlify Drop).
      if (url.pathname === '/api/publish/zip' && req.method === 'GET') {
        if (req.headers['x-sitetend-client']) throw new HttpError(403, 'Agents cannot download the website.', 'MCP_FORBIDDEN');
        const s = need(); const dir = s.publishDir();
        const tmp = path.join(os.tmpdir(), `sitetend-zip-${process.pid}-${crypto.randomBytes(6).toString('hex')}.zip`);
        try {
          await zipFolder(dir, tmp, { publish: true });
          const bytes = await fs.readFile(tmp);
          const name = (s.siteSlug() || 'website') + '.zip';
          res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${name}"` });
          return res.end(bytes);
        } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
      }
      if (url.pathname === '/api/file' && req.method === 'GET') {           // read-only, website/ only (for preview)
        const p = url.searchParams.get('path') || '';
        if (!p.startsWith('website/') && !p.startsWith('sources/')) throw new HttpError(403, 'Only files in website/ or sources/ can be read.');
        const r = await need().ws.readBytes(p);
        if (!r.ok) throw new HttpError(404, r.error.message);
        return send(res, 200, Buffer.from(r.data.bytes), TYPES[path.extname(p)] || 'application/octet-stream');
      }
      const key = `${req.method} ${url.pathname}`;
      const handler = routes[key];
      if (!handler) throw new HttpError(404, 'Unknown endpoint.');
      // Requests from outside agents are tagged by the MCP bridge and checked against the user's settings.
      const clientHeader = String(req.headers['x-sitetend-client'] || '');
      let client = null;
      if (clientHeader.startsWith('mcp:')) {
        client = clientHeader.slice(4).replace(/[^\w .@()-]/g, '').slice(0, 60) || 'agent';
        const mcp = (await loadSettings()).mcp;
        if (!mcp.enabled) throw new HttpError(403, 'Agent access is turned off in Sitetend (connection menu → MCP).', 'MCP_DISABLED');
        if (MCP_WRITE.has(key) && !mcp.allowWrites) throw new HttpError(403, 'Agents may suggest changes, but accepting, rejecting and undoing are turned off by the user.', 'MCP_READ_ONLY');
        if (!MCP_READ.has(key) && !MCP_WRITE.has(key)) throw new HttpError(403, 'Agents cannot use this part of Sitetend.', 'MCP_FORBIDDEN');
      }
      const body = req.method === 'POST' ? await readBody(req) : {};
      send(res, 200, { ok: true, data: await handler(body, url, client) });
    } catch (e) {
      // A mistake in Sitetend itself (not in the request): logged with its stack, and answered as such.
      const internal = !(e instanceof HttpError) && (e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError || e instanceof SyntaxError);
      if (internal) log(`Internal error on ${req.method} ${String(req.url).split('?')[0]}: ${e.stack || e.message}`);
      const status = e instanceof HttpError ? e.status : internal ? 500 : 400;
      if (status === 404 && !String(req.url).startsWith('/api/')) return send(res, 404, 'Not found', 'text/plain');
      send(res, status, { ok: false, error: internal ? { code: 'INTERNAL', message: 'Something went wrong inside Sitetend. Details are in its log.' } : { code: e.code || 'ERROR', message: e.message, ...(typeof e.file === 'string' ? { file: e.file } : {}), ...(typeof e.detail === 'string' && e.detail ? { detail: e.detail.slice(0, 300) } : {}) } });
    }
  });

  let actualPort = port;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  // @ts-ignore
  actualPort = server.address().port;
  const url = `http://127.0.0.1:${actualPort}/?t=${token}`;
  if (workspace) await openWorkspace(path.resolve(workspace));
  else {   // started again: back to the website used last time (if its folder is still there)
    const last = (await loadSettings()).recentWorkspaces?.[0];
    if (last && (await fs.stat(last).catch(() => null))?.isDirectory()) await openWorkspace(last).catch(e => log(`Could not reopen ${last}: ${e.message}`));
  }
  await fs.mkdir(userDir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(hostFile(), JSON.stringify({ port: actualPort, token, pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
  log(`Sitetend is running: ${url}`);
  return {
    url, port: actualPort, token,
    setTray(fn) { traySwitch = fn; },
    get session() { return session; },
    async close() {
      session?.close(); for (const c of clients) c.end(); await new Promise(r => server.close(r));
      try { const h = JSON.parse(await fs.readFile(hostFile(), 'utf8')); if (h.port === actualPort && h.token === token) await fs.rm(hostFile(), { force: true }); } catch {}
    },
  };
}
