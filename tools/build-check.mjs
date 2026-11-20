// Real framework sites, end to end: install, build, accept a change, let Sitetend rebuild, and look for the new
// words on the built page. Needs the internet (npm install), so it runs on the GitHub test machines, not in npm test.
//
//   node tools/build-check.mjs                 # every site below
//   node tools/build-check.mjs eleventy hexo   # only the sites whose name contains one of these words
//
// Exit code 1 if any site fails. Each site is copied to a temporary folder first; eval/sites stays untouched.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.SITETEND_HOME ||= await fs.mkdtemp(path.join(os.tmpdir(), 'st-home-'));
const { WorkspaceSession } = await import('../src/host/workspace-session.mjs');

// Sites whose dependencies install from npm alone. (Hugo and Jekyll need their own programs; Next.js, Gatsby,
// Angular and the old React template are left out because their old templates break with today's packages.)
const SITES = [
  'eval/sites/ext5-eleventy-baseblog',
  'eval/sites/ext5-hexo-starter',
  'eval/sites/ext3-astro-devportfolio',
  'eval/sites/ext7-vite-react',
  'eval/sites/own-vue-studio',
  'eval/sites/own-svelte-band',
];
const only = process.argv.slice(2);
const isDir = async p => (await fs.stat(p).catch(() => null))?.isDirectory();
const chosen = [];   // a word picks sites from the list; an existing folder is checked as it is
for (const w of only) if (await isDir(w)) chosen.push(path.resolve(w)); else chosen.push(...SITES.filter(s => s.includes(w)));
if (!only.length) chosen.push(...SITES);

const sh = (command, cwd, timeout = 600000) => new Promise(resolve =>
  exec(command, { cwd, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
    resolve({ ok: !err, out: (String(stdout) + String(stderr)).trim().split('\n').slice(-15).join('\n') })));
const plain = v => typeof v === 'string' && v.length >= 8 && v.length <= 80 && !/[\n<>{}[\]*_`#|]/.test(v) && /[a-z]{3}/i.test(v);

async function check(rel) {
  const name = path.basename(rel);
  // The full path: Windows gives the temp folder as a short name (C:\Users\RUNNER~1\...), and SvelteKit cannot find
  // its own files when the short and the long spelling of the same folder meet. (fs/promises realpath asks the system.)
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'st-build-')));
  await fs.cp(path.isAbsolute(rel) ? rel : path.join(ROOT, rel), root, { recursive: true, filter: src => !/[\\/](node_modules|\.git)$/.test(src) });
  const log = [];
  const step = (s) => { log.push(s); console.log(`  ${name}: ${s}`); };
  try {
    // The test sites keep the website in website/ (materials in sources/); a plain project has package.json at the top.
    const web = (await fs.stat(path.join(root, 'website', 'package.json')).catch(() => null)) ? path.join(root, 'website') : root;
    step('installing packages');
    const inst = await sh('npm install --no-audit --no-fund --loglevel=error', web);
    if (!inst.ok) return { name, ok: false, why: 'npm install failed\n' + inst.out };
    const events = [];
    const s = await new WorkspaceSession({ root, emit: (t, d) => events.push({ t, d: d && JSON.parse(JSON.stringify(d)) }) }).open();
    try {
      const sug = s.buildSuggestion;
      if (!sug?.command) return { name, ok: false, why: 'Sitetend did not find how this site is built' };
      step(`build found: "${sug.command}" -> ${sug.generated.join(', ')}`);
      s.build = { command: sug.command, generated: sug.generated, running: false, last: null };
      const first = await s.runBuild('first');
      if (!first?.ok) return { name, ok: false, why: 'the first build failed\n' + first?.output };
      const page = await s.builtText();
      if (!page) return { name, ok: false, why: `the build made no pages in ${sug.generated.join(', ')}` };
      // a field whose words are on the built page, so the check after the change means something
      const f = s.fields().find(x => plain(x.value) && page.includes(x.value));
      if (!f) return { name, ok: false, why: 'no field of the site was found on the built page' };
      const value = f.value.replace(/[.!?]*$/, '') + ' and more';
      step(`changing ${f.path}: "${f.value}" -> "${value}"`);
      await s.analysis.proposeDirect({ field: f.path, value, reason: 'build check' });
      await s.accept([s.analysis.state.proposals.find(x => x.status === 'PENDING').id]);
      const act = events.filter(e => e.t === 'activity' && e.d.kind === 'apply').at(-1)?.d;
      const codes = act?.steps.map(x => x.code) || [];
      step(`steps: ${codes.join(' > ')} (${act?.status})`);
      if (act?.status !== 'ok' || !codes.includes('build.done') || !codes.includes('verify.page'))
        return { name, ok: false, why: 'after the change: ' + JSON.stringify(act?.steps?.at(-1)) + '\n' + (s.build.last?.output || '') };
      if (!(await s.builtText()).includes(value)) return { name, ok: false, why: 'the new words are not on the rebuilt page' };
      return { name, ok: true, why: `${sug.command}: rebuilt in ${Math.round((s.build.last?.ms || 0) / 1000)} s, new words on the page` };
    } finally { s.close(); }
  } catch (e) {
    return { name, ok: false, why: e.stack || String(e) };
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

const results = [];
for (const rel of chosen) { console.log(`\n${rel}`); results.push(await check(rel)); }
console.log('\nResults');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.why.split('\n')[0]}` + (r.ok ? '' : '\n' + r.why.split('\n').slice(1).map(l => '      ' + l).join('\n')));
console.log(`\n${results.filter(r => r.ok).length} / ${results.length} sites passed`);
process.exit(results.every(r => r.ok) ? 0 : 1);
