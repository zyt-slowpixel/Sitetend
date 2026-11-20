// Prints the editable fields of a site folder (website/...). Usage: node tools/dump-fields.mjs <site-folder> [filter]
import fs from 'node:fs'; import path from 'node:path';
import { siteAdapterForWorkspace } from '../src/adapters/site-adapters.js';
import { NodeFsWorkspaceAdapter } from '../src/adapters/node-workspace-adapter.mjs';
const [dir, filter] = process.argv.slice(2);
const ws = new NodeFsWorkspaceAdapter(path.resolve(dir));
const a = await siteAdapterForWorkspace(ws);
const c = a.readContent ? (await a.readContent(ws)).data.data : JSON.parse(fs.readFileSync(path.join(dir, 'website/content.json'), 'utf8'));
for (const f of a.listEditableFields(c)) { if (filter && !f.path.includes(filter)) continue; const v = a.getFieldValue(c, f.path).data.value; console.log(f.path + ' = ' + JSON.stringify(v).slice(0, 110)); }
