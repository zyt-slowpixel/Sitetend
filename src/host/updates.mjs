// "Is there a newer Sitetend?" One small request to GitHub for the latest release's version number, at most once a
// day. Nothing about the user, their websites or their files is sent. Can be turned off in Settings.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { userDir } from './user-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const APP_VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; } })();
export const RELEASES_PAGE = 'https://github.com/zyt-slowpixel/Sitetend/releases';
const LATEST_URL = 'https://api.github.com/repos/zyt-slowpixel/Sitetend/releases/latest';
const DAY = 24 * 3600 * 1000;

/** 1 if a is newer than b, -1 if older, 0 if the same ("v1.2.0", "1.2", "1.2.0-beta" all work; a pre-release is older). */
export function compareVersions(a, b) {
  const parse = v => { const [main, pre] = String(v || '').trim().replace(/^v/i, '').split('-'); return { n: main.split('.').map(x => parseInt(x, 10) || 0), pre: pre || '' }; };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.n.length, y.n.length, 3); i++) { const d = (x.n[i] || 0) - (y.n[i] || 0); if (d) return Math.sign(d); }
  if (x.pre === y.pre) return 0;
  return !x.pre ? 1 : !y.pre ? -1 : x.pre > y.pre ? 1 : -1;
}

const cacheFile = () => path.join(userDir(), 'update.json');
const readCache = () => { try { return JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch { return null; } };

/**
 * @param {{ force?: boolean, enabled?: boolean }} opts
 * @returns {Promise<{ current: string, latest?: string, newer?: boolean, url?: string, checkedAt?: string, off?: boolean, error?: string }>}
 */
export async function checkForUpdate({ force = false, enabled = true } = {}) {
  const current = APP_VERSION;
  if (!enabled || process.env.SITETEND_NO_UPDATE_CHECK === '1') return { current, off: true };
  const cached = readCache();
  const result = c => ({ current, latest: c.latest, newer: compareVersions(c.latest, current) > 0, url: c.url || RELEASES_PAGE, checkedAt: c.checkedAt });
  if (!force && cached?.latest && Date.now() - Date.parse(cached.checkedAt) < DAY) return result(cached);
  try {
    const res = await fetch(process.env.SITETEND_UPDATE_URL || LATEST_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Sitetend/${current}` }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw Error(`HTTP ${res.status}`);
    const j = await res.json();
    const latest = String(j.tag_name || j.version || '').replace(/^v/i, '');
    if (!/^\d+(\.\d+)*/.test(latest)) throw Error('no version number');
    const url = /^https:\/\/github\.com\//.test(j.html_url || '') ? j.html_url : RELEASES_PAGE;   // only ever link to GitHub
    const c = { latest, url, checkedAt: new Date().toISOString() };
    try { fs.mkdirSync(userDir(), { recursive: true }); fs.writeFileSync(cacheFile(), JSON.stringify(c, null, 2)); } catch {}
    return result(c);
  } catch (e) {
    return cached?.latest ? { ...result(cached), error: 'OFFLINE' } : { current, error: 'OFFLINE' };
  }
}
