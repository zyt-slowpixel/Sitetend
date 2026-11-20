// Step 3: versioning robustness, batch undo, field locks, value evidence, resume asset replacement.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {AnalysisEngine} from '../src/agent/analysis-engine.js';
import {SourceParser} from '../src/adapters/source-parser.js';
import {MockModelProvider} from '../src/adapters/model-provider.js';
import {MemoryBackedWorkspaceAdapter} from '../src/adapters/workspace-adapter.js';
import {SiteKeeperCore} from '../src/core/engine.js';
import {JsonGenericSiteAdapter} from '../src/adapters/json-generic-adapter.js';
import {computeContentHash,legacyContentHash} from '../src/contracts.js';
import {take,sha256} from '../src/agent/utils.js';
if(!Promise.try)Promise.try=function(fn,...a){return new Promise(r=>r(fn(...a)))};
if(!globalThis.DOMMatrix)globalThis.DOMMatrix=class DOMMatrix{};
if(!Uint8Array.prototype.toHex)Uint8Array.prototype.toHex=function(){return Buffer.from(this).toString('hex')};
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url));
const content=JSON.parse(read('demo-workspace/website/content.json'));
const profile=JSON.parse(read('demo-workspace/sources/profile.json'));
const md=read('demo-workspace/sources/projects/orbit-dock.md').toString('utf8');
const oldPdf=new Uint8Array(read('demo-workspace/sources/resume.pdf'));
const newPdf=new Uint8Array(read('examples/updates/resume.pdf'));
const adapter=new JsonGenericSiteAdapter();let count=0;
async function test(name,fn){await fn();console.log('✓ '+name);count++}
const pending=e=>e.state.proposals.filter(p=>p.status==='PENDING');
const disk=async ws=>take(await ws.readJson('website/content.json')).data;
async function setup({provider=new MockModelProvider(),autoApply=true,files={}}={}){
  const ws=new MemoryBackedWorkspaceAdapter({'website/content.json':content,'sources/profile.json':profile,'sources/projects/orbit-dock.md':md,...files});
  for(const [p,b] of Object.entries(files))if(b instanceof Uint8Array)take(await ws.writeBytes(p,b));
  const editor=new SiteKeeperCore({workspaceAdapter:ws,siteAdapter:adapter});take(await editor.initializeWorkspace());editor.config.autoApply=autoApply;
  const engine=new AnalysisEngine({workspaceAdapter:ws,siteAdapter:adapter,editingCore:editor,parser:new SourceParser(),provider});take(await engine.initialize());take(await engine.scan({baselineOnly:true}));
  return {ws,editor,engine};
}
const email=(ws,v='new@example.com',extra={})=>ws.writeJson('sources/profile.json',{...profile,email:v,...extra});

await test('Hash ignores key order and formatting of content.json',async()=>{
  const reordered=Object.fromEntries(Object.entries(content).reverse());
  assert.equal(computeContentHash(reordered),computeContentHash(content));
  const {ws,editor,engine}=await setup();take(await email(ws));take(await engine.scan());take(await engine.decide(pending(engine)[0].id,'accept'));
  const d=await disk(ws);take(await ws.writeText('website/content.json',JSON.stringify(Object.fromEntries(Object.entries(d).reverse()))));
  take(await editor.undo()); // would have been blocked as an "external edit" before
  assert.equal((await disk(ws)).contact.email,profile.email)});

await test('Legacy FNV baseline is migrated without a false conflict',async()=>{
  const ws=new MemoryBackedWorkspaceAdapter({'website/content.json':content});
  const e1=new SiteKeeperCore({workspaceAdapter:ws,siteAdapter:adapter});take(await e1.initializeWorkspace());
  const st=take(await ws.readJson('.sitetend/state.json')).data;st.baselineContentHash=legacyContentHash(content);delete st.undoStack;take(await ws.writeJson('.sitetend/state.json',st));
  const e2=new SiteKeeperCore({workspaceAdapter:ws,siteAdapter:adapter});const s=take(await e2.initializeWorkspace());
  assert.equal(s.externalEditDetected,false);take(await e2.editDraftField('profile.role','After migration'));take(await e2.applyDraftToWorkspace())});

