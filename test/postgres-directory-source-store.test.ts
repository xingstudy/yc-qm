import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import { createPostgresDirectorySourceStore } from "../src/directory-sources/postgres-directory-source-store.ts";
import type {
  DirectorySyncRun,
  ManagedDirectoryPreview,
  NormalizedDirectoryMember,
  StoredDirectorySource,
} from "../src/directory-sources/types.ts";
import type { ScopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL to run the Postgres directory-source tests";

beforeEach(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  await pool.query(
    "DROP TABLE IF EXISTS directory_unit_member_ownership, directory_unit_mappings, directory_managed_previews, directory_managed_user_ownership, directory_source_units, directory_email_lookup_guards, directory_email_resolutions, directory_sync_runs, directory_source_members, directory_source_secrets, directory_sources, audit_log CASCADE",
  );
  await pool.end();
});

function source(over: Partial<StoredDirectorySource> = {}): StoredDirectorySource {
  return {
    id: "source-1",
    orgId: "org-1",
    provider: "wecom",
    name: "WeCom",
    externalTenantId: "wwcorp",
    status: "active",
    origin: "admin",
    mode: "identity_only",
    loginEnabled: true,
    syncEnabled: true,
    jitProvisioningEnabled: false,
    scheduleMinutes: 360,
    matchPolicy: "verified_corporate_email",
    capabilities: {
      login: true,
      fullSync: true,
      targetedLookup: true,
      corporateEmailSubjectLookup: true,
      trustedCorporateEmail: true,
      employeeNumber: true,
      mobile: true,
      departments: true,
    },
    publicConfig: { corpId: "wwcorp", agentId: "1000002", redirectUri: "https://agent.example.test/callback" },
    hasSecret: true,
    secretEnc: "encrypted-secret",
    environmentConfigFingerprint: null,
    revision: 1,
    previewConfirmedRevision: null,
    memberSnapshotRevision: null,
    reconciliationStatus: "not_started",
    reconciledSourceRevision: null,
    reconciledMemberSnapshotRevision: null,
    reconciledAt: null,
    reconciliationExpiresAt: null,
    lastTestAt: 1,
    lastTestStatus: "succeeded",
    createdAt: 1,
    updatedAt: 1,
    createdBy: "admin",
    updatedBy: "admin",
    ...over,
  };
}

function member(over: Partial<NormalizedDirectoryMember> = {}): NormalizedDirectoryMember {
  return {
    orgId: "org-1",
    sourceId: "source-1",
    provider: "wecom",
    externalTenantId: "wwcorp",
    externalSubjectId: "alice",
    displayName: "Alice",
    emails: [{ value: "alice@example.com", kind: "corporate", verified: true }],
    employeeNumber: "E-1",
    mobile: null,
    departmentIds: ["2"],
    status: "active",
    revision: "rev-1",
    observedAt: 1,
    profileHash: "hash-1",
    matchState: "unmatched",
    matchReason: "not_evaluated",
    matchedPrincipalId: null,
    ignoredBy: null,
    ignoredReason: null,
    lastLoginAttemptAt: null,
    ...over,
  };
}

function run(over: Partial<DirectorySyncRun> = {}): DirectorySyncRun {
  return {
    id: "run-1",
    orgId: "org-1",
    sourceId: "source-1",
    sourceRevision: 1,
    kind: "manual",
    status: "running",
    idempotencyKey: "manual-1",
    targetExternalSubjectId: null,
    counts: { observed: 0, added: 0, changed: 0, inactive: 0, unchanged: 0 },
    errorCode: null,
    errorMessage: null,
    leaseOwner: null,
    leaseExpiresAt: 1_000,
    createdAt: 1,
    startedAt: null,
    completedAt: null,
    updatedAt: 1,
    ...over,
  };
}

test("Postgres source store keeps secrets separate, enforces CAS, and isolates organizations", { skip }, async () => {
  const store = createPostgresDirectorySourceStore(URL!);
  try {
    assert.equal(await store.putSource(source({ environmentConfigFingerprint: "config-fingerprint" }), null), true);
    const read = await store.getSource("org-1", "source-1");
    assert.equal(read?.secretEnc, "encrypted-secret");
    assert.equal(read?.hasSecret, true);
    assert.equal(read?.environmentConfigFingerprint, "config-fingerprint");
    assert.equal(await store.getSource("org-2", "source-1"), null);
    assert.equal(await store.putSource(source({ revision: 2, name: "Stale" }), 99), false);
    assert.equal(await store.putSource(source({ revision: 2, name: "Updated" }), 1), true);
    assert.equal((await store.getSource("org-1", "source-1"))?.name, "Updated");
  } finally {
    await store.close();
  }
});

