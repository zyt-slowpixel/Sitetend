// Sitetend UI (dependency-free). Talks only to the local host API; holds no business logic.
import { icon, applyIcons } from './icons.js';
import { startTour } from './tour.js';
import { popIn, popOut, keepOnScreen, growFrom, shrinkTo, fadeShow, fadeHide, openDialog, closeDialog, animateDialog, confirmBox, flip, crossfade } from './motion.js';
import { PreviewBridge } from '/src/ui/preview-bridge.js';
import { siteAdapterFor } from '/src/adapters/site-adapters.js';
import { plainMarkdown } from '/src/ui/markdown-lite.js';
import { applyEdits } from '/src/agent/code-edits.js';

const $ = id => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v; else if (k === 'html') n.innerHTML = v;   // only for our own icon markup
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, ''); else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : String(k));
  return n;
};

applyIcons();

// Segmented controls: one white "thumb" slides to the pressed button (instead of jumping).
function placeThumb(seg, animate = true) {
  const on = seg.querySelector('button[aria-pressed="true"]');
  seg.classList.toggle('has-thumb', Boolean(on));
  if (!on) return;
  if (!animate) seg.classList.add('no-anim');
  seg.style.setProperty('--thumb-x', on.offsetLeft + 'px'); seg.style.setProperty('--thumb-w', on.offsetWidth + 'px');
  if (!animate) requestAnimationFrame(() => seg.classList.remove('no-anim'));
}
const segWatch = new MutationObserver(list => { for (const m of list) { const seg = m.target.closest?.('.seg'); if (seg) placeThumb(seg); } });
// Button widths change when the language changes (or fonts load): keep the thumb under the right button.
const segResize = window.ResizeObserver ? new ResizeObserver(list => { for (const e of list) { const seg = e.target.closest('.seg'); if (seg) placeThumb(seg, false); } }) : null;
function watchSegs(root = document) {
  for (const seg of root.querySelectorAll('.seg')) { if (seg.dataset.thumb) continue; seg.dataset.thumb = '1'; placeThumb(seg, false); for (const b of seg.querySelectorAll('button')) segResize?.observe(b); segWatch.observe(seg, { attributes: true, subtree: true, attributeFilter: ['aria-pressed'] }); }
}
watchSegs();
addEventListener('resize', () => document.querySelectorAll('.seg').forEach(s => placeThumb(s, false)));
document.fonts?.ready.then(() => document.querySelectorAll('.seg').forEach(s => placeThumb(s, false)));

// ---------------------------------------------------------------- session token
const params = new URLSearchParams(location.search);
if (params.get('t')) { sessionStorage.setItem('sitetend.t', params.get('t')); history.replaceState(null, '', '/'); }
const TOKEN = sessionStorage.getItem('sitetend.t') || '';

