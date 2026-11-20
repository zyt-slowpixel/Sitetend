// @ts-check
// A small MCP client (JSON-RPC 2.0) so Sitetend can read the owner's materials from other services - a notes app,
// a drive, a CMS - through their MCP servers. Two transports:
//   - stdio: a command the owner typed (stored only in ~/.sitetend/settings.json), one JSON message per line;
//   - Streamable HTTP: POST to the server's URL; the reply is JSON or a short event stream.
// Only reading is used: resources/list, resources/read, tools/list, and tools/call for tools the owner picked.
import { spawn } from 'node:child_process';

const PROTOCOL = '2025-06-18';
const CLIENT_INFO = { name: 'sitetend', version: '1.0.0' };
const TIMEOUT_MS = 30000;
const MAX_MESSAGE = 32 * 1024 * 1024;

const fail = (code, message) => Object.assign(Error(message), { code });
/** https anywhere; plain http only for this computer or the local network (a key may travel with the request). */
export function checkServerUrl(raw) {
  let u; try { u = new URL(String(raw || '').trim()); } catch { throw fail('BAD_ENDPOINT', 'Not a web address.'); }
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/i.test(u.hostname);
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local)) || u.username || u.password) throw fail('BAD_ENDPOINT', 'Use an https:// address (http:// only for this computer or the local network).');
  return u;
}

export class McpClient {
  /**
   * @param {{ transport: 'stdio'|'http', command?: string, url?: string, token?: string, tokenEnv?: string, cwd?: string }} cfg
   */
  constructor(cfg) { this.cfg = cfg; this.nextId = 1; this.pending = new Map(); this.sessionId = null; this.proc = null; this.serverInfo = null; }

