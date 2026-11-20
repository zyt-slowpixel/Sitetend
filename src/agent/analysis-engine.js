import {createOk,createErr,ERROR_CODES} from '../contracts.js';
import {take,sha256,same,id,now} from './utils.js';
const STATE='.sitetend/analysis.json';
const DECIDED_KEEP=300;
/** analysis.json must not grow forever: open suggestions stay, plus the latest accepted one per field or entry
 *  (where a value came from), plus the 300 most recent decided ones. */
export function compactProposals(next){
  const list=next?.proposals;if(!Array.isArray(list)||list.length<=DECIDED_KEEP)return next;
  const open=p=>!['ACCEPTED','REJECTED','SUPERSEDED','DISMISSED','UNDONE'].includes(p.status);
  const keep=new Set(),lastFor=new Set();
  for(let i=list.length-1;i>=0;i--){const p=list[i];if(p.status!=='ACCEPTED')continue;const k=p.kind==='item'?'item:'+(p.appliedKey||p.title||p.id):'field:'+p.field;if(!lastFor.has(k)){lastFor.add(k);keep.add(p)}}
  let recent=0;for(let i=list.length-1;i>=0;i--){const p=list[i];if(!open(p)&&recent<DECIDED_KEEP){keep.add(p);recent++}}
  return {...next,proposals:list.filter(p=>open(p)||keep.has(p))};
}
const ASSET='asset:';
const clone=x=>structuredClone(x);
const EMPTY=()=>({schemaVersion:1,initialized:false,sources:{},baselineSources:{},proposals:[],scans:[]});
import {valueHints,mappingHints} from './value-hints.js';
import {normTitle,cleanValues} from '../adapters/collections.js';
import {CODE_FILE,applyEdits,checkChange,addedWords,expand,condense} from './code-edits.js';
const normText=s=>String(s).toLowerCase().replace(/\s+/g,' ').trim();
/** Words, numbers and version-like tokens (v1.6, 2026, example.edu), lower-cased. */
/**
 * Where each website field usually gets its information from. Nothing here is specific to one website:
 *  - required: the user's own mappings (Advanced settings) -> a field mapped there only changes from those files;
 *  - usual:    the site adapter's suggestions plus past accepted suggestions -> a hint for the model and the reviewer.
 */
function fieldSources(site,disk,custom=[],proposals=[]){
  const required=new Map(),usual=new Map(),add=(m,f,src)=>{if(!m.has(f))m.set(f,new Set());m.get(f).add(src)};
  for(const m of custom||[])if(m?.sourcePath&&m?.targetField)add(required,m.targetField,m.sourcePath);
  for(const m of site.getSourceMappings?.(disk)||[])for(const f of m.targetFields||[])add(usual,f,m.sourcePattern);
  for(const p of proposals||[])if(p.status==='ACCEPTED'&&p.sourcePath&&p.kind!=='asset')add(usual,p.field,p.sourcePath);
  return {required,usual};
}
const tokens=s=>new Set((String(s).toLowerCase().match(/[\p{L}\p{N}]+(?:[.\-@][\p{L}\p{N}]+)*/gu)||[]));
/** Values that look different but mean the same (email letter case, URL trailing slash / host case). */
const sameMeaning=(type,a,b)=>{
  if(typeof a!=='string'||typeof b!=='string')return false;
  if(type==='email')return a.trim().toLowerCase()===b.trim().toLowerCase();
  if(type==='url'){try{const n=u=>{const x=new URL(u.trim());return x.protocol+'//'+x.host.toLowerCase()+x.pathname.replace(/\/+$/,'')+x.search};return n(a)===n(b)}catch{return false}}
  return false;
};
/** Files never sent to a model (by name). Users can add their own patterns in advanced settings. */
export const DEFAULT_PRIVACY_PATTERNS=Object.freeze(['*secret*','*credential*','*password*','*passwd*','*token*','*api-key*','*api_key*','*apikey*','*private*key*','id_rsa*','*.pem','*.key','*.p12','*.pfx','*.kdbx']);
const globToRegExp=g=>new RegExp('^'+String(g).trim().replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.')+'$','i');
/** Content that is never sent, whatever the file is called. */
const SECRET_CONTENT=/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}|\bghp_[A-Za-z0-9]{30,}|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}/;
function validPath(path){return typeof path==='string'&&path.startsWith('sources/')&&!path.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('.'))}
function formatOf(path){const p=path.toLowerCase();return p.endsWith('.json')?'json':p.endsWith('.pdf')?'pdf':p.endsWith('.docx')?'docx':'markdown'}
/** Coordinates parsers/providers; site-specific interpretation lives in Site Adapter. */
/** The owner's notes a model says it followed for one suggestion (only ids that were really given). */
const citedNotes=(item,notes)=>!notes?.length||!Array.isArray(item?.usedNotes)?[]:notes.filter(n=>item.usedNotes.includes(n.id));

