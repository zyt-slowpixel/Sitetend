/**
 * Picks the site adapter for a website. No structure is assumed:
 *   website/content.json                      -> json-generic (any JSON shape)
 *   _config.yml / hugo.toml / *.html files    -> text-files (Jekyll, Hugo or static HTML)
 * (The old demo-specific json-portfolio adapter was retired on 2026-11-11.)
 */
import { JsonGenericSiteAdapter } from './json-generic-adapter.js';
import { TextSiteAdapter, detectTextMode } from './text-site-adapter.js';

/** From state already known (e.g. in the browser): { siteAdapter, mode }. */
export function siteAdapterFor(info = {}) {
  return info?.siteAdapter === 'text-files' ? new TextSiteAdapter(info.mode || 'html') : new JsonGenericSiteAdapter();
}

/** From the files of a workspace. */
export async function siteAdapterForWorkspace(workspace, { exclude = [] } = {}) {
  const json = await workspace.exists('website/content.json');
  if (json.ok && json.data.exists && !exclude.includes('content.json')) return new JsonGenericSiteAdapter();
  const list = await workspace.listFiles('website');
  const mode = list.ok ? detectTextMode(list.data.files.map(p => p.replace(/^website\//, '')).filter(p => !exclude.includes(p))) : null;
  return mode ? new TextSiteAdapter(mode, { exclude }) : new JsonGenericSiteAdapter();
}