await test('Accept-all is one undo step',async()=>{
  const {ws,editor,engine}=await setup();take(await email(ws,'all@example.com',{location:'Detroit, MI'}));take(await engine.scan());
  const ids=pending(engine).map(p=>p.id);assert(ids.length>=2);
  const r=take(await engine.acceptMany(ids));assert.equal(r.accepted,ids.length);assert(r.applied);
  assert.equal(editor.state.undoStack.length,1);
  take(await editor.undo());const d=await disk(ws);assert.equal(d.contact.email,profile.email);assert.equal(d.contact.location,content.contact.location)});

await test('Batch accept skips a conflicting item and applies the rest',async()=>{
  const {ws,editor,engine}=await setup({autoApply:false});take(await email(ws,'b@example.com',{location:'Detroit, MI'}));take(await engine.scan());
  take(await editor.editDraftField('contact.location','Manual place'));
  const r=take(await engine.acceptMany(pending(engine).map(p=>p.id)));
  assert.equal(r.failures.length,1);assert.equal(editor.draftContent.contact.email,'b@example.com');assert.equal(editor.draftContent.contact.location,'Manual place')});

await test('Apply and undo are refused while a scan is running',async()=>{
  let release;const slow={providerId:'slow',isMock:false,analyzeSourceDiff:()=>new Promise(r=>{release=()=>r({ok:true,data:{decision:'NO_UPDATE_NEEDED',proposals:[]}})})};
  const {ws,editor,engine}=await setup({provider:slow,autoApply:false});take(await email(ws));
  const scanning=engine.scan();await new Promise(r=>setTimeout(r,20));
  take(await editor.editDraftField('profile.role','During scan'));
  const a=await editor.applyDraftToWorkspace();assert(!a.ok);assert(a.error.message.includes('check is running'));
  assert(!(await editor.undo()).ok);release();take(await scanning);take(await editor.applyDraftToWorkspace())});

await test('Invented short value with a real quote is dropped',async()=>{
  const sneaky={providerId:'sneaky',isMock:false,analyzeSourceDiff:async r=>({ok:true,data:{decision:'UPDATE',proposals:[
    {targetField:'contact.email',value:'attacker@evil.example',quote:'new@example.com',reason:'quote is real, value is not'},
    {targetField:'contact.location',value:'Detroit, MI',quote:'Detroit, MI',reason:'supported'}]}})};
  const {ws,engine}=await setup({provider:sneaky});take(await email(ws,'new@example.com',{location:'Detroit, MI'}));take(await engine.scan());
  assert(!pending(engine).some(p=>p.field==='contact.email'));assert(pending(engine).some(p=>p.field==='contact.location'));
  assert(engine.state.scans[0].results.some(r=>/1 suggestion\(s\) without enough evidence dropped/.test(r.message)))});

await test('Locked field gets no suggestions; manual edits still allowed',async()=>{
  const {ws,editor,engine}=await setup();take(await editor.setFieldLock('contact.email',true));
  take(await email(ws));take(await engine.scan());assert(!pending(engine).some(p=>p.field==='contact.email'));
  take(await editor.editDraftField('contact.email','me@example.com'));take(await editor.applyIfAuto());assert.equal((await disk(ws)).contact.email,'me@example.com');
  take(await editor.setFieldLock('contact.email',false));
  const e2=new SiteKeeperCore({workspaceAdapter:ws,siteAdapter:adapter});take(await e2.initializeWorkspace());assert(!e2.isFieldLocked('contact.email'))});

await test('Resume PDF replacement is suggested, applied, undone and redone as a file',async()=>{
  const {ws,editor,engine}=await setup({files:{'sources/resume.pdf':oldPdf,'website/assets/resume.pdf':oldPdf}});
  take(await ws.writeBytes('sources/resume.pdf',newPdf));take(await engine.scan());
  const asset=pending(engine).find(p=>p.field==='asset:website/assets/resume.pdf');assert(asset,'asset proposal exists');
  take(await engine.decide(asset.id,'accept'));
  const live=async()=>sha256(take(await ws.readBytes('website/assets/resume.pdf')).bytes);
  assert.equal(await live(),await sha256(newPdf));
  assert(editor.state.maintenanceLogs[0].changes.some(c=>c.path==='asset:website/assets/resume.pdf'&&c.sourcePath==='sources/resume.pdf'));
  take(await editor.undo());assert.equal(await live(),await sha256(oldPdf));
  take(await editor.redo());assert.equal(await live(),await sha256(newPdf));
  take(await engine.scan());assert(!pending(engine).some(p=>p.kind==='asset'),'no repeat suggestion')});

