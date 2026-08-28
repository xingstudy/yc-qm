# Phase 1: Internal Users and Strict Identity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist human users in Core (`organization_users` + `auth_identities`), make Portal login upsert and enforce user status, and fail closed on unknown/suspended portal principals.

**Architecture:** New `src/organization/` module (store interface + memory impl + Postgres impl + service) following the repo's existing store conventions (`createPgPool` schema arrays, `config.databaseUrl ?` wiring ternary). Portal calls a new source-auth-only Core endpoint `POST /v1/internal/auth/users/login` during the OIDC callback; Core replies with the user's status and `sessionVersion`, which the portal embeds in its session cookie and per-request portal-identity token (`sv` claim). The request gate in `src/api/server.ts` rejects portal actors that are unknown, non-active, or carry a stale `sv`.

**Spec:** `docs/organization-skill-authorization-design.md` v1.1 — sections 4.1, 6.1, 6.2, 7, 11.3 (`POST /v1/admin/org/users`, `PATCH /v1/admin/org/users/:principalId`), 11.5, 15.1, 16 (login/user-status audit events), 19 阶段一, 21.1.

**Tech Stack:** TypeScript (Node ≥24 type-stripping), `node:test`, `pg` via `src/persistence/pg-pool.ts`, no new dependencies.

## Global Constraints

- Zero comments in code (repo rule: no comments, no TODO, no suppression directives). Express intent through names.
- User statuses exactly: `invited | active | suspended | deprovisioned` (spec 4.1).
- Only `active` users get Portal sessions and business API access; `invited` users activate via first OIDC login (spec 7.2).
- `email` normalized to lowercase; unique per org when present (spec 6.1 — mandatory, invite matching depends on it).
- `display_name`: strip control characters, max 200 chars (spec 6.1).
- `session_version` increments on activation, suspend, reactivate, deprovision (spec 6.1).
- Unknown human portal principal → fail closed (spec 15.1). Service/source-auth identities unchanged.
- Auth source of truth is OIDC `issuer + subject`; email is profile/matching only (spec 6.2).
- Audit events (spec 16): login success/denied, suspended-login attempt, user status change. Use the existing async `AuditLog.record` for these Phase-1 events (transactional audit insert arrives with Phase 2+ policy writes).
- No new npm dependencies. Memory and Postgres variants both required; wiring picks via `config.databaseUrl ?`.
- Backward compatibility: default admission is `domain_auto_join` so existing deployments keep working; `invite_only` is the hardened option (spec 7.1).
- Tests: `node --experimental-test-module-mocks --test test/<file>.test.ts`; PG tests self-skip without `DATABASE_URL` and run with `--test-concurrency=1`.
- Plugins never import core code except `plugins/chassis` (repo rule).

## File Structure

- Create `src/organization/organization-store.ts` — types (`OrganizationUser`, `AuthIdentity`, `OrganizationUserStatus`), `OrganizationStore` interface, `createMemoryOrganizationStore()`.
- Create `src/organization/postgres-organization-store.ts` — `createPostgresOrganizationStore(connectionString)`.
- Create `src/organization/organization-service.ts` — `createOrganizationService(...)` with `login`, `invite`, `setStatus`, `checkActive`, `refresh`, `hydrate`.
- Create `src/api/routes/organization.ts` — `organizationRoutes`: `POST /v1/internal/auth/users/login` (auth `"source"`), `POST /v1/admin/org/users` and `PATCH /v1/admin/org/users/:principalId` (auth `"either"`, admin-checked).
- Modify `src/config.ts` — `orgAdmission`, `orgAutoJoinDomains`, `orgBootstrapUsers`.
- Modify `src/wiring.ts` — construct store + service, bootstrap seed, pass into `createApp` deps and wiring result.
- Modify `src/api/deps.ts` — `ServerDeps.organization?: OrganizationService`.
- Modify `src/api/user-scoped-routes.ts` — add `/v1/internal/auth/users/login` to `SYSTEM`.
- Modify `src/api/routes/index.ts` — register `organizationRoutes`.
- Modify `src/auth/portal-identity.ts` — `PortalIdentity` gains `sv?: number`.
- Modify `plugins/chassis/src/portal-identity.ts` — minted claims gain `sv?: number`.
- Modify `plugins/portal/src/session.ts` — `SessionClaims` gains `sv?: number`.
- Modify `plugins/portal/src/index.ts` — authCallback calls the login endpoint; session carries `sv`.
- Modify `plugins/portal/src/proxy.ts` — `proxyToSurface` forwards `sv` into minted identity.
- Modify `src/api/server.ts` — gate: portal actor must be a known active user with matching `sv`.
- Tests: `test/organization-store.test.ts`, `test/postgres-organization-store.test.ts`, `test/organization-service.test.ts`, `test/organization-routes.test.ts`, `test/organization-gate.test.ts`.

