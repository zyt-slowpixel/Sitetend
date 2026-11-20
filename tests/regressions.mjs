import assert from 'node:assert/strict';
import fs from 'node:fs';
import {SiteKeeperCore} from '../src/core/engine.js';
import {MemoryBackedWorkspaceAdapter, BrowserDirectoryWorkspaceAdapter} from '../src/adapters/workspace-adapter.js';
import {JsonGenericSiteAdapter} from '../src/adapters/json-generic-adapter.js';
const seed=JSON.parse(fs.readFileSync(new URL('../demo-workspace/website/content.json',import.meta.url)));
const adapter=new JsonGenericSiteAdapter();let count=0;
async function setup(){const ws=new MemoryBackedWorkspaceAdapter({'website/content.json':seed});const core=new SiteKeeperCore({workspaceAdapter:ws,siteAdapter:adapter});assert((await core.initializeWorkspace()).ok);return {ws,core}}
async function test(name,fn){await fn();count++;console.log('✓ '+name)}
await test('Failed draft save does not mutate the in-memory draft',async()=>{const {ws,core}=await setup();ws.writeJson=async()=>({ok:false,error:{code:'IO'}});const r=await core.editDraftField('profile.name','New name');assert(!r.ok);assert.equal(core.draftContent.profile.name,seed.profile.name)});
await test('History save failure rolls website back and retains recoverable draft',async()=>{const {ws,core}=await setup();await core.editDraftField('profile.name','New name');const write=ws.writeJson.bind(ws);ws.writeJson=async(p,d)=>p==='.sitetend/state.json'?{ok:false,error:{code:'IO'}}:write(p,d);const r=await core.applyDraftToWorkspace();assert(!r.ok);assert.equal(r.error.details.partialWrite,false);assert.equal((await ws.readJson('website/content.json')).data.data.profile.name,seed.profile.name);assert((await ws.exists('.sitetend/drafts/draft.json')).data.exists)});
await test('Draft cleanup failure reports warning after successful apply',async()=>{const {ws,core}=await setup();await core.editDraftField('profile.name','New name');ws.deleteFile=async()=>({ok:false,error:{code:'IO'}});const r=await core.applyDraftToWorkspace();assert(r.ok);assert(r.data.warning);const reopened=new SiteKeeperCore({workspaceAdapter:ws,siteAdapter:adapter});assert((await reopened.initializeWorkspace()).ok);assert.equal(reopened.hasUnsavedDraft,false)});
await test('No-op apply does not create unnecessary history',async()=>{const {core}=await setup();const r=await core.applyDraftToWorkspace();assert(r.ok);assert.equal(r.data.snapshotId,null);assert.equal(core.state.snapshots.length,0)});
await test('Outside edits to other fields are kept when applying',async()=>{const {ws,core}=await setup();await core.editDraftField('profile.name','New');const c=structuredClone(seed);c.profile.role='External';await ws.writeJson('website/content.json',c);const r=await core.applyDraftToWorkspace({forceResolveConflict:true});assert(r.ok);const d=(await ws.readJson('website/content.json')).data.data;assert.equal(d.profile.role,'External');assert.equal(d.profile.name,'New')});
await test('Force option cannot bypass a same-field external change',async()=>{const {ws,core}=await setup();await core.editDraftField('profile.name','New');const c=structuredClone(seed);c.profile.name='External name';await ws.writeJson('website/content.json',c);const r=await core.applyDraftToWorkspace({forceResolveConflict:true});assert(!r.ok);assert.equal((await ws.readJson('website/content.json')).data.data.profile.name,'External name')});
await test('External changes during snapshot creation invalidate apply',async()=>{const {ws,core}=await setup();await core.editDraftField('profile.name','New');const write=ws.writeJson.bind(ws);ws.writeJson=async(p,d)=>{const r=await write(p,d);if(p.startsWith('.sitetend/snapshots/')){const c=structuredClone(seed);c.profile.name='Concurrent';await write('website/content.json',c)}return r};assert(!(await core.applyDraftToWorkspace()).ok);assert.equal((await ws.readJson('website/content.json')).data.data.profile.name,'Concurrent')});
await test('Directory permission errors are not treated as missing files',async()=>{const ws=new BrowserDirectoryWorkspaceAdapter({getDirectoryHandle:async()=>{const e=Error('Denied');e.name='NotAllowedError';throw e}});assert(!(await ws.exists('website/content.json')).ok);assert(!(await ws.deleteFile('website/content.json')).ok)});
await test('PDF bytes round-trip in demo workspace',async()=>{const {ws}=await setup();const bytes=new Uint8Array([0,255,128,1]);assert((await ws.writeBytes('website/assets/sample.pdf',bytes)).ok);assert.deepEqual((await ws.readBytes('website/assets/sample.pdf')).data.bytes,bytes)});
await test('Browser storage quota failure is reported and rolled back',async()=>{globalThis.localStorage={getItem:()=>null,setItem:()=>{throw Error('QuotaExceeded')}};const ws=new MemoryBackedWorkspaceAdapter({'a.txt':'old'},'quota');assert(!(await ws.writeText('a.txt','new')).ok);assert.equal((await ws.readText('a.txt')).data.content,'old');delete globalThis.localStorage});
await test('Complete initialization manifest points to existing real website and PDF resources',async()=>{const manifest=JSON.parse(fs.readFileSync(new URL('../demo-workspace/manifest.json',import.meta.url)));for(const p of manifest)assert(fs.existsSync(new URL('../demo-workspace/'+p,import.meta.url)),p);for(const p of ['website/index.html','website/style.css','website/app.js','website/content.json','website/assets/resume.pdf','sources/resume.pdf'])assert(manifest.includes(p));assert(fs.readFileSync(new URL('../demo-workspace/website/assets/resume.pdf',import.meta.url)).subarray(0,5).equals(Buffer.from('%PDF-')))});
await test('Only the 30 most recent backups are kept (older files deleted); undo still goes back further',async()=>{const {ws,core}=await setup();
  for(let i=0;i<35;i++){assert((await core.editDraftField('profile.name','Name '+i)).ok);assert((await core.applyDraftToWorkspace()).ok)}
  assert.equal(core.state.snapshots.length,30);
  const files=(await ws.listFiles('.sitetend/snapshots')).data.files;assert.equal(files.length,30);
  for(let i=0;i<34;i++)assert((await core.undo()).ok);
  assert.equal(core.getStatusSummary().liveContent.profile.name,'Name 0')});