await test('Externally replaced download file is not overwritten',async()=>{
  const {ws,engine}=await setup({files:{'sources/resume.pdf':oldPdf,'website/assets/resume.pdf':oldPdf}});
  take(await ws.writeBytes('sources/resume.pdf',newPdf));take(await engine.scan());
  const asset=pending(engine).find(p=>p.kind==='asset');take(await ws.writeBytes('website/assets/resume.pdf',new TextEncoder().encode('%PDF-hand edited')));
  assert(!(await engine.decide(asset.id,'accept')).ok);assert.equal(engine.state.proposals.find(p=>p.id===asset.id).status,'CONFLICT')});

await test('Publish checkpoint: undo warns when leaving the published version',async()=>{
  const {ws,editor,engine}=await setup();take(await email(ws));take(await engine.scan());take(await engine.decide(pending(engine)[0].id,'accept'));
  take(await editor.markPublished({publishedHash:editor.state.baselineContentHash,publisherId:'test'}));
  const s=editor.getStatusSummary();assert(s.liveIsPublished);assert(s.undoLeavesPublished);
  take(await editor.undo());assert(!editor.getStatusSummary().liveIsPublished)});

await test('Undo/redo are per operation: no extra files, a new edit clears redo',async()=>{
  const {ws,editor}=await setup();
  for(let i=0;i<3;i++){take(await editor.editDraftField('profile.role','Role '+i));take(await editor.applyIfAuto())}
  const files=async()=>take(await ws.listFiles('.sitetend/snapshots')).files;
  const before=(await files()).length;
  take(await editor.undo());take(await editor.undo());
  assert.equal((await files()).length,before,'undo writes no snapshot files');assert.equal((await disk(ws)).profile.role,'Role 0');
  take(await editor.redo());assert.equal((await disk(ws)).profile.role,'Role 1');
  take(await editor.editDraftField('profile.role','New branch'));take(await editor.applyIfAuto());
  assert(!editor.canRedo());
  const referenced=new Set(editor.state.snapshots.map(s=>s.path));assert((await files()).every(f=>referenced.has(f)))});

await test('Adopting outside edits clears the stale undo chain',async()=>{
  const {ws,editor}=await setup();take(await editor.editDraftField('profile.role','Mine'));take(await editor.applyIfAuto());
  const d=await disk(ws);d.profile.role='Edited elsewhere';take(await ws.writeJson('website/content.json',d));
  assert(!(await editor.undo()).ok);take(await editor.discardDraft());assert(!editor.canUndo());
  assert.equal(editor.state.maintenanceLogs[0].action,'ADOPT_DISK');
  take(await editor.editDraftField('profile.role','Continue'));take(await editor.applyIfAuto());take(await editor.undo());assert.equal((await disk(ws)).profile.role,'Edited elsewhere')});

await test('Corrupt state.json can be recovered with a backup',async()=>{
  const ws=new MemoryBackedWorkspaceAdapter({'website/content.json':content,'.sitetend/state.json':'{broken'});
  const e1=new SiteKeeperCore({workspaceAdapter:ws,siteAdapter:adapter});assert(!(await e1.initializeWorkspace()).ok);
  const r=take(await SiteKeeperCore.recoverCorruptState(ws));assert(r.backupPath);assert.equal(take(await ws.readText(r.backupPath)).content,'{broken');
  const e2=new SiteKeeperCore({workspaceAdapter:ws,siteAdapter:adapter});take(await e2.initializeWorkspace());assert.deepEqual(await disk(ws),content)});

await test('Acknowledged deleted source stops asking for clarification',async()=>{
  const {ws,engine}=await setup();take(await ws.deleteFile('sources/projects/orbit-dock.md'));take(await engine.scan());
  assert(engine.state.scans[0].results.some(r=>r.kind==='DELETED'));take(await engine.acknowledgeDeletion('sources/projects/orbit-dock.md'));
  take(await engine.scan());assert(!engine.state.scans[0].results.some(r=>r.kind==='DELETED'))});