## Interfaces (contract for all tasks)

```ts
// src/organization/organization-store.ts
export type OrganizationUserStatus = "invited" | "active" | "suspended" | "deprovisioned";

export interface OrganizationUser {
  orgId: string;
  principalId: string;
  email: string | null;
  displayName: string;
  status: OrganizationUserStatus;
  sessionVersion: number;
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number | null;
  createdBy: string;
  updatedBy: string;
}

export interface AuthIdentity {
  orgId: string;
  issuer: string;
  subject: string;
  principalId: string;
  emailAtLink: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface OrganizationStore {
  getUser(orgId: string, principalId: string): Promise<OrganizationUser | null>;
  findUserByEmail(orgId: string, email: string): Promise<OrganizationUser | null>;
  listUsers(orgId: string): Promise<OrganizationUser[]>;
  putUser(user: OrganizationUser): Promise<void>;
  getIdentity(orgId: string, issuer: string, subject: string): Promise<AuthIdentity | null>;
  putIdentity(identity: AuthIdentity): Promise<void>;
}
```

```ts
// src/organization/organization-service.ts
export type OrgAdmission = "invite_only" | "domain_auto_join";

export interface LoginInput {
  principalId: string;
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string;
}

export type LoginResult =
  | { status: "ok"; user: OrganizationUser }
  | { status: "denied"; reason: "unknown" | "suspended" | "deprovisioned" | "not_invited" | "email_unverified" };

export interface ActiveCheck {
  status: OrganizationUserStatus;
  sessionVersion: number;
}

export interface OrganizationService {
  login(input: LoginInput): Promise<LoginResult>;
  invite(input: { principalId: string; email: string | null; displayName: string; actor: string }): Promise<OrganizationUser>;
  setStatus(input: { principalId: string; status: OrganizationUserStatus; actor: string }): Promise<OrganizationUser | null>;
  checkActive(principalId: string): Promise<ActiveCheck | null>;
  refresh(): Promise<void>;
  hydrate(): Promise<void>;
}
```

`createOrganizationService(deps: { store: OrganizationStore; orgId: string; admission: OrgAdmission; autoJoinDomains: readonly string[]; auditLog: AuditLog; identity: IdentityService; now?: () => number })`.

Behavior contract for `login` (decision tree, evaluated in order; every transition writes an audit event via `auditLog.record` with `scopeLabel: org:<orgId>`):

1. `identity = store.getIdentity(orgId, issuer, subject)`. If found:
   - `user = store.getUser(orgId, identity.principalId)`; missing user → `denied:"unknown"` (inconsistent state, fail closed).
   - `active` → update `displayName`/`email`/`lastLoginAt`, `putUser`, audit `org.user.login`, return `ok`.
   - `invited` → activate: `status:"active"`, `sessionVersion+1`, profile update, `putUser`, audit `org.user.activate` + `org.user.login`, return `ok` (pre-bound invite activation).
   - `suspended` / `deprovisioned` → audit `org.user.login_denied`, return `denied` with matching reason.
2. No identity, `email && emailVerified`: `invitedUser = store.findUserByEmail`; if found and `status === "invited"` → `putIdentity` linking issuer+subject to that user, activate as in (1), audit `org.user.activate`, return `ok`.
3. No identity, no invite match, `admission === "domain_auto_join"` and `emailVerified` and (`autoJoinDomains` empty or email domain ∈ `autoJoinDomains`) → create `active` user (`sessionVersion: 1`, `createdBy/updatedBy: "system:login"`) + `putIdentity`, audit `org.user.auto_join`, return `ok`.
4. Otherwise → audit `org.user.login_denied`, return `denied:"not_invited"` (or `"email_unverified"` when admission would otherwise pass but the email is unverified).

