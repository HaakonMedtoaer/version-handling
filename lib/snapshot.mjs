// Build a POST /workflows body from a GET /workflows/{id} response.
// Publish and rollback are the same operation: snapshot -> new workflow named "<base> <n>.0".
import { randomBytes } from 'node:crypto';

// Top-level fields POST accepts (live-workflow.schema.json). Everything else in a GET
// (stats, workflowArn, definitionAsl, overview, created/modified/By) is server-computed
// and POST rejects it.
const POST_FIELDS = ['entity', 'description', 'hasError', 'tenantId', 'workflowId', 'workflowName',
  'workflowAlias', 'active', 'workflowType', 'labels', 'tags', 'definition'];

const newWorkflowId = () => `WORKFLOW-${randomBytes(16).toString('hex')}`;

// "Order Sync 3.0" -> { base: "Order Sync", version: 3 }; names without a suffix are version 0.
export function parseVersionedName(name) {
  const m = /^(.*?)\s+(\d+)\.0$/.exec(name);
  return m ? { base: m[1], version: Number(m[2]) } : { base: name, version: 0 };
}

export const versionedName = (base, version) => `${base} ${version}.0`;

// The part of a workflow worth storing as a version: the definition plus the
// top-level settings needed to recreate it.
export function toSnapshot(get) {
  return {
    sourceWorkflowId: get.workflowId,
    workflowName: get.workflowName,
    active: get.active,
    workflowType: get.workflowType,
    labels: get.labels ?? [],
    description: get.description ?? '',
    tags: get.tags,
    definition: get.definition,
  };
}

// Problems that let creation succeed but break the copy later. A malformed environment or
// connection id in tags passes POST silently and breaks M3 API steps (skill: schema.tags).
export function snapshotWarnings(snapshot) {
  const tags = snapshot.tags ?? {};
  if (tags._type === 'SYSTEM') return [];
  const bad = (prefix, v) => v !== undefined && !new RegExp(`^${prefix}-[0-9a-f]{32}$`).test(v);
  const warnings = [];
  for (const v of [tags.apiEnvironment, tags.primaryEnvironment, ...(tags.environments ?? [])]) {
    if (bad('ENVIRONMENT', v)) warnings.push(`malformed environment id "${v}"`);
  }
  for (const v of tags.connectionId ?? []) {
    if (bad('CONNECTION', v)) warnings.push(`malformed connection id "${v}"`);
  }
  return [...new Set(warnings)];
}

// Environments a snapshot can be published to: every environment that has its own connection to
// replace each connection the workflow uses. Connections carry environmentId (GET /connections).
// A replacement must be the same kind of system (connection.system: "M3", "VinceLive", ...).
export function environmentOptions(snapshot, environments, connections) {
  const byId = new Map(connections.map((c) => [c.connectionId, c]));
  const usedSystems = [...new Set((snapshot.tags?.connectionId ?? []).map((id) => byId.get(id)?.system ?? 'unknown'))];
  const current = snapshot.tags?.primaryEnvironment;
  return environments.map((env) => {
    const inEnv = connections.filter((c) => c.environmentId === env.environmentId);
    const missing = usedSystems.filter((s) => !inEnv.some((c) => c.system === s));
    return {
      environmentId: env.environmentId,
      name: env.environmentName,
      current: env.environmentId === current,
      // Candidate replacements per system the workflow uses.
      connections: Object.fromEntries(usedSystems.map((s) => [s, inEnv.filter((c) => c.system === s)
        .map((c) => ({ connectionId: c.connectionId, name: c.connectionName }))])),
      available: missing.length === 0,
      reason: missing.length ? `No ${missing.join('/')} connection in ${env.environmentName}` : null,
    };
  });
}

// Point a snapshot at another environment. connectionMap maps each old connection id to its
// replacement in that environment. Connection ids are unique tokens, so replacing them across the
// serialised definition covers connectionContext, every M3 transaction and REST step content.
export function retarget(snapshot, { environmentId, connectionMap = {} }) {
  let json = JSON.stringify(snapshot.definition);
  for (const [from, to] of Object.entries(connectionMap)) json = json.split(from).join(to);
  return {
    ...snapshot,
    definition: JSON.parse(json),
    tags: {
      ...snapshot.tags,
      apiEnvironment: environmentId,
      primaryEnvironment: environmentId,
      environments: [environmentId],
      connectionId: (snapshot.tags?.connectionId ?? []).map((id) => connectionMap[id] ?? id),
    },
  };
}

// Turn a stored snapshot into a POST /workflows body under a new name.
export function toPostBody(snapshot, { tenantId, name }) {
  if (snapshot.workflowType !== 'STANDARD') {
    // Creating with EXPRESS yields a half-provisioned, unreachable workflow (skill: schema.workflowType).
    throw new Error(`Cannot publish ${snapshot.workflowType} workflow "${snapshot.workflowName}": only STANDARD is safe to create`);
  }
  const definition = structuredClone(snapshot.definition);
  // workflowConfig.name mirrors workflowName (87/89 real workflows). The trigger/client form
  // title often does too, but it is user-facing text, so it is left as the author set it.
  if (definition.workflowConfig) definition.workflowConfig.name = name;
  const body = {
    entity: 'Workflow',
    description: snapshot.description ?? '',
    hasError: false,
    tenantId,
    workflowId: newWorkflowId(), // Live assigns its own id; read the real one back from the response.
    workflowName: name,
    workflowAlias: name,
    active: snapshot.active ?? true,
    workflowType: 'STANDARD',
    labels: snapshot.labels ?? [],
    tags: snapshot.tags,
    definition,
  };
  return Object.fromEntries(POST_FIELDS.map((k) => [k, body[k]]));
}
