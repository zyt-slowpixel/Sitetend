// @ts-check
// The chat agent: one runtime, the same tools as the MCP bridge. It can read the site, run an analysis and
// *suggest* changes; suggestions go into the normal review queue (source: the user's chat message).
// Scope: maintaining website content, plus small code changes to a page or style sheet when no field or list fits
// (always reviewed in the live preview). New pages, redesigns and scripts are redirected to a coding tool.
import { msg } from './i18n.mjs';
import { LEXICON, words } from './lexicon.mjs';
import { todayLine } from '../agent/utils.js';
import { resolveKey } from './user-config.mjs';

const MAX_STEPS = 8;   // reading a page, a code change and one retry fit
const langName = code => { try { return code ? new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || 'English' : 'English'; } catch { return 'English'; } };

export const CHAT_TOOLS = [
  { type: 'function', function: { name: 'list_fields', description: 'List the website content fields that can be changed, with current values.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'propose_edit', description: 'Suggest a change to one field. The user reviews it before anything is written.',
    parameters: { type: 'object', required: ['field', 'value', 'reason'], properties: {
      field: { type: 'string', description: 'Field path from list_fields' },
      value: { description: 'New value (string, or array of strings for list fields)', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      reason: { type: 'string', description: 'One sentence explaining the change' } } } } },
  { type: 'function', function: { name: 'list_lists', description: 'List the lists on the website that can take a new item (projects, publications, talks, members, dates…), with their field names and existing items.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'propose_new_item', description: 'Suggest adding a new item to a list (or replacing one existing item). Shaped like the items already there; the user reviews it before anything is written.',
    parameters: { type: 'object', required: ['list', 'values', 'reason'], properties: {
      list: { type: 'string', description: 'List id from list_lists' },
      values: { type: 'object', description: 'Field name -> value, using only field names of that list and only facts the owner gave you. Leave out fields you do not know.', additionalProperties: { type: 'string' } },
      position: { type: 'string', enum: ['start', 'end'], description: 'start if the list is newest-first, otherwise end' },
      replace: { type: 'string', description: 'Optional: key or title of the existing item to replace instead of adding' },
      reason: { type: 'string', description: 'One sentence explaining the change' } } } } },
  { type: 'function', function: { name: 'read_page', description: 'Read a page (.html) or style sheet (.css) of the website before writing a code change. Long scripts, styles and attribute values are shown as tokens like ⟦S3⟧ or ⟦A7⟧; keep them as they are. For long files, give a phrase near the place to change.',
    parameters: { type: 'object', required: ['file'], properties: { file: { type: 'string', description: 'File path, e.g. index.html or p/experience.html' }, phrase: { type: 'string', description: 'Optional: words near the place to change' } } } } },
  { type: 'function', function: { name: 'propose_code_change', description: 'Suggest a small change to the code of one page or style sheet, for what propose_edit and propose_new_item cannot do (a new section, an entry in a list laid out by hand, a small layout fix). The owner sees it in the live preview and accepts or rejects it.',
    parameters: { type: 'object', required: ['file', 'edits', 'summary'], properties: {
      file: { type: 'string' },
      edits: { type: 'array', description: 'Find-and-replace edits. Each "find" is copied exactly from read_page (tokens included) and appears once in the file; "replace" is the new text.', items: { type: 'object', required: ['find', 'replace'], properties: { find: { type: 'string' }, replace: { type: 'string' } } } },
      summary: { type: 'string', description: 'One sentence, in the owner\'s language, saying what changes on the page' } } } } },
  { type: 'function', function: { name: 'check_materials', description: "Analyze changes in the user's materials (resume, profile, project notes) and create suggestions.", parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'list_suggestions', description: 'List suggestions waiting for review.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'remember', description: 'Remember something the owner asks you to keep in mind for the future (a preference about wording or format, or a decision about what the website shows). Only when the owner says so; never for a one-time change.',
    parameters: { type: 'object', required: ['text'], properties: {
      text: { type: 'string', description: "The note, one clear sentence in the owner's language" },
      kind: { type: 'string', enum: ['preference', 'decision'], description: 'preference: how to write (applies to all their websites). decision: what this website shows or leaves out.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Optional: field paths a decision is about' } } } } },
  { type: 'function', function: { name: 'history', description: 'Recent changes to the website.', parameters: { type: 'object', properties: { limit: { type: 'integer' } } } } },
];

function systemPrompt(lang, notes = []) {
  return [
    "You are Sitetend's assistant. You help the owner keep their personal website's content up to date.",
    todayLine(),
    'You can read the website fields, run an analysis of their materials, and SUGGEST edits with propose_edit. You never write files yourself; every suggestion is reviewed by the owner.',
    'You maintain content: change existing text (propose_edit), or add a new entry to a list that already exists on the site, such as a project, paper, talk, member or date (list_lists, then propose_new_item; it can also replace one entry).',
    'When neither fits (a new section on a page, an entry in a list the site lays out by hand, a small layout or style fix), read the page with read_page and suggest a code change with propose_code_change. Keep it small: copy the markup, classes and spacing the page already uses for similar content; change only what is needed; no scripts, event handlers, frames or files from other websites. If an edit is refused, read the page again and fix the edit.',
    'New pages, redesigns, scripts and site settings are out of scope: say that this needs a coding tool and offer what you can do instead.',
    'Never invent facts, numbers or achievements. If something is unclear, ask.',
    'Write website content in the same language as the existing website content.',
    `Reply in the language the owner writes in (if unclear, use ${langName(lang)}). Keep replies short; plain text or simple Markdown (bold, bullet lists) only.`,
    'When the owner asks you to remember something for the future ("from now on…", "always…", "never…", "remember that…"), call remember, then say in one short sentence that you will keep it in mind. They can see and remove what you remember in Settings.',
    ...(notes.length ? ['The owner asked you to remember these (follow them when you write or suggest):', ...notes.map(n => `- [${n.kind}] ${n.text}`)] : []),
  ].join('\n');
}

/** Executes one tool call against the workspace session. Returns a JSON-serialisable result. */
async function runTool(session, name, args, userMessage) {
  switch (name) {
    case 'list_fields': return session.fields().map(f => ({ path: f.path, value: f.value, locked: f.locked || undefined }));
    case 'propose_edit': {
      const r = await session.propose({ field: String(args.field || ''), value: args.value, reason: String(args.reason || ''), kind: 'chat', client: 'you', quote: userMessage });
      return { ok: true, id: r.proposal.id, note: 'Suggestion created; the owner will review it.' };
    }
    case 'list_lists': return session.lists();
    case 'propose_new_item': {
      const r = await session.proposeItem({ collection: String(args.list || ''), values: args.values, position: args.position, replace: args.replace ?? null, reason: String(args.reason || ''), kind: 'chat', client: 'you', quote: userMessage });
      return { ok: true, id: r.proposal.id, missing: r.proposal.missing, note: 'Suggestion created; the owner will review it.' };
    }
    case 'read_page': return session.readPage(String(args.file || ''), String(args.phrase || ''));
    case 'propose_code_change': {
      const r = await session.proposeCode({ file: String(args.file || ''), edits: Array.isArray(args.edits) ? args.edits : [], summary: String(args.summary || ''), kind: 'chat', client: 'you', quote: userMessage });
      return { ok: true, id: r.proposal.id, note: 'Suggestion created; the owner will see it in the preview and decide.' };
    }
    case 'check_materials': return session.check();
    case 'list_suggestions': return session.state().proposals.filter(p => p.status === 'PENDING').map(p => ({ id: p.id, field: p.field, before: p.before, after: p.value, source: p.sourcePath, reason: p.reason }));
    case 'remember': {
      const note = await session.remember({ text: String(args.text || ''), kind: args.kind, fields: args.fields, quote: userMessage });
      return { ok: true, id: note.id, text: note.text, kind: note.kind, existed: note.existed || undefined, note: 'Remembered. The owner can see and remove it in Settings.' };
    }
    case 'history': return session.state().history.slice(0, Math.min(20, args.limit || 8)).map(h => ({ at: h.timestamp, action: h.action, fields: (h.changes || []).map(c => c.path) }));
    default: throw Error(`Unknown tool ${name}`);
  }
}

// ------------------------------------------------------------------ offline rule mode
// Field aliases. English words use word boundaries; CJK has no word boundaries, so it is matched as plain text.
const L = LEXICON.fieldAliases;
const alias = (en, key) => new RegExp(en + (L[key]?.length ? '|' + words(L[key]) : ''), 'i');
const ALIASES = [
  [alias('\\be-?mail\\b|\\bcorreo\\b', 'contact.email'), 'contact.email'], [alias('\\b(job )?title\\b|\\brole\\b|\\bcargo\\b', 'profile.role'), 'profile.role'],
  [alias('\\btagline\\b|\\beslogan\\b', 'profile.tagline'), 'profile.tagline'], [alias('\\blocation\\b|\\bcity\\b|\\bubicaci[oó]n\\b', 'contact.location'), 'contact.location'],
  [/\bgithub\b/i, 'contact.github'], [/\blinkedin\b/i, 'contact.linkedin'], [alias('\\bbadge\\b|\\bstatus\\b', 'profile.badge'), 'profile.badge'],
  [alias('\\babout\\b.*\\b(headline|title)\\b', 'about.headline'), 'about.headline'], [alias('\\bname\\b|\\bnombre\\b', 'profile.name'), 'profile.name'],
];
const RULE_PATTERNS = [
  /(?:change|set|update)\s+(?:my\s+|the\s+)?(.+?)\s+to\s+["“']?(.+?)["”']?\s*\.?$/i,
  ...LEXICON.changePatterns.map(p => new RegExp(p)),
  /(?:cambia|actualiza)\s+(?:mi\s+|el\s+|la\s+)?(.+?)\s+(?:a|por)\s+["“']?(.+?)["”']?\.?$/i,
];
const REMEMBER_PATTERNS = [
  /^(?:please\s+)?remember(?:\s+(?:that|to))?\s*[:,]?\s+(.+)$/i, /^from now on,?\s+(.+)$/i,
  ...(LEXICON.rememberPatterns || []).map(p => new RegExp(p)),
  /^(?:recuerda(?:\s+que)?|de ahora en adelante|a partir de ahora),?\s*[:,]?\s+(.+)$/i,
];
// Replies are interface text: ui/locales/<lang>.json, keys chatRule.done / help / fail.
async function ruleReply(session, message, lang) {
  const T = { done: 'chatRule.done', fail: 'chatRule.fail', help: 'chatRule.help' }; const fill = (key, v) => msg(lang, key, v);
  // "Remember: …" / "From now on …": kept as a note (the offline demo does not use notes, a model does).
  for (const re of REMEMBER_PATTERNS) {
    const m = message.trim().match(re); if (!m) continue;
    const text = (m[1] || '').trim(); if (text.length < 2) break;
    try { const note = await session.remember({ text, kind: 'preference', quote: message }); return { reply: fill('chatRule.remembered', { text: note.text }), proposed: 0, remembered: [{ id: note.id, text: note.text }] }; }
    catch (e) { return { reply: fill(T.fail, { error: e.message }), proposed: 0 }; }
  }
  for (const re of RULE_PATTERNS) {
    const m = message.trim().match(re); if (!m) continue;
    const target = m[1].trim(); const value = m[2].trim();
    const direct = session.fields().find(f => f.path === target);
    const field = direct?.path || ALIASES.find(([re2]) => re2.test(target))?.[1];
    if (!field) break;
    try {
      await session.propose({ field, value, reason: 'Requested in chat.', kind: 'chat', client: 'you', quote: message });
      return { reply: fill(T.done, { label: direct?.label || target, value }), proposed: 1 };   // the owner's own words, not a field path
    } catch (e) { return { reply: fill(T.fail, { error: e.message }), proposed: 0 }; }
  }
  return { reply: msg(lang, T.help), proposed: 0 };
}

// ------------------------------------------------------------------ model mode
async function callModel(profile, key, body, signal) {
  let res, text;
  try {
    res = await fetch(profile.endpoint, { method: 'POST', signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) }, body: JSON.stringify(body) });
    text = await res.text();
  } catch (e) {   // "fetch failed" and friends: say what it means
    if (e.name === 'AbortError') throw Object.assign(Error('The model took too long to answer.'), { code: 'PROVIDER_TIMEOUT' });
    throw Object.assign(Error(`Could not reach the model server (${e.cause?.code || e.message}).`), { code: 'PROVIDER_UNREACHABLE' });
  }
  if (!res.ok) throw Object.assign(Error(`Model returned HTTP ${res.status}`), { code: res.status === 401 || res.status === 403 ? 'PROVIDER_AUTH' : 'PROVIDER_UNAVAILABLE', status: res.status, body: text.slice(0, 500) });
  try { return JSON.parse(text); } catch { throw Object.assign(Error('The model server did not return JSON.'), { code: 'PROVIDER_UNAVAILABLE' }); }
}

/**
 * Runs one chat turn. history: previous [{role:'user'|'assistant', content}]. Returns { reply, proposed, usage }.
 * @param {any} session WorkspaceSession
 */
export async function chatTurn(session, { profile, history, message, lang = 'en', notes = [], onUsage = () => {} }) {
  if (!profile || profile.type === 'rule') return ruleReply(session, message, lang);
  const key = await resolveKey(profile.keyRef);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 120000);
  const messages = [{ role: 'system', content: systemPrompt(lang, notes) }, ...history.slice(-20).map(m => ({ role: m.role, content: m.content })), { role: 'user', content: message }];
  let proposed = 0, useTools = true; const remembered = [];
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      let data;
      try {
        data = await callModel(profile, key, { ...(profile.extraBody || {}), model: profile.model, messages, ...(useTools ? { tools: CHAT_TOOLS, tool_choice: 'auto' } : profile.jsonMode === false ? {} : { response_format: { type: 'json_object' } }) }, controller.signal);
      } catch (e) {
        // Models without tool calling: fall back to a single JSON answer with edits.
        if (useTools && e.status === 400 && /tool/i.test(e.body || '')) {
          useTools = false;
          messages[0] = { role: 'system', content: systemPrompt(lang, notes) + '\nAnswer as JSON: {"reply": string, "edits": [{"field": string, "value": string, "reason": string}], "remember": [string]}. remember: notes to keep for the future, only when the owner asks. Current fields: ' + JSON.stringify(session.fields().map(f => ({ path: f.path, value: f.value }))) };
          step--; continue;
        }
        throw e;
      }
      onUsage(data.usage || null);
      const msg = data.choices?.[0]?.message;
      if (!msg) throw Object.assign(Error('Empty model response'), { code: 'PROVIDER_UNAVAILABLE' });
      if (!useTools) {
        const out = JSON.parse((msg.content || '{}').trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
        for (const e of Array.isArray(out.edits) ? out.edits.slice(0, 10) : []) {
          try { await session.propose({ field: String(e.field), value: e.value, reason: String(e.reason || 'Requested in chat.'), kind: 'chat', client: 'you', quote: message }); proposed++; } catch {}
        }
        for (const t of Array.isArray(out.remember) ? out.remember.slice(0, 3) : []) {
          try { const note = await session.remember({ text: String(t), kind: 'preference', quote: message }); if (!note.existed) remembered.push({ id: note.id, text: note.text }); } catch {}
        }
        return { reply: String(out.reply || ''), proposed, remembered };
      }
      if (!msg.tool_calls?.length) return { reply: msg.content || '', proposed, remembered };
      messages.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
      for (const call of msg.tool_calls) {
        let result;
        try {
          const args = JSON.parse(call.function?.arguments || '{}');
          result = await runTool(session, call.function?.name, args, message);
          if (['propose_edit', 'propose_new_item', 'propose_code_change'].includes(call.function?.name)) proposed++;
          if (call.function?.name === 'remember' && result?.ok && !result.existed) remembered.push({ id: result.id, text: result.text });
        } catch (e) { result = { ok: false, error: e.message, code: e.code }; }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, call.function?.name === 'read_page' ? 64000 : 20000) });   // a page is read whole when it fits
      }
    }
    return { reply: '…', proposed, remembered };
  } finally { clearTimeout(timer); }
}
