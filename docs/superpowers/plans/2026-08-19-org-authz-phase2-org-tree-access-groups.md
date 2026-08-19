# Org AuthZ Phase 2: Org Tree and Access Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the organization unit tree (closure table), unit memberships, access groups, role-delegated admin APIs, transactional audit, and Admin UI pages, per `docs/organization-skill-authorization-design.md` §19 阶段二.

**Architecture:** Extend the existing `src/organization/` module (store + service) with units/closure/members/groups/authz-revision state and a transaction primitive; extend the Postgres audit log with a transaction-client insert per design §16; expose §11.3 admin routes with org-admin / unit-manager / group-manager authorization; add two pages to the single-file Admin SPA. Memory and Postgres store implementations stay behavior-identical; PG tests run against a real database.

**Tech Stack:** TypeScript (type-stripping, `.ts` import extensions), `node:test`, `pg` via `src/persistence/pg-pool.ts`, vanilla-JS SPA in `plugins/admin/public/index.html`.

## Global Constraints

- Zero comments anywhere in code: no explanatory comments, docblocks, TODO/FIXME, lint suppressions, commented-out code. Express intent through names, structure, tests.
- Factory functions, not classes. `.ts` import extensions. No new npm dependencies.
- Every table carries `org_id`; relationship FKs are composite including `org_id` (design §6).
- Authorization writes (node create/move/archive, member changes, group changes, user status changes) must bump `organization_authz_state.revision` and write audit in the SAME database transaction (design §6.10, §16, §17). Never update the tree and refresh derived state asynchronously.
- The closure table is a derived index of `org_units.parent_id` maintained in the same transaction as every node change (design §6.3). Every node has a self-row `(ancestor_id = descendant_id, depth = 0)`.
- Exactly one active root per org; root has `parent_id = null`; root cannot be moved, archived, or deleted; a node can never be moved to itself or a descendant (design §6.3).
- Archiving a non-root unit with active child units or active members returns `409` with an impact summary (design §6.3). Directory-root and Skill-grant reference checks do not exist yet (Phases 3/4) — the impact checker must be structured so later phases plug in, and its result type must already carry those fields.
- Unit managers add/remove `member`-role members within their managed subtree only; group managers maintain their own group's `member`-role members only; no manager grants or revokes any `manager` role; tree structure and archive stay org-admin-only (design §6.4, §6.5, §11.3). All manager roles require the holder to be an `active` org user — check via `OrganizationService.checkActive` at authorization time (design §4.6).
- Cross-org, hidden, archived, or nonexistent object IDs referenced by an unauthorized caller return `404`, never `403` with existence confirmation (design §11.3, §12.4, §15.2).
- Audit events for permission changes are transactional: the change commits only if the audit insert commits (design §16). The transaction audit insert reuses the existing `idempotency_key` retry dedupe. Audit never stores OIDC tokens, cookies, or full profiles.
- Tests must run with `/root/.nvm/versions/node/v24.18.0/bin/node --experimental-test-module-mocks --test <files>` (system node 22 cannot strip types). PG tests self-skip without `DATABASE_URL`; the local container is `yc-qm-postgres-1`, database `qm_org_test`, DSN `postgres://qm:qmPass123@127.0.0.1:5432/qm_org_test`.
- Known pre-existing full-suite failures (environmental, byte-identical to clean main): PG suites bound to an unreachable fixed IP, one production-compose substitution test, one deploy-drain in-suite hang. Never "fix" tests by weakening assertions.

## Interfaces

Everything below is the contract between tasks. Later tasks consume these exact names and signatures.

### Types (added to `src/organization/organization-store.ts` in Task 2)

```ts
export type OrgUnitKind = "organization" | "department" | "team";
export type OrgUnitStatus = "active" | "archived";
export interface OrgUnit {
  orgId: string; id: string; parentId: string | null; name: string;
  kind: OrgUnitKind; status: OrgUnitStatus; sortOrder: number;
  createdAt: number; updatedAt: number; createdBy: string; updatedBy: string;
}
export type OrgMemberRole = "member" | "manager";
export interface OrgUnitMember {
  orgId: string; unitId: string; principalId: string; role: OrgMemberRole;
  createdAt: number; createdBy: string;
}
export type AccessGroupStatus = "active" | "archived";
export interface AccessGroup {
  orgId: string; id: string; name: string; status: AccessGroupStatus;
  createdAt: number; updatedAt: number; createdBy: string; updatedBy: string;
}
export interface AccessGroupMember {
  orgId: string; groupId: string; principalId: string; role: OrgMemberRole;
  createdAt: number; createdBy: string;
}
export interface UnitImpact {
  activeChildUnits: number;
  activeMembers: number;
  directoryRoots: number;
  skillGrants: number;
}
```

