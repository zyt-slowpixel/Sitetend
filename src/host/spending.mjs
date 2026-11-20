// What the AI models cost this month, and the monthly limit. Estimated from the token counts each reply reports and
// the model's price per million tokens (built-in models come with a price; the user can change it). The provider's
// own bill is what counts; this is a guard so a month can't run away. Kept in ~/.sitetend/usage.json, per month.
import fs from 'node:fs/promises';
import path from 'node:path';
import { userDir, loadSettings } from './user-config.mjs';

const FILE = () => path.join(userDir(), 'usage.json');
export const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;   // the user's own month
const round = x => Math.round(x * 1e6) / 1e6;

async function read() { try { return JSON.parse(await fs.readFile(FILE(), 'utf8')); } catch { return { schemaVersion: 1, months: {} }; } }
let chain = Promise.resolve();   // one write at a time
const write = data => (chain = chain.then(async () => {
  await fs.mkdir(userDir(), { recursive: true, mode: 0o700 });
  const tmp = FILE() + '.tmp'; await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); await fs.rename(tmp, FILE());
}).catch(() => {}));

/** Dollars for one reply's usage at a profile's price (null when the profile has no price). */
export function costOf(profile, u) {
  if (profile?.local || profile?.type === 'rule') return 0;   // runs on this computer: free, and never counted against the limit
  const p = profile?.price; if (!p || !u) return profile?.price ? 0 : null;
  return round(((u.prompt_tokens || 0) * (Number(p.in) || 0) + (u.completion_tokens || 0) * (Number(p.out) || 0)) / 1e6);
}

/** Adds one reply to this month's total. */
export async function record(profile, u) {
  if (!profile || profile.type === 'rule' || !u) return;
  const data = await read(); const m = (data.months[monthKey()] ??= { dollars: 0, calls: 0, unpriced: 0, models: {} });
  const cost = costOf(profile, u);
  const row = (m.models[profile.id] ??= { calls: 0, in: 0, out: 0, dollars: 0 });
  row.calls++; row.in += u.prompt_tokens || 0; row.out += u.completion_tokens || 0;
  m.calls++;
  if (cost == null) m.unpriced++; else { row.dollars = round(row.dollars + cost); m.dollars = round(m.dollars + cost); }
  // keep a year of months
  for (const k of Object.keys(data.months).sort().slice(0, -12)) delete data.months[k];
  await write(data);
}

/** This month so far, and the limit from Settings (0 = no limit). */
export async function status() {
  const [data, s] = await Promise.all([read(), loadSettings()]);
  const m = data.months[monthKey()] || { dollars: 0, calls: 0, unpriced: 0, models: {} };
  const limit = Number(s.monthlyLimit) > 0 ? Number(s.monthlyLimit) : 0;
  return { month: monthKey(), dollars: m.dollars, calls: m.calls, unpriced: m.unpriced, models: m.models, limit, reached: Boolean(limit && m.dollars >= limit) };
}

/** Throws PROVIDER_BUDGET_REACHED when this month's limit is used up. Local and rule models cost nothing and always run. */
export async function guard(profile) {
  if (!profile || profile.type === 'rule' || profile.local) return;
  const st = await status();
  if (st.reached) throw Object.assign(Error(`Monthly limit of $${st.limit} reached ($${st.dollars.toFixed(2)} this month).`), { code: 'PROVIDER_BUDGET_REACHED', spent: st.dollars, limit: st.limit });
}
