# Handoff
_Last updated: 2026-10-02 (Claude Code session)_

## Current state
- Project: App Builder app adding publish / version / rollback to Vince Live workflows. Nothing built in App Builder yet.
- Draft 1 flowchart + overview layout in Lucid: https://lucid.app/lucidchart/8b0f7352-fc8e-4c96-9a21-6521bb711f36/edit (page 1 user flow, page 2 overview screen).
- Colours taken from vincesoftware.com (not confirmed as App Builder design system): #1F363D, #F26B21, #4BB4B0, #E4F3F2, #ECF2FB, #CFE2F3.
- Decision: rollback = create a NEW workflow copy from a snapshot (no in-place restore). Publish and rollback are the same operation: build POST /workflows body from snapshot, name "X <n>.0".
- Code in this folder (Node 24, no deps):
  - `lib/snapshot.mjs`: GET response -> snapshot -> POST body (`toSnapshot`, `toPostBody`, `snapshotWarnings`, name parse/format).
  - `lib/validate-all.mjs`: offline run over all captured workflows.
  - `probe/probe.mjs`: list + single GET, saves raw JSON to `probe/out/`.
  - `probe/publish-test.mjs <id> [--go]`: end-to-end publish + read-back diff. Dry run by default.
  - Token goes in `probe/.token` (gitignored; Cognito ID token from DevTools, ~1h life).

## Confirmed 2026-10-02 (real tenant TENANT-176ff31b…, 89 workflows)
- **`GET /workflows` (no id) exists.** Returns `{count, items[], scannedCount, queryCount}`. All 89 in one response (121 KB), no paging cursor seen. Unknown whether a larger tenant gets a cursor.
- List items are **summaries**: no `definition`. Fields: workflowId, workflowName, workflowAlias, active, workflowType, labels, tags, createdBy, modifiedBy, created, modified, hasError, overview.{triggerType, steps[{stepId,name,type,target}]}, stats, workflowArn. Enough for the overview screen in one call.
- `createdBy`/`modifiedBy` are ids (`USER-…` or `CLIENT-…` for API clients), not names. Sometimes missing.
- **stats gotcha:** `numRunsSuccessful` is always 0. The real counter is **`numRunsSuccess`**, plus numRuns, numRunsFailed, lastExecutionTime(Success/Failed), lastExecutionId*. Keys are absent on never-run workflows: default to 0.
- `GET /workflows/{id}` **does include `labels`** (contradicts skill); `description` is absent. `definitionAsl` missing on 7.
- `workflowAlias` == `workflowName` on all 89 and unique.
- Definition size: median 6 KB, max 123 KB, none > 350 KB.
- **Table Updater captured** (9 real workflows). Node in `workflowConfig.steps`: `{"stepId":"table_updater_1","type":"TABLE_UPDATER","name":"Table updater","retryAttempts":0,"target":"workflow-table-updater","childSteps":[]}`. stepConfig: `{"command":"UPDATE","customTableName":"<table>","primaryKeys":[...]}`. Input is the previous step's output: an array of row objects (values can be arrays/booleans). Only `UPDATE` seen.
- A REST API step can call `api.vince.live` via connection `CONNECTION-39b7d8c3ed26462ca00c71ccca88f114` (used for `POST /live/custom-tables/search/...` with an ES query body). Whether that connection may call `/workflows` is untested.
- The skill schema is a drafting subset: real builder-saved workflows fail it (TABLE_UPDATER, null descriptions, optional flags false, `tags: {"_type":"SYSTEM"}`). For cloning, pass `definition` through untouched; Live's POST validator is the authority.

## Confirmed 2026-10-02, part 2: lookup endpoints (all GET, all 200)
- `/users` (userId, email, group e.g. "TenantAdmin"; firstName/lastName only on some), `/users/me`, `/api-clients` (clientId, apiClientName, roles[] of ROLE ids; `createdBy: CLIENT-<clientId>`), `/environments` (environmentId, code, environmentName, description), `/connections` (connectionId, connectionName, environmentId), `/groups` + `/groups/{id}`, `/roles` + `/roles/{id}`.
- `/v1/...` variants, `/me`, `/tenants`, `/permissions` -> 403.
- Roles hold `permissions: [{vrn, action}]`. Only wildcards seen: `vrn:<TENANT>:fnd:workflow:*`. Per-workflow form `...:fnd:workflow:<WORKFLOW-id>` is assumed, not seen. Users carry no role list; API clients do.
- Environments: PRD, STG, EDU, DEV, TST. 73 workflows on DEV, 8 corrupted, 8 none. **Only one M3 connection exists, in DEV**, so retargeting to another environment needs a connection there first.
- **All 5 groups point only at deleted workflow ids** (GET -> 404). Deleting a workflow does not clean its group. Since every publish/rollback creates a new id, the app must update group membership or groups go stale.
- Connection `CONNECTION-39b7…` used by the Peppol REST steps no longer exists (GET /connections/{id} -> 404). Those workflows likely fail.
- List paging params (`limit`, `size`, `pageSize`) are ignored; still 89/89.