  async connect() {
    if (this.cfg.transport === 'stdio') this._spawn(); else checkServerUrl(this.cfg.url);
    const r = await this.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT_INFO });
    this.serverInfo = r?.serverInfo || null; this.capabilities = r?.capabilities || {};
    await this.notify('notifications/initialized');
    return this;
  }

  // ---- stdio
  _spawn() {
    const command = String(this.cfg.command || '').trim();
    if (!command) throw fail('BAD_COMMAND', 'No command.');
    const env = { ...process.env };
    if (this.cfg.token) env[this.cfg.tokenEnv || 'MCP_TOKEN'] = this.cfg.token;
    // A shell, like a terminal, so "npx -y some-server --flag" works the same on Windows, macOS and Linux.
    const p = spawn(command, { shell: true, cwd: this.cfg.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = p; this.stderr = '';
    let buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', d => {
      buf += d; if (buf.length > MAX_MESSAGE) { this._failAll(fail('MCP_PROTOCOL', 'The server sent too much data.')); p.kill(); return; }
      let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) this._onMessage(line); }
    });
    p.stderr.setEncoding('utf8'); p.stderr.on('data', d => { this.stderr = (this.stderr + d).slice(-2000); });
    p.on('error', e => this._failAll(fail('MCP_START_FAILED', e.message)));
    p.on('exit', code => this._failAll(fail('MCP_START_FAILED', `The server stopped (exit ${code}). ${this.stderr.trim().split('\n').slice(-3).join(' ')}`.trim())));
    p.stdin.on('error', () => {});
  }
  _onMessage(line) {
    let m; try { m = JSON.parse(line); } catch { return; }   // servers sometimes log to stdout; ignore non-JSON lines
    for (const msg of Array.isArray(m) ? m : [m]) this._dispatch(msg);
  }
  _dispatch(msg) {
    if (msg && msg.id != null && (msg.result !== undefined || msg.error) && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id); clearTimeout(timer); this.pending.delete(msg.id);
      if (msg.error) reject(fail('MCP_ERROR', String(msg.error.message || 'The server returned an error.').slice(0, 300))); else resolve(msg.result);
    } else if (msg && msg.method && msg.id != null) {
      // A request from the server (ping, roots/list, sampling…): answer ping, decline the rest.
      this._send(msg.method === 'ping' ? { jsonrpc: '2.0', id: msg.id, result: {} } : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Not supported by Sitetend' } });
    }
  }
  _failAll(err) { for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(err); this.pending.delete(id); } this.dead = err; }
  _send(obj) { if (this.cfg.transport === 'stdio') { if (this.proc?.stdin.writable) this.proc.stdin.write(JSON.stringify(obj) + '\n'); } }

  // ---- HTTP (Streamable HTTP)
  async _post(obj, expectId) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL };
    if (this.cfg.token) headers.Authorization = `Bearer ${this.cfg.token}`;
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      let res;
      try { res = await fetch(this.cfg.url, { method: 'POST', headers, body: JSON.stringify(obj), signal: ctrl.signal, redirect: 'error' }); }
      catch (e) { throw fail(e.name === 'AbortError' ? 'MCP_TIMEOUT' : 'MCP_UNREACHABLE', e.name === 'AbortError' ? 'The server did not answer in time.' : `Could not reach the server: ${e.cause?.code || e.message}`); }
      const sid = res.headers.get('mcp-session-id'); if (sid) this.sessionId = sid;
      if (res.status === 401 || res.status === 403) throw fail('MCP_AUTH', 'The server refused the key (or needs one).');
      if (!res.ok && res.status !== 202) throw fail('MCP_ERROR', `The server answered ${res.status}.`);
      if (expectId == null) { await res.body?.cancel().catch(() => {}); return null; }
      const type = res.headers.get('content-type') || '';
      if (type.includes('text/event-stream')) return await this._readStream(res, expectId);
      const text = await res.text(); if (text.length > MAX_MESSAGE) throw fail('MCP_PROTOCOL', 'The server sent too much data.');
      let m; try { m = JSON.parse(text); } catch { throw fail('MCP_PROTOCOL', 'The server did not answer with MCP.'); }
      const msg = (Array.isArray(m) ? m : [m]).find(x => x.id === expectId);
      if (!msg) throw fail('MCP_PROTOCOL', 'The server did not answer the request.');
      return msg;
    } finally { clearTimeout(timer); }
  }
  async _readStream(res, expectId) {
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '', total = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        total += value.length; if (total > MAX_MESSAGE) throw fail('MCP_PROTOCOL', 'The server sent too much data.');
        buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let i; while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          let m; try { m = JSON.parse(data); } catch { continue; }
          for (const msg of Array.isArray(m) ? m : [m]) {
            if (msg.id === expectId && (msg.result !== undefined || msg.error)) return msg;
            if (msg.method && msg.id != null) await this._post(msg.method === 'ping' ? { jsonrpc: '2.0', id: msg.id, result: {} } : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Not supported by Sitetend' } });
          }
        }
      }
    } finally { reader.cancel().catch(() => {}); }
    throw fail('MCP_PROTOCOL', 'The server did not answer the request.');
  }

  // ---- JSON-RPC
  async request(method, params = {}) {
    if (this.dead) throw this.dead;
    const id = this.nextId++;
    const obj = { jsonrpc: '2.0', id, method, params };
    if (this.cfg.transport === 'http') {
      const msg = await this._post(obj, id);
      if (msg.error) throw fail('MCP_ERROR', String(msg.error.message || 'The server returned an error.').slice(0, 300));
      return msg.result;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(fail('MCP_TIMEOUT', 'The server did not answer in time.')); }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this._send(obj);
    });
  }
  async notify(method, params = {}) {
    const obj = { jsonrpc: '2.0', method, params };
    if (this.cfg.transport === 'http') await this._post(obj, null); else this._send(obj);
  }
  async _paged(method, key, max = 500) {
    const out = []; let cursor;
    for (let i = 0; i < 20 && out.length < max; i++) {
      const r = await this.request(method, cursor ? { cursor } : {});
      out.push(...(r?.[key] || [])); cursor = r?.nextCursor; if (!cursor) break;
    }
    return out.slice(0, max);
  }
  async listResources() { return this.capabilities?.resources ? this._paged('resources/list', 'resources') : []; }
  async listTools() { return this.capabilities?.tools ? this._paged('tools/list', 'tools') : []; }
  readResource(uri) { return this.request('resources/read', { uri }); }
  callTool(name, args = {}) { return this.request('tools/call', { name, arguments: args }); }

  async close() {
    this._failAll(fail('MCP_CLOSED', 'Closed'));
    if (this.proc) {
      try { this.proc.stdin.end(); } catch {}
      const p = this.proc;
      // Through a shell the server is a grandchild (e.g. cmd.exe → npx → node): on Windows end the whole tree.
      setTimeout(() => { if (p.exitCode != null) return; try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true }); else p.kill(); } catch {} }, 500).unref?.();
    }
    if (this.cfg.transport === 'http' && this.sessionId) {
      const headers = { 'Mcp-Session-Id': this.sessionId }; if (this.cfg.token) headers.Authorization = `Bearer ${this.cfg.token}`;
      await fetch(this.cfg.url, { method: 'DELETE', headers, signal: AbortSignal.timeout(3000) }).catch(() => {});
    }
  }
}

/** Connects, runs fn(client), always closes. */
export async function withMcp(cfg, fn) {
  const c = new McpClient(cfg);
  try { await c.connect(); return await fn(c); } finally { await c.close(); }
}
