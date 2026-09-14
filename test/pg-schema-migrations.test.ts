import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createPostgresOrganizationStore } from "../src/organization/postgres-organization-store.ts";
import { createPostgresDirectorySourceStore } from "../src/directory-sources/postgres-directory-source-store.ts";
import { createPostgresOrganizationMemberJobStore } from "../src/organization/postgres-member-job-store.ts";
import { createPostgresPortalLoginTransactionStore } from "../src/auth/portal-login-transactions.ts";
import { spawn } from "node:child_process";
import { test, type TestContext } from "node:test";
import pg, { type Pool } from "pg";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import {
  applyPgMigrations,
  definePgMigration,
  pgMigrationChecksum,
  pgSchemaMigrations,
  withPgSchemaLock,
} from "../src/persistence/pg-schema-migrations.ts";

const databaseUrl = process.env.DATABASE_URL;

function databaseTest(name: string, run: (pool: Pool, url: string, t: TestContext) => Promise<void>): void {
  test(name, { skip: databaseUrl ? false : "requires a dedicated DATABASE_URL" }, async (t) => {
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const schema = `migration_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const pool = new pg.Pool({ connectionString: url.toString() });
    try {
      await run(pool, url.toString(), t);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
}

test("migration definitions validate immutable checksums and ordered concurrent index boundaries", () => {
  assert.equal(pgMigrationChecksum([" SELECT 1 "]), pgMigrationChecksum(["SELECT 1"]));
  assert.throws(() => definePgMigration({ id: "../escape", statements: [] }), /invalid migration id/);
  assert.throws(() => definePgMigration({ id: "test/1", statements: ["SELECT 1; SELECT 2"] }), /single statement/);
  assert.throws(
    () => definePgMigration({ id: "test/1", statements: ["SELECT 1"], expectedChecksum: "bad" }),
    /source checksum mismatch/,
  );
  assert.throws(
    () => definePgMigration({ id: "test/1", statements: ["DELETE FROM data"], transactional: false }),
    /idempotent concurrent index/,
  );
  const index = "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS data_unique ON data(value)";
  assert.throws(() => definePgMigration({ id: "test/1", statements: [index] }), /nontransactional migration/);
  assert.throws(
    () => definePgMigration({ id: "test/1", statements: [index], transactional: false, legacyId: "old" }),
    /cannot adopt/,
  );
  const statements = ["CREATE TABLE data(value int)", index, "INSERT INTO data VALUES (1)"];
  const migrations = pgSchemaMigrations("test/0001", statements);
  assert.deepEqual(
    migrations.map((item) => item.id),
    ["test/0001/0000", "test/0001/0001", "test/0001/0002"],
  );
  assert.deepEqual(
    migrations.flatMap((item) => item.statements),
    statements,
  );
  assert.deepEqual(
    migrations.map((item) => item.transactional !== false),
    [true, false, true],
  );
  assert.throws(() => pgSchemaMigrations("test/0001", statements, []), /frozen bootstrap length mismatch/);
  assert.throws(() => pgSchemaMigrations("test/0001", statements, ["changed"]), /source checksum mismatch/);
});

test("schema lock destroys uncertain sessions and preserves operation plus cleanup errors", async () => {
  for (const cleanup of ["false", "error"]) {
    const released: boolean[] = [];
    const unlocks: string[] = [];
    const fake = {
      connect: async () => ({
        query: async (query: { text: string; values: string[] }) => {
          if (query.text.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
          unlocks.push(query.values[0]!);
          if (cleanup === "error") throw new Error("unlock failed");
          return { rows: [{ released: false }] };
        },
        release: (discard: boolean) => released.push(discard),
      }),
    } as unknown as Pool;
    await assert.rejects(
      withPgSchemaLock(fake, async () => {
        throw new Error("operation failed");
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 3);
        assert.match(String(error.errors[0]), /operation failed/);
        return true;
      },
    );
    assert.deepEqual(released, [true]);
    assert.deepEqual(unlocks, ["agent-platform:schema-init", "qm:schema-migrations"]);
  }
});

databaseTest(
  "named migrations adopt existing tables without a ledger and preserve rows on restart",
  async (pool, url) => {
    await pool.query("CREATE TABLE retained(value text PRIMARY KEY)");
    await pool.query("INSERT INTO retained VALUES ('existing')");
    const migration = {
      id: "test/retained/1",
      statements: [
        "CREATE TABLE IF NOT EXISTS retained(value text PRIMARY KEY)",
        "ALTER TABLE retained ADD COLUMN IF NOT EXISTS revision int DEFAULT 1",
      ],
    };
    await applyPgMigrations(pool, [migration]);
    await applyPgMigrations(pool, [migration]);
    assert.deepEqual((await pool.query("SELECT * FROM retained")).rows, [{ value: "existing", revision: 1 }]);
    assert.equal((await pool.query("SELECT * FROM qm_schema_migrations")).rowCount, 1);
    await assert.rejects(
      applyPgMigrations(pool, [{ ...migration, statements: [...migration.statements, "DELETE FROM retained"] }]),
      /checksum mismatch/,
    );
    assert.equal((await pool.query("SELECT * FROM retained")).rowCount, 1);
    const next = createPgPool(url, "test/retained/2", ["ALTER TABLE retained ADD COLUMN enabled boolean DEFAULT true"]);
    try {
      assert.equal((await next.q("SELECT * FROM retained"))[0]?.enabled, true);
    } finally {
      await next.close();
    }
  },
);

databaseTest(
  "migration failures roll back DDL and ledger then allow the same pool wrapper to retry",
  async (pool, url) => {
    const wrapper = createPgPool(url, "test/retry/1", [
      "CREATE TABLE retried(value int)",
      "INSERT INTO retried SELECT value FROM prerequisite",
    ]);
    await assert.rejects(wrapper.pool(), /prerequisite/);
    assert.equal((await pool.query("SELECT to_regclass('retried') AS name")).rows[0].name, null);
    assert.equal((await pool.query("SELECT * FROM qm_schema_migrations")).rowCount, 0);
    await pool.query("CREATE TABLE prerequisite(value int)");
    await pool.query("INSERT INTO prerequisite VALUES (42)");
    try {
      assert.deepEqual(await wrapper.q("SELECT * FROM retried"), [{ value: 42 }]);
    } finally {
      await wrapper.close();
    }
  },
);

databaseTest("legacy adoption requires the exact recorded legacy id", async (pool) => {
  await applyPgMigrations(pool, [
    { id: "test/no-legacy-table", legacyId: "missing", statements: ["CREATE TABLE first_table(value int)"] },
  ]);
  await pool.query("CREATE TABLE schema_migrations(id text PRIMARY KEY)");
  await pool.query("INSERT INTO schema_migrations VALUES ('old-applied')");
  await applyPgMigrations(pool, [
    { id: "test/adopt", legacyId: "old-applied", statements: ["SELECT * FROM deliberately_absent"] },
    { id: "test/not-adopt", legacyId: "other", statements: ["CREATE TABLE second_table(value int)"] },
  ]);
  assert.equal((await pool.query("SELECT * FROM qm_schema_migrations")).rowCount, 3);
  assert.notEqual((await pool.query("SELECT to_regclass('second_table') AS name")).rows[0].name, null);
  await assert.rejects(
    applyPgMigrations(pool, [
      { id: "test/duplicate", statements: [] },
      { id: "test/duplicate", statements: [] },
    ]),
    /duplicate migration id/,
  );
});

databaseTest(
  "failed concurrent indexes are repaired and completed indexes survive a missing ledger record",
  async (pool) => {
    await pool.query("CREATE TABLE indexed(value int)");
    await pool.query("INSERT INTO indexed VALUES (1), (1)");
    const migration = {
      id: "test/concurrent/1",
      statements: ["CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS indexed_unique ON indexed(value)"],
      transactional: false,
    };
    await assert.rejects(applyPgMigrations(pool, [migration]), /could not create unique index/);
    assert.equal(
      (await pool.query("SELECT indisvalid FROM pg_index WHERE indexrelid='indexed_unique'::regclass")).rows[0]
        .indisvalid,
      false,
    );
    assert.equal((await pool.query("SELECT * FROM qm_schema_migrations")).rowCount, 0);
    await pool.query("DELETE FROM indexed WHERE ctid NOT IN (SELECT min(ctid) FROM indexed GROUP BY value)");
    await applyPgMigrations(pool, [migration]);
    const oid = (await pool.query("SELECT 'indexed_unique'::regclass::oid AS oid")).rows[0].oid;
    await pool.query("DELETE FROM qm_schema_migrations");
    await applyPgMigrations(pool, [migration]);
    assert.equal((await pool.query("SELECT 'indexed_unique'::regclass::oid AS oid")).rows[0].oid, oid);
    assert.equal(
      (await pool.query("SELECT indisvalid FROM pg_index WHERE indexrelid='indexed_unique'::regclass")).rows[0]
        .indisvalid,
      true,
    );
  },
);

databaseTest("per-start maintenance stays outside the immutable ledger and fails closed", async (pool, url) => {
  const definition = { id: "test/maintenance/1", statements: ["CREATE TABLE maintenance_runs(value int)"] };
  const maintenance = [{ id: "test/runtime", statements: ["INSERT INTO maintenance_runs VALUES (1)"] }];
  for (let n = 0; n < 2; n++) {
    const wrapper = createPgPool(url, [definition], maintenance);
    try {
      await wrapper.pool();
    } finally {
      await wrapper.close();
    }
  }
  assert.equal((await pool.query("SELECT * FROM maintenance_runs")).rowCount, 2);
  assert.equal((await pool.query("SELECT * FROM qm_schema_migrations")).rowCount, 1);
  const empty = createPgPool(url, [], maintenance);
  try {
    await empty.pool();
  } finally {
    await empty.close();
  }
  assert.equal((await pool.query("SELECT * FROM maintenance_runs")).rowCount, 3);
  await assert.rejects(
    applyPgMigrations(pool, [definition], {
      maintenance: [
        { id: "test/runtime", statements: ["INSERT INTO maintenance_runs VALUES (2)", "SELECT * FROM missing_guard"] },
      ],
    }),
    /missing_guard/,
  );
  assert.equal((await pool.query("SELECT * FROM maintenance_runs")).rowCount, 3);
});

databaseTest("both old and new schema lock holders cause bounded failure and release allows retry", async (pool) => {
  for (const key of ["agent-platform:schema-init", "qm:schema-migrations"]) {
    const holder = await pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
      const start = performance.now();
      await assert.rejects(
        withPgSchemaLock(pool, async () => assert.fail("must not initialize"), 75),
        /timeout acquiring/,
      );
      assert.ok(performance.now() - start < 3_000);
      await holder.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
      assert.equal(await withPgSchemaLock(pool, async () => "retried", 1_000), "retried");
    } finally {
      holder.release(true);
    }
  }
});

databaseTest("independent OS processes serialize named migration execution", async (pool, url, t) => {
  const moduleUrl = new URL("../src/persistence/pg-schema-migrations.ts", import.meta.url).href;
  const code = `import pg from 'pg'; import {applyPgMigrations} from ${JSON.stringify(moduleUrl)};
    const pool = new pg.Pool({connectionString: process.env.QM_MIGRATION_TEST_URL});
    try { await applyPgMigrations(pool, [{id:'test/process/1', statements:[
      'CREATE TABLE process_runs(value int)', 'SELECT pg_sleep(0.15)', 'INSERT INTO process_runs VALUES (1)'
    ]}]); } finally { await pool.end(); }`;
  const run = () =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
        env: { ...process.env, QM_MIGRATION_TEST_URL: url },
        stdio: ["ignore", "pipe", "pipe"],
      });
      t.after(() => {
        if (child.exitCode === null) child.kill();
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (exit) =>
        exit === 0 ? resolve() : reject(new Error(`migration child failed (${exit}): ${stderr}`)),
      );
    });
  await Promise.all([run(), run()]);
  assert.deepEqual((await pool.query("SELECT * FROM process_runs")).rows, [{ value: 1 }]);
  assert.equal((await pool.query("SELECT * FROM qm_schema_migrations")).rowCount, 1);
});

databaseTest(
  "prod-v1.3.0 source schema upgrades preserve downstream rows and freeze initial migration checksums",
  async (pool, url) => {
    const fixture = JSON.parse(
      readFileSync(new URL("./fixtures/postgres/prod-v1.3.0-schema.json", import.meta.url), "utf8"),
    ) as {
      revision: string;
      expectedMigrations: { id: string; checksum: string }[];
      schemas: Record<string, { statements: string[] }>;
    };
    assert.equal(fixture.revision, "bd1cb20411a69ff7badd95da4d482961b07d4b7b");
    for (const schema of Object.values(fixture.schemas)) {
      for (const statement of schema.statements) await pool.query(statement);
    }
    await pool.query(`INSERT INTO organization_users(org_id, principal_id, display_name, status, session_version, profile_revision, created_at, updated_at, created_by, updated_by)
    VALUES ('fixture', 'user-1', 'Synthetic user', 'paused', 7, 9, 100, 101, 'admin', 'admin')`);
    await pool.query(`INSERT INTO auth_identities(org_id, issuer, subject, principal_id, created_at, updated_at)
    VALUES ('fixture', 'https://idp.example.test', 'subject-1', 'user-1', 100, 101)`);
    await pool.query(`INSERT INTO directory_sources(org_id, id, provider, name, external_tenant_id, status, origin, login_enabled, sync_enabled, schedule_minutes, match_policy, capabilities, public_config, revision, created_at, updated_at, created_by, updated_by)
    VALUES ('fixture', 'source-1', 'wecom', 'Synthetic source', 'synthetic-tenant', 'active', 'admin', true, true, 360, 'verified_corporate_email', '{}', '{}', 4, 100, 101, 'admin', 'admin')`);
    await pool.query(`INSERT INTO directory_source_secrets(org_id, source_id, version, source_revision, purpose, secret_enc, updated_at)
    VALUES ('fixture', 'source-1', 1, 4, 'provider', 'synthetic-opaque-ciphertext-does-not-decrypt', 101)`);
    await pool.query(`INSERT INTO organization_member_jobs(id, org_id, kind, status, actor_id, idempotency_key, input_hash, expected_authz_revision, summary, created_at, expires_at)
    VALUES ('job-1', 'fixture', 'import', 'previewed', 'admin', 'fixture-key', 'fixture-hash', 12, '{"synthetic":true}', 100, 4102444800000)`);
    await pool.query(`INSERT INTO organization_member_job_items(org_id, job_id, item_index, principal_id, normalized_input, changes, status, errors, warnings)
    VALUES ('fixture', 'job-1', 0, 'user-1', '{"synthetic":true}', '{}', 'ready', '[]', '[]')`);
    await pool.query(`INSERT INTO portal_login_transactions(state_hash, status, payload, expires_at)
    VALUES ('fixture-state-hash', 'pending', 'synthetic-payload', '2100-01-01')`);
    await pool.query(`INSERT INTO portal_login_rate_limits(bucket, window_number, used, updated_at)
    VALUES ('fixture-bucket', 1, 3, '2100-01-01')`);
    const tables = [
      "organization_users",
      "auth_identities",
      "directory_sources",
      "directory_source_secrets",
      "organization_member_jobs",
      "organization_member_job_items",
      "portal_login_transactions",
      "portal_login_rate_limits",
    ];
    const snapshot = async () => {
      const values: Record<string, unknown> = {};
      for (const table of tables)
        values[table] = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
      return values;
    };
    const before = await snapshot();
    assert.equal((await pool.query("SELECT to_regclass('qm_schema_migrations') AS name")).rows[0].name, null);
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) {
        for (const schema of Object.values(fixture.schemas)) {
          for (const statement of schema.statements) await pool.query(statement);
        }
      }
      const organization = createPostgresOrganizationStore(url, { exclusiveOrgId: "fixture" });
      const directory = createPostgresDirectorySourceStore(url);
      const jobs = createPostgresOrganizationMemberJobStore(url);
      const portal = createPostgresPortalLoginTransactionStore(url);
      try {
        assert.equal((await organization.getUser("fixture", "user-1"))?.sessionVersion, 7);
        assert.equal(
          (await directory.getSource("fixture", "source-1"))?.secretEnc,
          "synthetic-opaque-ciphertext-does-not-decrypt",
        );
        assert.equal((await jobs.get("fixture", "job-1", "admin"))?.items.length, 1);
        assert.deepEqual(await portal.claim("missing-state"), { status: "missing" });
        assert.deepEqual(await snapshot(), before);
      } finally {
        await directory.close();
        await jobs.close?.();
      }
    }
    const actual = (await pool.query("SELECT id, checksum FROM qm_schema_migrations")).rows.sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    assert.deepEqual(actual, fixture.expectedMigrations);
    const mismatched = createPostgresOrganizationStore(url, { exclusiveOrgId: "other-tenant" });
    await assert.rejects(mismatched.getUser("other-tenant", "user-1"), /already belongs to fixture/);
    assert.deepEqual(await snapshot(), before);
    await applyPgMigrations(pool, [
      {
        id: "fork/organization/0002",
        statements: ["ALTER TABLE organization_users ADD COLUMN fixture_extension text"],
      },
    ]);
    const afterExtension = (await pool.query("SELECT id, checksum FROM qm_schema_migrations ORDER BY id")).rows;
    assert.deepEqual(
      afterExtension.filter((row) => row.id !== "fork/organization/0002"),
      fixture.expectedMigrations,
    );
    assert.equal(afterExtension.length, fixture.expectedMigrations.length + 1);
    assert.equal(
      (await pool.query("SELECT fixture_extension FROM organization_users")).rows[0].fixture_extension,
      null,
    );
  },
);

test("schema lock surfaces a release failure and migration rollback retains the original failure", async () => {
  const releaseFailure = new Error("release failed");
  let ended = false;
  const releasePool = {
    connect: async () => ({
      query: async (query: { text: string }) => ({
        rows: [query.text.includes("pg_try") ? { acquired: true } : { released: true }],
      }),
      release: () => {
        throw releaseFailure;
      },
      end: async () => {
        ended = true;
      },
    }),
  } as unknown as Pool;
  await assert.rejects(
    withPgSchemaLock(releasePool, async () => undefined),
    (error) => error === releaseFailure,
  );
  assert.equal(ended, true);
  const statements: string[] = [];
  const released: boolean[] = [];
  const rollbackPool = {
    connect: async () => ({
      query: async (query: string | { text: string }) => {
        const text = typeof query === "string" ? query : query.text;
        statements.push(text);
        if (text.includes("pg_try")) return { rows: [{ acquired: true }] };
        if (text.includes("pg_advisory_unlock")) return { rows: [{ released: true }] };
        if (text === "SELECT broken") throw new Error("DDL failed");
        if (text === "ROLLBACK") throw new Error("rollback failed");
        return { rows: [] };
      },
      release: (discard: boolean) => {
        released.push(discard);
      },
    }),
  } as unknown as Pool;
  await assert.rejects(
    applyPgMigrations(rollbackPool, [{ id: "test/rollback", statements: ["SELECT broken"] }]),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(String(error.errors[0]), /DDL failed/);
      assert.match(String(error.errors[1]), /rollback failed/);
      assert.equal(error.cause, error.errors[1]);
      return true;
    },
  );
  assert.equal(
    statements.some((statement) => statement.startsWith("INSERT INTO qm_schema_migrations")),
    false,
  );
  assert.deepEqual(released, [true]);
});

databaseTest("a later migration failure retains completed boundaries and retries only unapplied work", async (pool) => {
  const migrations = pgSchemaMigrations("test/boundaries", [
    "CREATE TABLE boundary_data(value int)",
    "INSERT INTO boundary_data VALUES (1)",
    "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS boundary_unique ON boundary_data(value)",
    "INSERT INTO boundary_data SELECT value FROM boundary_prerequisite",
  ]);
  await assert.rejects(applyPgMigrations(pool, migrations), /boundary_prerequisite/);
  assert.equal((await pool.query("SELECT * FROM qm_schema_migrations")).rowCount, 2);
  await pool.query("CREATE TABLE boundary_prerequisite(value int)");
  await pool.query("INSERT INTO boundary_prerequisite VALUES (2)");
  await applyPgMigrations(pool, migrations);
  assert.equal((await pool.query("SELECT * FROM qm_schema_migrations")).rowCount, 3);
  assert.deepEqual((await pool.query("SELECT value FROM boundary_data ORDER BY value")).rows, [
    { value: 1 },
    { value: 2 },
  ]);
});
