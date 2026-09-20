import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateRegisteredPgSchemas } from "../src/persistence/pg-pool.ts";
import {
  createMemorySandboxLifecycleStore,
  createPostgresSandboxLifecycleStore,
  type SandboxLifecycleStore,
} from "../src/sandbox/sandbox-lifecycle-store.ts";

async function exerciseLifecycleStore(
  writer: SandboxLifecycleStore,
  reader: SandboxLifecycleStore,
  scopeId: string,
): Promise<void> {
  const observed = await writer.observe({
    orgId: "test-org",
    backend: "local-docker",
    scopeId,
    containerName: `container-${scopeId}`,
    desiredGeneration: "generation-2",
    running: true,
    now: 100,
  });
  assert.equal(observed.state, "legacy_unknown");
  assert.equal(observed.firstObservedAt, 100);

  await writer.mark("test-org", "local-docker", scopeId, {
    currentGeneration: "generation-1",
    state: "ready",
  });
  assert.equal((await reader.get("test-org", "local-docker", scopeId))?.currentGeneration, "generation-1");

  const lease = await writer.acquireLease({
    orgId: "test-org",
    backend: "local-docker",
    scopeId,
    containerName: `container-${scopeId}`,
    holder: "core-a",
    expiresAt: 500,
    createdAt: 110,
  });
  assert.equal((await reader.activeLeases("test-org", "local-docker", `container-${scopeId}`, 200)).length, 1);
  assert.equal(await reader.renewLease(lease.leaseId, 700), true);
  assert.equal((await writer.activeLeases("test-org", "local-docker", `container-${scopeId}`, 600)).length, 1);
  assert.equal(await reader.releaseLease(lease.leaseId), true);

  assert.equal(await writer.tryClaimMigration("test-org", "local-docker", scopeId, "token-a", 200, 400), true);
  assert.equal(await reader.tryClaimMigration("test-org", "local-docker", scopeId, "token-b", 300, 500), false);
  assert.equal(await reader.tryClaimMigration("test-org", "local-docker", scopeId, "token-b", 401, 600), true);
  assert.equal((await writer.get("test-org", "local-docker", scopeId))?.migrationToken, "token-b");

  await reader.delete("test-org", "local-docker", scopeId);
  assert.equal(await writer.get("test-org", "local-docker", scopeId), null);
}

test("memory sandbox lifecycle store shares observations, leases, and migration claims", async () => {
  const store = createMemorySandboxLifecycleStore();
  await exerciseLifecycleStore(store, store, `memory-${Date.now()}`);
});

const databaseUrl = process.env.DATABASE_URL;
const postgresSkip = databaseUrl ? false : "set DATABASE_URL to run the PostgreSQL sandbox lifecycle test";

test("PostgreSQL sandbox lifecycle store coordinates independent core instances", { skip: postgresSkip }, async () => {
  const writer = createPostgresSandboxLifecycleStore(databaseUrl!);
  const reader = createPostgresSandboxLifecycleStore(databaseUrl!);
  await migrateRegisteredPgSchemas(databaseUrl!);
  try {
    await exerciseLifecycleStore(writer, reader, `postgres-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  } finally {
    await writer.close?.();
    await reader.close?.();
  }
});
