import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPostgresOrganizationStore } from "../src/organization/postgres-organization-store.ts";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createOrganizationService } from "../src/organization/organization-service.ts";
import type {
  AccessGroup,
  AccessGroupMember,
  AuthIdentity,
  OrganizationUser,
  OrgUnit,
  OrgUnitMember,
} from "../src/organization/organization-store.ts";
import type { AuditEvent } from "../src/audit/audit-log.ts";
import type { Skill } from "../src/skills/skill-store.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres organization-store tests";

beforeEach(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query(
    "DROP TABLE IF EXISTS directory_view_roots, directory_view_policies, skill_access_policies, acl_grants, acl_grants_version, skills, durable_map_versions, org_unit_members, org_unit_closure, org_units, access_group_members, access_groups, organization_authz_state, auth_identities, organization_users, organization_identity_status, deactivated_principals, organization_operation_results, organization_legacy_runtime_eligible, organization_schema_migrations, organization_database_owner, participants CASCADE",
  );
  await p.end();
});

async function rawRows(text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  try {
    return (await p.query(text, params)).rows as Record<string, unknown>[];
  } finally {
    await p.end();
  }
}

const user = (over: Partial<OrganizationUser> = {}): OrganizationUser => ({
  orgId: "org1",
  principalId: "U1",
  email: "alice@example.com",
  displayName: "Alice",
  jobTitle: null,
  mobile: null,
  employeeNumber: null,
  status: "active",
  sessionVersion: 1,
  profileRevision: 1,
  createdAt: 100,
  updatedAt: 100,
  lastLoginAt: null,
  createdBy: "admin",
  updatedBy: "admin",
  ...over,
});

const identity = (over: Partial<AuthIdentity> = {}): AuthIdentity => ({
  orgId: "org1",
  issuer: "https://idp.example.com",
  subject: "sub-1",
  principalId: "U1",
  emailAtLink: "alice@example.com",
  createdAt: 100,
  updatedAt: 100,
  ...over,
});

test(
  "pg organization store: putUser upserts on (org, principal); getUser and listUsers round-trip",
  { skip },
  async () => {
    const store = createPostgresOrganizationStore(URL!);
    assert.equal(await store.getUser("org1", "U1"), null);

    await store.putUser(user());
    await store.putUser(user());
    assert.deepEqual(await store.getUser("org1", "U1"), user());
    assert.equal((await store.listUsers("org1")).length, 1, "put dedups on (org, principal)");

    await store.putUser(user({ displayName: "Alice Cooper", updatedAt: 200, lastLoginAt: 150 }));
    const got = await store.getUser("org1", "U1");
    assert.equal(got!.displayName, "Alice Cooper");
    assert.equal(got!.lastLoginAt, 150);
    assert.equal((await store.listUsers("org1")).length, 1, "second put is an upsert, not an insert");

    await store.putUser(user({ orgId: "org2" }));
    assert.equal((await store.listUsers("org1")).length, 1);
    assert.equal((await store.listUsers("org2")).length, 1, "listUsers is org-scoped");
    assert.equal(await store.getUser("org1", "missing"), null);
  },
);

test("pg organization store: findUserByEmail is case-insensitive and org-scoped", { skip }, async () => {
  const store = createPostgresOrganizationStore(URL!);
  await store.putUser(user({ email: "Alice@Example.com" }));
  assert.equal((await store.findUserByEmail("org1", "alice@example.COM"))!.principalId, "U1");
  assert.equal(await store.findUserByEmail("org2", "alice@example.com"), null);
  assert.equal(await store.findUserByEmail("org1", "nobody@example.com"), null);
});

test("pg organization store: legacy runtime eligibility is a canonical one-time snapshot", { skip }, async () => {
  await rawRows("CREATE TABLE participants(principal_id TEXT NOT NULL)");
  await rawRows("INSERT INTO participants(principal_id) VALUES($1), ($2), ($3)", [
    " Legacy@Example.com ",
    "legacy@example.com",
    " U-legacy ",
  ]);
  const store = createPostgresOrganizationStore(URL!);
  assert.equal(await store.legacyRuntimeAccessEligible("LEGACY@example.com"), true);
  assert.equal(await store.legacyRuntimeAccessEligible("U-legacy"), true);
  assert.equal(await store.legacyRuntimeAccessEligible("missing"), false);
  assert.equal((await rawRows("SELECT person_key FROM organization_legacy_runtime_eligible")).length, 2);

  await rawRows("INSERT INTO participants(principal_id) VALUES($1)", ["late@example.com"]);
  const restarted = createPostgresOrganizationStore(URL!);
  assert.equal(await restarted.legacyRuntimeAccessEligible("late@example.com"), false);
});

test("pg organization store: user search is filtered, bounded, assignable, and org-scoped", { skip }, async () => {
  const store = createPostgresOrganizationStore(URL!);
  await store.putUser(user({ principalId: "U-alice", displayName: "Alice Zhang" }));
  await store.putUser(user({ principalId: "U-alina", email: "alina@example.com", displayName: "Alina" }));
  await store.putUser(
    user({
      principalId: "U-deleted",
      email: "alice.deleted@example.com",
      status: "deprovisioned",
      sessionVersion: 2,
    }),
  );
  await store.putUser(user({ principalId: "U-pending", email: "alice.pending@example.com", status: "invited" }));
  await store.putUser(user({ principalId: "U-paused", email: "alice.paused@example.com", status: "suspended" }));
  await store.putUser(user({ orgId: "org2", principalId: "U-other", displayName: "Alice Other" }));
  assert.deepEqual(
    (await store.searchUsers("org1", "ali", 1)).map((candidate) => candidate.principalId),
    ["U-alice"],
  );
  assert.deepEqual(
    (await store.searchUsers("org1", "example.com", 20)).map((candidate) => candidate.principalId),
    ["U-alice", "U-alina"],
  );
  assert.deepEqual(
    (
      await store.searchDirectoryUsers("org1", {
        query: "ali",
        unitIds: null,
        excludePrincipalIds: ["U-alice"],
        after: null,
        limit: 1,
      })
    ).users.map((candidate) => candidate.principalId),
    ["U-alina"],
  );
  await store.putUser(user({ principalId: "U-literal", email: "literal%_@example.com", displayName: "Literal %_" }));
  assert.deepEqual(
    (await store.searchUsers("org1", "%_", 20)).map((candidate) => candidate.principalId),
    ["U-literal"],
  );
});

test("pg organization store: session versions cannot regress", { skip }, async () => {
  const store = createPostgresOrganizationStore(URL!);
  await store.putUser(user({ status: "suspended", sessionVersion: 4, updatedAt: 400 }));
  await store.putUser(user({ status: "suspended", sessionVersion: 4, displayName: "Profile refresh", updatedAt: 450 }));
  await assert.rejects(
    () => store.putUser(user({ status: "active", sessionVersion: 4, updatedAt: 500 })),
    (error: unknown) => (error as { code?: string }).code === "40001",
  );
  await assert.rejects(
    () => store.putUser(user({ status: "active", sessionVersion: 3, updatedAt: 500 })),
    (error: unknown) => (error as { code?: string }).code === "40001",
  );
  const stored = await store.getUser("org1", "U1");
  assert.equal(stored?.status, "suspended");
  assert.equal(stored?.sessionVersion, 4);
});

