import assert from "node:assert/strict";
import test from "node:test";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createOrganizationMemberBatchService } from "../src/organization/member-batch-service.ts";
import { createMemoryOrganizationMemberJobStore } from "../src/organization/member-job-store.ts";
import { createOrganizationService } from "../src/organization/organization-service.ts";
import { createMemoryOrganizationStore, type OrganizationUser } from "../src/organization/organization-store.ts";
import { createKeyedQueue } from "../src/util/async.ts";

const ORG = "acme";

const user = (principalId: string): OrganizationUser => ({
  orgId: ORG,
  principalId,
  email: `${principalId.toLowerCase()}@example.com`,
  displayName: principalId,
  jobTitle: null,
  mobile: null,
  employeeNumber: null,
  status: "active",
  sessionVersion: 1,
  profileRevision: 1,
  createdAt: 1,
  updatedAt: 1,
  lastLoginAt: null,
  createdBy: "setup",
  updatedBy: "setup",
});

async function setup() {
  const auditLog = createAuditLog();
  const store = createMemoryOrganizationStore({ auditLog });
  const organization = createOrganizationService({
    store,
    orgId: ORG,
    admission: "invite_only",
    autoJoinDomains: [],
    auditLog,
    identity: createIdentityService(),
    now: () => 100,
  });
  await store.ensureOrgRoot({ orgId: ORG, name: "Acme", actor: "setup", now: 1 });
  const unit = await organization.createUnit({
    parentId: "root",
    name: "Engineering",
    kind: "department",
    actor: "admin",
  });
  const group = await organization.createGroup({ name: "Developers", actor: "admin" });
  for (const principalId of ["U1", "U2"]) await store.putUser(user(principalId));
  const jobs = createMemoryOrganizationMemberJobStore();
  const batch = createOrganizationMemberBatchService({ orgId: ORG, store, organization, jobs, now: () => 200 });
  return { store, organization, batch, jobs, unit, group };
}

test("CSV import previews existing members and commits profile and ordinary relationships atomically", async () => {
  const { store, batch, unit, group } = await setup();
  const csv = [
    "principalId,displayName,email,jobTitle,mobile,employeeNumber,primaryUnitId,additionalUnitIds,accessGroupIds",
    `U1,Alice,alice@example.com,Engineer,+86 13800138000,E-1,${unit.id},,${group.id}`,
  ].join("\r\n");
  const preview = await batch.previewImport({ csv, actor: "admin", idempotencyKey: "import-1" });
  assert.equal(preview.job.status, "previewed");
  assert.equal(preview.job.summary.errors, 0);
  assert.deepEqual(preview.items[0]?.changes.profile, {
    displayName: { before: "U1", after: "Alice" },
    email: { before: "u…@example.com", after: "a…@example.com" },
    jobTitle: { before: null, after: "Engineer" },
    mobile: { before: null, after: "••••8000" },
    employeeNumber: { before: null, after: "E-1" },
  });
  assert.deepEqual(preview.items[0]?.changes.primaryUnit, {
    before: null,
    after: { id: unit.id, name: "Engineering" },
  });
  const reloaded = await batch.get(preview.job.id, "admin");
  assert.deepEqual(reloaded?.items[0]?.changes, preview.items[0]?.changes);
  assert.equal((await store.getUser(ORG, "U1"))?.displayName, "U1");
  const committed = await batch.commit({ jobId: preview.job.id, actor: "admin", inputHash: preview.job.inputHash });
  assert.equal(committed.ok, true);
  assert.equal((await store.getUser(ORG, "U1"))?.displayName, "Alice");
  assert.equal((await store.getUser(ORG, "U1"))?.jobTitle, "Engineer");
  assert.equal((await store.listUnitMembersForUsers(ORG, ["U1"]))[0]?.isPrimary, true);
  assert.equal((await store.listGroupMembersForUsers(ORG, ["U1"]))[0]?.groupId, group.id);
});

test("CSV import never creates an unmatched member and an error preview cannot commit", async () => {
  const { store, batch } = await setup();
  const preview = await batch.previewImport({
    csv: "principalId,displayName\nUNKNOWN,Unknown",
    actor: "admin",
    idempotencyKey: "import-error",
  });
  assert.equal(preview.job.summary.errors, 1);
  assert.equal(await store.getUser(ORG, "UNKNOWN"), null);
  assert.deepEqual(await batch.commit({ jobId: preview.job.id, actor: "admin", inputHash: preview.job.inputHash }), {
    ok: false,
    reason: "preview_has_errors",
    detail: preview,
  });
});

test("batch relationship changes resolve an explicit target set and bump authorization revision once", async () => {
  const { store, batch, unit } = await setup();
  const before = await store.getAuthzRevision(ORG);
  const preview = await batch.previewBatch({
    principalIds: ["U1", "U2", "U1"],
    action: { type: "add_unit", unitId: unit.id },
    actor: "admin",
    idempotencyKey: "batch-1",
  });
  assert.equal(preview.job.summary.affectedMembers, 2);
  assert.deepEqual(preview.job.summary.target, { unit: { id: unit.id, name: "Engineering" } });
  assert.deepEqual(preview.items[0]?.changes.additionalUnits, {
    before: [],
    after: [{ id: unit.id, name: "Engineering" }],
  });
  const committed = await batch.commit({ jobId: preview.job.id, actor: "admin", inputHash: preview.job.inputHash });
  assert.equal(committed.ok, true);
  assert.equal((await store.listUnitMembers(ORG, unit.id)).length, 2);
  assert.equal(await store.getAuthzRevision(ORG), before + 1);
  assert.equal(
    (await batch.commit({ jobId: preview.job.id, actor: "admin", inputHash: preview.job.inputHash })).ok,
    true,
  );
});