test("Postgres managed previews preserve mapping ownership and impact details", { skip }, async () => {
  const store = createPostgresDirectorySourceStore(URL!);
  try {
    await store.putSource(source({ mode: "managed_directory" }), null);
    const mapping = {
      orgId: "org-1",
      provider: "wecom",
      externalTenantId: "wwcorp",
      externalUnitId: "engineering",
      sourceId: "source-1",
      unitId: "manual-engineering",
      ownership: "manual" as const,
      createdAt: 10,
      updatedAt: 11,
    };
    await assert.rejects(
      () =>
        store.putUnitMapping(mapping, {
          at: 11,
          principalId: "admin",
          action: "managed_directory.unit_mapping_decide",
          resource: "source-1",
          scopeLabel: "org:org-1" as ScopeId,
          orgId: "org-1",
          actorKind: "user",
          source: "managed-directory",
          result: "success",
        }),
      /directory_source_audit_unavailable/,
    );
    assert.deepEqual(await store.listUnitMappings("org-1", "source-1"), []);
    await store.putUnitMapping(mapping);
    assert.deepEqual(await store.listUnitMappings("org-1", "source-1"), [mapping]);
    const preview: ManagedDirectoryPreview = {
      id: "preview-1",
      orgId: "org-1",
      sourceId: "source-1",
      generation: 1,
      sourceRevision: 1,
      snapshotRevision: "snapshot-1",
      organizationRevision: 4,
      identityFingerprint: "identities-1",
      mappingFingerprint: "mappings-1",
      memberFingerprint: "members-1",
      status: "ready",
      units: [
        {
          externalUnitId: "engineering",
          unitId: "manual-engineering",
          parentUnitId: "root",
          name: "Engineering",
          sortOrder: 5,
          ownership: "manual",
          collisionUnitId: "manual-engineering",
          action: "unchanged",
        },
      ],
      members: [],
      relations: [
        {
          externalSubjectId: "alice",
          principalId: "principal-1",
          externalUnitId: "engineering",
          unitId: "manual-engineering",
          primary: true,
          action: "preserve",
        },
      ],
      preserved: [{ kind: "manual_unit", resourceId: "manual-engineering", detail: "engineering" }],
      authorizationImpacts: [
        {
          externalUnitId: "engineering",
          unitId: "manual-engineering",
          activeChildUnits: 1,
          activeMembers: 2,
          directoryRoots: 3,
          accessGrants: 4,
        },
      ],
      conflicts: [],
      createdAt: 12,
      expiresAt: 13,
      committedAt: null,
      actor: "admin",
    };
    await store.putManagedPreview(preview);
    assert.deepEqual(await store.getManagedPreview("org-1", "source-1", "preview-1"), preview);
  } finally {
    await store.close();
  }
});

test("Postgres source locks cannot starve source queries under concurrent mutations", { skip }, async () => {
  const store = createPostgresDirectorySourceStore(URL!);
  let releaseFirst: (() => void) | undefined;
  let firstEntered: (() => void) | undefined;
  const release = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  let timeout: NodeJS.Timeout | undefined;
  try {
    assert.equal(await store.putSource(source(), null), true);
    const first = store.withSourceLock("org-1", "source-1", async () => {
      firstEntered?.();
      await release;
      return (await store.getSource("org-1", "source-1"))?.revision;
    });
    await entered;
    const mutations = Array.from({ length: 10 }, () => store.putSource(source({ revision: 2, updatedAt: 2 }), 1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseFirst?.();
    const completed = Promise.all([first, ...mutations]);
    const expired = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("source lock concurrency timed out")), 5_000);
    });
    const result = await Promise.race([completed, expired]);
    assert.equal(result[0], 1);
    assert.equal(result.filter((value) => value === true).length, 1);
    assert.equal(result.filter((value) => value === false).length, 9);
  } finally {
    if (timeout) clearTimeout(timeout);
    await store.close();
  }
});