test(
  "pg organization store: user status and identity projections commit together across old and new writers",
  { skip },
  async () => {
    const store = createPostgresOrganizationStore(URL!);
    await store.putUser(user());
    assert.deepEqual(await rawRows("SELECT id FROM deactivated_principals WHERE id = $1", ["U1"]), []);
    await rawRows(
      "UPDATE organization_users SET status = 'suspended', session_version = 2, updated_at = 200 WHERE org_id = 'org1' AND principal_id = 'U1'",
    );
    assert.deepEqual(
      await rawRows(
        "SELECT json ->> 'status' AS status, json ->> 'sessionVersion' AS version FROM organization_identity_status WHERE id = $1",
        ["U1"],
      ),
      [{ status: "deactivated", version: "2" }],
    );
    assert.deepEqual(
      await rawRows("SELECT json ->> 'sessionVersion' AS version FROM deactivated_principals WHERE id = $1", ["U1"]),
      [{ version: "2" }],
    );
    await assert.rejects(
      () => rawRows("DELETE FROM deactivated_principals WHERE id = $1", ["U1"]),
      (error: unknown) => (error as { code?: string }).code === "40001",
    );
    await rawRows("UPDATE deactivated_principals SET json = json - 'sessionVersion' WHERE id = $1", ["U1"]);
    assert.deepEqual(
      await rawRows("SELECT json ->> 'sessionVersion' AS version FROM deactivated_principals WHERE id = $1", ["U1"]),
      [{ version: "2" }],
    );
    await store.putUser(user({ status: "active", sessionVersion: 3, updatedAt: 300 }));
    assert.deepEqual(await rawRows("SELECT id FROM deactivated_principals WHERE id = $1", ["U1"]), []);
    await assert.rejects(
      () =>
        rawRows(
          "INSERT INTO deactivated_principals(id, json) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET json = EXCLUDED.json",
          ["U1", JSON.stringify({ principalId: "U1", source: "manual", status: "deactivated", at: 400 })],
        ),
      (error: unknown) => (error as { code?: string }).code === "40001",
    );
    assert.deepEqual(
      await rawRows(
        "SELECT json ->> 'status' AS status, json ->> 'sessionVersion' AS version FROM organization_identity_status WHERE id = $1",
        ["U1"],
      ),
      [{ status: "active", version: "3" }],
    );
  },
);

test("pg organization store: user creator fields and identity bindings are immutable", { skip }, async () => {
  const store = createPostgresOrganizationStore(URL!);
  await store.putUser(user());
  await assert.rejects(
    () => store.putUser(user({ createdAt: 101 })),
    (error: unknown) => (error as { code?: string }).code === "23514",
  );
  await assert.rejects(
    () => store.putUser(user({ createdBy: "other-admin" })),
    (error: unknown) => (error as { code?: string }).code === "23514",
  );
  await store.putUser(user({ principalId: "U2", email: "two@example.com" }));
  await store.putIdentity(identity());
  await store.putIdentity(identity({ emailAtLink: "updated@example.com", updatedAt: 200 }));
  await assert.rejects(
    () => store.putIdentity(identity({ principalId: "U2", updatedAt: 300 })),
    (error: unknown) => (error as { code?: string }).code === "23514",
  );
  await assert.rejects(
    () => store.putIdentity(identity({ createdAt: 99, updatedAt: 300 })),
    (error: unknown) => (error as { code?: string }).code === "23514",
  );
});

test(
  "pg organization store: duplicate email rejected within an org, allowed across orgs; null emails exempt",
  { skip },
  async () => {
    const store = createPostgresOrganizationStore(URL!);
    await store.putUser(user({ email: "alice@example.com" }));
    await assert.rejects(
      () => store.putUser(user({ principalId: "U2", email: "ALICE@example.com" })),
      (e: unknown) => (e as { code?: string }).code === "23505",
      "unique index rejects a case-variant duplicate email in the same org",
    );

    await store.putUser(user({ principalId: "U2", orgId: "org2", email: "alice@example.com" }));
    await store.putUser(user({ principalId: "U3", email: null }));
    await store.putUser(user({ principalId: "U4", email: null }));
    assert.equal((await store.listUsers("org1")).length, 3, "other orgs and null emails coexist");
  },
);

test("pg organization store: identities round-trip keyed by (org, issuer, subject)", { skip }, async () => {
  const store = createPostgresOrganizationStore(URL!);
  await store.putUser(user());
  assert.equal(await store.getIdentity("org1", "https://idp.example.com", "sub-1"), null);

  await store.putIdentity(identity());
  assert.deepEqual(await store.getIdentity("org1", "https://idp.example.com", "sub-1"), identity());

  await store.putIdentity(identity({ emailAtLink: "new@example.com", updatedAt: 200 }));
  const got = await store.getIdentity("org1", "https://idp.example.com", "sub-1");
  assert.equal(got!.emailAtLink, "new@example.com", "putIdentity upserts on (org, issuer, subject)");

  await store.putIdentity(identity({ subject: "sub-2" }));
  assert.equal((await store.getIdentity("org1", "https://idp.example.com", "sub-2"))!.subject, "sub-2");
  assert.equal(await store.getIdentity("org1", "https://idp.example.com", "missing"), null);
  assert.equal(await store.getIdentity("org2", "https://idp.example.com", "sub-1"), null);
});

test("pg organization store: rows survive a second store instance", { skip }, async () => {
  const boot1 = createPostgresOrganizationStore(URL!);
  await boot1.putUser(user({ principalId: "U-durable" }));
  await boot1.putIdentity(identity({ principalId: "U-durable", subject: "sub-durable" }));

  const boot2 = createPostgresOrganizationStore(URL!);
  assert.equal((await boot2.getUser("org1", "U-durable"))!.principalId, "U-durable");
  assert.equal((await boot2.getIdentity("org1", "https://idp.example.com", "sub-durable"))!.principalId, "U-durable");
});

test("pg organization store: Skill Access policy and grants are durable and guarded", { skip }, async () => {
  const orgId = "org-skill-access";
  const store = createPostgresOrganizationStore(URL!, { exclusiveOrgId: orgId });
  await store.ensureOrgRoot({ orgId, name: "Skill Org", actor: "admin", now: 1 });
  await store.putUser(user({ orgId, principalId: "owner", email: "owner@example.com" }));
  await store.putUser(user({ orgId, principalId: "reader", email: "reader@example.com" }));
  const skill: Skill = {
    id: "skill-pg-access",
    orgId,
    scopeId: "personal:owner",
    manifest: {
      name: "pg-access",
      description: "Postgres access fixture",
      requiredCapabilities: [],
      body: "Run the fixture",
    },
    signature: "fixture-signature",
    status: "published",
    createdBy: "owner",
    version: 1,
    grantedCapabilities: [],
    approvals: ["owner"],
    createdAt: 1,
    updatedAt: 1,
  };
  await store.transact(orgId, async (tx) => {
    await tx.putSkill(skill);
    await tx.putSkillAccessPolicy({
      orgId,
      skillId: skill.id,
      ownerScopeId: skill.scopeId,
      mode: "home",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      updatedBy: "owner",
    });
    await tx.markSkillAccessEnforced(orgId, 1, 1);
    await tx.bumpRevision(orgId);
  });
  await store.transact(orgId, async (tx) => {
    await tx.putSkillAccessPolicy({
      orgId,
      skillId: skill.id,
      ownerScopeId: skill.scopeId,
      mode: "restricted",
      revision: 2,
      createdAt: 1,
      updatedAt: 2,
      updatedBy: "owner",
    });
    await tx.replaceSkillAccessGrants(orgId, skill.id, [
      {
        orgId,
        ownerScopeId: skill.scopeId,
        path: `skill:${skill.id}`,
        granteeScopeId: "personal:reader",
        permission: "read",
        grantedBy: "owner",
        grantedAt: 2,
      },
    ]);
    await tx.bumpRevision(orgId);
  });
  const second = createPostgresOrganizationStore(URL!, { exclusiveOrgId: orgId });
  assert.equal((await second.getSkillAccessPolicy(orgId, skill.id))?.mode, "restricted");
  assert.equal((await second.listSkillAccessGrants(orgId, skill.id))[0]?.granteeScopeId, "personal:reader");
  assert.equal(await second.getSkillAccessPolicyVersion(orgId), 1);
  await assert.rejects(
    () =>
      rawRows(
        `INSERT INTO acl_grants(org_id, owner_scope_id, path, grantee_scope_id, permission, granted_by, granted_at)
         VALUES($1, $2, $3, $4, 'read', 'owner', 3)`,
        [orgId, skill.scopeId, `skill:${skill.id}`, "personal:missing"],
      ),
    (error: unknown) => (error as { code?: string }).code === "23514",
  );
});

