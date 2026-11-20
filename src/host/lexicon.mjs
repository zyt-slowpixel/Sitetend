// Loads lexicon.json: words in other languages that Sitetend understands in input.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const LEXICON = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'lexicon.json'), 'utf8'));
/** A regex alternation of the listed words (they may already contain regex syntax). */
export const words = list => (list || []).join('|');