test("Postgres source store upgrades and backfills the secret revision fence", { skip }, async () => {
  const initial = createPostgresDirectorySourceStore(URL!);
  assert.equal(await initial.putSource(source(), null), true);
  await initial.close();

  const pg = (await import("pg")).default;
  const oldSchema = new pg.Pool({ connectionString: URL });
  await oldSchema.query("ALTER TABLE directory_source_secrets DROP COLUMN source_revision");
  await oldSchema.end();

  const upgraded = createPostgresDirectorySourceStore(URL!);
  try {
    assert.equal((await upgraded.getSource("org-1", "source-1"))?.secretEnc, "encrypted-secret");
    assert.equal(await upgraded.putSource(source({ revision: 2, updatedAt: 2 }), 1), true);
  } finally {
    await upgraded.close();
  }

  const verified = new pg.Pool({ connectionString: URL });
  try {
    const column = await verified.query(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema=current_schema() AND table_name='directory_source_secrets' AND column_name='source_revision'`,
    );
    assert.equal(column.rows[0]?.is_nullable, "YES");
    await verified.query(
      "DELETE FROM directory_source_secrets WHERE org_id=$1 AND source_id=$2 AND purpose='provider'",
      ["org-1", "source-1"],
    );
    await verified.query(
      `INSERT INTO directory_source_secrets(org_id,source_id,purpose,secret_enc,version,updated_at)
       VALUES($1,$2,'provider',$3,1,3)`,
      ["org-1", "source-1", "legacy-writer-secret"],
    );
    const secret = await verified.query(
      "SELECT source_revision FROM directory_source_secrets WHERE org_id=$1 AND source_id=$2 AND purpose='provider'",
      ["org-1", "source-1"],
    );
    assert.equal(Number(secret.rows[0]?.source_revision), 2);
  } finally {
    await verified.end();
  }
});

test("Postgres source transactions initialize a fresh audit schema before recording", { skip }, async () => {
  const auditLog = createPostgresAuditLog(URL!);
  const store = createPostgresDirectorySourceStore(URL!, { auditLog });
  try {
    assert.equal(
      await store.putSource(source(), null, {
        at: 1,
        principalId: "admin",
        action: "directory_source.create",
        resource: "source-1",
        scopeLabel: "org:org-1",
        orgId: "org-1",
        actorKind: "user",
        result: "success",
      }),
      true,
    );
    assert.equal((await auditLog.events()).filter((event) => event.action === "directory_source.create").length, 1);
  } finally {
    await store.close();
    await (await auditLog.pool()).end();
  }
});

test(
  "Postgres snapshot preview is read-only and two complete commits atomically mark missing members inactive",
  { skip },
  async () => {
    const store = createPostgresDirectorySourceStore(URL!);
    try {
      await store.putSource(source(), null);
      await store.upsertMember(member());
      const preview = await store.replaceMembers("org-1", "source-1", [member({ externalSubjectId: "bob" })], true);
      assert.equal(preview.inactive, 0);
      assert.equal(await store.getMember("org-1", "source-1", "bob"), null);
      await store.replaceMembers("org-1", "source-1", [member({ externalSubjectId: "bob" })], false);
      assert.equal((await store.getMember("org-1", "source-1", "alice"))?.status, "active");
      await store.replaceMembers("org-1", "source-1", [member({ externalSubjectId: "bob" })], false);
      assert.equal((await store.getMember("org-1", "source-1", "alice"))?.status, "inactive");
      assert.equal((await store.getMember("org-1", "source-1", "bob"))?.status, "active");
    } finally {
      await store.close();
    }
  },
);

test("Postgres run creation is idempotent and collapses concurrent runs for one source", { skip }, async () => {
  const store = createPostgresDirectorySourceStore(URL!);
  try {
    await store.putSource(source(), null);
    const [first, replay] = await Promise.all([store.createRun(run()), store.createRun(run({ id: "run-replay" }))]);
    assert.equal(first.id, replay.id);
    const concurrent = await store.createRun(run({ id: "run-2", idempotencyKey: "manual-2" }));
    assert.equal(concurrent.id, first.id);
    const claimed = await store.claimRun("org-1", "source-1", first.id, "test-owner", 10, 100);
    assert.ok(claimed);
    await store.finishRun(
      {
        ...claimed,
        status: "succeeded",
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: 20,
        updatedAt: 20,
      },
      "test-owner",
    );
    assert.equal(await store.latestSucceededAt("org-1", "source-1"), 20);
  } finally {
    await store.close();
  }
});

test("Postgres sync completion rejects member writes after the source revision changes", { skip }, async () => {
  const store = createPostgresDirectorySourceStore(URL!);
  try {
    await store.putSource(source(), null);
    const created = await store.createRun(run({ id: "run-fenced", idempotencyKey: "manual-fenced" }));
    const claimed = await store.claimRun("org-1", "source-1", created.id, "owner", 10, 100);
    assert.ok(claimed);
    assert.equal(await store.putSource(source({ revision: 2, status: "paused", updatedAt: 11 }), 1), true);
    const completed = await store.finishRun(
      { ...claimed, status: "succeeded", completedAt: 20, updatedAt: 20 },
      "owner",
      { kind: "full", members: [member()], preview: false },
    );
    assert.equal(completed?.status, "failed");
    assert.equal(completed?.errorCode, "directory_sync_source_changed");
    assert.equal(await store.getMember("org-1", "source-1", "alice"), null);
  } finally {
    await store.close();
  }
});