test("pg organization store: Skill Access replacement coordinates an empty-set legacy writer", { skip }, async () => {
  const orgId = "org-skill-access-lock";
  const store = createPostgresOrganizationStore(URL!, { exclusiveOrgId: orgId });
  await store.ensureOrgRoot({ orgId, name: "Skill Lock Org", actor: "admin", now: 1 });
  for (const principalId of ["owner", "old-reader", "new-reader"]) {
    await store.putUser(user({ orgId, principalId, email: `${principalId}@example.com` }));
  }
  const skill: Skill = {
    id: "skill-pg-access-lock",
    orgId,
    scopeId: "personal:owner",
    manifest: {
      name: "pg-access-lock",
      description: "Postgres access lock fixture",
      requiredCapabilities: [],
      body: "Run the lock fixture",
    },
    signature: "fixture-signature",
    status: "published",
    createdBy: "owner",
    version: 1,
    grantedCapabilities: [],
    approvals: ["owner"],
    createdAt: 1,
    updatedAt: 1,
  };
  await store.transact(orgId, async (tx) => {
    await tx.putSkill(skill);
    await tx.putSkillAccessPolicy({
      orgId,
      skillId: skill.id,
      ownerScopeId: skill.scopeId,
      mode: "restricted",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      updatedBy: "owner",
    });
    await tx.markSkillAccessEnforced(orgId, 1, 1);
  });
  const path = `skill:${skill.id}`;
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL, application_name: "skill-access-legacy-race-test" });
  const legacy = await pool.connect();
  let committed = false;
  try {
    await legacy.query("BEGIN");
    await legacy.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`acl-grants:${skill.scopeId}\n${path}`]);
    const selected = await legacy.query(
      "SELECT 1 FROM acl_grants WHERE (org_id = $1 OR org_id IS NULL) AND owner_scope_id = $2 AND path = $3 FOR UPDATE",
      [orgId, skill.scopeId, path],
    );
    assert.equal(selected.rowCount, 0);
    let settled = false;
    const replacement = store
      .transact(orgId, (tx) =>
        tx.replaceSkillAccessGrants(orgId, skill.id, [
          {
            orgId,
            ownerScopeId: skill.scopeId,
            path,
            granteeScopeId: "personal:new-reader",
            permission: "read",
            grantedBy: "owner",
            grantedAt: 3,
          },
        ]),
      )
      .finally(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(settled, false);
    await legacy.query(
      `INSERT INTO acl_grants(org_id, owner_scope_id, path, grantee_scope_id, permission, granted_by, granted_at)
       VALUES($1, $2, $3, $4, 'read', 'owner', 2)`,
      [orgId, skill.scopeId, path, "personal:old-reader"],
    );
    await legacy.query("COMMIT");
    committed = true;
    await replacement;
    assert.deepEqual(
      (await store.listSkillAccessGrants(orgId, skill.id)).map((grant) => grant.granteeScopeId),
      ["personal:new-reader"],
    );
  } finally {
    if (!committed) await legacy.query("ROLLBACK").catch(() => undefined);
    legacy.release();
    await pool.end();
  }
});

test(
  "pg organization store: legacy Skill and ACL writers remain safe after Skill Access cutover",
  { skip },
  async () => {
    const orgId = "org-legacy-skill";
    const store = createPostgresOrganizationStore(URL!, { exclusiveOrgId: orgId });
    await store.ensureOrgRoot({ orgId, name: "Legacy Skill Org", actor: "admin", now: 1 });
    await store.transact(orgId, async (tx) => {
      await tx.markSkillAccessEnforced(orgId, 1, 1);
    });
    await store.putUser(user({ orgId, principalId: "owner", email: "owner@example.com" }));
    await store.putUser(user({ orgId, principalId: "reader", email: "reader@example.com" }));
    const legacySkill = {
      id: "legacy-skill",
      scopeId: "personal:owner",
      manifest: { name: "legacy", description: "Legacy", requiredCapabilities: [], body: "Legacy body" },
      signature: "legacy-signature",
      status: "published",
      createdBy: "owner",
      version: 1,
      grantedCapabilities: [],
      approvals: [],
    };
    await rawRows("INSERT INTO skills(id, json) VALUES($1, $2)", [legacySkill.id, JSON.stringify(legacySkill)]);
    assert.equal((await store.transact(orgId, (tx) => tx.getSkill(orgId, legacySkill.id)))?.orgId, orgId);
    assert.equal((await store.getSkillAccessPolicy(orgId, legacySkill.id))?.mode, "home");
    const revisionAfterCreate = await store.getAuthzRevision(orgId);
    await rawRows("UPDATE skills SET json = jsonb_set(json, '{scopeId}', to_jsonb($2::text)) WHERE id = $1", [
      legacySkill.id,
      "personal:new-owner",
    ]);
    assert.equal((await store.getSkillAccessPolicy(orgId, legacySkill.id))?.ownerScopeId, "personal:new-owner");
    assert.ok((await store.getAuthzRevision(orgId)) > revisionAfterCreate);
    const policyAfterMove = (await store.getSkillAccessPolicy(orgId, legacySkill.id))!;
    const revisionAfterMove = await store.getAuthzRevision(orgId);
    await rawRows("UPDATE skills SET json = jsonb_set(json, '{lastUsedAt}', to_jsonb(123::bigint)) WHERE id = $1", [
      legacySkill.id,
    ]);
    assert.equal((await store.getSkillAccessPolicy(orgId, legacySkill.id))?.revision, policyAfterMove.revision);
    assert.equal(await store.getAuthzRevision(orgId), revisionAfterMove);
    await rawRows(
      `INSERT INTO acl_grants(owner_scope_id, path, grantee_scope_id, permission, granted_by)
     VALUES('personal:owner', 'file:legacy', 'personal:reader', 'read', 'owner')`,
    );
    assert.deepEqual(await rawRows("SELECT org_id, granted_at IS NOT NULL AS stamped FROM acl_grants"), [
      { org_id: orgId, stamped: true },
    ]);
    await store.transact(orgId, async (tx) => {
      await tx.putSkillAccessPolicy({
        ...policyAfterMove,
        mode: "restricted",
        revision: policyAfterMove.revision + 1,
        updatedAt: 4,
        updatedBy: "owner",
      });
    });
    const policyBeforeLegacyGrant = (await store.getSkillAccessPolicy(orgId, legacySkill.id))!;
    const authzBeforeLegacyGrant = await store.getAuthzRevision(orgId);
    await rawRows(
      `INSERT INTO acl_grants(owner_scope_id, path, grantee_scope_id, permission, granted_by)
       VALUES('personal:new-owner', $1, 'personal:reader', 'read', 'owner')`,
      [`skill:${legacySkill.id}`],
    );
    assert.equal(
      (await store.getSkillAccessPolicy(orgId, legacySkill.id))?.revision,
      policyBeforeLegacyGrant.revision + 1,
    );
    assert.equal(await store.getAuthzRevision(orgId), authzBeforeLegacyGrant + 1);
    const policyBeforeLegacyRevoke = (await store.getSkillAccessPolicy(orgId, legacySkill.id))!;
    const authzBeforeLegacyRevoke = await store.getAuthzRevision(orgId);
    await rawRows("DELETE FROM acl_grants WHERE path = $1", [`skill:${legacySkill.id}`]);
    assert.equal(
      (await store.getSkillAccessPolicy(orgId, legacySkill.id))?.revision,
      policyBeforeLegacyRevoke.revision + 1,
    );
    assert.equal(await store.getAuthzRevision(orgId), authzBeforeLegacyRevoke + 1);
    await rawRows("DELETE FROM skills WHERE id = $1", [legacySkill.id]);
    assert.equal(await store.getSkillAccessPolicy(orgId, legacySkill.id), null);
  },
);

test("pg organization store: a production database is bound to one organization", { skip }, async () => {
  const first = createPostgresOrganizationStore(URL!, { exclusiveOrgId: "org1" });
  await first.putUser(user());
  await assert.rejects(() => first.putUser(user({ orgId: "org2" })), /organization store is bound to org1/);
  await assert.rejects(
    () =>
      rawRows(
        `INSERT INTO organization_users(
           org_id, principal_id, email, display_name, status, session_version,
           created_at, updated_at, last_login_at, created_by, updated_by
         ) VALUES('org2', 'U-old-writer', NULL, 'Old writer', 'active', 1, 1, 1, NULL, 'old', 'old')`,
      ),
    (error: unknown) =>
      (error as { code?: string }).code === "23514" &&
      (error as Error).message.includes("organization database belongs to org1, not org2"),
  );
  const foreignSkill = {
    id: "foreign-skill",
    orgId: "org2",
    scopeId: "personal:foreign",
    manifest: { name: "foreign", description: "Foreign", requiredCapabilities: [], body: "Foreign" },
    signature: "foreign-signature",
    status: "published",
    createdBy: "foreign",
    version: 1,
    grantedCapabilities: [],
    approvals: [],
  };
  await assert.rejects(
    () => rawRows("INSERT INTO skills(id, json) VALUES($1, $2)", [foreignSkill.id, JSON.stringify(foreignSkill)]),
    (error: unknown) =>
      (error as { code?: string }).code === "23514" &&
      (error as Error).message.includes("organization database belongs to org1, not org2"),
  );
  assert.deepEqual(await rawRows("SELECT id FROM organization_identity_status WHERE id = 'U-old-writer'"), []);
  const second = createPostgresOrganizationStore(URL!, { exclusiveOrgId: "org2" });
  await assert.rejects(() => second.putUser(user({ orgId: "org2" })), /organization database already belongs to org1/);
});