### Transaction handle (added to `src/organization/organization-store.ts` in Task 2)

```ts
export interface OrganizationTx {
  putUser(user: OrganizationUser): Promise<void>;
  putUnit(unit: OrgUnit): Promise<void>;
  moveUnitSubtree(orgId: string, unitId: string, newParentId: string): Promise<void>;
  putUnitMember(member: OrgUnitMember): Promise<void>;
  removeUnitMember(orgId: string, unitId: string, principalId: string): Promise<void>;
  putGroup(group: AccessGroup): Promise<void>;
  putGroupMember(member: AccessGroupMember): Promise<void>;
  removeGroupMember(orgId: string, groupId: string, principalId: string): Promise<void>;
  bumpRevision(orgId: string): Promise<number>;
  audit(event: AuditEvent): Promise<void>;
}
```

`OrganizationStore` gains (Task 2 memory / Task 3 PG):

```ts
getUnit(orgId: string, id: string): Promise<OrgUnit | null>;
listUnits(orgId: string): Promise<OrgUnit[]>;
putUnit(unit: OrgUnit): Promise<void>;
isDescendant(orgId: string, ancestorId: string, descendantId: string): Promise<boolean>;
listSubtreeUnitIds(orgId: string, unitId: string): Promise<string[]>;
listManagedSubtreeUnitIds(orgId: string, principalId: string): Promise<string[]>;
unitImpact(orgId: string, unitId: string): Promise<UnitImpact>;
listUnitMembers(orgId: string, unitId: string): Promise<OrgUnitMember[]>;
putUnitMember(member: OrgUnitMember): Promise<void>;
removeUnitMember(orgId: string, unitId: string, principalId: string): Promise<void>;
getGroup(orgId: string, id: string): Promise<AccessGroup | null>;
listGroups(orgId: string): Promise<AccessGroup[]>;
putGroup(group: AccessGroup): Promise<void>;
listGroupMembers(orgId: string, groupId: string): Promise<AccessGroupMember[]>;
putGroupMember(member: AccessGroupMember): Promise<void>;
removeGroupMember(orgId: string, groupId: string, principalId: string): Promise<void>;
getAuthzRevision(orgId: string): Promise<number>;
ensureOrgRoot(input: { orgId: string; name: string; actor: string; now: number }): Promise<void>;
transact<T>(fn: (tx: OrganizationTx) => Promise<T>): Promise<T>;
```

Memory `transact` semantics: applies mutations directly, buffers `audit` calls, flushes them to the injected `AuditLog.record` only after `fn` resolves; a throw leaves mutations applied (rollback fidelity is a Postgres-only guarantee — PG tests cover it). Memory `bumpRevision` keeps a per-org counter starting at 1.

`ensureOrgRoot` is idempotent: no-op when an active root exists; otherwise creates root unit (`id: "root"`, `kind: "organization"`, `parentId: null`) and the `organization_authz_state` row (`revision: 1`) in one transaction (PG) / atomically (memory).

### Service methods (added to `OrganizationService` in Tasks 4-5)

```ts
createUnit(input: { parentId: string | null; name: string; kind: OrgUnitKind; sortOrder?: number; actor: string }): Promise<OrgUnit>;
updateUnit(input: { unitId: string; name?: string; sortOrder?: number; actor: string }): Promise<OrgUnit | null>;
moveUnit(input: { unitId: string; newParentId: string; actor: string }): Promise<{ ok: true } | { ok: false; reason: "root" | "self_or_descendant" | "missing_parent" | "archived" }>;
archiveUnit(input: { unitId: string; actor: string }): Promise<{ ok: true } | { ok: false; reason: "root" | "conflict"; impact?: UnitImpact }>;
addUnitMember(input: { unitId: string; principalId: string; role: OrgMemberRole; actor: string }): Promise<{ ok: true } | { ok: false; reason: "missing_unit" | "missing_user" | "archived" }>;
removeUnitMember(input: { unitId: string; principalId: string; actor: string }): Promise<{ ok: true } | { ok: false; reason: "missing_unit" }>;
createGroup(input: { name: string; actor: string }): Promise<AccessGroup>;
updateGroup(input: { groupId: string; name?: string; actor: string }): Promise<AccessGroup | null>;
archiveGroup(input: { groupId: string; actor: string }): Promise<{ ok: true }>;
addGroupMember(input: { groupId: string; principalId: string; role: OrgMemberRole; actor: string }): Promise<{ ok: true } | { ok: false; reason: "missing_group" | "missing_user" | "archived" }>;
removeGroupMember(input: { groupId: string; principalId: string; actor: string }): Promise<{ ok: true } | { ok: false; reason: "missing_group" }>;
unitImpact(orgId: string, unitId: string): Promise<UnitImpact>; // re-export of store for routes
listManagedSubtreeUnitIds(principalId: string): Promise<string[]>;
```