test("a commit that outlives its lease remains exclusive and completes once", async () => {
  const { store, organization, jobs, unit } = await setup();
  let clock = 200;
  let releaseApply!: () => void;
  let enteredApply!: () => void;
  const entered = new Promise<void>((resolve) => (enteredApply = resolve));
  const blocked = new Promise<void>((resolve) => (releaseApply = resolve));
  const originalApply = organization.applyMemberMutations.bind(organization);
  let applies = 0;
  organization.applyMemberMutations = async (input) => {
    applies += 1;
    enteredApply();
    await blocked;
    return originalApply(input);
  };
  const lock = createKeyedQueue<string>();
  const makeBatch = () =>
    createOrganizationMemberBatchService({
      orgId: ORG,
      store,
      organization,
      jobs,
      now: () => clock,
      withStatusLock: (fn) => lock("admin-liveness", fn),
    });
  const firstService = makeBatch();
  const secondService = makeBatch();
  const preview = await firstService.previewBatch({
    principalIds: ["U1"],
    action: { type: "add_unit", unitId: unit.id },
    actor: "admin",
    idempotencyKey: "long-running",
  });
  const first = firstService.commit({ jobId: preview.job.id, actor: "admin", inputHash: preview.job.inputHash });
  await entered;
  clock += 61_000;
  const second = secondService.commit({ jobId: preview.job.id, actor: "admin", inputHash: preview.job.inputHash });
  releaseApply();
  const results = await Promise.all([first, second]);
  assert.deepEqual(
    results.map((result) => result.ok),
    [true, true],
  );
  assert.equal(applies, 1);
  assert.equal((await jobs.get(ORG, preview.job.id, "admin"))?.job.status, "completed");
});

test("the organization root cannot be selected as a primary unit", async () => {
  const { batch } = await setup();
  await assert.rejects(
    batch.previewBatch({
      principalIds: ["U1"],
      action: { type: "set_primary_unit", unitId: "root", keepPreviousMembership: true },
      actor: "admin",
      idempotencyKey: "root-primary",
    }),
    /root cannot be a primary unit/,
  );
  const csv = await batch.previewImport({
    csv: "principalId,primaryUnitId\nU1,root",
    actor: "admin",
    idempotencyKey: "root-primary-csv",
  });
  assert.deepEqual(csv.items[0]?.errors, ["root_primary_unit"]);
});

test("batch preview rejects invalid profiles and reports every missing explicit target", async () => {
  const { batch } = await setup();
  const invalid = await batch.previewBatch({
    principalIds: ["U1"],
    action: { type: "set_job_title", value: "x".repeat(201) },
    actor: "admin",
    idempotencyKey: "invalid-title",
  });
  assert.equal(invalid.job.summary.errors, 1);
  assert.deepEqual(invalid.items[0]?.errors, ["invalid_jobTitle"]);
  const missing = await batch.previewBatch({
    principalIds: ["U1", "UNKNOWN"],
    action: { type: "suspend" },
    actor: "admin",
    idempotencyKey: "missing-target",
  });
  assert.equal(missing.job.summary.errors, 1);
  assert.equal(missing.items.find((item) => item.principalId === "UNKNOWN")?.status, "error");
});

test("CSV preview detects conflicts with members outside the imported rows", async () => {
  const { store, batch } = await setup();
  await store.putUser({ ...user("U2"), employeeNumber: "E-2" });
  const email = await batch.previewImport({
    csv: "principalId,email\nU1,u2@example.com",
    actor: "admin",
    idempotencyKey: "existing-email",
  });
  assert.deepEqual(email.items[0]?.errors, ["duplicate_email"]);
  const employeeNumber = await batch.previewImport({
    csv: "principalId,employeeNumber\nU1,E-2",
    actor: "admin",
    idempotencyKey: "existing-employee-number",
  });
  assert.deepEqual(employeeNumber.items[0]?.errors, ["duplicate_employee_number"]);
});

test("member task idempotency keys cannot be reused for different inputs", async () => {
  const { batch } = await setup();
  await batch.previewBatch({
    principalIds: ["U1"],
    action: { type: "suspend" },
    actor: "admin",
    idempotencyKey: "same-key",
  });
  await assert.rejects(
    batch.previewBatch({
      principalIds: ["U1"],
      action: { type: "deprovision" },
      actor: "admin",
      idempotencyKey: "same-key",
    }),
    /different member task/,
  );
  await assert.rejects(
    batch.previewImport({
      csv: "principalId,displayName\nU1,Alice",
      actor: "admin",
      idempotencyKey: "same-key",
    }),
    /different member task/,
  );
});