export class AnalysisEngine {
  constructor({workspaceAdapter,siteAdapter,editingCore,parser,provider}){
    this.workspace=workspaceAdapter;this.site=siteAdapter;this.editor=editingCore;this.parser=parser;this.provider=provider;this.state=EMPTY();this.busy=false;this.scanning=false;
    // Apply / undo must not interleave with a running scan.
    this.editor.scanLock=()=>this.scanning;
    this.editor.describeChange=field=>{
      const item=[...this.state.proposals].reverse().find(p=>p.status==='ACCEPTED'&&p.kind==='item'&&p.appliedPaths?.includes(field));
      if(item)return {origin:item.via||'model',client:item.client,sourcePath:item.sourcePath,quote:item.quote,reason:item.reason,proposalId:item.id,item:{op:item.op||'add',title:item.title,collection:item.collectionLabel}};
      const code=[...this.state.proposals].reverse().find(p=>p.status==='ACCEPTED'&&p.kind==='code'&&p.appliedPaths?.includes(field));
      if(code)return {origin:code.via||'chat',client:code.client,sourcePath:code.sourcePath,quote:code.quote,reason:code.summary,proposalId:code.id};
      const value=this.draftValue(field);
      const p=[...this.state.proposals].reverse().find(p=>p.status==='ACCEPTED'&&p.field===field&&same(p.editedValue??p.value,value)&&(!this.editor.restoreContext||p.reviewedAt>this.editor.restoreContext.loadedAt));
      return p?{origin:p.kind==='agent'?'agent':p.kind==='chat'?'chat':p.kind==='asset'?'rule':p.isMock?'rule':'model',client:p.client,edited:p.editedValue!==undefined,suggested:p.editedValue!==undefined?p.value:undefined,sourcePath:p.sourcePath,quote:p.quote,reason:p.reason,proposalId:p.id}:{origin:this.editor.restoreContext?'restore-or-manual':'manual'};
    };
    this.editor.beforeApply=async()=>{
      const guard=await this.validateAcceptedDraft();if(!guard.ok)return guard;
      try{const collected=await this.collect();if(collected.errors.length)throw Error('Could not read the materials; nothing was changed on the website.');
        this.editor.historySourceBaseline=clone(this.state.baselineSources||{});
        if(this.editor.restoreContext){this.editor.pendingSourceBaseline=clone(this.editor.restoreContext.sourceBaseline);return guard;}
        const baseline=clone(this.editor.state.sourceBaseline||this.state.baselineSources||{});
        for(const [path,current] of Object.entries(collected.docs)){
          // Advance only sources whose current content was actually analyzed by the last scan;
          // unscanned edits (and STALE ones) stay discoverable.
          const scanned=this.state.sources[path];
          if(!current.doc||!scanned?.doc||scanned.rawHash!==current.rawHash)continue;
          const outstanding=this.state.proposals.some(p=>p.sourcePath===path&&['PENDING','CONFLICT'].includes(p.status)&&
            p.sourceHash===current.rawHash&&!same(this.draftValue(p.field),p.value));
          if(!outstanding)baseline[path]=clone(current);
        }
        this.editor.pendingSourceBaseline=baseline;return guard;
      }catch(e){return this.error(e)}
    };
  }
  /** Value currently in the draft for a field; asset fields map to the staged (or live) file hash. */
  draftValue(field,content=this.editor.draftContent){
    if(field.startsWith(ASSET)){const path=field.slice(ASSET.length);return this.editor.draftAssets?.[path]??this.editor.state?.assetBaseline?.[path]??null}
    return this.site.getFieldValue(content,field).data?.value;
  }
  async initialize(){try{
    if(take(await this.workspace.exists(STATE)).exists){const value=take(await this.workspace.readJson(STATE)).data;
      if(value.schemaVersion!==1||!value.sources||!Array.isArray(value.proposals)||!Array.isArray(value.scans))throw Error('The analysis record has an unsupported version or format; the file was kept as it is.');
      this.state=value;
      this.state.baselineSources ||= clone(value.sources); // Legacy state has no older source snapshot.
    }
    return createOk(this.summary());
  }catch(e){return this.error(e)}}
  summary(){return clone(this.state)}
  error(e){return createErr(e.code||ERROR_CODES.WORKSPACE_IO_ERROR,'AnalysisEngine',e.message)}
  async save(next){next=compactProposals(next);take(await this.workspace.writeJson(STATE,next));this.state=next}
  privacyPatterns(){return [...DEFAULT_PRIVACY_PATTERNS,...(this.editor.config?.privacyExclude||[])].map(globToRegExp)}
  async collect(){
    const rules=this.privacyPatterns();const excluded=[];
    const paths=take(await this.workspace.listFiles('sources')).files.filter(p=>validPath(p)&&/\.(json|md|markdown|txt|pdf|docx)$/i.test(p)).filter(p=>{
      const name=p.split('/').pop();
      if(rules.some(r=>r.test(name)||r.test(p))){excluded.push({path:p,reason:'NAME'});return false}
      return true;
    });
    if(paths.length>50)throw Error('At most 50 supported material files can be checked.');
    const docs={},errors=[];let total=0;
    for(const path of paths){try{
      const {bytes}=take(await this.workspace.readBytes(path));total+=bytes.byteLength;
      if(bytes.byteLength>2*1024*1024||total>8*1024*1024)throw Error('Materials are limited to 2 MB per file and 8 MB in total.');
      if(!/\.(pdf|docx)$/i.test(path)&&SECRET_CONTENT.test(new TextDecoder().decode(bytes))){excluded.push({path,reason:'CONTENT'});continue;}
      const rawHash=await sha256(bytes);const cached=this.state.sources[path];
      const result=cached?.rawHash===rawHash&&cached.doc?createOk(cached.doc):await this.parser.parseFile({path,format:formatOf(path),rawContent:bytes});
      docs[path]={rawHash,size:bytes.byteLength,doc:result.ok?result.data:null};if(!result.ok)errors.push({path,message:result.error.message,code:result.error.code});
    }catch(e){errors.push({path,message:e.message,...(e.code?{code:e.code}:{})});docs[path]={rawHash:null,doc:null}}}
    return {docs,errors,excluded};
  }
  /** Binary copy suggestions, e.g. sources/resume.pdf -> website/assets/resume.pdf (Spec A4). */
  async assetProposal(path,current,previous,disk){
    let mapping=(this.site.getSourceMappings?.(disk)||[]).find(m=>m.targetAssetCopy&&m.sourcePattern===path);
    if(!mapping&&/\.(pdf|docx)$/i.test(path)){   // generic: the website already publishes a file with the same name
      const target='website/assets/'+path.split('/').pop();
      if(take(await this.editor.currentAssetHash(target)).hash)mapping={targetAssetCopy:target};
    }
    if(!mapping||!current.rawHash||previous?.rawHash===current.rawHash)return null;
    const field=ASSET+mapping.targetAssetCopy;
    if(this.editor.isFieldLocked?.(field))return null;
    const live=take(await this.editor.currentAssetHash(mapping.targetAssetCopy)).hash;
    let oldSize=null;if(live){const b=await this.workspace.readBytes(mapping.targetAssetCopy);if(b.ok)oldSize=b.data.bytes.byteLength;}
    if(live===current.rawHash||this.editor.draftAssets?.[mapping.targetAssetCopy]===current.rawHash)return null;
    return {id:id(),kind:'asset',signature:await sha256([path,field,current.rawHash]),sourcePath:path,sourceHash:current.rawHash,sourceContentHash:current.doc?.contentHash||null,
      field,before:live,value:current.rawHash,targetPath:mapping.targetAssetCopy,oldSize,newSize:current.size||null,quote:`${path} (${current.size||0} bytes)`,reason:'The file in your materials was replaced; update the download on the website too.',
      status:'PENDING',provider:'rule',isMock:false,createdAt:now()};
  }
  async scan({baselineOnly=false,reanalyze=false}={}) {
    if(this.busy||this.editor.busy)return createErr('BUSY','AnalysisEngine','Another task is running.');
    this.busy=true;this.scanning=true;
    try{
      const collected=await this.collect();
      if(baselineOnly){
        if(this.state.initialized)throw Error('A baseline already exists; it is not rebuilt silently.');
        if(collected.errors.length)throw Error('Could not create the baseline: '+collected.errors.map(e=>e.message).join('\n'));
        const next=clone(this.state);next.initialized=true;
        next.sources=Object.fromEntries(Object.entries(collected.docs).map(([p,x])=>[p,{...x,processedBy:'baseline'}]));
        next.baselineSources=clone(next.sources);
        next.scans.unshift({id:id(),at:now(),kind:'BASELINE',results:[{status:'BASELINE',message:'Baseline created; no suggestions were made.'}]});
        await this.save(next);return createOk(this.summary());
      }
      if(!this.state.initialized)throw Error('Create the baseline first, then change the materials in sources and check again.');
      const disk=take(await this.editor._readLive()).data;
      take(this.site.validateContent(disk));const next=clone(this.state);const results=[...collected.errors.map(e=>({...e,status:'ERROR'})),...collected.excluded.map(x=>({path:x.path,status:'EXCLUDED',reason:x.reason,message:'Privacy rule: not read and not sent to the model.'}))];
      const excludedPaths=new Set(collected.excluded.map(x=>x.path));
      // Only a successful website Apply advances the baseline.
      const baseline=this.editor.state.sourceBaseline||next.baselineSources||{};
      const previousPending=next.proposals.filter(p=>p.status==='PENDING');
      const isDirect=p=>p.kind==='agent'||p.kind==='chat'||Boolean(p.via);   // from an agent or the chat (incl. new items): no source file
      next.proposals=next.proposals.filter(p=>p.status!=='PENDING'||isDirect(p));
      const providerKey=this.provider.providerId;
      const stillOpen=p=>p.kind==='item'?!this.itemOnSite(p):!same(this.draftValue(p.field),p.value)&&!this.editor.isFieldLocked?.(p.field);
      const isNew=p=>!next.proposals.some(x=>x.signature===p.signature&&['REJECTED','PENDING'].includes(x.status));
      for(const path of Object.keys(baseline))if(!Object.hasOwn(collected.docs,path)&&!excludedPaths.has(path)&&!(next.acknowledgedDeletions||[]).includes(path))
        results.push({path,status:'NEEDS_CLARIFICATION',kind:'DELETED',message:'The material was deleted. Nothing was removed from the website; you decide.'});
      // The model service is down (unreachable, timing out, refusing the key, or this month's limit is used up): the
      // first file that meets it waits for it; the other files of this check are reported with the same reason at once.
      let modelDown=null;const DOWN=new Set(['PROVIDER_UNREACHABLE','PROVIDER_TIMEOUT','PROVIDER_AUTH','PROVIDER_UNAVAILABLE','PROVIDER_BUDGET_REACHED']);
      for(const [path,current]of Object.entries(collected.docs)) {
        if(!current.doc)continue;const previous=baseline[path];
        const comparedTo=previous?.doc?.contentHash??null;
        let assetAdded=0;
        const asset=await this.assetProposal(path,current,previous,disk);
        if(asset&&(reanalyze||isNew(asset))){next.proposals.push(asset);assetAdded++;}
        if(!reanalyze && previous?.doc?.contentHash===current.doc.contentHash) {
          next.sources[path]={...current,processedBy:providerKey,comparedTo};
          results.push(assetAdded?{path,status:'UPDATE',message:'The file was replaced; update the download too.',proposalCount:assetAdded}
            :{path,status:'NO_UPDATE_NEEDED',message:previous.rawHash===current.rawHash?'The material did not change.':'Only spacing, comments or JSON order changed.',unchanged:true});continue;
        }
        // Same content, same comparison point, same provider: keep earlier cards instead of calling the model again.
        const last=this.state.sources[path];
        if(!reanalyze&&last?.doc?.contentHash===current.doc.contentHash&&last.comparedTo===comparedTo&&last.processedBy===providerKey&&
          Array.isArray(last.producedIds)&&last.producedIds.every(pid=>previousPending.some(p=>p.id===pid))){
          const kept=previousPending.filter(p=>p.sourcePath===path&&p.kind!=='asset'&&stillOpen(p));
          next.proposals.push(...kept);next.sources[path]={...current,processedBy:providerKey,comparedTo,producedIds:kept.map(p=>p.id)};
          results.push({path,status:kept.length+assetAdded?'UPDATE':'NO_UPDATE_NEEDED',message:kept.length?'Unchanged since the last check; earlier suggestions are kept.':'Unchanged since the last check.',proposalCount:kept.length+assetAdded,reused:true});continue;
        }
        const mappings=this.editor.config.sourceMappings||[];
        const allFields=this.site.listEditableFields(disk);
        const withValues=allFields.map(f=>({path:f.path,current:take(this.site.getFieldValue(disk,f.path)).value}));
        const paths=new Set(allFields.map(f=>f.path));
        let hints=[...mappingHints(current.doc,mappings,paths),...valueHints(reanalyze?null:previous?.doc,current.doc,withValues)]
          .filter((h,i,a)=>!this.editor.isFieldLocked?.(h.targetField)&&a.findIndex(x=>x.targetField===h.targetField)===i);
        if(previous?.doc && !reanalyze) {
          const oldHints=mappingHints(previous.doc,mappings,paths);
          hints=hints.filter(h=>!oldHints.some(old=>old.targetField===h.targetField&&same(old.value,h.value)));
        }
        const owners=fieldSources(this.site,disk,this.editor.config.sourceMappings,this.state.proposals);
        const request={source:current.doc,previousText:previous?.doc?.extractedText||null,change:previous?'MODIFIED':'ADDED',
          fields:this.site.listEditableFields(disk).filter(f=>!this.editor.isFieldLocked?.(f.path)).map(f=>({path:f.path,label:f.label,type:f.type,current:take(this.site.getFieldValue(disk,f.path)).value,...(owners.usual.get(f.path)?{usualSource:[...owners.usual.get(f.path)].join(' or ')}:{})})),hints};
        const lists=(this.site.listCollections?.(disk)||[]).filter(c=>c.canAdd).slice(0,30);
        if(lists.length)request.collections=lists.map(c=>({id:c.id,label:c.label,itemCount:c.items.length,existing:c.items.slice(0,15).map(i=>String(i.title).slice(0,60)),
          fields:c.fields.map(f=>({name:f.name,...(f.label&&f.label!==f.name?{label:f.label}:{}),type:f.type,required:f.required,example:f.example,...(f.choices?{choices:f.choices}:{})}))}));
        try{
          if(modelDown)throw modelDown;
          if(this.replyLanguage)request.replyLanguage=this.replyLanguage;
          await this.locate(request);
          // What the owner asked Sitetend to remember. Added only when there is something, so a site without notes sends exactly what it always sent.
          const notes=this.provider.isMock?[]:(await this.notesFor?.(request.fields.map(f=>f.path)))||[];
          if(notes.length)request.ownerNotes=notes.map(n=>({id:n.id,kind:n.kind,text:n.text}));
          this._notes=notes;
          let response=take(await this.provider.analyzeSourceDiff(request));
          let checked;
          try{checked=await this.validateResponse(response,current,disk,path,reanalyze?null:previous?.doc);}
          catch(err){
            // One retry: tell the model exactly why its answer was rejected.
            if(!err.rejected||this.provider.isMock)throw err;
            response=take(await this.provider.analyzeSourceDiff({...request,feedback:'Your previous answer was rejected: '+err.rejected.join('; ')+'. Fix these problems or return NO_UPDATE_NEEDED / NEEDS_CLARIFICATION.'}));
            checked=await this.validateResponse(response,current,disk,path,reanalyze?null:previous?.doc);
          }
          const {proposals:validated,dropped,locked,rejected}=checked;
          const review=await this.review(validated,request,current,collected.docs,disk);
          for(const r of review.rejected)rejected.push(r);
          let added=assetAdded;const produced=[],usedNotes=[];
          for(const proposal of review.kept){
            if(!reanalyze && !isNew(proposal))continue;
            if(proposal.kind==='item'?this.itemOnSite(proposal):same(this.draftValue(proposal.field),proposal.value))continue;
            next.proposals.push(proposal);added++;produced.push(proposal.id);
            if(proposal.memory?.length)usedNotes.push(...proposal.memory);
          }
          next.sources[path]={...current,processedBy:providerKey,comparedTo,producedIds:produced};
          if(usedNotes.length)this.onNotesUsed?.([...new Set(usedNotes)]);
          const notesText=[dropped?`${dropped} suggestion(s) without enough evidence dropped`:'',locked?`${locked} on locked fields skipped`:'',review.rejected.length?`${review.rejected.length} rejected by the reviewer`:''].filter(Boolean).join('; ');
          results.push({path,status:added?'UPDATE':response.decision==='NEEDS_CLARIFICATION'?'NEEDS_CLARIFICATION':'NO_UPDATE_NEEDED',message:(response.summary||'No new suggestions.')+(notesText?' ('+notesText+')':''),byModel:!response.isMockResult&&!!response.summary,proposalCount:added,...(notes.length?{notesGiven:notes.length,notesUsed:[...new Set(usedNotes)]}:{}),dropped,locked,reviewRejected:review.rejected.map(r=>String(r).slice(0,200)),suggested:review.kept.filter(p=>produced.includes(p.id)).map(p=>p.kind==='item'?p.title:(this.site.listEditableFields(disk).find(f=>f.path===p.field)?.label||p.field)),isMock:this.provider.isMock,...(rejected.length?{rejected}:{})});
        }catch(e){if(!modelDown&&DOWN.has(e.code))modelDown=Object.assign(Error(e.message),{code:e.code});results.push({path,status:'ERROR',message:e.message,...(e.code?{code:e.code}:{}),...(e.rejected?{rejected:e.rejected}:{})});if(assetAdded)results.push({path,status:'UPDATE',message:'The file was replaced; update the download too.',proposalCount:assetAdded});/* No checkpoint: failed analyses retry. */}
      }
      if(!results.length)results.push({status:'UNCHANGED',message:'No new changes in the materials and no open suggestions.'});
      next.scans.unshift({id:id(),at:now(),kind:'SCAN',provider:this.provider.providerId,results});next.scans=next.scans.slice(0,40);
      await this.save(next);return createOk(this.summary());
    }catch(e){return this.error(e)}finally{this.busy=false;this.scanning=false}
  }
  /** Locate step: on large websites, ask which fields this change could touch and send only those to the generator. */
  async locate(request){
    const size=JSON.stringify(request.fields).length;
    if(!this.provider.locateFields||this.provider.isMock||size<(this.locateThreshold??12000))return;
    // Large websites are sent in parts (about 15k tokens of fields each), so one request never outgrows the model.
    const all=request.fields.map(f=>({path:f.path,label:f.label,preview:JSON.stringify(f.current).slice(0,90)}));
    const parts=[];let part=[],len=0;
    for(const f of all){const n=JSON.stringify(f).length;if(part.length&&len+n>(this.locateChunk??60000)){parts.push(part);part=[];len=0}part.push(f);len+=n}
    if(part.length)parts.push(part);
    const want=new Set();
    for(const fields of parts){
      const r=await this.provider.locateFields({source:{path:request.source.path,extractedText:request.source.extractedText.slice(0,12000)},previousText:request.previousText?.slice(0,12000)??null,fields});
      if(!r.ok)return;   // fall back to all fields
      for(const p of r.data.paths)want.add(p);
    }
    const picked=request.fields.filter(f=>want.has(f.path));
    if(picked.length)request.fields=picked;
    request.located=true;
  }

