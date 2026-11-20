// @ts-check
// Webhooks: Sitetend tells another service (Slack, Discord, a home server, an automation tool) when something
// happens - new suggestions, a change written, a publish, a failed build. Payloads carry what happened and counts,
// never the content of the owner's materials or website. Each request is signed with HMAC-SHA256 so the receiver
// can check it came from this Sitetend. Configured only by the owner (not by MCP agents).
import crypto from 'node:crypto';
import { checkServerUrl } from './mcp-client.mjs';
import { msg } from './i18n.mjs';

export const EVENTS = ['suggestions.ready', 'change.applied', 'change.undone', 'site.published', 'site.edited_outside', 'build.failed', 'sources.updated', 'sources.failed', 'analysis.failed'];

// The summary line of each event is interface text: ui/locales/<lang>.json, keys hook.<event>.


/** Which webhook event (if any) a host event stands for, with its counts. */
export function mapEvent(type, data = {}) {
  if (type === 'analysis.completed') return data.errorCode ? { event: 'analysis.failed', data: { code: data.errorCode } } : data.pending ? { event: 'suggestions.ready', data: { n: data.pending } } : null;
  if (type === 'state' && ['accept', 'edit', 'redo'].includes(data.reason)) return { event: 'change.applied', data: {} };
  if (type === 'state' && ['undo', 'revert'].includes(data.reason)) return { event: 'change.undone', data: {} };
  if (type === 'state' && data.reason === 'publish') return { event: 'site.published', data: {} };
  if (type === 'site.external_change' && data.changes) return { event: 'site.edited_outside', data: { n: data.changes } };
  if (type === 'build.failed') return { event: 'build.failed', data: { code: data.code ?? null } };
  if (type === 'sources.synced' && data.failed?.length) return { event: 'sources.failed', data: { sources: data.failed.map(f => f.name).filter(Boolean) } };
  if (type === 'sources.synced' && data.changed) return { event: 'sources.updated', data: { n: data.changed } };
  return null;
}

export const sign = (secret, body) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

export class Webhooks {
  /** @param {{ list: () => Promise<any[]>, secret: (hook:any) => Promise<string>, lang: () => Promise<string> }} deps */
  constructor(deps) { this.deps = deps; this.last = new Map(); }

  async deliver(hook, event, site, data = {}) {
    const lang = await this.deps.lang();
    const summary = msg(lang, 'hook.' + event, { site: site || 'Sitetend', n: data.n ?? '' });
    // "text" is what Slack shows, "content" what Discord shows; other receivers read event/data.
    const body = JSON.stringify({ event, at: new Date().toISOString(), site: { name: site || null }, data, summary, text: summary, content: summary });
    const id = crypto.randomUUID();
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Sitetend-Webhook/1.0', 'X-Sitetend-Event': event, 'X-Sitetend-Delivery': id };
    const secret = await this.deps.secret(hook); if (secret) headers['X-Sitetend-Signature'] = sign(secret, body);
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        checkServerUrl(hook.url);
        const res = await fetch(hook.url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(10000) });
        await res.body?.cancel().catch(() => {});
        result = { at: new Date().toISOString(), event, ok: res.ok, status: res.status };
        if (res.ok || res.status < 500) break;
      } catch (e) { result = { at: new Date().toISOString(), event, ok: false, status: null, error: String(e.cause?.code || e.message).slice(0, 200) }; }
      await new Promise(r => setTimeout(r, 1500));
    }
    this.last.set(hook.id, result);
    return result;
  }

  /** Called for every host event; sends to the hooks that subscribed. Never throws, never waits for the receivers. */
  async onHostEvent(type, data, site) {
    const m = mapEvent(type, data); if (!m) return;
    const hooks = (await this.deps.list().catch(() => [])).filter(h => h.events?.includes(m.event));
    for (const h of hooks) this.deliver(h, m.event, site, m.data).catch(() => {});
  }
}
