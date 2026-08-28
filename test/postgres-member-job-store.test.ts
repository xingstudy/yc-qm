import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { OrganizationMemberJob, OrganizationMemberJobItem } from "../src/organization/member-job-store.ts";
import { createPostgresOrganizationMemberJobStore } from "../src/organization/postgres-member-job-store.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL to run PostgreSQL member-job tests";

beforeEach(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  await pool.query("DROP TABLE IF EXISTS organization_member_job_items, organization_member_jobs CASCADE");
  await pool.end();
});

const job = (): OrganizationMemberJob => ({
  id: "job-1",
  orgId: "acme",
  kind: "import",
  status: "previewed",
  actorId: "admin",
  idempotencyKey: "key-1",
  inputHash: "a".repeat(64),
  expectedAuthzRevision: 2,
  summary: { errors: 0 },
  createdAt: 1,
  startedAt: null,
  claimToken: null,
  leaseExpiresAt: null,
  completedAt: null,
  expiresAt: Date.now() + 60_000,
  error: null,
});

const item = (): OrganizationMemberJobItem => ({
  orgId: "acme",
  jobId: "job-1",
  itemIndex: 0,
  principalId: "U1",
  expectedProfileRevision: 1,
  normalizedInput: { mutation: { principalId: "U1", expectedProfileRevision: 1 } },
  changes: { profile: true },
  status: "ready",
  errors: [],
  warnings: [],
});

test("PostgreSQL member jobs survive store restart and preserve JSON items", { skip }, async () => {
  const first = createPostgresOrganizationMemberJobStore(URL!);
  await first.create(job(), [item()]);
  await first.close?.();
  const second = createPostgresOrganizationMemberJobStore(URL!);
  const loaded = await second.get("acme", "job-1", "admin");
  assert.equal(loaded?.job.expectedAuthzRevision, 2);
  assert.deepEqual(loaded?.items[0]?.normalizedInput, item().normalizedInput);
  assert.equal(await second.get("acme", "job-1", "other"), null);
  await second.close?.();
});

test("PostgreSQL member jobs enforce idempotency and fence recoverable running claims", { skip }, async () => {
  const store = createPostgresOrganizationMemberJobStore(URL!);
  const first = await store.create(job(), [item()]);
  const duplicate = await store.create({ ...job(), id: "job-2" }, [{ ...item(), jobId: "job-2" }]);
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.detail.job.id, "job-1");
  await assert.rejects(
    store.create({ ...job(), id: "job-3", inputHash: "b".repeat(64) }, [{ ...item(), jobId: "job-3" }]),
    /different member task/,
  );
  const firstClaim = await store.claim("acme", "job-1", "admin", "claim-a", 10, 20);
  assert.equal(firstClaim?.acquired, true);
  assert.equal(firstClaim?.detail.job.startedAt, 10);
  assert.equal((await store.claim("acme", "job-1", "admin", "claim-b", 10, 20))?.acquired, false);
  assert.equal((await store.claim("acme", "job-1", "admin", "claim-b", 20, 30))?.acquired, true);
  assert.equal(await store.complete("acme", "job-1", "admin", "claim-a", { done: true }, 21), null);
  assert.equal(
    (await store.complete("acme", "job-1", "admin", "claim-b", { done: true }, 22))?.job.status,
    "completed",
  );
  await store.close?.();
});