All mutating methods run inside `store.transact`, bump the revision once per call, and write one audit event (`org.unit.create` / `org.unit.update` / `org.unit.move` / `org.unit.archive` / `org.unit.member.add` / `org.unit.member.remove` / `org.group.create` / `org.group.update` / `org.group.archive` / `org.group.member.add` / `org.group.member.remove`) with `scopeLabel: "org:"+orgId`, `principalId: actor`, `resource` naming the object. Generated unit/group IDs: `unit-<uuid>` / `grp-<uuid>` via `crypto.randomUUID()`.

`moveUnit` validation order: unit exists and active → not root → new parent exists, active, same org → new parent is not the unit itself and `isDescendant(unitId, newParentId)` is false → transact { moveUnitSubtree, bumpRevision, audit }.

`archiveUnit`: root → `{ok:false, reason:"root"}`; else `unitImpact` — if `activeChildUnits > 0 || activeMembers > 0` → `{ok:false, reason:"conflict", impact}`; else transact { putUnit(status archived), bumpRevision, audit }. `directoryRoots`/`skillGrants` in `UnitImpact` are always 0 in this phase; the store method computes them from a `referenceCheckers` list that is empty until Phases 3/4.

`addUnitMember`/`addGroupMember`: target user must exist in `organization_users` (any status except `deprovisioned` — inviting a not-yet-active user into a unit is allowed; `deprovisioned` is rejected as `missing_user`). Re-adding an existing membership updates only `role` when the caller may set that role. Membership changes do not validate the actor's own power — that is the route's job.

`setStatus` and the login-activation path (existing Phase 1 methods) are modified in Task 6: status-changing writes (`putUser` when the status or sessionVersion actually changes) go through `transact` with `bumpRevision` + transactional `audit`; the legacy `identity.deactivate/reactivate` calls stay outside the transaction (different store), in the same order as today.

### Route authorization helper (Task 7, `src/api/routes/organization.ts`)

```ts
async function authorizeOrgMembershipWrite(
  ctx: ApiCtx,
  target: { kind: "unit"; unitId: string; role: OrgMemberRole } | { kind: "group"; groupId: string; role: OrgMemberRole },
): Promise<{ actorId: string } | null>
```

Logic: org admin (existing `authorizeAdmin`) → allow. Otherwise actor must pass `organization.checkActive`, `role` must be `"member"`, and: unit target → `unitId ∈ await service.listManagedSubtreeUnitIds(actorId)`; group target → actor has `manager` row in that group. Any failure → write the response (404 when the target unit/group is missing/archived/cross-org, 403 when it is visible but power is insufficient) and return null. Structural operations (create/update/move/archive units, create/update/archive groups, any `manager`-role grant) remain org-admin-only via the existing `requireOrganizationAdmin`.

### Routes (Tasks 7-8, `src/api/routes/organization.ts`, all `auth: "either"`)

```text
GET    /v1/admin/org/units                          → { units: OrgUnit[] }
POST   /v1/admin/org/units                          { parentId, name, kind, sortOrder? }
GET    /v1/admin/org/units/:id                      → { unit: OrgUnit, members: OrgUnitMember[] }
PATCH  /v1/admin/org/units/:id                      { name?, sortOrder?, parentId?, status? }
POST   /v1/admin/org/units/:id/members              { principalId, role }
DELETE /v1/admin/org/units/:id/members/:principalId
GET    /v1/admin/org/access-groups                  → { groups: AccessGroup[] }
POST   /v1/admin/org/access-groups                  { name }
GET    /v1/admin/org/access-groups/:id              → { group: AccessGroup, members: AccessGroupMember[] }
PATCH  /v1/admin/org/access-groups/:id              { name?, status? }
POST   /v1/admin/org/access-groups/:id/members      { principalId, role }
DELETE /v1/admin/org/access-groups/:id/members/:principalId
```

