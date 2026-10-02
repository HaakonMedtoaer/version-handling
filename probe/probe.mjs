// Probe the Vince Live workflow endpoints and save raw responses for analysis.
// Usage: put a bearer (Cognito ID) token in probe/.token, then: node probe/probe.mjs [workflowId]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'out');
mkdirSync(out, { recursive: true });

const BASE = 'https://api.vince.live';
const token = readFileSync(join(here, '.token'), 'utf8')
  .replace(/\s+/g, '')
  .replace(/^["']|["']$/g, '')
  .replace(/^Bearer/i, '');

// Show which tenant the token acts on (the token decides the tenant).
try {
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  const tenantClaims = Object.entries(claims).filter(([, v]) => /TENANT-[0-9a-f]{32}/i.test(String(v)));
  console.log('Token tenant claim(s):', tenantClaims);
  console.log('Token expires:', new Date(claims.exp * 1000).toISOString());
} catch { console.log('Could not decode token claims (not a JWT?)'); }

async function get(path, file) {
  const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  writeFileSync(join(out, file), text);
  console.log(`\nGET ${path} -> ${res.status} (${text.length} bytes) saved to out/${file}`);
  const headers = Object.fromEntries(res.headers);
  writeFileSync(join(out, file.replace('.json', '.headers.json')), JSON.stringify(headers, null, 2));
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
}

function shape(v, depth = 0) {
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1), `…${v.length} items`] : [];
  if (v && typeof v === 'object') {
    if (depth > 3) return '{…}';
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]));
  }
  return typeof v;
}

const list = await get('/workflows', 'list.json');
if (list.status !== 200) process.exit(1);
console.log('List shape:', JSON.stringify(shape(list.body), null, 2));

const items = Array.isArray(list.body) ? list.body : (list.body.items ?? list.body.data ?? []);
console.log(`Items in first response: ${items.length}`);
const id = process.argv[2] ?? items[0]?.workflowId;
if (id) {
  const one = await get(`/workflows/${id}`, 'single.json');
  if (one.status === 200) {
    console.log('Single top-level keys:', Object.keys(one.body));
    console.log('stats:', JSON.stringify(one.body.stats, null, 2));
  }
}
