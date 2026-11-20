// @ts-check
// Publish backend: commit only the website folder and push it with the user's own git setup.
// Never commits materials (sources/) or Sitetend data (.sitetend/), never asks for credentials itself.
import { execFile } from 'node:child_process';

const GIT_TIMEOUT = 120000;

/** @returns {Promise<{ ok: boolean, out: string, err: string, code: number|null }>} */
function git(cwd, args) {
  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },   // never hang waiting for a password prompt
    (error, stdout, stderr) => resolve({ ok: !error, out: String(stdout).trim(), err: String(stderr).trim(), code: error ? (typeof error.code === 'number' ? error.code : null) : 0 }));
  });
}

/** What publishing would do for this folder. */
export async function gitStatus(root) {
  const v = await git(root, ['--version']);
  if (!v.ok) return { available: false, reason: 'NO_GIT' };
  const top = await git(root, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { available: false, reason: 'NOT_A_REPO' };
  const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).out || null;
  const upstream = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const remotes = (await git(root, ['remote'])).out.split(/\s+/).filter(Boolean);
  const remote = upstream.ok ? upstream.out.split('/')[0] : remotes.includes('origin') ? 'origin' : remotes[0] || null;
  const url = remote ? (await git(root, ['remote', 'get-url', remote])).out : null;
  if (!remote) return { available: false, reason: 'NO_REMOTE', branch };
  // Is Sitetend's own data accidentally tracked?
  const tracked = (await git(root, ['ls-files', '--', '.sitetend'])).out;
  return { available: true, branch, remote, upstream: upstream.ok ? upstream.out : null, url: redact(url), sitetendTracked: Boolean(tracked) };
}

const redact = url => url ? url.replace(/\/\/[^@/]+@/, '//***@') : url;   // hide tokens embedded in remote URLs

/**
 * Commits website/ (only) and pushes. Returns { commit, pushed, remote, branch, nothingToCommit }.
 * Throws an Error with .code: NOT_A_REPO | NO_REMOTE | GIT_IDENTITY | PUSH_REJECTED | PUSH_AUTH | GIT_FAILED
 */
export async function gitPublish(root, { paths = ['website'], message } = {}) {
  const st = await gitStatus(root);
  if (!st.available) throw Object.assign(Error(st.reason), { code: st.reason });
  const add = await git(root, ['add', '--', ...paths]);
  if (!add.ok) throw Object.assign(Error(add.err || 'git add failed'), { code: 'GIT_FAILED' });
  const staged = await git(root, ['diff', '--cached', '--quiet', '--', ...paths]);
  let nothingToCommit = staged.ok;
  // Only commit what we staged under website/; other staged work of the user stays staged, untouched.
  if (!nothingToCommit) {
    const c = await git(root, ['commit', '-m', message || `Sitetend: publish ${new Date().toISOString()}`, '--', ...paths]);
    if (!c.ok) {
      if (/user\.(name|email)|Please tell me who you are|empty ident/i.test(c.err + c.out)) throw Object.assign(Error(c.err), { code: 'GIT_IDENTITY' });
      throw Object.assign(Error(c.err || c.out || 'git commit failed'), { code: 'GIT_FAILED' });
    }
  }
  const commit = (await git(root, ['rev-parse', '--short', 'HEAD'])).out;
  const push = st.upstream ? await git(root, ['push']) : await git(root, ['push', '-u', st.remote, 'HEAD']);
  if (!push.ok) {
    if (/rejected|non-fast-forward|fetch first/i.test(push.err)) throw Object.assign(Error(push.err), { code: 'PUSH_REJECTED' });
    if (/Authentication|Permission denied|could not read Username|403|401/i.test(push.err)) throw Object.assign(Error(push.err), { code: 'PUSH_AUTH' });
    throw Object.assign(Error(push.err || 'git push failed'), { code: 'GIT_FAILED' });
  }
  return { commit, pushed: true, remote: st.remote, branch: st.branch, nothingToCommit };
}