test("pg organization store: owner binding detects organization-tagged Skills", { skip }, async () => {
  const legacy = createPostgresOrganizationStore(URL!);
  await legacy.listUsers("org1");
  const foreignSkill = {
    id: "foreign-only-skill",
    orgId: "org2",
    scopeId: "personal:foreign",
    manifest: { name: "foreign-only", description: "Foreign", requiredCapabilities: [], body: "Foreign" },
    signature: "foreign-signature",
    status: "published",
    createdBy: "foreign",
    version: 1,
    grantedCapabilities: [],
    approvals: [],
  };
  await rawRows("INSERT INTO skills(id, json) VALUES($1, $2)", [foreignSkill.id, JSON.stringify(foreignSkill)]);
  const production = createPostgresOrganizationStore(URL!, { exclusiveOrgId: "org1" });
  await assert.rejects(() => production.listUsers("org1"), /organization database contains data for org2/);
  assert.deepEqual(await rawRows("SELECT org_id FROM organization_database_owner"), []);
});

test("pg organization store: owner binding and legacy writes share one lock", { skip }, async () => {
  const store = createPostgresOrganizationStore(URL!);
  await store.listUsers("org1");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL, application_name: "organization-owner-race-test" });
  const owner = await pool.connect();
  try {
    await owner.query("BEGIN");
    await owner.query("SELECT pg_advisory_xact_lock(hashtext('organization-database-owner'))");
    const legacyWrite = pool.query(
      `INSERT INTO organization_users(
         org_id, principal_id, email, display_name, status, session_version,
         created_at, updated_at, last_login_at, created_by, updated_by
       ) VALUES('org2', 'U-racing-writer', NULL, 'Racing writer', 'active', 1, 1, 1, NULL, 'old', 'old')`,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await owner.query("INSERT INTO organization_database_owner(singleton, org_id) VALUES(TRUE, 'org1')");
    await owner.query("COMMIT");
    await assert.rejects(
      () => legacyWrite,
      (error: unknown) =>
        (error as { code?: string }).code === "23514" &&
        (error as Error).message.includes("organization database belongs to org1, not org2"),
    );
    assert.deepEqual(await rawRows("SELECT id FROM organization_identity_status WHERE id = 'U-racing-writer'"), []);
  } finally {
    owner.release(true);
    await pool.end();
  }
});

test("pg organization store: rejected owner binding cannot commit identity projection", { skip }, async () => {
  const legacy = createPostgresOrganizationStore(URL!);
  await legacy.putUser(user({ orgId: "org2", principalId: "U-foreign" }));
  await rawRows("DELETE FROM organization_identity_status WHERE id = 'U-foreign'");
  await rawRows("DELETE FROM organization_schema_migrations WHERE id = 'organization_identity_projection_v1'");
  const production = createPostgresOrganizationStore(URL!, { exclusiveOrgId: "org1" });
  await assert.rejects(() => production.listUsers("org1"), /organization database contains data for org2/);
  assert.deepEqual(await rawRows("SELECT id FROM organization_identity_status WHERE id = 'U-foreign'"), []);
  assert.deepEqual(
    await rawRows("SELECT id FROM organization_schema_migrations WHERE id = 'organization_identity_projection_v1'"),
    [],
  );
  assert.deepEqual(await rawRows("SELECT org_id FROM organization_database_owner"), []);
});

test(
  "pg organization service: concurrent login and suspension cannot reactivate or overwrite the suspension",
  { skip },
  async () => {
    const org = "org-login-suspend-concurrent";
    const firstAudit = createPostgresAuditLog(URL!);
    const secondAudit = createPostgresAuditLog(URL!);
    const firstStore = createPostgresOrganizationStore(URL!, { auditLog: firstAudit });
    const secondStore = createPostgresOrganizationStore(URL!, { auditLog: secondAudit });
    await firstStore.putUser(user({ orgId: org, principalId: "U-race", email: "race@example.com" }));
    await firstStore.putIdentity(
      identity({ orgId: org, principalId: "U-race", subject: "sub-race", emailAtLink: "race@example.com" }),
    );
    const first = createOrganizationService({
      store: firstStore,
      orgId: org,
      admission: "invite_only",
      autoJoinDomains: [],
      auditLog: firstAudit,
      identity: createIdentityService(),
    });
    const second = createOrganizationService({
      store: secondStore,
      orgId: org,
      admission: "invite_only",
      autoJoinDomains: [],
      auditLog: secondAudit,
      identity: createIdentityService(),
    });

    await Promise.all([
      first.login({
        principalId: "untrusted-claim",
        issuer: "https://idp.example.com",
        subject: "sub-race",
        email: "race@example.com",
        emailVerified: true,
        displayName: "Race Login",
      }),
      second.setStatus({ principalId: "U-race", status: "suspended", actor: "admin" }),
    ]);

    const final = await firstStore.getUser(org, "U-race");
    assert.equal(final?.status, "suspended");
    assert.equal(final?.sessionVersion, 2);
  },
);

test("pg organization service: concurrent first identity binding admits exactly one subject", { skip }, async () => {
  const org = "org-login-bind-concurrent";
  const firstAudit = createPostgresAuditLog(URL!);
  const secondAudit = createPostgresAuditLog(URL!);
  const firstStore = createPostgresOrganizationStore(URL!, { auditLog: firstAudit });
  const secondStore = createPostgresOrganizationStore(URL!, { auditLog: secondAudit });
  await firstStore.putUser(
    user({
      orgId: org,
      principalId: "legacy@example.com",
      email: "legacy@example.com",
      createdBy: "system:migration",
      updatedBy: "system:migration",
    }),
  );
  const service = (store: ReturnType<typeof createPostgresOrganizationStore>, auditLog: typeof firstAudit) =>
    createOrganizationService({
      store,
      orgId: org,
      admission: "invite_only",
      autoJoinDomains: [],
      auditLog,
      identity: createIdentityService(),
    });
  const login = (subject: string) => ({
    principalId: "legacy@example.com",
    issuer: "https://idp.example.com",
    subject,
    email: "legacy@example.com",
    emailVerified: true,
    displayName: "Legacy User",
  });

  const results = await Promise.all([
    service(firstStore, firstAudit).login(login("subject-one")),
    service(secondStore, secondAudit).login(login("subject-two")),
  ]);

  assert.deepEqual(results.map((result) => result.status).sort(), ["denied", "ok"]);
  assert.equal((await firstStore.listIdentitiesForUser(org, "legacy@example.com")).length, 1);
});

const unit = (over: Partial<OrgUnit> = {}): OrgUnit => ({
  orgId: "org-tree",
  id: "unit-a",
  parentId: "root",
  name: "Unit A",
  kind: "department",
  status: "active",
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  createdBy: "admin",
  updatedBy: "admin",
  ...over,
});

const unitMember = (over: Partial<OrgUnitMember> = {}): OrgUnitMember => ({
  orgId: "org-tree",
  unitId: "unit-a",
  principalId: "U1",
  role: "member",
  createdAt: 1,
  createdBy: "admin",
  ...over,
});

const group = (over: Partial<AccessGroup> = {}): AccessGroup => ({
  orgId: "org-tree",
  id: "grp-a",
  name: "Group A",
  status: "active",
  createdAt: 1,
  updatedAt: 1,
  createdBy: "admin",
  updatedBy: "admin",
  ...over,
});

const groupMember = (over: Partial<AccessGroupMember> = {}): AccessGroupMember => ({
  orgId: "org-tree",
  groupId: "grp-a",
  principalId: "U1",
  role: "member",
  createdAt: 1,
  createdBy: "admin",
  ...over,
});

const auditEvent = (orgId: string, action: string): AuditEvent => ({
  at: 1,
  principalId: "admin",
  action,
  resource: "unit:root",
  scopeLabel: `org:${orgId}`,
  orgId,
});