// ---------------------------------------------------------------- i18n
let dict = {}, fallback = {}, lang = 'en';
// "{n} change(s)": with a count, write the word as singular or plural instead of "(s)".
const plural = (s, n) => n == null || isNaN(+n) ? s : s.replace(/(\p{L}+)\(s\)/gu, (_, w) => +n === 1 ? w : w + 's');
const t = (k, vars = {}) => plural(String(dict[k] ?? fallback[k] ?? k), vars.n).replace(/\{(\w+)\}/g, (_, v) => vars[v] ?? '');
let LANGS = [['en', 'English']];   // [code, name in its own language], from ui/locales/languages.json
async function loadLang(l) {
  if (LANGS.length === 1) { try { LANGS = (await (await fetch('/ui/locales/languages.json')).json()).map(x => [x.code, x.name]); } catch {} }
  fallback = await (await fetch('/ui/locales/en.json')).json();
  lang = LANGS.some(([c]) => c === l) ? l : 'en';
  dict = lang === 'en' ? fallback : await (await fetch(`/ui/locales/${lang}.json`)).json();
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach(n => { n.textContent = t(n.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach(n => { n.title = t(n.dataset.i18nTitle); n.setAttribute('aria-label', n.title); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(n => { n.placeholder = t(n.dataset.i18nPlaceholder); });
  if (typeof renderMaterials === 'function') renderMaterials();   // drawn by code, not by data-i18n
}
/** Error text in the interface language; backend messages are only used as a last resort. */
function errorText(e) {
  // A host's own words (Cloudflare, Netlify) follow the explanation: they name the exact reason.
  if (e.code && (dict[`err.${e.code}`] ?? fallback[`err.${e.code}`])) return t(`err.${e.code}`, { file: e.file || '' }) + (e.detail ? ` (${e.detail})` : '');
  // Backend messages are English. They are shown only in the English interface (and only if they really are
  // English, e.g. not a model's reply in another language); other languages get the general line for the code.
  const m = e.message || '', cjk = /[\u3400-\u9fff]/.test(m);
  return m && lang === 'en' && !cjk ? m : t('err.generic');
}

// ---------------------------------------------------------------- API
async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Sitetend-Token': TOKEN }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({ ok: false, error: { message: res.statusText } }));
  if (!json.ok) throw Object.assign(Error(json.error?.message || ''), { code: json.error?.code, file: json.error?.file, detail: json.error?.detail });
  return json.data;
}
let busy = false;
async function act(fn) {
  if (busy) return; busy = true; syncButtons();
  try { await fn(); } catch (e) { say(errorText(e), true); } finally { busy = false; await refresh().catch(e => say(errorText(e), true)); }
}
const menuClosed = id => $(id).hidden || Boolean($(id).dataset.leaving);
let toastTimer = null;
// ---- spending: this month's estimated cost, the monthly limit, and the price of the model in use
const money = x => (x || 0) < 10 ? (x || 0).toFixed(2) : Math.round(x).toString();
function spendSection() {
  const sec = el('section', {}, secHead('sliders', t('settings.spend')), el('div', { class: 'muted' }, '…'));
  (async () => {
    const st = await api('GET', '/api/spending'); const active = models?.profiles.find(p => p.id === models.active);
    const pct = st.limit ? Math.min(100, Math.round(st.dollars / st.limit * 100)) : 0;
    const limit = el('input', { type: 'number', min: '0', step: '1', value: String(st.limit || 0), 'aria-label': t('settings.spend.limit'), class: 'num' });
    const parts = [secHead('sliders', t('settings.spend')),
      el('div', { class: 'spend-now' }, t('settings.spend.month', { d: money(st.dollars), n: st.calls })),
      st.limit ? el('div', { class: 'spend-bar' + (pct >= 100 ? ' full' : pct >= 80 ? ' near' : '') }, el('span', { style: `width:${pct}%` })) : null,
      st.limit ? el('div', { class: 'muted' }, t('settings.spend.ofLimit', { p: pct, l: money(st.limit) })) : null,
      el('label', { class: 'muted' }, t('settings.spend.limit')),
      el('form', { class: 'inline-form', onsubmit: e => { e.preventDefault(); act(async () => { await api('POST', '/api/settings', { monthlyLimit: Number(limit.value) || 0 }); say(t('settings.spend.saved')); openDrawer(); }); } },
        limit, el('button', {}, t('settings.spend.save')))];
    if (active && active.type !== 'rule') {
      if (active.local) parts.push(el('div', { class: 'muted' }, t('settings.spend.free', { model: modelName(active) })));
      else {
        const pin = el('input', { type: 'number', min: '0', step: '0.01', value: String(active.price?.in ?? ''), 'aria-label': t('settings.spend.in'), class: 'num' });
        const pout = el('input', { type: 'number', min: '0', step: '0.01', value: String(active.price?.out ?? ''), 'aria-label': t('settings.spend.out'), class: 'num' });
        parts.push(el('label', { class: 'muted' }, t('settings.spend.price', { model: modelName(active) })),
          el('form', { class: 'inline-form', onsubmit: e => { e.preventDefault(); act(async () => { await api('POST', '/api/models/price', { id: active.id, in: pin.value, out: pout.value }); models = await api('GET', '/api/models'); say(t('settings.spend.saved')); }); } },
            el('span', { class: 'muted' }, t('settings.spend.in')), pin, el('span', { class: 'muted' }, t('settings.spend.out')), pout, el('button', {}, t('settings.spend.save'))));
      }
    }
    if (st.unpriced) parts.push(el('div', { class: 'muted' }, t('settings.spend.unpriced', { n: st.unpriced })));
    parts.push(el('div', { class: 'muted' }, t('settings.spend.note')));
    sec.replaceChildren(...parts.filter(Boolean));
  })().catch(() => {});
  return sec;
}
let spendWarned = null;
async function checkSpending() {   // one reminder per month when 80% of the limit is used
  try {
    const st = await api('GET', '/api/spending'); if (!st.limit) return;
    const pct = Math.round(st.dollars / st.limit * 100);
    const key = 'sitetend.spendWarned'; spendWarned ??= (() => { try { return localStorage.getItem(key); } catch { return null; } })();
    if (pct >= 80 && spendWarned !== st.month) { say(t('spend.near', { p: Math.min(pct, 100), l: money(st.limit) }), pct >= 100); spendWarned = st.month; try { localStorage.setItem(key, st.month); } catch {} }
  } catch {}
}
// ---- new versions: a quiet bar at the bottom left when GitHub has a newer release (once per version)
let updateInfo = null;
async function checkUpdate(force = false) {
  try { updateInfo = await api('GET', '/api/update' + (force ? '?force=1' : '')); } catch { updateInfo = { error: 'OFFLINE' }; }
  const skip = (() => { try { return localStorage.getItem('sitetend.skipVersion'); } catch { return null; } })();
  if (updateInfo?.newer && (force || skip !== updateInfo.latest)) showUpdateBar(updateInfo);
  return updateInfo;
}
function showUpdateBar(u) {
  document.getElementById('update-bar')?.remove();
  const bar = el('div', { id: 'update-bar', class: 'update-bar', role: 'status' },
    el('span', { class: 'h3-ico', html: icon('download-cloud', 16) }),
    el('span', {}, t('update.available', { v: u.latest, cur: u.current })),
    el('a', { class: 'primary-link', href: u.url, target: '_blank', rel: 'noopener' }, t('update.download')),
    el('button', { class: 'link', onclick: () => { try { localStorage.setItem('sitetend.skipVersion', u.latest); } catch {} bar.remove(); } }, t('update.later')));
  document.body.append(bar);
}
function updateSection() {
  const status = el('div', { class: 'muted' }, '');
  const show = u => { status.textContent = !u ? '' : u.off ? t('settings.updates.off', { v: u.current }) : u.newer ? t('settings.updates.newer', { v: u.latest })
    : u.latest ? t('settings.updates.latest', { v: u.current }) : t('settings.updates.offline', { v: u.current || S?.host?.version || '' }); };
  show(updateInfo);
  return el('section', {}, secHead('download-cloud', t('settings.updates')),
    el('label', { class: 'mcheck', style: 'padding-left:0' }, el('input', { type: 'checkbox', checked: settings.updateCheck !== false,
      onchange: e => act(async () => { await api('POST', '/api/settings', { updateCheck: e.target.checked }); settings.updateCheck = e.target.checked; show(await checkUpdate()); }) }), t('settings.updates.on')),
    el('div', { class: 'muted' }, t('settings.updates.note')),
    status,
    el('div', { class: 'btn-grid' }, el('button', { onclick: () => act(async () => { status.textContent = '…'; show(await checkUpdate(true)); }) }, t('settings.updates.now'))),
    el('div', { class: 'muted' }, t('settings.updates.how')));
}
// Daily full-site backups: a list with dates and sizes, restore, back up now, open the folder.
function backupSection() {
  const list = el('div', { class: 'backup-list' }, el('div', { class: 'muted' }, '…'));
  const toggle = el('input', { type: 'checkbox', checked: settings.backups !== false, onchange: e => onToggle(e) });
  const size = n => n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB';
  const load = async () => {
    let r; try { r = await api('GET', '/api/backups'); } catch { list.replaceChildren(el('div', { class: 'muted' }, t('err.generic'))); return; }
    if (!r.list.length) { list.replaceChildren(el('div', { class: 'muted' }, t('backup.none'))); return; }
    list.replaceChildren(...r.list.slice(0, 20).map(b => el('div', { class: 'backup-row' },
      el('div', {}, el('div', {}, new Date(b.at).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' })),
        el('div', { class: 'muted' }, t('backup.kind.' + b.kind) + ' · ' + size(b.bytes))),
      el('button', { class: 'small-btn', onclick: () => confirmRestore(b) }, t('backup.restore')))));
  };
  const confirmRestore = b => {
    const when = new Date(b.at).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' });
    const { d, body } = sheetDialog(t('backup.confirmTitle'));
    const msg = el('div', { class: 'dlg-msg' });
    body.append(el('p', {}, t('backup.confirm', { when })), msg,
      el('div', { class: 'btns' },
        el('button', { type: 'button', onclick: () => closeDialog(d) }, t('cancel')),
        el('button', { type: 'button', class: 'primary', onclick: () => inDialog(msg, async () => {
          await api('POST', '/api/backups/restore', { file: b.file }); closeDialog(d); say(t('backup.restored', { when }));
          loadedA = loadedB = false; bridge.lastDoc = bridgeB.lastDoc = null; await refresh(); load();
        }, t('backup.restoring')) }, t('backup.restore'))));
  };
  load();
  return el('section', {}, secHead('archive', t('backup.title')),
    el('label', { class: 'mcheck', style: 'padding-left:0' }, toggle, t('backup.on')),
    el('div', { class: 'muted' }, t('backup.note')),
    list,
    el('div', { class: 'btn-grid' },
      el('button', { onclick: () => act(async () => { say(t('backup.making')); await api('POST', '/api/backups/now', {}); say(t('backup.made')); load(); }) }, t('backup.now')),
      el('button', { onclick: () => act(() => api('POST', '/api/backups/reveal', {})) }, t('backup.folder'))));
  function onToggle(e) { act(async () => { await api('POST', '/api/settings', { backups: e.target.checked }); settings.backups = e.target.checked; }); }
}
function say(text, error = false) {
  const n = $('status'); n.textContent = text || ''; n.classList.toggle('error', error);
  n.classList.toggle('show', Boolean(text)); clearTimeout(toastTimer);
  if (text) toastTimer = setTimeout(() => n.classList.remove('show'), error ? 9000 : 3500);
}
$('status').onclick = () => $('status').classList.remove('show');
const fileUrl = p => `/api/file?path=${encodeURIComponent(p)}&t=${encodeURIComponent(TOKEN)}`;

// ---------------------------------------------------------------- state
let S = null, models = null, settings = null, hostInfo = null, sites = [];
// Memory: what the owner asked Sitetend to remember, and open "remember this?" questions. askWhy: the suggestion just rejected (optional reason).
let MEM = { items: [], candidates: [] }, askWhy = null, whyTimer = null;
async function loadMemory() { try { MEM = S ? await api('GET', '/api/memory') : { items: [], candidates: [] }; } catch { /* keeps the last list */ } if (S) renderCards(); if (typeof renderChat === 'function' && S) renderChat(); for (const fn of memoryViews) fn(); }
const memoryViews = new Set();   // open memory pages to refresh
let site = siteAdapterFor();
const fileClient = {
  async readText(p) { const r = await fetch(fileUrl(p)); return r.ok ? { ok: true, data: { content: await r.text() } } : { ok: false, error: { message: r.statusText } }; },
  async readBytes(p) { const r = await fetch(fileUrl(p)); return r.ok ? { ok: true, data: { bytes: new Uint8Array(await r.arrayBuffer()) } } : { ok: false, error: { message: r.statusText } }; },
};
let selectedId = null;            // suggestion card shown in the preview
let view = 'a';                   // 'a' = current / with this change, 'b' = original, 'split'
let editMode = false;             // in-place text editing in the preview
let historyOpen = false;
let undoBlocked = false;           // last undo hit a step whose fields were changed elsewhere
const edits = new Map();          // proposal id -> text typed in the card (unsaved)
const itemEdits = new Map();      // new-item card id -> { op, key, position, values } (unsaved)
let cardsStale = false;

const shortcut = a => act(() => doStep(a));
const splitOn = () => !$('pane-b').hidden;
const bridge = new PreviewBridge($('preview'), site, () => {}, shortcut, r => { if (splitOn()) bridgeB.scrollTo(r); }, m => onPreviewEdit(m));
const bridgeB = new PreviewBridge($('preview-b'), site, () => {}, shortcut, r => { if (splitOn()) bridge.scrollTo(r); });
// Another page of a plain HTML site is shown (a link was clicked, or a suggestion lives there): both panes follow.
bridge.onNavigate = f => { if (bridgeB.page !== f) { bridgeB.page = f; bridgeB.lastDoc = null; } pageCaption(); if (!navBusy) { navBusy = true; queueMicrotask(() => { navBusy = false; renderPreview(); }); } };
// A page drawn by its own scripts (a video intro, a canvas, a single-page app) looks empty in the preview, which runs no
// scripts. Say so, and offer the page of the site with the most text, or the real page in the browser.
bridge.onShown = ({ text, visible, covered, ownScripts, page }) => {
  // little text, or a full-window layer with no words on top (a loading screen its scripts would take away)
  const scriptDrawn = ownScripts > 0 && (text < 120 || covered) && S?.siteMode === 'html' && !S.build;
  if (editPart) {   // a part being edited: it is not switched to live; say so when it shows nothing here either
    if (page === editPart.part && ownScripts > 0 && visible < 20) {   // its words are there but hidden until its scripts lay them out
      const note = $('script-note'), ep = editPart; note.hidden = false;
      note.replaceChildren(el('span', {}, t('preview.partBlank', { part: ep.part, host: ep.host })),
        ...editMode ? [] : [el('button', { class: 'small-btn', onclick: () => { staticPages.delete(ep.part); staticPages.delete(ep.host); for (const b of [bridge, bridgeB]) { b.page = ep.host; b.lastDoc = null; } renderPreview(); } }, t('preview.useLive'))]);
    }
    return;
  }
  if (scriptDrawn && hostInfo?.view && !staticPages.has(page) && !editMode) { livePages.add(page); renderPreview(); return; }   // show it live instead
  const note = $('script-note');
  note.hidden = !scriptDrawn; if (note.hidden) { note.replaceChildren(); return; }
  if (editMode) { note.replaceChildren(el('span', {}, t('preview.editBlank', { page }))); return; }   // editing needs the normal preview, where it shows nothing
  note.replaceChildren(el('span', {}, t('preview.scriptDrawn')),
    ...hostInfo?.view ? [el('button', { class: 'small-btn', onclick: () => { staticPages.delete(page); livePages.add(page); renderPreview(); } }, t('preview.useLive'))] : []);
};
// ---- live preview: the real page with its own scripts, from Sitetend's sandboxed /view/ address (the same as "Open in browser",
// which cannot reach Sitetend). Used for pages drawn by their scripts. A suggestion or an older version is put in place on the
// way (pages from memory, nothing saved) and its words are highlighted. In-place editing needs the normal preview.
const livePages = new Set(), staticPages = new Set(), stageCache = new Map();
/**
 * A page that is a part of another page: a top-level page loads it with its scripts (for example index.html builds
 * 'p/' + name + '.html' for each menu item). Opened alone it lacks that page's styles, background and paths, so it is
 * shown inside the page that loads it. Returns that page, or null.
 */
function hostPageOf(file) {
  const files = S?.content?.files || {};
  if (!/\.html?$/i.test(file) || !file.includes('/')) return null;
  const dir = file.slice(0, file.lastIndexOf('/') + 1), stem = file.slice(dir.length).replace(/\.html?$/i, '');
  const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const top = Object.keys(files).filter(q => q !== file && /\.html?$/i.test(q) && !q.includes('/')).sort((a, b) => (/^index\./i.test(b) - /^index\./i.test(a)));
  for (const q of top) {
    const txt = [...String(files[q] || '').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');   // loaded by its scripts, not just linked
    if (txt.includes(file)) return q;
    const firstDir = dir.split('/')[0] + '/';
    if (new RegExp(`['"\`]${esc(firstDir)}`).test(txt) && new RegExp(`['"/=]${esc(stem)}['"./]`).test(txt)) return q;
  }
  return null;
}
let shownPart = null, editPart = null;
/** The part of a script-drawn page with the most words to edit (its own menu pages: home, about…), or null. */
function bestPartOf(host) {
  const files = Object.keys(S?.content?.files || {}).filter(f => hostPageOf(f) === host);
  if (!files.length) return null;
  const n = new Map(files.map(f => [f, 0]));
  for (const f of site.listEditableFields?.(S.content) || []) { const file = String(f.path).split('::')[0]; if (n.has(file)) n.set(file, n.get(file) + 1); }
  const first = files.find(f => /(^|\/)(home|index|main)\.html?$/i.test(f));   // the page that opens first, when there is one
  return first || [...n].sort((a, b) => b[1] - a[1])[0][0];
}   // a part page shown inside the page that loads it
const pageOf = () => bridge.page || Object.keys(S?.content?.files || {}).find(f => /^index\.html?$/i.test(f)) || 'index.html';
function wantsLive() { const pg = pageOf(); return Boolean(S && !editMode && S.siteMode === 'html' && !S.build && hostInfo?.view && livePages.has(pg) && !staticPages.has(pg)); }
const strHash = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return (h >>> 0).toString(36) + str.length; };
function marksOf(p) {
  if (!p) return [];
  if (p.kind === 'code') return (p.words || []).filter(v => v.length >= 2);
  const value = p.kind === 'item' ? Object.values(itemSpec(p).values || {}) : [].concat(edits.has(p.id) ? edits.get(p.id) : p.value);
  return value.map(v => show(v)).filter(v => v.length >= 2);
}
/** The address of `content` in the browser: the saved site, or a staged copy when some pages differ from it. */
async function liveUrl(content, marks, label, page = pageOf()) {
  const after = content?.files || {}, before = S.content.files || {};
  const files = Object.fromEntries(Object.entries(after).filter(([f, v]) => typeof v === 'string' && v !== before[f]));
  const enc = page.split('/').map(encodeURIComponent).join('/');
  if (!Object.keys(files).length) return hostInfo.view + enc;
  const key = strHash(JSON.stringify([files, marks, label]));
  if (!stageCache.has(key)) { stageCache.set(key, (await api('POST', '/api/preview/stage', { files, marks, label })).url); if (stageCache.size > 4) stageCache.delete(stageCache.keys().next().value); }
  return stageCache.get(key) + enc;
}
// A second frame beside the normal one: the normal preview keeps its page, and switching back is instant.
function liveFrame(br) {
  if (!br.liveEl) {
    br.liveEl = el('iframe', { class: 'live-frame', title: t('preview.liveTitle'), sandbox: 'allow-scripts allow-downloads allow-popups allow-forms allow-modals', hidden: '' });
    br.frame.after(br.liveEl); layoutFrames();
  }
  return br.liveEl;
}
// The saved website's version: the live page is loaded again when its files change (a suggestion accepted, an edit
// elsewhere), even at the same address.
let verOf = null, verVal = '';
function siteVersion() {
  const files = S?.content?.files; if (!files) return '';
  if (verOf !== files) { verOf = files; verVal = strHash(Object.entries(files).map(([k, v]) => k + ':' + (typeof v === 'string' ? strHash(v) : '')).join('|')); }
  return verVal;
}
function reloadLive(br) { const f = br.liveEl; if (f && br.inLive) f.setAttribute('src', f.getAttribute('src')); }   // setting src again loads it again
function setLive(br, url) { const f = liveFrame(br), ver = siteVersion(); if (f.getAttribute('src') !== url || br.liveVer !== ver) f.setAttribute('src', url); br.liveVer = ver; f.hidden = false; br.frame.hidden = true; br.inLive = true; }
function leaveLive(br) { if (!br.inLive) return; br.liveEl.setAttribute('src', 'about:blank'); br.liveEl.hidden = true; br.frame.hidden = false; br.inLive = false; br.lastDoc = null; }   // blank: its videos and sounds stop
bridgeB.onNavigate = f => { if (bridge.page !== f) { bridge.page = f; bridge.lastDoc = null; renderPreview(); } };
let navBusy = false;
// Plain HTML site with several pages: choose which page the preview shows (also for sites that move between pages
// with their own scripts, which the preview does not run).
function pagePicker() {
  const pick = $('page-pick');
  const pages = S && S.siteMode === 'html' && !S.build && S.content?.files ? Object.keys(S.content.files).filter(f => /\.html?$/i.test(f)) : [];
  pages.sort((a, b) => (/^index\.html?$/i.test(b) - /^index\.html?$/i.test(a)) || a.localeCompare(b));
  const live = $('open-live'), shown = bridge.page || bridge.build?.main || (S?.siteMode === 'html' ? pages.find(f => /^index\.html?$/i.test(f)) || pages[0] : null);
  live.hidden = !hostInfo?.view || !shown;
  const withChange = Boolean(liveChange());
  if (!live.hidden) { live.href = hostInfo.view + shown.split('/').map(encodeURIComponent).join('/'); live.textContent = t(withChange ? 'preview.openLiveChange' : 'preview.openLive'); live.title = t(withChange ? 'preview.openLiveChangeTip' : 'preview.openLiveTip'); }
  pick.hidden = pages.length < 2; if (pick.hidden) return;
  const key = pages.join('|');
  if (pick.dataset.key !== key) { pick.replaceChildren(...pages.map(f => el('option', { value: f }, f))); pick.dataset.key = key; }
  pick.value = shownPart && pages.includes(shownPart) ? shownPart : bridge.page && pages.includes(bridge.page) ? bridge.page : pages[0];
  pick.setAttribute('aria-label', t('preview.page'));
}
/** The suggestion the preview is showing in place, if the browser should show it too (plain HTML sites only). */
function liveChange() {
  if (!S || S.siteMode !== 'html' || S.build || view === 'b') return null;
  const p = S.proposals.find(x => x.id === selectedId);
  return p && ['PENDING', 'CONFLICT'].includes(p.status) && p.kind !== 'asset' ? p : null;
}
/** "Open in browser": the saved site, or, while a suggestion is selected, the site with that suggestion in place and its words highlighted. */
async function openLive(e) {
  const p = liveChange(); if (!p) return;   // the plain link opens the saved site
  e.preventDefault();
  const w = window.open('', '_blank');      // opened right away, so the browser does not block it
  try {
    const url = await liveUrl(withProposal(p), marksOf(p), t('preview.liveBanner', { label: p.kind === 'item' ? p.title || '' : fieldLabel(p.field) }));
    if (w) { w.opener = null; w.location = url; } else say(t('err.generic'), true);
  } catch (err) { w?.close(); say(errorText(err), true); }
}
$('open-live').addEventListener('click', openLive);
$('page-pick').onchange = () => { const f = $('page-pick').value; staticPages.delete(f); for (const b of [bridge, bridgeB]) { b.page = f; b.lastDoc = null; } renderPreview(); };
function pageCaption() {
  pagePicker();
  const page = $('page-pick').hidden && bridge.page && !/^index\.html?$/i.test(bridge.page) ? ' · ' + bridge.page : '';
  for (const id of ['cap-a', 'cap-b']) { const c = $(id); if (c.textContent) c.textContent = c.textContent.replace(/ · [^·]*\.html?$/i, '') + page; }
}
let loadedA = false, loadedB = false, lastRoot = null;
function resetWorkspaceUI() {
  loadedA = loadedB = false; chatLoaded = false; chatMessages = [];
  historyOpen = false; selectedId = null; view = 'a'; editMode = false; edits.clear(); itemEdits.clear(); materials = null;
  for (const w of working.values()) { clearTimeout(w.timer); clearTimeout(w.closeTimer); }   // cards at work belong to the website just left
  working.clear(); lastOrder = []; activityItems = null; histNodes.clear();
  MEM = { items: [], candidates: [] }; askWhy = null; loadMemory();
  livePages.clear(); staticPages.clear(); stageCache.clear(); shownPart = null; $('script-note').hidden = true; leaveLive(bridge); leaveLive(bridgeB);
  const box = document.getElementById('chat-input'); if (box) box.value = '';   // a half-typed request was for the website just left
}

async function refresh() {
  const st = await api('GET', '/api/state');
  settings = st.settings; S = st.workspace; hostInfo = st.host; sites = st.sites || [];
  const root = S?.workspace.root || null;
  if (root !== lastRoot) { lastRoot = root; resetWorkspaceUI(); if (root && !settings.tourDone) setTimeout(() => runTour(), 400); }   // another website (or none): nothing carries over
  if (S && (S.siteAdapter !== site.adapterId || (S.siteMode || null) !== (site.mode || null))) { site = siteAdapterFor({ siteAdapter: S.siteAdapter, mode: S.siteMode }); bridge.adapter = bridgeB.adapter = site; loadedA = loadedB = false; }
  models = await api('GET', '/api/models');
  render();
}

// ---------------------------------------------------------------- labels
const show = v => v == null ? '-' : Array.isArray(v) ? v.join(', ') : String(v);
const baseName = p => String(p).split('/').pop();
function projectTitle(id) { return S?.content?.projects?.find(p => p.id === id)?.title || id; }
function fieldLabel(path) {
  if (path.startsWith('asset:')) return t('field.asset', { file: baseName(path.slice(6)) });
  if (path.startsWith('items:')) return t('field.list', { name: listLabel(path.slice(6)) });
  if (path.startsWith('item:')) return t('field.list', { name: listLabel(path.slice(5)) });
  if (path.startsWith('code:')) return t('field.code', { file: path.slice(5) });
  if (path.startsWith('file:')) return t('field.file', { file: path.slice(5) });
  const parts = path.split('.');
  if (parts[0] === 'projects' && parts.length === 3 && (dict[`field.project.${parts[2]}`] ?? fallback[`field.project.${parts[2]}`])) return t(`field.project.${parts[2]}`, { project: projectTitle(parts[1]) });
  const key = `field.${path}`;
  if (dict[key] ?? fallback[key]) return t(key);
  return (S?.content && site.listEditableFields(S.content).find(f => f.path === path)?.label) || path;
}
function listLabel(id) { return (S?.content && site.listCollections?.(S.content).find(c => c.id === id)?.label) || id; }
const itemLabel = it => t(it.op === 'replace' ? 'h.item.replace' : 'h.item.add', { title: it.title, list: it.collection || '' });
// The quote from a Markdown or text material, shown the way it reads (no ** or list dashes).
const quoteText = p => /\.(md|markdown|mdx|txt)$/i.test(p.sourcePath || '') ? plainMarkdown(p.quote).replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '') : p.quote;
function sourceLabel(p) { const k = p.via || p.kind; return k === 'agent' ? t('source.agent', { client: p.client }) : k === 'chat' ? t('source.chat') : p.sourcePath; }
// Words a model wrote are in the language the interface had then. Shown only while it is still that language.
const reviewNote = p => p.review?.lang && !sameLang(p.review.lang) ? '' : p.review?.note;
const sameLang = x => !x || x === lang;
function reasonText(p) {
  if (p.kind === 'asset') return t('reason.asset');
  if (p.isMock) return t('reason.rule');
  if (p.kind === 'chat' && (!p.reason || p.reason === 'Requested in chat.')) return t('reason.chat');
  return p.lang && !sameLang(p.lang) ? '' : p.reason;
}
const kb = n => n == null ? t('asset.none') : n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`;

// ---------------------------------------------------------------- render
// Pages too large to read are named once per site and set of files, so the owner knows they will not be updated.
function skippedNote(S) {
  const enc = S.notUtf8Files || [], big = S.skippedFiles || [];
  const [files, msg] = enc.length ? [enc, 'skipped.encoding'] : [big, 'skipped.banner']; if (!files.length) return null;
  const key = 'sitetend.skipped.' + S.workspace.root + '|' + msg + '|' + files.join('|');
  try { if (localStorage.getItem(key)) return null; } catch {}
  return [el('span', {}, plural(t(msg, { n: files.length, files: files.slice(0, 3).join(', ') + (files.length > 3 ? ', …' : '') }), files.length)),
    el('button', { class: 'link', onclick: () => { try { localStorage.setItem(key, '1'); } catch {} render(); } }, t('skipped.ok'))];
}
let hadWorkspace = false, recoveredShown = null;
const keepMenusOnScreen = () => document.querySelectorAll('.popover:not([hidden])').forEach(m => keepOnScreen(m));
addEventListener('resize', keepMenusOnScreen);
// Panels never scroll sideways (focusing a control near the edge would otherwise shift the whole column out of view).
document.addEventListener('scroll', e => { const n = e.target; if (n instanceof Element && n.scrollLeft && /\b(panel-body|drawer-body|adv-col|sheet-body)\b/.test(n.className)) n.scrollLeft = 0; }, true); // first visit shows a bare top bar; after "switch workspace" the menus stay
function render() {
  if (S) hadWorkspace = true;
  $('welcome').hidden = Boolean(S); $('app').hidden = !S;
  $('welcome-lang').hidden = Boolean(S);
  document.body.classList.toggle('first-run', !S && !hadWorkspace);
  for (const id of ['check', 'undo', 'redo', 'publish', 'pub-label', 'pub-more']) $(id).hidden = !S;
  $('site-wrap').hidden = !S; renderConn(); renderSiteBtn(); syncButtons();
  requestAnimationFrame(keepMenusOnScreen);   // the top bar may have changed under an open menu
  if (!S) { renderWelcome(); return; }
  if (!S.canUndo) undoBlocked = false;
  if (S.recovered && recoveredShown !== S.workspace.root) { recoveredShown = S.workspace.root; say(t('msg.recovered')); }
  const adopt = msg => el('button', { onclick: () => act(async () => { await api('POST', '/api/adopt-disk', {}); undoBlocked = false; say(t(msg)); }) }, msg === 'msg.skipped' ? t('undo.skip') : t('adopt'));
  const buildKey = BUILD_DISMISS + S.workspace.root;
  let buildHidden = false; try { buildHidden = Boolean(localStorage.getItem(buildKey)); } catch {}
  const banner = undoBlocked ? [el('span', {}, t('undo.conflict')), adopt('msg.skipped')]
    : S.externalEditDetected ? [el('span', {}, t('external')), adopt('msg.adopted')]
    : S.buildSuggestion && !S.build && !buildHidden ? [el('span', {}, t(/^npm (install|i|ci)\b/.test(S.buildSuggestion.command) ? 'build.prepareSlow' : 'build.prepare')),
      // one click: Sitetend sets up the detected command itself (the command and folders are in Settings → Advanced, for developers)
      el('button', { onclick: () => act(async () => { const sug = S.buildSuggestion; buildStatus('running', { installs: /^npm (install|i|ci)\s*&&/.test(sug.command) }); await api('POST', '/api/build/config', { command: sug.command, generated: sug.generated }); await refresh(); }) }, t('build.prepareBtn')),
      el('button', { class: 'link', onclick: () => { try { localStorage.setItem(buildKey, '1'); } catch {} render(); } }, t('build.bannerNo'))]
    : skippedNote(S) || [];
  // after "Not now": a small button stays next to undo/redo, so the setup is easy to find again
  const bs = $('build-status');
  if (S.buildSuggestion && !S.build && buildHidden && buildRunningSince === null) {
    clearTimeout(buildStatusTimer); bs.hidden = false; bs.className = 'build-status idle'; bs.tabIndex = 0;
    bs.replaceChildren(el('span', {}, t('build.prepareBtn')));
    bs.onclick = () => act(async () => { const sug = S.buildSuggestion; buildStatus('running', { installs: /^npm (install|i|ci)\s*&&/.test(sug.command) }); await api('POST', '/api/build/config', { command: sug.command, generated: sug.generated }); await refresh(); });
    bs.title = t('build.prepareSlow');
  } else if (bs.classList.contains('idle')) { bs.hidden = true; bs.className = 'build-status'; bs.onclick = null; bs.title = ''; }
  $('banner').hidden = !banner.length;
  $('banner').replaceChildren(...banner);
  $('pub-label').textContent = !S.published ? t('published.none') : S.liveIsPublished ? t('published.yes') : t('published.no');
  if (selectedId && !S.proposals.some(p => p.id === selectedId)) selectedId = null;
  for (const id of [...edits.keys()]) if (!S.proposals.some(p => p.id === id && p.status === 'PENDING')) edits.delete(id);
  // Don't rebuild a card the user is typing in; live events would steal focus.
  if (document.activeElement?.classList.contains('edit-box')) cardsStale = true; else renderCards();
  renderHistory(); renderPreview(); renderChatUsage();
  if (!materials || materials.root !== S.workspace.root) { materials = { root: S.workspace.root, files: [], inbox: [], bytes: 0, kinds: [] }; loadMaterials(); }
  if (!chatLoaded) loadChat();
}

function syncButtons() {
  $('check').disabled = busy || !S; $('undo').disabled = busy || !S?.canUndo; $('redo').disabled = busy || !S?.canRedo;
  $('publish').disabled = busy || !S || S?.liveIsPublished;
  // Manual mode only records the published version; say so on the button itself.
  const mode = S?.publishMode || 'manual';
  $('publish').textContent = mode === 'manual' ? t('publish.mark') : t('publish');
  $('publish').title = t('publish.tip.' + mode);
}

// ---------------------------------------------------------------- appearance (light / dark)
const THEME_KEY = 'sitetend.theme';
const themeChoice = () => { try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; } };
function applyTheme(choice = themeChoice()) {
  const dark = choice === 'dark' || (choice === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme());

// ---------------------------------------------------------------- publish menu (⋯ next to Publish)
// Hosts Publish can upload to. Field: [name, label key, placeholder, note key, kind].
const HOST_NAME = { cloudflare: 'Cloudflare Pages', netlify: 'Netlify' };
const HOST_UI = {
  // The link opens Cloudflare's token page with the one permission needed already chosen (Account > Cloudflare Pages > Edit).
  cloudflare: { tokenUrl: 'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22page%22%2C%22type%22%3A%22edit%22%7D%5D&accountId=%2A&zoneId=all&name=Sitetend', steps: ['cf.step1', 'cf.step2', 'cf.step3'],
    fields: [['accountId', 'cf.account', '0123456789abcdef0123456789abcdef'], ['project', 'cf.project', 'my-site'], ['branch', 'cf.branch', () => t('cf.branchPh'), 'cf.branchNote']],
    previewOf: c => Boolean(c.branch) },
  netlify: { tokenUrl: 'https://app.netlify.com/user/applications#personal-access-tokens', steps: ['nl.step1', 'nl.step2'],
    fields: [['site', 'nl.site', 'mysite.netlify.app', 'nl.siteNote'], ['draft', 'nl.draft', '', 'nl.draftNote', 'bool']],
    previewOf: c => Boolean(c.draft) },
};
const isHost = m => Boolean(HOST_UI[m]);
function openPubMenu() {
  const m = $('pub-menu'), mode = S?.publishMode || 'manual';
  const set = next => act(async () => { await api('POST', '/api/settings', { publishMode: next }); openPubMenu(); if (isHost(next)) hostSetupIfNeeded(next); });
  const item = k => el('button', { class: 'mitem' + (mode === k ? ' active' : ''), onclick: () => set(k) }, el('span', { class: 'check' }, mode === k ? '✓' : ''),
    el('span', {}, el('div', {}, t('publish.mode.' + k)), el('div', { class: 'sub2' }, t('publish.mode.' + k + '.sub'))));
  const info = el('div', { class: 'mnote' }, '…');
  m.replaceChildren(el('h3', {}, t('settings.publish')), item('git'), item('cloudflare'), item('netlify'), item('manual'), el('div', { class: 'sep' }), info,
    el('div', { class: 'sep' }), zipLink('mitem'));
  api('GET', '/api/publish/status').then(st => { info.replaceChildren(...publishInfo(st, host => { closePubMenu(); hostDialog(host); })); }).catch(() => { info.textContent = ''; });
  popIn(m, $('pub-more')); $('pub-more').setAttribute('aria-expanded', 'true');
}
/** One or two lines about where Publish sends the site, for the menu and for Settings. */
function publishInfo(st, openSetup) {
  if (st.mode === 'git') return [st.git.available ? t('settings.publish.repo', { remote: st.git.remote, branch: st.git.branch || '', url: st.git.url || '' }) + (st.git.sitetendTracked ? ' ' + t('settings.publish.trackedWarn') : '') : t('err.' + st.git.reason)];
  if (isHost(st.mode)) {
    const host = st.mode, c = st[host], name = HOST_NAME[host];
    const target = c.project || c.site || '';
    const line = !c.ready ? t('host.notSetUp') : typeof c.files === 'number' ? t('host.ready', { name: target, n: c.files, folder: st.folder || t('host.folderRoot') }) : errorText({ code: c.files?.error, file: c.files?.file });
    const last = c.last ? t('host.last', { when: new Date(c.last.at).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' }), url: (c.last.production ? c.last.live : c.last.url) || c.last.url || '' }) : null;
    return [el('div', {}, line), last ? el('div', { class: 'muted' }, last) : null, el('button', { class: 'small-btn', type: 'button', onclick: () => openSetup(host) }, t(c.ready ? 'host.change' : 'host.setUp', { host: name }))];
  }
  return [t('publish.manual.zipHint')];
}
/** Download the website as one .zip (the files at the top level), e.g. to drag into a host's upload page. */
function zipLink(cls) {
  return el('a', { class: cls, href: `/api/publish/zip?t=${encodeURIComponent(TOKEN)}`, download: '', onclick: () => say(t('publish.zipMade')) },
    el('span', { class: 'h3-ico', html: icon('archive', 16) }), el('span', {}, t('publish.zip')));
}
async function hostSetupIfNeeded(host) {
  const st = await api('GET', '/api/publish/status').catch(() => null);
  if (st && !st[host]?.ready) { closePubMenu(); hostDialog(host); }
}
/** Settings for one host: its token (stored in ~/.sitetend/.env only), its own fields, the folder to upload. */
async function hostDialog(host) {
  const st = await api('GET', '/api/publish/status'); const c = st[host], ui = HOST_UI[host];
  const { d, body } = sheetDialog(HOST_NAME[host], t('host.sub', { host: HOST_NAME[host] }));
  const msg = el('div', { class: 'dlg-msg' });
  const token = el('input', { type: 'password', ...KEY_INPUT, placeholder: c.hasToken ? t('host.tokenSaved') : t('host.tokenPh') });
  const inputs = {};
  const rows = ui.fields.map(([k, label, ph, note, kind]) => {
    if (kind === 'bool') { inputs[k] = el('input', { type: 'checkbox', checked: Boolean(c[k]) }); return el('label', { class: 'mcheck', style: 'padding-left:0' }, inputs[k], el('span', {}, t(label), note ? el('span', { class: 'muted small', style: 'display:block' }, t(note)) : null)); }
    inputs[k] = el('input', { value: c[k] || '', placeholder: typeof ph === 'function' ? ph() : ph, spellcheck: 'false', autocomplete: 'off' });
    return el('label', { class: 'field-lbl' }, t(label), inputs[k], note ? el('span', { class: 'muted small' }, t(note)) : null);
  });
  const folder = el('input', { value: st.folder, placeholder: st.suggestedFolder || t('host.folderRoot'), spellcheck: 'false', autocomplete: 'off' });
  const values = () => ({ host, folder: folder.value, ...(token.value.trim() ? { token: token.value } : {}),
    ...Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.type === 'checkbox' ? i.checked : i.value])) });
  const save = async () => { await api('POST', '/api/publish/host', values()); token.value = ''; token.placeholder = t('host.tokenSaved'); };
  body.append(
    el('ol', { class: 'cf-steps' }, ...ui.steps.map((k, i) => el('li', {}, t(k), i === 0 ? [' ', el('a', { href: ui.tokenUrl, target: '_blank', rel: 'noopener' }, t(host === 'cloudflare' ? 'cf.tokenLink' : 'host.tokenLink'))] : null))),
    el('label', { class: 'field-lbl' }, t(host === 'netlify' ? 'nl.token' : 'cf.token'), token),
    ...rows,
    el('label', { class: 'field-lbl' }, t('host.folder'), folder, el('span', { class: 'muted small' }, st.suggestedFolder ? t('host.folderBuilt', { folder: st.suggestedFolder }) : t('host.folderNote'))),
    msg,
    el('div', { class: 'btns' },
      el('button', { type: 'button', onclick: () => closeDialog(d) }, t('cancel')),
      el('button', { type: 'button', onclick: async () => { let r = null; await inDialog(msg, async () => { await save(); r = await api('POST', '/api/publish/host/check', { host }); }, t('host.checking', { host: HOST_NAME[host] }));
        if (r) { msg.className = 'dlg-msg good'; msg.textContent = t('host.checked', { name: r.project || r.name, url: r.url || '', n: r.files }); } } }, t('host.test')),
      el('button', { type: 'button', class: 'primary', onclick: () => inDialog(msg, async () => { await save(); closeDialog(d); say(t('host.saved', { host: HOST_NAME[host] })); }) }, t('save'))));
  (c.hasToken ? Object.values(inputs)[0] : token).focus();
}
function closePubMenu() { popOut($('pub-menu')); $('pub-more').setAttribute('aria-expanded', 'false'); }
$('pub-more').onclick = e => { e.stopPropagation(); menuClosed('pub-menu') ? openPubMenu() : closePubMenu(); };
$('pub-menu').onclick = e => e.stopPropagation();
document.addEventListener('click', closePubMenu);

function renderConn() {
  const active = models?.profiles.find(p => p.id === models.active);
  $('conn-label').textContent = active ? modelName(active) : '-';
  $('conn-dot').className = 'dot ' + (!active ? '' : active.hasKey ? 'ok' : 'bad');
}

// ---------------------------------------------------------------- saved websites (top-left switcher, welcome list)
const siteName = s => !s.custom && s.demo ? t(s.demo === 'academic' ? 'sites.demoAcademic' : 'sites.demoPortfolio') : s.name;
function renderSiteBtn() {
  const cur = sites.find(s => s.current);
  $('site-label').textContent = cur ? siteName(cur) : S?.workspace.label || '-';
  $('site-btn').title = S?.workspace.root || '';
}
async function openSite(p) { closeSiteMenu(); await act(() => openFolder(p)); }
/** Opens a folder; if it is not a website, looks inside it and offers what it finds instead of an error. */
async function openFolder(p) {
  try { await api('POST', '/api/workspace/open', { path: p }); }
  catch (e) {
    if (e.code !== 'NOT_A_SITE') throw e;
    const r = await api('POST', '/api/workspace/find', { path: p });
    if (r.sites.length === 1) { await api('POST', '/api/workspace/open', { path: r.sites[0].path }); say(t('find.openedInside', { name: r.sites[0].name })); return; }
    showFound(r);
  }
}
function showFound(r) {
  const d = sheetDialog(t(r.sites.length ? 'find.title' : 'find.noneTitle'), r.folder);
  const pickAgain = () => { closeDialog(d.d); addSite(); };
  d.body.replaceChildren(
    el('p', { class: 'muted' }, r.sites.length ? t('find.found', { n: r.sites.length }) : t('find.none')),
    ...r.sites.map(x => el('div', { class: 'src-row' },
      el('div', { class: 'src-main' }, el('div', { class: 'src-name' }, x.name), el('div', { class: 'muted small mono ell' }, x.rel)),
      el('div', { class: 'src-btns' }, el('button', { class: 'primary', onclick: () => { closeDialog(d.d); act(() => api('POST', '/api/workspace/open', { path: x.path })); } }, t('find.open'))))),
    el('div', { class: 'ws-btns' }, el('button', { onclick: pickAgain }, t('find.pickAgain')),
      S ? null : el('button', { onclick: () => { closeDialog(d.d); act(() => api('POST', '/api/workspace/demo', {})); } }, t('help.demo'))));
}
async function addSite() {
  closeSiteMenu();
  await act(async () => { const r = await api('POST', '/api/workspace/pick', { title: t('welcome.pickTitle') }); if (r.path) await openFolder(r.path); else if (r.unavailable) say(t('welcome.noPicker')); });
}
// The site in use can be removed too: Sitetend closes it first and goes back to the start page (files are never touched).
async function removeSite(s) { await act(async () => { if (s.current) { closeSiteMenu(); await api('POST', '/api/workspace/close', {}); } sites = await api('POST', '/api/sites/remove', { path: s.path }); say(t('sites.removed', { name: siteName(s) })); }); renderSiteBtn(); if (!$('site-menu').hidden) openSiteMenu(); if (!S) renderWelcome(); }
/** One saved site as a row: click to open; pencil to rename in place; × to forget it (files are not touched). */
function siteRow(s, { inMenu }) {
  const row = el('div', { class: 'site-row' + (s.current ? ' current' : '') + (s.missing ? ' missing' : '') });
  const main = el('button', { class: 'mitem', disabled: s.missing || s.current ? true : null, title: s.path, onclick: () => openSite(s.path) },
    inMenu ? el('span', { class: 'check' }, s.current ? '✓' : '') : null,
    el('span', { class: 'site-text' }, el('span', { class: 'mlabel' }, siteName(s)), el('span', { class: 'sub2' }, s.missing ? t('sites.missing') : s.path)));
  const rename = el('button', { class: 'icon tiny', title: t('sites.rename'), 'aria-label': t('sites.rename'), html: icon('pencil', 14),
    onclick: e => { e.stopPropagation(); startRename(row, s, inMenu); } });
  const remove = el('button', { class: 'icon tiny', title: t('sites.removeTip'), 'aria-label': t('sites.remove'), html: icon('x', 14),
    onclick: e => { e.stopPropagation(); removeSite(s); } });
  row.append(main, el('span', { class: 'row-tools' }, s.missing ? null : rename, remove));
  return row;
}
function startRename(row, s, inMenu) {
  const input = el('input', { value: s.custom ? s.name : siteName(s), placeholder: t('sites.renameHint'), 'aria-label': t('sites.rename') });
  const done = async save => {
    if (save) await act(async () => { sites = await api('POST', '/api/sites/rename', { path: s.path, name: input.value }); });
    renderSiteBtn(); if (inMenu) openSiteMenu(); else renderWelcome();
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); done(true); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); } });
  input.addEventListener('blur', () => { if (input.isConnected) done(true); });
  row.replaceChildren(el('div', { class: 'rename-row' }, input, el('span', { class: 'sub2' }, t('sites.renameHint'))));
  input.focus(); input.select();
}
function openSiteMenu() {
  const m = $('site-menu');
  // the user's own sites first; the two sample sites sit quietly in their own group at the bottom, always there to open.
  const sample = kind => { const s = sites.find(x => x.demo === kind); return s ? siteRow(s, { inMenu: true })
    : el('button', { class: 'mitem maction', onclick: () => { closeSiteMenu(); act(() => api('POST', '/api/workspace/demo', kind === 'academic' ? { kind } : {})); } },
        el('span', { class: 'check' }), t(kind === 'academic' ? 'sites.demoAcademic' : 'sites.demoPortfolio')); };
  m.replaceChildren(el('h3', {}, t('sites.title')), ...sites.filter(s => !s.demo).map(s => siteRow(s, { inMenu: true })),
    el('button', { class: 'mitem maction', onclick: addSite }, el('span', { class: 'check', html: icon('plus', 14) }), t('sites.add')),
    el('div', { class: 'sep' }), el('h3', { class: 'msub' }, t('sites.samples')), sample('portfolio'), sample('academic'));
  popIn(m, $('site-btn')); $('site-btn').setAttribute('aria-expanded', 'true');
}
function closeSiteMenu() { popOut($('site-menu')); $('site-btn').setAttribute('aria-expanded', 'false'); }
$('site-btn').onclick = e => { e.stopPropagation(); closeConnMenu(); menuClosed('site-menu') ? openSiteMenu() : closeSiteMenu(); };
$('site-menu').onclick = e => e.stopPropagation();
document.addEventListener('click', closeSiteMenu);

/** A settings group's heading with its icon, so a group is found by shape before its words are read. */
const secHead = (name, text) => el('h3', { class: 'sec-head', 'data-sec': name }, el('span', { class: 'h3-ico', html: icon(name, 15) }), el('span', {}, text));

// ---------------------------------------------------------------- build step (pages generated by a script)
const BUILD_DISMISS = 'sitetend.buildHint.';
/** Settings: the command that regenerates the site, and the files it makes (Sitetend never edits those). */
/** Build progress that stays on screen: spinner while the site is rebuilt, then the result (failure stays until clicked). */
let buildStatusTimer = null;
let buildRunningSince = null, buildLiveTimer = null, buildInstalls = false, buildPillTimer = null;
/** The progress line inside Settings → Build step (the toolbar status is hidden behind the open drawer). */
function renderBuildLive() {
  const live = $('build-live'); if (!live) { clearInterval(buildLiveTimer); return; }
  const since = buildRunningSince ?? (S?.build?.running ? S.build.startedAt || Date.now() : null);
  if (since === null) { live.hidden = true; clearInterval(buildLiveTimer); return; }
  const secs = Math.max(0, Math.round((Date.now() - since) / 1000));
  const installing = buildInstalls;
  live.hidden = false;
  live.replaceChildren(el('span', { class: 'spinner', 'aria-hidden': 'true' }),
    el('span', {}, el('strong', {}, t('build.status.running')), ' ', t('build.live.elapsed', { s: secs })),
    ...(installing ? [el('div', { class: 'muted small' }, t('build.live.firstTime'))] : []));
  if (!buildLiveTimer) buildLiveTimer = setInterval(() => { if (!$('build-live')) { clearInterval(buildLiveTimer); buildLiveTimer = null; return; } renderBuildLive(); }, 1000);
}
function buildStatus(state, d = {}) {
  const b = $('build-status'); clearTimeout(buildStatusTimer);
  if (state === 'running') { buildRunningSince ??= Date.now(); if ('installs' in d) buildInstalls = d.installs; } else { buildRunningSince = null; clearInterval(buildLiveTimer); buildLiveTimer = null; }
  if ($('build-live')) { if (state === 'running') renderBuildLive(); else refresh().then(() => { if ($('build-live')) openDrawer(); }).catch(() => {}); }
  $('frames')?.classList.toggle('rebuilding', state === 'running');
  b.className = 'build-status ' + state; b.hidden = false; b.onclick = null; b.removeAttribute('tabindex');
  if (state === 'running') {
    const label = el('span', {}), tick = () => { const secs = Math.round((Date.now() - (buildRunningSince || Date.now())) / 1000); label.textContent = t(buildInstalls ? 'build.status.preparing' : 'build.status.running') + (secs >= 3 ? ' ' + t('build.live.elapsed', { s: secs }) : ''); };
    tick(); b.replaceChildren(el('span', { class: 'spinner', 'aria-hidden': 'true' }), label);
    clearInterval(buildPillTimer); buildPillTimer = setInterval(() => { if (b.classList.contains('running')) tick(); else clearInterval(buildPillTimer); }, 1000);
  }
  else if (state === 'done') {
    b.replaceChildren(el('span', { class: 'bs-ico', html: icon('check', 14) }), el('span', {}, t('build.status.done', { s: d.ms ? (d.ms / 1000).toFixed(1) : '?' })));
    buildStatusTimer = setTimeout(() => { b.hidden = true; }, 8000);
  } else {
    b.replaceChildren(el('span', { class: 'bs-ico', html: icon('alert', 14) }), el('span', {}, t('build.status.failed')));
    b.tabIndex = 0; b.onclick = () => { b.hidden = true; advOpen = true; openDrawer(); setTimeout(() => $('build-live')?.closest('section')?.scrollIntoView({ block: 'center' }), 350); };
  }
}
function buildSection() {
  const b = S.build, sug = S.buildSuggestion;
  const cmd = el('input', { value: b?.command || sug?.command || '', placeholder: 'python build.py', 'aria-label': t('build.command'), spellcheck: 'false' });
  const gen = el('input', { value: (b?.generated || sug?.generated || []).join(', '), placeholder: 'index.html', 'aria-label': t('build.generated'), spellcheck: 'false' });
  const last = b?.last, running = Boolean(b?.running) || buildRunningSince !== null;
  const live = el('div', { id: 'build-live', class: 'build-live', role: 'status', 'aria-live': 'polite' });
  setTimeout(() => renderBuildLive(), 0);
  return el('section', { class: 'build-sec' }, secHead('terminal', t('build.title')),
    el('div', { class: 'muted' }, b ? t('build.on') : sug ? t('build.found', { command: sug.command }) : t('build.off')),
    el('label', { class: 'field-lbl' }, t('build.command'), cmd),
    el('label', { class: 'field-lbl' }, t('build.generated'), gen, el('span', { class: 'muted' }, t('build.generatedHint'))),
    live,
    !running && last ? el('div', { class: 'build-last ' + (last.ok ? 'ok' : 'bad') }, last.ok ? t('build.lastOk', { s: (last.ms / 1000).toFixed(1) }) : t('build.lastFail'),
      !last.ok && last.output ? el('pre', {}, last.output) : null) : null,
    el('div', { class: 'ws-btns' },
      el('button', { class: 'primary', disabled: running || null, onclick: () => act(async () => { if (cmd.value.trim()) buildStatus('running', { installs: /^npm (install|i|ci)\s*&&/.test(cmd.value.trim()) && !S.build }); await api('POST', '/api/build/config', { command: cmd.value, generated: gen.value }); say(cmd.value.trim() ? t('build.saved') : t('build.cleared')); await refresh(); openDrawer(); }) }, b ? t('build.update') : t('build.enable')),
      b ? el('button', { disabled: running || null, onclick: () => act(async () => { buildStatus('running'); await api('POST', '/api/build/run', {}); }) }, t('build.runNow')) : null,
      b ? el('button', { onclick: () => act(async () => { await api('POST', '/api/build/config', { command: '' }); say(t('build.cleared')); await refresh(); openDrawer(); }) }, t('build.disable')) : null),
    b ? el('div', { class: 'muted small' }, t('build.buttonsHint')) : null,
    el('div', { class: 'muted small' }, t('build.safety')));
}

// ---------------------------------------------------------------- first-time guide
let tourOn = false;
/** Walks through the main areas once. On the portfolio demo it first makes a sample change so there is a real card to show. */
async function runTour() {
  if (tourOn || !S) return; tourOn = true;
  closeDrawer(); closeConnMenu(); closeSiteMenu(); closePubMenu();
  if (historyOpen) { historyOpen = false; renderHistory(); }
  const firstCard = () => document.querySelector('#cards article.card.PENDING') || document.querySelector('#cards article.card');
  const isDemo = sites.find(s => s.current)?.demo === 'portfolio';
  if (isDemo && !S.proposals?.some(p => p.status === 'PENDING')) {
    api('POST', '/api/demo/change', { kind: 'email' }).then(() => api('POST', '/api/check', {})).then(() => refresh()).catch(() => {});
  }
  const step = (target, key, extra = {}) => ({ target, title: t(`tour.${key}.title`), body: t(`tour.${key}.body`), ...extra });
  startTour({
    t,
    steps: [
      step(() => $('site-btn'), 'site'),
      step(() => $('materials'), 'materials'),
      step(() => $('check'), 'check'),
      firstCard() ? step(firstCard, 'card')
        : isDemo ? step(() => $('cards'), 'card', { body: t('tour.card.waiting'), foundBody: t('tour.card.body'), wait: firstCard })
        : step(() => $('cards'), 'card', { body: t('tour.card.none') }),
      // In reading order across the screen: down the left column, then the preview, then the top-right actions.
      step(() => $('chat'), 'chat'),
      step(() => $('frames'), 'preview'),
      step(() => $('undo'), 'undo', { side: 'left' }),
      step(() => $('publish'), 'publish', { side: 'left' }),
    ],
    onEnd: () => { tourOn = false; if (!settings.tourDone) { settings.tourDone = true; api('POST', '/api/settings', { tourDone: true }).catch(() => {}); } },
  });
}

function renderWelcome() {
  // Language can be chosen before anything is opened (each name is written in its own language).
  $('welcome-lang').replaceChildren(...LANGS.map(([v, n]) => el('button', { class: 'link' + (lang === v ? ' on' : ''), lang: v, 'aria-current': lang === v ? 'true' : null,
    onclick: () => act(async () => { if (lang === v) return; await api('POST', '/api/settings', { language: v }); settings.language = v; await loadLang(v); renderWelcome(); }) }, n)));
  const mine = sites.filter(s => !s.demo);   // the demos have their own buttons
  $('recent').replaceChildren(...(mine.length ? [el('h3', {}, t('sites.mine')), el('div', { class: 'site-list' }, ...mine.map(s => siteRow(s, { inMenu: false })))] : []));
  renderWelcomeShortcut();
}
// Offered on the welcome page until there is a shortcut: next time, a double-click on the icon opens Sitetend.
async function renderWelcomeShortcut() {
  const box = $('welcome-shortcut');
  if (!appInfo) { try { appInfo = await api('GET', '/api/app'); } catch { return; } }
  box.hidden = Boolean(appInfo.shortcut);
  box.replaceChildren(el('button', { class: 'link', onclick: () => act(async () => { appInfo = await api('POST', '/api/app/shortcut', {}); say(t('app.shortcutMade.' + platKey())); renderWelcomeShortcut(); }) }, t('app.welcomeShortcut')));
}

// ---- suggestion cards
// ---- my materials (drop a file -> check what it is -> confirm -> filed under sources/<kind>/)
let materials = null, materialsOpen = false;
async function loadMaterials() { if (!S) { materials = null; return; } try { materials = { ...(await api('GET', '/api/materials')), root: S.workspace.root }; } catch { } renderMaterials(); }
const mb = n => n == null ? '' : n === 0 ? '0 KB' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`;
function warnText(w) {
  if (w.code === 'EMAIL_MISMATCH') return t('mat.warn.email', { file: w.file.join(', '), known: w.known.join(', ') });
  if (w.code === 'NAME_MISSING') return t('mat.warn.name', { known: w.known.join(' / ') });
  if (w.code === 'KIND_DISAGREE') return t('mat.warn.kind', { rule: t('mat.kind.' + w.rule), ai: t('mat.kind.' + w.ai) }) + (w.why ? ' ' + w.why : '');
  if (w.code === 'NO_TEXT') return t('mat.warn.noText');
  return w.code;
}
function renderMaterials() {
  const box = $('materials'); if (!box) return;
  if (!S || !materials) { box.replaceChildren(); return; }
  const kinds = materials.kinds;
  const inbox = materials.inbox.map(item => {
    const sel = el('select', {}, ...kinds.map(k => el('option', { value: k, selected: k === item.kind }, t('mat.kind.' + k))));
    return el('article', { class: 'card mat-inbox' + (item.warnings.length ? ' warn' : '') },
      el('div', { class: 'field' }, '📄 ' + item.name), el('div', { class: 'meta' }, `${mb(item.size)} · ${t('mat.checked.' + (item.ai ? 'ai' : 'rule'))}`),
      el('label', { class: 'mat-kind' }, t('mat.is'), ' ', sel),
      item.replaces ? el('div', { class: 'meta' }, t('mat.replaces', { file: baseName(item.replaces) })) : null,
      ...item.warnings.map(w => el('div', { class: 'review flag' }, '⚠ ' + warnText(w))),
      el('div', { class: 'btns' },
        el('button', { class: 'primary', onclick: () => act(async () => { await api('POST', '/api/materials/confirm', { id: item.id, kind: sel.value }); say(t('mat.filed')); await loadMaterials(); }) }, item.replaces ? t('mat.confirmReplace') : t('mat.confirm')),
        el('button', { onclick: () => act(async () => { await api('POST', '/api/materials/discard', { id: item.id }); await loadMaterials(); }) }, t('cancel'))));
  });
  const byKind = kinds.map(k => [k, materials.files.filter(f => f.kind === k)]).filter(([, f]) => f.length);
  const list = materialsOpen ? el('div', { class: 'mat-list' }, ...byKind.map(([k, fs]) => el('div', {}, el('div', { class: 'mat-k' }, t('mat.kind.' + k)),
    ...fs.map(f => el('div', { class: 'mat-f', title: f.path }, el('span', {}, f.name), el('span', { class: 'muted' }, [mb(f.size), f.modified ? new Date(f.modified).toLocaleDateString() : ''].filter(Boolean).join(' · ')))))),
    el('div', { class: 'mat-actions' }, el('button', { class: 'link small', onclick: () => $('mat-file').click() }, t('mat.add')),
      el('button', { class: 'link small', onclick: () => act(async () => { await api('POST', '/api/workspace/reveal', { which: 'sources' }); }) }, t('mat.open')),
      el('button', { class: 'link small', onclick: () => openFormatHelp('materials') }, t('help.matLink')))) : null;
  if (!materials.files.length && !materials.inbox.length) {
    box.replaceChildren(el('div', { class: 'mat-empty', onclick: () => $('mat-file').click() }, el('strong', {}, t('mat.emptyTitle')), el('div', {}, t('mat.emptyBody')),
      el('button', { class: 'link small', onclick: e => { e.stopPropagation(); openFormatHelp('materials'); } }, t('help.matLink'))));
    return;
  }
  box.replaceChildren(
    el('button', { class: 'mat-head', onclick: () => { materialsOpen = !materialsOpen; renderMaterials(); } },
      el('span', { class: 'mat-title' }, el('span', { class: 'chev' + (materialsOpen ? ' open' : ''), html: icon('chevron-right', 14) }), t('mat.title')), el('span', { class: 'muted' }, t('mat.summary', { n: materials.files.length, size: mb(materials.bytes) }))),
    ...(list ? [list] : []), ...inbox,
    // Always visible, so people know they can drop files (anywhere on the window works too).
    el('button', { class: 'mat-drop', onclick: () => $('mat-file').click() }, el('span', { class: 'h3-ico', html: icon('upload', 16) }), el('span', {}, t('mat.dropHint'))));
}
async function uploadFiles(files) {
  for (const f of files) {
    if (f.size > 20 * 1024 * 1024) { say(t('err.MATERIAL_TOO_LARGE'), true); continue; }
    try {
      const res = await fetch('/api/materials/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Sitetend-Token': TOKEN, 'X-File-Name': encodeURIComponent(f.name) }, body: await f.arrayBuffer() });
      const j = await res.json(); if (!j.ok) throw Object.assign(Error(j.error.message), { code: j.error.code });
      say(t('mat.received', { file: f.name }));
    } catch (e) { say(errorText(e), true); }
  }
  await loadMaterials();
}
$('mat-file').onchange = e => { uploadFiles([...e.target.files]); e.target.value = ''; };
let dragDepth = 0;
addEventListener('dragenter', e => { if (!S || !e.dataTransfer?.types?.includes('Files')) return; dragDepth++; $('dropzone').hidden = false; });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropzone').hidden = true; } });
addEventListener('dragover', e => { if (S && e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
addEventListener('drop', e => { if (!S || !e.dataTransfer?.files?.length) return; e.preventDefault(); dragDepth = 0; $('dropzone').hidden = true; uploadFiles([...e.dataTransfer.files]); });

function renderCards() {
  const open = S.proposals.filter(p => p.status === 'PENDING' && !working.has(p.id));
  const skipped = (S.lastScan?.results || []).filter(r => r.status === 'EXCLUDED');
  $('bulk').replaceChildren(...(open.length > 1 ? [el('button', { class: 'primary', onclick: () => acceptAll(open) }, t('acceptAll', { n: open.length }))] : []),
    ...(skipped.length ? [el('div', { class: 'muted privacy-note', title: skipped.map(r => r.path).join('\n') }, '🔒 ' + t('privacy.skipped', { n: skipped.length, files: skipped.map(r => baseName(r.path)).join(', ') }))] : []));
  const live = [...S.proposals].reverse(), byId = new Map(live.map(p => [p.id, p]));
  // order: new cards on top, then everything in the order it was shown; a card at work keeps its place even after it left the list
  const ids = [...live.filter(p => !lastOrder.includes(p.id)).map(p => p.id), ...lastOrder.filter(id => byId.has(id) || working.has(id))];
  for (const id of working.keys()) if (!ids.includes(id)) ids.push(id);
  lastOrder = ids;
  const extra = [askWhy ? whyCard() : null, ...MEM.candidates.map(candidateCard)].filter(Boolean);
  if (!ids.length && !extra.length) { $('cards').replaceChildren(el('div', { class: 'empty' }, el('strong', {}, t('empty.title')), t('empty.body'))); return; }
  flip($('cards'), () => $('cards').replaceChildren(...extra, ...ids.map(id => working.has(id) ? workCard(id, working.get(id)) : card(byId.get(id)))));
}

/** One line that says what a collapsed card changes. */
function cardSummary(p) {
  if (p.kind === 'item') return el('div', { class: 'gist' }, el('span', { class: 'ins' }, (p.op === 'replace' ? t('item.gist.replace', { title: p.replacedTitle || '' }) : t('item.gist.add')) + ' ' + (p.title || '')));
  if (p.kind === 'asset') return el('div', { class: 'gist' }, t('card.gist.file'));
  if (p.kind === 'code') return el('div', { class: 'gist' }, el('span', { class: 'ins' }, p.summary || ''));
  const after = edits.has(p.id) ? edits.get(p.id) : p.value;
  return el('div', { class: 'gist', title: `${t('before')}: ${show(p.before)}` }, el('span', { class: 'muted' }, t('card.gist.to') + ' '), el('span', { class: 'ins' }, show(after)));
}
// ---- memory in the suggestion list ----
const memDate = n => new Date(n.createdAt).toLocaleDateString(lang, { dateStyle: 'medium' });
/** "Following what you said on 16 Nov: …" for each note a suggestion followed. */
function memoryLines(p) {
  return (p.memory || []).map(id => {
    const n = MEM.items.find(x => x.id === id);
    return el('div', { class: 'review mem', title: n?.from?.quote || '' }, el('span', { class: 'h3-ico', html: icon('bookmark', 14) }), ' ', n ? t('mem.followed', { date: memDate(n), text: n.text }) : t('mem.followedGone'));
  });
}
/** After a reject: an optional "why?" (two of the answers become a note for next time). */
function whyCard() {
  const a = askWhy, done = () => { askWhy = null; renderCards(); };
  const pick = reason => act(async () => {
    const text = reason === 'notYet' ? t('mem.text.notYet', { label: a.label, value: a.value }) : reason === 'private' ? t('mem.text.private', { label: a.label, value: a.value }) : undefined;
    const r = await api('POST', '/api/proposals/reject-reason', { id: a.id, reason, text });
    done(); if (r.note) { say(t('mem.saved')); loadMemory(); }
  });
  return el('article', { class: 'card ask', 'data-key': 'why-' + a.id },
    el('div', { class: 'ask-head' }, el('div', { class: 'field' }, t('why.title')), el('button', { class: 'icon-btn', 'aria-label': t('close'), title: t('close'), onclick: done, html: icon('x', 16) })),
    el('div', { class: 'meta' }, t('why.sub', { label: a.label })),
    el('div', { class: 'chips' }, ...['wrong', 'notYet', 'private', 'wording', 'other'].map(k => el('button', { class: 'small-btn', onclick: () => pick(k) }, t('why.' + k)))));
}
/** The note a "remember this?" question would save, in the owner's language. */
function ruleText(c) {
  const r = c.rule || {}, ex = c.examples?.at(-1) || {};
  return r.type === 'replace' ? t('mem.rule.replace', { from: r.from, to: r.to }) : t('mem.rule.' + r.type, { from: ex.from || '', to: ex.to || '' });
}
function candidateCard(c) {
  const answer = remember => act(async () => { await api('POST', '/api/memory/candidate', { id: c.id, remember, text: remember ? ruleText(c) : undefined }); if (remember) say(t('mem.saved')); await loadMemory(); });
  return el('article', { class: 'card ask', 'data-key': c.id },
    el('div', { class: 'field' }, el('span', { class: 'h3-ico', html: icon('bookmark', 16) }), ' ', t('mem.ask.title')),
    el('div', { class: 'ask-body' }, t('mem.ask.body', { n: c.examples.length })),
    el('ul', { class: 'ask-examples' }, ...c.examples.slice(-2).map(e => el('li', {}, el('span', { class: 'del' }, e.from), ' → ', el('span', { class: 'ins' }, e.to)))),
    el('div', { class: 'meta' }, t('mem.ask.note', { text: ruleText(c) })),
    el('div', { class: 'btns' }, el('button', { class: 'primary', onclick: () => answer(true) }, t('mem.ask.yes')), el('button', { onclick: () => answer(false) }, t('mem.ask.no'))));
}
/** Settings > Advanced > Memory: every note, where it came from, and controls to change, pause or remove it. */
function memorySection() {
  const list = el('div', { class: 'mem-list' });
  const from = n => t('mem.from.' + (n.from?.type || 'manual'));
  const row = n => {
    const text = el('div', { class: 'mem-text' + (n.status !== 'active' ? ' off' : '') }, n.text);
    const edit = () => {
      const box = el('textarea', { class: 'edit-box', rows: '2', 'aria-label': t('mem.edit') }); box.value = n.text;
      const save = () => act(async () => { if (box.value.trim() && box.value.trim() !== n.text) await api('POST', '/api/memory/update', { id: n.id, text: box.value }); await loadMemory(); });
      text.replaceWith(el('div', { class: 'mem-editing' }, box, el('div', { class: 'btns' }, el('button', { class: 'small-btn primary', onclick: save }, t('save')), el('button', { class: 'small-btn', onclick: () => render() }, t('cancel')))));
      box.focus();
    };
    return el('div', { class: 'mem-row' }, text,
      el('div', { class: 'muted mem-meta', title: n.from?.quote || '' }, [from(n), memDate(n), t(n.scope === 'all' ? 'mem.scope.all' : 'mem.scope.site'), n.usedCount ? t('mem.used', { n: n.usedCount }) : null, n.status === 'paused' ? t('mem.paused') : null].filter(Boolean).join(' · ')),
      el('div', { class: 'mem-actions' },
        el('button', { class: 'small-btn', onclick: edit }, t('mem.edit')),
        el('button', { class: 'small-btn', onclick: () => act(async () => { await api('POST', '/api/memory/update', { id: n.id, status: n.status === 'paused' ? 'active' : 'paused' }); await loadMemory(); }) }, t(n.status === 'paused' ? 'mem.resume' : 'mem.pause')),
        n.kind === 'preference' ? el('button', { class: 'small-btn', onclick: () => act(async () => { await api('POST', '/api/memory/update', { id: n.id, scope: n.scope === 'all' ? 'site' : 'all' }); await loadMemory(); }) }, t(n.scope === 'all' ? 'mem.toSite' : 'mem.toAll')) : null,
        el('button', { class: 'small-btn', onclick: () => act(async () => { await api('POST', '/api/memory/remove', { id: n.id }); say(t('mem.removed')); await loadMemory(); }) }, t('mem.remove'))));
  };
  const render = () => {
    if (!list.isConnected && list.dataset.shown) { memoryViews.delete(render); return; }
    list.dataset.shown = '1';
    if (!MEM.items.length) { list.replaceChildren(el('div', { class: 'muted' }, t('mem.none'))); return; }
    list.replaceChildren(...['preference', 'decision', 'answer'].flatMap(kind => {
      const items = MEM.items.filter(n => n.kind === kind);
      return items.length ? [el('div', { class: 'mem-group' }, t('mem.kind.' + kind)), ...items.map(row)] : [];
    }));
  };
  memoryViews.add(render); render();
  const box = el('textarea', { class: 'edit-box', rows: '2', placeholder: t('mem.add.ph'), 'aria-label': t('mem.add') });
  const kind = el('select', { 'aria-label': t('mem.add.kind') }, el('option', { value: 'preference' }, t('mem.kind.preference')), el('option', { value: 'decision' }, t('mem.kind.decision')));
  const add = () => act(async () => { if (!box.value.trim()) { box.focus(); return; } await api('POST', '/api/memory', { kind: kind.value, text: box.value, lang }); box.value = ''; say(t('mem.saved')); await loadMemory(); });
  return el('section', {}, secHead('bookmark', t('mem.title')),
    el('div', { class: 'muted' }, t('mem.note')),
    list,
    el('div', { class: 'mem-add' }, box, el('div', { class: 'mem-add-row' }, kind, el('button', { onclick: add }, t('mem.add')))));
}

function card(p) {
  const pending = p.status === 'PENDING';
  const pick = e => { if (e.target.closest('button,textarea,input,select,a')) return; selectCard(selectedId === p.id ? null : p.id); };
  // Collapsed unless it is the selected card or the only open one: title, source, a one-line before → after, and the buttons.
  const openCount = S.proposals.filter(x => x.status === 'PENDING').length;
  const expanded = p.id === selectedId || (pending && openCount === 1) || p.status === 'CONFLICT';
  if (!expanded) return el('article', { class: `card compact ${p.status}`, 'data-key': p.id, tabindex: '0', onclick: pick, onkeydown: e => { if (e.key === 'Enter' && e.target === e.currentTarget) selectCard(p.id); }, title: t('card.expand') },
    el('div', { class: 'field' }, p.kind === 'item' ? t('item.head', { list: p.collectionLabel }) : fieldLabel(p.field),
      p.review?.verdict === 'flag' ? el('span', { class: 'flag-dot', title: reviewNote(p) || t('review.flag') }, ' ⚠') : null),
    el('div', { class: 'meta' }, `${t('source')}: ${sourceLabel(p)}`, pending ? '' : ` · ${t('status.' + p.status)}`),
    cardSummary(p),
    cardButtons(p));
  return el('article', { class: `card ${p.status}${p.id === selectedId ? ' selected' : ''}`, 'data-key': p.id, tabindex: '0', onclick: pick },
    el('div', { class: 'field' }, p.kind === 'item' ? t('item.head', { list: p.collectionLabel }) : fieldLabel(p.field)),
    el('div', { class: 'meta' }, `${t('source')}: ${sourceLabel(p)}`, pending ? '' : ` · ${t('status.' + p.status)}`),
    p.kind === 'item' ? itemBlock(p) : p.kind === 'asset' ? assetBlock(p) : p.kind === 'code' ? codeBlock(p) : el('dl', { class: 'diff' },
      el('dt', {}, t('before')), el('dd', { class: 'del' }, show(p.before)),
      el('dt', {}, t('after')), pending ? el('dd', {}, editor(p)) : el('dd', { class: 'ins' }, show(p.value))),
    p.status === 'CONFLICT' && p.conflict && p.kind !== 'asset' && p.kind !== 'code' ? el('div', { class: 'note' }, el('strong', {}, t('card.nowOnSite') + ': '), show(p.conflict.current)) : null,
    p.kind === 'asset' || !p.quote || (p.kind !== 'item' && sameText(quoteText(p), show(p.value))) ? null : el('blockquote', { title: t('card.evidence') }, quoteText(p)),
    reasonText(p) && !(p.kind === 'code' && reasonText(p) === p.summary) ? el('div', { class: 'meta' }, `${t('why')}: ${reasonText(p)}`) : null,
    ...(pending ? copiesLine(p) : []),
    ...memoryLines(p),
    p.review?.verdict === 'flag' ? el('div', { class: 'review flag' }, el('strong', {}, '⚠ ' + t('review.flag') + ' '), reviewNote(p) || '')
      : p.review?.verdict === 'remind' ? el('div', { class: 'review remind' }, '↻ ' + (reviewNote(p) || t('review.remind')))
      : p.review?.verdict === 'approve' ? el('div', { class: 'review ok', title: reviewNote(p) || '' }, '✓ ' + t('review.ok'))
      : p.review?.verdict === 'unreviewed' ? el('div', { class: 'review muted' }, t('review.none')) : null,
    cardButtons(p));
}

/** A new item for a list: its values (editable), where it goes (top / bottom / instead of an existing item), and notes. */
function itemState(p) {
  if (!itemEdits.has(p.id)) itemEdits.set(p.id, { op: p.op === 'replace' ? 'replace' : 'add', key: p.replaceKey ?? null, position: p.position || 'end', values: { ...p.values } });
  return itemEdits.get(p.id);
}
function itemSpec(p) { const st = itemEdits.get(p.id); return st ? { ...st } : { op: p.op === 'replace' ? 'replace' : 'add', key: p.replaceKey ?? null, position: p.position || 'end', values: p.values }; }
function itemBlock(p) {
  const pending = p.status === 'PENDING';
  const coll = site.listCollections?.(S.content).find(c => c.id === p.collection);
  const notes = [
    ...(p.missing?.length ? [t('item.missing', { fields: p.missing.join(', ') })] : []),
    ...(p.warnings || []).filter(w => !(w.code === 'ASSET_FROM_TEMPLATE' && itemEdits.get(p.id)?.values?.[w.field])).map(w => t('item.warn.' + ({ ASSET_FROM_TEMPLATE: 'asset', KEPT_FROM_TEMPLATE: 'kept', DATE_TODAY: 'date', NESTED_CLEARED: 'nested', LINK_EMPTY: 'link' }[w.code] || 'kept'), { field: w.field, value: show(w.value) }))];
  if (!pending) return el('div', { class: 'item-new' },
    el('dl', { class: 'diff' }, ...Object.entries(p.editedValues || p.values || {}).flatMap(([k, v]) => [el('dt', {}, k), el('dd', { class: 'ins' }, show(v))])));
  const st = itemState(p);
  const mode = el('select', { 'aria-label': t('item.where'), onchange: () => {
    const [op, ...rest] = mode.value.split(':'); const key = rest.join(':');
    Object.assign(st, op === 'replace' ? { op, key } : { op: 'add', key: null, position: key }); schedulePreview(); } },
    el('option', { value: 'add:start', selected: st.op === 'add' && st.position === 'start' }, t('item.mode.start')),
    el('option', { value: 'add:end', selected: st.op === 'add' && st.position !== 'start' }, t('item.mode.end')),
    ...(coll?.canReplace ? coll.items.map(i => el('option', { value: 'replace:' + i.key, selected: st.op === 'replace' && st.key === i.key }, t('item.mode.replace', { title: String(i.title).slice(0, 48) }))) : []));
  const rows = Object.entries(st.values).filter(([k]) => !(coll?.kind === 'html' && coll.fields.some(f => f.name === k && f.type === 'image'))).flatMap(([k, v]) => {
    const box = el('textarea', { class: 'edit-box', rows: String(Math.min(5, Math.max(1, Math.ceil(show(v).length / 44)))), 'aria-label': k });
    box.value = show(v);
    box.addEventListener('focus', () => { if (selectedId !== p.id) selectCard(p.id, { keepCards: true }); });
    box.addEventListener('input', () => { st.values[k] = box.value; schedulePreview(); });
    box.addEventListener('blur', () => { if (cardsStale) { cardsStale = false; setTimeout(() => { if (!document.activeElement?.classList.contains('edit-box')) renderCards(); }, 0); } });
    return [el('dt', {}, coll?.fields.find(f => f.name === k)?.label || k), el('dd', {}, box)];
  });
  // pictures of a hand-written HTML list: the copied block keeps its picture until one is chosen here
  const pics = (coll?.kind === 'html' ? coll.fields.filter(f => f.type === 'image') : []).flatMap(f => {
    const cur = st.values[f.name];
    const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/avif', hidden: '', onchange: () => act(async () => {
      const file = input.files?.[0]; if (!file) return;
      const res = await fetch('/api/item-image', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Sitetend-Token': TOKEN, 'X-File-Name': encodeURIComponent(file.name), 'X-Collection': encodeURIComponent(p.collection), 'X-Field': encodeURIComponent(f.name) }, body: await file.arrayBuffer() });
      const j = await res.json().catch(() => null); if (!res.ok || !j?.ok) throw Object.assign(Error(j?.error?.message || res.statusText), { code: j?.error?.code });
      st.values[f.name] = j.data.src; schedulePreview(); renderCards();
    }) });
    return [el('dt', {}, f.label || f.name), el('dd', {}, el('span', { class: 'muted' }, cur ? baseName(cur) : t('item.picKept')), ' ', input,
      el('button', { class: 'small-btn', onclick: e => { e.stopPropagation(); input.click(); } }, t('item.picChoose')))];
  });
  return el('div', { class: 'item-new' },
    el('label', { class: 'mat-kind' }, t('item.where') + ' ', mode),
    el('dl', { class: 'diff' }, ...rows, ...pics),
    ...notes.map(n => el('div', { class: 'note' }, '⚠ ' + n)));
}

const sameText = (a, b) => String(a).replace(/["“”'\s]/g, '') === String(b).replace(/["“”'\s]/g, '');

/** A code change written by the model: what it does, the code itself on request, and a reminder to look first. */
function codeBlock(p) {
  const cut = (v, n = 1600) => { const x = String(v); return x.length > n ? x.slice(0, n) + '\n…' : x; };
  return el('div', { class: 'code-change' },
    el('div', {}, p.summary || ''),
    el('div', { class: 'note' }, '⚠ ' + t('code.check')),
    el('details', { onclick: e => e.stopPropagation() }, el('summary', {}, t('code.show', { n: (p.edits || []).length })),
      ...(p.edits || []).flatMap((e, i) => [el('div', { class: 'meta' }, t('code.edit', { n: i + 1 })),
        el('pre', { class: 'code del' }, cut(e.find)), el('pre', { class: 'code ins' }, cut(e.replace))])));
}
function assetBlock(p) {
  const target = p.targetPath || p.field.slice(6);
  return el('div', { class: 'asset' },
    el('div', {}, el('strong', {}, t('asset.replace')), ` · ${baseName(target)}`),
    el('div', { class: 'meta' }, `${kb(p.oldSize)} → ${kb(p.newSize)}`),
    el('div', { class: 'links' },
      el('a', { href: fileUrl(p.sourcePath), target: '_blank', rel: 'noopener' }, t('asset.open')),
      p.before ? el('a', { href: fileUrl(target), target: '_blank', rel: 'noopener' }, t('asset.openCurrent')) : null));
}

function cardButtons(p) {
  const btn = (label, fn, primary) => el('button', { class: primary ? 'primary' : '', onclick: () => act(fn) }, label);
  if (p.status === 'PENDING') return el('div', { class: 'btns' },
    btn(t('accept'), async () => {
      startWorking([p]);
      try { await acceptOne(p); } catch (e) { stopWorking([p.id]); throw e; }
    }, true),
    btn(t('reject'), async () => {
      await api('POST', '/api/proposals/reject', { id: p.id }); edits.delete(p.id); itemEdits.delete(p.id); say(t('msg.rejected'));
      // Optional and unobtrusive: the question leaves by itself after a while.
      clearTimeout(whyTimer); const mine = askWhy = { id: p.id, label: p.kind === 'item' ? (p.title || '') : fieldLabel(p.field), value: p.kind === 'item' ? (p.title || '') : show(p.value) }; renderCards();
      whyTimer = setTimeout(() => { if (askWhy === mine && !document.querySelector('.card.ask:hover, .card.ask:focus-within')) { askWhy = null; renderCards(); } }, 20000);
    }));
  return cardButtonsRest(p, btn);
}
async function acceptOne(p) {
  {
      if (p.kind === 'item') { await api('POST', '/api/proposals/accept', { ids: [p.id], edits: { [p.id]: itemSpec(p) } }); itemEdits.delete(p.id); return; }
      const changed = p.kind !== 'asset' && edits.has(p.id) && edits.get(p.id) !== show(p.value);
      if (changed) await api('POST', '/api/proposals/accept-edited', { id: p.id, value: edits.get(p.id) });
      else await api('POST', '/api/proposals/accept', { ids: [p.id] });
      edits.delete(p.id);
  }
}
function cardButtonsRest(p, btn) {
  const resolve = (action, msg) => async () => { await api('POST', '/api/proposals/resolve', { id: p.id, action }); say(t(msg)); };
  if (p.status === 'CONFLICT') return el('div', { class: 'btns' },
    p.kind === 'asset' || p.kind === 'code' || p.kind === 'item' ? null : btn(t('card.useSuggestion'), resolve('overwrite', 'msg.overwritten'), true),
    btn(t('card.keep'), resolve('dismiss', 'msg.dismissed')));
  if (p.status === 'STALE') return el('div', { class: 'btns' },
    btn(t('card.retry'), resolve('retry', 'msg.retrying'), true),
    btn(t('card.dismiss'), resolve('dismiss', 'msg.dismissed')));
  return null;
}

async function acceptAll(open) {
  startWorking(open);
  await act(async () => {
    const changed = Object.fromEntries([...open.filter(p => p.kind !== 'item' && edits.has(p.id) && edits.get(p.id) !== show(p.value)).map(p => [p.id, edits.get(p.id)]),
      ...open.filter(p => p.kind === 'item').map(p => [p.id, itemSpec(p)])]);
    let r; try { r = await api('POST', '/api/proposals/accept', { ids: open.map(p => p.id), edits: changed }); } catch (e) { stopWorking(open.map(p => p.id)); throw e; }
    open.forEach(p => { edits.delete(p.id); itemEdits.delete(p.id); });
    say(r.failures?.length ? t('msg.acceptedSome', { n: r.accepted, failed: r.failures.length }) : t('msg.acceptedN', { n: r.accepted }), Boolean(r.failures?.length));
  });
}

let previewTimer = null;
function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 250); }
function editor(p) {
  const original = show(p.value);
  const box = el('textarea', { class: 'edit-box', 'aria-label': t('after'), rows: String(Math.min(8, Math.max(1, Math.ceil(original.length / 44)))) });
  box.value = edits.has(p.id) ? edits.get(p.id) : original;
  const revert = el('button', { class: 'link small', hidden: box.value === original, onclick: () => { edits.delete(p.id); box.value = original; revert.hidden = true; schedulePreview(); } }, t('revert'));
  box.addEventListener('focus', () => { if (selectedId !== p.id) selectCard(p.id, { keepCards: true }); });
  box.addEventListener('input', () => { edits.set(p.id, box.value); revert.hidden = box.value === original; schedulePreview(); });
  box.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); box.closest('.card').querySelector('.btns .primary').click(); }
    if (e.key === 'Escape') { revert.click(); box.blur(); }
  });
  box.addEventListener('blur', () => { if (cardsStale) { cardsStale = false; setTimeout(() => { if (!document.activeElement?.classList.contains('edit-box')) renderCards(); }, 0); } });
  return el('div', { class: 'edit-wrap' }, box, el('div', { class: 'tip' }, t('editTip'), ' ', revert));
}