`invite` upserts an `invited` user (`sessionVersion: 1`, `createdBy/updatedBy: actor`); re-inviting an existing user returns it unchanged. `setStatus` bumps `sessionVersion`, updates `updatedBy/updatedAt`, audits `org.user.status`, and keeps the legacy deactivation map consistent: `suspended`/`deprovisioned` → `identity.deactivate(principalId, "manual")`; `active` → `identity.reactivate(principalId)`; `invited` → no identity change. `checkActive` reads a process-local `Map<string, ActiveCheck>` refreshed from `store.listUsers` with a 5 s TTL (mirroring `IdentityService.refresh`); a principal absent from the map after refresh returns `null`. Local writes update the map immediately.

---

### Task 1: Organization store types + memory implementation

**Files:**
- Create: `src/organization/organization-store.ts`
- Test: `test/organization-store.test.ts`

**Interfaces:**
- Produces: the `OrganizationStore` contract above + `createMemoryOrganizationStore(): OrganizationStore`.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryOrganizationStore, type OrganizationUser } from "../src/organization/organization-store.ts";

const user = (over: Partial<OrganizationUser> = {}): OrganizationUser => ({
  orgId: "default-org",
  principalId: "alice@acme.com",
  email: "alice@acme.com",
  displayName: "Alice",
  status: "active",
  sessionVersion: 1,
  createdAt: 1,
  updatedAt: 1,
  lastLoginAt: null,
  createdBy: "system:bootstrap",
  updatedBy: "system:bootstrap",
  ...over,
});

test("memory organization store: put/get/findByEmail/list round-trip", async () => {
  const s = createMemoryOrganizationStore();
  assert.equal(await s.getUser("default-org", "alice@acme.com"), null);
  await s.putUser(user());
  assert.equal((await s.getUser("default-org", "alice@acme.com"))?.status, "active");
  assert.equal((await s.findUserByEmail("default-org", "Alice@ACME.com"))?.principalId, "alice@acme.com");
  await s.putUser(user({ principalId: "bob@acme.com", email: "bob@acme.com", status: "invited" }));
  assert.equal((await s.listUsers("default-org")).length, 2);
  assert.equal((await s.listUsers("other-org")).length, 0, "org isolation");
  await s.putUser(user({ status: "suspended", sessionVersion: 2 }));
  assert.equal((await s.getUser("default-org", "alice@acme.com"))?.sessionVersion, 2, "upsert replaces");
});