async function assertClosureMatchesParentWalk(orgId: string): Promise<void> {
  const units = await rawRows("SELECT id, parent_id FROM org_units WHERE org_id = $1", [orgId]);
  const closure = await rawRows("SELECT ancestor_id, descendant_id, depth FROM org_unit_closure WHERE org_id = $1", [
    orgId,
  ]);
  const parentOf = new Map(units.map((u) => [u.id as string, u.parent_id as string | null]));
  const byDescendant = new Map<string, Map<string, number>>();
  for (const row of closure) {
    const key = row.descendant_id as string;
    if (!byDescendant.has(key)) byDescendant.set(key, new Map());
    byDescendant.get(key)!.set(row.ancestor_id as string, Number(row.depth));
  }
  const childrenOf = new Map<string | null, string[]>();
  for (const u of units) {
    const p = u.parent_id as string | null;
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p)!.push(u.id as string);
  }
  const reached: string[] = [];
  const walk = (id: string) => {
    reached.push(id);
    for (const child of childrenOf.get(id) ?? []) walk(child);
  };
  walk("root");
  assert.deepEqual(
    [...reached].sort(),
    units.map((u) => u.id as string).sort(),
    "walking from root reaches every unit exactly once (acyclic, connected)",
  );
  for (const u of units) {
    const id = u.id as string;
    const expected = new Map<string, number>();
    let current: string | null = id;
    let depth = 0;
    while (current !== null) {
      expected.set(current, depth);
      depth += 1;
      current = parentOf.get(current) ?? null;
    }
    assert.deepEqual(byDescendant.get(id) ?? new Map(), expected, `closure rows for ${id} match the parent walk`);
  }
}

test("pg org tree: ensureOrgRoot creates root and revision 1, second call is a no-op", { skip }, async () => {
  const org = "org-ensure-root";
  const store = createPostgresOrganizationStore(URL!);
  await store.ensureOrgRoot({ orgId: org, name: "Acme", actor: "admin", now: 10 });
  const root = await store.getUnit(org, "root");
  assert.equal(root?.kind, "organization");
  assert.equal(root?.parentId, null);
  assert.equal(root?.status, "active");
  assert.equal(root?.createdAt, 10);
  assert.equal(await store.getAuthzRevision(org), 1);
  assert.equal(await store.isDescendant(org, "root", "root"), true, "root self-row in closure");

  await store.ensureOrgRoot({ orgId: org, name: "Renamed", actor: "admin", now: 20 });
  const again = await store.getUnit(org, "root");
  assert.equal(again?.name, "Acme");
  assert.equal(again?.createdAt, 10);
  assert.equal((await store.listUnits(org)).length, 1);
  assert.equal(await store.getAuthzRevision(org), 1);
});

test("pg org tree: ensureOrgRoot never regresses an existing revision", { skip }, async () => {
  const org = "org-ensure-root-bump";
  const store = createPostgresOrganizationStore(URL!);
  await store.transact(org, async (tx) => {
    await tx.bumpRevision(org);
  });
  assert.equal(await store.getAuthzRevision(org), 2);
  await store.ensureOrgRoot({ orgId: org, name: "Acme", actor: "admin", now: 10 });
  assert.equal(await store.getAuthzRevision(org), 2, "bootstrap never clobbers a concurrent bump");
  const root = await store.getUnit(org, "root");
  assert.equal(root?.kind, "organization");
  assert.equal(root?.status, "active");
});

test("pg org tree: ensureOrgRoot repairs a missing authorization state row", { skip }, async () => {
  const store = createPostgresOrganizationStore(URL!);
  await store.ensureOrgRoot({ orgId: "org1", name: "Acme", actor: "admin", now: 1 });
  await rawRows("DELETE FROM organization_authz_state WHERE org_id = 'org1'");
  assert.equal(await store.getAuthzRevision("org1"), 0);
  await store.ensureOrgRoot({ orgId: "org1", name: "Acme", actor: "admin", now: 2 });
  assert.equal(await store.getAuthzRevision("org1"), 1);
});

test(
  "pg org tree: putUnit maintains closure self-rows, isDescendant and listSubtreeUnitIds reflect the tree",
  { skip },
  async () => {
    const org = "org-closure-basic";
    const store = createPostgresOrganizationStore(URL!);
    await store.ensureOrgRoot({ orgId: org, name: "Acme", actor: "admin", now: 1 });
    await store.putUnit(unit({ orgId: org, id: "unit-a" }));
    await store.putUnit(unit({ orgId: org, id: "unit-b", parentId: "unit-a" }));
    assert.equal(await store.isDescendant(org, "root", "unit-b"), true);
    assert.equal(await store.isDescendant(org, "root", "root"), true, "self-row");
    assert.equal(await store.isDescendant(org, "unit-b", "root"), false);
    assert.equal(await store.isDescendant(org, "unit-b", "unit-a"), false);
    assert.deepEqual((await store.listSubtreeUnitIds(org, "root")).sort(), ["root", "unit-a", "unit-b"]);
    assert.deepEqual(await store.listSubtreeUnitIds(org, "unit-b"), ["unit-b"]);
    assert.equal((await store.getUnit(org, "unit-b"))?.name, "Unit A");

    await store.putUnit(unit({ orgId: org, id: "unit-b", parentId: "unit-a", name: "Unit B v2", updatedAt: 2 }));
    assert.equal((await store.getUnit(org, "unit-b"))?.name, "Unit B v2", "putUnit upserts");
    assert.equal((await store.listUnits(org)).length, 3, "upsert does not duplicate");
    await assertClosureMatchesParentWalk(org);
  },
);

test("pg org tree: transact moveUnitSubtree re-links the subtree and keeps closure self-rows", { skip }, async () => {
  const org = "org-move";
  const store = createPostgresOrganizationStore(URL!);
  await store.ensureOrgRoot({ orgId: org, name: "Acme", actor: "admin", now: 1 });
  await store.putUnit(unit({ orgId: org, id: "unit-a" }));
  await store.putUnit(unit({ orgId: org, id: "unit-c" }));
  await store.putUnit(unit({ orgId: org, id: "unit-b", parentId: "unit-a" }));
  await store.putUnit(unit({ orgId: org, id: "unit-b1", parentId: "unit-b" }));
  await store.transact(org, async (tx) => {
    await tx.moveUnitSubtree(org, "unit-b", "unit-c");
  });
  assert.equal((await store.getUnit(org, "unit-b"))?.parentId, "unit-c");
  assert.equal(await store.isDescendant(org, "unit-c", "unit-b1"), true);
  assert.equal(await store.isDescendant(org, "unit-a", "unit-b1"), false);
  assert.equal(await store.isDescendant(org, "unit-b", "unit-b1"), true);
  assert.equal(await store.isDescendant(org, "unit-b1", "unit-b1"), true, "self-row intact");
  assert.equal(await store.isDescendant(org, "root", "unit-b1"), true);
  assert.deepEqual((await store.listSubtreeUnitIds(org, "unit-c")).sort(), ["unit-b", "unit-b1", "unit-c"]);
  await assertClosureMatchesParentWalk(org);
});

test("pg org tree: direct legacy writes cannot commit a parent and closure mismatch", { skip }, async () => {
  const store = createPostgresOrganizationStore(URL!);
  const org = "org-legacy-closure";
  await store.ensureOrgRoot({ orgId: org, name: "Root", actor: "test", now: 1 });
  await store.putUnit(unit({ orgId: org, id: "a", parentId: "root" }));
  await store.putUnit(unit({ orgId: org, id: "b", parentId: "root" }));
  await assert.rejects(
    () => rawRows("UPDATE org_units SET parent_id = $1 WHERE org_id = $2 AND id = $3", ["a", org, "b"]),
    (error: unknown) => (error as { code?: string }).code === "23514",
  );
  assert.equal((await store.getUnit(org, "b"))?.parentId, "root");
  await assertClosureMatchesParentWalk(org);
});