PATCH semantics: `parentId` present → move path; `status: "archived"` → archive path (409 with `{ error: "conflict", impact }` body); `status: "active"` on an archived unit/group restores it (org admin only, bumps revision, audits `org.unit.update` / `org.group.update`). Validation failures map: missing/hidden → 404, `root`/`self_or_descendant`/`archived`/`missing_user` → 400 with `{ error: reason }`, move `missing_parent` → 400.

### Admin UI (Tasks 9-10, `plugins/admin/`)

Two new views in `plugins/admin/public/index.html`, registered in `SECTIONS` under the `Admin` label as `org-units` and `org-groups`, with `VIEW_TITLE` entries, `ORG_WIDE` membership, `ENDPOINT` entries, and `renderOrgUnits` / `renderOrgGroups` in the `paintData` map. Proxy: add `org-units`/`org-groups` to `READS` and `WRITES` in `plugins/admin/src/index.ts` mapping to the core routes above (member add/remove and PATCH/POST/DELETE writes).

`renderOrgUnits` per design §12.1: left column indented tree (active units only, sorted by `sortOrder`), right column selected-unit detail (name, kind, member count, manager count) with member list; actions: create child unit (name + kind + optional sort order), rename, move (parent dropdown excluding self and descendants — the server re-validates), archive (shows server-returned 409 impact summary verbatim when blocked), add member (principal id + role select), remove member. `renderOrgGroups`: group list with member counts; per-group detail with rename, archive, member add/remove. All mutations go through the existing `api(method, path, body)` helper; errors render the server `error` field. No client-side filtering of hidden nodes — the server is the only source (§12.1).

---

### Task 1: Transactional audit insert

**Files:**
- Modify: `src/audit/audit-log.ts`
- Modify: `src/admin/postgres-audit-log.ts`
- Test: `test/postgres-audit-log.test.ts` (extend existing if present — check first)

**Interfaces:**
- Consumes: existing `AuditLog` (`src/audit/audit-log.ts:14-19`), `createPgPool`/`withPgTransaction` (`src/persistence/pg-pool.ts`).
- Produces: `AuditEvent` gains optional fields `{ orgId?: string; actorKind?: string; requestId?: string; beforeDigest?: string; afterDigest?: string; source?: string; result?: string }`. `PostgresAuditLog` (the concrete return type of `createPostgresAuditLog`) gains `recordInTransaction(client: PoolClient, event: AuditEvent): Promise<void>`. `createPostgresAuditLog` keeps its current signature.

- [ ] **Step 1: Write failing tests.** In the PG audit test (self-skipping without DATABASE_URL):

```ts
test("recordInTransaction commits with the surrounding transaction and dedupes by idempotency key", async (t) => {
  if (!process.env.DATABASE_URL) return t.skip();
  const log = createPostgresAuditLog(process.env.DATABASE_URL);
  await withPgTransaction(await log.pool(), async (client) => {
    await log.recordInTransaction(client, {
      at: 1, principalId: "U-a", action: "org.unit.create", resource: "unit:root",
      scopeLabel: "org:acme", idempotencyKey: "tx-a-1",
      orgId: "acme", actorKind: "user", result: "ok",
    } as never);
  });
  const events = await log.events();
  assert.equal(events.filter((e) => e.action === "org.unit.create").length, 1);
});

test("recordInTransaction rolls back when the surrounding transaction aborts", async (t) => {
  if (!process.env.DATABASE_URL) return t.skip();
  const log = createPostgresAuditLog(process.env.DATABASE_URL);
  await assert.rejects(withPgTransaction(await log.pool(), async (client) => {
    await log.recordInTransaction(client, { at: 2, principalId: "U-a", action: "org.unit.move", resource: "unit:x", scopeLabel: "org:acme" } as never);
    throw new Error("abort");
  }));
  assert.equal((await log.events()).filter((e) => e.action === "org.unit.move").length, 0);
});
```

Expose whatever minimal accessor the test needs (e.g. `pool()`) on the concrete type — do not widen the `AuditLog` interface.

- [ ] **Step 2: Run to verify failure** (new columns/method missing).

- [ ] **Step 3: Implement.** Extend the `audit_log` DDL in `postgres-audit-log.ts` with idempotent single statements: `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS org_id text` and likewise for `actor_kind`, `request_id`, `before_digest`, `after_digest`, `source`, `result`. `recordInTransaction` runs one parameterized INSERT (including `idempotency_key` when the event carries one, relying on the existing unique partial index + `ON CONFLICT DO NOTHING`) using the passed client. Map the new columns through `events()`/`tail()` reads. The `AuditLog` interface and `record`/`recordOnce` behavior stay unchanged.

