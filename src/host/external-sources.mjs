// @ts-check
// External materials: content the owner keeps in another service, read through that service's MCP server and saved
// as ordinary materials under sources/external/<source>/, so the normal analysis, privacy rules and history apply.
// The list of sources (and any stdio command) lives only in ~/.sitetend/settings.json, set by the owner in the UI;
// a website folder or an outside agent cannot add one.
import crypto from 'node:crypto';
import { withMcp } from './mcp-client.mjs';
import { resolveKey } from './user-config.mjs';
import { MAX_MATERIAL_BYTES } from './materials.mjs';

export const EXTERNAL_DIR = 'sources/external';
const MAX_ITEMS = 50;
const slug = s => String(s || '').normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60) || 'item';
export const sourceDir = src => `${EXTERNAL_DIR}/${slug(src.name)}`;

/** Clean a source as sent by the UI. Throws on anything that does not make sense. */
export function cleanSource(b, prev = null) {
  const bad = m => Object.assign(Error(m), { code: 'BAD_SOURCE' });
  const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!name) throw bad('A name is needed.');
  const transport = b.transport === 'stdio' ? 'stdio' : 'http';
  const src = { id: prev?.id || 'src-' + crypto.randomBytes(4).toString('hex'), name, transport,
    keyRef: prev?.keyRef || null, interval: [0, 15, 60, 360].includes(Number(b.interval)) ? Number(b.interval) : 0 };
  if (transport === 'stdio') {
    src.command = String(b.command || '').trim().slice(0, 500);
    if (!src.command) throw bad('A command is needed.');
    src.tokenEnv = /^[A-Za-z_][A-Za-z0-9_]{0,60}$/.test(String(b.tokenEnv || '')) ? String(b.tokenEnv) : 'MCP_TOKEN';
  } else {
    src.url = String(b.url || '').trim().slice(0, 500);
    if (!src.url) throw bad('An address is needed.');
  }
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, MAX_ITEMS).map(i => i?.type === 'tool'
    ? { type: 'tool', name: String(i.name || '').slice(0, 120), args: i.args && typeof i.args === 'object' && !Array.isArray(i.args) ? i.args : {}, label: String(i.label || i.name || '').slice(0, 80) }
    : { type: 'resource', uri: String(i?.uri || '').slice(0, 1000), label: String(i?.label || i?.uri || '').slice(0, 80) }).filter(i => i.type === 'tool' ? i.name : i.uri);
  if (JSON.stringify(items).length > 64 * 1024) throw bad('The tool arguments are too large.');
  src.items = items;
  return src;
}

export async function clientConfig(src, cwd, token) {
  return { transport: src.transport, url: src.url, command: src.command, tokenEnv: src.tokenEnv, cwd,
    token: token ?? (src.keyRef ? await resolveKey(src.keyRef) : '') };
}

/** What a server offers (for the owner to pick from). */
export async function discover(cfg) {
  return withMcp(cfg, async c => {
    const [resources, tools] = await Promise.all([c.listResources().catch(() => []), c.listTools().catch(() => [])]);
    return {
      server: c.serverInfo ? { name: String(c.serverInfo.name || ''), version: String(c.serverInfo.version || '') } : null,
      resources: resources.slice(0, 300).map(r => ({ uri: String(r.uri), name: String(r.name || r.title || r.uri).slice(0, 120), description: String(r.description || '').slice(0, 200), mimeType: r.mimeType || null })),
      tools: tools.slice(0, 200).map(t => ({ name: String(t.name), description: String(t.description || '').slice(0, 300),
        readOnly: t.annotations?.readOnlyHint === true, required: Array.isArray(t.inputSchema?.required) ? t.inputSchema.required.map(String) : [],
        properties: Object.keys(t.inputSchema?.properties || {}).slice(0, 20) })),
    };
  });
}

/** One item's content as { ext, bytes }. */
async function fetchItem(c, item) {
  if (item.type === 'tool') {
    const r = await c.callTool(item.name, item.args);
    const text = (r?.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n\n');
    if (r?.isError) throw Object.assign(Error(text.slice(0, 300) || 'The tool reported an error.'), { code: 'MCP_ERROR' });
    if (!text.trim() && r?.structuredContent) return { ext: 'json', bytes: Buffer.from(JSON.stringify(r.structuredContent, null, 2)) };
    return { ext: 'md', bytes: Buffer.from(text) };
  }
  const r = await c.readResource(item.uri);
  const contents = r?.contents || [];
  const pdf = contents.find(x => x.blob && /pdf/i.test(x.mimeType || ''));
  if (pdf) return { ext: 'pdf', bytes: Buffer.from(pdf.blob, 'base64') };
  const texts = contents.filter(x => typeof x.text === 'string');
  if (texts.length === 1 && /json/i.test(texts[0].mimeType || '')) { try { JSON.parse(texts[0].text); return { ext: 'json', bytes: Buffer.from(texts[0].text) }; } catch {} }
  return { ext: 'md', bytes: Buffer.from(texts.map(x => x.text).join('\n\n')) };
}

/**
 * Reads every item of every source and writes what changed into sources/external/. Never throws: each source reports
 * { id, ok, files, changed, error }. Returns the paths that changed.
 * @param {any} ws workspace adapter  @param {any[]} sources  @param {string} cwd
 */
export async function syncSources(ws, sources, cwd) {
  const report = [], changed = [];
  for (const src of sources) {
    const out = { id: src.id, at: new Date().toISOString(), ok: true, files: 0, changed: 0, error: null, code: null };
    try {
      await withMcp(await clientConfig(src, cwd), async c => {
        const used = new Set();
        for (const item of src.items) {
          try {
            const { ext, bytes } = await fetchItem(c, item);
            if (!bytes.length) continue;
            if (bytes.length > MAX_MATERIAL_BYTES) throw Object.assign(Error('Larger than 20 MB.'), { code: 'MATERIAL_TOO_LARGE' });
            let base = slug(item.label || (item.type === 'tool' ? item.name : item.uri.split(/[\/#?]/).filter(Boolean).pop()));
            while (used.has(base)) base += '-2';
            used.add(base);
            const rel = `${sourceDir(src)}/${base}.${ext}`;
            const old = await ws.readBytes(rel);
            out.files++;
            if (old.ok && Buffer.from(old.data.bytes).equals(bytes)) continue;
            const w = await ws.writeBytes(rel, bytes); if (!w.ok) throw Object.assign(Error(w.error.message), { code: w.error.code });
            out.changed++; changed.push(rel);
          } catch (e) { out.ok = false; out.error = `${item.label || item.name || item.uri}: ${e.message}`.slice(0, 300); out.code = e.code || 'MCP_ERROR'; }
        }
      });
    } catch (e) { out.ok = false; out.error = String(e.message).slice(0, 300); out.code = e.code || 'MCP_ERROR'; }
    report.push(out);
  }
  return { report, changed };
}