test("pg org tree: database guards enforce assignable memberships and unit final state", { skip }, async () => {
  const store = createPostgresOrganizationStore(URL!);
  const org = "org-state-guards";
  await store.ensureOrgRoot({ orgId: org, name: "Root", actor: "test", now: 1 });
  await store.putUser(user({ orgId: org, principalId: "U1" }));
  await store.putUser(user({ orgId: org, principalId: "U2", email: "u2@example.com" }));
  await store.putUnit(unit({ orgId: org, id: "parent" }));
  await store.putUnit(unit({ orgId: org, id: "child", parentId: "parent" }));
  await assert.rejects(
    store.putUnit(unit({ orgId: org, id: "parent", status: "archived" })),
    (error: unknown) => (error as { code?: string }).code === "23514",
  );
  await store.putUnit(unit({ orgId: org, id: "child", parentId: "parent", status: "archived" }));
  await store.putUnitMember(unitMember({ orgId: org, unitId: "parent", principalId: "U1" }));
  await assert.rejects(
    store.putUnit(unit({ orgId: org, id: "parent", status: "archived" })),
    (error: unknown) => (error as { code?: string }).code === "23514",
  );
  await store.putUser(user({ orgId: org, principalId: "U1", status: "deprovisioned", sessionVersion: 2 }));
  await store.putUnit(unit({ orgId: org, id: "parent", status: "archived" }));
  await assert.rejects(
    store.putUnitMember(unitMember({ orgId: org, unitId: "parent", principalId: "U2" })),
    (error: unknown) => (error as { code?: string }).code === "23514",
  );
  await assert.rejects(
    store.putUnitMember(unitMember({ orgId: org, unitId: "parent", principalId: "U1", role: "manager" })),
    (error: unknown) => (error as { code?: string }).code === "23514",
  );
  await assert.rejects(
    store.putUnit(unit({ orgId: org, id: "blocked-child", parentId: "parent" })),
    (error: unknown) => (error as { code?: string }).code === "23514",
  );
  await assert.rejects(
    store.putUser(user({ orgId: org, principalId: "U1", status: "active", sessionVersion: 3, updatedAt: 300 })),
    (error: unknown) => (error as { code?: string }).code === "23514",
  );
  await store.removeUnitMember(org, "parent", "U1");
  await store.putUser(user({ orgId: org, principalId: "U1", status: "active", sessionVersion: 3, updatedAt: 300 }));
  await assert.rejects(
    store.putUnit(unit({ orgId: org, id: "root", parentId: null, status: "archived" })),
    /org root must remain active/,
  );
  await assert.rejects(
    () =>
      rawRows(
        `WITH removed AS (
           DELETE FROM org_unit_closure WHERE org_id = $1 AND ancestor_id = 'root' AND descendant_id = 'root'
         )
         DELETE FROM org_units WHERE org_id = $1 AND id = 'root'`,
        [org],
      ),
    (error: unknown) => (error as { code?: string }).code === "23514",
  );
});

test("pg org tree: new transactions yield to legacy row-first writers without deadlocking", { skip }, async () => {
  const store = createPostgresOrganizationStore(URL!);
  const org = "org-legacy-lock-order";
  await store.ensureOrgRoot({ orgId: org, name: "Root", actor: "test", now: 1 });
  await store.putUnit(unit({ orgId: org, id: "unit-a" }));
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  const legacy = await pool.connect();
  let committed = false;
  try {
    await legacy.query("BEGIN");
    await legacy.query("SELECT id FROM org_units WHERE org_id = $1 AND id IN ($2, $3) ORDER BY id FOR UPDATE", [
      org,
      "root",
      "unit-a",
    ]);
    const current = (await store.getUnit(org, "unit-a"))!;
    const nextWrite = store.putUnit({ ...current, name: "New writer", updatedAt: 300 });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const locks = await rawRows(
        `SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory'
            AND granted
            AND classid = hashtext('organization-authz')::oid
            AND objid = hashtext($1)::oid`,
        [org],
      );
      if (locks.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (attempt === 99) assert.fail("new writer did not acquire the organization advisory lock");
    }
    await legacy.query("UPDATE org_units SET name = 'Legacy writer' WHERE org_id = $1 AND id = 'unit-a'", [org]);
    await legacy.query("COMMIT");
    committed = true;
    await nextWrite;
    assert.equal((await store.getUnit(org, "unit-a"))?.name, "New writer");
  } finally {
    if (!committed) await legacy.query("ROLLBACK").catch(() => undefined);
    legacy.release();
    await pool.end();
  }
});

test("pg organization store: identity projection follows DurableMap lock order", { skip }, async () => {
  const store = createPostgresOrganizationStore(URL!);
  const org = "org-identity-lock-order";
  await store.putUser(user({ orgId: org }));
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  const legacy = await pool.connect();
  let committed = false;
  try {
    await legacy.query("BEGIN");
    await legacy.query("SET LOCAL lock_timeout = '500ms'");
    await legacy.query(
      `INSERT INTO durable_map_versions(tbl, v) VALUES('organization_identity_status', 1)
       ON CONFLICT (tbl) DO UPDATE SET v = durable_map_versions.v + 1`,
    );
    const suspension = store.putUser(user({ orgId: org, status: "suspended", sessionVersion: 2, updatedAt: 200 }));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const locks = await rawRows(
        `SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory'
            AND granted
            AND classid = hashtext('organization-authz')::oid
            AND objid = hashtext($1)::oid`,
        [org],
      );
      if (locks.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (attempt === 99) assert.fail("organization writer did not acquire its advisory lock");
    }
    await legacy.query("UPDATE organization_identity_status SET json = json WHERE id = 'U1'");
    await legacy.query("COMMIT");
    committed = true;
    await suspension;
    assert.equal((await store.getUser(org, "U1"))?.status, "suspended");
    assert.deepEqual(
      await rawRows(
        "SELECT json ->> 'status' AS status, json ->> 'sessionVersion' AS version FROM organization_identity_status WHERE id = 'U1'",
      ),
      [{ status: "deactivated", version: "2" }],
    );
  } finally {
    if (!committed) await legacy.query("ROLLBACK").catch(() => undefined);
    legacy.release();
    await pool.end();
  }
});

test("pg org tree: store startup rejects historical closure mismatches", { skip }, async () => {
  const store = createPostgresOrganizationStore(URL!);
  const org = "org-historical-closure";
  await store.ensureOrgRoot({ orgId: org, name: "Root", actor: "test", now: 1 });
  await store.putUnit(unit({ orgId: org, id: "a", parentId: "root" }));
  await rawRows("ALTER TABLE org_unit_closure DISABLE TRIGGER organization_closure_enqueue");
  try {
    await rawRows("DELETE FROM org_unit_closure WHERE org_id = $1 AND ancestor_id = 'root' AND descendant_id = 'a'", [
      org,
    ]);
  } finally {
    await rawRows("ALTER TABLE org_unit_closure ENABLE TRIGGER organization_closure_enqueue");
  }
  await rawRows("DELETE FROM organization_schema_migrations WHERE id = 'organization_unit_closure_validated_v1'");
  const restarted = createPostgresOrganizationStore(URL!);
  await assert.rejects(
    () => restarted.getUnit(org, "a"),
    (error: unknown) => (error as { code?: string }).code === "23514",
  );
});

test(
  "pg org tree: concurrent ancestor and descendant moves remain consistent across store instances",
  { skip },
  async () => {
    const org = "org-move-concurrent";
    const first = createPostgresOrganizationStore(URL!);
    const second = createPostgresOrganizationStore(URL!);
    await first.ensureOrgRoot({ orgId: org, name: "Acme", actor: "admin", now: 1 });
    await first.putUnit(unit({ orgId: org, id: "target-a" }));
    await first.putUnit(unit({ orgId: org, id: "target-b" }));
    await first.putUnit(unit({ orgId: org, id: "ancestor" }));
    await first.putUnit(unit({ orgId: org, id: "descendant", parentId: "ancestor" }));
    await first.putUnit(unit({ orgId: org, id: "leaf", parentId: "descendant" }));

    await Promise.all([
      first.transact(org, (tx) => tx.moveUnitSubtree(org, "ancestor", "target-a")),
      second.transact(org, (tx) => tx.moveUnitSubtree(org, "descendant", "target-b")),
    ]);

    assert.equal((await first.getUnit(org, "ancestor"))?.parentId, "target-a");
    assert.equal((await first.getUnit(org, "descendant"))?.parentId, "target-b");
    assert.equal(await first.isDescendant(org, "target-b", "leaf"), true);
    assert.equal(await first.isDescendant(org, "ancestor", "leaf"), false);
    await assertClosureMatchesParentWalk(org);
  },
);

test("pg org tree: concurrent root initialization creates exactly one active root", { skip }, async () => {
  const org = "org-root-concurrent";
  const first = createPostgresOrganizationStore(URL!);
  const second = createPostgresOrganizationStore(URL!);
  await Promise.all([
    first.ensureOrgRoot({ orgId: org, name: "First", actor: "admin", now: 1 }),
    second.ensureOrgRoot({ orgId: org, name: "Second", actor: "admin", now: 2 }),
  ]);
  const roots = await rawRows(
    "SELECT id, status FROM org_units WHERE org_id = $1 AND parent_id IS NULL AND status = 'active'",
    [org],
  );
  assert.equal(roots.length, 1);
  assert.equal(await first.isDescendant(org, roots[0]!.id as string, roots[0]!.id as string), true);
});

