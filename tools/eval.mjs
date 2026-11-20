// Sitetend judgment evaluation. Runs every case in eval/cases.json against a fresh demo workspace.
//
//   npm run eval                                   # rule-based Mock provider (baseline)
//   SK_ENDPOINT=https://.../v1/chat/completions SK_MODEL=name SK_API_KEY=... npm run eval
//   node tools/eval.mjs --model openai --json     # use a model + key saved in the Sitetend app
//   node tools/eval.mjs --only email --json         # filter by name, write eval/results/*.json
//
// Prints per-case PASS/FAIL and pass rate per category. Exit code is 0 unless --strict is given.
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {AnalysisEngine} from '../src/agent/analysis-engine.js';
import {SourceParser} from '../src/adapters/source-parser.js';
import {MockModelProvider,OpenAICompatibleProvider} from '../src/adapters/model-provider.js';
import {MemoryBackedWorkspaceAdapter} from '../src/adapters/workspace-adapter.js';
import {SiteKeeperCore} from '../src/core/engine.js';
import {siteAdapterForWorkspace} from '../src/adapters/site-adapters.js';
import {take} from '../src/agent/utils.js';
if(!Promise.try)Promise.try=function(fn,...a){return new Promise(r=>r(fn(...a)))};
if(!globalThis.DOMMatrix)globalThis.DOMMatrix=class DOMMatrix{};
if(!Uint8Array.prototype.toHex)Uint8Array.prototype.toHex=function(){return Buffer.from(this).toString('hex')};

const args=process.argv.slice(2);
const flag=n=>args.includes(n);const opt=n=>{const i=args.indexOf(n);return i>=0?args[i+1]:null};
const root=new URL('../',import.meta.url);
const read=p=>fs.readFileSync(new URL(p,root));
// Case sets: v1 = original 15 cases, hard = harder set added 2026-11-11. --set v1|hard picks one (default: both).
if(!process.env.SITETEND_TODAY)process.env.SITETEND_TODAY='2026-11-13';   // the held-out cases were written on this day
const SETS={v1:'eval/cases.json',hard:'eval/cases-hard.json',academic:'eval/cases-academic.json',multi:'eval/cases-multi.json',items:'eval/cases-items.json',ext2:'eval/cases-ext2.json',ext3:'eval/cases-ext3.json',ext4:'eval/cases-ext4.json',ext5:'eval/cases-ext5.json',ext6:'eval/cases-ext6.json',ext7:'eval/cases-ext7.json'};
const cases=Object.entries(SETS).filter(([k])=>!opt('--set')||opt('--set')===k)
  .flatMap(([k,f])=>fs.existsSync(new URL(f,root))?JSON.parse(read(f)).cases.map(c=>({...c,set:k})):[]);
// --model <id>: use a model saved in the Sitetend app (~/.sitetend/models.json + its key), e.g. --model openai
let provider;
if(opt('--model')){
  const {loadModels,resolveKey}=await import('../src/host/user-config.mjs');
  const m=(await loadModels()).profiles.find(p=>p.id===opt('--model'));
  if(!m||m.type==='rule'){console.error(`No saved model "${opt('--model')}". Saved: ${(await loadModels()).profiles.map(p=>p.id).join(', ')}`);process.exit(2);}
  const apiKey=m.keyRef?await resolveKey(m.keyRef):'';
  if(m.keyRef&&!apiKey){console.error(`No key saved for "${m.id}". Set it in Sitetend (menu next to the logo) first.`);process.exit(2);}
  provider=new OpenAICompatibleProvider({endpoint:m.endpoint,model:m.model||'',apiKey,jsonMode:m.jsonMode!==false});
  console.log(`Model: ${m.label} (${m.model||''})`);
}else provider=process.env.SK_ENDPOINT
  ? new OpenAICompatibleProvider({endpoint:process.env.SK_ENDPOINT,model:process.env.SK_MODEL||'',apiKey:process.env.SK_API_KEY||'',jsonMode:process.env.SK_JSON_MODE!=='0'})
  : new MockModelProvider();

