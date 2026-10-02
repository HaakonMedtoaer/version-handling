// Build the catalog from captured responses in probe/out and run a search.
// Usage: node lib/try-catalog.mjs [--text x] [--user x] [--api MMS200MI] [--sort name|environment|modified]
import { readFileSync, readdirSync } from 'node:fs';
import { buildCatalog, search } from './catalog.mjs';

const out = new URL('../probe/out/', import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(p, out)));
const items = (p) => read(`endpoints/${p}.json`).items;
const definitions = Object.fromEntries(readdirSync(new URL('defs/', out)).map((f) => {
  const g = read(`defs/${f}`); return [g.workflowId, g.definition];
}));

const catalog = buildCatalog({
  workflows: read('list.json').items, definitions,
  users: items('_users'), apiClients: items('_api-clients'), environments: items('_environments'),
  connections: items('_connections'), groups: items('_groups'), roles: items('_roles'),
});

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((a) => a.trim().split(/\s+(.*)/s).slice(0, 2)));
const rows = search(catalog, { text: args.text, user: args.user, api: args.api, sortBy: args.sort ?? 'name' });
console.log(`${rows.length} of ${catalog.length}`);
for (const w of rows.slice(0, 15)) {
  console.log(`- ${w.workflowName} [${w.workflowType}] env=${w.environment?.name ?? '-'} by=${w.modifiedBy}`
    + ` groups=${w.groups.map((g) => g.groupName).join(',') || '-'} roles=${w.roles.map((r) => r.roleName).join(',') || '-'}`
    + ` runs=${w.stats.success}/${w.stats.runs}${w.m3Apis.length ? ` apis=${w.m3Apis.slice(0, 3).join(',')}${w.m3Apis.length > 3 ? '…' : ''}` : ''}`);
}
