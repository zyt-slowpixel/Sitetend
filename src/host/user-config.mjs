// @ts-check
// Per-user data in ~/.sitetend/ (override with SITETEND_HOME): model profiles, keys (.env), settings.
// Keys never leave this module except as an Authorization header to the configured endpoint.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const userDir = () => process.env.SITETEND_HOME || path.join(os.homedir(), '.sitetend');
const file = name => path.join(userDir(), name);

const DEFAULT_MODELS = {
  active: 'rule',
  profiles: [
    { id: 'rule', label: 'Rule demo', type: 'rule' },
    // price: US dollars per million tokens (input, output), for the monthly spending limit. Prices change: the user
    // can edit them in the model menu. keyUrl: where to get a key.
    // Claude through Anthropic's OpenAI-compatible endpoint. It rejects response_format json_object (jsonMode:false;
    // the prompts already ask for JSON and fenced replies are unwrapped) and needs room for its default thinking.
    { id: 'claude', label: 'Claude Sonnet 5.5', type: 'openai-compatible',
      endpoint: 'https://api.anthropic.com/v1/chat/completions', model: 'claude-sonnet-5-5', keyRef: 'SITETEND_KEY_ANTHROPIC',
      jsonMode: false, extraBody: { max_tokens: 16000 }, price: { in: 2, out: 10 }, keyUrl: 'https://platform.claude.com/settings/keys' },
    // The low-cost Claude model (same key). Used for cheap evaluation runs.
    { id: 'claude-haiku', label: 'Claude Haiku 5.5', cheap: true, type: 'openai-compatible',
      endpoint: 'https://api.anthropic.com/v1/chat/completions', model: 'claude-haiku-5-5', keyRef: 'SITETEND_KEY_ANTHROPIC',
      jsonMode: false, extraBody: { max_tokens: 16000 }, price: { in: 0.1, out: 0.5 }, keyUrl: 'https://platform.claude.com/settings/keys' },
    { id: 'openai', label: 'OpenAI GPT-6.1 Terra', type: 'openai-compatible',
      endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-6.1-terra', keyRef: 'SITETEND_KEY_OPENAI',
      jsonMode: true, price: { in: 1, out: 5 }, keyUrl: 'https://platform.openai.com/api-keys' },
    { id: 'openai-luna', label: 'OpenAI GPT-6 Luna', cheap: true, type: 'openai-compatible',
      endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-6-luna', keyRef: 'SITETEND_KEY_OPENAI',
      jsonMode: true, price: { in: 0.1, out: 0.5 }, keyUrl: 'https://platform.openai.com/api-keys' },
    // Gemini through Google's OpenAI-compatible endpoint. Prices of the Flash model rise on 2027-01-01 ($1.50 / $7.50).
    { id: 'gemini', label: 'Gemini 3.8 Flash', type: 'openai-compatible',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-3.8-flash', keyRef: 'SITETEND_KEY_GEMINI',
      jsonMode: false, price: { in: 0.75, out: 3.75 }, keyUrl: 'https://aistudio.google.com/apikey' },
    { id: 'gemini-lite', label: 'Gemini 3.1 Flash-Lite', cheap: true, type: 'openai-compatible',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-3.1-flash-lite', keyRef: 'SITETEND_KEY_GEMINI',
      jsonMode: false, price: { in: 0.25, out: 1.5 }, keyUrl: 'https://aistudio.google.com/apikey' },
    { id: 'ollama', label: 'Ollama', type: 'openai-compatible', local: true,
      endpoint: 'http://127.0.0.1:11434/v1/chat/completions', model: 'llama3.1', keyRef: null, price: { in: 0, out: 0 } },
  ],
};
const DEFAULT_SETTINGS = { language: 'en', recentWorkspaces: [], analyzeDelaySec: 10, reviewer: true, mcp: { enabled: false, allowWrites: false } };

async function readJson(name, fallback) {
  try { return { ...structuredClone(fallback), ...JSON.parse(await fs.readFile(file(name), 'utf8')) }; }
  catch (e) { if (e.code !== 'ENOENT') throw Error(`Could not read ${name}: ${e.message}`); return structuredClone(fallback); }
}
async function writeJson(name, data) {
  await fs.mkdir(userDir(), { recursive: true, mode: 0o700 });
  const tmp = file(name) + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, file(name));
}

/** Saved profiles, plus any built-in profile added in a later version (an existing models.json keeps its own edits). */
export const loadModels = async () => {
  const m = await readJson('models.json', DEFAULT_MODELS);
  const have = new Set(m.profiles.map(p => p.id));
  const missing = DEFAULT_MODELS.profiles.filter(p => !have.has(p.id));
  if (missing.length) { const at = Math.max(0, m.profiles.findIndex(p => p.id === 'ollama')); m.profiles.splice(at === -1 ? m.profiles.length : at, 0, ...structuredClone(missing)); }
  // a built-in profile saved by an older version gets the fields added since (price, key link), never overwriting the user's own
  // a profile that was built in once and no longer is stays, as the user's own (it keeps working and can be removed)
  for (const p of m.profiles) if (!p.custom && p.type !== 'rule' && !DEFAULT_MODELS.profiles.some(d => d.id === p.id)) p.custom = true;
  for (const p of m.profiles) { const def = !p.custom && DEFAULT_MODELS.profiles.find(d => d.id === p.id); if (!def) continue; for (const [k, v] of Object.entries(def)) if (!(k in p)) p[k] = structuredClone(v); p.label = def.label; p.cheap = def.cheap; }   // built-in names follow the app
  return m;
};
export const saveModels = m => writeJson('models.json', m);
export const loadSettings = async () => { const s = await readJson('settings.json', DEFAULT_SETTINGS); s.mcp = { ...DEFAULT_SETTINGS.mcp, ...(s.mcp || {}) }; if (!Number.isFinite(s.analyzeDelaySec)) s.analyzeDelaySec = DEFAULT_SETTINGS.analyzeDelaySec; if (typeof s.reviewer !== 'boolean') s.reviewer = true; return s; };
/** Where a running host can be found by other local processes (the MCP bridge). Private to this user. */
export const hostFile = () => file('host.json');
export const saveSettings = s => writeJson('settings.json', s);

/** Minimal .env reader/writer (KEY=value per line). */
export async function readEnv() {
  let text = '';
  try { text = await fs.readFile(file('.env'), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}
export async function setEnvKey(name, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw Error('Not a valid key name.');
  if (/[\r\n]/.test(value)) throw Error('A key cannot contain line breaks.');
  const env = await readEnv();
  if (value) env[name] = value; else delete env[name];
  await fs.mkdir(userDir(), { recursive: true, mode: 0o700 });
  const body = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  await fs.writeFile(file('.env'), body, { mode: 0o600 });
  await fs.chmod(file('.env'), 0o600).catch(() => {});
}
/** Key for a profile: process env first (CI / one-off runs), then ~/.sitetend/.env. */
export async function resolveKey(keyRef) {
  if (!keyRef) return '';
  return process.env[keyRef] || (await readEnv())[keyRef] || '';
}