function selectCard(id, { keepCards = false } = {}) {
  selectedId = id; editMode = false;
  if (id && view === 'b') view = 'a';
  if (keepCards) { document.querySelectorAll('.card.selected').forEach(c => c.classList.remove('selected')); document.activeElement?.closest('.card')?.classList.add('selected'); }
  else renderCards();
  renderPreview();
}

// ---- history (readable)
const REVERTIBLE = new Set(['EXTERNAL_CHANGE', 'APPLY_DRAFT', 'RESTORE_VERSION', 'REVERT_EXTERNAL', 'REVERT_ENTRY']);
function historyTitle(h) {
  if (h.action === 'UNDO') return t('h.undo');
  if (h.action === 'REDO') return t('h.redo');
  if (h.action === 'PUBLISH') return t('h.publish');
  if (h.action === 'ADOPT_DISK') return t('h.adopt');
  if (h.action === 'RESTORE_VERSION') return t('h.restore');
  if (h.action === 'EXTERNAL_CHANGE') return t('h.external');
  if (h.action === 'REVERT_EXTERNAL') return t('h.revertExternal');
  if (h.action === 'REVERT_ENTRY') return t('h.revertEntry');
  const ch = h.changes || [];
  if (/^Overwrite with suggestion/.test(h.note || '')) return t('h.overwrite');
  if (ch.length && ch.every(c => ['model', 'rule', 'agent', 'chat'].includes(c.origin))) return ch.some(c => c.edited) ? t('h.acceptedEdited') : t('h.accepted');
  if (ch.length && ch.every(c => c.origin === 'manual')) return t('h.edited');
  return t('h.changed');
}
function renderHistory() {
  // Two tabs share the panel: Suggestions (materials, bulk actions, cards) and History.
  $('history').hidden = !historyOpen;
  for (const id of ['materials', 'bulk', 'cards']) $(id).hidden = historyOpen;
  $('tab-sugg').setAttribute('aria-pressed', String(!historyOpen)); $('tab-history').setAttribute('aria-pressed', String(historyOpen));
  const n = S.proposals.filter(p => p.status === 'PENDING').length;
  $('tab-count').textContent = n ? String(n) : '';
  if (!historyOpen) return;
  if (!activityItems) { loadActivities(); activityItems = []; }
  const acts = activityItems.slice().reverse().slice(0, 30);
  const items = S.history;
  // Keyed: an entry that has not changed keeps its node (so it does not flash, and an opened entry stays open);
  // only a new entry is built, and it slides in while the ones below glide down.
  const keep = (key, sig, make) => { const c = histNodes.get(key); if (c && c.sig === sig) return c.node; const node = make(); histNodes.set(key, { sig, node }); return node; };
  const head = (key, text) => keep(key, text + lang, () => el('h4', { class: 'h-sec' }, text));
  slideList($('history'), [...(acts.length ? [head('h:acts', t('act.history')), ...acts.map(m => keep('a:' + m.id, m.status + m.steps.length + lang, () => activityEntry(m))), head('h:changes', t('act.changes'))] : []),
    ...(items.length ? items.map(h => keep('h:' + h.logId, h.action + (h.changes || []).length + lang, () => {
    const ch = h.changes || [];
    const who = ch.find(c => c.origin)?.origin;
    return el('details', { class: 'hitem' },
      el('summary', {},
        el('div', {}, el('span', { class: 'title' }, historyTitle(h)), ch.length ? ' · ' + [...new Set(ch.map(c => c.item ? itemLabel(c.item) : fieldLabel(c.path)))].join(', ') : ''),
        el('div', { class: 'muted' }, new Date(h.timestamp).toLocaleString(lang),
          who && ['model', 'rule', 'manual', 'external', 'agent', 'chat'].includes(who) && !['UNDO', 'REDO'].includes(h.action) ? ` · ${t('h.by.' + who, { client: ch.find(c => c.client)?.client || '' })}` : '')),
      ...ch.map(c => el('div', { class: 'chg' },
        el('div', { class: 'lbl' }, c.item ? itemLabel(c.item) : fieldLabel(c.path), c.sourcePath ? el('span', { class: 'muted' }, ' · ' + t('h.source', { file: c.sourcePath })) : null),
        /^(asset|items|file):/.test(c.path) ? null : el('dl', { class: 'diff' }, el('dt', {}, t('before')), el('dd', { class: 'del' }, show(c.before)), el('dt', {}, t('after')), el('dd', { class: 'ins' }, show(c.after))))),
      // Any one change can be taken back on its own (as a new step, which itself can be undone). Replaced files cannot.
      REVERTIBLE.has(h.action) && ch.some(c => !String(c.path).startsWith('asset:'))
        ? el('div', { class: 'h-actions' }, el('button', { class: 'small-btn', onclick: () => act(async () => { await api('POST', '/api/history/revert', { id: h.logId }); say(t('h.reverted')); }) }, t('h.revertBtn')),
          ch.some(c => String(c.path).startsWith('asset:')) ? el('span', { class: 'muted' }, t('h.revertNoFiles')) : null)
        : null);
  })) : [keep('h:empty', lang, () => el('div', { class: 'muted' }, t('h.empty')))])]);
}
const histNodes = new Map();
// Put a list's children in a new order without rebuilding them. New children fade in from above; children that
// moved glide to their new place (measure, move, then play the difference back: FLIP).
function slideList(box, nodes) {
  const before = new Map([...box.children].map(n => [n, n.getBoundingClientRect().top]));
  const first = !box.children.length;
  box.replaceChildren(...nodes);
  if (first || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const n of nodes) {
    const was = before.get(n);
    if (was == null) { n.animate([{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' }); continue; }
    const dy = was - n.getBoundingClientRect().top;
    if (Math.abs(dy) > 1) n.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
}

// ---- preview: what is compared with what
/** Where a proposal shows up on the page, in priority order (first visible one is highlighted). */
function focusPaths(p) {
  if (p.field.startsWith('asset:')) return ['resume.downloadPath', 'resume.headline'];
  if (p.kind === 'code') return [p.file + '::code'];
  if (p.kind === 'item') { const r = site.buildItem?.(S.content, p.collection, itemSpec(p)); const c = site.listCollections?.(S.content).find(x => x.id === p.collection);
    return r?.ok && c?.kind === 'json' ? [`${p.collection}.${r.data.key}.${c.titleField}`] : []; }
  const parts = p.field.split('.');
  return parts[0] === 'projects' ? [p.field, `projects.${parts[1]}.summary`, `projects.${parts[1]}.title`] : [p.field];
}
function withProposal(p) {
  if (p.kind === 'asset') return S.content;
  if (p.kind === 'item') { const r = site.buildItem?.(S.content, p.collection, itemSpec(p)); return r?.ok ? r.data.content : S.content; }
  if (p.kind === 'code') { try { const f = S.content.files[p.file]; return { ...S.content, files: { ...S.content.files, [p.file]: applyEdits(f, p.edits) } }; } catch { return S.content; } }
  const r = site.setFieldValue(S.content, p.field, edits.has(p.id) ? edits.get(p.id) : p.value);
  return r.ok ? r.data.content : S.content;
}
// The same words elsewhere on the site (a phone version, a summary): accepting changes them too (see syncCopies).
let copiesFor = null, copiesIdx = null;
function copiesLine(p) {
  if (p.kind === 'item' || p.kind === 'asset' || typeof p.before !== 'string' || p.before.trim().length < 12) return [];
  if (copiesFor !== S.content) { copiesFor = S.content; copiesIdx = new Map(); for (const [path, f] of Object.entries(editableMap())) { if (f.type === 'url' || f.locked || typeof f.value !== 'string') continue; const k = f.value.trim(); if (!copiesIdx.has(k)) copiesIdx.set(k, []); copiesIdx.get(k).push(path); } }
  const home = String(p.field).split('::')[0];
  const files = [...new Set((copiesIdx.get(p.before.trim()) || []).map(x => x.split('::')[0]).filter(f => f !== home))];
  return files.length ? [el('div', { class: 'meta' }, t('card.copies', { files: files.join(', ') }))] : [];
}
function editableMap() {
  const out = {};
  for (const f of S.editableFields) {
    if (!['text', 'textarea', 'email', 'url', 'tags'].includes(f.type)) continue;
    const r = site.getFieldValue(S.content, f.path);
    out[f.path] = { value: r.ok ? r.data.value : '', type: f.type, label: fieldLabel(f.path), locked: S.lockedFields.includes(f.path) };
  }
  return out;
}
/**
 * With a suggestion selected: A = with this change, B = current website.
 * Without:                    A = current website,  B = published version (or the version when Sitetend opened).
 */
function comparison() {
  const p = S.proposals.find(x => x.id === selectedId);
  if (p) return { p, a: withProposal(p), b: S.content, labelA: t('view.proposed'), labelB: t('view.original'), capA: t('view.capProposed'), capB: t('view.capOriginal') };
  const base = S.compareBase?.content || S.content;
  const n = site.diffContent(base, S.content).data?.changeCount || 0;
  const published = S.compareBase?.kind === 'published';
  return { p: null, a: S.content, b: base, labelA: t('view.current'), labelB: published ? t('view.published') : t('view.opened'),
    capA: t('view.capCurrent'), capB: (published ? t('view.capPublished') : t('view.capOpened')) + ' · ' + (n ? t('view.capDiff', { n }) : t('view.capSame')) };
}
async function renderPreview() {
  // Build step: the preview shows the generated page itself (the first generated HTML file).
  const gen = S?.build?.generated || [];
  const main = gen.find(f => /\.html?$/i.test(f)) || (gen.find(f => f.endsWith('/')) ? gen.find(f => f.endsWith('/')) + 'index.html' : null);
  bridge.build = bridgeB.build = main ? { main } : null;
  // the text-list preview, in the interface language
  bridge.contentViewTitle = bridgeB.contentViewTitle = mode => t(mode === 'app' ? 'preview.list.app' : mode === 'hugo' ? 'preview.list.hugo' : 'preview.list.jekyll');
  bridge.contentViewNote = bridgeB.contentViewNote = () => t(S?.buildSuggestion && !S?.build ? 'preview.list.notePrepare' : 'preview.list.note');
  bridge.live = bridgeB.live = S?.content || null;
  if (!S) return;
  const c = comparison();
  if (editMode && view === 'b') view = 'a';
  $('v-proposed').textContent = c.labelA; $('v-original').textContent = c.labelB; $('v-split').textContent = t('view.split');
  for (const [id, v] of [['v-proposed', 'a'], ['v-original', 'b'], ['v-split', 'split']]) $(id).setAttribute('aria-pressed', String(view === v));
  $('edit-toggle').setAttribute('aria-pressed', String(editMode));
  $('compare').hidden = false;              // comparison is always available
  const split = view === 'split';
  $('pane-b').hidden = !split;
  $('cap-a').textContent = split ? c.capA : view === 'b' ? c.capB : c.capA;
  $('cap-b').textContent = split ? c.capB : '';
  pageCaption();
  layoutFrames();
  if (!loadedA) { await bridge.load(fileClient); loadedA = true; }
  bridge.focus(c.p ? focusPaths(c.p) : null);   // first: a suggestion on another page brings that page up
  // Editing, or the editable preview chosen, on a page drawn by its scripts: it shows no words here, so edit its parts instead.
  editPart = null;
  const bestPart = S.siteMode === 'html' && !S.build && livePages.has(pageOf()) && (editMode || staticPages.has(pageOf())) ? bestPartOf(pageOf()) : null;
  if (bestPart) {
    const host = pageOf(), part = bestPart;
    { for (const b of [bridge, bridgeB]) { b.page = part; b.lastDoc = null; } if (!editMode) staticPages.add(part); editPart = { part, host }; pagePicker(); }
  } else if (S.siteMode === 'html' && hostPageOf(pageOf()) && (editMode || staticPages.has(pageOf()) || staticPages.has(hostPageOf(pageOf())))) editPart = { part: pageOf(), host: hostPageOf(pageOf()) };   // the editable preview chosen on its page: its other parts too
  // A part of another page (see hostPageOf) is shown inside that page, live, when that page is drawn by its scripts.
  const part = S.siteMode === 'html' && !S.build ? pageOf() : null, host = part && hostPageOf(part);
  if (host && livePages.has(host) && !staticPages.has(host) && !staticPages.has(part) && !editMode) {
    for (const b of [bridge, bridgeB]) { b.page = host; b.lastDoc = null; }
    shownPart = part; pagePicker();
  } else if (shownPart && hostPageOf(shownPart) !== pageOf()) shownPart = null;
  if (wantsLive()) {
    const note = $('script-note'), pg = pageOf();
    note.hidden = false;
    const stem = shownPart ? shownPart.split('/').pop().replace(/\.html?$/i, '') : '';
    note.replaceChildren(el('span', {}, shownPart ? t(c.p && view !== 'b' && (c.p.kind === 'code' ? c.p.file : String(c.p.field || '').split('::')[0]) === shownPart ? 'preview.partChange' : c.p && view !== 'b' ? 'preview.liveOnChange' : 'preview.part', { part: shownPart, host: pg, name: stem }) : t(c.p && view !== 'b' ? 'preview.liveOnChange' : 'preview.liveOn')),
      el('button', { class: 'small-btn', title: t('preview.reloadTip'), onclick: () => { reloadLive(bridge); reloadLive(bridgeB); } }, t('preview.reload')),
      el('button', { class: 'small-btn', onclick: () => { if (shownPart) { staticPages.add(shownPart); for (const b of [bridge, bridgeB]) { b.page = shownPart; b.lastDoc = null; } shownPart = null; } else staticPages.add(pg); renderPreview(); } }, t('preview.useStatic')));
    const label = c.p ? t('preview.liveBanner', { label: c.p.kind === 'item' ? c.p.title || '' : fieldLabel(c.p.field) }) : '';
    try {
      setLive(bridge, await liveUrl(view === 'b' ? c.b : c.a, view === 'b' ? [] : marksOf(c.p), view === 'b' ? '' : label));
      if (split) { if (!loadedB) { await bridgeB.load(fileClient); loadedB = true; } setLive(bridgeB, await liveUrl(c.b, [], '')); }
    } catch (e) { say(errorText(e), true); }
    return;
  }
  leaveLive(bridge); leaveLive(bridgeB);
  const note = $('script-note');
  if (editPart) {
    note.hidden = false;
    note.replaceChildren(el('span', {}, t('preview.editPart', { part: editPart.part, host: editPart.host })),
      ...editMode ? [] : [el('button', { class: 'small-btn', onclick: () => { staticPages.delete(editPart.part); staticPages.delete(editPart.host); for (const b of [bridge, bridgeB]) { b.page = editPart.host; b.lastDoc = null; } renderPreview(); } }, t('preview.useLive'))]);
  } else { note.hidden = true; note.replaceChildren(); }   // the page reports what it shows once it is drawn (onShown)
  await bridge.render(view === 'b' ? c.b : c.a, 'live', null);
  // In-place editing only on the current website (not on a suggestion or an old version).
  const canEdit = editMode && !c.p && view !== 'b';
  bridge.setEditMode(canEdit, canEdit ? editableMap() : {});
  if (split) {
    if (!loadedB) { await bridgeB.load(fileClient); loadedB = true; }
    bridgeB.focus(c.p ? focusPaths(c.p) : null);
    await bridgeB.render(c.b, 'live', null);
  }
}

// ---------------------------------------------------------------- chat
let chatMessages = [], chatLoaded = false, chatThinking = false;
// The "→ N suggestions added" line follows the language the owner wrote in (the model's reply does too), not the UI language.
const otherDicts = {};
async function msgLang(text) {
  const l = /[\u3400-\u9fff]/.test(text) ? (lang.startsWith('zh') ? lang : 'zh-Hans') : lang.startsWith('zh') ? 'en' : lang;
  if (l !== lang && !otherDicts[l]) { try { otherDicts[l] = l === 'en' ? fallback : await (await fetch(`/ui/locales/${l}.json`)).json(); } catch { return lang; } }
  return l;
}
function addedLine(m) {
  const d = m.lang && m.lang !== lang ? otherDicts[m.lang] : null;
  return d?.['chat.suggested'] ? d['chat.suggested'].replace('{n}', m.proposed) : t('chat.suggested', { n: m.proposed });
}
async function loadChat() { chatLoaded = true; try { chatMessages = (await api('GET', '/api/chat')).messages; } catch { chatMessages = []; } renderChat(); }
/** Tiny Markdown for chat replies: paragraphs, bullet/numbered lists, **bold**, `code`. Builds DOM nodes, never HTML strings. */
function md(text) {
  const inline = line => line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map(part =>
    /^\*\*.+\*\*$/.test(part) ? el('strong', {}, part.slice(2, -2)) : /^`.+`$/.test(part) ? el('code', {}, part.slice(1, -1)) : part);
  const out = []; let list = null;
  for (const raw of String(text || '').split(/\n/)) {
    const line = raw.trimEnd(); const item = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (item) { if (!list) { list = el(/^\s*\d/.test(line) ? 'ol' : 'ul', {}); out.push(list); } list.append(el('li', {}, ...inline(item[1]))); continue; }
    list = null;
    if (!line.trim()) continue;
    const h = line.match(/^#{1,4}\s+(.*)$/);
    out.push(h ? el('p', {}, el('strong', {}, h[1])) : el('p', {}, ...inline(line)));
  }
  return el('div', { class: 'md' }, ...out);
}
// ---- step logs ("activities"): what Sitetend did after an accept or during a check, like a command you can open
const openActs = new Set();
function stepText(x) {
  const list = a => (a || []).slice(0, 6).join(', ') + ((a || []).length > 6 ? ' …' : '');
  switch (x.code) {
    case 'apply.accepted': return t('act.accepted', { list: list(x.items) });
    case 'apply.draft': return t('act.draft');
    case 'apply.written': return t('act.written', { files: list(x.files) });
    case 'verify.files': return x.missing?.length ? t('act.verifyFiles.bad', { list: list(x.missing) }) : t('act.verifyFiles.ok', { n: x.n });
    case 'verify.page.same': return t('act.verifyPage.same');
    case 'verify.page.skip': return t('act.verifyPage.skip');
    case 'verify.page': return x.missing?.length ? t('act.verifyPage.bad', { list: list(x.missing.map(w => '"' + w + '"')) }) : t('act.verifyPage.ok');
    case 'build.running': return t('act.build.running');
    case 'build.done': return t('act.build.done', { s: Math.max(1, Math.round((x.ms || 0) / 1000)) });
    case 'build.failed': return t('act.build.failed');
    case 'check.update': return t('act.check.update', { path: x.path, n: x.n, list: list(x.fields) });
    case 'check.none': return t('act.check.none', { path: x.path });
    case 'check.clarify': return t(x.deleted ? 'act.check.deleted' : 'act.check.clarify', { path: x.path });
    case 'check.error': return t('act.check.error', { path: x.path }) + (x.reason && (dict[`err.${x.reason}`] ?? fallback[`err.${x.reason}`]) ? ' · ' + t(`err.${x.reason}`) : '');
    case 'check.private': return t('act.check.private', { path: x.path });
    case 'check.dropped': return t('act.check.dropped', { n: x.n });
    case 'check.locked': return t('act.check.locked', { n: x.n });
    case 'check.reviewer': return t('act.check.reviewer', { why: String(x.why || '').replace(/^[^:]*:\s*reviewer rejected - /, '') });
    default: return x.message || t('err.generic');
  }
}
function actTitle(m) {
  const done = m.status !== 'running';
  if (m.kind === 'apply') return t(done ? `act.apply.${m.status}` : 'act.apply.running', { n: m.params?.n || 1 });
  return t(done ? `act.check.${m.status}` : 'act.check.running');
}
function actMark(status, size = 13) {
  return status === 'running' ? el('span', { class: 'act-spin' }) : el('span', { class: 'act-mark ' + status, html: icon(status === 'ok' ? 'check' : 'alert', size) });
}
const stepItem = (x, fresh) => el('li', { class: 'act-step ' + (x.status || 'ok') + (fresh ? ' fresh' : '') },
  x.status === 'running' ? el('span', { class: 'act-spin small' }) : el('span', { class: 'act-dot' }),
  el('span', {}, stepText(x), x.summary && /^check\./.test(x.code) && x.lang === lang ? el('span', { class: 'act-sum' }, x.summary) : null));

// ---- a card at work: after Accept, the card stays where it is and shows what Sitetend is doing, one step at a time
const working = new Map();   // proposal id -> { p (the card as it was), rec (step log), shown, timer, closing }
let activityItems = null, lastOrder = [];
function startWorking(list) { for (const p of list) working.set(p.id, { p: structuredClone(p), rec: null, shown: 0, timer: null, closing: false, view: 'steps', touched: false }); renderCards(); }
function stopWorking(ids) { for (const id of ids) working.delete(id); renderCards(); }
function onActivity(rec) {
  if (activityItems) { const i = activityItems.findIndex(m => m.id === rec.id); if (i >= 0) activityItems[i] = rec; else if (rec.status !== 'running') activityItems.push(rec); }
  if (rec.kind === 'apply') for (const id of rec.params?.ids || []) { const w = working.get(id); if (w) { w.rec = rec; pumpCard(id); } }
  if (historyOpen && rec.status !== 'running') renderHistory();
}
function pumpCard(id) {
  const w = working.get(id); if (!w || w.timer || !w.rec) return;
  const steps = w.rec.steps, node = document.querySelector(`#cards .card[data-key="${CSS.escape(id)}"]`);
  // steps show one after another (about three a second) so the work can be followed; a step still running updates in place
  if (w.shown < steps.length) {
    w.shown++;
    if (node) { const ol = node.querySelector('.act-steps'); if (ol) { const atEnd = ol.scrollHeight - ol.scrollTop - ol.clientHeight < 8;
      ol.replaceChildren(...steps.slice(0, w.shown).map((x, i) => stepItem(x, i === w.shown - 1))); if (atEnd) ol.scrollTop = ol.scrollHeight; } }
    w.timer = setTimeout(() => { w.timer = null; pumpCard(id); }, 340);
    return;
  }
  if (node) node.querySelector('.act-steps')?.replaceChildren(...steps.map(x => stepItem(x, false)));
  w.shown = steps.length;
  if (w.rec.status === 'running') return;
  if (node) node.replaceWith(workCard(id, w));
  if (w.rec.status === 'ok') scheduleFold(id);
}
/** Done and checked: the card folds away after a moment, unless you have touched it (scrolled its steps, opened the suggestion again): then it waits for "Close". */
function scheduleFold(id) {
  const w = working.get(id); if (!w || w.closeTimer) return;
  w.closeTimer = setTimeout(() => {
    w.closeTimer = null;
    const n = document.querySelector(`#cards .card[data-key="${CSS.escape(id)}"]`);
    if (w.touched) return;
    w.closing = true; if (n) n.classList.add('closing');
    setTimeout(() => stopWorking([id]), 320);
  }, 2400);
}
function foldCard(id) { const w = working.get(id); if (!w) return; w.closing = true; document.querySelector(`#cards .card[data-key="${CSS.escape(id)}"]`)?.classList.add('closing'); setTimeout(() => stopWorking([id]), 320); }
/** What the card suggested, read-only (shown again with "Back to the suggestion"). */
function workSuggestion(p) {
  return p.kind === 'item' ? itemBlock({ ...p, status: 'APPLIED' })
    : p.kind === 'asset' ? assetBlock(p)
    : el('div', {}, el('dl', { class: 'diff' }, el('dt', {}, t('before')), el('dd', { class: 'del' }, show(p.before)), el('dt', {}, t('after')), el('dd', { class: 'ins' }, show(edits.get(p.id) ?? p.value))),
        p.quote ? el('blockquote', { title: t('card.evidence') }, quoteText(p)) : null,
        el('div', { class: 'meta' }, `${t('source')}: ${sourceLabel(p)}` + (reasonText(p) ? ` · ${t('why')}: ${reasonText(p)}` : '')));
}
function workCard(id, w) {
  // the result shows only once every step has been shown
  const status = w.rec && w.rec.status !== 'running' && w.shown >= w.rec.steps.length ? w.rec.status : 'running', p = w.p;
  const steps = w.rec ? w.rec.steps.slice(0, w.shown) : [];
  const toggle = el('button', { class: 'link small work-toggle', onclick: () => { w.touched = true; w.view = w.view === 'steps' ? 'suggestion' : 'steps'; renderCards(); } },
    w.view === 'steps' ? t('act.showSuggestion') : t('act.showSteps'));
  const list = el('ol', { class: 'act-steps', tabindex: '0', 'aria-label': t('act.steps'), onwheel: () => { w.touched = true; }, ontouchmove: () => { w.touched = true; } },
    ...(steps.length ? steps.map(x => stepItem(x, false)) : [el('li', { class: 'act-step running' }, el('span', { class: 'act-spin small' }), el('span', {}, t('act.start')))]));
  requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  return el('article', { class: `card working ${status}${w.closing ? ' closing' : ''}`, 'data-key': id, 'aria-live': 'polite',
    },
    el('div', { class: 'work-head' }, actMark(status, 13),
      el('div', { class: 'work-name' }, el('div', { class: 'work-title' }, t(`act.card.${status}`)),
        el('div', { class: 'meta' }, p.kind === 'item' ? t('item.head', { list: p.collectionLabel }) : fieldLabel(p.field))), toggle),
    w.view === 'steps' ? list : workSuggestion(p),
    status === 'running' ? null : el('div', { class: 'btns' }, el('button', { onclick: () => status === 'ok' ? foldCard(id) : stopWorking([id]) }, status === 'ok' ? t('act.fold') : t('act.dismiss'))));
}
async function loadActivities() { try { activityItems = (await api('GET', '/api/activity')).items; } catch { activityItems = []; } if (historyOpen) renderHistory(); }
function activityEntry(m) {
  return el('details', { class: 'hitem act-item ' + m.status, open: m.status === 'fail' || undefined },
    el('summary', {}, el('div', { class: 'act-sumline' }, actMark(m.status, 11), el('span', { class: 'title' }, actTitle(m))),
      el('div', { class: 'muted' }, new Date(m.at).toLocaleString(lang))),
    el('ol', { class: 'act-steps' }, ...m.steps.map(x => stepItem(x, false))));
}
function renderChat() {
  const items = chatMessages.filter(m => m.role !== 'activity').slice(-30).map(m => el('div', { class: `msg ${m.role}` }, m.role === 'assistant' ? md(m.content) : m.content,
    m.role === 'assistant' && m.proposed ? el('span', { class: 'added' }, addedLine(m)) : null,
    ...(m.role === 'assistant' ? (m.remembered || []).map(r => MEM.items.some(n => n.id === r.id)
      ? el('span', { class: 'added remembered' }, el('span', { class: 'h3-ico', html: icon('bookmark', 14) }), ' ', t('mem.chat.saved', { text: r.text }), ' ',
          el('button', { class: 'link-btn', onclick: () => act(async () => { await api('POST', '/api/memory/remove', { id: r.id }); say(t('mem.removed')); await loadMemory(); }) }, t('undo')))
      : el('span', { class: 'added remembered off' }, t('mem.chat.undone', { text: r.text }))) : [])));
  if (chatThinking) items.push(el('div', { class: 'msg assistant thinking' }, t('chat.thinking')));
  $('chat-log').replaceChildren(...items);
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
  $('chat-clear').hidden = !chatMessages.length;
  $('chat-send').disabled = chatThinking || !S;
  layoutFrames();   // the preview gives up/takes back the height the conversation uses
}
function renderChatUsage() {
  if (!S) return;
  $('chat-usage').textContent = S.usage.totalTokens ? t('chat.usage', { tokens: S.usage.totalTokens.toLocaleString() }) : '';
  $('chat-usage').title = t('chat.usageTitle', { calls: S.usage.calls, tokens: S.usage.totalTokens });
}
async function sendChat() {
  const text = $('chat-input').value.trim();
  if (!text || chatThinking) return;
  chatMessages.push({ role: 'user', content: text }); $('chat-input').value = ''; autoGrow();
  chatThinking = true; renderChat();
  try {
    const r = await api('POST', '/api/chat', { message: text });
    if (r.remembered?.length) await loadMemory();
    chatMessages.push({ role: 'assistant', content: r.reply, proposed: r.proposed, tokens: r.tokens, lang: await msgLang(text), ...(r.remembered?.length ? { remembered: r.remembered } : {}) });
  } catch (e) { chatMessages.push({ role: 'assistant', content: errorText(e) }); }
  finally { chatThinking = false; renderChat(); refresh().catch(() => {}); }
}
function autoGrow() { const x = $('chat-input'); x.style.height = 'auto'; x.style.height = Math.min(120, x.scrollHeight) + 'px'; x.style.overflowY = x.scrollHeight > 120 ? 'auto' : 'hidden'; layoutFrames(); }
$('chat-form').onsubmit = e => { e.preventDefault(); sendChat(); };
$('chat-input').addEventListener('input', autoGrow);
$('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); } });
$('chat-clear').onclick = () => act(async () => { await api('POST', '/api/chat/clear', {}); chatMessages = []; renderChat(); });

// ---------------------------------------------------------------- in-place editing
$('edit-toggle').onclick = () => {
  editMode = !editMode;
  if (editMode) { selectedId = null; renderCards(); say(t('editOn')); } else say('');
  renderPreview();
};
async function saveField(field, value) { await act(async () => { await api('POST', '/api/edit', { field, value }); say(t('saved')); }); }
function onPreviewEdit(m) {
  if (m.type === 'SITETEND_EDIT_COMMIT') return saveField(m.field, m.value);
  if (m.type === 'SITETEND_LOCK_TOGGLE') {
    const locked = !S.lockedFields.includes(m.field);
    return act(async () => { await api('POST', '/api/lock', { field: m.field, locked }); say(locked ? t('locked') : t('unlocked')); });
  }
  if (m.type === 'SITETEND_EDIT_REQUEST') {               // e.g. a link whose visible text is not the stored value
    const f = editableMap()[m.field]; if (!f || f.locked) return;
    $('edit-label').textContent = f.label;
    $('edit-input').value = Array.isArray(f.value) ? f.value.join(', ') : String(f.value ?? '');
    $('edit-dialog').returnValue = '';
    openDialog($('edit-dialog')); $('edit-input').focus(); $('edit-input').select();
    $('edit-dialog').onclose = () => { if ($('edit-dialog').returnValue === 'save') saveField(m.field, $('edit-input').value); };
  }
}
$('edit-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); closeDialog($('edit-dialog'), 'save'); } });
animateDialog($('edit-dialog'));

// ---------------------------------------------------------------- full-size rendering + zoom
const DEVICE = { desktop: 1440, phone: 390 };
let device = 'desktop', zoom = null;                  // zoom null = fit to window
const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5];
function fitScale() {
  const panes = [...document.querySelectorAll('.pane')].filter(p => !p.hidden);
  const w = Math.min(...panes.map(p => p.querySelector('.viewport').clientWidth)) - 2;
  return Math.min(1, Math.max(0.1, w / DEVICE[device]));
}
function layoutFrames() {
  if (!S) return;
  const fit = fitScale(), s = zoom ?? fit, W = DEVICE[device];
  for (const pane of document.querySelectorAll('.pane')) {
    if (pane.hidden) continue;
    const vp = pane.querySelector('.viewport'), stage = pane.querySelector('.stage');
    const H = Math.max(400, (vp.clientHeight - 2) / s);
    // CSS zoom (not transform): the browser scales hit-testing natively, so clicks inside the page land correctly.
    for (const f of pane.querySelectorAll('iframe')) { f.style.width = W + 'px'; f.style.height = H + 'px'; f.style.zoom = String(s); }
    stage.style.width = W * s + 'px'; stage.style.height = H * s + 'px';
  }
  $('zoom-fit').textContent = zoom == null ? t('zoom.fitLabel', { p: Math.round(fit * 100) }) : Math.round(s * 100) + '%';
}
function stepZoom(dir) {
  const cur = zoom ?? fitScale();
  const next = dir > 0 ? ZOOMS.find(z => z > cur + 0.001) : [...ZOOMS].reverse().find(z => z < cur - 0.001);
  if (next) { zoom = next; layoutFrames(); }
}
$('zoom-in').onclick = () => stepZoom(1);
$('zoom-out').onclick = () => stepZoom(-1);
$('zoom-fit').onclick = () => { zoom = null; layoutFrames(); };
addEventListener('resize', () => layoutFrames());
if (window.ResizeObserver) new ResizeObserver(() => layoutFrames()).observe($('frames'));
function setDevice(d) { device = d; $('w-desktop').setAttribute('aria-pressed', String(d === 'desktop')); $('w-phone').setAttribute('aria-pressed', String(d === 'phone')); layoutFrames(); }
$('w-desktop').onclick = () => setDevice('desktop');
$('w-phone').onclick = () => setDevice('phone');
for (const [id, v] of [['v-proposed', 'a'], ['v-original', 'b'], ['v-split', 'split']]) $(id).onclick = () => { view = v; if (v === 'b') editMode = false; renderPreview(); };

// ---------------------------------------------------------------- connection menu
// API-key boxes are password fields, so browsers (Edge, Chrome) fill in a saved website password unless told this is
// not a sign-in. "off" is ignored for passwords; "new-password" is respected, and password managers skip these too.
// Built-in models with words in their name (rule demo, Ollama) get the name in the interface language; brand names stay.
const modelName = p => !p.custom && (dict[`model.name.${p.id}`] ?? fallback[`model.name.${p.id}`]) ? t(`model.name.${p.id}`) : p.label;
const KEY_INPUT = { autocomplete: 'new-password', spellcheck: 'false', 'data-lpignore': 'true', 'data-1p-ignore': 'true', 'data-bwignore': 'true' };
function openConnMenu() {
  const m = $('conn-menu');
  const items = [el('h3', {}, t('menu.models'))];
  for (const p of models.profiles) {
    items.push(el('button', { class: 'mitem' + (p.id === models.active ? ' active' : ''), onclick: () => { if (p.id === models.active) return; (async () => { try { await api('POST', '/api/models/active', { id: p.id }); models = await api('GET', '/api/models'); await refresh(); } catch (e) { say(errorText(e), true); } if (!menuClosed('conn-menu')) openConnMenu(); })(); } },   // stays open: the tick moves; click outside to close
      el('span', { class: 'dot ' + (p.hasKey ? 'ok' : 'bad') }), el('span', { class: 'mlabel' }, modelName(p), p.cheap ? el('span', { class: 'mtag' }, t('model.cheap')) : null), p.id === models.active ? el('span', { class: 'check' }, '✓') : null, el('span', { class: 'sub' }, p.hasKey ? (p.local || p.type === 'rule' ? t('menu.local') : p.model || '') : t('menu.needsKey'))));
    if (p.custom) items.at(-1).append(el('span', { class: 'icon tiny mremove', role: 'button', tabindex: '0', title: t('model.remove'), 'aria-label': t('model.remove'), html: icon('x', 14),
      onclick: e => { e.stopPropagation(); act(async () => { await api('POST', '/api/models/remove', { id: p.id }); models = await api('GET', '/api/models'); say(t('model.removed', { name: p.label })); }).then(openConnMenu); } }));
    if (p.keyRef && p.id === models.active) {   // only the chosen model's key box, so the menu stays short
      const input = el('input', { type: 'password', placeholder: t('menu.setKey'), ...KEY_INPUT });
      items.push(el('form', { class: 'keyrow', onsubmit: e => { e.preventDefault(); act(async () => { await api('POST', '/api/models/key', { id: p.id, key: input.value }); input.value = ''; say(t('menu.keySaved')); }); } }, input, el('button', {}, '✓')));
      if (/^https:\/\//.test(p.keyUrl || '')) items.push(el('a', { class: 'mlink', href: p.keyUrl, target: '_blank', rel: 'noopener' }, t('menu.getKey')));
    }
  }
  items.push(...addModelForm());
  if (S) {
    // The button itself turns into the result: a cover slides over it ("Testing…"), turns green or red, then fades away.
    const cover = el('div', { class: 'mtest-cover', hidden: true });
    const testBtn = el('button', { class: 'mitem mtest', onclick: async () => {
      if (!cover.hidden) return;
      cover.className = 'mtest-cover'; cover.textContent = t('menu.testing'); cover.hidden = false;
      cover.animate([{ opacity: 0, transform: 'scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: 160, easing: 'cubic-bezier(.2,.9,.25,1)' });
      let ok = false, text;
      try { const r = await api('POST', '/api/models/test', {}); ok = r.ok; text = r.ok ? `✓ ${t('menu.testOk')} · ${r.latencyMs} ms` : t('err.PROVIDER_UNAVAILABLE'); }
      catch (e) { text = errorText(e); }
      cover.className = 'mtest-cover ' + (ok ? 'ok' : 'bad'); cover.textContent = text;
      cover.animate([{ transform: 'scale(.97)' }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2,.9,.25,1)' });
      setTimeout(() => cover.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: 'ease-in', fill: 'forwards' }).finished
        .then(() => { cover.hidden = true; cover.getAnimations().forEach(x => x.cancel()); }), ok ? 2500 : 5000);
    } }, t('menu.test'));
    items.push(el('div', { class: 'mtest-wrap' }, testBtn, cover));
    const usageNote = el('div', { class: 'mnote' }, t('menu.usage', { calls: S.usage.calls, tokens: S.usage.totalTokens }));
    api('GET', '/api/spending').then(st => { if (st.calls) usageNote.textContent += ' · ' + t('menu.month', { d: money(st.dollars) }); }).catch(() => {});
    items.push(usageNote);
  }
  items.push(el('div', { class: 'sep' }));
  items.push(...mcpMenu());
  items.push(el('div', { class: 'sep' }));
  items.push(el('h3', {}, t('menu.connect')),
    S ? el('button', { class: 'mitem', onclick: () => { closeConnMenu(); openSources(); } }, el('span', { class: 'check', html: icon('download-cloud', 14) }), el('span', {}, el('div', {}, t('menu.sources') + '…'),
      el('div', { class: 'sub2' }, S.sources?.length ? t('src.count', { n: S.sources.length }) : t('src.menuSub')))) : null,
    el('button', { class: 'mitem', onclick: () => { closeConnMenu(); openHooks(); } }, el('span', { class: 'check', html: icon('bell', 14) }), el('span', {}, el('div', {}, t('menu.webhooks') + '…'),
      el('div', { class: 'sub2' }, t('hook.menuSub')))));
  m.replaceChildren(...items.filter(Boolean)); popIn(m, $('conn')); $('conn').setAttribute('aria-expanded', 'true');
}
/** "+ Add a model…": any OpenAI-compatible endpoint (OpenRouter, DeepSeek, Azure, a company gateway, LM Studio…). */
let addModelOpen = false;
// Plus / minus in one drawing: the upright stroke turns down onto the level one (plus -> minus) and back.
const PLUS_MINUS = '<svg class="ico pm" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line class="pm-h" x1="5" y1="12" x2="19" y2="12"/><line class="pm-v" x1="12" y1="5" x2="12" y2="19"/></svg>';
function addModelForm() {
  const f = {
    label: el('input', { placeholder: t('model.namePh'), 'aria-label': t('model.name'), maxlength: '40' }),
    endpoint: el('input', { placeholder: 'https://api.example.com/v1', 'aria-label': t('model.endpoint'), spellcheck: 'false' }),
    model: el('input', { placeholder: t('model.modelPh'), 'aria-label': t('model.model'), spellcheck: 'false' }),
    key: el('input', { type: 'password', placeholder: t('model.keyPh'), 'aria-label': t('model.key'), ...KEY_INPUT }),
  };
  const row = (k, labelKey) => el('label', { class: 'mfield' }, el('span', {}, t(labelKey)), f[k]);
  const form = el('form', { class: 'madd', onsubmit: e => { e.preventDefault(); act(async () => {
    const r = await api('POST', '/api/models/add', { label: f.label.value, endpoint: f.endpoint.value, model: f.model.value, key: f.key.value });
    // Without its key an internet service cannot be used yet: add it, and ask for the key in its row.
    if (!r.needsKey) await api('POST', '/api/models/active', { id: r.id });
    models = await api('GET', '/api/models'); addModelOpen = false; say(t(r.needsKey ? 'model.addedNeedsKey' : 'model.added', { name: f.label.value.trim() }));
  }).then(openConnMenu); } },
    row('label', 'model.name'), row('endpoint', 'model.endpoint'), row('model', 'model.model'), row('key', 'model.key'),
    el('div', { class: 'mnote' }, t('model.note')),
    el('button', { class: 'primary' }, t('model.addBtn')));
  // Opening and closing toggle classes in place (no redraw), so the icon and the form can animate.
  const wrap = el('div', { class: 'madd-wrap' + (addModelOpen ? ' open' : ''), 'aria-hidden': String(!addModelOpen) }, el('div', {}, form));
  const toggle = el('button', { class: 'mitem maction madd-toggle' + (addModelOpen ? ' open' : ''), 'aria-expanded': String(addModelOpen), onclick: () => {
    addModelOpen = !addModelOpen;
    toggle.classList.toggle('open', addModelOpen); wrap.classList.toggle('open', addModelOpen);
    toggle.setAttribute('aria-expanded', String(addModelOpen)); wrap.setAttribute('aria-hidden', String(!addModelOpen));
    if (addModelOpen) setTimeout(() => f.label.focus({ preventScroll: true }), 120);
  } }, el('span', { class: 'check', html: PLUS_MINUS }), t('model.add'));
  for (const n of Object.values(f)) n.tabIndex = addModelOpen ? 0 : -1;
  toggle.addEventListener('click', () => { for (const n of [...Object.values(f), form.querySelector('.primary')]) n.tabIndex = addModelOpen ? 0 : -1; });
  return [toggle, wrap];
}
function mcpMenu() {
  const mcp = settings.mcp || { enabled: false, allowWrites: false };
  const set = next => act(() => api('POST', '/api/settings', { mcp: { ...mcp, ...next } })).then(openConnMenu);   // redraw after settings refresh
  const copy = (text, msg) => navigator.clipboard.writeText(text).then(() => say(t(msg))).catch(() => { prompt(t('mcp.copyManual'), text); });
  const q = s => /\s/.test(s) ? `"${s}"` : s;
  const claudeCmd = `claude mcp add sitetend -- ${q(hostInfo.node)} ${q(hostInfo.bin)} mcp`;
  const cursorJson = JSON.stringify({ mcpServers: { sitetend: { command: hostInfo.node, args: [hostInfo.bin, 'mcp'] } } }, null, 2);
  const out = [el('h3', {}, t('menu.mcp')),
    el('label', { class: 'mcheck' }, el('input', { type: 'checkbox', checked: mcp.enabled, onchange: e => set({ enabled: e.target.checked, allowWrites: e.target.checked && mcp.allowWrites }) }), t('mcp.enable')),
    el('label', { class: 'mcheck' + (mcp.enabled ? '' : ' off') }, el('input', { type: 'checkbox', checked: mcp.allowWrites, disabled: !mcp.enabled, onchange: e => set({ allowWrites: e.target.checked }) }), t('mcp.writes'))];
  out.push(el('div', { class: 'mnote' }, mcp.enabled ? (mcp.allowWrites ? t('mcp.noteWrites') : t('mcp.noteSuggest')) : t('mcp.noteOff')));
  if (mcp.enabled) out.push(
    el('button', { class: 'mitem', onclick: () => copy(claudeCmd, 'mcp.copied') }, t('mcp.copyClaude')),
    el('button', { class: 'mitem', onclick: () => copy(cursorJson, 'mcp.copied') }, t('mcp.copyCursor')),
    el('button', { class: 'mitem', onclick: () => copy(t('mcp.agentsMd'), 'mcp.copiedAgents') }, t('mcp.copyAgents')));
  return out;
}
function closeConnMenu() { popOut($('conn-menu')); $('conn').setAttribute('aria-expanded', 'false'); }
$('conn').onclick = e => { e.stopPropagation(); closeSiteMenu(); menuClosed('conn-menu') ? openConnMenu() : closeConnMenu(); };
$('conn-menu').onclick = e => e.stopPropagation();
document.addEventListener('click', closeConnMenu);
// A click in the website preview (an iframe) never reaches this document; the window loses focus instead.
// Treat that as a click outside, so every menu closes the same way.
addEventListener('blur', () => { closeConnMenu(); closeSiteMenu(); closePubMenu(); });

// ---------------------------------------------------------------- settings drawer
let advOpen = false;
function openDrawer() {
  const wasOpen = !$('drawer').hidden && $('drawer').getBoundingClientRect().width > 0;
  const body = [], adv = [];
  if (S) body.push(el('section', {}, secHead('folder', t('settings.workspace')), el('div', {}, $('site-label').textContent), el('div', { class: 'muted' }, S.workspace.root),
    el('div', { class: 'ws-btns' },
      el('button', { onclick: () => act(async () => { const r = await api('POST', '/api/workspace/reveal', { which: 'sources' }); say(t('settings.revealed', { path: r.path })); }) }, t('settings.revealSources')),
      el('button', { onclick: () => act(async () => { await api('POST', '/api/workspace/reveal', { which: 'website' }); }) }, t('settings.revealWebsite')),
    el('button', { class: 'wide', onclick: () => act(async () => { await api('POST', '/api/workspace/close', {}); closeDrawer(); }) }, t('settings.switch')))));
  const langSel = el('select', { onchange: () => act(async () => { await api('POST', '/api/settings', { language: langSel.value }); settings.language = langSel.value; await loadLang(langSel.value); openDrawer(); }) },
    ...LANGS.map(([v, n]) => el('option', { value: v, selected: settings.language === v }, n)));
  body.push(el('section', {}, secHead('globe', t('settings.language')), langSel));
  if (S) adv.unshift(buildSection());   // how the preview is generated: for developers, under Advanced
  if (S) adv.push(el('section', {}, secHead('help-circle', t('tour.settings')), el('button', { class: 'wide', onclick: () => { closeDrawer(); runTour(); } }, t('tour.replay'))));
  const themeSel = el('div', { class: 'seg seg-full', role: 'group' },
    ...['system', 'light', 'dark'].map(v => el('button', { 'aria-pressed': String(themeChoice() === v), onclick: e => { try { localStorage.setItem(THEME_KEY, v); } catch {} applyTheme(v); for (const b of e.currentTarget.parentNode.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); } }, t('settings.theme.' + v))));
  body.push(el('section', {}, secHead('sun', t('settings.theme')), themeSel));
  body.push(appSection());
  body.push(spendSection());
  body.push(updateSection());
  if (S) {
    const mode = el('select', { onchange: () => act(() => api('POST', '/api/settings', { autoAnalyze: mode.value })) },
      el('option', { value: 'auto', selected: S.autoAnalyze === 'auto' }, t('settings.analyze.auto')),
      el('option', { value: 'manual', selected: S.autoAnalyze === 'manual' }, t('settings.analyze.manual')));
    body.push(el('section', {}, secHead('zap', t('settings.analyze')), mode));
    const pub = el('select', { onchange: () => act(async () => { await api('POST', '/api/settings', { publishMode: pub.value }); openDrawer(); if (isHost(pub.value)) hostSetupIfNeeded(pub.value); }) },
      ...['git', 'cloudflare', 'netlify', 'manual'].map(k => el('option', { value: k, selected: (S.publishMode || 'manual') === k }, t('settings.publish.' + k))));
    const pubInfo = el('div', { class: 'muted pub-info' }, '…');
    api('GET', '/api/publish/status').then(st => { pubInfo.replaceChildren(...publishInfo(st, hostDialog)); }).catch(() => { pubInfo.textContent = ''; });
    adv.push(
      el('section', {}, secHead('upload-cloud', t('settings.publish')), pub, pubInfo, zipLink('zip-link'), el('div', { class: 'muted' }, t('settings.publish.alsoMenu'))),
      el('section', {}, secHead('lock', t('settings.locked')),
        el('div', { class: 'muted' }, t('settings.locked.what')),
        ...(S.lockedFields.length ? S.lockedFields.map(f => el('div', { class: 'lockrow' }, fieldLabel(f), el('button', { onclick: () => act(async () => { await api('POST', '/api/lock', { field: f, locked: false }); openDrawer(); }) }, t('unlock')))) : [el('div', { class: 'muted' }, t('settings.locked.none'))])),
      el('section', {}, secHead('shield', t('settings.reviewer')),
        el('label', { class: 'mcheck', style: 'padding-left:0' }, el('input', { type: 'checkbox', checked: settings.reviewer !== false, onchange: e => act(() => api('POST', '/api/settings', { reviewer: e.target.checked })) }), t('settings.reviewer.on')),
        el('div', { class: 'muted' }, t('settings.reviewer.note'))),
      el('section', {}, secHead('clock', t('settings.delay')),
        el('select', { onchange: e => act(() => api('POST', '/api/settings', { analyzeDelaySec: Number(e.target.value) })) },
          ...[5, 10, 15, 30, 60].map(n => el('option', { value: String(n), selected: (settings.analyzeDelaySec ?? 10) === n }, t('settings.delay.n', { n })))),
        el('div', { class: 'muted' }, t('settings.delay.note'))),
      privacySection(),
      memorySection(),
      backupSection(),
      el('section', {}, secHead('play', t('settings.demo')), el('div', { class: 'btn-grid' },
        ...(S.workspace.label === 'demo-workspace' ? [
        el('button', { onclick: () => act(() => api('POST', '/api/demo/change', { kind: 'email' })) }, t('demo.email')),
        el('button', { onclick: () => act(() => api('POST', '/api/demo/change', { kind: 'project' })) }, t('demo.project')),
        el('button', { onclick: () => act(() => api('POST', '/api/demo/change', { kind: 'space' })) }, t('demo.space'))] : []),
        el('button', { onclick: () => act(() => api('POST', '/api/check', { reanalyze: true })) }, t('settings.reanalyze')),
        el('button', { onclick: () => act(async () => { await api('POST', '/api/workspace/demo', { reset: true }); loadedA = loadedB = false; }) }, t('settings.resetDemo')))),
      el('section', {}, secHead('send', t('settings.sent')),
        ...(S.sentLog.length ? S.sentLog.slice(0, 8).map(x => el('div', { class: 'muted' }, `${new Date(x.at).toLocaleTimeString()} · ${x.model} · ${x.files.join(', ')}`)) : [el('div', { class: 'muted' }, t('settings.none'))])));
    body.push(el('button', { class: 'adv-toggle' + (advOpen ? ' on' : ''), 'aria-expanded': String(advOpen), onclick: () => { advOpen = !advOpen; openDrawer(); } },
      el('span', { class: 'chev', html: icon(advOpen ? 'chevron-right' : 'chevron-left', 16) }), el('span', { class: 'h3-ico', html: icon('sliders', 16) }), el('span', {}, t('settings.advanced'))));
  }
  $('drawer-body').replaceChildren(...body); growFrom($('drawer'), $('settings')); fadeShow($('scrim')); placeClose(); fadeShow($('close-drawer'));
  requestAnimationFrame(() => watchSegs($('drawer-body')));
  // Just opened: keyboard and screen reader users start inside the panel (closing it returns them to the gear button).
  if (!wasOpen) requestAnimationFrame(() => $('drawer-body').querySelector('button,select,input,textarea,a[href]')?.focus({ preventScroll: true }));
  // Advanced settings open as a second panel to the LEFT of the drawer, so nothing has to be scrolled to.
  // Grouped by what they are about, not by the browser's column filling:
  // left = how Sitetend works on the site; right = what leaves this computer (publishing, privacy, model calls), demo last.
  const ADV_COLS = [['terminal', 'shield', 'clock', 'lock', 'archive'], ['upload-cloud', 'eye-off', 'send', 'play', 'help-circle']];
  const secOf = n => n.querySelector('h3[data-sec]')?.dataset.sec;
  const cols = ADV_COLS.map(keys => keys.map(k => adv.find(n => secOf(n) === k)).filter(Boolean));
  const rest = adv.filter(n => !cols.flat().includes(n)); cols[1].push(...rest);
  $('drawer-adv-body').replaceChildren(...cols.map(c => el('div', { class: 'adv-col' }, ...c)));
  if (advOpen && adv.length) showPanel('drawer-adv', 'adv-collapse'); else leavePanel('drawer-adv', 'adv-collapse');
}
function closeDrawer() { advOpen = false; const back = $('drawer').contains(document.activeElement); shrinkTo($('drawer'), $('settings')); if (back) $('settings').focus({ preventScroll: true }); fadeHide($('scrim')); fadeHide($('close-drawer'), 150); leavePanel('drawer-adv', 'adv-collapse'); }
function placeClose() {
  const r = $('settings').getBoundingClientRect(); if (!r.width) return;
  Object.assign($('close-drawer').style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
}
addEventListener('resize', () => { if (!$('close-drawer').hidden) placeClose(); });
// Panels leave the way they came in (a short slide + fade) instead of vanishing; showing again cancels a pending exit.
const leaving = new Map();
function leavePanel(...ids) {
  for (const id of ids) {
    const n = $(id); if (n.hidden || leaving.has(id)) continue;
    n.classList.add('leaving');
    leaving.set(id, setTimeout(() => { n.hidden = true; n.classList.remove('leaving'); leaving.delete(id); }, 190));
  }
}
function showPanel(...ids) {
  for (const id of ids) { const n = $(id); clearTimeout(leaving.get(id)); leaving.delete(id); n.classList.remove('leaving'); n.hidden = false; }
}
$('adv-collapse').onclick = () => { advOpen = false; openDrawer(); };
$('scrim').onclick = () => { if (advOpen && !$('drawer-adv').hidden) { advOpen = false; openDrawer(); } else closeDrawer(); };
document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (!$('drawer').hidden) closeDrawer(); closeConnMenu(); closeSiteMenu(); closePubMenu(); } });
function privacySection() {
  const box = el('textarea', { rows: '3', placeholder: 'diary*\n*-private.md' }); box.value = (S.privacy?.extra || []).join('\n');
  return el('section', {}, secHead('eye-off', t('settings.privacy')),
    el('details', { class: 'inline' }, el('summary', { class: 'muted' }, t('settings.privacy.defaults') + ` (${(S.privacy?.defaults || []).length})`), el('div', { class: 'muted mono' }, (S.privacy?.defaults || []).join('  '))),
    el('label', { class: 'muted' }, t('settings.privacy.extra')), box,
    el('button', { onclick: () => act(async () => { await api('POST', '/api/settings', { privacyExclude: box.value.split(/\n/) }); say(t('settings.saved')); }) }, t('save')));
}
// ---------------------------------------------------------------- "What can Sitetend work with?" (formats, with examples)
const TREE = {
  html: 'my-site/\n  index.html\n  about.html\n  style.css',
  json: 'my-site/\n  website/\n    index.html\n    content.json ← text',
  ssg: 'my-blog/\n  _config.yml  (Jekyll)\n  hugo.toml    (Hugo)\n  _posts/  content/ …',
  build: 'my-site/\n  build.py ← makes index.html\n  pages/  data/ …',
  app: 'my-portfolio/\n  package.json\n  src/  (or app/)\n    components/  pages/\n    config.ts ← text',
};
const SAMPLE = {
  md: '# Orbit Dock\n\n- Summary: A workspace launcher\n- Version: 1.7\n- Link: github.com/you/orbit',
  json: '{\n  "name": "Alex Morgan",\n  "title": "Product Designer",\n  "email": "alex@example.com"\n}',
};
function openFormatHelp(first = 'site') {
  const d = sheetDialog(t('help.title'), null);
  const code = txt => el('pre', { class: 'help-code' }, txt);
  // Plain language first; the folder layouts are for people who want them (collapsed).
  const site = el('div', { class: 'help-sec' }, el('h4', {}, t('help.q1.title')),
    el('p', {}, t('help.q1.body')),
    el('ul', { class: 'help-list' }, el('li', {}, t('help.q1.check')), el('li', {}, t('help.q1.unsure'))),
    el('div', { class: 'help-warn', role: 'note' }, el('span', { class: 'help-warn-ico', html: icon('alert', 16) }), el('span', {}, t('help.q1.no'))),
    el('details', { class: 'help-dev' }, el('summary', {}, t('help.dev')),
      el('div', { class: 'help-grid' },
        el('div', {}, el('strong', {}, t('help.site.html')), code(TREE.html)),
        el('div', {}, el('strong', {}, t('help.site.json')), code(TREE.json)),
        el('div', {}, el('strong', {}, t('help.site.ssg')), code(TREE.ssg)),
        el('div', {}, el('strong', {}, t('help.site.build')), code(TREE.build)),
        el('div', {}, el('strong', {}, t('help.site.app')), code(TREE.app)))));
  const mats = el('div', { class: 'help-sec' }, el('h4', {}, t('help.q2.title')),
    el('p', {}, t('help.q2.body')),
    el('ul', { class: 'help-list' }, ...['i1', 'i2', 'i3', 'i4'].map(k => el('li', {}, t('help.q2.' + k)))),
    el('p', { class: 'muted small' }, t('help.q2.chat')),
    el('div', { class: 'help-note' }, el('div', { class: 'muted small' }, t('help.q2.exampleLabel')), el('div', { class: 'help-note-text' }, t('help.q2.example'))),
    el('p', { class: 'muted small' }, t('help.q2.safe')));
  d.body.replaceChildren(...(first === 'materials' ? [mats, site] : [site, mats]),
    S ? null : el('button', { class: 'link small', onclick: () => { closeDialog(d.d); act(() => api('POST', '/api/workspace/demo', {})); } }, t('help.demo')));
}
$('site-help').onclick = () => openFormatHelp('site');

// ---------------------------------------------------------------- open like an app (shortcut, sign-in, tray, quit)
let appInfo = null;
const platKey = () => appInfo?.platform === 'win32' ? 'win' : appInfo?.platform === 'darwin' ? 'mac' : 'linux';
function appSection() {
  const box = el('section', { class: 'app-sec' }, secHead('power', t('app.title')), el('div', { class: 'muted' }, '…'));
  const sw = (on, label, onchange, disabled = false) => el('label', { class: 'mcheck' + (disabled ? ' off' : ''), style: 'padding-left:0' }, el('input', { type: 'checkbox', checked: on, disabled, onchange }), label);
  const fill = () => {
    const a = appInfo; if (!a) return;
    const quit = a.canQuit ? el('button', { onclick: async () => {
        if (!(await confirmBox(t('app.quitConfirm'), { ok: t('app.quit'), cancel: t('cancel') }))) return;
        await api('POST', '/api/host/quit', {}).catch(() => {});
        liveEvents?.close(); closeDrawer();
        document.body.append(el('div', { class: 'quit-note' }, el('img', { src: '/ui/assets/sitetend-mark.svg', alt: '', width: '64', height: '64' }), el('strong', {}, t('app.quitDone')), el('div', { class: 'muted' }, t('app.quitDoneSub'))));
      } }, t('app.quit')) : null;
    box.replaceChildren(...[secHead('power', t('app.title')),
      el('div', { class: 'muted' }, a.shortcut ? t('app.shortcutDone.' + platKey()) : t('app.shortcutWhy')),
      el('div', { class: 'ws-btns' }, el('button', { onclick: () => act(async () => { appInfo = await api('POST', '/api/app/shortcut', {}); say(t('app.shortcutMade.' + platKey())); fill(); }) }, a.shortcut ? t('app.shortcutAgain') : t('app.shortcut')), quit),
      sw(a.login, t('app.login'), e => act(async () => { appInfo = await api('POST', '/api/app/login', { enabled: e.target.checked }); fill(); })),
      sw(a.tray && a.trayAvailable, t('app.tray'), e => act(async () => { appInfo = await api('POST', '/api/app/tray', { enabled: e.target.checked }); fill(); }), !a.trayAvailable),
      a.trayAvailable ? null : el('div', { class: 'muted' }, t('app.trayOnlyWin')),
      a.error ? el('div', { class: 'muted small' }, a.error) : null].filter(Boolean));
  };
  if (appInfo) fill(); else api('GET', '/api/app').then(a => { appInfo = a; fill(); }).catch(() => box.lastChild.remove());
  return box;
}

// ---------------------------------------------------------------- external sources (MCP) and webhooks
// Each opens as its own dialog (zooms in like the others). Messages show inside the dialog, since a modal dialog
// sits above the toast.
const when = iso => new Date(iso).toLocaleString(lang, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function sheetDialog(title, sub) {
  const d = el('dialog', { class: 'edit-dialog sheet-dialog' });
  const body = el('div', { class: 'sheet-body' });
  d.append(el('div', { class: 'sheet-head' }, el('div', {}, el('h2', {}, title), sub ? el('div', { class: 'muted small' }, sub) : null),
    el('button', { class: 'icon', type: 'button', 'aria-label': t('close'), title: t('close'), html: icon('x', 16), onclick: () => closeDialog(d) })), body);
  document.body.append(d); animateDialog(d);
  d.addEventListener('close', () => d.remove());
  d.addEventListener('mousedown', e => { if (e.target === d) closeDialog(d); });   // the backdrop
  openDialog(d);
  return { d, body };
}
/** Runs fn and shows its error (or nothing) in the dialog's own message line. */
async function inDialog(msg, fn, busyText = '') {
  msg.className = 'dlg-msg'; msg.textContent = busyText;
  try { await fn(); if (busyText) msg.textContent = ''; }
  catch (e) { msg.className = 'dlg-msg bad'; msg.textContent = errorText(e) + (/^MCP_/.test(e.code || '') && e.message && !errorText(e).includes(e.message) ? ' - ' + e.message : ''); }
}

let srcDlg = null;
function openSources() { if (!S) return; srcDlg = sheetDialog(t('menu.sources'), $('site-label').textContent); srcList(); }
function srcList() {
  const msg = el('div', { class: 'dlg-msg' });
  const rows = (S.sources || []).map(x => el('div', { class: 'src-row' },
    el('div', { class: 'src-main' },
      el('div', { class: 'src-name' }, x.name),
      el('div', { class: 'muted small mono ell' }, x.transport === 'stdio' ? x.command : x.url),
      el('div', { class: 'muted small' }, t('src.items', { n: x.items.length }) + ' · ' + t('src.every.' + (x.interval || 0))),
      x.last ? el('div', { class: 'small ' + (x.last.ok ? 'ok-ink' : 'bad-ink') }, x.last.ok ? t('src.lastOk', { time: when(x.last.at), n: x.last.changed }) : t('src.lastFail', { time: when(x.last.at), error: x.last.error || '' }))
        : el('div', { class: 'muted small' }, t('src.never'))),
    el('div', { class: 'src-btns' },
      el('button', { type: 'button', onclick: () => srcForm(x) }, t('src.edit')),
      el('button', { type: 'button', class: 'icon', title: t('src.remove'), 'aria-label': t('src.remove'), html: icon('x', 14), onclick: async () => {
        if (!(await confirmBox(t('src.removeConfirm', { name: x.name }), { ok: t('src.remove'), cancel: t('cancel') }))) return;
        await inDialog(msg, async () => { await api('POST', '/api/sources/remove', { id: x.id }); await refresh(); srcList(); });
      } }))));
  const sync = el('button', { type: 'button', onclick: () => { sync.disabled = true; inDialog(msg, async () => { await api('POST', '/api/sources/sync', {}); await refresh(); srcList(); }, t('src.reading')).finally(() => { sync.disabled = false; }); } }, t('src.syncNow'));
  srcDlg.body.replaceChildren(
    el('p', { class: 'muted' }, t('src.intro')),
    ...(rows.length ? rows : [el('div', { class: 'sheet-empty muted' }, t('src.empty'))]),
    el('div', { class: 'ws-btns' }, el('button', { type: 'button', class: 'primary', onclick: () => srcForm(null) }, t('src.add')), rows.length ? sync : null),
    msg);
}
function srcForm(x) {
  const st = { transport: x?.transport || 'http', items: structuredClone(x?.items || []), found: null };
  const msg = el('div', { class: 'dlg-msg' });
  const name = el('input', { value: x?.name || '', placeholder: t('src.namePh') });
  const url = el('input', { value: x?.url || '', placeholder: 'https://example.com/mcp', spellcheck: 'false' });
  const cmd = el('input', { value: x?.command || '', placeholder: 'npx -y @example/notes-mcp', spellcheck: 'false' });
  const tokenEnv = el('input', { value: x?.tokenEnv || 'MCP_TOKEN', spellcheck: 'false' });
  const token = el('input', { type: 'password', ...KEY_INPUT, placeholder: x?.hasKey ? t('src.keySaved') : t('src.keyPh') });
  const interval = el('select', {}, ...[0, 15, 60, 360].map(n => el('option', { value: String(n), selected: (x?.interval || 0) === n }, t('src.every.' + n))));
  const urlRow = el('label', { class: 'field-lbl' }, t('src.url'), url);
  const cmdRow = el('div', { class: 'col' }, el('label', { class: 'field-lbl' }, t('src.command'), cmd), el('label', { class: 'field-lbl' }, t('src.tokenEnv'), tokenEnv), el('div', { class: 'muted small' }, t('src.cmdSafety')));
  const segBtns = ['http', 'stdio'].map(k => el('button', { type: 'button', onclick: () => { st.transport = k; draw(); } }, t('src.t.' + k)));
  const found = el('div', { class: 'src-found' });
  const cfg = () => ({ id: x?.id, name: name.value.trim() || 'source', transport: st.transport, url: url.value, command: cmd.value, tokenEnv: tokenEnv.value, token: token.value });
  const has = it => st.items.findIndex(i => i.type === it.type && (it.type === 'tool' ? i.name === it.name : i.uri === it.uri));
  function draw() {
    segBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(['http', 'stdio'][i] === st.transport)));
    urlRow.hidden = st.transport !== 'http'; cmdRow.hidden = st.transport !== 'stdio';
  }
  function drawFound() {
    const f = st.found;
    if (!f) {
      found.replaceChildren(st.items.length ? el('div', { class: 'muted small' }, t('src.chosen', { list: st.items.map(i => i.label).join(', ') })) : el('div', { class: 'muted small' }, t('src.connectFirst')));
      return;
    }
    const res = f.resources.map(r => {
      const item = { type: 'resource', uri: r.uri, label: r.name };
      return el('label', { class: 'pick' }, el('input', { type: 'checkbox', checked: has(item) >= 0, onchange: e => { const i = has(item); if (e.target.checked && i < 0) st.items.push(item); else if (!e.target.checked && i >= 0) st.items.splice(i, 1); } }),
        el('span', {}, el('span', {}, r.name), el('span', { class: 'muted small mono' }, ' ' + r.uri), r.description ? el('div', { class: 'muted small' }, r.description) : null));
    });
    const tools = f.tools.map(tl => {
      const base = { type: 'tool', name: tl.name, label: tl.name };
      const cur = st.items[has(base)];
      const args = el('textarea', { rows: '2', spellcheck: 'false', class: 'mono' });
      args.value = JSON.stringify(cur?.args || Object.fromEntries(tl.required.map(k => [k, ''])), null, 0);
      const bad = el('div', { class: 'bad-ink small' });
      const box = el('div', { class: 'tool-args' }, el('div', { class: 'muted small' }, t('src.args', { list: tl.properties.join(', ') || '-' })), args, bad);
      box.hidden = !cur;
      args.oninput = () => { const i = has(base); try { const v = JSON.parse(args.value || '{}'); if (typeof v !== 'object' || Array.isArray(v) || v === null) throw 0; bad.textContent = ''; if (i >= 0) st.items[i].args = v; } catch { bad.textContent = t('src.badArgs'); } };
      return el('div', { class: 'pick-tool' },
        el('label', { class: 'pick' }, el('input', { type: 'checkbox', checked: Boolean(cur), onchange: e => {
          const i = has(base); box.hidden = !e.target.checked;
          if (e.target.checked && i < 0) { let a = {}; try { a = JSON.parse(args.value || '{}'); } catch {} st.items.push({ ...base, args: a }); }
          else if (!e.target.checked && i >= 0) st.items.splice(i, 1);
        } }), el('span', {}, el('span', { class: 'mono' }, tl.name), tl.readOnly ? el('span', { class: 'tag ok' }, t('src.readOnly')) : el('span', { class: 'tag warn' }, t('src.mayWrite')),
          tl.description ? el('div', { class: 'muted small' }, tl.description) : null)), box);
    });
    found.replaceChildren(
      el('div', { class: 'muted small' }, f.server ? t('src.connected', { name: f.server.name }) : ''),
      res.length ? el('h4', {}, t('src.resources')) : null, ...res,
      tools.length ? el('h4', {}, t('src.tools')) : null, tools.length ? el('div', { class: 'muted small' }, t('src.toolsNote')) : null, ...tools,
      !res.length && !tools.length ? el('div', { class: 'muted small' }, t('src.nothing')) : null);
  }
  const connect = el('button', { type: 'button', onclick: () => { connect.disabled = true; inDialog(msg, async () => { st.found = await api('POST', '/api/sources/discover', cfg()); drawFound(); }, t('src.connecting')).finally(() => { connect.disabled = false; }); } }, t('src.connect'));
  const save = el('button', { type: 'button', class: 'primary', onclick: () => inDialog(msg, async () => {
    if (!st.items.length) throw Object.assign(Error(t('src.noItems')), {});
    if (found.querySelector('.tool-args:not([hidden]) .bad-ink:not(:empty)')) throw Error(t('src.badArgs'));
    await api('POST', '/api/sources/save', { ...cfg(), interval: Number(interval.value), items: st.items });
    await refresh(); srcList();
  }) }, t('save'));
  srcDlg.body.replaceChildren(
    el('label', { class: 'field-lbl' }, t('src.name'), name),
    el('div', { class: 'field-lbl' }, t('src.how'), el('div', { class: 'seg' }, ...segBtns)),
    urlRow, cmdRow,
    el('label', { class: 'field-lbl' }, t('src.key'), token, el('span', { class: 'muted small' }, t('src.keyNote'))),
    el('div', { class: 'ws-btns' }, connect),
    found,
    el('label', { class: 'field-lbl' }, t('src.when'), interval),
    el('div', { class: 'ws-btns' }, save, el('button', { type: 'button', onclick: srcList }, t('cancel'))),
    msg);
  draw(); drawFound(); requestAnimationFrame(() => watchSegs(srcDlg.d)); name.focus();
}

let hookDlg = null;
async function openHooks() { hookDlg = sheetDialog(t('menu.webhooks'), null); hookDlg.body.append(el('div', { class: 'muted' }, '…')); await drawHooks().catch(e => hookDlg.body.replaceChildren(el('div', { class: 'dlg-msg bad' }, errorText(e)))); }
async function drawHooks() {
  const data = await api('GET', '/api/webhooks');
  const msg = el('div', { class: 'dlg-msg' });
  const rows = data.hooks.map(h => el('div', { class: 'src-row' },
    el('div', { class: 'src-main' },
      el('div', { class: 'src-name mono ell' }, h.url),
      el('div', { class: 'muted small' }, h.events.map(e => t('hook.ev.' + e)).join(' · ')),
      h.last ? el('div', { class: 'small ' + (h.last.ok ? 'ok-ink' : 'bad-ink') }, h.last.ok ? t('hook.lastOk', { time: when(h.last.at), status: h.last.status }) : t('hook.lastFail', { time: when(h.last.at), status: h.last.status ?? h.last.error ?? '' })) : null,
      el('details', { class: 'inline' }, el('summary', { class: 'muted small' }, t('hook.secret')), el('div', { class: 'mono small sel' }, h.secret), el('div', { class: 'muted small' }, t('hook.secretNote')))),
    el('div', { class: 'src-btns' },
      el('button', { type: 'button', onclick: () => inDialog(msg, async () => { await api('POST', '/api/webhooks/test', { id: h.id }); await drawHooks(); }, t('hook.sending')) }, t('hook.test')),
      el('button', { type: 'button', class: 'icon', title: t('hook.remove'), 'aria-label': t('hook.remove'), html: icon('x', 14), onclick: async () => {
        if (!(await confirmBox(t('hook.removeConfirm', { url: h.url }), { ok: t('hook.remove'), cancel: t('cancel') }))) return;
        await inDialog(msg, async () => { await api('POST', '/api/webhooks/remove', { id: h.id }); await drawHooks(); });
      } }))));
  const url = el('input', { placeholder: 'https://hooks.slack.com/services/…', spellcheck: 'false' });
  const DEFAULT_EV = ['suggestions.ready', 'build.failed', 'sources.failed', 'analysis.failed'];
  const evs = data.events.map(e => el('label', { class: 'pick' }, el('input', { type: 'checkbox', value: e, checked: DEFAULT_EV.includes(e) }), el('span', {}, t('hook.ev.' + e))));
  const add = el('button', { type: 'button', class: 'primary', onclick: () => inDialog(msg, async () => {
    await api('POST', '/api/webhooks/save', { url: url.value, events: evs.map(l => l.querySelector('input')).filter(i => i.checked).map(i => i.value) }); await drawHooks();
  }) }, t('hook.add'));
  const inc = data.incoming;
  const curl = inc.enabled ? `curl -X POST ${inc.url} -H "Authorization: Bearer ${inc.key}"` : '';
  hookDlg.body.replaceChildren(
    el('p', { class: 'muted' }, t('hook.intro')),
    ...rows,
    el('h4', {}, t('hook.addTitle')),
    el('label', { class: 'field-lbl' }, t('hook.url'), url),
    el('div', { class: 'ev-grid' }, ...evs),
    el('div', { class: 'muted small' }, t('hook.privacy')),
    el('div', { class: 'ws-btns' }, add),
    el('h4', {}, t('hook.inTitle')),
    el('label', { class: 'mcheck', style: 'padding-left:0' }, el('input', { type: 'checkbox', checked: inc.enabled, onchange: e => inDialog(msg, async () => { await api('POST', '/api/webhooks/incoming', { enabled: e.target.checked }); await drawHooks(); }) }), t('hook.inOn')),
    el('div', { class: 'muted small' }, t('hook.inNote')),
    inc.enabled ? el('div', { class: 'code-row' }, el('code', { class: 'sel' }, curl), el('button', { type: 'button', onclick: () => navigator.clipboard.writeText(curl).then(() => { msg.className = 'dlg-msg'; msg.textContent = t('mcp.copied'); }) }, t('hook.copy'))) : null,
    msg);
}

$('settings').onclick = openDrawer;
$('close-drawer').onclick = closeDrawer;

// ---------------------------------------------------------------- top actions
async function doStep(dir) {
  if (dir === 'undo' && S?.undoLeavesPublished && !(await confirmBox(t('undo.leavePublished'), { ok: t('undo'), cancel: t('cancel') }))) return;
  try { await api('POST', `/api/${dir}`, {}); undoBlocked = false; }
  catch (e) {
    if (e.code !== 'BASELINE_CONFLICT_DETECTED' || dir !== 'undo') throw e;
    undoBlocked = true; say(''); return;   // banner offers to keep the current files and skip this step
  }
  say(t(dir === 'undo' ? 'msg.undone' : 'msg.redone'));
}
$('check').onclick = () => act(async () => { say(t('checking')); const r = await api('POST', '/api/check', {}); say(r.errorCode ? t(`err.${r.errorCode}`) : r.pending ? t('analysis.done', { n: r.pending }) : t('analysis.none'), Boolean(r.errorCode)); });
$('undo').onclick = () => act(() => doStep('undo'));
$('redo').onclick = () => act(() => doStep('redo'));
$('publish').onclick = () => act(async () => {
  const st = await api('GET', '/api/publish/status');
  if (isHost(st.mode)) {
    const host = st.mode, c = st[host], name = HOST_NAME[host], preview = HOST_UI[host].previewOf(c);
    if (!c.ready) { hostDialog(host); return; }
    if (typeof c.files !== 'number') throw Object.assign(Error(''), { code: c.files?.error, file: c.files?.file });
    if (!(await confirmBox(t(preview ? 'host.confirmPreview' : 'host.confirm', { n: c.files, name: c.project || c.site, host: name, branch: c.branch || '' }), { ok: t('publish'), cancel: t('cancel') }))) return;
    say(t('host.uploading', { host: name }));
    const r = await api('POST', '/api/publish', {});
    say(t(r.production ? 'host.done' : 'host.donePreview', { host: name, n: r.uploaded, total: r.files, url: r.production ? r.live || r.url : r.url }));
    return;
  }
  if (st.mode === 'git') {
    if (!st.git.available) throw Object.assign(Error(''), { code: st.git.reason });
    if (!(await confirmBox(t('publish.confirmGit', { remote: st.git.remote, branch: st.git.branch || '' }), { ok: t('publish'), cancel: t('cancel') }))) return;
    say(t('publish.pushing'));
    const r = await api('POST', '/api/publish', {});
    say(r.nothingToCommit ? t('publish.pushedNoChange', { remote: r.remote }) : t('publish.pushed', { commit: r.commit, remote: r.remote }));
  } else {
    if (!(await confirmBox(t('publish.confirm'), { ok: t('ok'), cancel: t('cancel') }))) return;
    await api('POST', '/api/publish', {}); say(t('msg.published'));
  }
});
// Narrow panel: when "Check for updates" no longer fits beside the tabs it drops to its own row and fills it,
// instead of hanging off the right edge.
new ResizeObserver(() => {
  const head = document.querySelector('.panel-head'), tabs = $('tab-sugg').parentElement, tools = document.querySelector('.panel-tools');
  head.classList.remove('stacked');
  if (tools.offsetTop > tabs.offsetTop + 4) head.classList.add('stacked');
}).observe(document.querySelector('.panel-head'));
const tabPanes = () => ['materials', 'bulk', 'cards', 'history'].map($);
const switchTab = h => { if (h === historyOpen) return; crossfade(tabPanes, () => { historyOpen = h; renderHistory(); }); };
$('tab-sugg').onclick = () => switchTab(false);
$('tab-history').onclick = () => switchTab(true);
$('open-demo').onclick = () => act(() => api('POST', '/api/workspace/demo', {}));
$('browse').onclick = () => act(async () => { const r = await api('POST', '/api/workspace/pick', { title: t('welcome.pickTitle') }); if (r.path) await openFolder(r.path); else if (r.unavailable) say(t('welcome.noPicker')); });
$('open-form').onsubmit = e => { e.preventDefault(); act(() => openFolder($('open-path').value.trim())); };
document.addEventListener('keydown', e => {
  if (!(e.metaKey || e.ctrlKey) || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  const k = e.key.toLowerCase(); if (k !== 'z' && k !== 'y') return;
  e.preventDefault(); act(() => doStep(k === 'y' || e.shiftKey ? 'redo' : 'undo'));
});

// Countdown on the Check button while an automatic analysis is waiting (cloud models wait ~30 s).
let countdownTimer = null;
function startCountdown(ms) {
  clearInterval(countdownTimer);
  if (ms < 2500) return;
  const end = Date.now() + ms;
  const tick = () => { const s = Math.max(0, Math.round((end - Date.now()) / 1000)); $('check').textContent = `${t('check')} · ${s}s`; $('check').classList.add('waiting'); if (!s) stopCountdown(); };
  tick(); countdownTimer = setInterval(tick, 500);
}
function stopCountdown(label) { clearInterval(countdownTimer); countdownTimer = null; $('check').textContent = label || t('check'); $('check').classList.toggle('waiting', Boolean(label)); if (!label) $('check').classList.remove('waiting'); }

// ---------------------------------------------------------------- live events from the host
let liveEvents = null;
function connectEvents() {
  const es = new EventSource(`/api/events?t=${encodeURIComponent(TOKEN)}`); liveEvents = es;
  let timer = null; const soon = () => { clearTimeout(timer); timer = setTimeout(() => { if (!busy) refresh().catch(() => {}); }, 150); };
  es.addEventListener('state', soon);
  es.addEventListener('materials', () => loadMaterials());
  es.addEventListener('memory', () => loadMemory());
  es.addEventListener('publish.progress', e => { const p = JSON.parse(e.data); if (p.total) say(t('host.progress', { host: HOST_NAME[S?.publishMode] || '', done: p.done, total: p.total })); });
  es.addEventListener('usage', soon);
  es.addEventListener('spending', () => checkSpending());
  es.addEventListener('analysis.scheduled', e => { const ms = JSON.parse(e.data).inMs; say(t('analysis.scheduled', { s: Math.round(ms / 1000) })); startCountdown(ms); });
  es.addEventListener('analysis.pending', () => say(t('analysis.pending')));
  es.addEventListener('analysis.started', () => { stopCountdown(t('checking')); say(t('analysis.started')); });
  es.addEventListener('analysis.completed', e => { stopCountdown(); const d = JSON.parse(e.data); say(d.errorCode ? t(`err.${d.errorCode}`) : d.pending ? t('analysis.done', { n: d.pending }) : t('analysis.none'), Boolean(d.errorCode)); soon(); });
  es.addEventListener('activity', e => onActivity(JSON.parse(e.data)));
  es.addEventListener('activity.removed', e => { const id = JSON.parse(e.data).id; if (activityItems) activityItems = activityItems.filter(m => m.id !== id); });
  es.addEventListener('build.started', e => buildStatus('running', JSON.parse(e.data || '{}')));
  es.addEventListener('build.done', e => { buildStatus('done', JSON.parse(e.data || '{}')); bridge.lastDoc = bridgeB.lastDoc = null; soon(); setTimeout(() => renderPreview().catch(() => {}), 200); });
  es.addEventListener('build.failed', e => { buildStatus('failed', JSON.parse(e.data || '{}')); say(t('build.failed'), true); soon(); });
  es.addEventListener('sources.synced', e => { const d = JSON.parse(e.data); if (d.failed?.length) say(t('src.syncFailed', { names: d.failed.map(f => f.name).join(', ') }), true); else if (d.changed) say(t('src.synced', { n: d.changed })); if (d.changed) loadMaterials().catch(() => {}); soon(); });
  es.addEventListener('site.external_change', e => { const d = JSON.parse(e.data); if (d.changes) say(t('msg.external', { n: d.changes })); soon(); });
  es.addEventListener('watch.error', () => say(t('err.generic'), true));
  es.addEventListener('backup.failed', e => { const d = JSON.parse(e.data); say(d.code ? t('err.' + d.code) : t('backup.failed', { message: d.message }), true); });
}

// ---------------------------------------------------------------- boot
(async () => {
  try {
    if (!TOKEN) throw Object.assign(Error(''), { code: 'UNAUTHORIZED' });
    const st = await api('GET', '/api/state');
    await loadLang(st.settings.language);
    await refresh(); connectEvents();
    if (st.settings.updateCheck !== false) setTimeout(() => checkUpdate(), 3000);   // after the page has settled
  } catch (e) { await loadLang('en').catch(() => {}); say(errorText(e), true); }
})();

// ---------------------------------------------------------------- resizable areas
// Suggestions | preview width (vertical bar) and preview | chat height (horizontal bar).
// Sizes are a per-browser convenience only; storage may be unavailable, so every access is guarded.
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };
function makeSplitter(bar, { axis, min, max, apply, key }) {
  const saved = Number(store.get(key)); if (saved) apply(saved);
  let start = 0, base = 0, cur = null;
  bar.addEventListener('pointerdown', e => {
    e.preventDefault(); bar.setPointerCapture(e.pointerId); bar.classList.add('drag'); document.body.classList.add('resizing');
    start = axis === 'x' ? e.clientX : e.clientY; base = axis === 'x' ? $('app').firstElementChild.getBoundingClientRect().width : $('chat').getBoundingClientRect().height;
  });
  bar.addEventListener('pointermove', e => {
    if (!bar.classList.contains('drag')) return;
    const d = (axis === 'x' ? e.clientX : e.clientY) - start;
    cur = Math.round(Math.min(max(), Math.max(min, axis === 'x' ? base + d : base - d))); apply(cur);
  });
  const end = () => { if (!bar.classList.contains('drag')) return; bar.classList.remove('drag'); document.body.classList.remove('resizing'); if (cur) store.set(key, cur); };
  bar.addEventListener('pointerup', end); bar.addEventListener('pointercancel', end);
  bar.addEventListener('dblclick', () => { apply(null); store.set(key, null); });
  bar.addEventListener('keydown', e => {
    const step = e.shiftKey ? 60 : 20, k = e.key;
    const grow = axis === 'x' ? { ArrowRight: 1, ArrowLeft: -1 } : { ArrowUp: 1, ArrowDown: -1 };
    if (!(k in grow)) return; e.preventDefault();
    const now = axis === 'x' ? $('app').firstElementChild.getBoundingClientRect().width : $('chat').getBoundingClientRect().height;
    cur = Math.round(Math.min(max(), Math.max(min, now + grow[k] * step))); apply(cur); store.set(key, cur);
  });
}
makeSplitter($('split-x'), { axis: 'x', key: 'sitetend.panelW', min: 260, max: () => Math.max(300, innerWidth * 0.6),
  apply: w => w == null ? $('app').style.removeProperty('--panel-w') : $('app').style.setProperty('--panel-w', w + 'px') });
makeSplitter($('split-y'), { axis: 'y', key: 'sitetend.chatH', min: 90, max: () => Math.max(140, innerHeight * 0.6),
  apply: h => { $('chat').classList.toggle('sized', h != null); h == null ? $('chat').style.removeProperty('--chat-h') : $('chat').style.setProperty('--chat-h', h + 'px'); } });