- [ ] **Step 4: Run to verify pass** (with and without DATABASE_URL).

- [ ] **Step 5: Commit** — `feat: add transactional audit insert for permission changes`

---

### Task 2: Org tree store types and memory implementation

**Files:**
- Modify: `src/organization/organization-store.ts`
- Test: `test/organization-store.test.ts` (extend)

**Interfaces:**
- Consumes: `AuditEvent`/`AuditLog` (Task 1), existing memory store.
- Produces: all types and the full extended `OrganizationStore`/`OrganizationTx` contract in the Interfaces block; `createMemoryOrganizationStore` gains an optional `{ auditLog?: AuditLog }` constructor arg used by `transact` audit flushing.

- [ ] **Step 1: Write failing tests** covering, one `node:test` each:
  1. `ensureOrgRoot` creates root + revision 1; second call is a no-op; a second root cannot be created via `putUnit` + service later (store-level: `ensureOrgRoot` only).
  2. `putUnit` maintains closure self-rows; `isDescendant(root, child)` true; `isDescendant(child, root)` false; `listSubtreeUnitIds` returns the unit and all descendants.
  3. `transact` + `moveUnitSubtree` re-links the subtree: after moving B under C, `isDescendant(C, B-child)` true and `isDescendant(A, B-child)` false; closure self-rows intact.
  4. `listManagedSubtreeUnitIds`: manager on B sees B and descendants, not siblings/ancestors.
  5. `unitImpact` counts active child units and members whose user status is not `deprovisioned`... members are counted when the membership row exists and the referenced user is missing-or-not-deprovisioned (document the choice in the test name); `directoryRoots`/`skillGrants` are 0.
  6. `transact` audit buffering: two `tx.audit` calls flush to the injected `AuditLog` after success; none flush when `fn` throws.
  7. `bumpRevision` increments and returns 2, 3, ... per org.
  8. Group CRUD + members round-trip; `removeGroupMember` removes only the target row.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** the types and memory store. Memory closure: maintain a `Map<orgId, Map<unitId, Set<ancestorId>>>` derived index updated inside `putUnit` (self-row + link to parent's ancestors) and rebuilt for the subtree inside `moveUnitSubtree` (collect subtree via parent map, then recompute each node's ancestor set from its new position). Keep it obviously correct — recompute ancestors by walking parents after applying the parent change, capped at a depth guard (e.g. 1000) that throws on cycle. Memory `transact` runs `fn` with a handle whose mutations call the store methods, buffers audits, flushes via `auditLog?.record` on success.

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit** — `feat: add org tree and access group memory store`

---

### Task 3: Postgres org tree store

**Files:**
- Modify: `src/organization/postgres-organization-store.ts`
- Test: `test/postgres-organization-store.test.ts` (extend; self-skip without DATABASE_URL)

**Interfaces:**
- Consumes: Task 1 `recordInTransaction`, Task 2 contract, `withPgTransaction`.
- Produces: `createPostgresOrganizationStore(connectionString: string, opts?: { auditLog?: PostgresAuditLog }): OrganizationStore`. Tables `org_units`, `org_unit_closure`, `org_unit_members`, `access_groups`, `access_group_members`, `organization_authz_state` per design §6.3-6.5 and §6.10 (exact columns and FKs as written there; `organization_authz_state` also carries `skill_access_policy_version integer not null default 0` and `skill_access_enforced_at bigint` for Phase 4). Indexes per §6.3 plus `org_unit_members(org_id, principal_id)` and `access_group_members(org_id, principal_id)`. DDL statements are single-statement idempotent (match the existing `CREATE TABLE IF NOT EXISTS` / `DO $$ ... pg_constraint` style already in this file).

- [ ] **Step 1: Write failing tests** (each self-skips without DATABASE_URL; use unique org ids per test):
  1. Mirror of Task 2 tests 1-8 against PG (same assertions, shared helper is fine).
  2. Closure consistency after move: query `org_unit_closure` directly and assert parent-walk agreement for every node.
  3. Concurrent moves of two sibling subtrees under each other do not produce a cycle: serialize via the transaction's row locks (`SELECT ... FOR UPDATE` on the moved units inside `transact`); assert one move wins and the closure stays acyclic (walk from root reaches every active node exactly once).
  4. Cross-org isolation: same unit id in two orgs; moves/impact in one never touch the other.
  5. `transact` rolls back everything (unit update + revision + audit) when `fn` throws mid-transaction; `tx.audit` without a configured auditLog throws.

