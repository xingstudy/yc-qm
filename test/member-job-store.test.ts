import assert from "node:assert/strict";
import test from "node:test";
import {
  createMemoryOrganizationMemberJobStore,
  type OrganizationMemberJob,
  type OrganizationMemberJobItem,
} from "../src/organization/member-job-store.ts";

const job = (id = "job-1", idempotencyKey = "key-1"): OrganizationMemberJob => ({
  id,
  orgId: "acme",
  kind: "batch",
  status: "previewed",
  actorId: "admin",
  idempotencyKey,
  inputHash: "a".repeat(64),
  expectedAuthzRevision: 1,
  summary: { errors: 0 },
  createdAt: 1,
  startedAt: null,
  claimToken: null,
  leaseExpiresAt: null,
  completedAt: null,
  expiresAt: 100,
  error: null,
});

const item = (jobId = "job-1"): OrganizationMemberJobItem => ({
  orgId: "acme",
  jobId,
  itemIndex: 0,
  principalId: "U1",
  expectedProfileRevision: 1,
  normalizedInput: { mutation: { principalId: "U1" } },
  changes: {},
  status: "ready",
  errors: [],
  warnings: [],
});

test("organization member job store is idempotent and actor-scoped", async () => {
  const store = createMemoryOrganizationMemberJobStore();
  const first = await store.create(job(), [item()]);
  assert.equal(first.created, true);
  const duplicate = await store.create(job("job-2"), [item("job-2")]);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.detail.job.id, "job-1");
  assert.equal(await store.get("acme", "job-1", "other-admin"), null);
  await assert.rejects(
    store.create({ ...job("job-3"), inputHash: "b".repeat(64) }, [{ ...item(), jobId: "job-3" }]),
    /different member task/,
  );
  await assert.rejects(
    store.create({ ...job("job-4"), kind: "import" }, [{ ...item(), jobId: "job-4" }]),
    /different member task/,
  );
});

test("organization member job store pages item bodies without changing the total", async () => {
  const store = createMemoryOrganizationMemberJobStore();
  await store.create(job(), [item(), { ...item(), itemIndex: 1, principalId: "U2" }]);
  const page = await store.page("acme", "job-1", "admin", 1, 1);
  assert.equal(page?.itemTotal, 2);
  assert.deepEqual(
    page?.detail.items.map((entry) => entry.principalId),
    ["U2"],
  );
  assert.equal(await store.page("acme", "job-1", "other-admin", 0, 1), null);
});

test("organization member job store fences claims, recovers expired leases, completes, and expires bodies", async () => {
  const store = createMemoryOrganizationMemberJobStore();
  await store.create(job(), [item()]);
  const first = await store.claim("acme", "job-1", "admin", "claim-a", 10, 20);
  assert.equal(first?.acquired, true);
  assert.equal(first?.detail.job.status, "running");
  const concurrent = await store.claim("acme", "job-1", "admin", "claim-b", 10, 20);
  assert.equal(concurrent?.acquired, false);
  const recovered = await store.claim("acme", "job-1", "admin", "claim-b", 20, 30);
  assert.equal(recovered?.acquired, true);
  assert.equal(await store.complete("acme", "job-1", "admin", "claim-a", { done: 1 }, 21), null);
  assert.equal((await store.complete("acme", "job-1", "admin", "claim-b", { done: 1 }, 22))?.job.status, "completed");
  await store.create(job("job-3", "key-3"), [item("job-3")]);
  assert.equal(await store.expire(101), 1);
  assert.deepEqual((await store.get("acme", "job-3", "admin"))?.items, []);
});
