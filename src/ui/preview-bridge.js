import {annotateHtml} from '../adapters/text-site-adapter.js';
import {renderMarkdown,plainMarkdown,README_CSS} from './markdown-lite.js';

// Runs inside the sandboxed preview (injected by the host, not part of the user's site).
// Edit mode: hover outlines editable text; click edits in place with the site's own fonts and layout.
function sitetendEditHelper() {
  var on = false, fields = {}, active = null, original = '', badge = null, hoverEl = null;
  var css = document.createElement('style');
  css.textContent = 'body.st-edit [data-sk-field]{cursor:text}'
    + 'body.st-edit tspan[data-sk-field]{pointer-events:auto!important}'   // SVG text: clickable even where the site turns clicks off
    + 'body.st-edit tspan[data-sk-field]:hover{fill:#3d63a8}'   // SVG text draws no outline
    + 'body.st-edit [data-sk-field]:hover{outline:1.5px dashed #3d63a8!important;outline-offset:3px}'
    + 'body.st-edit [data-sk-field].st-locked:hover{outline-color:#9aa6b2!important;cursor:not-allowed}'
    + 'body.st-edit [data-sk-field].st-other:hover{cursor:pointer}'
    + '[contenteditable].st-active{outline:2px solid #3d63a8!important;outline-offset:3px;background:#3d63a80d;border-radius:3px}'
    + '.st-badge{position:fixed;z-index:2147483647;font:600 11px/1 system-ui,sans-serif;background:#1d2733;color:#fff;border-radius:6px;padding:5px 7px;cursor:pointer;user-select:none;box-shadow:0 2px 8px #0003}';
  document.head.appendChild(css);
  function fieldOf(el) { var n = el && el.closest && el.closest('[data-sk-field]'); return n && fields[n.getAttribute('data-sk-field')] ? n : null; }
  function mark() {
    document.body.classList.toggle('st-edit', on);
    document.querySelectorAll('[data-sk-field]').forEach(function (n) {
      var f = fields[n.getAttribute('data-sk-field')];
      n.classList.toggle('st-locked', Boolean(on && f && f.locked));
      n.classList.toggle('st-other', Boolean(on && f && !f.locked && !inlineOk(n, f)));
    });
  }
  function inlineOk(n, f) { return typeof f.value === 'string' && (n.innerText || '').trim() === f.value.trim() && n.children.length === 0; }
  function showBadge(n) {
    if (!badge) { badge = document.createElement('div'); badge.className = 'st-badge'; document.body.appendChild(badge);
      badge.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation();
        if (hoverEl) parent.postMessage({ type: 'SITETEND_LOCK_TOGGLE', field: hoverEl.getAttribute('data-sk-field') }, '*'); }); }
    var f = fields[n.getAttribute('data-sk-field')], r = n.getBoundingClientRect();
    badge.textContent = f.locked ? '🔒 Unlock' : '🔓 Lock';
    badge.style.top = Math.max(4, r.top - 26) + 'px'; badge.style.left = Math.max(4, r.right - 70) + 'px'; badge.style.display = 'block';
  }
  function hideBadge() { if (badge) badge.style.display = 'none'; }
  function finish(commit) {
    if (!active) return;
    var n = active, field = n.getAttribute('data-sk-field'), value = n.innerText.replace(/ /g, ' ').trim();
    active = null; n.removeAttribute('contenteditable'); n.classList.remove('st-active');
    if (commit && value !== original.trim()) parent.postMessage({ type: 'SITETEND_EDIT_COMMIT', field: field, value: value }, '*');
    else n.innerText = original;
  }
  // Capture on window runs before the site's own handlers: in edit mode, clicks edit instead of navigating.
  window.addEventListener('click', function (e) {
    if (!on) return;
    if (active && active.contains(e.target)) return;
    var n = fieldOf(e.target);
    if (e.target.closest && e.target.closest('a,button')) e.preventDefault();
    e.stopImmediatePropagation();
    if (active) finish(true);
    if (!n) return;
    var f = fields[n.getAttribute('data-sk-field')];
    if (f.locked) return;
    if (!inlineOk(n, f)) { parent.postMessage({ type: 'SITETEND_EDIT_REQUEST', field: n.getAttribute('data-sk-field') }, '*'); return; }
    active = n; original = n.innerText; n.setAttribute('contenteditable', 'plaintext-only'); n.classList.add('st-active'); n.focus();
    var range = document.createRange(); range.selectNodeContents(n); var sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  }, true);
  window.addEventListener('keydown', function (e) {
    if (!active) return;
    // Enter saves everywhere; Shift+Enter inserts a line break (multi-line fields only).
    var multi = (fields[active.getAttribute('data-sk-field')] || {}).type === 'textarea';
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    else if (e.key === 'Enter' && !(multi && e.shiftKey)) { e.preventDefault(); finish(true); }
  }, true);
  document.addEventListener('focusout', function (e) { if (active && e.target === active) finish(true); });
  document.addEventListener('mouseover', function (e) { if (!on || active) return hideBadge(); var n = fieldOf(e.target); hoverEl = n; if (n) showBadge(n); else if (!(badge && badge.contains(e.target))) hideBadge(); });
  window.addEventListener('scroll', hideBadge, { passive: true });
  window.addEventListener('message', function (e) {
    if (e.source !== parent || !e.data) return;
    if (e.data.type === 'SITETEND_EDIT_MODE') { on = Boolean(e.data.on); fields = e.data.fields || {}; if (!on) { finish(false); hideBadge(); } setTimeout(mark, 30); }
    if (e.data.type === 'SITEKEEPER_PREVIEW_RENDER') { active = null; setTimeout(mark, 60); }
  });
}