- [ ] **Step 2: Run to verify failure** (tables missing).

- [ ] **Step 3: Implement.** `moveUnitSubtree` in one transaction: `SELECT ... FOR UPDATE` the unit row; update `parent_id`; rebuild closure with the standard two statements:

```sql
DELETE FROM org_unit_closure
 WHERE org_id = $1
   AND descendant_id IN (SELECT descendant_id FROM org_unit_closure WHERE org_id = $1 AND ancestor_id = $2)
   AND ancestor_id NOT IN (SELECT descendant_id FROM org_unit_closure WHERE org_id = $1 AND ancestor_id = $2);

INSERT INTO org_unit_closure (org_id, ancestor_id, descendant_id, depth)
SELECT $1, up.ancestor_id, sub.descendant_id, up.depth + sub.depth + 1
  FROM org_unit_closure up
  JOIN org_unit_closure sub ON sub.org_id = $1
 WHERE up.org_id = $1 AND up.descendant_id = $3 AND sub.ancestor_id = $2;
```

`bumpRevision`: `INSERT INTO organization_authz_state (org_id, revision, updated_at) VALUES ($1, 2, $2) ON CONFLICT (org_id) DO UPDATE SET revision = organization_authz_state.revision + 1, updated_at = $2 RETURNING revision`. `tx.audit` delegates to `opts.auditLog.recordInTransaction(client, event)`; without a configured auditLog it throws immediately. `ensureOrgRoot` runs its own transaction. Non-transactional methods stay single-statement via `pg.q`/`pg.query`.

- [ ] **Step 4: Run to verify pass** (real database via the local container DSN).

- [ ] **Step 5: Commit** — `feat: add postgres org tree store with closure table and transactions`

---

### Task 4: Org tree service operations

**Files:**
- Modify: `src/organization/organization-service.ts`
- Test: `test/organization-service.test.ts` (extend)

**Interfaces:**
- Consumes: Task 2 store contract.
- Produces: `createUnit`, `updateUnit`, `moveUnit`, `archiveUnit` with the exact signatures and audit action names in the Interfaces block; `createOrganizationService` unchanged signature.