await test('Accept with edits writes the user wording and keeps the source; undo restores',async()=>{
  const {ws,editor,engine}=await setup();take(await ws.writeText('sources/projects/orbit-dock.md',md+'\n- **Summary**: A keyboard-first dock.\n'));take(await engine.scan());
  const p=pending(engine).find(x=>x.field.endsWith('.summary'));
  const r=take(await engine.acceptEdited(p.id,'A keyboard-first dock for solo builders <b>now</b>.'));assert(r.applied);assert(r.edited);
  assert.equal((await disk(ws)).projects[0].summary,'A keyboard-first dock for solo builders now.');
  const log=editor.state.maintenanceLogs[0];assert.match(log.note,/edited/i);
  const c=log.changes.find(c=>c.path===p.field);assert.equal(c.edited,true);assert.equal(c.suggested,'A keyboard-first dock.');assert.equal(c.sourcePath,'sources/projects/orbit-dock.md');
  take(await engine.scan());assert(!pending(engine).some(x=>x.field===p.field),'no re-suggestion after edited accept');
  take(await editor.undo());assert.equal((await disk(ws)).projects[0].summary,content.projects[0].summary)});

await test('Accept with edits still refuses invalid values and conflicts',async()=>{
  const {ws,editor,engine}=await setup({autoApply:false});take(await email(ws,'e@example.com'));take(await engine.scan());
  const p=pending(engine).find(x=>x.field==='contact.email');
  assert(!(await engine.acceptEdited(p.id,'not-an-email')).ok);assert.equal(engine.state.proposals.find(x=>x.id===p.id).status,'PENDING');
  take(await editor.editDraftField('contact.email','manual@example.com'));
  assert(!(await engine.acceptEdited(p.id,'mine@example.com')).ok);assert.equal(engine.state.proposals.find(x=>x.id===p.id).status,'CONFLICT')});

await test('Accept-all keeps per-card edits and is still one undo step',async()=>{
  const {ws,editor,engine}=await setup();take(await email(ws,'all2@example.com',{location:'Detroit, MI'}));take(await engine.scan());
  const loc=pending(engine).find(p=>p.field==='contact.location');
  const r=take(await engine.acceptMany(pending(engine).map(p=>p.id),{[loc.id]:'Detroit, Michigan'}));assert.equal(r.accepted,2);
  const d=await disk(ws);assert.equal(d.contact.email,'all2@example.com');assert.equal(d.contact.location,'Detroit, Michigan');
  assert.equal(editor.state.undoStack.length,1);take(await editor.undo());assert.equal((await disk(ws)).contact.location,content.contact.location)});

await test('Privacy filter: sensitive files are never read or sent to the model',async()=>{
  const sent=[];const base=new MockModelProvider();
  const spy={providerId:'spy',isMock:true,analyzeSourceDiff:r=>{sent.push(r.source.path);return base.analyzeSourceDiff(r)}};
  const {ws,editor,engine}=await setup({provider:spy});editor.config.privacyExclude=['diary*'];
  take(await ws.writeJson('sources/credentials.json',{email:'leak@example.com'}));
  take(await ws.writeText('sources/notes.md','# Notes\n-----BEGIN RSA PRIVATE KEY-----\nabc\n'));
  take(await ws.writeText('sources/keys.md','token: sk-abcdefghijklmnopqrstuvwxyz123456'));
  take(await ws.writeText('sources/diary-2026.md','Summary: private thoughts'));
  take(await email(ws,'fine@example.com'));take(await engine.scan());
  for(const p of ['sources/credentials.json','sources/notes.md','sources/keys.md','sources/diary-2026.md'])assert(!sent.includes(p),p+' was sent');
  assert(sent.includes('sources/profile.json'));
  const ex=engine.state.scans[0].results.filter(r=>r.status==='EXCLUDED').map(r=>r.path).sort();
  assert.deepEqual(ex,['sources/credentials.json','sources/diary-2026.md','sources/keys.md','sources/notes.md']);
  assert(!pending(engine).some(p=>p.value==='leak@example.com'))});

console.log(`${count} Step 3 checks passed`);
