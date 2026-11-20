// @ts-check
// Desktop integration, so Sitetend opens like an app: a shortcut (desktop + Start menu / Applications / app menu),
// starting at sign-in, and on Windows a tray icon. Every shortcut runs `node bin/sitetend.mjs --launch`, which opens
// the running Sitetend if there is one, or starts it in the background (no console window) and then opens it.
// Nothing here is reachable by MCP agents.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { msg } from './i18n.mjs';

export const APP_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const SCRIPT = path.join(APP_ROOT, 'bin', 'sitetend.mjs');
const ICON_ICO = path.join(APP_ROOT, 'ui', 'assets', 'sitetend.ico');
const ICON_PNG = path.join(APP_ROOT, 'ui', 'assets', 'sitetend.png');
const NAME = 'Sitetend';
const exists = p => fs.stat(p).then(() => true, () => false);
const home = () => process.env.SITETEND_DESKTOP_HOME || os.homedir();   // tests point this at a temp folder

function ps(script, env = {}) {
  return new Promise((resolve, reject) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from('[Console]::OutputEncoding = [Text.Encoding]::UTF8\n' + script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 20000, env: { ...process.env, ...env } }, (err, out, errOut) => err ? reject(Object.assign(Error(String(errOut || err.message).trim().slice(0, 300)), { code: 'DESKTOP_FAILED' })) : resolve(String(out).trim())));
}

// ---------------------------------------------------------------- Windows
let winDirs = null;
async function windowsDirs() {
  // Known folders (the Desktop may be redirected to OneDrive), asked once.
  winDirs ??= JSON.parse(await ps(`@{ desktop = [Environment]::GetFolderPath('Desktop'); programs = [Environment]::GetFolderPath('Programs'); startup = [Environment]::GetFolderPath('Startup') } | ConvertTo-Json -Compress`));
  return winDirs;
}
const WIN_LNK = String.raw`
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:ST_LNK)
$s.TargetPath = $env:ST_NODE
$s.Arguments = $env:ST_ARGS
$s.WorkingDirectory = $env:ST_APP
$s.IconLocation = "$($env:ST_ICON),0"
$s.Description = 'Sitetend: keep your website in sync with your materials'
$s.WindowStyle = 7
$s.Save()`;
// WindowStyle 7 = minimized: the launcher only lives for a moment, so no console window flashes up.
const winLink = (lnk, args) => ps(WIN_LNK, { ST_LNK: lnk, ST_NODE: process.execPath, ST_ARGS: `"${SCRIPT}" ${args}`, ST_APP: APP_ROOT, ST_ICON: ICON_ICO });

// ---------------------------------------------------------------- macOS
const macApp = () => path.join(home(), 'Applications', `${NAME}.app`);
async function makeMacApp() {
  const app = macApp(), contents = path.join(app, 'Contents');
  await fs.mkdir(path.join(contents, 'MacOS'), { recursive: true }); await fs.mkdir(path.join(contents, 'Resources'), { recursive: true });
  await fs.writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>${NAME}</string><key>CFBundleDisplayName</key><string>${NAME}</string>
<key>CFBundleIdentifier</key><string>io.github.sitetend</string><key>CFBundleExecutable</key><string>${NAME}</string>
<key>CFBundleIconFile</key><string>sitetend</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1.0.0</string><key>LSUIElement</key><true/>
</dict></plist>
`);
  const exe = path.join(contents, 'MacOS', NAME);
  await fs.writeFile(exe, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(SCRIPT)} --launch\n`, { mode: 0o755 });
  // An .icns from the PNG with the tools every Mac has; without it the app just shows the generic icon.
  const set = path.join(os.tmpdir(), `sitetend-${process.pid}.iconset`);
  await fs.mkdir(set, { recursive: true });
  const run = (c, a) => new Promise(r => execFile(c, a, err => r(!err)));
  let ok = true;
  for (const n of [16, 32, 128, 256, 512]) {
    ok = ok && await run('sips', ['-z', String(n), String(n), ICON_PNG, '--out', path.join(set, `icon_${n}x${n}.png`)]);
    if (n * 2 <= 512) ok = ok && await run('sips', ['-z', String(n * 2), String(n * 2), ICON_PNG, '--out', path.join(set, `icon_${n}x${n}@2x.png`)]);
  }
  if (ok) await run('iconutil', ['-c', 'icns', set, '-o', path.join(contents, 'Resources', 'sitetend.icns')]);
  await fs.rm(set, { recursive: true, force: true });
}
const macAgent = () => path.join(home(), 'Library', 'LaunchAgents', 'io.github.sitetend.plist');

// ---------------------------------------------------------------- Linux
const linuxEntry = (args, extra = '') => `[Desktop Entry]
Type=Application
Name=${NAME}
Comment=Keep your website in sync with your materials
Exec=${JSON.stringify(process.execPath)} ${JSON.stringify(SCRIPT)} ${args}
Icon=${ICON_PNG}
Terminal=false
Categories=Utility;Development;
${extra}`;
const linuxMenu = () => path.join(home(), '.local', 'share', 'applications', 'sitetend.desktop');
const linuxDesktop = () => path.join(home(), 'Desktop', 'sitetend.desktop');
const linuxAutostart = () => path.join(home(), '.config', 'autostart', 'sitetend.desktop');

