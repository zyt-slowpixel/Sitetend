// The UI scripts are loaded by the browser, so the Node test suites never import them. Parse them here so a
// syntax slip (which leaves the whole page blank) fails `npm test` instead of the next browser session.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const dir = new URL('../ui/', import.meta.url);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sitetend-ui-'));
let count = 0;
try {
  for (const f of (await fs.readdir(dir)).filter(f => f.endsWith('.js'))) {
    const copy = path.join(tmp, f.replace(/\.js$/, '.mjs'));   // ES module syntax, like <script type="module">
    await fs.copyFile(new URL(f, dir), copy);
    if (!(await fs.readFile(copy, 'utf8')).trim()) throw Error(`ui/${f} is empty`);
    try { execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' }); }
    catch (e) { throw Error(`ui/${f} does not parse:\n${String(e.stderr)}`); }
    console.log('✓ ui/' + f + ' parses'); count++;
  }
  for (const f of (await fs.readdir(new URL('locales/', dir))).filter(f => f.endsWith('.json'))) {
    JSON.parse(await fs.readFile(new URL('locales/' + f, dir), 'utf8')); console.log('✓ ui/locales/' + f + ' is valid JSON'); count++;
  }
  const langs = JSON.parse(await fs.readFile(new URL('locales/languages.json', dir), 'utf8'));
  for (const l of langs) await fs.access(new URL(`locales/${l.code}.json`, dir)).catch(() => { throw Error(`languages.json lists ${l.code} but ui/locales/${l.code}.json is missing`); });
  console.log(`✓ ${langs.length} languages listed, each with its file`); count++;
} finally { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
console.log(`${count} UI file checks passed`);