  /** Reviewer: independent second look. reject -> dropped (reason kept in the scan log); flag -> card shows a warning. */
  async review(proposals,request,current,docs,disk){
    if(!proposals.length||this.reviewer===false||this.provider.isMock||!this.provider.reviewProposals)return {kept:proposals,rejected:[]};
    const others=Object.entries(docs||{}).filter(([p,d])=>p!==current.doc.path&&d?.doc).slice(0,8)
      .map(([p,d])=>({path:p,excerpt:d.doc.extractedText.slice(0,1500)}));
    const fields=new Map(this.site.listEditableFields(disk).map(f=>[f.path,f]));
    const r=await this.provider.reviewProposals({replyLanguage:this.replyLanguage,
      source:{path:current.doc.path,extractedText:current.doc.extractedText.slice(0,8000)},previousText:request.previousText?.slice(0,8000)??null,otherMaterials:others,
      proposals:proposals.map(p=>p.kind==='item'
        ?{id:p.id,field:p.field,label:'NEW ITEM in '+p.collectionLabel,type:'new item',current:null,proposed:p.values,
          existingItems:((this.site.listCollections?.(disk)||[]).find(c=>c.id===p.collection)?.items||[]).slice(0,15).map(i=>i.title),quote:p.quote,reason:p.reason}
        :{id:p.id,field:p.field,label:fields.get(p.field)?.label,type:fields.get(p.field)?.type,current:p.before,proposed:p.value,quote:p.quote,reason:p.reason,...(p.crossSource?{crossSource:`usually updated from ${p.crossSource.join(' or ')}`}:{}),...(p.memory?.length?{followsNotes:p.memory}:{})}),
      ...(request.ownerNotes?.length?{ownerNotes:request.ownerNotes}:{})});
    if(!r.ok){for(const p of proposals)p.review={verdict:'unreviewed'};return {kept:proposals,rejected:[]};}
    const byId=new Map(r.data.reviews.filter(x=>x&&typeof x.id==='string').map(x=>[x.id,x]));
    const kept=[],rejected=[];
    for(const p of proposals){
      const v=byId.get(p.id),verdict=['approve','remind','flag','reject'].includes(v?.verdict)?v.verdict:'flag';
      const note=typeof v?.note==='string'?v.note.slice(0,300):'';
      // Shadow mode (evaluation only): record the verdict but keep every card, so the reviewer can be scored.
      if(verdict==='reject'&&!this.reviewerShadow){rejected.push(`${p.field}: reviewer rejected - ${note}`);continue;}
      p.review={verdict,note,lang:this.replyLanguage||null};kept.push(p);
    }
    return {kept,rejected};
  }