test("memory organization store: identities are keyed by issuer+subject", async () => {
  const s = createMemoryOrganizationStore();
  assert.equal(await s.getIdentity("default-org", "https://idp", "sub-1"), null);
  await s.putIdentity({ orgId: "default-org", issuer: "https://idp", subject: "sub-1", principalId: "alice@acme.com", emailAtLink: "alice@acme.com", createdAt: 1, updatedAt: 1 });
  assert.equal((await s.getIdentity("default-org", "https://idp", "sub-1"))?.principalId, "alice@acme.com");
  assert.equal(await s.getIdentity("default-org", "https://other", "sub-1"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-test-module-mocks --test test/organization-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/organization/organization-store.ts`**

Types exactly as in the Interfaces block. Memory impl: two `Map`s keyed by `${orgId}\n${principalId}` and `${orgId}\n${issuer}\n${subject}`; `findUserByEmail` scans with lowercase compare; store defensive copies on read/write. No comments.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-test-module-mocks --test test/organization-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/organization/organization-store.ts test/organization-store.test.ts
git commit -m "feat: add organization user store types and memory implementation"
```

---

### Task 2: Postgres organization store

**Files:**
- Create: `src/organization/postgres-organization-store.ts`
- Test: `test/postgres-organization-store.test.ts`

**Interfaces:**
- Consumes: `OrganizationStore` contract (Task 1), `createPgPool` from `src/persistence/pg-pool.ts`.
- Produces: `createPostgresOrganizationStore(connectionString: string): OrganizationStore`.

- [ ] **Step 1: Write the failing test** (follow `test/postgres-admin-grants.test.ts`: `skip` without `DATABASE_URL`, `beforeEach` drops `organization_users` and `auth_identities`)

Assert: upsert round-trip; `findUserByEmail` is case-insensitive; duplicate email in same org rejected (unique index) while different orgs may share an email; identities round-trip keyed by (org, issuer, subject); rows survive a second store instance (durable).

- [ ] **Step 2: Run to verify it fails** — `node --test --test-concurrency=1 test/postgres-organization-store.test.ts` (skip-passes without DATABASE_URL; with one, fails on missing module).

- [ ] **Step 3: Implement**

Schema array (each element one statement, per `assertOneStatement`):

```sql
CREATE TABLE IF NOT EXISTS organization_users(
  org_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  email TEXT,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL,
  session_version BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  last_login_at BIGINT,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (org_id, principal_id)
)
CREATE UNIQUE INDEX IF NOT EXISTS organization_users_email ON organization_users(org_id, lower(email)) WHERE email IS NOT NULL
CREATE INDEX IF NOT EXISTS organization_users_status ON organization_users(org_id, status)
CREATE TABLE IF NOT EXISTS auth_identities(
  org_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  email_at_link TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (org_id, issuer, subject)
)
CREATE INDEX IF NOT EXISTS auth_identities_principal ON auth_identities(org_id, principal_id)
```

plus a `DO $$ ... $$` block adding the composite FK `auth_identities(org_id, principal_id) → organization_users` guarded by `pg_constraint` existence (precedent: the `DO $$` block in `src/admin/postgres-audit-log.ts`). Upserts use `INSERT ... ON CONFLICT (pk) DO UPDATE SET ... = EXCLUDED....` (precedent: `src/admin/postgres-admin-grant-store.ts`). Row mappers cast `Record<string, unknown>` columns; `Number(...)` for bigint columns.

- [ ] **Step 4: Run to verify it passes** (with `DATABASE_URL` if available; otherwise confirm skip).

- [ ] **Step 5: Commit** — `feat: add postgres organization store`

---

### Task 3: Organization service

**Files:**
- Create: `src/organization/organization-service.ts`
- Test: `test/organization-service.test.ts`

**Interfaces:**
- Consumes: `OrganizationStore` (Task 1), `AuditLog` from `src/audit/audit-log.ts`, `IdentityService` from `src/identity/identity-service.ts`.
- Produces: the `OrganizationService` contract + `createOrganizationService` signature above.

- [ ] **Step 1: Write failing tests** (memory store + `createAuditLog()` + real `createIdentityService()`), one `node:test` test per branch of the login decision tree:

1. unknown user + `invite_only` → `denied:"not_invited"`.
2. unknown + `domain_auto_join` + verified email in allowed domain → `ok`, user created `active` with `sessionVersion: 1`, identity row linked.
3. `domain_auto_join` + domain not in list → `denied:"not_invited"`.
4. `domain_auto_join` + `emailVerified: false` → `denied:"email_unverified"`.
5. invited user matched by email (case differs) → `ok`, status becomes `active`, `sessionVersion` 2, identity bound; second login with same issuer+subject hits the identity path (no email needed).
6. pre-bound invited user (invite with issuer+subject pre-linked via `store.putIdentity`) → activated on first login.
7. suspended user → `denied:"suspended"`; deprovisioned → `denied:"deprovisioned"`.
8. identity exists but user row missing → `denied:"unknown"`.
9. `setStatus` to `suspended` bumps `sessionVersion` and calls `identity.deactivate` (`identity.classify(id).type === "guest"`); back to `active` reactivates.
10. `checkActive`: unknown → `null`; active → `{ status, sessionVersion }`; after `setStatus("suspended")` → visible without waiting for TTL; two service instances over the same store converge after `refresh()`.
11. audit: login ok/denied, activate, auto_join, status change all recorded (assert via `auditLog.events()`).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** the decision tree exactly as specified in the Interfaces block. `displayName` sanitized: `name.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 200)`. `checkActive` cache: `Map<string, ActiveCheck>`, 5 s TTL refresh via `store.listUsers(orgId)`, single-flight refresh promise (mirror `IdentityService.refresh`). Local writes (`login`, `invite`, `setStatus`) update the cache immediately.

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit** — `feat: add organization service with admission, activation, and status lifecycle`

---

### Task 4: Config + wiring

**Files:**
- Modify: `src/config.ts` (near `orgId` exposure, ~line 688-737)
- Modify: `src/wiring.ts` (identity at ~418, admin grants at ~872-878 as pattern)
- Modify: `src/api/deps.ts` (`ServerDeps`, near `identity?: IdentityService` line 123)
- Test: extend `test/organization-service.test.ts` or add wiring smoke test in `test/organization-routes.test.ts` (Task 5 covers via `buildApp`).

**Interfaces:**
- Produces: `Config.orgAdmission: OrgAdmission`, `Config.orgAutoJoinDomains: string[]`, `Config.orgBootstrapUsers: string[]`; `ServerDeps.organization?: OrganizationService`; wiring result exposes `organization`.

- [ ] **Step 1: Config**

- `ORG_ADMISSION` → `orgAdmission` (`"invite_only" | "domain_auto_join"`, default `"domain_auto_join"`).
- `ORG_AUTO_JOIN_DOMAINS` → `orgAutoJoinDomains` (comma-split, trimmed, lowercased; default `[]` = delegate trust to portal's OIDC domain config).
- `ORG_BOOTSTRAP_USERS` → `orgBootstrapUsers` (comma-split principal ids, default `[]`).

- [ ] **Step 2: Wiring** — after the identity block:

```ts
const organizationStore = config.databaseUrl
  ? createPostgresOrganizationStore(config.databaseUrl)
  : createMemoryOrganizationStore();
const organization = createOrganizationService({
  store: organizationStore,
  orgId: config.orgId,
  admission: config.orgAdmission,
  autoJoinDomains: config.orgAutoJoinDomains,
  auditLog,
  identity,
});
void organization.hydrate();
for (const principalId of config.orgBootstrapUsers) {
  void organization
    .invite({ principalId, email: principalId.includes("@") ? principalId : null, displayName: principalId, actor: "system:bootstrap" })
    .then((u) => organization.setStatus({ principalId: u.principalId, status: "active", actor: "system:bootstrap" }));
}
```

(Bootstrap must be idempotent: `invite` on an existing user returns it unchanged and `setStatus(active)` on an already-active user is a no-op — make the service behave that way rather than complicating wiring.) Pass `organization` into the wiring result object and ensure `createApp` deps / `ServerDeps` carry it (trace how `identity` flows into `src/index.ts` `createServer` deps and mirror it).

- [ ] **Step 3: Typecheck** — `npm run typecheck`. Fix any `Config` type errors.

- [ ] **Step 4: Commit** — `feat: wire organization service into config and app construction`

---

### Task 5: Internal login route

**Files:**
- Create: `src/api/routes/organization.ts`
- Modify: `src/api/routes/index.ts` (spread `organizationRoutes` into `apiRoutes`)
- Modify: `src/api/user-scoped-routes.ts` (add `POST /v1/internal/auth/users/login` to `SYSTEM` — required, otherwise the gate demands a portal actor for this unclassified write)
- Test: `test/organization-routes.test.ts`

**Interfaces:**
- Consumes: `OrganizationService` (Task 3) via `ctx.deps.organization`.
- Produces: `POST /v1/internal/auth/users/login`, auth `"source"`. Request: `{ principalId, issuer, subject, email?, emailVerified?, displayName? }`. Response 200: `{ status: "ok", user: { principalId, status, sessionVersion, displayName } }` or `{ status: "denied", reason }`. 400 on missing/invalid fields; 503 when `deps.organization` absent.

- [ ] **Step 1: Write failing route tests** (pattern: `test/auth-gate.test.ts` — `buildApp(testConfig({ dataDir: mkdtempSync(...) }))`, `createServer(built.app, { signingSecret })`, sign with `signRequest`):

1. unsigned request → 401.
2. signed request with unknown user under default config (`domain_auto_join`, verified email) → 200 `{ status: "ok", user.status: "active" }`; second call with same issuer+subject → `ok` (identity path).
3. signed request with `emailVerified: false` → 200 `{ status: "denied", reason: "email_unverified" }`.
4. missing `principalId`/`issuer`/`subject` → 400.
5. `principalId: "system:plugin-skills"` → 400 or denied (service rejects `system:`-prefixed principal ids for human login — add this guard in the route: `if (principalId.startsWith("system:"))` 400).
6. `buildApp(testConfig({ ... }))` with `ORG_ADMISSION=invite_only` (extend `test/support/test-config.ts` to accept overrides) → unknown user denied `not_invited`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** the route (validate strings, `typeof emailVerified === "boolean"`, call `deps.organization.login`, `sendJson`). Register + SYSTEM entry.

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit** — `feat: add internal portal login endpoint with source auth`

---

### Task 6: Admin user management routes

**Files:**
- Modify: `src/api/routes/organization.ts`
- Test: `test/organization-routes.test.ts`

**Interfaces:**
- Produces:
  - `POST /v1/admin/org/users` — body `{ principalId, email?, displayName? }` → 200 `{ user }`; 401/403 non-admin; 400 invalid.
  - `PATCH /v1/admin/org/users/:principalId` — body `{ status }` → 200 `{ user }`; 404 unknown user; 400 invalid status.
- Both `auth: "either"`; admin authorization follows the existing `/v1/admin/*` route pattern (read `src/api/routes/admin/artifacts.ts` for how the actor's admin status is checked via `ctx.deps` admin service and mirror it exactly). Actor comes from `ctx.actor?.p` (portal identity) or capability `actorId`.

- [ ] **Step 1: Write failing tests**

1. invite creates an `invited` user (visible via a follow-up login-denied check or a service-level assert through `built.organization`).
2. invited user can then log in (login endpoint returns ok + active).
3. `PATCH` status to `suspended` → subsequent login endpoint call → `denied:"suspended"`.
4. non-admin actor → 403 (use the admin-check pattern from an existing admin route test if one exists; otherwise assert 401 without portal identity under `requireSignedPortalIdentity`).
5. invalid status string → 400.

- [ ] **Step 2-4:** Fail → implement → pass.

- [ ] **Step 5: Commit** — `feat: add admin organization user invite and status routes`

---

### Task 7: Session-version claim plumbing

**Files:**
- Modify: `plugins/chassis/src/portal-identity.ts` (claims type + mint)
- Modify: `src/auth/portal-identity.ts` (`PortalIdentity` type; verification passes claims through — confirm no field whitelist drops `sv`)
- Modify: `plugins/portal/src/session.ts` (`SessionClaims` gains `sv?: number`)
- Modify: `plugins/portal/src/proxy.ts` (`SurfaceTarget` gains `sessionVersion?: number`; `proxyToSurface` includes `sv` in `mintPortalIdentity` claims when present)
- Test: `test/organization-gate.test.ts` (created here, extended in Task 9)

- [ ] **Step 1: Failing test** — unit-level: mint a portal identity with `sv: 3` via chassis, verify via core `verifyPortalIdentity`, assert `sv === 3` survives.

Note: plugins import chassis by relative path; core has its own copy in `src/auth/portal-identity.ts`. Keep both in sync — the claims shape must match exactly.

- [ ] **Step 2-4:** Fail → implement → pass.

- [ ] **Step 5: Commit** — `feat: carry session version through portal identity claims`

---

### Task 8: Portal login upsert + session `sv`

**Files:**
- Modify: `plugins/portal/src/index.ts` (`authCallback`, ~lines 1210-1291)
- Modify: `plugins/portal/src/proxy.ts` if not done in Task 7 (call sites that build `SurfaceTarget` pass the session's `sv`)

**Interfaces:**
- Consumes: Task 5 endpoint; chassis `signedHeaders`/`withSourceAuthNonce` pattern (`plugins/chassis/src/core-client.ts`); `coreGet/corePost`-style helpers at portal `index.ts:614-618, 676-689`.

- [ ] **Step 1: Implement** (portal has no core mock in unit tests here — keep the change surgical and covered by the Task 9 integration test):

In `authCallback`, after `sub`/`name` are resolved and before the transaction `complete(..., "succeeded")`:

```ts
const email = typeof info.email === "string" ? info.email.trim().toLowerCase() : "";
const emailVerified = info.email_verified === true || info.email_verified === "true";
const issuer = typeof claims.iss === "string" ? claims.iss : OIDC.issuer;
const loginPath = withSourceAuthNonce("/v1/internal/auth/users/login", CORE_SIGNING_SECRET);
const loginRes = await fetch(`${CORE}${loginPath}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...signedHeaders(CORE_SIGNING_SECRET, "POST", loginPath, loginBody) },
  body: loginBody,
});
```

`loginBody` = JSON of `{ principalId: sub, issuer, subject: infoSub, email: email || undefined, emailVerified, displayName: name || undefined }`. Non-200 network/HTTP → `complete(stateParam, claimId, "failed")` + `fail("sign-in service temporarily unavailable", 503)`. `{ status: "denied" }` → `complete(..., "failed")` + `fail(<reason-mapped message>, 403)`. On `ok`: capture `user.sessionVersion` and `user.displayName` (prefer the core-returned display name), complete the transaction, and set the session cookie with `sv: user.sessionVersion`.

Also: where `SurfaceTarget` is constructed from the session (search `sessionVersion`/`proxyToSurface(` call sites in index.ts), pass `session.sv`.

Failure mode requirement: if core is unreachable or denies, no session cookie is issued (fail closed at the front door).

- [ ] **Step 2: Typecheck** — `npm run typecheck` (portal is part of the workspace).

- [ ] **Step 3: Commit** — `feat: upsert and enforce organization users at portal login`

---

### Task 9: Gate fail-closed for portal actors

**Files:**
- Modify: `src/api/server.ts` (portal-identity branch of `gate()`, ~lines 250-287)
- Test: `test/organization-gate.test.ts`

**Interfaces:**
- Consumes: `deps.organization` (Task 4), `PortalIdentity.sv` (Task 7).

- [ ] **Step 1: Write failing tests** (`buildApp(testConfig(...))` + `createServer(built.app, { signingSecret, capabilitySecret, portalIdentitySecret, requireSignedPortalIdentity: true, production: false })`; mint portal identities directly with `mintPortalIdentity`-equivalent core helper):

1. portal identity for a principal with no user row → 401 on a user-scoped route (e.g. `GET /v1/contexts?principalId=...`).
2. after `built.organization.invite(...)` + `setStatus("active")` → 200.
3. identity with `sv: user.sessionVersion` → 200; `sv: user.sessionVersion + 1` → 401; after `setStatus("suspended")` → 401 even with matching stale `sv`.
4. capability-token path unchanged (existing behavior tests keep passing — run `test/auth-gate.test.ts`).
5. **regression sweep**: run the full non-PG suite and fix any existing test that mints portal identities (they now need seeded active users). If many break, gate the new check behind `config.production || orgUserGate` — prefer fixing tests; only add a config escape hatch if the blast radius is genuinely large, and if added, default it ON whenever `requireSignedPortalIdentity` is on.

Gate patch (inside the portal-identity branch, after the existing `deps.identity` check):

```ts
if (actor && deps.organization) {
  const u = await deps.organization.checkActive(actor.p);
  if (!u || u.status !== "active" || (typeof actor.sv === "number" && actor.sv !== u.sessionVersion)) actor = null;
}
```

- [ ] **Step 2-4:** Fail → implement → pass, including the regression sweep (`npm test`).

- [ ] **Step 5: Commit** — `feat: fail closed on unknown or stale portal principals`

---

### Task 10: Verification pass

- [ ] **Step 1:** `npm run typecheck`
- [ ] **Step 2:** `npm run lint` (and `npm run lint:ox` if configured)
- [ ] **Step 3:** `npm test` (full non-PG suite) + `npm run test:pg` when `DATABASE_URL` is available
- [ ] **Step 4:** Fix everything found; commits as `fix:`/`test:` per change.
- [ ] **Step 5: Commit** remaining fixes.

## Self-Review Notes (completed by plan author)

- Spec coverage for 阶段一: `organization_users` (T1/T2), `auth_identities` (T1/T2), 状态管理 (T3/T6), Portal 登录 upsert + active 校验 (T5/T8), fail closed 未知人类 principal (T9), 人类 vs service 身份 (T5 `system:` guard + source-auth-only endpoint; capability path untouched), session_version (T3/T7/T8/T9), bootstrap 与 invite_only 可用性 (T4/T6), 21.1 测试条目 (T3/T5/T6/T9). 审计登录成功/拒绝/停用尝试与状态变化 (T3).
- Out of scope (later phases, do not implement): org_units/closure, access_groups, directory visibility, skill access policies, transactional audit insert, NOTIFY.
- Type consistency: `OrganizationService.checkActive` returns `ActiveCheck | null`; gate uses `u.status`/`u.sessionVersion`; portal uses `user.sessionVersion` from the login response — the route must serialize exactly these names.
- Known risk owned by T9: existing tests that mint portal identities without seeding users.