// Each case runs on a fresh copy of its demo website (c.site: "demo-workspace" by default, or "demo-academic").
// Seed = website/content.json + every text source. PDFs come in through initialFiles/writesFile.
// Each case runs on a fresh in-memory copy of its site folder (c.site, default "demo-workspace"): the website's text
// files (content.json, HTML, Markdown, YAML, TOML) and every material file. PDFs are copied as bytes.
const TEXT=/\.(json|html?|md|mdx|markdown|ya?ml|toml|txt|astro|jsx?|tsx?|mjs|vue|svelte|njk|liquid|qmd|php|py)$/i;   // framework projects: components and code files too
const seed=site=>{
  const out={},bin={};
  const walk=dir=>{const d=new URL(`${site}/${dir}/`,root);if(!fs.existsSync(d))return;for(const e of fs.readdirSync(d,{withFileTypes:true})){const rel=`${dir}/${e.name}`;
    if(e.isDirectory())walk(rel);else if(/\.(pdf|docx)$/i.test(rel))bin[rel]=new Uint8Array(read(`${site}/${rel}`));
    else if(TEXT.test(rel)&&!/(^|\/)LICENSE/i.test(rel))out[rel]=rel==='website/content.json'||(rel.startsWith('sources/')&&rel.endsWith('.json'))?JSON.parse(read(`${site}/${rel}`)):read(`${site}/${rel}`).toString('utf8')}};
  walk('website');walk('sources');return {out,bin};
};
/** "~text" in an expectation means "the website field whose current text contains this" (case-insensitive). */
function resolver(adapter,content){
  const fields=adapter.listEditableFields(content).map(f=>({path:f.path,v:(x=>Array.isArray(x)?x.join(' | '):String(x??''))(adapter.getFieldValue(content,f.path).data?.value).toLowerCase()}));
  return key=>{if(!key.startsWith('~'))return [key];const q=key.slice(1).toLowerCase();const hit=fields.filter(f=>f.v.includes(q)).map(f=>f.path);if(!hit.length)throw Error('Selector matched no field: '+key);return hit};
}
function expandExpect(e,resolve,got){
  const pick=k=>{const c=resolve(k);return c.find(p=>p in got)||c[0]};
  const map=o=>o&&Object.fromEntries(Object.entries(o).map(([k,v])=>[pick(k),v]));
  const all=a=>a&&[...new Set(a.flatMap(resolve))];
  return {...e,fields:map(e.fields),contains:map(e.contains),notContains:e.notContains&&Object.fromEntries(Object.entries(e.notContains).flatMap(([k,v])=>resolve(k).map(p=>[p,v]))),
    forbid:all(e.forbid),onlyFields:all(e.onlyFields),fieldsAny:all(e.fieldsAny),acceptField:e.acceptField&&pick(e.acceptField),
    keepsWebsite:map(e.keepsWebsite)};
}
const reviewer=!flag('--no-review');
// --reviewer-study: the reviewer judges every generated card but nothing is removed; each card is then labelled
// right/wrong from the case's expectations and compared with the reviewer's verdict.
const study=flag('--reviewer-study');
// --study-generator rule: cards come from the offline rule mode (it makes more mistakes), the model only reviews them.
if(study&&opt('--study-generator')==='rule'&&!provider.isMock){
  const real=provider,rule=new MockModelProvider();
  provider={providerId:'rule-generator+'+real.providerId+'-reviewer',isMock:false,
    analyzeSourceDiff:r=>rule.analyzeSourceDiff(r),reviewProposals:r=>real.reviewProposals(r)};
}