// Loads the actual selected workspace template. Isolated opaque-origin iframe;
// the host only accepts messages from that iframe and registered field paths.
const IMAGE_TYPES={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',avif:'image/avif',svg:'image/svg+xml',ico:'image/x-icon',bmp:'image/bmp'};
const imageType=src=>IMAGE_TYPES[(src.split(/[?#]/)[0].split('.').pop()||'').toLowerCase()]||'application/octet-stream';
function dataUrl(bytes,type){let s='';const u=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);for(let i=0;i<u.length;i+=0x8000)s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000));return 'data:'+type+';base64,'+btoa(s);}
// Focus helper (runs inside the preview): outline a field's element(s) and scroll to it. If the text can hardly be
// seen (its background is drawn by the site's scripts, which the preview does not run), it gets a plain backing so
// the change can be read.
function sitetendFocusHelper() {
  var want = null;
  function rgb(c) { var m = String(c).match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/); return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null; }
  function lum(c) { function ch(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); } return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b); }
  function backdrop(n) { for (var e = n; e && e.nodeType === 1; e = e.parentElement) { var b = rgb(getComputedStyle(e).backgroundColor); if (b && b.a > 0.5) return b; } return { r: 255, g: 255, b: 255, a: 1 }; }
  function legible(n) {
    n.classList.remove('sitetend-on-dark', 'sitetend-on-light');
    var cs = getComputedStyle(n), fg = rgb(cs.color); if (!fg) return;
    var bg = backdrop(n), a = lum(fg), b = lum(bg), ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (ratio < 2 || parseFloat(cs.opacity) < 0.3 || (fg.a < 0.3)) n.classList.add(a > 0.5 ? 'sitetend-on-dark' : 'sitetend-on-light');
  }
  function apply() {
    document.querySelectorAll('.sitetend-focus').forEach(function (n) { n.classList.remove('sitetend-focus', 'sitetend-on-dark', 'sitetend-on-light'); });
    if (!want) return;
    var els = [];
    for (var i = 0; i < want.length && !els.length; i++) els = [].slice.call(document.querySelectorAll('[data-sk-field="' + want[i].replace(/"/g, '') + '"]')).filter(function (n) { return n.offsetParent !== null || getComputedStyle(n).position === 'fixed'; });
    els.forEach(function (n) { n.classList.add('sitetend-focus'); legible(n); });
    if (els[0]) els[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  // Most of the page's words light on a light backing: the real background is drawn by the site's scripts (a canvas,
  // a video). Show the page on a dark backing instead, so its words can be read.
  function backing() {
    var light = 0, total = 0, els = document.body ? document.body.querySelectorAll('p,h1,h2,h3,h4,li,span,div,a') : [];
    for (var i = 0; i < els.length && total < 400; i++) {
      var n = els[i]; if (!n.childNodes.length || ![].some.call(n.childNodes, function (c) { return c.nodeType === 3 && c.textContent.trim().length > 1; })) continue;
      var fg = rgb(getComputedStyle(n).color); if (!fg) continue; total++;
      if (lum(fg) > 0.6 && lum(backdrop(n)) > 0.6) light++;
    }
    if (total >= 3 && light / total > 0.5) document.documentElement.style.setProperty('background', '#3b3a36', 'important');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', backing); else backing();
  window.addEventListener('message', function (e) {
    if (e.source !== parent || !e.data) return;
    if (e.data.type === 'SITETEND_FOCUS') { want = e.data.paths || null; setTimeout(apply, 60); }
    if (e.data.type === 'SITEKEEPER_PREVIEW_RENDER' && want) setTimeout(apply, 60);
  });
}
export class PreviewBridge {
  constructor(frame, adapter, onField, onShortcut=null, onScroll=null, onEdit=null) {
    this.frame=frame; this.adapter=adapter; this.urls=[];this.payload=null;
    window.addEventListener('message', e=>{
      if(e.source!==frame.contentWindow || !e.data || typeof e.data!=='object') return;
      if(e.data.type==='SITEKEEPER_PREVIEW_READY') { this.send(); if(this.focusPaths) this.focus(this.focusPaths); if(this.editState) this.setEditMode(this.editState.on,this.editState.fields); }
      if(onEdit && ['SITETEND_EDIT_COMMIT','SITETEND_EDIT_REQUEST','SITETEND_LOCK_TOGGLE'].includes(e.data.type) && typeof e.data.field==='string') onEdit(e.data);
      if(e.data.type==='SITETEND_TEXT' && typeof e.data.n==='number') { this.shownText=e.data.n; this.onShown?.({ text:e.data.n, visible:typeof e.data.v==='number'?e.data.v:e.data.n, covered:e.data.c===true, ownScripts:this.lastContent?.mode==='html'&&!this.build?.main?(this.ownScripts||0):0, page:this.page }); }
      if(e.data.type==='SITETEND_SCROLL' && onScroll && typeof e.data.ratio==='number') onScroll(Math.min(1,Math.max(0,e.data.ratio)));
      // A link to another page of the site was clicked in the preview: show that page (the preview has no network).
      if(e.data.type==='SITETEND_NAVIGATE' && typeof e.data.href==='string') { const f=this._pageFromHref(e.data.href); if(f){ this.page=f; this.lastDoc=null; if(this.lastContent) this._renderText(this.lastContent); this.onNavigate?.(f); } }
      // Undo/redo pressed while focus is inside the preview.
      if(e.data.type==='SITEKEEPER_PREVIEW_SHORTCUT' && onShortcut && ['undo','redo'].includes(e.data.payload?.action)) onShortcut(e.data.payload.action);
      if(e.data.type==='SITEKEEPER_PREVIEW_FIELD_CLICK' && this.payload?.editable) {
        const path=e.data.payload?.fieldPath;
        if(adapter.listEditableFields(this.payload.content).some(f=>f.path===path)) onField(path);
      }
    });
  }
  async load(workspace) {
    this.urls.forEach(URL.revokeObjectURL);this.urls=[];
    // Text-file sites (HTML / Jekyll / Hugo): the page is rebuilt from the content on every render.
    if(this.adapter.adapterId==='text-files'){this.workspace=workspace;this.lastDoc=null;return;}
    const read=async p=>{const r=await workspace.readText(p);if(!r.ok) throw Error(r.error.message);return r.data.content};
    const [html,css,js]=await Promise.all(['index.html','style.css','app.js'].map(x=>read('website/'+x)));
    const doc=new DOMParser().parseFromString(html,'text/html');
    doc.querySelectorAll('script,link[rel="stylesheet"],base').forEach(e=>e.remove());
    const style=doc.createElement('style');style.textContent=css;doc.head.append(style);
    this._helpers(doc);
    const script=doc.createElement('script');script.textContent=js;doc.body.append(script);
    this.frame.srcdoc='<!doctype html>'+doc.documentElement.outerHTML;
    this.workspace=workspace;
  }
  /** Host-owned helpers added to every preview document (keyboard, focus outline, scroll sync, in-place editing, CSP). */
  _helpers(doc) {
    // Host-owned helper (not part of the user's site): forward Ctrl/⌘+Z, Ctrl/⌘+Shift+Z, Ctrl+Y to SiteKeeper.
    const keys=doc.createElement('script');
    keys.textContent="document.addEventListener('keydown',function(e){if(!(e.metaKey||e.ctrlKey))return;var t=document.activeElement&&document.activeElement.tagName;if(t==='INPUT'||t==='TEXTAREA'||(document.activeElement&&document.activeElement.isContentEditable))return;var k=e.key.toLowerCase();if(k!=='z'&&k!=='y')return;e.preventDefault();parent.postMessage({type:'SITEKEEPER_PREVIEW_SHORTCUT',payload:{action:(k==='y'||e.shiftKey)?'redo':'undo'}},'*')},true);";
    doc.head.append(keys);
    // Host-owned focus helper: outline the element(s) of a field and scroll to it. Independent of the site's own CSS.
    const focusStyle=doc.createElement('style');
    focusStyle.textContent='.sitetend-on-dark{background:#1e1e1a!important;color:#fefaf1!important;border-radius:4px}.sitetend-on-light{background:#fefaf1!important;color:#1e1e1a!important;border-radius:4px}.sitetend-focus{outline:3px solid #3d63a8!important;outline-offset:4px!important;border-radius:4px;box-shadow:0 0 0 8px #3d63a822!important;transition:outline-color .2s}';
    doc.head.append(focusStyle);
    const focus=doc.createElement('script');
    focus.textContent='('+sitetendFocusHelper.toString()+')();';
    doc.head.append(focus);
    // Host-owned scroll sync helper: reports scroll position (as a ratio) and follows positions sent by the host.
    const sync=doc.createElement('script');
    sync.textContent="(function(){var following=false,t=0;function max(){return Math.max(1,document.documentElement.scrollHeight-innerHeight)}addEventListener('scroll',function(){if(following){following=false;return}cancelAnimationFrame(t);t=requestAnimationFrame(function(){parent.postMessage({type:'SITETEND_SCROLL',ratio:scrollY/max()},'*')})},{passive:true});addEventListener('message',function(e){if(e.source!==parent||!e.data||e.data.type!=='SITETEND_SCROLL_TO')return;var y=Math.round(e.data.ratio*max());if(Math.abs(y-scrollY)<2)return;following=true;scrollTo(0,y)})})();";
    doc.head.append(sync);
    const edit=doc.createElement('script');edit.textContent='('+sitetendEditHelper.toString()+')();';doc.head.append(edit);
    // Host-owned navigation helper: a link to another page of the site asks the host to show that page.
    const nav=doc.createElement('script');
    nav.textContent="document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href]');if(!a||e.defaultPrevented)return;var h=a.getAttribute('href');if(/^([a-z][\\w+.-]*:|\\/\\/|#)/i.test(h))return;e.preventDefault();parent.postMessage({type:'SITETEND_NAVIGATE',href:h},'*');});";
    doc.head.append(nav);
    // No network access from selected code. Data and assets are supplied by host.
    const csp=doc.createElement('meta');csp.httpEquiv='Content-Security-Policy';
    csp.content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; font-src data:; connect-src 'none';";
    doc.head.prepend(csp);
  }
  async render(content, mode, field) {
    if(this.adapter.adapterId==='text-files') return this._renderText(content);
    const r=this.adapter.buildPreviewPayload(content,{mode,editable:mode==='draft',activeFieldPath:field});
    if(!r.ok) throw Error(r.error.message);
    // Download assets are read from the selected directory, never fetched from the app origin.
    const path=content.resume?.downloadPath;
    if(path && /^assets\/[A-Za-z0-9_./-]+$/.test(path) && !path.split('/').includes('..')) {
      const file=await this.workspace.readBytes('website/'+path);
      if(file.ok) {
        const url=URL.createObjectURL(new Blob([file.data.bytes],{type:path.endsWith('.pdf')?'application/pdf':'application/octet-stream'}));
        this.urls.push(url);r.data.content.resume.downloadPath=url;
      }
    }
    this.payload=r.data;this.send();
  }
  /** Outline a field in the preview. paths: candidates in priority order (first visible one wins). */
  focus(paths){
    const key=JSON.stringify(paths||null),fresh=key!==this.focusKey;this.focusKey=key;this.focusPaths=paths;
    // a suggestion just selected on another page of a plain HTML site: show that page (once; links still navigate after)
    const file=fresh&&(paths||[]).map(p=>String(p).split('::')[0]).find(f=>/\.html?$/i.test(f)&&this.lastContent?.files?.[f]!==undefined);
    if(file&&file!==this.page){this.page=file;this.lastDoc=null;this.onNavigate?.(file);}
    this.frame.contentWindow?.postMessage({type:'SITETEND_FOCUS',paths},'*');
  }
  /** The site file a link in the shown page points to, or null (outside links, anchors on the same page, other files). */
  _pageFromHref(href){
    if(!this.lastContent?.files||/^([a-z][\w+.-]*:|\/\/|#)/i.test(href))return null;
    const cur=this.page||'';const dir=cur.includes('/')?cur.slice(0,cur.lastIndexOf('/')+1):'';
    let path=href.split(/[?#]/)[0];if(!path)return null;
    const parts=(path.startsWith('/')?path.slice(1):dir+path).split('/');const out=[];for(const p of parts){if(p==='..')out.pop();else if(p&&p!=='.')out.push(p);}
    let f=out.join('/');if(!f||href.split(/[?#]/)[0].endsWith('/'))f=(f?f+'/':'')+'index.html';
    const files=this.lastContent.files;
    return files[f]!==undefined?f:files[f+'.html']!==undefined?f+'.html':files[f+'/index.html']!==undefined?f+'/index.html':null;
  }
  /** Turns in-place text editing on/off. fields: { path: { value, type, locked } } */
  setEditMode(on,fields={}){this.editState={on,fields};this.frame.contentWindow?.postMessage({type:'SITETEND_EDIT_MODE',on,fields},'*');}
  scrollTo(ratio){this.frame.contentWindow?.postMessage({type:'SITETEND_SCROLL_TO',ratio},'*');}
  async _renderText(content){
    this.lastContent=content;
    const html=this.build?.main?await this._builtPage(content):content.mode==='html'?await this._htmlPage(content):content.mode==='readme'?await this._readmePage(content):this._contentView(content);
    if(html===this.lastDoc)return;
    this.lastDoc=html;this.payload=null;this.frame.srcdoc=html;
  }
  /** Static HTML site: the real page with its stylesheets and images, every editable text marked for focus/editing. */
  async _htmlPage(content){
    const files=Object.keys(content.files).filter(f=>/\.html?$/i.test(f));
    const file=(this.page&&content.files[this.page]!==undefined?this.page:null)||files.find(f=>/^index\.html?$/i.test(f))||files[0];this.page=file;
    if(!file)return this._contentView(content);
    return this._inline(file,new DOMParser().parseFromString(annotateHtml(file,content.files[file]),'text/html'));
  }
  /**
   * Site with a build step: show the generated page as built, and find the source fields in it by their text
   * (a field whose words appear as a whole element). Those get marked so a suggestion can be outlined and edited
   * in place; the content passed in (e.g. with a suggestion applied) replaces the built text there.
   */
  async _builtPage(content){
    const r=await this.workspace.readText('website/'+this.build.main);
    if(!r.ok)return this._contentView(content);
    const doc=new DOMParser().parseFromString(r.data.content,'text/html');
    if(doc.body.textContent.replace(/\s+/g,'').length<20)return this._contentView(content);   // a single-page app draws its words with JavaScript: nothing to show without running it
    this._markFields(doc,content);
    return this._inline(this.build.main,doc);
  }
  /** A GitHub profile: the README drawn the way GitHub shows it, its words marked like a built page. */
  async _readmePage(content){
    const file=Object.keys(content.files).find(f=>/^README\.md$/i.test(f));
    if(!file)return this._contentView(content);
    const doc=new DOMParser().parseFromString('<!doctype html><html><head><meta charset="utf-8"><style>'+README_CSS+'</style></head><body><main>'+renderMarkdown(content.files[file].replace(/^---[\s\S]*?\n---\s*\n/,''))+'</main></body></html>','text/html');
    this._markFields(doc,content);
    return this._inline(file,doc);
  }
  /**
   * Find the source fields in a rendered page by their words (a field whose words are a whole element) and mark
   * them so a suggestion can be outlined and edited in place; the content passed in (e.g. with a suggestion
   * applied) replaces the rendered words there. Markdown values are compared by what a reader sees.
   */
  _markFields(doc,content){
    const live=this.live||content,norm=s=>plainMarkdown(String(s??'')).replace(/\s+/g,' ').trim();
    // words -> the fields that hold exactly those words, in source order (the same words can live in two fields:
    // a headline and a job title). Those spots are matched to the fields in page order.
    const byText=new Map();
    for(const f of this.adapter.listEditableFields(live)){
      if(!['text','textarea','email'].includes(f.type))continue;
      const v=this.adapter.getFieldValue(live,f.path);const text=norm(v.ok?v.data.value:'');
      if(text.length<2)continue;
      if(!byText.has(text))byText.set(text,[]);
      if(!byText.get(text).includes(f.path))byText.get(text).push(f.path);
    }
    // the innermost element whose whole text is a field's words (an outer element with the same text is skipped)
    const spots=[];
    for(const e of doc.body.querySelectorAll('*')){
      if(/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG)$/i.test(e.tagName)||e.closest('svg,script,style'))continue;
      const text=norm(e.textContent);if(!byText.has(text))continue;
      if([...e.querySelectorAll('*')].some(c=>norm(c.textContent)===text))continue;
      if(spots.some(s=>s.e.contains(e)))continue;   // words inside a field already found (a bold name in a list item) belong to that field
      spots.push({e,text});
    }
    const seen=new Map();
    for(const {e,text} of spots){   // document order
      const paths=byText.get(text),i=seen.get(text)||0;seen.set(text,i+1);
      const path=paths[Math.min(i,paths.length-1)];
      const now=this.adapter.getFieldValue(content,path);const was=this.adapter.getFieldValue(live,path);
      const span=doc.createElement('span');span.setAttribute('data-sk-field',path);
      if(now.ok&&was.ok&&norm(now.data.value)!==norm(was.data.value)){span.textContent=norm(now.data.value);e.replaceChildren(span);}
      else{span.append(...e.childNodes);e.append(span);}
    }
  }
  /** Stylesheets and images of the page, read from the website folder (the preview has no network). */
  async _inline(file,doc){
    const dir=file.includes('/')?file.slice(0,file.lastIndexOf('/')+1):'';
    // How much of this page is code of its own: a page drawn by its scripts looks empty here, and the owner is told why.
    this.ownScripts=[...doc.querySelectorAll('script')].filter(e=>!/json|template/i.test(e.getAttribute('type')||'')&&((e.getAttribute('src')||'')||e.textContent.trim().length>200)).length;
    doc.querySelectorAll('script,base,iframe,link[rel~="icon"],link[rel="manifest"],link[rel~="preload"],link[rel~="prefetch"]').forEach(e=>e.remove());   // the preview has no network
    const resolve=href=>{const parts=(dir+href.split(/[?#]/)[0]).split('/');const out=[];for(const p of parts){if(p==='..')out.pop();else if(p&&p!=='.')out.push(p);}return out.join('/');};
    for(const link of [...doc.querySelectorAll('link[rel~="stylesheet"]')]){
      const href=link.getAttribute('href')||'';link.remove();
      if(/^(https?:)?\/\//i.test(href)||!href)continue;
      const r=await this.workspace.readText('website/'+resolve(href));
      if(r.ok){const st=doc.createElement('style');st.textContent=await this._cssAssets(r.data.content,resolve(href));doc.head.append(st);}
    }
    for(const st of [...doc.querySelectorAll('style')])st.textContent=await this._cssAssets(st.textContent,file);   // fonts in the page's own <style>
    for(const img of [...doc.querySelectorAll('img[src]')]){
      const src=img.getAttribute('src');if(/^(https?:|data:|\/\/)/i.test(src))continue;
      const b=await this.workspace.readBytes('website/'+resolve(src));
      // A data: URL, not a blob: URL: the sandboxed preview has its own origin and may not load the host page's blobs.
      if(b.ok)img.setAttribute('src',dataUrl(b.data.bytes,imageType(src)));
      else img.removeAttribute('src');   // missing from the folder: shown as missing, not requested from the network
    }
    this._helpers(doc);this._ready(doc);
    return '<!doctype html>'+doc.documentElement.outerHTML;
  }
  /** CSS for the preview: fonts are read from the website folder (small ones, as data: URLs); other url()s are dropped (no network). */
  async _cssAssets(css,cssFile){
    const dir=cssFile.includes('/')?cssFile.slice(0,cssFile.lastIndexOf('/')+1):'';
    const norm=href=>{const out=[];for(const p of (dir+href.split(/[?#]/)[0]).split('/')){if(p==='..')out.pop();else if(p&&p!=='.')out.push(p);}return out.join('/');};
    const found=new Map();let total=0;
    for(const m of css.matchAll(/url\((['"]?)([^)'"]+)\1\)/g)){
      const href=m[2].trim();if(/^(data:|https?:|\/\/|#)/i.test(href)||!/\.(woff2?|ttf|otf)([?#]|$)/i.test(href)||found.has(href))continue;
      const b=await this.workspace.readBytes('website/'+norm(href));
      if(!b.ok||b.data.bytes.byteLength>600000||(total+=b.data.bytes.byteLength)>3000000){found.set(href,null);continue;}
      const ext=href.split(/[?#]/)[0].split('.').pop().toLowerCase();
      found.set(href,dataUrl(b.data.bytes,{woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',otf:'font/otf'}[ext]));
    }
    return css.replace(/url\((['"]?)([^)'"]+)\1\)/g,(all,q,href)=>{href=href.trim();if(/^(data:|#)/i.test(href))return all;const d=found.get(href);return d?`url("${d}")`:'none';});
  }
  /** Sites that must be built first (Jekyll, Hugo): a readable list of the editable words, file by file. */
  _contentView(content){
    const doc=new DOMParser().parseFromString('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>','text/html');
    const st=doc.createElement('style');
    st.textContent='body{font:15px/1.6 system-ui,sans-serif;color:#1d2733;background:#fbfbfa;margin:0;padding:28px 36px;max-width:900px}h1{font-size:20px;margin:0 0 4px}.note{color:#66788a;font-size:13px;margin-bottom:24px}section{background:#fff;border:1px solid #e4e7eb;border-radius:10px;padding:14px 18px;margin:0 0 16px}h2{font:600 13px ui-monospace,monospace;color:#3d63a8;margin:0 0 10px}.f{display:grid;grid-template-columns:200px 1fr;gap:12px;padding:5px 0;border-top:1px solid #f0f2f4}.f:first-of-type{border-top:0}.l{color:#66788a;font-size:12px;overflow-wrap:anywhere}.v{white-space:pre-wrap;overflow-wrap:anywhere}';
    doc.head.append(st);
    const h=doc.createElement('h1');h.textContent=this.contentViewTitle?.(content.mode)||(content.mode==='app'?'Website project':(content.mode==='hugo'?'Hugo':'Jekyll')+' site');doc.body.append(h);
    const note=doc.createElement('div');note.className='note';note.textContent=this.contentViewNote?.(content.mode)||(content.mode==='app'?'This site is built with a JavaScript framework (such as Astro, React, Next.js, Vue or Svelte), so it is shown as a list of its editable text, file by file. Turn on the build step in Settings to see the real page.':'This site is built by a site generator, so it is shown as a list of its editable text, file by file.');doc.body.append(note);
    const byFile=new Map();for(const f of this.adapter.listEditableFields(content)){if(!byFile.has(f.section))byFile.set(f.section,[]);byFile.get(f.section).push(f);}
    for(const [file,fields] of byFile){
      const sec=doc.createElement('section');const t=doc.createElement('h2');t.textContent=file;sec.append(t);
      for(const f of fields){const row=doc.createElement('div');row.className='f';const l=doc.createElement('div');l.className='l';l.textContent=(content.mode==='app'||/(^|\.)str\.\d/.test(f.path.split('::')[1]))&&f.label?f.label.split(' › ').slice(1).join(' › '):f.path.split('::')[1];
        const v=doc.createElement('div');v.className='v';v.setAttribute('data-sk-field',f.path);const val=this.adapter.getFieldValue(content,f.path);v.textContent=Array.isArray(val.data?.value)?val.data.value.join(', '):String(val.data?.value??'');row.append(l,v);sec.append(row);}
      doc.body.append(sec);
    }
    this._helpers(doc);this._ready(doc);
    return '<!doctype html>'+doc.documentElement.outerHTML;
  }
  _ready(doc){const s=doc.createElement('script');s.textContent="function covered(){var W=innerWidth,H=innerHeight,de=document.documentElement,b=document.body,found=null;if(!b||W<50||H<50)return false;var pts=[[.5,.5],[.25,.25],[.75,.25],[.25,.75],[.75,.75]];for(var i=0;i<pts.length;i++){var e=document.elementFromPoint(W*pts[i][0],H*pts[i][1]),hit=null;for(;e&&e!==b&&e!==de;e=e.parentElement){var cs=getComputedStyle(e);if(cs.position==='fixed'||cs.position==='absolute'){var r=e.getBoundingClientRect();if(r.left<=W*.05&&r.top<=H*.05&&r.right>=W*.95&&r.bottom>=H*.95)hit=e;}}if(!hit||(found&&hit!==found))return false;found=hit;}return (found.innerText||'').replace(/\\s+/g,'').length<20}function shownChars(){var b=document.body;if(!b)return 0;var w=document.createTreeWalker(b,4),n,c=0,k=0;while((n=w.nextNode())&&k++<4000&&c<2000){var t=n.nodeValue.replace(/\\s+/g,'');if(!t)continue;var r=document.createRange();r.selectNodeContents(n);var q=r.getBoundingClientRect();if(q.width<1||q.height<1)continue;var ok=true;for(var e=n.parentElement;e&&ok;e=e.parentElement){var cs=getComputedStyle(e);if(cs.visibility==='hidden'||cs.display==='none'||cs.opacity==='0')ok=false;else if(e!==b&&e!==document.documentElement&&cs.overflow!=='visible'){var a=e.getBoundingClientRect();if(a.width<1||a.height<1||a.right<=q.left||a.left>=q.right||a.bottom<=q.top||a.top>=q.bottom)ok=false;}}if(ok)c+=t.length;}return c}parent.postMessage({type:'SITEKEEPER_PREVIEW_READY'},'*');setTimeout(function(){parent.postMessage({type:'SITETEND_TEXT',n:(document.body&&document.body.innerText||'').replace(/\\s+/g,'').length,v:shownChars(),c:covered()},'*')},300);setTimeout(function(){window.dispatchEvent(new MessageEvent('message',{data:{type:'SITEKEEPER_PREVIEW_RENDER'},source:parent}))},80);";doc.body.append(s);}
  send(){if(this.payload)this.frame.contentWindow.postMessage({type:'SITEKEEPER_PREVIEW_RENDER',payload:this.payload},'*');}
}
