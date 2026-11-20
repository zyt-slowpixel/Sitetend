// @ts-check
// MCP server over stdio (JSON-RPC 2.0, one message per line) that lets coding agents (Claude Code, Cursor, Codex…)
// use Sitetend. It never touches files itself: every call goes to the running Sitetend host, so writes share the
// host's queue, history and undo. If no host is running, it starts one in the background (no browser window).
//
//   claude mcp add sitetend -- node /path/to/sitetend/bin/sitetend.mjs mcp
import fs from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';
import { hostFile, loadSettings } from '../host/user-config.mjs';

const SERVER_INFO = { name: 'sitetend', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** Tool list. Write tools are listed always; the host refuses them unless the user allowed it. */
export const TOOLS = [
  { name: 'sitetend_status', description: 'Show the open website workspace in Sitetend: pending suggestions, whether the local site is published, undo availability, active AI model.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'sitetend_list_fields', description: 'List the website content fields Sitetend can change, with their current values. Use these paths with sitetend_propose_edit.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'sitetend_check', description: "Analyze changes in the user's materials (resume, profile, project notes) and create sourced update suggestions.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'sitetend_list_suggestions', description: 'List suggestions waiting for review (and conflicts), with source, evidence, reason and before/after values.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'sitetend_propose_edit', description: 'Suggest a change to one website content field. It appears in Sitetend for the user to review; nothing is written until it is accepted. Prefer this over editing website content files directly.',
    inputSchema: { type: 'object', required: ['field', 'value', 'reason'], additionalProperties: false, properties: {
      field: { type: 'string', description: 'Field path from sitetend_list_fields, e.g. "contact.email" or "projects.orbit-dock.summary".' },
      value: { description: 'New value: a string, or an array of strings for list fields.', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      reason: { type: 'string', description: 'Why this change is right, in one or two sentences. Shown to the user.' } } } },
  { name: 'sitetend_list_lists', description: 'List the lists on the website that can take a new item (projects, publications, talks, members…), with field names and existing items. Use with sitetend_propose_item.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'sitetend_propose_item', description: 'Suggest adding a new item to a list on the website (or replacing one item). It is built in the shape of the existing items and appears in Sitetend for the user to review.',
    inputSchema: { type: 'object', required: ['list', 'values', 'reason'], additionalProperties: false, properties: {
      list: { type: 'string', description: 'List id from sitetend_list_lists, e.g. "projects" or "dir:_talks".' },
      values: { type: 'object', description: 'Field name -> value (field names from sitetend_list_lists). Leave out what you do not know.', additionalProperties: { type: 'string' } },
      position: { type: 'string', enum: ['start', 'end'] },
      replace: { type: 'string', description: 'Optional: key or title of the item to replace instead of adding.' },
      reason: { type: 'string', description: 'Why, in one or two sentences. Shown to the user.' } } } },
  { name: 'sitetend_accept', description: 'Accept suggestions by id (written to the local website as one undoable step). Requires the user to allow agent writes.',
    inputSchema: { type: 'object', required: ['ids'], additionalProperties: false, properties: { ids: { type: 'array', items: { type: 'string' }, minItems: 1 } } } },
  { name: 'sitetend_reject', description: 'Reject one suggestion by id. Requires the user to allow agent writes.',
    inputSchema: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string' } } } },
  { name: 'sitetend_undo', description: 'Undo the last change Sitetend made to the website. Requires the user to allow agent writes.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'sitetend_redo', description: 'Redo the last undone change. Requires the user to allow agent writes.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'sitetend_history', description: 'Recent website maintenance history: what changed, when, and who or what made the change.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false } },
];

/** Plain-text summaries keep tool results readable for the agent. */
const fmt = v => v == null ? '-' : Array.isArray(v) ? v.join(', ') : String(v);
const describeSuggestion = p => [
  `- id: ${p.id}  [${p.status}]  ` + (p.kind === 'item' ? `${p.op === 'replace' ? 'replace "' + p.replacedTitle + '" with' : 'new item'} in ${p.collectionLabel}` : `field: ${p.field}`),
  ...(p.kind === 'item' ? [`  values: ${fmt(p.values)}`] : [`  before: ${fmt(p.before)}`, `  after:  ${fmt(p.value)}`]),
  `  source: ${p.sourcePath}${p.quote ? `  evidence: "${String(p.quote).slice(0, 200)}"` : ''}`, `  reason: ${p.reason}`].join('\n');

export class SitetendMcpBridge {
  /** @param {{ workspace?: string|null, startHost?: (opts:any)=>Promise<any>, write?: (s:string)=>void }} opts */
  constructor({ workspace = null, startHost = null, write = s => process.stdout.write(s) } = {}) {
    this.workspace = workspace; this.startHostFn = startHost; this.write = write;
    this.client = 'agent'; this.host = null; this.embedded = null;
  }

  async connect() {
    if (this.host) return this.host;
    try {
      const h = JSON.parse(await fs.readFile(hostFile(), 'utf8'));
      const r = await fetch(`http://127.0.0.1:${h.port}/api/state`, { headers: { 'X-Sitetend-Token': h.token, 'X-Sitetend-Client': `mcp:${this.client}` } });
      if (r.status !== 401) { this.host = h; return h; }
    } catch { /* no running host */ }
    if (!this.startHostFn) throw Object.assign(Error('Sitetend is not running. Start it with: npx sitetend'), { code: 'NO_HOST' });
    const settings = await loadSettings();
    const ws = this.workspace || settings.recentWorkspaces[0] || null;
    this.embedded = await this.startHostFn({ port: 0, workspace: ws, log: s => process.stderr.write(s + '\n') });
    this.host = { port: this.embedded.port, token: this.embedded.token };
    return this.host;
  }

  async call(method, p, body) {
    const h = await this.connect();
    const res = await fetch(`http://127.0.0.1:${h.port}${p}`, { method, body: body ? JSON.stringify(body) : undefined,
      headers: { 'Content-Type': 'application/json', 'X-Sitetend-Token': h.token, 'X-Sitetend-Client': `mcp:${this.client}` } });
    const json = await res.json().catch(() => ({ ok: false, error: { message: res.statusText } }));
    if (!json.ok) throw Object.assign(Error(json.error?.message || 'Request failed'), { code: json.error?.code });
    return json.data;
  }

  async workspaceState() {
    const st = await this.call('GET', '/api/state');
    if (!st.workspace) throw Object.assign(Error('No website is open in Sitetend. Ask the user to open one.'), { code: 'NO_WORKSPACE' });
    return st.workspace;
  }

  /** Runs one tool and returns MCP content. Errors become isError results the agent can read. */
  async runTool(name, args = {}) {
    try {
      const text = await this._tool(name, args || {});
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      const hint = { MCP_DISABLED: 'The user has not enabled agent access. Ask them to turn it on in Sitetend (connection menu → MCP).',
        MCP_READ_ONLY: 'Agent writes are off. Suggest the change with sitetend_propose_edit and let the user accept it in Sitetend.',
        NO_HOST: 'Sitetend is not running.', NO_WORKSPACE: 'No website is open in Sitetend.' }[e.code] || '';
      return { content: [{ type: 'text', text: `Error${e.code ? ` (${e.code})` : ''}: ${e.message}${hint ? `\n${hint}` : ''}` }], isError: true };
    }
  }

  async _tool(name, a) {
    switch (name) {
      case 'sitetend_status': {
        const s = await this.workspaceState();
        const pending = s.proposals.filter(p => p.status === 'PENDING').length;
        return [`Website: ${s.workspace.label} (${s.workspace.root})`, `Pending suggestions: ${pending}`,
          `Published: ${s.published ? (s.liveIsPublished ? 'yes, live = local' : 'local has unpublished changes') : 'never'}`,
          `Undo available: ${s.canUndo ? 'yes' : 'no'}`, `AI model: ${s.model?.label || '-'}`].join('\n');
      }
      case 'sitetend_list_fields': {
        const fields = await this.call('GET', '/api/fields');
        return fields.map(f => `${f.path}${f.locked ? ' (locked)' : ''} = ${fmt(f.value).slice(0, 300)}`).join('\n');
      }
      case 'sitetend_check': {
        const r = await this.call('POST', '/api/check', {});
        return `Analysis done. Pending suggestions: ${r.pending}. Use sitetend_list_suggestions to see them.`;
      }
      case 'sitetend_list_suggestions': {
        const s = await this.workspaceState();
        const open = s.proposals.filter(p => ['PENDING', 'CONFLICT', 'STALE'].includes(p.status));
        return open.length ? open.map(describeSuggestion).join('\n') : 'No suggestions waiting for review.';
      }
      case 'sitetend_propose_edit': {
        const r = await this.call('POST', '/api/proposals/propose', { field: a.field, value: a.value, reason: a.reason });
        return `Suggestion created (id ${r.proposal.id}). It is waiting for the user's review in Sitetend; nothing has been written yet.`;
      }
      case 'sitetend_list_lists': {
        const lists = await this.call('GET', '/api/lists');
        return lists.length ? lists.map(l => `${l.id} - ${l.label}\n  fields: ${l.fields.map(f => f.name + (f.required ? '*' : '') + (f.choices ? ` (one of: ${f.choices.join(' / ')})` : '')).join(', ')}\n  items: ${l.items.map(i => i.title).join(' | ').slice(0, 400)}`).join('\n') : 'This website has no lists that can take new items.';
      }
      case 'sitetend_propose_item': {
        const r = await this.call('POST', '/api/proposals/propose-item', { collection: a.list, values: a.values, position: a.position, replace: a.replace, reason: a.reason });
        return `Suggestion created (id ${r.proposal.id}): ${r.proposal.op === 'replace' ? 'replace "' + r.proposal.replacedTitle + '" with' : 'add'} "${r.proposal.title}" in ${r.proposal.collectionLabel}.${r.proposal.missing?.length ? ' Left empty: ' + r.proposal.missing.join(', ') + '.' : ''} It is waiting for the user's review; nothing has been written yet.`;
      }
      case 'sitetend_accept': {
        const r = await this.call('POST', '/api/proposals/accept', { ids: a.ids });
        return `Accepted ${r.accepted}; ${r.failures?.length || 0} skipped.${r.failures?.length ? '\n' + r.failures.map(f => `- ${f.field || f.id}: ${f.code || ''} ${f.message}`).join('\n') : ''} The change can be undone.`;
      }
      case 'sitetend_reject': { await this.call('POST', '/api/proposals/reject', { id: a.id }); return 'Rejected.'; }
      case 'sitetend_undo': { await this.call('POST', '/api/undo', {}); return 'Undone.'; }
      case 'sitetend_redo': { await this.call('POST', '/api/redo', {}); return 'Redone.'; }
      case 'sitetend_history': {
        const s = await this.workspaceState();
        return s.history.slice(0, a.limit || 10).map(h => `${h.timestamp}  ${h.action}  ${(h.changes || []).map(c => `${c.path}${c.origin ? ` (${c.origin}${c.client ? ':' + c.client : ''})` : ''}`).join(', ')}`).join('\n') || 'No history yet.';
      }
      default: throw Object.assign(Error(`Unknown tool: ${name}`), { code: 'UNKNOWN_TOOL' });
    }
  }

  /** Handles one JSON-RPC message; returns the response object (or null for notifications). */
  async handle(msg) {
    const reply = result => ({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid Request');
    const isNotification = msg.id === undefined;
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        this.client = String(msg.params?.clientInfo?.name || 'agent').slice(0, 60);
        return reply({ protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO,
          instructions: 'Sitetend keeps a website in sync with its owner\'s materials. To change website content, use sitetend_propose_edit instead of editing content files; the user reviews every suggestion in Sitetend.' });
      }
      case 'notifications/initialized': case 'notifications/cancelled': return null;
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS });
      case 'tools/call': {
        const name = msg.params?.name;
        if (!TOOLS.some(t => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
        return reply(await this.runTool(name, msg.params?.arguments));
      }
      default: return isNotification ? null : fail(-32601, `Method not found: ${msg.method}`);
    }
  }

  /** Reads newline-delimited JSON-RPC from stdin until it closes. */
  async serve(input = process.stdin) {
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { this.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); continue; }
      const out = await this.handle(msg).catch(e => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: e.message } }));
      if (out && msg.id !== undefined) this.write(JSON.stringify(out) + '\n');
    }
    await this.embedded?.close();
  }
}

export async function runStdioServer({ workspace = null } = {}) {
  // stdout carries the protocol only: route any library logging (e.g. PDF.js warnings) to stderr.
  console.log = (...a) => console.error(...a);
  console.warn = (...a) => console.error(...a);
  const { startHost } = await import('../host/server.mjs');
  const bridge = new SitetendMcpBridge({ workspace: workspace ? path.resolve(workspace) : null, startHost });
  await bridge.serve();
}
