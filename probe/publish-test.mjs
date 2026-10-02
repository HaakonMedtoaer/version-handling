// End-to-end publish test: GET a workflow, build the "<base> <n+1>.0" POST body, create it,
// then GET the new workflow back and diff its definition against the source.
// Usage: node probe/publish-test.mjs WORKFLOW-<id>          (dry run: writes the body only)
//        node probe/publish-test.mjs WORKFLOW-<id> --go     (actually creates the workflow)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toSnapshot, toPostBody, parseVersionedName, versionedName, snapshotWarnings } from '../lib/snapshot.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'out', 'publish');
mkdirSync(out, { recursive: true });
const BASE = 'https://api.vince.live';
const token = readFileSync(join(here, '.token'), 'utf8').replace(/\s+/g, '').replace(/^["']|["']$/g, '').replace(/^Bearer/i, '');
const [id, flag] = process.argv.slice(2);
if (!id) throw new Error('Pass a WORKFLOW-<id>');

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

// Paths where two JSON values differ.
function diff(a, b, path = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => diff(a[k], b[k], `${path}/${k}`));
  }
  return [`${path}: ${JSON.stringify(a)?.slice(0, 80)} -> ${JSON.stringify(b)?.slice(0, 80)}`];
}

const src = await call('GET', `/workflows/${id}`);
if (src.status !== 200) throw new Error(`GET source -> ${src.status} ${JSON.stringify(src.json)}`);
const snapshot = toSnapshot(src.json);
const { base, version } = parseVersionedName(src.json.workflowName);
const name = versionedName(base, version + 1);
const body = toPostBody(snapshot, { tenantId: src.json.tenantId, name });
writeFileSync(join(out, 'post-body.json'), JSON.stringify(body, null, 2));
console.log(`Source "${src.json.workflowName}" -> new "${name}"`);
snapshotWarnings(snapshot).forEach((w) => console.log('  warning:', w));
if (flag !== '--go') { console.log('Dry run: body written to out/publish/post-body.json'); process.exit(0); }

const created = await call('POST', '/workflows', body);
writeFileSync(join(out, 'post-response.json'), JSON.stringify(created.json, null, 2));
console.log(`POST /workflows -> ${created.status}`);
if (created.status >= 300) { console.log(JSON.stringify(created.json, null, 2)); process.exit(1); }
const newId = created.json.workflowId ?? created.json.item?.workflowId;
console.log(`New workflowId: ${newId} (sent ${body.workflowId}, same: ${newId === body.workflowId})`);

const back = await call('GET', `/workflows/${newId}`);
writeFileSync(join(out, 'readback.json'), JSON.stringify(back.json, null, 2));
console.log(`GET new -> ${back.status}`);
const expected = structuredClone(src.json.definition);
if (expected.workflowConfig) expected.workflowConfig.name = name;
const d = diff(expected, back.json.definition);
console.log(d.length ? `Definition differs in ${d.length} place(s):\n  ${d.join('\n  ')}` : 'Definition round-tripped identically');
for (const k of ['workflowName', 'workflowAlias', 'labels', 'description', 'workflowType', 'active', 'tags']) {
  console.log(`  ${k}: ${JSON.stringify(back.json[k])}`);
}
