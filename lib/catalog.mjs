// Joins the workflow list with users, API clients, environments, connections, groups and roles
// into one searchable record per workflow. Pure functions over API responses; no fetching here.

// M3 API calls in a definition: stepConfig.m3_api_N.<transactionInstanceId>.{programName, transactionName}.
export function m3Apis(definition) {
  const apis = new Set();
  for (const [stepId, step] of Object.entries(definition?.stepConfig ?? {})) {
    if (!stepId.startsWith('m3_api')) continue;
    for (const t of Object.values(step ?? {})) {
      if (t?.programName && t?.transactionName) apis.add(`${t.programName}/${t.transactionName}`);
    }
  }
  return [...apis].sort();
}

// vrn patterns use '*' as a wildcard segment suffix, e.g. vrn:TENANT-x:fnd:workflow:*
const vrnMatches = (pattern, vrn) =>
  new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(vrn);

// Per-workflow role permissions name the workflow by ALIAS, not id (captured from the UI):
// vrn:<TENANT>:fnd:workflow:<workflowAlias>, action "*" | "READ" | "WRITE".
export const workflowVrn = (workflow) => `vrn:${workflow.tenantId}:fnd:workflow:${workflow.workflowAlias}`;

// Roles granting access to a workflow, with the action and whether it only comes from a wildcard
// (which the user cannot remove per workflow).
export function rolesFor(workflow, roles) {
  const vrn = workflowVrn(workflow);
  return roles.flatMap((r) => {
    const perms = (r.permissions ?? []).filter((p) => vrnMatches(p.vrn, vrn));
    if (!perms.length) return [];
    const direct = perms.find((p) => p.vrn === vrn);
    return [{ roleId: r.roleId, roleName: r.roleName, action: (direct ?? perms[0]).action, viaWildcard: !direct }];
  });
}

// PUT /roles body granting (or with action null, revoking) direct access to one workflow alias.
// PUT replaces the whole permissions array, so it always carries every existing permission.
export function rolePutBody(role, vrn, action) {
  const permissions = (role.permissions ?? []).filter((p) => p.vrn !== vrn);
  if (action) permissions.push({ action, vrn });
  return { roleName: role.roleName, description: role.description ?? '', tenantId: role.tenantId,
    active: role.active, tags: role.tags ?? {}, roleId: role.roleId, permissions };
}

export function buildCatalog({ workflows, definitions = {}, users = [], apiClients = [], environments = [], connections = [], groups = [], roles = [] }) {
  const people = new Map();
  for (const u of users) people.set(u.userId, [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || u.userId);
  for (const c of apiClients) people.set(`CLIENT-${c.clientId}`, `${c.apiClientName.trim()} (API client)`);
  const envById = new Map(environments.map((e) => [e.environmentId, e]));
  const connById = new Map(connections.map((c) => [c.connectionId, c]));

  return workflows.map((w) => {
    const env = envById.get(w.tags?.primaryEnvironment);
    return {
      workflowId: w.workflowId,
      workflowName: w.workflowName,
      workflowType: w.workflowType,
      active: w.active,
      labels: w.labels ?? [],
      createdBy: people.get(w.createdBy) ?? w.createdBy ?? '',
      modifiedBy: people.get(w.modifiedBy) ?? w.modifiedBy ?? '',
      modified: w.modified,
      environment: env ? { id: env.environmentId, code: env.code, name: env.environmentName }
        : w.tags?.primaryEnvironment ? { id: w.tags.primaryEnvironment, code: '?', name: 'Unknown id' } : null,
      connections: (w.tags?.connectionId ?? []).map((id) => ({ id, name: connById.get(id)?.connectionName ?? 'Missing connection' })),
      groups: groups.filter((g) => (g.entities ?? []).some((e) => e.id === w.workflowId)).map((g) => ({ groupId: g.groupId, groupName: g.groupName })),
      roles: rolesFor(w, roles),
      m3Apis: m3Apis(definitions[w.workflowId]),
      stats: {
        runs: w.stats?.numRuns ?? 0,
        // numRunsSuccessful is always 0 in real data; numRunsSuccess is the real counter.
        success: w.stats?.numRunsSuccess ?? 0,
        failed: w.stats?.numRunsFailed ?? 0,
        lastRun: w.stats?.lastExecutionTime ?? null,
      },
    };
  });
}

// Free-text search across name and people, plus an M3 API filter ("MMS200MI" or "MMS200MI/GetItmBasic").
export function search(catalog, { text = '', user = '', api = '', sortBy = 'name' } = {}) {
  const has = (s, q) => String(s).toLowerCase().includes(q.toLowerCase());
  const rows = catalog.filter((w) =>
    (!text || has(w.workflowName, text))
    && (!user || has(w.createdBy, user) || has(w.modifiedBy, user))
    && (!api || w.m3Apis.some((a) => has(a, api))));
  const key = {
    name: (w) => w.workflowName.toLowerCase(),
    environment: (w) => `${w.environment?.code ?? '~'} ${w.workflowName.toLowerCase()}`,
    modified: (w) => w.modified ?? '',
  }[sortBy];
  return rows.sort((a, b) => key(a).localeCompare(key(b)) * (sortBy === 'modified' ? -1 : 1));
}