test("pg org tree: moveUnitSubtree rejects a move under the unit's own descendant", { skip }, async () => {
  const org = "org-move-cycle";
  const store = createPostgresOrganizationStore(URL!);
  await store.ensureOrgRoot({ orgId: org, name: "Acme", actor: "admin", now: 1 });
  await store.putUnit(unit({ orgId: org, id: "unit-a" }));
  await store.putUnit(unit({ orgId: org, id: "unit-b", parentId: "unit-a" }));
  await assert.rejects(
    store.transact(org, (tx) => tx.moveUnitSubtree(org, "unit-a", "unit-b")),
    /descendant/,
  );
  await assert.rejects(
    store.transact(org, (tx) => tx.moveUnitSubtree(org, "unit-a", "unit-a")),
    /descendant|itself/,
  );
  await assert.rejects(
    store.transact(org, (tx) => tx.moveUnitSubtree(org, "missing", "root")),
    /not found/,
  );
  await assertClosureMatchesParentWalk(org);
});

test(
  "pg org tree: listManagedSubtreeUnitIds gives a manager their unit and descendants, not siblings or ancestors",
  { skip },
  async () => {
    const org = "org-managed";
    const store = createPostgresOrganizationStore(URL!);
    await store.ensureOrgRoot({ orgId: org, name: "Acme", actor: "admin", now: 1 });
    await store.putUser(user({ orgId: org, principalId: "U-mgr", email: "mgr@example.com" }));
    await store.putUser(user({ orgId: org, principalId: "U-plain", email: "plain@example.com" }));
    await store.putUnit(unit({ orgId: org, id: "unit-a" }));
    await store.putUnit(unit({ orgId: org, id: "unit-a2", parentId: "unit-a" }));
    await store.putUnit(unit({ orgId: org, id: "unit-b", parentId: "unit-a" }));
    await store.putUnit(unit({ orgId: org, id: "unit-b1", parentId: "unit-b" }));
    await store.putUnitMember(unitMember({ orgId: org, unitId: "unit-b", principalId: "U-mgr", role: "manager" }));
    await store.putUnitMember(unitMember({ orgId: org, unitId: "unit-b", principalId: "U-plain", role: "member" }));
    assert.deepEqual((await store.listManagedSubtreeUnitIds(org, "U-mgr")).sort(), ["unit-b", "unit-b1"]);
    assert.deepEqual(await store.listManagedSubtreeUnitIds(org, "U-plain"), [], "plain members manage nothing");
    assert.deepEqual(await store.listManagedSubtreeUnitIds(org, "U-absent"), []);
    await store.putUser(
      user({
        orgId: org,
        principalId: "U-mgr",
        email: "mgr@example.com",
        status: "deprovisioned",
        sessionVersion: 2,
        updatedAt: 200,
      }),
    );
    await store.putUser(
      user({
        orgId: org,
        principalId: "U-plain",
        email: "plain@example.com",
        status: "deprovisioned",
        sessionVersion: 2,
        updatedAt: 200,
      }),
    );
    await store.putUnit(unit({ orgId: org, id: "unit-b1", parentId: "unit-b", status: "archived" }));
    await store.putUnit(unit({ orgId: org, id: "unit-b", parentId: "unit-a", status: "archived" }));
    assert.deepEqual(await store.listManagedSubtreeUnitIds(org, "U-mgr"), []);
  },
);

test(
  "pg org tree: unitImpact counts active child units and members whose user exists and is not deprovisioned",
  { skip },
  async () => {
    const org = "org-impact";
    const store = createPostgresOrganizationStore(URL!);
    await store.ensureOrgRoot({ orgId: org, name: "Acme", actor: "admin", now: 1 });
    await store.putUnit(unit({ orgId: org, id: "unit-a" }));
    await store.putUnit(unit({ orgId: org, id: "unit-a1", parentId: "unit-a" }));
    await store.putUnit(unit({ orgId: org, id: "unit-a2", parentId: "unit-a", status: "archived" }));
    await store.putUser(user({ orgId: org, principalId: "U-active", email: "active@example.com", status: "active" }));
    await store.putUser(user({ orgId: org, principalId: "U-susp", email: "susp@example.com" }));
    await store.putUser(user({ orgId: org, principalId: "U-gone", email: "gone@example.com" }));
    await store.putUnitMember(unitMember({ orgId: org, unitId: "unit-a", principalId: "U-active" }));
    await store.putUnitMember(unitMember({ orgId: org, unitId: "unit-a", principalId: "U-susp" }));
    await store.putUnitMember(unitMember({ orgId: org, unitId: "unit-a", principalId: "U-gone" }));
    await store.putUnitMember(unitMember({ orgId: org, unitId: "unit-a1", principalId: "U-active" }));
    await store.putUser(
      user({
        orgId: org,
        principalId: "U-susp",
        email: "susp@example.com",
        status: "suspended",
        sessionVersion: 2,
        updatedAt: 200,
      }),
    );
    await store.putUser(
      user({
        orgId: org,
        principalId: "U-gone",
        email: "gone@example.com",
        status: "deprovisioned",
        sessionVersion: 2,
        updatedAt: 200,
      }),
    );
    const impact = await store.unitImpact(org, "unit-a");
    assert.equal(impact.activeChildUnits, 1);
    assert.equal(impact.activeMembers, 2, "member rows require a user row (FK) and count unless deprovisioned");
    assert.equal(impact.directoryRoots, 0);
    assert.equal(impact.skillGrants, 0);
  },
);

