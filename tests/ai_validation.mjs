// Validation + retry rules for model proposals (no network: a scripted fake provider).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import './../src/host/node-polyfills.mjs';
import {AnalysisEngine,compactProposals} from '../src/agent/analysis-engine.js';
import {SourceParser} from '../src/adapters/source-parser.js';
import {MemoryBackedWorkspaceAdapter} from '../src/adapters/workspace-adapter.js';
import {SiteKeeperCore} from '../src/core/engine.js';
import {JsonGenericSiteAdapter} from '../src/adapters/json-generic-adapter.js';
import {take} from '../src/agent/utils.js';
import {OpenAICompatibleProvider} from '../src/adapters/model-provider.js';
const ZH = JSON.parse(fs.readFileSync(new URL('./fixtures/zh-input.json', import.meta.url), 'utf8'));   // Chinese input samples

const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url));
const OD=read('demo-workspace/sources/projects/orbit-dock.md').toString('utf8');
const adapter=new JsonGenericSiteAdapter();
async function run(write,answers,mappings=null,extra={}){
  const ws=new MemoryBackedWorkspaceAdapter({'website/content.json':JSON.parse(read('demo-workspace/website/content.json')),
    'sources/profile.json':JSON.parse(read('demo-workspace/sources/profile.json')),'sources/projects/orbit-dock.md':OD});
  const core=new SiteKeeperCore({workspaceAdapter:ws,siteAdapter:adapter});take(await core.initializeWorkspace());core.config.autoApply=false;if(mappings)core.config.sourceMappings=mappings;
  const calls=[],reviews=[],locates=[];const provider={providerId:'fake',isMock:false,async analyzeSourceDiff(r){calls.push(r);const a=answers[Math.min(calls.length-1,answers.length-1)];return {ok:true,data:typeof a==='function'?a(r):a}},
    ...(extra.review?{async reviewProposals(r){reviews.push(r);return extra.review(r)}}:{}),...(extra.locate?{async locateFields(r){locates.push(r);return extra.locate(r)}}:{})};
  const engine=new AnalysisEngine({workspaceAdapter:ws,siteAdapter:adapter,editingCore:core,parser:new SourceParser(),provider});engine.replyLanguage='zh-Hans';if(extra.threshold!=null)engine.locateThreshold=extra.threshold;if(extra.chunk!=null)engine.locateChunk=extra.chunk;
  take(await engine.initialize());take(await engine.scan({baselineOnly:true}));if(extra.before)extra.before(engine);
  for(const [p,v] of Object.entries(write))take(typeof v==='string'?await ws.writeText(p,v):await ws.writeJson(p,v));
  take(await engine.scan());
  return {calls,reviews,locates,proposals:engine.state.proposals,pending:Object.fromEntries(engine.state.proposals.filter(p=>p.status==='PENDING').map(p=>[p.field,p.value])),scan:engine.state.scans[0].results};
}
const up=(field,value,quote)=>({decision:'UPDATE',summary:'s',proposals:[{targetField:field,value,quote,reason:'r'}]});
let n=0;const test=async(name,fn)=>{await fn();n++;console.log('✓ '+name)};
const CN=OD+ZH.changelogNote;