// ---------------------------------------------------------------- public
/** Where the shortcuts are (or would be) and whether they exist. */
export async function status() {
  const p = process.platform;
  const out = { platform: p, trayAvailable: p === 'win32', shortcut: false, login: false, places: [] };
  try {
    if (p === 'win32') {
      const d = await windowsDirs();
      out.places = [path.join(d.desktop, `${NAME}.lnk`), path.join(d.programs, `${NAME}.lnk`)];
      out.shortcut = await exists(out.places[0]) || await exists(out.places[1]);
      out.login = await exists(path.join(d.startup, `${NAME}.lnk`));
    } else if (p === 'darwin') {
      out.places = [macApp(), path.join(home(), 'Desktop', `${NAME}.app`)];
      out.shortcut = await exists(macApp());
      out.login = await exists(macAgent());
    } else {
      out.places = [linuxMenu(), linuxDesktop()];
      out.shortcut = await exists(linuxMenu());
      out.login = await exists(linuxAutostart());
    }
  } catch (e) { out.error = e.message; }
  return out;
}

/** Desktop shortcut + Start menu (Windows) / Applications (macOS) / app menu (Linux). */
export async function createShortcut() {
  const p = process.platform;
  if (p === 'win32') {
    const d = await windowsDirs();
    await winLink(path.join(d.desktop, `${NAME}.lnk`), '--launch');
    await winLink(path.join(d.programs, `${NAME}.lnk`), '--launch');
  } else if (p === 'darwin') {
    await makeMacApp();
    const link = path.join(home(), 'Desktop', `${NAME}.app`);
    await fs.rm(link, { force: true }).catch(() => {});
    await fs.symlink(macApp(), link).catch(() => {});
  } else {
    await fs.mkdir(path.dirname(linuxMenu()), { recursive: true });
    await fs.writeFile(linuxMenu(), linuxEntry('--launch'), { mode: 0o755 });
    if (await exists(path.dirname(linuxDesktop()))) {
      await fs.writeFile(linuxDesktop(), linuxEntry('--launch'), { mode: 0o755 });
      execFile('gio', ['set', linuxDesktop(), 'metadata::trusted', 'true'], () => {});   // GNOME: allow launching
    }
  }
  return status();
}

/** Start Sitetend in the background when the user signs in (no browser window). */
export async function setLogin(enabled) {
  const p = process.platform;
  if (p === 'win32') {
    const lnk = path.join((await windowsDirs()).startup, `${NAME}.lnk`);
    if (enabled) await winLink(lnk, '--launch --no-browser'); else await fs.rm(lnk, { force: true });
  } else if (p === 'darwin') {
    if (enabled) {
      await fs.mkdir(path.dirname(macAgent()), { recursive: true });
      await fs.writeFile(macAgent(), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>io.github.sitetend</string>
<key>ProgramArguments</key><array><string>${process.execPath}</string><string>${SCRIPT}</string><string>--launch</string><string>--no-browser</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>
`);
    } else await fs.rm(macAgent(), { force: true });
  } else {
    if (enabled) { await fs.mkdir(path.dirname(linuxAutostart()), { recursive: true }); await fs.writeFile(linuxAutostart(), linuxEntry('--launch --no-browser', 'X-GNOME-Autostart-enabled=true\n')); }
    else await fs.rm(linuxAutostart(), { force: true });
  }
  return status();
}

// ---------------------------------------------------------------- tray (Windows)
const TRAY = String.raw`
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace St -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][St.Dpi]::SetProcessDPIAware()
[System.Windows.Forms.Application]::EnableVisualStyles()
$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = New-Object System.Drawing.Icon($env:ST_ICON)
$ni.Text = 'Sitetend'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add($env:ST_OPEN)
$open.Font = New-Object System.Drawing.Font($open.Font, [System.Drawing.FontStyle]::Bold)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$quit = $menu.Items.Add($env:ST_QUIT)
$open.add_Click({ Start-Process $env:ST_URL })
$quit.add_Click({
  try { Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($env:ST_PORT)/api/host/quit" -Headers @{ 'X-Sitetend-Token' = $env:ST_TOKEN } -ContentType 'application/json' -Body '{}' -TimeoutSec 5 | Out-Null } catch {}
  $ni.Visible = $false; [System.Windows.Forms.Application]::Exit()
})
$ni.ContextMenuStrip = $menu
$ni.add_MouseClick({ param($s, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Start-Process $env:ST_URL } })
$ni.Visible = $true
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({ if (-not (Get-Process -Id ([int]$env:ST_PID) -ErrorAction SilentlyContinue)) { $ni.Visible = $false; [System.Windows.Forms.Application]::Exit() } })
$timer.Start()
[System.Windows.Forms.Application]::Run()`;
// The two menu items are interface text: ui/locales/<lang>.json, keys tray.open and tray.quit.
/** Shows the tray icon; returns a handle to remove it. The icon also goes away by itself when Sitetend stops. */
export function startTray({ url, port, token, lang }) {
  if (process.platform !== 'win32') return null;
  const [open, quit] = [msg(lang, 'tray.open'), msg(lang, 'tray.quit')];
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(TRAY, 'utf16le').toString('base64')], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ST_ICON: ICON_ICO, ST_URL: url, ST_PORT: String(port), ST_TOKEN: token, ST_PID: String(process.pid), ST_OPEN: open, ST_QUIT: quit } });
  // If the icon does not appear, ~/.sitetend/tray.log says why (PowerShell's own error text).
  const log = path.join(process.env.SITETEND_HOME || path.join(os.homedir(), '.sitetend'), 'tray.log');
  const note = t => fs.appendFile(log, `[${new Date().toISOString()}] ${t}\n`).catch(() => {});
  note(`starting tray (pid ${process.pid}, icon ${ICON_ICO})`);
  let err = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', d => { err += d; });
  child.on('error', e => note('could not start PowerShell: ' + e.message));
  child.on('exit', code => note(`tray exited (code ${code})${err.trim() ? ':\n' + err.trim().slice(-3000) : ''}`));
  return { stop: () => { try { child.kill(); } catch {} } };
}

/** Opens a URL in the default browser. */
export function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref(); return true; } catch { return false; }
}
