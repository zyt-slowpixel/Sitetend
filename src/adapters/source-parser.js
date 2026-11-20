import {createOk,createErr,ERROR_CODES} from '../contracts.js';
import {sha256,stable} from '../agent/utils.js';
import {docxText} from './docx-text.js';
import { decodeText } from './text-decode.js';
export function semanticText(text){return text.replace(/<!--[\s\S]*?-->/g,'').replace(/\r\n?/g,'\n').split('\n').map(l=>l.trim()).filter(Boolean).join('\n')}
export class SourceParser {
  constructor({pdfLoader}={}){this.pdfLoader=pdfLoader||(()=>import('../../vendor/pdfjs/build/pdf.mjs'))}
  async parseFile({path,format,rawContent}) {
    let doc;
    try {
      if(format==='json') {
        const text=typeof rawContent==='string'?rawContent:decodeText(rawContent).text;
        const value=JSON.parse(text);
        if(!value||typeof value!=='object')throw Error('A JSON material must be an object or an array.');
        doc={path,format,extractedText:JSON.stringify(value,null,2),structuredData:value,semantic:JSON.stringify(stable(value))};
      } else if(format==='markdown') {
        const text=typeof rawContent==='string'?rawContent:decodeText(rawContent).text;
        const semantic=semanticText(text);if(!semantic)throw Error('No readable text in this material.');
        doc={path,format,extractedText:text,structuredData:null,semantic};
      } else if(format==='docx') {
        if(!(rawContent instanceof Uint8Array))throw Error('Not a valid Word file.');
        const text=docxText(rawContent);if(!semanticText(text))throw Error('No readable text in this material.');
        doc={path,format,extractedText:text,structuredData:null,semantic:semanticText(text)};
      } else if(format==='pdf') {
        if(!(rawContent instanceof Uint8Array)||new TextDecoder().decode(rawContent.slice(0,5))!=='%PDF-')throw Error('Not a valid PDF file.');
        const lib=await this.pdfLoader();
        lib.GlobalWorkerOptions.workerSrc=new URL('../../vendor/pdfjs/build/pdf.worker.mjs',import.meta.url).href;
        const task=lib.getDocument({data:rawContent.slice(),isEvalSupported:false,useSystemFonts:false,verbosity:0,
          cMapUrl:new URL('../../vendor/pdfjs/cmaps/',import.meta.url).href,cMapPacked:true,
          standardFontDataUrl:new URL('../../vendor/pdfjs/standard_fonts/',import.meta.url).href,
          wasmUrl:new URL('../../vendor/pdfjs/wasm/',import.meta.url).href});
        let pdf;
        try {
          pdf=await task.promise;if(pdf.numPages>30)throw Error('PDFs are limited to 30 pages.');
          const lines=[];for(let page=1;page<=pdf.numPages;page++) {
            const p=await pdf.getPage(page);const t=await p.getTextContent();let line='';
            lines.push(`[Page ${page}]`);
            for(const x of t.items){if(typeof x.str!=='string')continue;line+=x.str+' ';if(x.hasEOL){lines.push(line.trim());line=''}}
            if(line.trim())lines.push(line.trim());p.cleanup();
          }
          const text=lines.join('\n');if(text.replace(/\[Page \d+\]/g,'').trim().length<3)throw Error('No text found; scanned PDFs (OCR) are not supported.');
          doc={path,format,extractedText:text,structuredData:null,semantic:semanticText(text)};
        } finally {if(pdf)await pdf.destroy();else await task.destroy()}
      } else throw Error('Unsupported format.');
      if(doc.extractedText.length>60000)throw Error('The text is longer than 60,000 characters. Use a shorter material.');
      doc.contentHash=await sha256(doc.semantic);return createOk(doc);
    }catch(e){return createErr(ERROR_CODES.PARSER_EXTRACTION_FAILED,'SourceParser',`${path}: ${e.message}`,{path,format})}
  }
}
