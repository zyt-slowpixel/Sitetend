#!/usr/bin/env node
// Usage: sitetend [website-folder] [--port 54321] [--no-open]
//        sitetend --launch [--no-browser]   what the desktop shortcut runs: opens the running Sitetend, or starts it in
//                                           the background (no console window) and then opens it
//        sitetend mcp [folder]              MCP server over stdio for coding agents
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const positional = args.filter((a, i) => !a.startsWith('--') && !['--port'].includes(args[i - 1]));
const [maj] = process.versions.node.split('.').map(Number);
if (maj < 22) { console.error(`Sitetend needs Node 22 or newer (you have ${process.versions.node}).`); process.exit(1); }

// `sitetend mcp [folder]`: MCP server over stdio for coding agents (no browser, protocol on stdout only).
if (args[0] === 'mcp') {
  const { runStdioServer } = await import('../src/mcp/stdio-bridge.mjs');
  await runStdioServer({ workspace: args[1] && !args[1].startsWith('--') ? args[1] : null });
  process.exit(0);
}
const { hostFile, loadSettings, userDir } = await import('../src/host/user-config.mjs');
const { openBrowser, startTray } = await import('../src/host/desktop.mjs');

/** The Sitetend already running for this user, if any (one per user, so double-clicking twice opens the same one). */
async function runningHost() {
  try {
    const h = JSON.parse(await fs.readFile(hostFile(), 'utf8'));
    const r = await fetch(`http://127.0.0.1:${h.port}/api/ping`, { headers: { 'X-Sitetend-Token': h.token }, signal: AbortSignal.timeout(1500) });
    if (r.ok) return { ...h, url: `http://127.0.0.1:${h.port}/?t=${h.token}` };
  } catch {}
  return null;
}

if (flag('--launch')) {
  let h = await runningHost();
  if (!h) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--background', ...positional], { detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(path.dirname(fileURLToPath(import.meta.url))) });
    child.unref();
    for (let i = 0; i < 100 && !h; i++) { await new Promise(r => setTimeout(r, 200)); h = await runningHost(); }
  }
  if (!h) { console.error(`Sitetend did not start. See ${path.join(userDir(), 'sitetend.log')}`); await new Promise(r => setTimeout(r, 8000)); process.exit(1); }
  if (!flag('--no-browser')) openBrowser(h.url);
  process.exit(0);
}

const background = flag('--background');
if (background) {
  // No console: keep a short log instead.
  await fs.mkdir(userDir(), { recursive: true });
  const logFile = path.join(userDir(), 'sitetend.log');
  const st = await fs.stat(logFile).catch(() => null); if (st && st.size > 1024 * 1024) await fs.rm(logFile, { force: true });
  const write = (...a) => fs.appendFile(logFile, `[${new Date().toISOString()}] ${a.map(String).join(' ')}\n`).catch(() => {});
  console.log = console.error = write;
  process.on('uncaughtException', e => { write('uncaught', e.stack || e); });
}

const existing = await runningHost();
if (existing) {
  console.log(`Sitetend is already running: ${existing.url}`);
  if (!flag('--no-open') && !background) openBrowser(existing.url);
  process.exit(0);
}

const { startHost } = await import('../src/host/server.mjs');
let tray = null;
const stop = async () => { tray?.stop(); await host.close().catch(() => {}); process.exit(0); };
const wanted = Number(opt('--port') || process.env.PORT || 54321);
let host;
try { host = await startHost({ port: wanted, workspace: positional[0] || null, onQuit: () => stop() }); }
catch (e) {
  if (e.code !== 'EADDRINUSE') throw e;
  console.log(`Port ${wanted} is used by another program; using a free one.`);   // the shortcut finds the host through host.json, not the port
  host = await startHost({ port: 0, workspace: positional[0] || null, onQuit: () => stop() });
}
const s = await loadSettings();
if (s.tray !== false) tray = startTray({ url: host.url, port: host.port, token: host.token, lang: s.language });
host.setTray?.(on => { tray?.stop(); tray = on ? startTray({ url: host.url, port: host.port, token: host.token, lang: s.language }) : null; });
if (!flag('--no-open') && !background) openBrowser(host.url);
if (!background) console.log(process.platform === 'win32' && tray ? 'Close this window to quit (or use the Sitetend icon in the taskbar tray).' : 'Press Ctrl+C to quit.');
process.on('SIGINT', stop); process.on('SIGTERM', stop);
