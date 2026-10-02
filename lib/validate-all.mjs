// Offline check: build a POST body from every captured GET and check the envelope we construct.
// The definition itself is passed through untouched: the skill schema is a drafting subset and
// rejects shapes Live's own builder saves (TABLE_UPDATER, null descriptions, SYSTEM tags), so
// Live's POST validator is the only authority on it.
import { readFileSync, readdirSync } from 'node:fs';
import { toSnapshot, toPostBody, parseVersionedName, versionedName, snapshotWarnings } from './snapshot.mjs';

const ID = (p) => new RegExp(`^${p}-[0-9a-f]{32}$`);
const dir = new URL('../probe/out/defs/', import.meta.url);
const results = { ok: 0, refused: [], warned: [] };

for (const f of readdirSync(dir)) {
  const get = JSON.parse(readFileSync(new URL(f, dir)));
  const snapshot = toSnapshot(get);
  const { base, version } = parseVersionedName(get.workflowName);
  let body;
  try {
    body = toPostBody(snapshot, { tenantId: get.tenantId, name: versionedName(base, version + 1) });
  } catch (e) { results.refused.push(e.message); continue; }

  const envelopeOk = body.entity === 'Workflow' && ID('TENANT').test(body.tenantId) && ID('WORKFLOW').test(body.workflowId)
    && typeof body.description === 'string' && Array.isArray(body.labels) && body.definition?.workflowConfig && body.definition?.stepConfig;
  if (!envelopeOk) throw new Error(`Bad envelope for ${get.workflowName}`);
  results.ok++;
  const warnings = snapshotWarnings(snapshot);
  if (warnings.length) results.warned.push(`${get.workflowName}: ${warnings.join('; ')}`);
}
console.log(`publishable: ${results.ok} (with warnings: ${results.warned.length}), refused: ${results.refused.length}`);
results.warned.forEach((w) => console.log('  warn:', w));