## Confirmed 2026-10-02, part 3: live writes + HAR (`vince-services2.vince.live.har`, gitignored)
- **Publish works end to end.** `node probe/publish-test.mjs WORKFLOW-1360ade0… --go` created `WORKFLOW-869ad56396a14ab68feaa729d614589f` "M3 API Catalog Sync 2 1.0". Live ignored our id and assigned its own; the definition read back byte-identical. GET omits `description`/`labels` only when they are empty. Test copy still exists: delete in UI when done.
- UI lists with `GET /workflows?limit=1000` and `GET /users?limit=500`.
- **Role permissions name workflows and groups by ALIAS/NAME, not id**: `vrn:<TENANT>:fnd:workflow:<workflowAlias>`, `vrn:<TENANT>:fnd:group:<groupName>`. Actions: `*`, `READ`, `WRITE`. Consequence: a new version alias ("X 2.0") gets no direct grants automatically; a recreated workflow with an old alias inherits them.
- **`PUT /roles`** (no id in path), body = full role incl. `roleId` and the complete `permissions` array (replaces it). Confirmed by our own write: added `READ fnd:workflow:M3 API Catalog Sync 2 1.0` to role "Everything" (before-state in `probe/out/writes/role-before.json`).
- **`POST /groups`** captured (create, 201). **Adding to an existing group: not captured.** `PUT /groups` -> 403 gateway "missing equal-sign" error (= no such route). Per-id variants not tried; needs a UI capture.
- Connections have `system`: `M3` ("Vince Demo system", DEV) or `VinceLive` ("Vince API", TST, baseUri `https://api.vince.live`). Environment switch must map connections of the same `system`; currently no environment besides DEV has an M3 connection.
- The TST `VinceLive` connection is a candidate for a workflow calling the Live API itself (publish from inside Live). Untested.

## QOL requirements (Haakon, 2026-10-02)
- Search workflows by name and by user (created/modified by).
- Sort by environment.
- Search by M3 API used (program or program/transaction).
- New-version dialog: choose roles, environment and group for the new version.
- Always show current roles, environment and group clearly.
- Implemented as pure logic in `lib/catalog.mjs` (`buildCatalog`, `search`) and `lib/snapshot.mjs` (`environmentOptions`, `retarget`). Try with `node lib/try-catalog.mjs --api MMS200MI --sort environment`.
- M3 API search needs every definition (one GET per workflow). 89 GETs took a few seconds; cache in a Custom Table if it gets slow.
- **Blocked on writes:** no confirmed endpoint to add a workflow to a group, or to grant a role access to one workflow. CORS lists PUT/DELETE. Capture both from the UI with DevTools open.

## Risks found
- **38 of 89 workflows are `EXPRESS`** (incl. UI-built ones like Peppol_*). Skill says POSTing EXPRESS creates a broken, unreachable workflow. `toPostBody` refuses them for now. Converting to STANDARD is untested and may change runtime behaviour. Needs a decision + test.
- 8 MMS120 workflows have a corrupted environment id `yENVIRONMENT-…`; per skill this passes creation but breaks M3 API steps. Flagged by `snapshotWarnings`.

## Next steps
1. Haakon: open "M3 API Catalog Sync 2 1.0" in the builder and run it (confirms the copy renders + executes, not just that POST returned 200). Then delete it.
2. Haakon: UI capture of adding a workflow to an EXISTING group (HAR as before). Remaining write gap.
3. Haakon: the App Builder skill is not loaded in this Claude Code session; make it available (or paste it) so the brief follows its format.
4. Test EXPRESS: POST one as STANDARD and see if it runs the same; decide policy.
5. Test whether the TST VinceLive connection (CONNECTION-143ce…) lets a REST API step call `GET`/`POST /workflows` (in-Live publish).
6. Environment switch: needs an M3 connection in a second environment to test for real.
7. Versions table design (see below), then create it.
8. Update Lucid draft 2: rollback box -> "create new copy from snapshot"; overview data source = `GET /workflows?limit=1000`.

## Versions table proposal (not created)
- Name `workflow-versions`, `UPSERT`, `enforceSchema: false`, primaryKeys `["baseAlias","version"]` (immutable!).
- Columns: baseAlias, version (number), workflowId (of the created copy), sourceWorkflowId, workflowName, action (`publish`|`rollback`), rolledBackFrom (version), notes, publishedBy, publishedAt, workflowType, definitionBytes, snapshot (string: JSON of `toSnapshot` output).
- Version number comes from this table (max+1 for baseAlias), not parsed from names. Name parsing is only a fallback for workflows with no history.
- Row size limit unverified (`__id` encoding `#0#DATA#` hints at DynamoDB, 400 KB item). Largest definition 123 KB fits; verify with a real write of the 123 KB one.

## Open questions
- Paging on `GET /workflows` for big tenants?
- EXPRESS policy (above).
- Can the self connection call `/workflows`? Otherwise how does App Builder trigger a publish?
- Does App Builder have its own design tokens?
- API key vs bearer: how is it passed? (unverified)

## Gotchas
- Custom Table duplicate keys overwrite silently; check row count after writes.
- Token decides tenant; a mismatched connectionId fails silently with empty results.
- App Builder has zero confirmed facts in the skill: do not invent its format.