// Token count for the whole run (shown at the end), so the cost of one run can be checked against the provider's dashboard.
const usage={calls:0,prompt:0,completion:0,total:0};
if(!provider.isMock)for(const m of ['analyzeSourceDiff','locateFields','reviewProposals'])if(provider[m]){const f=provider[m].bind(provider);provider[m]=async r=>{const res=await f(r);usage.calls++;const u=res.ok?res.data._usage:null;if(u){usage.prompt+=u.prompt_tokens||0;usage.completion+=u.completion_tokens||0;usage.total+=u.total_tokens||0}return res}}
/** Is this single card right or wrong according to the case? 'unknown' when the case says nothing about it. */
function labelCard(e,field,value,txt){
  const v=txt(value);
  if(e.noProposals||(e.forbid||[]).includes(field))return 'wrong';
  if((e.forbidText||[]).some(x=>v.includes(x.toLowerCase())))return 'wrong';
  if((e.notContains?.[field]||[]).some(x=>v.includes(x.toLowerCase())))return 'wrong';
  if(e.onlyFields&&!e.onlyFields.includes(field))return 'wrong';
  if(e.fields&&field in e.fields)return JSON.stringify(e.fields[field])===JSON.stringify(value)?'right':'wrong';
  if(e.contains?.[field])return e.contains[field].every(x=>v.includes(x.toLowerCase()))?'right':'wrong';
  if((e.fieldsAny||[]).includes(field))return 'right';
  if(e.acceptField===field)return 'right';
  if(e.onlyFields)return 'right';   // allowed field, no stricter rule
  return 'unknown';
}
async function runCase(c){
  const site=c.site||'demo-workspace';const {out:files,bin}=seed(site);const ws=new MemoryBackedWorkspaceAdapter(files);
  for(const [p,b] of Object.entries(bin))take(await ws.writeBytes(p,b));
  const adapter=await siteAdapterForWorkspace(ws);
  for(const [p,src] of Object.entries(c.initialFiles||{}))take(await ws.writeBytes(p,new Uint8Array(read(src))));
  for(const [p,v] of Object.entries(c.initialWrites||{}))take(await ws.writeText(p,v));   // extra text materials present before the baseline
  const editor=new SiteKeeperCore({workspaceAdapter:ws,siteAdapter:adapter});take(await editor.initializeWorkspace());editor.config.autoApply=false;
  for(const f of c.lock||[])take(await editor.setFieldLock(f,true));
  const engine=new AnalysisEngine({workspaceAdapter:ws,siteAdapter:adapter,editingCore:editor,parser:new SourceParser(),provider});engine.replyLanguage=opt('--lang')||'en';engine.reviewer=reviewer;if(flag('--locate-always'))engine.locateThreshold=0;if(study){engine.reviewer=true;engine.reviewerShadow=true;}
  take(await engine.initialize());take(await engine.scan({baselineOnly:true}));const initialContent=structuredClone(editor.liveContent);
  for(const [p,v] of Object.entries(c.writes||{}))take(typeof v==='string'?await ws.writeText(p,v):await ws.writeJson(p,v));
  for(const [p,src] of Object.entries(c.writesFile||{}))take(await ws.writeBytes(p,new Uint8Array(read(src))));
  const t0=Date.now(),tok0=usage.total;take(await engine.scan());const ms=Date.now()-t0,tokens=usage.total-tok0;
  const allPending=engine.state.proposals.filter(p=>p.status==='PENDING');
  const items=allPending.filter(p=>p.kind==='item'),plainItems=items.filter(p=>p.review?.verdict!=='flag');
  const pending=allPending.filter(p=>p.kind!=='item');
  const results=engine.state.scans[0].results;
  // A flagged card asks the owner to double-check. Positive checks accept it; negative checks (forbid, noProposals…)
  // only count unflagged cards, because a flagged card is the reviewer doing its job.
  const got=Object.fromEntries(pending.map(p=>[p.field,p.value]));
  const flagged=pending.filter(p=>p.review?.verdict==='flag').map(p=>p.field);
  const plain=Object.fromEntries(pending.filter(p=>p.review?.verdict!=='flag').map(p=>[p.field,p.value]));
  const problems=[];let e=c.expect||{};
  try{e=expandExpect(e,resolver(adapter,initialContent),got)}catch(err){problems.push(err.message)}
  for(const [f,v] of Object.entries(e.fields||{}))if(!(f in got))problems.push(`Missing suggestion ${f}`);else if(JSON.stringify(got[f])!==JSON.stringify(v))problems.push(`${f}  wrong value: ${JSON.stringify(got[f])}`);
  if(e.fieldsAny&&!e.fieldsAny.some(f=>f in got))problems.push(`Missing suggestion ${e.fieldsAny.join(' or ')}`);
  for(const f of e.forbid||[])if(f in plain)problems.push(`Must not suggest ${f}=${JSON.stringify(plain[f])}`);
  // Text checks on proposed values (case-insensitive; arrays are joined).
  const txt=v=>(Array.isArray(v)?v.join(' | '):String(v??'')).toLowerCase();
  for(const [f,subs] of Object.entries(e.contains||{})){if(!(f in got)){problems.push(`Missing suggestion ${f}`);continue}for(const x of subs)if(!txt(got[f]).includes(x.toLowerCase()))problems.push(`${f}  should contain "${x}", got: ${JSON.stringify(got[f]).slice(0,120)}`)}
  for(const [f,subs] of Object.entries(e.notContains||{}))if(f in plain)for(const x of subs)if(txt(plain[f]).includes(x.toLowerCase()))problems.push(`${f}  must not contain "${x}"`);
  for(const x of e.forbidText||[])for(const [f,v] of Object.entries(plain))if(txt(v).includes(x.toLowerCase()))problems.push(`Suggestion ${f} contains the forbidden text "${x}"`);
  if(e.onlyFields){const extra=Object.keys(plain).filter(f=>!e.onlyFields.includes(f));if(extra.length)problems.push('Extra changes: '+extra.join(', '))}
  if(e.noProposals&&(Object.keys(plain).length||plainItems.length))problems.push('Expected no suggestion, got: '+[...Object.keys(plain),...plainItems.map(p=>'new '+p.title)].join(', '));
  // New items for a list: { newItem: { collection, values: { field: [substrings] } }, noNewItems, acceptItem }
  if(e.noNewItems&&plainItems.length)problems.push('Expected no new entry, got: '+plainItems.map(p=>`${p.collection}: ${p.title}`).join(', '));
  if(e.newItem){
    const want=e.newItem,it=items.find(p=>p.collection===want.collection||p.collection.includes(want.collection));
    if(!it)problems.push(`Missing new entry (${want.collection})`+(items.length?', got: '+items.map(p=>p.collection).join(', '):''));
    else{
      for(const [f,subs] of Object.entries(want.values||{})){const v=txt(it.values[f]);for(const x of subs)if(!v.includes(x.toLowerCase()))problems.push(`New entry ${f}  should contain "${x}", got: ${JSON.stringify(it.values[f]??null)}`)}
      for(const x of want.forbidText||[])if(txt(Object.values(it.values).flat().join(' ')).includes(x.toLowerCase()))problems.push(`New entry contains the forbidden text "${x}"`);
      if(items.length>(want.max||1))problems.push(`Too many new entries: ${items.length}`);
      if(e.acceptItem){
        const before=take(await editor._readLive()).data,count=c=>(adapter.listCollections(c).find(x=>x.id===it.collection)?.items.length)||0;
        const n0=count(before);
        editor.config.autoApply=true;const r=await engine.acceptMany([it.id]);
        if(!r.ok)problems.push('Accepting the new entry failed: '+r.error.message);
        else{
          const after=take(await editor._readLive()).data;
          if(count(after)!==n0+1)problems.push(`Entry count after accept${count(after)}, expected${n0+1}`);
          take(await editor.undo());
          if(JSON.stringify(take(await editor._readLive()).data)!==JSON.stringify(before))problems.push('The website was not restored after undo');
        }
      }
    }
  }
  if(e.decisionAny&&!results.some(r=>e.decisionAny.includes(r.status)))problems.push('Expected decision  '+e.decisionAny.join('/')+', got  '+results.map(r=>r.status).join('/'));
  if(e.acceptField){
    const p=pending.find(p=>p.field===e.acceptField);
    if(!p)problems.push('Nothing to accept for  '+e.acceptField);
    else{
      let d=take(await editor._readLive()).data;
      for(const [f,v] of Object.entries(c.websiteEditAfterScan||{}))d=take(adapter.setFieldValue(d,resolver(adapter,d)(f)[0],v)).content;
      take(await editor._writeLive(d));
      await engine.decide(p.id,'accept');
      const status=engine.state.proposals.find(x=>x.id===p.id).status;
      if(status!==e.acceptStatus)problems.push(`Status after accept${status}, expected${e.acceptStatus}`);
      const after=take(await editor._readLive()).data;
      for(const [f,v] of Object.entries(e.keepsWebsite||{}))if(take(adapter.getFieldValue(after,f)).value!==v)problems.push(`Website field ${f} was overwritten`);
    }
  }
  const labels=pending.filter(p=>p.kind!=='asset').map(p=>({field:p.field,value:p.value,label:labelCard(e,p.field,p.value,txt),verdict:p.review?.verdict||'none',note:p.review?.note||''}));
  return {set:c.set,name:c.name,category:c.category,labels,pass:!problems.length,problems,proposals:{...got,...Object.fromEntries(items.map(p=>['+'+p.collection,p.values]))},flagged,reviews:pending.filter(p=>p.review).map(p=>({field:p.field,...p.review})),statuses:results.map(r=>r.status),scan:results.map(r=>({path:r.path,status:r.status,message:r.message,rejected:r.rejected})),ms,tokens,
    expects:e.fields||e.contains||e.fieldsAny||e.newItem||e.acceptField?'change':e.noProposals||e.noNewItems||e.forbidText||e.forbid?'nothing':'other',missed:problems.some(p=>p.startsWith('Missing'))};
}

