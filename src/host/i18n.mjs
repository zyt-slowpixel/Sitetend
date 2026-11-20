// Interface text for the few things the host writes itself (tray menu, webhook summaries, rule-demo chat replies).
// The words live in ui/locales/<lang>.json with everything else; English is the fallback.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui', 'locales');
const cache = new Map();
function dict(lang) {
  if (!cache.has(lang)) { try { cache.set(lang, JSON.parse(fs.readFileSync(path.join(DIR, `${String(lang).replace(/[^\w-]/g, '')}.json`), 'utf8'))); } catch { cache.set(lang, {}); } }
  return cache.get(lang);
}
/** The text for `key` in `lang` ({name} filled in; "word(s)" made singular or plural from {n}). */
export function msg(lang, key, vars = {}) {
  let s = String(dict(lang)[key] ?? dict('en')[key] ?? key);
  if (vars.n != null && !isNaN(+vars.n)) s = s.replace(/(\p{L}+)\(s\)/gu, (_, w) => +vars.n === 1 ? w : w + 's');
  return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}