await test('Short value may keep the site format when its new words come from the source',async()=>{
  const r=await run({'sources/projects/orbit-dock.md':CN},[up('projects.orbit-dock.year','2026 · v1.6',ZH.changelogQuote)]);
  assert.equal(r.pending['projects.orbit-dock.year'],'2026 · v1.6');
});
await test('Abbreviations of source words are allowed (Thu <- Thursdays), short made-up words are not',async()=>{
  const md=OD.replace('2026 · v1.4','2026 · v1.4')+'\nReleased on Thursdays.\n- **Category**: Systems Research\n';
  const r=await run({'sources/projects/orbit-dock.md':md},[up('projects.orbit-dock.category','Systems Research · Thu','Category**: Systems Research')]);
  assert.equal(r.pending['projects.orbit-dock.category'],'Systems Research · Thu');
  const r2=await run({'sources/projects/orbit-dock.md':md},[up('projects.orbit-dock.category','Systems Research · Fri','Category**: Systems Research')]);
  assert.deepEqual(r2.pending,{});
});
await test('Short value with an invented word is rejected (and retried once with the reason)',async()=>{
  const r=await run({'sources/projects/orbit-dock.md':CN},[up('projects.orbit-dock.year','2027 · v1.6',ZH.changelogQuote)]);
  assert.equal(r.calls.length,2);assert.match(r.calls[1].feedback,/2027/);assert.deepEqual(r.pending,{});
});
await test('Retry fixes a quote that was not copied exactly',async()=>{
  const r=await run({'sources/projects/orbit-dock.md':CN},[up('projects.orbit-dock.year','2026 · v1.6','version v1.6'),up('projects.orbit-dock.year','2026 · v1.6','v1.6\uff082026')]);
  assert.equal(r.calls.length,2);assert.match(r.calls[1].feedback,/quote/);assert.equal(r.pending['projects.orbit-dock.year'],'2026 · v1.6');
});
await test('Email that only changed letter case is not a suggestion',async()=>{
  const p=JSON.parse(read('demo-workspace/sources/profile.json'));p.email='Alex.Morgan.Demo@northfield.edu';
  const r=await run({'sources/profile.json':p},[up('contact.email','Alex.Morgan.Demo@northfield.edu','"email": "Alex.Morgan.Demo@northfield.edu"')]);
  assert.deepEqual(r.pending,{});
});
await test('Email must still appear in the source as written',async()=>{
  const p=JSON.parse(read('demo-workspace/sources/profile.json'));p.email='alex.new@northfield.edu';
  const r=await run({'sources/profile.json':p},[up('contact.email','alex.other@northfield.edu','"email": "alex.new@northfield.edu"')]);
  assert.deepEqual(r.pending,{});
});
await test('Reply language and retry feedback reach the request; internal fields are not sent to the model',async()=>{
  const r=await run({'sources/projects/orbit-dock.md':CN},[up('projects.orbit-dock.year','2026 · v1.6',ZH.changelogQuote)]);
  assert.equal(r.calls[0].replyLanguage,'zh-Hans');
  let sent;const p=new OpenAICompatibleProvider({endpoint:'https://x.example/v1/chat/completions',model:'m',fetchImpl:async(u,o)=>{sent=JSON.parse(o.body);return new Response(JSON.stringify({choices:[{message:{content:'{"decision":"NO_UPDATE_NEEDED","summary":"","proposals":[]}'}}]}))}});
  take(await p.analyzeSourceDiff({source:{path:'a'},replyLanguage:'zh-Hans',feedback:'fix it'}));
  assert.match(sent.messages[0].content,/Simplified Chinese/);assert.equal(sent.messages.at(-1).content,'fix it');assert.ok(!sent.messages[1].content.includes('replyLanguage'));
});
await test('Temporary model errors (network, 429, 5xx) are retried; configuration errors are not',async()=>{
  const ok=()=>new Response(JSON.stringify({choices:[{message:{content:'{"decision":"NO_UPDATE_NEEDED","summary":"","proposals":[]}'}}]}));
  const mk=steps=>{let k=0;const p=new OpenAICompatibleProvider({endpoint:'https://x.example/v1/chat/completions',model:'m',fetchImpl:async()=>{const s=steps[k++];if(s==='net')throw new TypeError('fetch failed');return typeof s==='number'?new Response('busy',{status:s}):ok()}});p.retryDelays=[1,1];return {p,count:()=>k}};
  let t=mk(['net',503,'ok']);assert.equal((await t.p.analyzeSourceDiff({source:{path:'a'}})).ok,true);assert.equal(t.count(),3);
  t=mk([429,429,429,'ok']);assert.equal((await t.p.analyzeSourceDiff({source:{path:'a'}})).ok,false);assert.equal(t.count(),3,'gives up after two retries');
  t=mk([401,'ok']);const r=await t.p.analyzeSourceDiff({source:{path:'a'}});assert.equal(r.ok,false);assert.equal(t.count(),1,'a wrong key is not retried');assert.match(r.error.message,/401/);assert.equal(r.error.code,'PROVIDER_AUTH');
  t=mk(['net','net','net']);const down=await t.p.analyzeSourceDiff({source:{path:'a'}});assert.equal(down.ok,false);assert.equal(down.error.code,'PROVIDER_UNREACHABLE','network failure keeps its own code');
});
await test('Claude profile: no json_object response_format, extra body fields (max_tokens) are sent, fenced JSON is read',async()=>{
  let sent;const p=new OpenAICompatibleProvider({endpoint:'https://api.anthropic.com/v1/chat/completions',model:'claude-sonnet-5-5',apiKey:'k',jsonMode:false,extraBody:{max_tokens:16000},
    fetchImpl:async(u,o)=>{sent=JSON.parse(o.body);return new Response(JSON.stringify({choices:[{message:{content:'```json\n{"decision":"NO_UPDATE_NEEDED","summary":"","proposals":[]}\n```'}}]}))}});
  const r=await p.analyzeSourceDiff({source:{path:'a'}});assert.equal(r.ok,true);
  assert.equal(sent.response_format,undefined);assert.equal(sent.max_tokens,16000);assert.equal(sent.model,'claude-sonnet-5-5');
});
await test('Unparsable model JSON is retried once',async()=>{
  let k=0;const p=new OpenAICompatibleProvider({endpoint:'https://x.example/v1/chat/completions',model:'m',fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:k++?'```json\n{"decision":"NO_UPDATE_NEEDED","summary":"","proposals":[]}\n```':'Sure! Here you go'}}]}))});
  const r=await p.analyzeSourceDiff({source:{path:'a'}});assert.equal(r.ok,true);assert.equal(k,2);
});
await test("A field mapped by the owner only changes from that file; other usual sources are only a hint",async()=>{
  const history=e=>e.state.proposals.push({id:'old',field:'contact.email',sourcePath:'sources/profile.json',status:'ACCEPTED',value:'x@y.z'});
  const r=await run({'sources/projects/orbit-dock.md':OD+'\nContact: alex.new@northfield.edu\n'},[up('contact.email','alex.new@northfield.edu','Contact: alex.new@northfield.edu')],null,{before:history});
  assert.equal(r.calls[0].fields.find(f=>f.path==='contact.email').usualSource,'sources/profile.json');   // learned from accepted history
  assert.equal(r.proposals.find(p=>p.status==='PENDING').crossSource[0],'sources/profile.json');
  assert.equal(r.pending['contact.email'],'alex.new@northfield.edu');   // not blocked: the reviewer decides
  const r2=await run({'sources/projects/orbit-dock.md':OD+'\nContact: alex.new@northfield.edu\n'},[up('contact.email','alex.new@northfield.edu','Contact: alex.new@northfield.edu')],[{sourcePath:'sources/profile.json',sourceKey:'email',targetField:'contact.email'}]);
  assert.deepEqual(r2.pending,{});assert.match(r2.calls[1].feedback,/mapped this field to sources\/profile.json/);
});
const P2=JSON.parse(read('demo-workspace/sources/profile.json'));
const twoChanges={...P2,email:'alex.new@northfield.edu',github:'https://github.com/alex-morgan'};
const both={decision:'UPDATE',summary:'s',proposals:[{targetField:'contact.email',value:'alex.new@northfield.edu',quote:'"email": "alex.new@northfield.edu"',reason:'r'},{targetField:'contact.github',value:'https://github.com/alex-morgan',quote:'"github": "https://github.com/alex-morgan"',reason:'r'}]};
await test('Reviewer: reject drops a card (reason logged), flag keeps it with a note, other materials are shown',async()=>{
  const r=await run({'sources/profile.json':twoChanges},[both],null,{review:q=>({ok:true,data:{reviews:[{id:q.proposals[0].id,verdict:'reject',note:'conflicts'},{id:q.proposals[1].id,verdict:'flag',note:'check the org account'}]}})});
  assert.deepEqual(Object.keys(r.pending),['contact.github']);
  assert.equal(r.proposals.find(p=>p.field==='contact.github').review.note,'check the org account');
  assert.match(JSON.stringify(r.scan),/reviewer rejected - conflicts/);
  assert.ok(r.reviews[0].otherMaterials.some(m=>m.path==='sources/projects/orbit-dock.md'));assert.equal(r.reviews[0].replyLanguage,'zh-Hans');
});
await test('Reviewer "remind": the card stays a normal card with a gentle note (another material is outdated)',async()=>{
  const r=await run({'sources/profile.json':twoChanges},[both],null,{review:q=>({ok:true,data:{reviews:q.proposals.map(p=>({id:p.id,verdict:'remind',note:'resume still old'}))}})});
  assert.equal(Object.keys(r.pending).length,2);assert.ok(r.proposals.filter(p=>p.status==='PENDING').every(p=>p.review.verdict==='remind'));
});
await test('Reviewer unreachable: cards are kept and marked as not reviewed',async()=>{
  const r=await run({'sources/profile.json':twoChanges},[both],null,{review:()=>({ok:false,error:{message:'down'}})});
  assert.equal(Object.keys(r.pending).length,2);assert.ok(r.proposals.every(p=>p.status!=='PENDING'||p.review.verdict==='unreviewed'));
});
await test('Missing verdict counts as "flag", never as approval',async()=>{
  const r=await run({'sources/profile.json':twoChanges},[both],null,{review:()=>({ok:true,data:{reviews:[]}})});
  assert.ok(r.proposals.filter(p=>p.status==='PENDING').every(p=>p.review.verdict==='flag'));
});
await test('Locate step narrows the fields sent to the generator on large sites (falls back to all on failure)',async()=>{
  const r=await run({'sources/profile.json':twoChanges},[both],null,{threshold:0,locate:()=>({ok:true,data:{paths:['contact.email','contact.github']}})});
  assert.deepEqual(r.calls[0].fields.map(f=>f.path),['contact.email','contact.github']);assert.ok(r.locates[0].fields.length>10);
  const r2=await run({'sources/profile.json':twoChanges},[both],null,{threshold:0,locate:()=>({ok:false,error:{message:'x'}})});
  assert.ok(r2.calls[0].fields.length>10);
  const r3=await run({'sources/profile.json':twoChanges},[both],null,{locate:()=>{throw Error('should not be called on a small site')}});
  assert.equal(r3.locates.length,0);
});
await test('Locate step sends a large field list in parts and joins the answers',async()=>{
  const r=await run({'sources/profile.json':twoChanges},[both],null,{threshold:0,chunk:400,locate:q=>({ok:true,data:{paths:q.fields.map(f=>f.path).filter(p=>['contact.email','contact.github'].includes(p))}})});
  assert.ok(r.locates.length>2);assert.ok(r.locates.every(q=>JSON.stringify(q.fields).length<=400+300));
  assert.equal(new Set(r.locates.flatMap(q=>q.fields.map(f=>f.path))).size,r.locates.reduce((n,q)=>n+q.fields.length,0));   // each field sent once
  assert.deepEqual(r.calls[0].fields.map(f=>f.path).sort(),['contact.email','contact.github']);
});
await test('Old decided suggestions are trimmed; open ones and the latest accepted one per field stay',async()=>{
  const list=[{id:'old',status:'ACCEPTED',field:'contact.email'},...Array.from({length:400},(_,i)=>({id:'r'+i,status:'REJECTED',field:'f'+i})),{id:'open',status:'PENDING',field:'x'},{id:'c',status:'CONFLICT',field:'y'}];
  const out=compactProposals({proposals:list}).proposals.map(p=>p.id);
  assert.ok(out.includes('old')&&out.includes('open')&&out.includes('c'));assert.equal(out.length,303);assert.ok(!out.includes('r0')&&out.includes('r399'));
});
await test('Plain .txt materials are read like Markdown',async()=>{
  const r=await run({'sources/notes.txt':'Teaching\nWinter 2027: INFO 501\n'},[{decision:'NO_UPDATE_NEEDED',summary:'',proposals:[]}]);
  assert.ok(r.calls.some(c=>c.source.path==='sources/notes.txt'));
});
await test('The model is told today\'s date and time zone from this computer (pinned by SITETEND_TODAY in tests)', async () => {
  const { today, todayLine } = await import('../src/agent/utils.js');
  const was = process.env.SITETEND_TODAY; process.env.SITETEND_TODAY = '2027-01-05';
  try {
    const t = today(); assert.equal(t.date, '2027-01-05'); assert.equal(t.weekday, 'Tuesday'); assert.ok(t.timeZone);
    assert.match(todayLine(), /Today is Tuesday, 2027-01-05/);
    const { OpenAICompatibleProvider } = await import('../src/adapters/model-provider.js');
    let sent = null;
    const p = new OpenAICompatibleProvider({ endpoint: 'https://example.invalid/v1/chat/completions', model: 'm', fetchImpl: async (u, o) => { sent = JSON.parse(o.body); return new Response(JSON.stringify({ choices: [{ message: { content: '{"decision":"NO_UPDATE_NEEDED","summary":"","proposals":[]}' } }] }), { status: 200 }); } });
    await p.analyzeSourceDiff({ source: { path: 'a.md', extractedText: 'x' }, previousText: null, fields: [] });
    assert.match(sent.messages[0].content, /Today is Tuesday, 2027-01-05/);
  } finally { if (was === undefined) delete process.env.SITETEND_TODAY; else process.env.SITETEND_TODAY = was; }
});
console.log(`${n} AI validation checks passed`);