const only=opt('--only');
const siteOpt=opt('--site');
const selected=cases.filter(c=>(!only||c.name.includes(only))&&(!siteOpt||String(c.site||'').includes(siteOpt)));
console.log(`Sitetend eval · provider=${provider.providerId} · reviewer ${reviewer&&!provider.isMock?'on':'off'} · ${selected.length} cases\n`);
const out=[];
// --max-dollars N: stop before the next case once the run has cost N dollars. Prices per 1M tokens:
// --price-in / --price-out, default $2 input and $12 output per million tokens (the model the reported runs used).
const maxDollars=Number(opt('--max-dollars'))||0,priceIn=Number(opt('--price-in'))||2,priceOut=Number(opt('--price-out'))||12;
const spent=()=>(usage.prompt*priceIn+usage.completion*priceOut)/1e6;
let stopped=false;
for(const c of selected){
  if(maxDollars&&!provider.isMock&&spent()>=maxDollars){stopped=true;console.log(`\nSpent $${spent().toFixed(2)}, reached the limit $${maxDollars}, stopping here (${selected.length-out.length} cases not run).`);break}
  let r;try{r=await runCase(c)}catch(err){r={set:c.set,name:c.name,category:c.category,pass:false,problems:['Run error: '+err.message],proposals:{},statuses:[],ms:0}}
  out.push(r);console.log(`${r.pass?'PASS':'FAIL'}  [${r.category}] ${r.name}${r.flagged?.length?'  (⚠ '+r.flagged.join(', ')+')':''}${r.pass?'':'\n      '+r.problems.join('\n      ')}`);
}
const cats=[...new Set(out.map(r=>r.category))];
for(const set of [...new Set(out.map(r=>r.set))]){const xs=out.filter(r=>r.set===set);console.log(`\n[${set}] ${xs.filter(r=>r.pass).length}/${xs.length}`)}
console.log('\n'+cats.map(cat=>{const xs=out.filter(r=>r.category===cat);return `${cat}: ${xs.filter(r=>r.pass).length}/${xs.length}`}).join('   '));
const passed=out.filter(r=>r.pass).length;if(usage.calls)console.log(`Model calls ${usage.calls} · tokens: input ${usage.prompt.toLocaleString()} + output ${usage.completion.toLocaleString()} = ${usage.total.toLocaleString()}`);console.log(`Total ${passed}/${out.length} passed`);if(usage.calls)console.log(`Cost about $${spent().toFixed(2)} (input $${priceIn}, output $${priceOut} per million tokens)`);
if(study){
  const cards=out.flatMap(r=>(r.labels||[]).map(x=>({...x,case:r.name,set:r.set})));
  const t={};for(const x of cards){t[x.label]??={};t[x.label][x.verdict]=(t[x.label][x.verdict]||0)+1;}
  const n=(l,v)=>t[l]?.[v]||0,row=l=>['reject','flag','remind','approve','unreviewed','none'].map(v=>String(n(l,v)).padStart(7)).join('');
  console.log('\n=== Reviewer study (the reviewer only scores, it does not block)===');
  console.log('Cards  '+cards.length+': right  '+cards.filter(x=>x.label==='right').length+' · wrong '+cards.filter(x=>x.label==='wrong').length+' · unknown '+cards.filter(x=>x.label==='unknown').length);
  console.log('             reject  doubt  remind approve unrev.  none');
  for(const [l,name] of [['wrong','wrong suggestion'],['right','right suggestion'],['unknown','unknown          ']])console.log(name+'  '+row(l));
  const wrong=cards.filter(x=>x.label==='wrong'),right=cards.filter(x=>x.label==='right');
  const caught=wrong.filter(x=>x.verdict==='reject'||x.verdict==='flag').length,blocked=wrong.filter(x=>x.verdict==='reject').length;
  const falseRej=right.filter(x=>x.verdict==='reject').length,falseFlag=right.filter(x=>x.verdict==='flag').length;
  const pct=(a,b)=>b?Math.round(a*100/b)+'%':'-';
  console.log(`Wrong suggestions caught (rejected or doubted): ${caught}/${wrong.length}(${pct(caught,wrong.length)}), rejected outright${blocked}`);
  console.log(`Right suggestions hurt: wrongly rejected${falseRej}/${right.length}(${pct(falseRej,right.length)}), extra reminders${falseFlag}/${right.length}(${pct(falseFlag,right.length)})`);
  for(const x of wrong.filter(x=>x.verdict==='approve'))console.log(`  missed: [${x.case}] ${x.field} = ${JSON.stringify(x.value).slice(0,80)}`);
  for(const x of right.filter(x=>x.verdict==='reject'))console.log(`  wrongly rejected: [${x.case}] ${x.field} - ${x.note.slice(0,100)}`);
  const missed=out.filter(r=>r.problems.some(p=>p.startsWith('Missing suggestion'))).map(r=>r.name);
  if(missed.length)console.log('Changes the generator missed (the reviewer could not see them): '+missed.join(', '));
}
if(flag('--json')){fs.mkdirSync(new URL('eval/results/',root),{recursive:true});const f=new URL(`eval/results/${new Date().toISOString().replace(/[:.]/g,'-')}.json`,root);
  fs.writeFileSync(f,JSON.stringify({provider:provider.providerId,model:opt('--model')||null,set:opt('--set')||'all',today:process.env.SITETEND_TODAY,reviewer:reviewer&&!provider.isMock,study,usage,dollars:+spent().toFixed(4),stopped,tag:opt('--tag')||undefined,at:new Date().toISOString(),results:out},null,2));console.log('Results written to  '+fileURLToPath(f))}
if(flag('--strict')&&passed!==out.length)process.exit(1);