test(
  "pg org tree: transact commits audits through the audit log; failure rolls back unit, revision, and audit",
  { skip },
  async () => {
    const org = "org-tx-audit";
    await rawRows("DROP TABLE IF EXISTS audit_log CASCADE");
    const auditLog = createPostgresAuditLog(URL!);
    const store = createPostgresOrganizationStore(URL!, { auditLog });
    await store.ensureOrgRoot({ orgId: org, name: "Acme", actor: "admin", now: 1 });
    await store.putUnit(unit({ orgId: org, id: "unit-a" }));

    await store.transact(org, async (tx) => {
      await tx.audit(auditEvent(org, "org.unit.create"));
      await tx.audit(auditEvent(org, "org.unit.move"));
    });
    const committed = (await auditLog.events()).filter((e) => e.orgId === org);
    assert.deepEqual(
      committed.map((e) => e.action),
      ["org.unit.create", "org.unit.move"],
    );

    await assert.rejects(
      store.transact(org, async (tx) => {
        await tx.putUnit(unit({ orgId: org, id: "unit-a", name: "Renamed", updatedAt: 2 }));
        await tx.bumpRevision(org);
        await tx.audit(auditEvent(org, "org.unit.archive"));
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal((await store.getUnit(org, "unit-a"))?.name, "Unit A", "unit update rolled back");
    assert.equal(await store.getAuthzRevision(org), 1, "revision bump rolled back");
    assert.equal(
      (await auditLog.events()).filter((e) => e.orgId === org).length,
      2,
      "audit insert rolled back with the transaction",
    );

    const unlogged = createPostgresOrganizationStore(URL!);
    await assert.rejects(
      unlogged.transact(org, (tx) => tx.audit(auditEvent(org, "org.unit.create"))),
      /auditLog/,
      "tx.audit without a configured auditLog throws",
    );
  },
);

test("pg org tree: bumpRevision increments and returns 2, 3, ... per org", { skip }, async () => {
  const store = createPostgresOrganizationStore(URL!);
  await store.ensureOrgRoot({ orgId: "org-bump-a", name: "Acme", actor: "admin", now: 1 });
  await store.ensureOrgRoot({ orgId: "org-bump-b", name: "Other", actor: "admin", now: 1 });
  await store.transact("org-bump-a", async (tx) => {
    assert.equal(await tx.bumpRevision("org-bump-a"), 2);
    assert.equal(await tx.bumpRevision("org-bump-a"), 3);
  });
  await store.transact("org-bump-b", async (tx) => {
    assert.equal(await tx.bumpRevision("org-bump-b"), 2, "per-org counter");
  });
  assert.equal(await store.getAuthzRevision("org-bump-a"), 3);
  assert.equal(await store.getAuthzRevision("org-bump-b"), 2);
  assert.equal(await store.getAuthzRevision("org-bump-never"), 0, "no authz row yet");
});

test(
  "pg org tree: group CRUD and members round-trip, removeGroupMember removes only the target row",
  { skip },
  async () => {
    const org = "org-groups";
    const store = createPostgresOrganizationStore(URL!);
    await store.putUser(user({ orgId: org, principalId: "U1", email: "u1@example.com" }));
    await store.putUser(user({ orgId: org, principalId: "U2", email: "u2@example.com" }));
    assert.equal(await store.getGroup(org, "grp-a"), null);
    await store.putGroup(group({ orgId: org }));
    await store.putGroup(group({ orgId: "org-groups-other", id: "grp-b", name: "Group B" }));
    assert.equal((await store.getGroup(org, "grp-a"))?.name, "Group A");
    assert.deepEqual(
      (await store.listGroups(org)).map((g) => g.id),
      ["grp-a"],
      "org isolation",
    );
    await store.putGroup(group({ orgId: org, name: "Group A v2", updatedAt: 2 }));
    assert.equal((await store.getGroup(org, "grp-a"))?.name, "Group A v2", "upsert replaces");
    await store.putGroupMember(groupMember({ orgId: org, principalId: "U1" }));
    await store.putGroupMember(groupMember({ orgId: org, principalId: "U2", role: "manager" }));
    assert.equal((await store.listGroupMembers(org, "grp-a")).length, 2);
    assert.deepEqual(await store.listManagedGroupIds(org, "U2"), ["grp-a"]);
    await store.putGroup(group({ orgId: org, status: "archived" }));
    assert.deepEqual(await store.listManagedGroupIds(org, "U2"), []);
    await assert.rejects(
      store.putGroupMember(groupMember({ orgId: org, principalId: "U2", role: "member" })),
      (error: unknown) => (error as { code?: string }).code === "23514",
    );
    await store.removeGroupMember(org, "grp-a", "U1");
    const remaining = await store.listGroupMembers(org, "grp-a");
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.principalId, "U2");
    await store.removeGroupMember(org, "grp-a", "U-absent");
    assert.equal((await store.listGroupMembers(org, "grp-a")).length, 1, "removing a non-member is a no-op");
  },
);

test("pg org tree: unit members round-trip and removeUnitMember removes only the target row", { skip }, async () => {
  const org = "org-members";
  const store = createPostgresOrganizationStore(URL!);
  await store.ensureOrgRoot({ orgId: org, name: "Acme", actor: "admin", now: 1 });
  await store.putUnit(unit({ orgId: org, id: "unit-a" }));
  await store.putUser(user({ orgId: org, principalId: "U1", email: "u1@example.com" }));
  await store.putUser(user({ orgId: org, principalId: "U2", email: "u2@example.com" }));
  await store.putUnitMember(unitMember({ orgId: org, principalId: "U1" }));
  await store.putUnitMember(unitMember({ orgId: org, principalId: "U2", role: "manager" }));
  await store.putUnitMember(unitMember({ orgId: org, principalId: "U1", unitId: "root" }));
  assert.equal((await store.listUnitMembers(org, "unit-a")).length, 2);
  assert.deepEqual(
    (await store.listUnitMembersForUnits(org, ["root", "unit-a"])).map((member) => member.principalId),
    ["U1", "U1", "U2"],
  );
  await store.removeUnitMember(org, "unit-a", "U1");
  const remaining = await store.listUnitMembers(org, "unit-a");
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.principalId, "U2");
  assert.equal((await store.listUnitMembers(org, "root")).length, 1, "other units untouched");
});

test("pg org tree: closure stays consistent with the parent walk after a sequence of moves", { skip }, async () => {
  const org = "org-closure-consistency";
  const store = createPostgresOrganizationStore(URL!);
  await store.ensureOrgRoot({ orgId: org, name: "Acme", actor: "admin", now: 1 });
  await store.putUnit(unit({ orgId: org, id: "a" }));
  await store.putUnit(unit({ orgId: org, id: "b" }));
  await store.putUnit(unit({ orgId: org, id: "c", parentId: "b" }));
  await store.putUnit(unit({ orgId: org, id: "a1", parentId: "a" }));
  await store.putUnit(unit({ orgId: org, id: "a2", parentId: "a" }));
  await store.putUnit(unit({ orgId: org, id: "a1x", parentId: "a1" }));
  await assertClosureMatchesParentWalk(org);
  await store.transact(org, (tx) => tx.moveUnitSubtree(org, "a1", "c"));
  await assertClosureMatchesParentWalk(org);
  await store.transact(org, (tx) => tx.moveUnitSubtree(org, "b", "a2"));
  await assertClosureMatchesParentWalk(org);
  await store.transact(org, (tx) => tx.moveUnitSubtree(org, "a", "root"));
  await assertClosureMatchesParentWalk(org);
});

test(
  "pg org tree: concurrent sibling-swap moves serialize — exactly one wins and the closure stays acyclic",
  { skip },
  async () => {
    const org = "org-concurrent-move";
    const store = createPostgresOrganizationStore(URL!);
    await store.ensureOrgRoot({ orgId: org, name: "Acme", actor: "admin", now: 1 });
    await store.putUnit(unit({ orgId: org, id: "a" }));
    await store.putUnit(unit({ orgId: org, id: "a1", parentId: "a" }));
    await store.putUnit(unit({ orgId: org, id: "b" }));
    await store.putUnit(unit({ orgId: org, id: "b1", parentId: "b" }));
    const results = await Promise.allSettled([
      store.transact(org, (tx) => tx.moveUnitSubtree(org, "a", "b")),
      store.transact(org, (tx) => tx.moveUnitSubtree(org, "b", "a")),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "exactly one move commits");
    assert.equal(results.filter((r) => r.status === "rejected").length, 1, "the losing move is rejected");
    await assertClosureMatchesParentWalk(org);
  },
);

test("pg org tree: cross-org isolation — same unit ids in two orgs never interact", { skip }, async () => {
  const store = createPostgresOrganizationStore(URL!);
  for (const org of ["org-iso-a", "org-iso-b"]) {
    await store.ensureOrgRoot({ orgId: org, name: `Name ${org}`, actor: "admin", now: 1 });
    await store.putUnit(unit({ orgId: org, id: "shared" }));
    await store.putUnit(unit({ orgId: org, id: "child", parentId: "shared" }));
    await store.putUser(user({ orgId: org, principalId: "U1" }));
    await store.putUnitMember(unitMember({ orgId: org, unitId: "shared", principalId: "U1" }));
  }
  await store.transact("org-iso-a", async (tx) => {
    await tx.moveUnitSubtree("org-iso-a", "shared", "root");
    await tx.bumpRevision("org-iso-a");
  });
  await store.putUnit(unit({ orgId: "org-iso-a", id: "extra", parentId: "shared" }));

  assert.equal((await store.getUnit("org-iso-a", "shared"))?.parentId, "root");
  assert.equal((await store.getUnit("org-iso-b", "shared"))?.parentId, "root", "same shape, untouched rows");
  assert.equal((await store.getUnit("org-iso-b", "shared"))?.name, "Unit A");
  assert.deepEqual((await store.listSubtreeUnitIds("org-iso-a", "shared")).sort(), ["child", "extra", "shared"]);
  assert.deepEqual((await store.listSubtreeUnitIds("org-iso-b", "shared")).sort(), ["child", "shared"]);
  assert.equal((await store.unitImpact("org-iso-a", "shared")).activeMembers, 1);
  assert.equal((await store.unitImpact("org-iso-b", "shared")).activeChildUnits, 1);
  assert.equal(await store.getAuthzRevision("org-iso-a"), 2);
  assert.equal(await store.getAuthzRevision("org-iso-b"), 1, "other org revision untouched");
  await assertClosureMatchesParentWalk("org-iso-a");
  await assertClosureMatchesParentWalk("org-iso-b");
  const closureA = await rawRows("SELECT 1 FROM org_unit_closure WHERE org_id = 'org-iso-a'");
  const closureB = await rawRows("SELECT 1 FROM org_unit_closure WHERE org_id = 'org-iso-b'");
  assert.equal(closureA.length, 9, "org-iso-a closure covers exactly its own four-unit tree");
  assert.equal(closureB.length, 6, "org-iso-b closure unchanged by the other org's move and insert");
});
