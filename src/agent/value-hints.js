/**
 * Site-independent "rule" hints (used by the offline rule mode, and shown to models as guesses).
 * No field names are known in advance. Two signals only:
 *  1. Value tracking: a labelled value in the material changed, and its OLD value is exactly what some website
 *     field shows now -> suggest the NEW value for that field.
 *  2. Matching label: a newly added "Label: value" line whose label equals a field's own key, when the material
 *     clearly belongs to one item (its id or title appears in the material) -> suggest it for that item's field.
 */
const norm=s=>String(s??'').toLowerCase().replace(/\s+/g,' ').trim();
const keyOf=s=>String(s).toLowerCase().replace(/[^a-z0-9À-￿]/g,'');
const clean=s=>String(s).replace(/\*\*/g,'').replace(/`/g,'').trim();

/** label -> {value, quote}; labels that appear twice with different values are ambiguous and dropped. */
export function labelledValues(doc){
  const out=new Map(),bad=new Set();
  const put=(label,value,quote)=>{const k=keyOf(label);if(!k||!value)return;if(out.has(k)&&out.get(k).value!==value)bad.add(k);else out.set(k,{label,value,quote})};
  if(!doc)return out;
  if(doc.format==='json'&&doc.structuredData&&typeof doc.structuredData==='object'){
    const walk=(o,prefix)=>{for(const [k,v] of Object.entries(o)){if(typeof v==='string')put(prefix?prefix+'.'+k:k,v,JSON.stringify(k)+': '+JSON.stringify(v));else if(v&&typeof v==='object'&&!Array.isArray(v))walk(v,prefix?prefix+'.'+k:k)}};
    walk(doc.structuredData,'');
  }else{
    const text=String(doc.extractedText||'').replace(/<!--[\s\S]*?-->/g,m=>' '.repeat(m.length));   // commented-out text is not a fact
    for(const m of text.matchAll(/^[ \t]*(?:[-*][ \t]+)?(?:\*\*)?([^:*\n]{1,40}?)(?:\*\*)?[ \t]*:[ \t]*(.+)$/gm))put(clean(m[1]),clean(m[2]),m[0].trim());
  }
  for(const k of bad)out.delete(k);
  return out;
}

export function valueHints(previousDoc,currentDoc,fields){
  const hints=[],seen=new Set();
  const now=labelledValues(currentDoc),before=labelledValues(previousDoc);
  const text=norm(currentDoc?.extractedText);
  const add=(f,value,quote)=>{if(seen.has(f.path)||!String(currentDoc.extractedText).includes(quote))return;seen.add(f.path);hints.push({targetField:f.path,value,quote})};
  const scalar=fields.filter(f=>typeof f.current==='string'&&f.current.trim());
  // Fields whose own key equals the label, narrowed to the one item this material is about (if several).
  const byKey=label=>{
    const leaf=keyOf(String(label).split('.').at(-1));
    const cands=scalar.filter(f=>keyOf(f.path.split('.').at(-1))===leaf);
    if(cands.length<=1)return cands;
    const mine=cands.filter(f=>f.path.split('.').slice(1,-1).some(seg=>seg.length>2&&!/^\d+$/.test(seg)&&text.includes(norm(seg))));
    return mine.length===1?mine:[];
  };
  for(const [k,cur] of now){
    const old=before.get(k);
    if(old&&old.value===cur.value)continue;
    if(!old&&!previousDoc)continue;            // a brand-new file: nothing to compare with
    const tracked=old?scalar.filter(f=>norm(f.current)===norm(old.value)):[];
    for(const f of tracked.length?tracked:byKey(cur.label))add(f,cur.value,cur.quote);
  }
  return hints;
}

/** The owner's own mappings (Advanced settings): {sourcePath, sourceKey, targetField} for JSON materials. */
export function mappingHints(doc,mappings,fieldPaths){
  const hints=[];
  for(const m of mappings||[]){
    if(m?.sourcePath!==doc?.path||!fieldPaths.has(m.targetField)||doc.format!=='json')continue;
    let v=doc.structuredData;for(const part of String(m.sourceKey).split('.'))v=v?.[part];
    if(v===undefined||v===null)continue;
    const quote=JSON.stringify(v);
    if(String(doc.extractedText).includes(quote))hints.push({targetField:m.targetField,value:v,quote});
  }
  return hints;
}
