// @ts-check
// The interface languages: ui/locales/languages.json lists them, each with ui/locales/<code>.json beside it.
// Adding a language = a translated copy of en.json + one line in languages.json (missing keys fall back to English).
import fs from 'node:fs';
export const LANGUAGES = JSON.parse(fs.readFileSync(new URL('../../ui/locales/languages.json', import.meta.url), 'utf8'));
export const LANGUAGE_CODES = LANGUAGES.map(l => l.code);