  /** Is a new-item suggestion already on the website (an item with the same title in that list)? */
  itemOnSite(p,content=this.editor.draftContent){
    const coll=(this.site.listCollections?.(content)||[]).find(c=>c.id===p.collection);
    return Boolean(coll?.items.some(i=>normTitle(i.title)===normTitle(p.title)));
  }
  async validateResponse(response,current,disk,path,previousDoc=null){
    if(response&&response.newItems===undefined)response.newItems=[];
    if(!response||!['UPDATE','NO_UPDATE_NEEDED','NEEDS_CLARIFICATION'].includes(response.decision)||!Array.isArray(response.proposals)||response.proposals.length>25||!Array.isArray(response.newItems)||response.newItems.length>10)throw Error('The model reply does not have the expected structure.');
    if(response.decision!=='UPDATE'&&(response.proposals.length||response.newItems.length))throw Error('The model decision does not match its list of suggestions.');
    const proposals=[],seen=new Set(),rejected=[];let invalid=0,locked=0;
    const reject=(item,why)=>{invalid++;rejected.push(`${item?.targetField??'?'}: ${why}`);};
    const fields=new Map(this.site.listEditableFields(disk).map(f=>[f.path,f]));
    const sourceText=normText(current.doc.extractedText);
    const owners=fieldSources(this.site,disk,this.editor.config.sourceMappings,this.state.proposals);
    for(const item of response.proposals){
      // Drop a single bad item instead of discarding the whole model response.
      if(!item||!(typeof item.value==='string'||(Array.isArray(item.value)&&item.value.every(x=>typeof x==='string')))||JSON.stringify(item.value).length>10000||typeof item.targetField!=='string'||typeof item.reason!=='string'||!item.reason.trim()){reject(item,'malformed item');continue;}
      if(seen.has(item.targetField)){reject(item,'field listed twice');continue;}
      if(!fields.has(item.targetField)){reject(item,'not an editable field');continue;}
      const required=owners.required.get(item.targetField);
      if(required&&!required.has(path)){reject(item,`the owner mapped this field to ${[...required].join(' or ')}, not ${path}`);continue;}
      const usual=owners.usual.get(item.targetField);
      const crossSource=usual&&!usual.has(path)?[...usual]:null;   // allowed, but the reviewer takes a closer look
      if(typeof item.quote!=='string'||item.quote.trim().length<3||!current.doc.extractedText.includes(item.quote)){reject(item,'quote is not an exact substring of source.extractedText');continue;}
      seen.add(item.targetField);
      if(this.editor.isFieldLocked?.(item.targetField)){locked++;continue;}
      if(previousDoc?.extractedText.includes(item.quote))continue; // no newly changed evidence
      const set=this.site.setFieldValue(disk,item.targetField,item.value);
      if(!set.ok){reject(item,'value rejected by the website: '+(set.error?.message||''));continue;}
      const value=set.data.value;
      // Short factual values (email, URL, title, year, location…) must literally appear in the source,
      // so a real quote cannot be paired with an invented value. Long prose is left to human review.
      // Emails/URLs must appear in the source as written. For other short text, every word or number that is
      // NEW compared with the current website value must come from the source; words kept from the current
      // value are allowed, so the site's own format survives ("v1.6 (2026)" -> "2026 · v1.6").
      const type=fields.get(item.targetField)?.type;
      const before=take(this.site.getFieldValue(disk,item.targetField)).value;
      if(typeof value==='string'&&(type==='email'||type==='url')&&!sourceText.includes(normText(value))){reject(item,`value "${value}" does not appear in the source`);continue;}
      if(typeof value==='string'&&type==='text'&&value.length<=80&&!sourceText.includes(normText(value))){
        const src=tokens(current.doc.extractedText),old=tokens(before);
        const abbrev=t=>t.length>=3&&/^\p{L}+$/u.test(t)&&[...src].some(x=>x.length>t.length&&x.startsWith(t));   // Thu <- Thursdays, Sept <- September
        // A suggestion that follows a note of the owner may also use the note's own words, and may write out a word the source abbreviates (Sept -> September).
        const cited=citedNotes(item,this._notes);
        const noteWords=cited.length?tokens(cited.map(n=>n.text).join(' ')):new Set();
        const expands=t=>cited.length&&t.length>=4&&/^\p{L}+$/u.test(t)&&[...src].some(x=>x.length>=3&&x.length<t.length&&t.startsWith(x.replace(/\.$/,'')));
        const unsupported=[...tokens(value)].filter(t=>!old.has(t)&&!src.has(t)&&!abbrev(t)&&!noteWords.has(t)&&!expands(t));
        if(unsupported.length){reject(item,`new words not found in the source: ${unsupported.join(', ')}`);continue;}
      }
      if(same(before,value)||sameMeaning(type,before,value))continue;
      // Same source + field + value = same suggestion, regardless of unrelated edits elsewhere in the file.
      const signature=await sha256([path,item.targetField,value]);
      proposals.push({id:id(),signature,sourcePath:path,sourceHash:current.rawHash,sourceContentHash:current.doc.contentHash,field:item.targetField,before:clone(before),value:clone(value),
        quote:item.quote,reason:item.reason.slice(0,3000),lang:this.replyLanguage||null,...(crossSource?{crossSource}:{}),...(citedNotes(item,this._notes).length?{memory:citedNotes(item,this._notes).map(n=>n.id)}:{}),status:'PENDING',provider:this.provider.providerId,isMock:this.provider.isMock,createdAt:now()});
    }
    // New items for a list (a new project, paper, talk, member…), shaped like the items already there.
    const lists=new Map((this.site.listCollections?.(disk)||[]).map(c=>[c.id,c]));
    const srcTokens=tokens(current.doc.extractedText);
    const abbrevOf=t=>t.length>=3&&/^\p{L}+$/u.test(t)&&[...srcTokens].some(x=>x.length>t.length&&x.startsWith(t));
    for(const it of response.newItems){
      const label=`new item in ${it?.collection??'?'}`;
      const no=why=>{invalid++;rejected.push(`${label}: ${why}`);};
      if(!it||typeof it.collection!=='string'||!it.values||typeof it.values!=='object'||Array.isArray(it.values)||typeof it.reason!=='string'||!it.reason.trim()){no('malformed new item');continue;}
      const coll=lists.get(it.collection);
      if(!coll||!coll.canAdd){no('not a list that can take new items');continue;}
      if(typeof it.quote!=='string'||it.quote.trim().length<3||!current.doc.extractedText.includes(it.quote)){no('quote is not an exact substring of source.extractedText');continue;}
      if(previousDoc?.extractedText.includes(it.quote))continue;
      const values=cleanValues(it.values),fieldOf=new Map(coll.fields.map(f=>[f.name,f]));
      const unknown=Object.keys(values).filter(k=>!fieldOf.has(k));
      if(unknown.length){no(`unknown fields for this list: ${unknown.join(', ')}`);continue;}
      const title=values[coll.titleField];
      if(!title||Array.isArray(title)){no(`the new item needs "${coll.titleField}"`);continue;}
      if(coll.items.some(i=>normTitle(i.title)===normTitle(title)))continue;   // already on the site: field edits handle it
      // Every short value must come from the source, word for word or token by token (abbreviations allowed).
      const bad=[];
      const itemCited=citedNotes(it,this._notes),itemNoteWords=itemCited.length?tokens(itemCited.map(n=>n.text).join(' ')):new Set();
      const itemExpands=t=>itemCited.length&&t.length>=4&&/^\p{L}+$/u.test(t)&&[...srcTokens].some(x=>x.length>=3&&x.length<t.length&&t.startsWith(x.replace(/\.$/,'')));
      for(const [name,v] of Object.entries(values)){
        const f=fieldOf.get(name),text=Array.isArray(v)?v.join(' '):v;
        if(f.choices?.includes(text))continue;
        if((f.type==='email'||f.type==='url')&&!sourceText.includes(normText(text))){bad.push(`${name} "${text}" does not appear in the source`);continue;}
        if(f.type==='date'){const ys=String(text).match(/\d{4}/g)||[];if(!ys.length||!ys.every(y=>srcTokens.has(y)))bad.push(`${name} "${text}": year not found in the source`);continue;}
        if(text.length<=80&&!sourceText.includes(normText(text))){const miss=[...tokens(text)].filter(t=>!srcTokens.has(t)&&!abbrevOf(t)&&!itemNoteWords.has(t)&&!itemExpands(t));if(miss.length)bad.push(`${name}: new words not found in the source: ${miss.join(', ')}`);}
      }
      if(bad.length){no(bad.join('; '));continue;}
      const position=it.position==='start'?'start':'end';
      const built=this.site.buildItem(disk,coll.id,{op:'add',position,values});
      if(!built.ok){no('the website could not take this item: '+built.error.message);continue;}
      proposals.push({id:id(),kind:'item',signature:await sha256([path,'item',coll.id,normTitle(title)]),sourcePath:path,sourceHash:current.rawHash,sourceContentHash:current.doc.contentHash,
        field:'item:'+coll.id,collection:coll.id,collectionLabel:coll.label,op:'add',position,values,title:String(title),missing:built.data.missing,warnings:built.data.warnings,
        before:null,value:null,quote:it.quote,reason:it.reason.slice(0,3000),lang:this.replyLanguage||null,...(itemCited.length?{memory:itemCited.map(n=>n.id)}:{}),status:'PENDING',provider:this.provider.providerId,isMock:this.provider.isMock,createdAt:now()});
    }
    // If nothing in the response was usable, treat it as a failed analysis (retried next scan).
    if(invalid&&invalid===response.proposals.length+response.newItems.length)throw Object.assign(Error('Unknown field, missing evidence, or the evidence is not quoted from the material.'),{rejected});
    return {proposals,dropped:invalid,locked,rejected};
  }
  async sourceMatches(p,bytes){
    if(await sha256(bytes)===p.sourceHash)return true;
    if(p.kind==='asset')return false; // binary copies must be the exact reviewed file
    const parsed=take(await this.parser.parseFile({path:p.sourcePath,format:formatOf(p.sourcePath),rawContent:bytes}));
    const expected=p.sourceContentHash||this.state.sources[p.sourcePath]?.doc?.contentHash;
    return !!expected&&parsed.contentHash===expected&&parsed.extractedText.includes(p.quote);
  }
  /** After a change made outside Sitetend: a waiting suggestion whose spot was changed there becomes a conflict now,
   *  not when the owner presses Accept. paths: the fields that changed. Returns how many. */
  async markConflicts(paths){
    const set=new Set(paths||[]);if(!set.size)return 0;
    const live=take(await this.editor._readLive()).data;let n=0;
    const next=structuredClone(this.state);
    for(const p of next.proposals){
      if(p.status!=='PENDING'||p.kind==='asset'||p.kind==='item'||!set.has(p.field))continue;
      const r=this.site.getFieldValue(live,p.field);if(!r.ok)continue;
      const current=r.data.value;
      if(!same(current,p.before)&&!same(current,p.value)){p.status='CONFLICT';p.conflict={baseline:p.before,current,draft:current,proposed:p.value};n++;}
    }
    if(n)await this.save(next);
    return n;
  }
  async validateAcceptedDraft(){
    try {
      for(const p of this.state.proposals.filter(p=>p.status==='ACCEPTED'&&p.kind!=='asset'&&p.kind!=='agent'&&p.kind!=='chat'&&p.kind!=='item'&&p.kind!=='code')) {
        if(this.editor.restoreContext&&p.reviewedAt<=this.editor.restoreContext.loadedAt)continue;
        const draft=this.site.getFieldValue(this.editor.draftContent,p.field);
        const live=this.site.getFieldValue(this.editor.liveContent,p.field);
        const accepted=p.editedValue??p.value;
        if(!draft.ok || !live.ok || !same(draft.data.value,accepted)||same(live.data.value,accepted))continue;
        const {bytes}=take(await this.workspace.readBytes(p.sourcePath));
        if(!await this.sourceMatches(p,bytes))throw Error('The material behind an accepted suggestion changed again: '+p.sourcePath+'. Check again, or adjust the draft by hand.');
      }
      return createOk({valid:true});
    }catch(e){return createErr(ERROR_CODES.STALE_DRAFT_DETECTED,'AnalysisEngine',e.message)}
  }
  /** Moves one proposal into the draft (no Apply). Mutates p's status; throws a user-facing message on failure. */
  /**
   * The same words often sit in two places (a desktop page and its phone version, a page and its summary). When a
   * suggestion changes one, the copies in other files still holding exactly the old words get the same new words, so
   * the website does not end up saying two things. Only longer text (12+ characters), not links, not locked spots.
   * Other open cards for those copies with the same new value are marked done. Returns the paths changed.
   */
  async syncCopies(p,value,proposals){
    if(p.kind==='item'||p.kind==='asset'||p.kind==='code')return [];
    if(typeof p.before!=='string'||typeof value!=='string'||p.before.trim().length<12)return [];
    const old=p.before.trim(),out=[],files=this.editor.draftContent?.files,home=String(p.field).split('::')[0];
    if(!files||!String(p.field).includes('::'))return [];   // sites kept as files only
    const where=new Set(Object.keys(files).filter(f=>f!==home&&typeof files[f]==='string'&&files[f].includes(old)));   // other files: in the same file, two equal texts are often different things (a title and a heading)
    if(!where.size)return [];
    for(const f of this.site.listEditableFields(this.editor.draftContent)||[]){
      if(!where.has(String(f.path).split('::')[0])||f.type==='url'||this.editor.isFieldLocked?.(f.path))continue;
      const r=this.site.getFieldValue(this.editor.draftContent,f.path);
      if(!r.ok||typeof r.data.value!=='string'||r.data.value.trim()!==old)continue;
      if((await this.editor.editDraftField(f.path,value)).ok)out.push(f.path);
    }
    for(const q of proposals||[])if(q!==p&&q.status==='PENDING'&&out.includes(q.field)&&same(q.value,value)){q.status='ACCEPTED';q.reviewedAt=now();q.withCard=p.id;}
    if(out.length)p.copies=out;
    return out;
  }
  async acceptInto(p,choice=null){
    if(p.kind==='item')return this.acceptItem(p,choice);
    if(p.kind==='code')return this.acceptCode(p);
    if(this.editor.isFieldLocked?.(p.field))throw Object.assign(Error('This field is locked; suggestions are not applied to it: '+p.field),{code:'FIELD_LOCKED'});
    const direct=p.kind==='agent'||p.kind==='chat';
    const {bytes}=direct?{bytes:null}:take(await this.workspace.readBytes(p.sourcePath));
    if(!direct&&!await this.sourceMatches(p,bytes)){p.status='STALE';throw Object.assign(Error('The material changed, so this suggestion is out of date. Check again.'),{code:'PROPOSAL_STALE'})}
    if(p.kind==='asset'){
      const target=p.field.slice(ASSET.length);
      const current=take(await this.editor.currentAssetHash(target)).hash;
      const staged=this.editor.draftAssets?.[target];
      if((current!==p.before&&current!==p.value)||(staged&&staged!==p.value)){
        p.status='CONFLICT';p.conflict={baseline:p.before,current,draft:staged??current,proposed:p.value};
        throw Object.assign(Error('The download file on the website was changed by someone else, so it was not overwritten.'),{code:'PROPOSAL_CONFLICT'});
      }
      const stored=take(await this.editor.storeBlob(bytes));
      if(current!==p.value)take(await this.editor.stageAsset(target,stored.hash));
    } else {
      const disk=take(await this.editor._readLive()).data;take(this.site.validateContent(disk));
      const current=take(this.site.getFieldValue(disk,p.field)).value;
      const draft=take(this.site.getFieldValue(this.editor.draftContent,p.field)).value;
      if((!same(current,p.before)&&!same(current,p.value))||(!same(draft,p.before)&&!same(draft,p.value))){
        p.status='CONFLICT';p.conflict={baseline:p.before,current,draft,proposed:p.value};
        throw Object.assign(Error('This field was changed elsewhere, so it was not overwritten. Edit it by hand or check again.'),{code:'PROPOSAL_CONFLICT'});
      }
      if(!same(draft,p.value))take(await this.editor.editDraftField(p.field,p.value));
    }
    p.status='ACCEPTED';p.reviewedAt=now();
  }
  /**
   * A new-item card. The item is built against the CURRENT draft (not the website as it was when the card was made),
   * so accepting other cards first does not make this one conflict. choice: { op: 'add'|'replace', key, position, values }.
   */
  async acceptItem(p,choice){
    if(!p.via){   // from a material file: it must still say the same thing
      const {bytes}=take(await this.workspace.readBytes(p.sourcePath));
      if(!await this.sourceMatches(p,bytes)){p.status='STALE';throw Object.assign(Error('The material changed, so this suggestion is out of date. Check again.'),{code:'PROPOSAL_STALE'})}
    }
    const draft=this.editor.draftContent;
    const edited=choice?.values&&typeof choice.values==='object'?cleanValues(choice.values):null;
    const spec={op:(choice?.op??p.op)==='replace'?'replace':'add',key:choice?.key??p.replaceKey??null,position:choice?.position==='start'||choice?.position==='end'?choice.position:p.position||'end',values:{...p.values,...(edited||{})}};
    if(spec.op==='add'&&this.itemOnSite({...p,title:spec.values[(this.site.listCollections(draft).find(c=>c.id===p.collection)||{}).titleField]??p.title},draft)){p.status='ACCEPTED';p.reviewedAt=now();p.appliedPaths=[];return;}
    const built=this.site.buildItem(draft,p.collection,spec);
    if(!built.ok)throw Object.assign(Error('This entry could not be written to the website: '+built.error.message),{code:'ITEM_NOT_POSSIBLE'});
    take(await this.editor.setDraftContent(built.data.content,'item:'+p.collection));
    p.appliedPaths=this.site.diffContent(draft,built.data.content).data.changes.map(c=>c.path);
    p.op=spec.op;p.position=spec.position;if(spec.op==='replace'){p.replacedKey=spec.key;p.replacedTitle=(this.site.listCollections(draft).find(c=>c.id===p.collection)?.items.find(i=>i.key===spec.key)||{}).title;}
    if(edited&&!same({...p.values,...edited},p.values))p.editedValues=spec.values;
    p.status='ACCEPTED';p.reviewedAt=now();
  }
  async decide(proposalId,decision){
    if(decision==='accept')return this.acceptMany([proposalId]);
    if(this.busy||this.editor.busy)return createErr('BUSY','AnalysisEngine','Another task is running.');
    this.busy=true;
    try{
      const next=clone(this.state);const p=next.proposals.find(p=>p.id===proposalId);
      if(p?.status==='CONFLICT')throw Object.assign(Error('This spot was changed elsewhere. Choose to use the suggestion or keep the website as it is.'),{code:'PROPOSAL_CONFLICT'});
      if(!p||p.status!=='PENDING')throw Error('This suggestion no longer exists or was already handled. Check again.');
      if(decision!=='reject')throw Error('Unknown review action.');
      p.status='REJECTED';p.reviewedAt=now();await this.save(next);return createOk({message:'Rejected. It will not come back while the material stays the same.'});
    }catch(e){return this.error(e)}finally{this.busy=false}
  }
  /** Why the owner rejected a suggestion (optional, chosen after rejecting). */
  async setRejectReason(proposalId,reason){
    if(this.busy)return createErr('BUSY','AnalysisEngine','Another task is running.');
    this.busy=true;
    try{
      const next=clone(this.state);const p=next.proposals.find(p=>p.id===proposalId);
      if(!p||p.status!=='REJECTED')throw Error('This suggestion no longer exists or was not rejected.');
      p.rejectReason=String(reason).slice(0,40);await this.save(next);return createOk({proposal:clone(p)});
    }catch(e){return this.error(e)}finally{this.busy=false}
  }
  /**
   * Accepts one or more proposals into the draft, then (with auto-apply) writes them as ONE undo step.
   * Single accept keeps the old error semantics; for batches, failing items are reported and skipped.
   */
  async acceptMany(proposalIds,edits={}){
    if(this.busy||this.editor.busy)return createErr('BUSY','AnalysisEngine','Another task is running.');
    this.busy=true;
    try{
      const next=clone(this.state);const failures=[];let accepted=0;
      for(const pid of proposalIds){
        const p=next.proposals.find(p=>p.id===pid);
        if(p?.status==='CONFLICT'){failures.push({id:pid,code:'PROPOSAL_CONFLICT',message:'This spot was changed elsewhere. Choose to use the suggestion or keep the website as it is.'});continue;}
        if(!p||p.status!=='PENDING'){failures.push({id:pid,message:'This suggestion no longer exists or was already handled. Check again.'});continue;}
        try{
          let finalValue;
          if(p.kind==='item'||p.kind==='code'){await this.acceptInto(p,edits[pid]||null);accepted++;continue;}
          if(Object.hasOwn(edits,pid)&&p.kind!=='asset'){   // user's wording for this card
            const checked=this.site.setFieldValue(this.editor.draftContent,p.field,edits[pid]);
            if(!checked.ok)throw Object.assign(Error(checked.error.message),{code:checked.error.code});
            finalValue=checked.data.value;
          }
          await this.acceptInto(p);
          if(finalValue!==undefined&&!same(finalValue,p.value)){take(await this.editor.editDraftField(p.field,finalValue));p.editedValue=clone(finalValue);}
          if(p.kind!=='asset')await this.syncCopies(p,p.editedValue??p.value,next.proposals);
          accepted++;
        }catch(e){failures.push({id:pid,field:p.field,code:e.code||null,message:e.message});}
      }
      try{await this.save(next)}catch(e){throw Error('The suggestion is in the draft, but the review record could not be saved. Reload to check; accepting the same value again changes nothing.')}
      if(proposalIds.length===1&&failures.length)throw Object.assign(Error(failures[0].message),{code:failures[0].code});
      let applied=false,applyError=null;
      if(accepted&&this.editor.autoApply){
        this.busy=false; // Apply runs its own guard; scan lock is not held here.
        const r=await this.editor.applyDraftToWorkspace({note:accepted===1?(q=>q?.kind==='item'?(q.op==='replace'?'Replace entry: ':'Add entry: ')+q.title:'Accept suggestion: '+(q?.field||''))(next.proposals.find(p=>p.id===proposalIds.find(i=>!failures.some(f=>f.id===i)))):`Accept ${accepted} suggestions`});
        applied=r.ok;applyError=r.ok?null:r.error.message;
      }
      const base=!accepted?'No suggestion was accepted.':applied?(accepted>1?`Accepted ${accepted} suggestions and applied them to the website in one step that can be undone.`:'Applied to the website; it can be undone.')+' Not published yet.'
        :applyError?'Accepted into the draft, but applying it failed: '+applyError:'Accepted into the draft; not applied or published yet.';
      return createOk({applied,accepted,failures,message:base+(failures.length&&proposalIds.length>1?`\n${failures.length} not accepted: `+failures.map(f=>(f.field||f.id)+' - '+f.message).join('; '):'')});
    }catch(e){return this.error(e)}finally{this.busy=false}
  }
  /**
   * Accepts a proposal with the user's own wording. The suggestion keeps its source and reason;
   * the edited value is what gets written. Same conflict/staleness checks as a normal accept.
   */
  async acceptEdited(proposalId,value){
    if(this.busy||this.editor.busy)return createErr('BUSY','AnalysisEngine','Another task is running.');
    this.busy=true;
    try{
      const next=clone(this.state);const p=next.proposals.find(p=>p.id===proposalId);
      if(p?.status==='CONFLICT')throw Object.assign(Error('This spot was changed elsewhere. Choose to use the suggestion or keep the website as it is.'),{code:'PROPOSAL_CONFLICT'});
      if(!p||p.status!=='PENDING')throw Error('This suggestion no longer exists or was already handled. Check again.');
      if(p.kind==='asset')throw Error('A replaced file cannot be edited.');
      if(p.kind==='code'||p.kind==='item')throw Error('This kind of suggestion cannot be edited as text.');
      const checked=this.site.setFieldValue(this.editor.draftContent,p.field,value);
      if(!checked.ok)throw Object.assign(Error(checked.error.message),{code:checked.error.code});
      const finalValue=checked.data.value;
      try{await this.acceptInto(p)}catch(e){await this.save(next);throw e}
      if(!same(finalValue,p.value)){take(await this.editor.editDraftField(p.field,finalValue));p.editedValue=clone(finalValue);}
      await this.syncCopies(p,p.editedValue??p.value,next.proposals);
      try{await this.save(next)}catch(e){throw Error('The change is in the draft, but the review record could not be saved. Reload to check.')}
      let applied=false,applyError=null;
      if(this.editor.autoApply){
        this.busy=false;
        const r=await this.editor.applyDraftToWorkspace({note:(p.editedValue!==undefined?'Accept edited suggestion: ':'Accept suggestion: ')+p.field});
        applied=r.ok;applyError=r.ok?null:r.error.message;
      }
      return createOk({applied,edited:p.editedValue!==undefined,message:applied?'Written to the website as you edited it; it can be undone. Not published yet.':applyError?'Accepted into the draft, but applying it failed: '+applyError:'Accepted into the draft.'});
    }catch(e){return this.error(e)}finally{this.busy=false}
  }
  /**
   * Way out of a CONFLICT or STALE card.
   *  - 'dismiss'   : keep the website as it is; the card goes away.
   *  - 'overwrite' : (CONFLICT, text only) the user explicitly chooses the suggested value over the current one.
   *  - 'retry'     : dismiss, then analyze again against the current files (done by the caller).
   */
  async resolve(proposalId,action){
    if(this.busy||this.editor.busy)return createErr('BUSY','AnalysisEngine','Another task is running.');
    this.busy=true;
    try{
      const next=clone(this.state);const p=next.proposals.find(p=>p.id===proposalId);
      if(!p||!['CONFLICT','STALE'].includes(p.status))throw Error('This suggestion needs nothing.');
      if(action==='dismiss'||action==='retry'){p.status='DISMISSED';p.reviewedAt=now();await this.save(next);return createOk({action});}
      if(action!=='overwrite'||p.status!=='CONFLICT'||p.kind==='asset'||p.kind==='code'||p.kind==='item')throw Error('That action is not supported.');
      if(this.editor.isFieldLocked?.(p.field))throw Error('This field is locked.');
      take(await this.editor.editDraftField(p.field,p.value));
      p.status='ACCEPTED';p.overrode=true;p.reviewedAt=now();
      await this.save(next);
      let applied=false;
      if(this.editor.autoApply){this.busy=false;const r=await this.editor.applyDraftToWorkspace({note:'Overwrite with suggestion: '+p.field});applied=r.ok;if(!r.ok)throw Error(r.error.message);}
      return createOk({action,applied});
    }catch(e){return this.error(e)}finally{this.busy=false}
  }
  /**
   * A suggestion submitted directly by an outside agent (MCP) or by the chat. It goes into the same review queue;
   * nothing is written until it is accepted. Evidence is the agent's stated reason (or the user's chat message).
   */
  async proposeDirect({field,value,reason,kind='agent',client='agent',quote=''}){
    if(this.busy||this.editor.busy)return createErr('BUSY','AnalysisEngine','Another task is running.');
    this.busy=true;
    try{
      if(typeof field!=='string'||!this.site.listEditableFields(this.editor.liveContent).some(f=>f.path===field))throw Object.assign(Error('Unknown field: '+field),{code:'FIELD_NOT_EDITABLE'});
      if(this.editor.isFieldLocked?.(field))throw Object.assign(Error('This field is locked: '+field),{code:'FIELD_LOCKED'});
      if(typeof reason!=='string'||!reason.trim())throw Object.assign(Error('A reason for the change is needed.'),{code:'FIELD_VALIDATION_FAILED'});
      const checked=this.site.setFieldValue(this.editor.liveContent,field,value);
      if(!checked.ok)throw Object.assign(Error(checked.error.message),{code:checked.error.code});
      const before=take(this.site.getFieldValue(this.editor.liveContent,field)).value;
      if(same(before,checked.data.value))throw Object.assign(Error('The website already says this.'),{code:'NO_CHANGE'});
      const next=clone(this.state);
      // One open suggestion per field from the same client: a newer one replaces it.
      next.proposals=next.proposals.filter(p=>!(p.status==='PENDING'&&p.kind===kind&&p.field===field&&p.client===client));
      const proposal={id:id(),kind,client,signature:await sha256([kind,client,field,checked.data.value]),sourcePath:kind+':'+client,field,
        before:clone(before),value:clone(checked.data.value),quote:String(quote||'').slice(0,2000),reason:reason.slice(0,3000),
        status:'PENDING',provider:kind+':'+client,isMock:false,createdAt:now()};
      next.proposals.push(proposal);
      await this.save(next);
      return createOk({proposal});
    }catch(e){return this.error(e)}finally{this.busy=false}
  }
  /**
   * A new item (or a replacement for one item) requested in the chat or by an outside agent. Same review card as
   * items found in materials; the evidence is the request itself. Values are checked by the website's list shape.
   */
  async proposeDirectItem({collection,values,position='end',replace=null,reason,kind='chat',client='you',quote=''}){
    if(this.busy||this.editor.busy)return createErr('BUSY','AnalysisEngine','Another task is running.');
    this.busy=true;
    try{
      const content=this.editor.liveContent,coll=(this.site.listCollections?.(content)||[]).find(c=>c.id===collection);
      if(!coll||!coll.canAdd)throw Object.assign(Error('Entries cannot be added to this list: '+collection),{code:'LIST_NOT_EDITABLE'});
      if(typeof reason!=='string'||!reason.trim())throw Object.assign(Error('A reason is needed.'),{code:'FIELD_VALIDATION_FAILED'});
      const vals=cleanValues(values),fieldNames=new Set(coll.fields.map(f=>f.name));
      const unknown=Object.keys(vals).filter(k=>!fieldNames.has(k));
      if(unknown.length)throw Object.assign(Error(`This list has no field(s) ${unknown.join(', ')} (it has: ${[...fieldNames].join(', ')})`),{code:'FIELD_NOT_EDITABLE'});
      const title=vals[coll.titleField];
      if(!title||Array.isArray(title))throw Object.assign(Error(`A new entry needs "${coll.titleField}".`),{code:'FIELD_VALIDATION_FAILED'});
      let key=null;
      if(replace!=null&&replace!==''){
        const r=String(replace),hit=coll.items.find(i=>i.key===r)||coll.items.find(i=>normTitle(i.title)===normTitle(r));
        if(!hit)throw Object.assign(Error('The entry to replace was not found: '+r),{code:'ITEM_NOT_FOUND'});
        key=hit.key;
      } else if(coll.items.some(i=>normTitle(i.title)===normTitle(title)))throw Object.assign(Error('The website already has this entry: '+title),{code:'NO_CHANGE'});
      const op=key!=null?'replace':'add',pos=position==='start'?'start':'end';
      const built=this.site.buildItem(content,coll.id,{op,key,position:pos,values:vals});
      if(!built.ok)throw Object.assign(Error(built.error.message),{code:built.error.code});
      const next=clone(this.state);
      const proposal={id:id(),kind:'item',via:kind,client,signature:await sha256([kind,client,'item',coll.id,normTitle(title),key]),sourcePath:kind+':'+client,
        field:'item:'+coll.id,collection:coll.id,collectionLabel:coll.label,op,position:pos,...(key!=null?{replaceKey:key,replacedTitle:coll.items.find(i=>i.key===key)?.title}:{}),
        values:vals,title:String(title),missing:built.data.missing,warnings:built.data.warnings,before:null,value:null,
        quote:String(quote||'').slice(0,2000),reason:reason.slice(0,3000),status:'PENDING',provider:kind+':'+client,isMock:false,createdAt:now()};
      next.proposals=next.proposals.filter(x=>!(x.status==='PENDING'&&x.signature===proposal.signature));
      next.proposals.push(proposal);
      await this.save(next);
      return createOk({proposal});
    }catch(e){return this.error(e)}finally{this.busy=false}
  }
  /**
   * A code change (find-and-replace edits to one page or style sheet) written by the chat's model, for what a field
   * or list cannot do. edits may use the tokens of the condensed view the model read (see code-edits.js). Checked
   * here and again when accepted; nothing is written until the owner accepts it.
   */
  async proposeDirectCode({file,edits,summary,reason,kind='chat',client='you',quote=''}){
    if(this.busy||this.editor.busy)return createErr('BUSY','AnalysisEngine','Another task is running.');
    this.busy=true;
    try{
      const files=this.editor.liveContent?.files;
      if(!files||typeof file!=='string'||typeof files[file]!=='string')throw Object.assign(Error('Unknown file: '+file),{code:'CODE_FILE'});
      if(!CODE_FILE.test(file))throw Object.assign(Error('Code changes are only for pages (.html) and style sheets (.css).'),{code:'CODE_FILE'});
      if(typeof summary!=='string'||!summary.trim())throw Object.assign(Error('Say in one sentence what the change does.'),{code:'FIELD_VALIDATION_FAILED'});
      const text=files[file],{map}=condense(text);
      const real=(Array.isArray(edits)?edits:[]).map(e=>({find:expand(e?.find??'',map),replace:expand(e?.replace??'',map)}));
      const after=applyEdits(text,real);checkChange(file,text,after);
      const next=clone(this.state);
      const proposal={id:id(),kind:'code',via:kind,client,signature:await sha256([kind,client,'code',file,JSON.stringify(real)]),sourcePath:kind+':'+client,
        field:'code:'+file,file,edits:real,summary:summary.trim().slice(0,500),words:addedWords(real),before:null,value:null,
        quote:String(quote||'').slice(0,2000),reason:String(reason||summary).slice(0,3000),status:'PENDING',provider:kind+':'+client,isMock:false,createdAt:now()};
      next.proposals=next.proposals.filter(x=>!(x.status==='PENDING'&&x.signature===proposal.signature));
      next.proposals.push(proposal);
      await this.save(next);
      return createOk({proposal});
    }catch(e){return this.error(e)}finally{this.busy=false}
  }
  /** Applies a code card to the draft: the same edits on the file as it is now (other cards may have changed it). */
  async acceptCode(p){
    const draft=this.editor.draftContent,text=draft?.files?.[p.file];
    if(typeof text!=='string')throw Object.assign(Error('The file of this change is no longer on the website: '+p.file),{code:'PROPOSAL_STALE'});
    let after;
    try{after=applyEdits(text,p.edits);checkChange(p.file,text,after)}
    catch(e){if(/^CODE_FIND/.test(e.code||'')){p.status='CONFLICT';p.conflict={baseline:null,current:null,draft:null,proposed:null,code:true};throw Object.assign(Error('This part of the page was changed since the suggestion was made. Ask for it again.'),{code:'PROPOSAL_CONFLICT'})}throw e}
    const next={...draft,files:{...draft.files,[p.file]:after}};
    take(await this.editor.setDraftContent(next,'code:'+p.file));
    p.appliedPaths=this.site.diffContent(draft,next).data?.changes?.map(c=>c.path)||[];
    p.status='ACCEPTED';p.reviewedAt=now();
  }
  /** Lists that can take new items, for the chat and agents. */
  lists(content=this.editor.liveContent){
    return (this.site.listCollections?.(content)||[]).filter(c=>c.canAdd).map(c=>({id:c.id,label:c.label,titleField:c.titleField,
      items:c.items.map(i=>({key:i.key,title:i.title})),fields:c.fields.map(f=>({name:f.name,...(f.label&&f.label!==f.name?{label:f.label}:{}),type:f.type,required:f.required,...(f.choices?{choices:f.choices}:{})}))}));
  }
  /** Stops reporting a deleted source as "needs clarification". */
  async acknowledgeDeletion(path){
    if(this.busy)return createErr(ERROR_CODES.WORKSPACE_IO_ERROR,'AnalysisEngine','Another task is running.');
    try{const next=clone(this.state);next.acknowledgedDeletions=[...new Set([...(next.acknowledgedDeletions||[]),path])];await this.save(next);return createOk({acknowledged:path})}
    catch(e){return this.error(e)}
  }
}