await test('A save cut off last time is finished when the site is opened again (one history entry, undoable)',async()=>{
  for(const written of [false,true]){
    const {ws,core}=await setup();
    assert((await core.editDraftField('profile.name','Cut off name')).ok);assert((await core.editDraftField('about.headline','Cut off headline')).ok);
    if(written)await ws.writeJson('website/content.json',core.draftContent);   // the website file was written, the history was not
    const again=new SiteKeeperCore({workspaceAdapter:ws,siteAdapter:adapter});assert((await again.initializeWorkspace()).ok);
    const r=await again.finishInterruptedApply();assert(r.ok&&r.data.finished);
    const live=(await ws.readJson('website/content.json')).data.data;assert.equal(live.profile.name,'Cut off name');assert.equal(live.about.headline,'Cut off headline');
    assert.equal(again.state.maintenanceLogs[0].action,'APPLY_DRAFT');assert.equal(again.state.maintenanceLogs[0].changes.length,2);
    assert((await again.undo()).ok);assert.notEqual((await ws.readJson('website/content.json')).data.data.profile.name,'Cut off name');
  }
});
await test('A save cut off last time is not finished when the site was also edited meanwhile (left to the conflict handling)',async()=>{
  const {ws,core}=await setup();
  assert((await core.editDraftField('profile.name','Cut off name')).ok);
  const d=(await ws.readJson('website/content.json')).data.data;d.profile.tagline='Edited in another tool';await ws.writeJson('website/content.json',d);
  const again=new SiteKeeperCore({workspaceAdapter:ws,siteAdapter:adapter});assert((await again.initializeWorkspace()).ok);
  const r=await again.finishInterruptedApply();assert(r.ok&&!r.data.finished);
  assert.equal((await ws.readJson('website/content.json')).data.data.profile.tagline,'Edited in another tool');
});
console.log(`${count} regression checks passed`);