- [ ] **Step 1: Write failing tests** (memory store, one per branch):
  1. Bootstrap then `createUnit` under root → unit created with closure; audit `org.unit.create`; revision bumped.
  2. `createUnit` with a second root (`parentId: null` while an active root exists) throws/rejects.
  3. `createUnit` under missing or archived parent rejects.
  4. `moveUnit` to own descendant → `{ ok: false, reason: "self_or_descendant" }`; to self → same; root move → `{ ok: false, reason: "root" }`; under archived/missing parent → respective reasons.
  5. Successful move: closure reflects new ancestry, revision bumped once, one `org.unit.move` audit.
  6. `archiveUnit` root → `root`; with active child → `conflict` with `impact.activeChildUnits: 1`; with an active member → `conflict` with `impact.activeMembers: 1`; clean unit → archived, excluded from child listings, reactivation via `updateUnit`-style restore is NOT in this task (route-level restore in Task 7 uses `putUnit` through the service's `updateUnit` status path — add `status?: OrgUnitStatus` to `updateUnit` input and test restore bumps revision + audits).
  7. Suspended user's membership still counts in `unitImpact.activeMembers` (only deprovisioned/missing users are excluded) — pin the chosen rule from Task 2 test 5 here at service level.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** per the Interfaces block validation orders. All mutations in `store.transact` with a single `bumpRevision` and a single `audit` per call. Audit `detail` carries compact JSON (`{ "unitId": "...", "parentId": "..." }`); never full profiles.

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit** — `feat: add org tree create move archive service operations`

---

### Task 5: Membership and access group service operations

**Files:**
- Modify: `src/organization/organization-service.ts`
- Test: `test/organization-service.test.ts` (extend)

**Interfaces:**
- Consumes: Task 2 contract, Task 4 service.
- Produces: `addUnitMember`, `removeUnitMember`, `createGroup`, `updateGroup`, `archiveGroup`, `addGroupMember`, `removeGroupMember`, `listManagedSubtreeUnitIds` with the exact signatures and audit action names in the Interfaces block.

- [ ] **Step 1: Write failing tests**, one per branch:
  1. Add member to unit → row with role; audit; revision. Re-add same user with `member` then `manager` → role updated, single row.
  2. Add member referencing unknown user → `missing_user`; deprovisioned user → `missing_user`; invited user → allowed.
  3. Add member to archived/missing unit → `archived`/`missing_unit`.
  4. Remove member → row gone, audit, revision; removing a non-member is a no-op success.
  5. Group lifecycle: create → rename via `updateGroup` → archive → members cannot be added (`archived`); restore via `updateGroup({ status: "active" })`.
  6. Group members: add/remove round-trip; role update on re-add; `missing_user`/`missing_group` branches.
  7. `listManagedSubtreeUnitIds` reflects the store: manager on B gets B + descendants; after B moves under C, B's manager keeps managing B's subtree and C's manager ALSO gains it (managed set derives from direct manager rows + live closure, per design §6.4 "manager 管理该节点及其后代" — controller ruling, supersedes an earlier conflicting pin in this plan).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** per the Interfaces block. Every mutation transactional with one revision bump + one audit.

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit** — `feat: add unit membership and access group service operations`

---

### Task 6: Bootstrap root and transactional user status changes

**Files:**
- Modify: `src/wiring.ts`, `src/organization/organization-service.ts`
- Test: `test/organization-service.test.ts` (extend), plus a wiring-adjacent test if a natural home exists

**Interfaces:**
- Consumes: Tasks 2-5.
- Produces: `activateBootstrapUsers` flow calls `store.ensureOrgRoot` before any user seeding; `OrganizationService.setStatus` and the login activation path write through `transact` with `bumpRevision` + transactional audit.

- [ ] **Step 1: Write failing tests:**
  1. `setStatus` active→suspended bumps revision once and its audit event is present (assert via the injected AuditLog); status writes that change nothing (same status set twice) do not bump revision.
  2. Login activation (invited→active) bumps revision; plain returning login does not.
  3. `ensureOrgRoot` called from the wiring bootstrap path: build the app via the existing `buildApp(testConfig(...))` test harness and assert `store.getUnit(orgId, "root")` exists and `getAuthzRevision(orgId) >= 1` (find the existing wiring test file that covers `ORG_BOOTSTRAP_USERS` via grep; add there).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** In `wiring.ts`, call `ensureOrgRoot({ orgId, name: config.orgId, actor: "system:bootstrap", now: Date.now() })` before `activateBootstrapUsers` (fire-and-forget `void` with the same shape as the existing calls). In `organization-service.ts`, route the status/sessionVersion-changing `putUser` calls through `store.transact` including `bumpRevision` and the audit write; keep `identity.deactivate/reactivate` outside the transaction in the current order. The existing async `auditLog.record` calls for these paths move inside the transaction (PG) / buffer-flush (memory) — no double-auditing.

- [ ] **Step 4: Run to verify pass** (full `test/organization-service.test.ts`, `test/organization-gate.test.ts`, `test/organization-routes.test.ts` — the gate depends on this service).

- [ ] **Step 5: Commit** — `feat: bootstrap org root and make user status changes transactional`

---

### Task 7: Admin routes — org units and members

**Files:**
- Modify: `src/api/routes/organization.ts`
- Test: `test/organization-routes.test.ts` (extend)

**Interfaces:**
- Consumes: Tasks 4-6, existing `requireOrganizationAdmin`, `authorizeOrgMembershipWrite` from the Interfaces block.
- Produces: the unit and unit-member routes from the Interfaces block with the exact status/error mapping.

- [ ] **Step 1: Write failing tests** (existing harness: `buildApp(testConfig(...))` + real fetch + `signRequest`; portal-identity actor helpers already exist in this file):
  1. Org admin: create unit under root → 201/200 shape `{ unit }`; list units contains it; GET detail returns unit + members.
  2. Move via PATCH `{ parentId }` → closure-updated listing; moving to own descendant → 400 `self_or_descendant`; moving root → 400 `root`.
  3. Archive clean unit → archived; archive with active member → 409 with `impact`; restore via PATCH `{ status: "active" }`.
  4. Non-admin active user WITHOUT manager role → 403 on member add.
  5. Unit manager (manager row on the unit) adds/removes a `member` in their unit → 200; same actor on an unmanaged sibling → 403; same actor requesting `role: "manager"` → 403; on an archived unit → 404.
  6. Manager on parent unit manages members in a descendant unit (subtree rule).
  7. Suspended manager → 403/401 per the gate (pin whichever the gate produces; the authorization helper must never grant).
  8. Unknown unit id → 404 for both admin-structural and member paths (no existence leak for non-admins: manager of unit A probing unit B gets 404, not 403).
  9. Member add with deprovisioned/unknown principal → 400 `missing_user`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** the routes and `authorizeOrgMembershipWrite` per the Interfaces block. Serialization: snake_case fields stay camelCase in JSON (match existing route style in this file). All routes stay under the portal-only posture the server applies to `/v1/admin/org/*`.

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit** — `feat: add admin org unit and membership routes`

---

### Task 8: Admin routes — access groups

**Files:**
- Modify: `src/api/routes/organization.ts`
- Test: `test/organization-routes.test.ts` (extend)

**Interfaces:**
- Consumes: Task 5 service, Task 7 helper.
- Produces: the access-group routes from the Interfaces block.

- [ ] **Step 1: Write failing tests**, mirroring Task 7's matrix for groups: admin CRUD; group manager maintains `member` in own group only; no manager-role grants by managers; archived → 404 for managers, restore admin-only; unknown group → 404; `missing_user` → 400.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit** — `feat: add admin access group routes`

---

### Task 9: Admin UI — org tree page

**Files:**
- Modify: `plugins/admin/public/index.html`, `plugins/admin/src/index.ts`
- Test: `plugins/admin/test/org-units.test.ts` (new; mirror `plugins/admin/test/grants.test.ts` harness)

**Interfaces:**
- Consumes: Task 7 routes, the Admin UI conventions in the Interfaces block.
- Produces: `org-units` view + proxy READS/WRITES entries.

- [ ] **Step 1: Write failing tests** (mock-core harness from grants.test.ts): unauthenticated → 401 no core hop; `GET /api/org-units` forwards to `/v1/admin/org/units` signed with actor header; create-unit POST forwards body; member DELETE forwards path. A view-render smoke test asserting the SPA HTML now contains the `org-units` view registration (match how existing view tests assert — check `onboarding-view.test.ts` / `default-view.test.ts` patterns first).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** per the Interfaces block §12.1 layout. Reuse existing CSS classes and the `api()` helper; match the file's i18n pattern (check how recent localized views register copy — the repo recently completed Chinese localization; follow the exact convention used by neighboring views).

- [ ] **Step 4: Run to verify pass** (`npm test` in `plugins/admin`).

- [ ] **Step 5: Commit** — `feat: add admin org tree management page`

---

### Task 10: Admin UI — access groups page

**Files:**
- Modify: `plugins/admin/public/index.html`, `plugins/admin/src/index.ts`
- Test: `plugins/admin/test/org-groups.test.ts` (new)

**Interfaces:**
- Consumes: Task 8 routes, Task 9 patterns.
- Produces: `org-groups` view + proxy entries.

- [ ] **Step 1: Write failing tests** mirroring Task 9's.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** per the Interfaces block.

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit** — `feat: add admin access groups page`

---

### Task 11: Phase 2 verification

**Files:** none (verification only)

- [ ] **Step 1:** typecheck + lint + lint:ox (exit 0).
- [ ] **Step 2:** Full root suite with the v24 node; compare failures against the known environmental baseline (PG-at-unreachable-IP suites, production-compose substitution, deploy-drain hang). Any NEW failure blocks this task.
- [ ] **Step 3:** PG suites against the local container (`DATABASE_URL=postgres://qm:qmPass123@127.0.0.1:5432/qm_org_test`): `npm run test:pg` plus `test/postgres-organization-store.test.ts` and `test/postgres-audit-log.test.ts` explicitly if not in that list.
- [ ] **Step 4:** `npm test` in `plugins/admin` and `plugins/portal`.
- [ ] **Step 5:** Report per-suite counts; no commits unless a fix is genuinely needed (report first).

---

## Self-Review Notes

- Spec coverage: §6.3 (Tasks 2-4), §6.4 (Tasks 2,5,7), §6.5 (Tasks 2,5,8), §6.10 (Tasks 2,3,6), §16 (Task 1 + transactional writes throughout), §17 (Tasks 3-5), §18.2 root bootstrap (Task 6), §11.3 (Tasks 7-8), §12.1 (Task 9), §21.2 tests (Tasks 2-8 matrices). Directory visibility (§6.6/§8) and Skill access (§6.7-6.9/§9/§10) are Phases 3-4 by design; `UnitImpact.directoryRoots`/`skillGrants` are deliberate forward-compatible zeros.
- The design's archive-409 references to directory roots and Skill grants cannot exist before their tables do; the `referenceCheckers` seam in `unitImpact` is the documented plug point.
- §16's new audit columns are additive nullable ALTERs — no data migration needed.
