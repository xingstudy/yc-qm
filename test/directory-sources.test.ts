import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { createMetricsSink } from "../src/admin/metrics-sink.ts";
import {
  createMemoryDirectorySourceStore,
  type DirectorySourceStore,
} from "../src/directory-sources/directory-source-store.ts";
import {
  createDirectorySourceService,
  directoryEnvironmentSourcesFromEnv,
} from "../src/directory-sources/directory-source-service.ts";
import { createDirectoryProviderRegistry } from "../src/directory-sources/provider-registry.ts";
import { createDirectorySyncEngine } from "../src/directory-sources/directory-sync-engine.ts";
import { createWeComDirectoryProvider } from "../src/directory-sources/providers/wecom.ts";
import { matchDirectoryMember } from "../src/directory-sources/identity-match.ts";
import { createIdentityLinkingService } from "../src/directory-sources/identity-linking-service.ts";
import { createDirectoryEmailResolutionService } from "../src/directory-sources/email-resolution-service.ts";
import { createManagedDirectoryService } from "../src/directory-sources/managed-directory-service.ts";
import { createDirectoryIdentityMigrationService } from "../src/directory-sources/identity-migration.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import type { DirectoryProviderAdapter } from "../src/directory-sources/provider.ts";
import type {
  ExternalIdentityAssertion,
  NormalizedDirectoryMember,
  NormalizedDirectoryUnit,
} from "../src/directory-sources/types.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import {
  createMemoryOrganizationStore,
  type OrganizationStore,
  type OrganizationUser,
} from "../src/organization/organization-store.ts";
import { createNoopLeaderLease } from "../src/persistence/leader-lease.ts";

const ORG = "acme";
const CAPABILITIES = {
  login: true,
  fullSync: true,
  targetedLookup: true,
  employeeNumber: true,
  mobile: true,
  departments: true,
  trustedCorporateEmail: true,
};

function member(over: Partial<NormalizedDirectoryMember> = {}): NormalizedDirectoryMember {
  return {
    orgId: ORG,
    sourceId: "source-1",
    provider: "fake",
    externalTenantId: "tenant-1",
    externalSubjectId: "external-1",
    displayName: "Alice External",
    emails: [{ value: "alice@example.com", kind: "corporate", verified: true }],
    employeeNumber: "E-1",
    mobile: "+8613800000000",
    departmentIds: ["engineering"],
    status: "active",
    revision: "revision-1",
    observedAt: 1,
    profileHash: "hash-1",
    snapshotRevision: "snapshot-1",
    matchState: "unmatched",
    matchReason: "not_evaluated",
    matchedPrincipalId: null,
    ignoredBy: null,
    ignoredReason: null,
    lastLoginAttemptAt: null,
    ...over,
  };
}

async function seedMemorySource(
  store: ReturnType<typeof createMemoryDirectorySourceStore>,
  overrides: Partial<Parameters<typeof store.putSource>[0]> = {},
): Promise<void> {
  await store.putSource(
    {
      id: "source-1",
      orgId: ORG,
      provider: "fake",
      name: "Test source",
      externalTenantId: "tenant-1",
      status: "active",
      origin: "admin",
      mode: "identity_only",
      loginEnabled: false,
      syncEnabled: false,
      jitProvisioningEnabled: false,
      scheduleMinutes: 360,
      matchPolicy: "verified_corporate_email",
      capabilities: CAPABILITIES,
      publicConfig: { tenant: "tenant-1" },
      hasSecret: false,
      secretEnc: null,
      environmentConfigFingerprint: null,
      revision: 1,
      previewConfirmedRevision: null,
      memberSnapshotRevision: null,
      reconciliationStatus: "not_started",
      reconciledSourceRevision: null,
      reconciledMemberSnapshotRevision: null,
      reconciledAt: null,
      reconciliationExpiresAt: null,
      lastTestAt: null,
      lastTestStatus: null,
      createdAt: 1,
      updatedAt: 1,
      createdBy: "test",
      updatedBy: "test",
      ...overrides,
    },
    null,
  );
}

function user(over: Partial<OrganizationUser> = {}): OrganizationUser {
  return {
    orgId: ORG,
    principalId: "alice",
    email: "alice@example.com",
    displayName: "Alice Internal",
    jobTitle: "Engineer",
    mobile: "+8613800000000",
    employeeNumber: "E-1",
    status: "active",
    sessionVersion: 1,
    profileRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    lastLoginAt: null,
    createdBy: "admin",
    updatedBy: "admin",
    ...over,
  };
}

function provider(
  state: { members: NormalizedDirectoryMember[] },
  expectedSecret: string | null = "provider-secret",
): DirectoryProviderAdapter {
  return {
    id: "fake",
    displayName: "Fake Directory",
    capabilities: CAPABILITIES,
    publicFields: ["tenant", "redirectUri"],
    secretFields: ["secret"],
    configuredTenantId: (publicConfig) => publicConfig.tenant ?? null,
    async testConnection(config) {
      if (expectedSecret !== null) assert.equal(config.secretConfig.secret, expectedSecret);
      return { externalTenantId: config.publicConfig.tenant!, capabilities: CAPABILITIES };
    },
    async *fullSync() {
      for (const value of state.members) yield value;
    },
    async targetedLookup(_config, context) {
      return state.members.find((value) => value.externalSubjectId === context.externalSubjectId) ?? null;
    },
    async resolveLoginCode(_config, input) {
      const value = state.members[0]!;
      return {
        sourceId: input.sourceId,
        provider: "fake",
        externalTenantId: value.externalTenantId,
        externalSubjectId: value.externalSubjectId.trim(),
        displayName: value.displayName,
        corporateEmail: value.emails.find((email) => email.kind === "corporate")?.value ?? null,
        personalEmail: value.emails.find((email) => email.kind === "personal")?.value ?? null,
        employeeNumber: value.employeeNumber,
        mobile: value.mobile,
        status: value.status,
      };
    },
    async resolveProfileAuthorizationCode(_config, input) {
      const value = state.members[0]!;
      if (value.externalSubjectId.trim() !== input.expectedExternalSubjectId) {
        throw new Error("profile_identity_mismatch");
      }
      return {
        sourceId: input.sourceId,
        provider: "fake",
        externalTenantId: value.externalTenantId,
        externalSubjectId: value.externalSubjectId.trim(),
        displayName: value.displayName,
        corporateEmail: value.emails.find((email) => email.kind === "corporate")?.value ?? null,
        personalEmail: value.emails.find((email) => email.kind === "personal")?.value ?? null,
        employeeNumber: value.employeeNumber,
        mobile: value.mobile,
        status: value.status,
      };
    },
    authorizeUrl(config, input) {
      const url = new URL("https://login.example.test/authorize");
      url.searchParams.set("tenant", config.tenant!);
      url.searchParams.set("state", input.state);
      return url.toString();
    },
    profileAuthorizeUrl(config, input) {
      const url = new URL("https://login.example.test/profile-authorize");
      url.searchParams.set("tenant", config.tenant!);
      url.searchParams.set("state", input.state);
      return url.toString();
    },
  };
}

function setupSource(
  state: { members: NormalizedDirectoryMember[] },
  expectedSecret: string | null = "provider-secret",
) {
  const store = createMemoryDirectorySourceStore();
  const providers = createDirectoryProviderRegistry([provider(state, expectedSecret)]);
  const service = createDirectorySourceService({
    orgId: ORG,
    store,
    providers,
    keyMaterial: "directory-test-key-material-0123456789",
    auditLog: createAuditLog(),
  });
  return { store, providers, service };
}

function automaticProvider(state: {
  members: NormalizedDirectoryMember[];
  units?: NormalizedDirectoryUnit[];
  lookups: number;
  lookupSubjects?: Record<string, string>;
}): DirectoryProviderAdapter {
  const capabilities = {
    ...CAPABILITIES,
    corporateEmailSubjectLookup: true,
    trustedCorporateEmail: true,
    organizationUnits: true,
    memberOrganizationUnits: true,
  };
  return {
    id: "fake",
    displayName: "Fake Directory",
    capabilities,
    publicFields: ["tenant"],
    secretFields: [],
    async testConnection(config) {
      return { externalTenantId: config.publicConfig.tenant!, capabilities };
    },
    async *fullSync() {
      for (const value of state.members) yield value;
    },
    async targetedLookup(_config, context) {
      return state.members.find((value) => value.externalSubjectId === context.externalSubjectId) ?? null;
    },
    async lookupByCorporateEmail(_config, input) {
      state.lookups++;
      const mapped = state.lookupSubjects?.[input.email];
      if (mapped) return { status: "resolved" as const, externalSubjectId: mapped };
      const found = state.members.find((value) =>
        value.emails.some(
          (email) => email.kind === "corporate" && email.verified && email.value.toLowerCase() === input.email,
        ),
      );
      return found
        ? { status: "resolved" as const, externalSubjectId: found.externalSubjectId }
        : { status: "not_found" as const };
    },
    async *organizationUnits() {
      for (const value of state.units ?? []) yield value;
    },
    async resolveLoginCode(_config, input) {
      const value = state.members[0]!;
      return {
        sourceId: input.sourceId,
        provider: value.provider,
        externalTenantId: value.externalTenantId,
        externalSubjectId: value.externalSubjectId,
        displayName: value.displayName,
        corporateEmail: value.emails.find((email) => email.kind === "corporate")?.value ?? null,
        personalEmail: null,
        employeeNumber: value.employeeNumber,
        mobile: value.mobile,
        status: value.status,
      };
    },
    authorizeUrl() {
      return "https://login.example.test";
    },
  };
}

async function automaticLinkingSetup(
  options: { sessionInvalidationIntervalMs?: number; organizationStore?: OrganizationStore } = {},
) {
  const store = createMemoryDirectorySourceStore();
  const state: {
    members: NormalizedDirectoryMember[];
    lookups: number;
    lookupSubjects?: Record<string, string>;
  } = { members: [member()], lookups: 0 };
  const providers = createDirectoryProviderRegistry([automaticProvider(state)]);
  await seedMemorySource(store, {
    loginEnabled: true,
    capabilities: automaticProvider(state).capabilities,
    memberSnapshotRevision: "snapshot-1",
    reconciliationStatus: "ready",
    reconciledSourceRevision: 1,
    reconciledMemberSnapshotRevision: "snapshot-1",
    reconciledAt: 100,
    reconciliationExpiresAt: 10_000,
    jitProvisioningEnabled: true,
  });
  await store.upsertMember(member());
  const sources = createDirectorySourceService({
    orgId: ORG,
    store,
    providers,
    keyMaterial: "directory-test-key-material-0123456789",
    auditLog: createAuditLog(),
    now: () => 100,
  });
  await sources.ready;
  const organizationStore = options.organizationStore ?? createMemoryOrganizationStore({ auditLog: createAuditLog() });
  const linkingRef: { current: ReturnType<typeof createIdentityLinkingService> | null } = { current: null };
  const emailResolutions = createDirectoryEmailResolutionService({
    orgId: ORG,
    store,
    sources,
    providers,
    organizationStore,
    allowedEmailDomains: ["example.com"],
    hashKeyMaterial: "directory-email-test-key",
    bindResolvedIdentity: (input) => {
      if (!linkingRef.current) throw new Error("directory_identity_linking_not_ready");
      return linkingRef.current.bind({
        ...input,
        actor: "system:directory-reconciliation",
        matchedBy: "automatic",
      });
    },
    now: () => 100,
  });
  const linking = createIdentityLinkingService({
    orgId: ORG,
    organizationStore,
    directoryStore: store,
    sources,
    identity: createIdentityService(),
    emailResolutions,
    now: () => 100,
    sessionInvalidationIntervalMs: options.sessionInvalidationIntervalMs,
  });
  linkingRef.current = linking;
  const assertion: ExternalIdentityAssertion = {
    sourceId: "source-1",
    provider: "fake",
    externalTenantId: "tenant-1",
    externalSubjectId: "external-1",
    displayName: "Alice External",
    corporateEmail: "alice@example.com",
    corporateEmailVerified: true,
    personalEmail: null,
    employeeNumber: "E-1",
    mobile: "+8613800000000",
    status: "active",
  };
  return { store, state, sources, organizationStore, emailResolutions, linking, assertion };
}

test("matcher only auto-binds a unique verified corporate email", () => {
  const alice = user();
  const unique = matchDirectoryMember({
    member: member(),
    policy: "verified_corporate_email",
    users: [alice],
    identities: [],
  });
  assert.equal(unique.state, "suggested");
  assert.equal(unique.reason, "unique_corporate_email");
  assert.equal(unique.automatic, true);

  const personal = matchDirectoryMember({
    member: member({ emails: [{ value: "alice@example.com", kind: "personal", verified: false }] }),
    policy: "verified_corporate_email",
    users: [alice],
    identities: [],
  });
  assert.equal(personal.state, "suggested");
  assert.equal(personal.reason, "unique_employee_number");
  assert.equal(personal.automatic, false);

  const duplicate = matchDirectoryMember({
    member: member({ employeeNumber: null, mobile: null }),
    policy: "verified_corporate_email",
    users: [alice, user({ principalId: "alice-duplicate" })],
    identities: [],
  });
  assert.equal(duplicate.state, "conflict");
  assert.equal(duplicate.reason, "duplicate_corporate_email");
});

test("different sources may bind one internal user while one source remains unique", () => {
  const alice = user();
  const existing = {
    orgId: ORG,
    issuer: "directory:other-source",
    subject: "other-tenant:other-external",
    principalId: alice.principalId,
    emailAtLink: alice.email,
    sourceId: "other-source",
    externalSubjectId: "other-external",
    createdAt: 1,
    updatedAt: 1,
  };
  assert.equal(
    matchDirectoryMember({
      member: member(),
      policy: "verified_corporate_email",
      users: [alice],
      identities: [existing],
    }).automatic,
    true,
  );
  const sameSource = { ...existing, issuer: "directory:source-1", sourceId: "source-1" };
  const conflict = matchDirectoryMember({
    member: member(),
    policy: "verified_corporate_email",
    users: [alice],
    identities: [sameSource],
  });
  assert.equal(conflict.reason, "target_already_bound_in_source");
});

test("snapshot preview is read-only and failed or partial input cannot inactivate the durable snapshot", async () => {
  const store = createMemoryDirectorySourceStore();
  await seedMemorySource(store);
  await store.upsertMember(member());
  await assert.rejects(
    () => store.replaceMembers(ORG, "source-1", [], false),
    /directory_sync_suspicious_empty_snapshot/,
  );
  assert.equal((await store.getMember(ORG, "source-1", "external-1"))?.status, "active");
  const preview = await store.replaceMembers(ORG, "source-1", [member({ externalSubjectId: "external-2" })], true);
  assert.deepEqual(preview, { observed: 1, added: 1, changed: 0, inactive: 0, unchanged: 0 });
  assert.ok(await store.getMember(ORG, "source-1", "external-1"));
  assert.equal(await store.getMember(ORG, "source-1", "external-2"), null);

  await store.replaceMembers(ORG, "source-1", [member({ externalSubjectId: "external-2" })], false);
  assert.equal((await store.getMember(ORG, "source-1", "external-1"))?.status, "active");
  await store.replaceMembers(ORG, "source-1", [member({ externalSubjectId: "external-2" })], false);
  assert.equal((await store.getMember(ORG, "source-1", "external-1"))?.status, "inactive");
  assert.equal((await store.getMember(ORG, "source-1", "external-2"))?.status, "active");
});

test("an ignored match survives display-only changes and reopens when strong evidence changes", async () => {
  const store = createMemoryDirectorySourceStore();
  await seedMemorySource(store);
  await store.upsertMember(member({ matchState: "ignored", ignoredBy: "admin", ignoredReason: "contractor" }));
  await store.replaceMembers(ORG, "source-1", [member({ displayName: "Alice Renamed", profileHash: "hash-2" })], false);
  assert.equal((await store.getMember(ORG, "source-1", "external-1"))?.matchState, "ignored");
  await store.replaceMembers(
    ORG,
    "source-1",
    [member({ displayName: "Alice Renamed", employeeNumber: "E-2", profileHash: "hash-3" })],
    false,
  );
  assert.equal((await store.getMember(ORG, "source-1", "external-1"))?.matchState, "unmatched");
});

test("inactive members remain inactive even when a stable binding exists", () => {
  const result = matchDirectoryMember({
    member: member({ status: "inactive", matchState: "bound", matchedPrincipalId: "alice" }),
    policy: "verified_corporate_email",
    users: [user()],
    identities: [
      {
        orgId: ORG,
        issuer: "directory:source-1",
        subject: "tenant-1:external-1",
        principalId: "alice",
        emailAtLink: "alice@example.com",
        sourceId: "source-1",
        provider: "fake",
        externalTenantId: "tenant-1",
        externalSubjectId: "external-1",
        matchedBy: "manual",
        evidence: {},
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  });
  assert.equal(result.state, "inactive");
});

test("member writes reject source, provider, and tenant scope mismatches", async () => {
  const store = createMemoryDirectorySourceStore();
  await seedMemorySource(store);
  await assert.rejects(() => store.upsertMember(member({ orgId: "other" })), /source_not_found|scope_mismatch/);
  await assert.rejects(() => store.upsertMember(member({ provider: "other" })), /scope_mismatch/);
  await assert.rejects(() => store.upsertMember(member({ externalTenantId: "other" })), /scope_mismatch/);
});

test("memory source constraints match active tenant and managed-directory uniqueness", async () => {
  const store = createMemoryDirectorySourceStore();
  await seedMemorySource(store, { mode: "managed_directory" });
  const first = await store.getSource(ORG, "source-1");
  assert.ok(first);
  await assert.rejects(
    () => store.putSource({ ...first, id: "source-2", mode: "identity_only", createdAt: 2, updatedAt: 2 }, null),
    /directory_source_tenant_conflict/,
  );
  await assert.rejects(
    () =>
      store.putSource(
        {
          ...first,
          id: "source-3",
          provider: "another-provider",
          externalTenantId: "another-tenant",
          createdAt: 3,
          updatedAt: 3,
        },
        null,
      ),
    /directory_source_managed_directory_conflict/,
  );
});

test("run ownership fences stale sync commits", async () => {
  const store = createMemoryDirectorySourceStore();
  await seedMemorySource(store, { syncEnabled: true });
  const run = await store.createRun({
    id: "run-1",
    orgId: ORG,
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
    leaseExpiresAt: null,
    createdAt: 1,
    startedAt: null,
    completedAt: null,
    updatedAt: 1,
  });
  const first = await store.claimRun(ORG, "source-1", run.id, "owner-a", 2, 10);
  assert.ok(first);
  const second = await store.claimRun(ORG, "source-1", run.id, "owner-b", 11, 20);
  assert.ok(second);
  const stale = await store.finishRun({ ...first, status: "succeeded", completedAt: 12, updatedAt: 12 }, "owner-a", {
    kind: "full",
    members: [member()],
    preview: false,
  });
  assert.equal(stale, null);
  assert.equal(await store.getMember(ORG, "source-1", "external-1"), null);
  const completed = await store.finishRun(
    { ...second, status: "succeeded", completedAt: 13, updatedAt: 13 },
    "owner-b",
    { kind: "full", members: [member()], preview: false },
  );
  assert.equal(completed?.status, "succeeded");
  assert.ok(await store.getMember(ORG, "source-1", "external-1"));
});

test("sync commits are fenced when the source changes after provider reads begin", async () => {
  const store = createMemoryDirectorySourceStore();
  await seedMemorySource(store, { syncEnabled: true });
  const run = await store.createRun({
    id: "run-source-fence",
    orgId: ORG,
    sourceId: "source-1",
    sourceRevision: 1,
    kind: "manual",
    status: "running",
    idempotencyKey: "manual-source-fence",
    targetExternalSubjectId: null,
    counts: { observed: 0, added: 0, changed: 0, inactive: 0, unchanged: 0 },
    errorCode: null,
    errorMessage: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    createdAt: 1,
    startedAt: null,
    completedAt: null,
    updatedAt: 1,
  });
  const claimed = await store.claimRun(ORG, "source-1", run.id, "owner", 2, 20);
  assert.ok(claimed);
  const source = await store.getSource(ORG, "source-1");
  assert.ok(source);
  await store.putSource({ ...source, status: "paused", revision: 2 }, 1);
  const completed = await store.finishRun({ ...claimed, status: "succeeded", completedAt: 3, updatedAt: 3 }, "owner", {
    kind: "full",
    members: [member()],
    preview: false,
  });
  assert.equal(completed?.status, "failed");
  assert.equal(completed?.errorCode, "directory_sync_source_changed");
  assert.equal(await store.getMember(ORG, "source-1", "external-1"), null);
});

test("source service encrypts secrets, exposes no ciphertext, and uses revision CAS", async () => {
  const state = { members: [member()] };
  const { store, service } = setupSource(state);
  const created = await service.create(
    {
      provider: "fake",
      name: "Corporate directory",
      publicConfig: { tenant: "tenant-1", redirectUri: "https://agent.example.test/idp/directory/callback" },
      secretConfig: { secret: "provider-secret" },
    },
    "admin",
  );
  assert.equal(created.hasSecret, true);
  assert.equal("secretEnc" in created, false);
  const stored = await store.getSource(ORG, created.id);
  assert.notEqual(stored?.secretEnc, "provider-secret");
  assert.equal(await service.update(created.id, { expectedRevision: 99, name: "stale" }, "admin"), "conflict");
  const updated = await service.update(created.id, { expectedRevision: 1, syncEnabled: false }, "admin");
  assert.notEqual(updated, "conflict");
  assert.equal(typeof updated === "string" ? null : updated.syncEnabled, false);
});

test("pausing and reactivating a source requires a current snapshot before JIT can be enabled", async () => {
  const store = createMemoryDirectorySourceStore();
  const state = { members: [member()], lookups: 0 };
  const adapter = automaticProvider(state);
  await seedMemorySource(store, {
    capabilities: adapter.capabilities,
    status: "active",
    loginEnabled: true,
    jitProvisioningEnabled: true,
    memberSnapshotRevision: "snapshot-1",
    reconciliationStatus: "ready",
    reconciledSourceRevision: 1,
    reconciledMemberSnapshotRevision: "snapshot-1",
    reconciledAt: 1,
    reconciliationExpiresAt: 10_000,
  });
  const service = createDirectorySourceService({
    orgId: ORG,
    store,
    providers: createDirectoryProviderRegistry([adapter]),
    keyMaterial: "directory-test-key-material-0123456789",
    auditLog: createAuditLog(),
    now: () => 100,
  });
  await service.ready;
  const paused = await service.update("source-1", { expectedRevision: 1, status: "paused" }, "admin");
  assert.notEqual(paused, "conflict");
  if (typeof paused === "string") throw new Error("unexpected source conflict");
  assert.equal(paused.jitProvisioningEnabled, false);
  assert.equal(paused.reconciliationStatus, "stale");
  assert.equal(paused.reconciledSourceRevision, null);
  const active = await service.update("source-1", { expectedRevision: paused.revision, status: "active" }, "admin");
  assert.notEqual(active, "conflict");
  if (typeof active === "string") throw new Error("unexpected source conflict");
  assert.equal(active.jitProvisioningEnabled, false);
  assert.equal(active.reconciliationStatus, "stale");
  const enabled = await service.update(
    "source-1",
    { expectedRevision: active.revision, jitProvisioningEnabled: true },
    "admin",
  );
  assert.notEqual(enabled, "conflict");
  assert.equal(typeof enabled === "string" ? null : enabled.jitProvisioningEnabled, true);
  assert.equal(typeof enabled === "string" ? null : enabled.reconciliationStatus, "stale");
});

test("managed login can start after connection verification while synchronization still requires a preview", async () => {
  const state = { members: [member()] };
  const { service } = setupSource(state, null);
  const created = await service.create(
    {
      provider: "fake",
      name: "Corporate directory",
      publicConfig: { tenant: "tenant-1", redirectUri: "https://agent.example.test/idp/directory/callback" },
      secretConfig: { secret: "provider-secret" },
    },
    "admin",
  );
  assert.equal(created.loginEnabled, false);
  assert.equal(created.syncEnabled, false);
  const loginEnabled = await service.update(
    created.id,
    { expectedRevision: created.revision, loginEnabled: true },
    "admin",
  );
  assert.notEqual(loginEnabled, "conflict");
  if (typeof loginEnabled === "string") throw new Error("unexpected source conflict");
  await assert.rejects(
    () => service.update(created.id, { expectedRevision: loginEnabled.revision, syncEnabled: true }, "admin"),
    /preview_required/,
  );
  const confirmed = await service.confirmPreview(created.id, loginEnabled.revision);
  assert.ok(confirmed && confirmed !== "conflict");
  const enabled = await service.update(
    created.id,
    { expectedRevision: confirmed.revision, syncEnabled: true },
    "admin",
  );
  assert.notEqual(enabled, "conflict");
  if (typeof enabled === "string") throw new Error("unexpected source conflict");
  const rotated = await service.update(
    created.id,
    { expectedRevision: enabled.revision, secretConfig: { secret: "rotated-secret" } },
    "admin",
  );
  assert.notEqual(rotated, "conflict");
  if (typeof rotated === "string") throw new Error("unexpected source conflict");
  assert.equal(rotated.syncEnabled, false);
  assert.equal(rotated.previewConfirmedRevision, null);
  await assert.rejects(
    () => service.update(created.id, { expectedRevision: rotated.revision, syncEnabled: true }, "admin"),
    /preview_required/,
  );
  state.members[0] = member({
    externalSubjectId: " external-1 ",
    displayName: " Alice External ",
    emails: [
      { value: " alice@example.com ", kind: "corporate", verified: true },
      { value: " ", kind: "personal", verified: false },
    ],
    employeeNumber: " E-1 ",
    mobile: " ",
  });
  const assertion = await service.resolveLoginCode(created.id, "provider-code");
  assert.ok(assertion.proof);
  assert.equal(assertion.externalSubjectId, "external-1");
  assert.equal(assertion.displayName, "Alice External");
  assert.equal(assertion.corporateEmail, "alice@example.com");
  assert.equal(assertion.corporateEmailVerified, true);
  assert.equal(assertion.personalEmail, null);
  assert.equal(assertion.employeeNumber, "E-1");
  assert.equal(assertion.mobile, null);
  assert.ok(service.verifyLoginAssertion(assertion));
  assert.equal(await service.profileAuthorizationSupported(created.id), true);
  const profileAuthorization = await service.profileAuthorizationUrl(created.id, "profile-state");
  assert.equal(new URL(profileAuthorization.authorizeUrl).searchParams.get("state"), "profile-state");
  assert.equal(
    profileAuthorization.promptDelivered,
    false,
    "a provider without a prompt channel never claims delivery",
  );
  const profileAssertion = await service.resolveProfileAuthorizationCode(created.id, "profile-code", {
    provider: "fake",
    externalTenantId: "tenant-1",
    externalSubjectId: "external-1",
  });
  assert.equal(profileAssertion.corporateEmail, "alice@example.com");
  assert.equal(profileAssertion.corporateEmailVerified, true);
  assert.ok(service.verifyLoginAssertion(profileAssertion));
  const transported = {
    sourceId: assertion.sourceId,
    provider: assertion.provider,
    externalTenantId: assertion.externalTenantId,
    externalSubjectId: assertion.externalSubjectId,
    displayName: assertion.displayName,
    corporateEmail: assertion.corporateEmail,
    corporateEmailVerified: assertion.corporateEmailVerified,
    personalEmail: assertion.personalEmail,
    employeeNumber: assertion.employeeNumber,
    mobile: assertion.mobile,
    status: assertion.status,
    proof: assertion.proof,
  };
  const [payload] = assertion.proof.split(".");
  const signed = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as { digest: string; v: number };
  const { proof: _proof, ...oldVerifierClaims } = transported;
  assert.equal(signed.v, 2);
  assert.equal(signed.digest, createHash("sha256").update(JSON.stringify(oldVerifierClaims)).digest("base64url"));
  assert.ok(service.verifyLoginAssertion(transported));
  const legacySignerClaims = {
    sourceId: transported.sourceId,
    provider: transported.provider,
    externalTenantId: transported.externalTenantId,
    externalSubjectId: transported.externalSubjectId,
    displayName: transported.displayName,
    corporateEmail: transported.corporateEmail,
    personalEmail: transported.personalEmail,
    employeeNumber: transported.employeeNumber,
    mobile: transported.mobile,
    status: transported.status,
    corporateEmailVerified: transported.corporateEmailVerified,
  };
  const legacyIssuedAt = Math.floor(Date.now() / 1000);
  const legacyPayload = Buffer.from(
    JSON.stringify({
      aud: `qm-core:${ORG}`,
      digest: createHash("sha256").update(JSON.stringify(legacySignerClaims)).digest("base64url"),
      exp: legacyIssuedAt + 120,
      iat: legacyIssuedAt,
      jti: "legacy-assertion",
    }),
  ).toString("base64url");
  const assertionKey = deriveConnectorKey("directory-test-key-material-0123456789", "directory-login-assertions");
  const legacySignature = createHmac("sha256", assertionKey.current).update(legacyPayload).digest("base64url");
  assert.ok(service.verifyLoginAssertion({ ...transported, proof: `${legacyPayload}.${legacySignature}` }));
  assert.ok(
    service.verifyLoginAssertion({
      ...transported,
      externalSubjectId: " external-1 ",
      displayName: " Alice External ",
      corporateEmail: " alice@example.com ",
      personalEmail: " ",
      employeeNumber: " E-1 ",
      mobile: " ",
    }),
  );
  state.members[0] = member({ emails: [], employeeNumber: null, mobile: null });
  const emailLess = await service.resolveLoginCode(created.id, "provider-code");
  assert.equal(emailLess.corporateEmail, null);
  assert.equal(emailLess.corporateEmailVerified, false);
  assert.ok(service.verifyLoginAssertion(emailLess));
  await assert.rejects(
    () =>
      service.resolveProfileAuthorizationCode(created.id, "profile-code", {
        provider: "fake",
        externalTenantId: "tenant-1",
        externalSubjectId: "external-1",
      }),
    /profile_corporate_email_missing/,
  );
  assert.equal(service.verifyLoginAssertion({ ...assertion, displayName: "Forged" }), null);
});

test("provider-specific secret fields support partial rotation without exposing saved values", async () => {
  const observed: Array<Record<string, string>> = [];
  const adapter: DirectoryProviderAdapter = {
    ...provider({ members: [] }),
    id: "multi-secret",
    secretFields: ["clientId", "clientSecret"],
    async testConnection(config) {
      observed.push({ ...config.secretConfig });
      return { externalTenantId: config.publicConfig.tenant!, capabilities: CAPABILITIES };
    },
  };
  const store = createMemoryDirectorySourceStore();
  const service = createDirectorySourceService({
    orgId: ORG,
    store,
    providers: createDirectoryProviderRegistry([adapter]),
    keyMaterial: "directory-test-key-material-0123456789",
    auditLog: createAuditLog(),
  });
  const created = await service.create(
    {
      provider: adapter.id,
      name: "Multi-secret directory",
      publicConfig: { tenant: "tenant-1", redirectUri: "https://agent.example.test/idp/directory/callback" },
      secretConfig: { clientId: "client-id", clientSecret: "client-secret" },
    },
    "admin",
  );
  const updated = await service.update(
    created.id,
    { expectedRevision: created.revision, secretConfig: { clientSecret: "rotated-secret" } },
    "admin",
  );
  assert.notEqual(updated, "conflict");
  assert.deepEqual(observed, [
    { clientId: "client-id", clientSecret: "client-secret" },
    { clientId: "client-id", clientSecret: "rotated-secret" },
  ]);
  const publicSource = await service.get(created.id);
  assert.equal(publicSource?.hasSecret, true);
  assert.deepEqual(publicSource?.secretPresence, { clientId: true, clientSecret: true });
  assert.equal("secretConfig" in (publicSource ?? {}), false);
});

test("provider secret schema can add a required field without invalidating saved fields", async () => {
  const secretFields = ["clientId"];
  const observed: Array<Record<string, string>> = [];
  const adapter: DirectoryProviderAdapter = {
    ...provider({ members: [] }),
    id: "evolving-secret",
    get secretFields() {
      return secretFields;
    },
    async testConnection(config) {
      observed.push({ ...config.secretConfig });
      return { externalTenantId: config.publicConfig.tenant!, capabilities: CAPABILITIES };
    },
  };
  const store = createMemoryDirectorySourceStore();
  const service = createDirectorySourceService({
    orgId: ORG,
    store,
    providers: createDirectoryProviderRegistry([adapter]),
    keyMaterial: "directory-test-key-material-0123456789",
    auditLog: createAuditLog(),
  });
  const created = await service.create(
    {
      provider: adapter.id,
      name: "Evolving directory",
      publicConfig: { tenant: "tenant-1", redirectUri: "https://agent.example.test/idp/directory/callback" },
      secretConfig: { clientId: "client-id" },
    },
    "admin",
  );
  secretFields.push("clientSecret");
  assert.deepEqual((await service.get(created.id))?.secretPresence, { clientId: true, clientSecret: false });
  const updated = await service.update(
    created.id,
    { expectedRevision: created.revision, secretConfig: { clientSecret: "client-secret" } },
    "admin",
  );
  assert.notEqual(updated, "conflict");
  assert.deepEqual(observed, [{ clientId: "client-id" }, { clientId: "client-id", clientSecret: "client-secret" }]);
  assert.deepEqual(typeof updated === "string" ? null : updated.secretPresence, { clientId: true, clientSecret: true });
});

test("deleted Admin sources restore in place with features disabled and no secret disclosure", async () => {
  const { service } = setupSource({ members: [member()] });
  const created = await service.create(
    {
      provider: "fake",
      name: "Corporate directory",
      publicConfig: { tenant: "tenant-1", redirectUri: "https://agent.example.test/idp/directory/callback" },
      secretConfig: { secret: "provider-secret" },
    },
    "admin",
  );
  const deleted = await service.delete(created.id, created.revision, "admin");
  assert.ok(deleted && deleted !== "conflict");
  assert.equal((await service.list()).length, 0);
  const tombstone = await service.get(created.id, true);
  assert.equal(tombstone?.status, "deleted");
  assert.equal(tombstone?.hasSecret, false);
  assert.deepEqual(tombstone?.secretPresence, { secret: false });
  const restored = await service.restore(created.id, tombstone!.revision, { secret: "provider-secret" }, "admin");
  assert.ok(restored && restored !== "conflict");
  assert.equal(restored.id, created.id);
  assert.equal(restored.status, "paused");
  assert.equal(restored.loginEnabled, false);
  assert.equal(restored.syncEnabled, false);
  assert.deepEqual(restored.secretPresence, { secret: true });
});

test("environment sources pause safely and an Admin tombstone blocks environment fallback", async () => {
  assert.deepEqual(directoryEnvironmentSourcesFromEnv({}, "https://agent.example.test/idp/directory/callback"), []);
  assert.deepEqual(
    directoryEnvironmentSourcesFromEnv(
      { AUTH_WECOM_CORP_ID: "wwcorp" },
      "https://agent.example.test/idp/directory/callback",
    ),
    [],
  );
  assert.deepEqual(
    directoryEnvironmentSourcesFromEnv(
      { AUTH_WECOM_DIRECTORY_SYNC_SECRET: "directory-secret" },
      "https://agent.example.test/idp/directory/callback",
    ),
    [],
  );
  const parsed = directoryEnvironmentSourcesFromEnv(
    {
      AUTH_WECOM_CORP_ID: "tenant-1",
      AUTH_WECOM_AGENT_ID: "agent-1",
      AUTH_WECOM_SECRET: "provider-secret",
      AUTH_WECOM_DIRECTORY_SYNC_SECRET: "directory-secret",
      AUTH_WECOM_SYNC_ENABLED: "0",
      AUTH_WECOM_JIT_PROVISIONING_ENABLED: "1",
      AUTH_WECOM_MATCH_POLICY: "manual_only",
    },
    "https://agent.example.test/idp/directory/callback",
  );
  assert.equal(parsed[0]?.syncEnabled, false);
  assert.equal(parsed[0]?.jitProvisioningEnabled, true);
  assert.equal(parsed[0]?.matchPolicy, "manual_only");
  assert.deepEqual(parsed[0]?.secretConfig, {
    applicationSecret: "provider-secret",
    directorySyncSecret: "directory-secret",
  });
  const defaultSync = directoryEnvironmentSourcesFromEnv(
    {
      AUTH_WECOM_CORP_ID: "tenant-1",
      AUTH_WECOM_AGENT_ID: "agent-1",
      AUTH_WECOM_SECRET: "provider-secret",
      AUTH_WECOM_DIRECTORY_SYNC_SECRET: "directory-secret",
    },
    "https://agent.example.test/idp/directory/callback",
  );
  assert.equal(defaultSync[0]?.syncEnabled, false);

  const state = { members: [member()] };
  const store = createMemoryDirectorySourceStore();
  const providers = createDirectoryProviderRegistry([provider(state)]);
  const environment = createDirectorySourceService({
    orgId: ORG,
    store,
    providers,
    keyMaterial: "directory-test-key-material-0123456789",
    auditLog: createAuditLog(),
    environmentSources: [
      {
        provider: "fake",
        name: "Environment directory",
        publicConfig: { tenant: "tenant-1", redirectUri: "https://agent.example.test/idp/directory/callback" },
        secretConfig: { secret: "provider-secret" },
      },
    ],
  });
  await environment.ready;
  const environmentSource = (await environment.list())[0]!;
  assert.equal(environmentSource.origin, "environment");
  assert.equal(environmentSource.hasSecret, true);
  const paused = await environment.pause(environmentSource.id, environmentSource.revision, "admin");
  assert.ok(paused && paused !== "conflict");
  const admin = await environment.create(
    {
      provider: "fake",
      name: "Admin directory",
      publicConfig: { tenant: "tenant-1", redirectUri: "https://agent.example.test/idp/directory/callback" },
      secretConfig: { secret: "provider-secret" },
    },
    "admin",
  );
  assert.equal(admin.id, environmentSource.id);
  const deleted = await environment.delete(admin.id, admin.revision, "admin");
  assert.ok(deleted && deleted !== "conflict");

  const restarted = createDirectorySourceService({
    orgId: ORG,
    store,
    providers,
    keyMaterial: "directory-test-key-material-0123456789",
    auditLog: createAuditLog(),
    environmentSources: [
      {
        provider: "fake",
        name: "Environment directory",
        publicConfig: { tenant: "tenant-1", redirectUri: "https://agent.example.test/idp/directory/callback" },
        secretConfig: { secret: "provider-secret" },
      },
    ],
  });
  await restarted.ready;
  assert.deepEqual(await restarted.list(), []);
  assert.equal((await restarted.list(true))[0]?.status, "deleted");
});

test("a failed environment source stays visible without blocking Admin takeover", async () => {
  const state = { members: [member()] };
  const base = provider(state);
  let connectionFails = true;
  const adapter: DirectoryProviderAdapter = {
    ...base,
    async testConnection(config) {
      if (connectionFails) throw new Error("provider_connection_denied");
      return base.testConnection(config);
    },
  };
  const store = createMemoryDirectorySourceStore();
  const service = createDirectorySourceService({
    orgId: ORG,
    store,
    providers: createDirectoryProviderRegistry([adapter]),
    keyMaterial: "directory-test-key-material-0123456789",
    auditLog: createAuditLog(),
    environmentSources: [
      {
        provider: "fake",
        name: "Broken environment directory",
        publicConfig: { tenant: "tenant-1", redirectUri: "https://agent.example.test/idp/directory/callback" },
        secretConfig: { secret: "provider-secret" },
        loginEnabled: true,
        syncEnabled: true,
      },
    ],
  });
  await service.ready;
  const failed = (await service.list())[0]!;
  assert.equal(failed.origin, "environment");
  assert.equal(failed.status, "paused");
  assert.equal(failed.lastTestStatus, "failed");
  assert.equal(failed.loginEnabled, false);
  assert.equal(failed.syncEnabled, false);

  connectionFails = false;
  const admin = await service.create(
    {
      provider: "fake",
      name: "Admin directory",
      publicConfig: { tenant: "tenant-1", redirectUri: "https://agent.example.test/idp/directory/callback" },
      secretConfig: { secret: "provider-secret" },
    },
    "admin",
  );
  assert.equal(admin.id, failed.id);
  assert.equal(admin.origin, "admin");
});

test("invalid environment metadata cannot block Admin directory management", async () => {
  for (const invalid of [
    { name: "x".repeat(121), scheduleMinutes: 360 },
    { name: "Environment directory", scheduleMinutes: Number.NaN },
  ]) {
    const service = createDirectorySourceService({
      orgId: ORG,
      store: createMemoryDirectorySourceStore(),
      providers: createDirectoryProviderRegistry([provider({ members: [member()] })]),
      keyMaterial: "directory-test-key-material-0123456789",
      auditLog: createAuditLog(),
      environmentSources: [
        {
          provider: "fake",
          ...invalid,
          publicConfig: { tenant: "tenant-1", redirectUri: "https://agent.example.test/idp/directory/callback" },
          secretConfig: { secret: "provider-secret" },
        },
      ],
    });
    await service.ready;
    assert.deepEqual(await service.list(), []);
  }
});

test("environment synchronization requires a real preview and survives only unchanged configuration", async () => {
  const state = { members: [member()] };
  const store = createMemoryDirectorySourceStore();
  const providers = createDirectoryProviderRegistry([provider(state, null)]);
  const configured = {
    provider: "fake",
    name: "Environment directory",
    publicConfig: { tenant: "tenant-1", redirectUri: "https://agent.example.test/idp/directory/callback" },
    secretConfig: { secret: "provider-secret" },
    syncEnabled: true,
  };
  const sourceService = () =>
    createDirectorySourceService({
      orgId: ORG,
      store,
      providers,
      keyMaterial: "directory-test-key-material-0123456789",
      auditLog: createAuditLog(),
      environmentSources: [configured],
    });
  const service = sourceService();
  await service.ready;
  const source = (await service.list())[0]!;
  assert.equal(source.syncEnabled, false);
  assert.equal(source.previewConfirmedRevision, null);
  assert.equal("environmentConfigFingerprint" in source, false);
  state.members = [member({ sourceId: source.id })];
  const pending: Promise<void>[] = [];
  const engine = createDirectorySyncEngine({
    orgId: ORG,
    store,
    sources: service,
    providers,
    leaderLease: createNoopLeaderLease(),
    onBackgroundTask: (task) => pending.push(task),
  });
  await engine.request({ sourceId: source.id, kind: "preview" });
  await Promise.all(pending);
  const enabled = await service.get(source.id);
  assert.equal(enabled?.syncEnabled, true);
  assert.equal(enabled?.previewConfirmedRevision, enabled?.revision);

  const restarted = sourceService();
  await restarted.ready;
  const preserved = await restarted.get(source.id);
  assert.equal(preserved?.syncEnabled, true);
  assert.equal(preserved?.previewConfirmedRevision, preserved?.revision);
  const changed = createDirectorySourceService({
    orgId: ORG,
    store,
    providers,
    keyMaterial: "directory-test-key-material-0123456789",
    auditLog: createAuditLog(),
    environmentSources: [{ ...configured, secretConfig: { secret: "rotated-secret" } }],
  });
  await changed.ready;
  const reset = await changed.get(source.id);
  assert.equal(reset?.syncEnabled, false);
  assert.equal(reset?.previewConfirmedRevision, null);
  const stalePreview = await engine.request({ sourceId: source.id, kind: "preview" });
  await Promise.all(pending.splice(0));
  assert.equal((await engine.get(source.id, stalePreview.id))?.status, "failed");
  assert.equal((await changed.get(source.id))?.previewConfirmedRevision, null);
  const stored = await store.getSource(ORG, source.id);
  assert.ok(stored);
  assert.equal(
    await store.putSource(
      { ...stored, revision: stored.revision + 1, syncEnabled: true, previewConfirmedRevision: null },
      stored.revision,
    ),
    true,
  );
  await assert.rejects(() => engine.request({ sourceId: source.id, kind: "manual" }), /preview_required/);
});

test("environment reconciliation is idempotent, pauses removed config, and yields to Admin", async () => {
  const state = { members: [member()] };
  const store = createMemoryDirectorySourceStore();
  const providers = createDirectoryProviderRegistry([provider(state)]);
  const configured = {
    provider: "fake",
    name: "Environment directory",
    publicConfig: { tenant: "tenant-1", redirectUri: "https://agent.example.test/idp/directory/callback" },
    secretConfig: { secret: "provider-secret" },
  };
  const sourceService = (environmentSources = [configured]) =>
    createDirectorySourceService({
      orgId: ORG,
      store,
      providers,
      keyMaterial: "directory-test-key-material-0123456789",
      auditLog: createAuditLog(),
      environmentSources,
    });
  const first = sourceService();
  await first.ready;
  const initial = (await first.list())[0]!;
  const second = sourceService();
  await second.ready;
  assert.equal((await second.list())[0]!.revision, initial.revision);
  const removed = sourceService([]);
  await removed.ready;
  const paused = (await removed.list())[0]!;
  assert.equal(paused.status, "paused");
  assert.equal(paused.hasSecret, false);
  const admin = await removed.create(
    {
      provider: "fake",
      name: "Admin directory",
      publicConfig: configured.publicConfig,
      secretConfig: configured.secretConfig,
    },
    "admin",
  );
  const restarted = sourceService([{ ...configured, secretConfig: { secret: "unused-because-admin-wins" } }]);
  await restarted.ready;
  assert.equal((await restarted.list()).find((source) => source.origin === "admin")?.id, admin.id);
});

test("environment configuration never combines another instance public config with a local secret", async () => {
  const store = createMemoryDirectorySourceStore();
  const providers = createDirectoryProviderRegistry([provider({ members: [member()] }, null)]);
  const sourceService = (redirectUri: string, secret: string) =>
    createDirectorySourceService({
      orgId: ORG,
      store,
      providers,
      keyMaterial: "directory-test-key-material-0123456789",
      auditLog: createAuditLog(),
      environmentSources: [
        {
          provider: "fake",
          name: "Environment directory",
          publicConfig: { tenant: "tenant-1", redirectUri },
          secretConfig: { secret },
        },
      ],
    });
  const first = sourceService("https://first.example.test/callback", "first-secret");
  await first.ready;
  const sourceId = (await first.list())[0]!.id;
  const second = sourceService("https://second.example.test/callback", "second-secret");
  await second.ready;
  await assert.rejects(() => first.configuration(sourceId), /environment_configuration_changed/);
  const configured = await second.configuration(sourceId);
  assert.equal(configured?.config.publicConfig.redirectUri, "https://second.example.test/callback");
  assert.equal(configured?.config.secretConfig.secret, "second-secret");
});

test("an Admin takeover never uses another instance's cached environment configuration", async () => {
  const store = createMemoryDirectorySourceStore();
  const providers = createDirectoryProviderRegistry([provider({ members: [member()] }, null)]);
  const environmentSource = {
    provider: "fake",
    name: "Environment directory",
    publicConfig: { tenant: "tenant-1", redirectUri: "https://environment.example.test/callback" },
    secretConfig: { secret: "environment-secret" },
  };
  const sourceService = () =>
    createDirectorySourceService({
      orgId: ORG,
      store,
      providers,
      keyMaterial: "directory-test-key-material-0123456789",
      auditLog: createAuditLog(),
      environmentSources: [environmentSource],
    });
  const first = sourceService();
  await first.ready;
  const sourceId = (await first.list())[0]!.id;
  const second = sourceService();
  await second.ready;
  const admin = await second.create(
    {
      provider: "fake",
      name: "Admin directory",
      publicConfig: { tenant: "tenant-1", redirectUri: "https://admin.example.test/callback" },
      secretConfig: { secret: "admin-secret" },
    },
    "admin",
  );
  assert.equal(admin.id, sourceId);
  const configured = await first.configuration(sourceId);
  assert.equal(configured?.source.origin, "admin");
  assert.equal(configured?.config.publicConfig.redirectUri, "https://admin.example.test/callback");
  assert.equal(configured?.config.secretConfig.secret, "admin-secret");
});

test("environment reconciliation and Admin takeover serialize without overwriting Admin state", async () => {
  const store = createMemoryDirectorySourceStore();
  const providers = createDirectoryProviderRegistry([provider({ members: [member()] }, null)]);
  const baseEnvironment = {
    provider: "fake",
    name: "Environment directory",
    publicConfig: { tenant: "tenant-1", redirectUri: "https://environment.example.test/callback" },
    secretConfig: { secret: "environment-secret" },
  };
  const bootstrap = createDirectorySourceService({
    orgId: ORG,
    store,
    providers,
    keyMaterial: "directory-test-key-material-0123456789",
    auditLog: createAuditLog(),
    environmentSources: [baseEnvironment],
  });
  await bootstrap.ready;
  const initial = (await bootstrap.list())[0]!;
  let releaseReconcile!: () => void;
  let reachReconcile!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseReconcile = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    reachReconcile = resolve;
  });
  let blocked = false;
  const racingStore: DirectorySourceStore = {
    ...store,
    async putSource(source, expectedRevision, audit) {
      if (!blocked && source.origin === "environment" && expectedRevision === initial.revision) {
        blocked = true;
        reachReconcile();
        await released;
      }
      return store.putSource(source, expectedRevision, audit);
    },
  };
  const reconciler = createDirectorySourceService({
    orgId: ORG,
    store: racingStore,
    providers,
    keyMaterial: "directory-test-key-material-0123456789",
    auditLog: createAuditLog(),
    environmentSources: [{ ...baseEnvironment, name: "Changed environment directory" }],
  });
  await reached;
  const createAdmin = () =>
    bootstrap.create(
      {
        provider: "fake",
        name: "Admin directory",
        publicConfig: { tenant: "tenant-1", redirectUri: "https://admin.example.test/callback" },
        secretConfig: { secret: "admin-secret" },
      },
      "admin",
    );
  let takeoverFinished = false;
  const racingTakeover = createAdmin().then(
    (source) => {
      takeoverFinished = true;
      return { source, error: null };
    },
    (error: unknown) => {
      takeoverFinished = true;
      return { source: null, error };
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(takeoverFinished, false);
  releaseReconcile();
  await reconciler.ready;
  const raced = await racingTakeover;
  assert.equal(raced.source, null);
  assert.match(String(raced.error), /directory_source_create_conflict/);
  const admin = await createAdmin();
  const final = await reconciler.get(admin.id);
  assert.equal(final?.origin, "admin");
  assert.equal(final?.name, "Admin directory");
  const configured = await reconciler.configuration(admin.id);
  assert.equal(configured?.config.secretConfig.secret, "admin-secret");
});

test("sync engine previews without writes and commits complete snapshots with durable results", async () => {
  const state = { members: [member()] };
  const { store, providers, service } = setupSource(state);
  const created = await service.create(
    {
      provider: "fake",
      name: "Corporate directory",
      publicConfig: { tenant: "tenant-1", redirectUri: "https://agent.example.test/idp/directory/callback" },
      secretConfig: { secret: "provider-secret" },
    },
    "admin",
  );
  state.members = [member({ sourceId: created.id })];
  const pending: Promise<void>[] = [];
  const metrics = createMetricsSink();
  const engine = createDirectorySyncEngine({
    orgId: ORG,
    store,
    sources: service,
    providers,
    leaderLease: createNoopLeaderLease(),
    onBackgroundTask: (task) => pending.push(task),
    onMetric: (sample) => metrics.recordDirectory({ ...sample, scopeLabel: "org:acme" }),
  });
  const preview = await engine.request({ sourceId: created.id, kind: "preview" });
  await Promise.all(pending.splice(0));
  assert.equal(await store.getMember(ORG, created.id, "external-1"), null);
  assert.equal((await engine.get(created.id, preview.id))?.status, "succeeded");
  const confirmed = await service.get(created.id);
  assert.ok(confirmed);
  const enabled = await service.update(
    created.id,
    { expectedRevision: confirmed.revision, syncEnabled: true },
    "admin",
  );
  assert.notEqual(enabled, "conflict");
  const manual = await engine.request({ sourceId: created.id, kind: "manual" });
  await Promise.all(pending.splice(0));
  assert.equal((await store.getMember(ORG, created.id, "external-1"))?.displayName, "Alice External");
  assert.equal((await engine.get(created.id, manual.id))?.counts.observed, 1);
  assert.equal((await metrics.listDirectory()).filter((sample) => sample.name === "sync_result").length, 2);
  engine.stop();
});

test("scheduled full sync preserves an unchanged JIT baseline and queues reconciliation after snapshot changes", async () => {
  const store = createMemoryDirectorySourceStore();
  const state = { members: [member()], lookups: 0 };
  const adapter = automaticProvider(state);
  const providers = createDirectoryProviderRegistry([adapter]);
  const service = createDirectorySourceService({
    orgId: ORG,
    store,
    providers,
    keyMaterial: "directory-test-key-material-0123456789",
    auditLog: createAuditLog(),
  });
  const created = await service.create(
    {
      provider: adapter.id,
      name: "Automatic directory",
      publicConfig: { tenant: "tenant-1" },
      secretConfig: {},
    },
    "admin",
  );
  state.members = [member({ sourceId: created.id })];
  const pending: Promise<void>[] = [];
  const reconciliations: string[] = [];
  const drain = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };
  const engine = createDirectorySyncEngine({
    orgId: ORG,
    store,
    sources: service,
    providers,
    leaderLease: createNoopLeaderLease(),
    onBackgroundTask: (task) => pending.push(task),
    reconcileStaleSource: async (sourceId) => {
      reconciliations.push(sourceId);
    },
  });
  await engine.request({ sourceId: created.id, kind: "preview", idempotencyKey: "preview-baseline" });
  await drain();
  const confirmed = await service.get(created.id);
  assert.ok(confirmed);
  const enabled = await service.update(
    created.id,
    { expectedRevision: confirmed.revision, syncEnabled: true },
    "admin",
  );
  assert.notEqual(enabled, "conflict");
  await engine.request({ sourceId: created.id, kind: "manual", idempotencyKey: "initial-full" });
  await drain();
  assert.deepEqual(reconciliations, [created.id]);
  const synced = await store.getSource(ORG, created.id);
  assert.ok(synced?.memberSnapshotRevision);
  await store.putSource(
    {
      ...synced,
      jitProvisioningEnabled: true,
      reconciliationStatus: "ready",
      reconciledSourceRevision: synced.revision,
      reconciledMemberSnapshotRevision: synced.memberSnapshotRevision,
      reconciledAt: 1,
      reconciliationExpiresAt: Date.now() + 60_000,
    },
    synced.revision,
  );
  await engine.request({ sourceId: created.id, kind: "scheduled", idempotencyKey: "scheduled-unchanged" });
  await drain();
  const unchanged = await service.get(created.id);
  assert.equal(unchanged?.reconciliationStatus, "ready");
  assert.equal(unchanged?.jitProvisioningEnabled, true);
  assert.deepEqual(reconciliations, [created.id]);
  state.members = [
    member({
      sourceId: created.id,
      displayName: "Alice Changed",
      revision: "revision-changed",
      profileHash: "hash-changed",
    }),
  ];
  await engine.request({ sourceId: created.id, kind: "scheduled", idempotencyKey: "scheduled-changed" });
  await drain();
  const changed = await service.get(created.id);
  assert.equal(changed?.reconciliationStatus, "stale");
  assert.equal(changed?.jitProvisioningEnabled, false);
  assert.deepEqual(reconciliations, [created.id, created.id]);
  engine.stop();
});

test("managed login binds an existing member, remains stable after email changes, and never creates an unmatched user", async () => {
  const state = { members: [member()] };
  const { store, service } = setupSource(state);
  const created = await service.create(
    {
      provider: "fake",
      name: "Corporate directory",
      publicConfig: { tenant: "tenant-1", redirectUri: "https://agent.example.test/idp/directory/callback" },
      secretConfig: { secret: "provider-secret" },
    },
    "admin",
  );
  const confirmed = await service.confirmPreview(created.id, created.revision);
  assert.ok(confirmed && confirmed !== "conflict");
  const enabled = await service.update(
    created.id,
    { expectedRevision: confirmed.revision, loginEnabled: true },
    "admin",
  );
  assert.ok(enabled !== "conflict");
  const snapshotMember = member({
    sourceId: created.id,
    emails: [],
    revision: "revision-without-email",
    profileHash: "hash-without-email",
  });
  await store.upsertMember(snapshotMember);
  const sourceWithLogin = await store.getSource(ORG, created.id);
  assert.ok(sourceWithLogin);
  assert.ok(
    await store.putSource(
      { ...sourceWithLogin, memberSnapshotRevision: snapshotMember.snapshotRevision ?? "snapshot-1" },
      sourceWithLogin.revision,
    ),
  );
  const organization = createMemoryOrganizationStore({ auditLog: createAuditLog() });
  await organization.putUser(user());
  const identity = createIdentityService();
  const metrics = createMetricsSink();
  const linking = createIdentityLinkingService({
    orgId: ORG,
    organizationStore: organization,
    directoryStore: store,
    sources: service,
    identity,
    onMetric: (sample) => metrics.recordDirectory({ ...sample, scopeLabel: "org:acme" }),
  });
  const assertion: ExternalIdentityAssertion = {
    sourceId: created.id,
    provider: "fake",
    externalTenantId: "tenant-1",
    externalSubjectId: "external-1",
    displayName: "Alice External",
    corporateEmail: "alice@example.com",
    corporateEmailVerified: true,
    personalEmail: null,
    employeeNumber: "E-1",
    mobile: "+8613800000000",
    status: "active",
  };
  const first = await linking.login({ issuer: "https://auth.example.test", subject: "transient", assertion });
  assert.equal(first.status, "ok");
  assert.equal(first.status === "ok" ? first.user.principalId : null, "alice");
  assert.equal((await organization.listUsers(ORG)).length, 1);
  assert.deepEqual((await store.getMember(ORG, created.id, "external-1"))?.emails, [
    { value: "alice@example.com", kind: "corporate", verified: true },
  ]);
  const changed = await linking.login({
    issuer: "https://auth.example.test",
    subject: "another-transient-value",
    assertion: { ...assertion, corporateEmail: "alice.renamed@example.com" },
  });
  assert.equal(changed.status, "ok");
  assert.equal(changed.status === "ok" ? changed.user.principalId : null, "alice");

  const unmatched = await linking.login({
    issuer: "https://auth.example.test",
    subject: "unmatched",
    assertion: {
      ...assertion,
      externalSubjectId: "external-2",
      corporateEmail: "nobody@example.com",
      employeeNumber: null,
      mobile: null,
    },
  });
  assert.deepEqual(unmatched, { status: "denied", reason: "identity_unmatched" });
  assert.equal((await organization.listUsers(ORG)).length, 1);
  assert.equal(
    (await metrics.listDirectory()).some((sample) => sample.name === "duplicate_creation_blocked"),
    true,
  );
  assert.deepEqual(await linking.sourceImpact(created.id), { members: 2, bindings: 1, affectedUsers: 1 });
  assert.equal(await linking.invalidateSourceSessions(created.id, "admin", 7), 1);
  assert.equal(await linking.invalidateSourceSessions(created.id, "admin", 7), 1);
  assert.equal((await organization.getUser(ORG, "alice"))?.sessionVersion, 2);
});

test("managed login fails closed when a source is paused and sessions are invalidated during login", async () => {
  const state = { members: [member()] };
  const { store, service } = setupSource(state);
  const created = await service.create(
    {
      provider: "fake",
      name: "Corporate directory",
      publicConfig: { tenant: "tenant-1", redirectUri: "https://agent.example.test/idp/directory/callback" },
      secretConfig: { secret: "provider-secret" },
    },
    "admin",
  );
  const confirmed = await service.confirmPreview(created.id, created.revision);
  assert.ok(confirmed && confirmed !== "conflict");
  const enabled = await service.update(
    created.id,
    { expectedRevision: confirmed.revision, loginEnabled: true },
    "admin",
  );
  assert.ok(enabled !== "conflict");
  const organizationAudit = createAuditLog();
  const organization = createMemoryOrganizationStore({ auditLog: organizationAudit });
  await organization.putUser(user({ status: "invited", lastLoginAt: null }));
  await organization.putIdentity({
    orgId: ORG,
    issuer: `directory:${created.id}`,
    subject: "tenant-1:external-1",
    principalId: "alice",
    emailAtLink: "alice@example.com",
    sourceId: created.id,
    provider: "fake",
    externalTenantId: "tenant-1",
    externalSubjectId: "external-1",
    matchedBy: "manual",
    evidence: { reason: "manual" },
    createdAt: 1,
    updatedAt: 1,
  });
  let beforeSourceLock: (() => Promise<void>) | null = null;
  const linkingStore: DirectorySourceStore = {
    ...store,
    async withSourceLock<T>(orgId: string, sourceId: string, fn: () => Promise<T>): Promise<T> {
      const action = beforeSourceLock;
      beforeSourceLock = null;
      if (action) await action();
      return store.withSourceLock(orgId, sourceId, fn);
    },
  };
  const linking = createIdentityLinkingService({
    orgId: ORG,
    organizationStore: organization,
    directoryStore: linkingStore,
    sources: service,
    identity: createIdentityService(),
  });
  const assertion: ExternalIdentityAssertion = {
    sourceId: created.id,
    provider: "fake",
    externalTenantId: "tenant-1",
    externalSubjectId: "external-1",
    displayName: "Alice External",
    corporateEmail: "alice@example.com",
    corporateEmailVerified: true,
    personalEmail: null,
    employeeNumber: "E-1",
    mobile: "+8613800000000",
    status: "active",
  };
  let enteredSourceLock: (() => void) | undefined;
  let releaseSourceLock: (() => void) | undefined;
  const sourceLockEntered = new Promise<void>((resolve) => {
    enteredSourceLock = resolve;
  });
  const sourceLockReleased = new Promise<void>((resolve) => {
    releaseSourceLock = resolve;
  });
  beforeSourceLock = async () => {
    enteredSourceLock?.();
    await sourceLockReleased;
  };
  const login = linking.login({ issuer: "https://auth.example.test", subject: "raced", assertion });
  await sourceLockEntered;
  const current = await service.get(created.id);
  assert.ok(current);
  const paused = await service.pause(current.id, current.revision, "admin");
  assert.ok(paused && paused !== "conflict");
  assert.equal(await linking.invalidateSourceSessions(created.id, "admin"), 1);
  releaseSourceLock?.();
  assert.deepEqual(await login, {
    status: "denied",
    reason: "source_disabled",
  });
  const persisted = await organization.getUser(ORG, "alice");
  assert.equal(persisted?.status, "invited");
  assert.equal(persisted?.lastLoginAt, null);
  assert.equal(persisted?.sessionVersion, 2);
  assert.equal((await organizationAudit.events()).filter((event) => event.action === "org.user.login").length, 0);
});

test("verified email login links the external identity before a later directory login", async () => {
  const { state, organizationStore, linking, assertion } = await automaticLinkingSetup();
  const emailLogin = await linking.loginEmail({
    principalId: "alice@example.com",
    issuer: "https://mail.example.test",
    subject: "mail-subject-alice",
    email: "alice@example.com",
    displayName: "Alice",
    allowCreate: true,
  });
  assert.equal(emailLogin.status, "ok");
  assert.equal(emailLogin.status === "ok" ? emailLogin.user.principalId : null, "alice@example.com");
  const directoryLogin = await linking.login({ issuer: "transient", subject: "transient", assertion });
  assert.equal(directoryLogin.status, "ok");
  assert.equal(directoryLogin.status === "ok" ? directoryLogin.user.principalId : null, "alice@example.com");
  assert.equal((await organizationStore.listUsers(ORG)).length, 1);
  assert.equal((await organizationStore.listIdentities(ORG)).length, 2);
  await linking.loginEmail({
    principalId: "alice@example.com",
    issuer: "https://mail.example.test",
    subject: "mail-subject-alice",
    email: "alice@example.com",
    displayName: "Alice",
    allowCreate: true,
  });
  assert.equal(state.lookups, 1);
});

test("directory login provisions once and a later verified email login reuses the same user", async () => {
  const { organizationStore, linking, assertion } = await automaticLinkingSetup();
  const directoryLogin = await linking.login({ issuer: "transient", subject: "transient", assertion });
  assert.equal(directoryLogin.status, "ok");
  const principalId = directoryLogin.status === "ok" ? directoryLogin.user.principalId : "";
  assert.match(principalId, /^directory-user:/);
  const emailLogin = await linking.loginEmail({
    principalId: "alice@example.com",
    issuer: "https://mail.example.test",
    subject: "mail-subject-alice",
    email: "alice@example.com",
    displayName: "Alice",
    allowCreate: true,
  });
  assert.equal(emailLogin.status, "ok");
  assert.equal(emailLogin.status === "ok" ? emailLogin.user.principalId : null, principalId);
  assert.equal(emailLogin.status === "ok" ? emailLogin.user.email : null, "alice@example.com");
  assert.equal((await organizationStore.listUsers(ORG)).length, 1);
  assert.equal((await organizationStore.listIdentities(ORG)).length, 2);
});

test("a current snapshot member with a live verified corporate email can use JIT while reconciliation is blocked", async () => {
  const { store, organizationStore, linking, assertion } = await automaticLinkingSetup();
  const source = await store.getSource(ORG, "source-1");
  assert.ok(source);
  await store.putSource(
    {
      ...source,
      reconciliationStatus: "blocked",
      reconciledSourceRevision: null,
      reconciledMemberSnapshotRevision: null,
      reconciledAt: null,
      reconciliationExpiresAt: null,
    },
    source.revision,
  );
  const login = await linking.login({ issuer: "transient", subject: "transient", assertion });
  assert.equal(login.status, "ok");
  assert.equal(login.status === "ok" ? login.user.email : null, assertion.corporateEmail);
  assert.equal((await organizationStore.listUsers(ORG)).length, 1);
  assert.equal((await organizationStore.listIdentities(ORG)).length, 1);
});

test("blocked reconciliation still rejects snapshot JIT without a live verified corporate email", async () => {
  const { store, organizationStore, linking, assertion } = await automaticLinkingSetup();
  await store.upsertMember(
    member({
      emails: [],
      revision: "revision-without-email",
      profileHash: "hash-without-email",
    }),
  );
  const source = await store.getSource(ORG, "source-1");
  assert.ok(source);
  await store.putSource(
    {
      ...source,
      reconciliationStatus: "blocked",
      reconciledSourceRevision: null,
      reconciledMemberSnapshotRevision: null,
      reconciledAt: null,
      reconciliationExpiresAt: null,
    },
    source.revision,
  );
  assert.deepEqual(
    await linking.login({
      issuer: "transient",
      subject: "transient",
      assertion: { ...assertion, corporateEmailVerified: false },
    }),
    { status: "denied", reason: "identity_unmatched" },
  );
  assert.equal((await organizationStore.listUsers(ORG)).length, 0);
  assert.equal((await organizationStore.listIdentities(ORG)).length, 0);
});

test("JIT rejects login-observed subjects that were never present in the reconciled snapshot", async () => {
  const { organizationStore, linking, assertion } = await automaticLinkingSetup();
  await organizationStore.putUser(user());
  const unknown = {
    ...assertion,
    externalSubjectId: "external-unknown",
    corporateEmail: "alice@example.com",
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(await linking.login({ issuer: "transient", subject: "transient", assertion: unknown }), {
      status: "denied",
      reason: "identity_unmatched",
    });
  }
  assert.equal((await organizationStore.listUsers(ORG)).length, 1);
  assert.equal((await organizationStore.listIdentities(ORG)).length, 0);
});

test("an unbound directory login rejects a trusted email that disagrees with the current snapshot", async () => {
  const { store, organizationStore, linking, assertion, sources } = await automaticLinkingSetup();
  await organizationStore.putUser(user());
  assert.deepEqual(
    await linking.login({
      issuer: "transient",
      subject: "transient",
      assertion: { ...assertion, corporateEmail: "other@example.com" },
    }),
    { status: "denied", reason: "identity_conflict" },
  );
  assert.equal((await organizationStore.listIdentities(ORG)).length, 0);
  assert.equal((await sources.get("source-1"))?.reconciliationStatus, "stale");
  assert.equal((await sources.get("source-1"))?.jitProvisioningEnabled, false);
  assert.equal(
    (await store.getMember(ORG, "source-1", assertion.externalSubjectId))?.matchReason,
    "login_snapshot_email_mismatch",
  );
});

test("an unbound directory login cannot reuse a verified snapshot email after live verification disappears", async () => {
  const { store, organizationStore, linking, assertion, sources } = await automaticLinkingSetup();
  await organizationStore.putUser(user());
  assert.deepEqual(
    await linking.login({
      issuer: "transient",
      subject: "transient",
      assertion: { ...assertion, corporateEmail: null, corporateEmailVerified: false },
    }),
    { status: "denied", reason: "identity_conflict" },
  );
  assert.equal((await organizationStore.listIdentities(ORG)).length, 0);
  assert.equal((await sources.get("source-1"))?.reconciliationStatus, "stale");
  assert.equal(
    (await store.getMember(ORG, "source-1", assertion.externalSubjectId))?.matchReason,
    "login_snapshot_email_mismatch",
  );
});

test("a paused source invalidates linked sessions even when paused outside the API", async () => {
  const { organizationStore, linking, assertion, sources } = await automaticLinkingSetup({
    sessionInvalidationIntervalMs: 5,
  });
  const login = await linking.login({ issuer: "transient", subject: "transient", assertion });
  assert.equal(login.status, "ok");
  const principalId = login.status === "ok" ? login.user.principalId : "";
  const before = await organizationStore.getUser(ORG, principalId);
  const source = await sources.get("source-1");
  assert.ok(source);
  assert.notEqual(await sources.pause(source.id, source.revision, "admin"), "conflict");
  linking.start();
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await organizationStore.getUser(ORG, principalId))?.sessionVersion === (before?.sessionVersion ?? 0) + 1) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(
      (await organizationStore.getUser(ORG, principalId))?.sessionVersion,
      (before?.sessionVersion ?? 0) + 1,
    );
  } finally {
    linking.stop();
  }
});

test("pause serializes after the final source check for both existing and JIT directory logins", async () => {
  for (const existingBinding of [false, true]) {
    const baseOrganizationStore = createMemoryOrganizationStore({ auditLog: createAuditLog() });
    let blockTransaction = false;
    let transactionsBeforeBlock = 0;
    let transactionEntered!: () => void;
    let releaseTransaction!: () => void;
    const racingOrganizationStore: OrganizationStore = {
      ...baseOrganizationStore,
      async transact(scopeOrgId, fn) {
        if (blockTransaction) {
          if (transactionsBeforeBlock > 0) {
            transactionsBeforeBlock--;
            return baseOrganizationStore.transact(scopeOrgId, fn);
          }
          blockTransaction = false;
          transactionEntered();
          await transactionRelease;
        }
        return baseOrganizationStore.transact(scopeOrgId, fn);
      },
    };
    const { organizationStore, linking, assertion, sources } = await automaticLinkingSetup({
      organizationStore: racingOrganizationStore,
    });
    if (existingBinding) {
      assert.equal((await linking.login({ issuer: "transient", subject: "initial", assertion })).status, "ok");
    }
    const transactionEntry = new Promise<void>((resolve) => {
      transactionEntered = resolve;
    });
    const transactionRelease = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    transactionsBeforeBlock = existingBinding ? 0 : 1;
    blockTransaction = true;
    const login = linking.login({ issuer: "transient", subject: "racing", assertion });
    await transactionEntry;
    const source = await sources.get("source-1");
    assert.ok(source);
    let pauseFinished = false;
    const pause = sources.pause(source.id, source.revision, "admin").then((result) => {
      pauseFinished = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(pauseFinished, false);
    releaseTransaction();
    const loggedIn = await login;
    assert.equal(loggedIn.status, "ok", `existingBinding=${existingBinding} result=${JSON.stringify(loggedIn)}`);
    const paused = await pause;
    assert.ok(paused && paused !== "conflict");
    assert.equal(await linking.invalidateSourceSessions(source.id, "admin", paused.revision), 1);
    const principalId = loggedIn.status === "ok" ? loggedIn.user.principalId : "";
    assert.equal(
      (await organizationStore.getUser(ORG, principalId))?.sessionVersion,
      (loggedIn.status === "ok" ? loggedIn.user.sessionVersion : 0) + 1,
    );
  }
});

test("untrusted provider email assertions cannot bind an existing corporate-email user", async () => {
  const { store, organizationStore, linking, assertion } = await automaticLinkingSetup();
  const source = await store.getSource(ORG, "source-1");
  assert.ok(source);
  await store.putSource(
    {
      ...source,
      capabilities: { ...source.capabilities, trustedCorporateEmail: false },
      jitProvisioningEnabled: false,
    },
    source.revision,
  );
  await organizationStore.putUser(user({ principalId: "victim", email: assertion.corporateEmail }));
  assert.deepEqual(await linking.login({ issuer: "transient", subject: "transient", assertion }), {
    status: "denied",
    reason: "identity_unmatched",
  });
  assert.equal((await organizationStore.listIdentities(ORG)).length, 0);
});

test("manual-only matching never uses email login to create or bind directory identities", async () => {
  const { store, organizationStore, linking } = await automaticLinkingSetup();
  const source = await store.getSource(ORG, "source-1");
  assert.ok(source);
  await store.putSource({ ...source, matchPolicy: "manual_only", jitProvisioningEnabled: false }, source.revision);
  assert.deepEqual(
    await linking.loginEmail({
      principalId: "alice@example.com",
      issuer: "https://mail.example.test",
      subject: "mail-subject-alice",
      email: "alice@example.com",
      displayName: "Alice",
      allowCreate: true,
    }),
    { status: "not_applicable" },
  );
  assert.equal((await organizationStore.listUsers(ORG)).length, 0);
  assert.equal((await organizationStore.listIdentities(ORG)).length, 0);
});

test("an open email-resolution circuit blocks JIT provisioning", async () => {
  const { store, organizationStore, linking, assertion } = await automaticLinkingSetup();
  await store.putEmailLookupGuard({
    orgId: ORG,
    sourceId: "source-1",
    windowStartedAt: 0,
    attempts: 1,
    notFound: 1,
    circuitOpenUntil: 5_000,
    updatedAt: 100,
  });
  assert.deepEqual(await linking.login({ issuer: "transient", subject: "transient", assertion }), {
    status: "denied",
    reason: "identity_unmatched",
  });
  assert.equal((await organizationStore.listUsers(ORG)).length, 0);
});

test("email reconciliation binds a verified email identity before directory login without profile email", async () => {
  const { store, state, organizationStore, emailResolutions, linking, assertion } = await automaticLinkingSetup();
  const snapshotMember = member({ emails: [], revision: "revision-no-email", profileHash: "hash-no-email" });
  state.members = [snapshotMember];
  state.lookupSubjects = { "alice@example.com": snapshotMember.externalSubjectId };
  await store.upsertMember(snapshotMember);
  await organizationStore.putUser(user({ principalId: "existing-alice" }));
  await organizationStore.putIdentity({
    orgId: ORG,
    issuer: "https://mail.example.test",
    subject: "mail-subject-alice",
    principalId: "existing-alice",
    emailAtLink: "alice@example.com",
    evidence: { emailVerified: "true", emailVerifiedEmail: "alice@example.com" },
    createdAt: 1,
    updatedAt: 1,
  });
  assert.deepEqual(await emailResolutions.reconcile("source-1"), {
    status: "ready",
    total: 1,
    resolved: 1,
    notFound: 0,
    blocked: 0,
  });
  const login = await linking.login({
    issuer: "transient",
    subject: "transient",
    assertion: { ...assertion, corporateEmail: null },
  });
  assert.equal(login.status, "ok");
  assert.equal(login.status === "ok" ? login.user.principalId : null, "existing-alice");
  assert.equal((await organizationStore.listUsers(ORG)).length, 1);
  assert.equal((await organizationStore.listIdentities(ORG)).length, 2);
});

test("email reconciliation never looks up or approves a profile email without verified identity evidence", async () => {
  const { state, organizationStore, emailResolutions, sources } = await automaticLinkingSetup();
  await organizationStore.putUser(user({ principalId: "manual-email" }));
  assert.deepEqual(await emailResolutions.reconcile("source-1"), {
    status: "blocked",
    total: 1,
    resolved: 0,
    notFound: 0,
    blocked: 1,
  });
  assert.equal(state.lookups, 0);
  assert.equal((await sources.get("source-1"))?.reconciliationStatus, "blocked");
  assert.equal((await sources.get("source-1"))?.jitProvisioningEnabled, true);
});

test("email reconciliation fails closed when the source cannot provide trusted email lookup", async () => {
  const { store, emailResolutions } = await automaticLinkingSetup();
  const source = await store.getSource(ORG, "source-1");
  assert.ok(source);
  await store.putSource(
    {
      ...source,
      capabilities: { ...source.capabilities, corporateEmailSubjectLookup: false },
      jitProvisioningEnabled: false,
    },
    source.revision,
  );
  await assert.rejects(() => emailResolutions.reconcile("source-1"), /directory_email_resolution_unsupported/);
});

test("managed directory preview and commit create source-owned units, users, and memberships", async () => {
  const store = createMemoryDirectorySourceStore();
  const unit: NormalizedDirectoryUnit = {
    orgId: ORG,
    sourceId: "source-1",
    provider: "fake",
    externalTenantId: "tenant-1",
    externalUnitId: "engineering",
    parentExternalUnitId: null,
    displayName: "Engineering",
    sortOrder: 10,
    status: "active",
    revision: "unit-revision-1",
    observedAt: 100,
    profileHash: "unit-hash-1",
  };
  const state = { members: [member({ primaryDepartmentId: "engineering" })], units: [unit], lookups: 0 };
  const adapter = automaticProvider(state);
  const providers = createDirectoryProviderRegistry([adapter]);
  await seedMemorySource(store, {
    mode: "managed_directory",
    syncEnabled: true,
    previewConfirmedRevision: 1,
    capabilities: adapter.capabilities,
  });
  const sources = createDirectorySourceService({
    orgId: ORG,
    store,
    providers,
    keyMaterial: "directory-test-key-material-0123456789",
    auditLog: createAuditLog(),
  });
  await sources.ready;
  const pending: Promise<void>[] = [];
  const sync = createDirectorySyncEngine({
    orgId: ORG,
    store,
    sources,
    providers,
    leaderLease: createNoopLeaderLease(),
    onBackgroundTask: (task) => pending.push(task),
  });
  await sync.request({ sourceId: "source-1", kind: "manual" });
  await Promise.all(pending);
  const organizationStore = createMemoryOrganizationStore({ auditLog: createAuditLog() });
  await organizationStore.ensureOrgRoot({ orgId: ORG, name: "Acme", actor: "admin", now: 100 });
  const identityService = createIdentityService();
  const linking = createIdentityLinkingService({
    orgId: ORG,
    organizationStore,
    directoryStore: store,
    sources,
    identity: identityService,
  });
  const managed = createManagedDirectoryService({
    orgId: ORG,
    store,
    sources,
    organizationStore,
    identityLinking: linking,
    identity: identityService,
    now: () => 200,
    recoveryIntervalMs: 10,
  });
  const ignoredPreview = await managed.preview("source-1", "admin");
  assert.equal(await linking.ignore("source-1", "external-1", "admin", "not yet"), true);
  await assert.rejects(() => managed.commit("source-1", ignoredPreview.id, "admin"), /managed_directory_preview_stale/);
  assert.equal(await linking.unignore("source-1", "external-1", "admin"), true);
  const preview = await managed.preview("source-1", "admin");
  assert.equal(preview.status, "ready");
  assert.equal(preview.units[0]?.action, "create");
  assert.equal(preview.members[0]?.action, "provision");
  const [committed, repeated] = await Promise.all([
    managed.commit("source-1", preview.id, "admin"),
    managed.commit("source-1", preview.id, "admin"),
  ]);
  assert.equal(committed.status, "committed");
  assert.equal(repeated.status, "committed");
  assert.equal(repeated.id, committed.id);
  const supersededId = "historical-committing-preview";
  await store.putManagedPreview({
    ...preview,
    id: supersededId,
    generation: preview.generation - 1,
    status: "committing",
    createdAt: preview.createdAt - 1,
    committedAt: null,
  });
  await organizationStore.transact(ORG, (tx) =>
    tx.putOperationResult(`managed-directory:${ORG}:source-1:${supersededId}`, {
      principals: [],
      createdOwnership: [],
      desiredOwnership: [],
      removedOwnership: [],
      suspended: [],
      reactivated: [],
      changedUserOwnership: [],
    }),
  );
  await managed.recoverCommitting();
  const superseded = await store.getManagedPreview(ORG, "source-1", supersededId);
  assert.equal(superseded?.status, "blocked");
  assert.deepEqual(superseded?.conflicts, ["superseded_by_newer_commit"]);
  const users = await organizationStore.listUsers(ORG);
  assert.equal(users.length, 1);
  const managedUser = users[0];
  assert.ok(managedUser);
  const units = await organizationStore.listUnits(ORG);
  const engineering = units.find((candidate) => candidate.name === "Engineering");
  assert.ok(engineering);
  assert.equal((await organizationStore.listUnitMembers(ORG, engineering.id))[0]?.principalId, users[0]?.principalId);
  assert.equal((await store.listUnitMappings(ORG, "source-1"))[0]?.unitId, engineering.id);
  assert.equal((await store.listUnitMemberOwnership(ORG, "source-1")).length, 1);
  assert.deepEqual(
    (await store.listManagedUserOwnership(ORG, "source-1")).map((ownership) => ({
      principalId: ownership.principalId,
      suspendedBySource: ownership.suspendedBySource,
      suspendedSessionVersion: ownership.suspendedSessionVersion,
    })),
    [{ principalId: managedUser.principalId, suspendedBySource: false, suspendedSessionVersion: null }],
  );

  const firstPageMember = await store.getMember(ORG, "source-1", "external-1");
  assert.ok(firstPageMember);
  const secondPageMember = member({
    externalSubjectId: "external-2",
    displayName: "Bob External",
    emails: [{ value: "bob@example.com", kind: "corporate", verified: true }],
    employeeNumber: "E-2",
    mobile: "+8613800000002",
    primaryDepartmentId: "engineering",
    snapshotRevision: firstPageMember.snapshotRevision,
    revision: "revision-2",
    profileHash: "hash-2",
  });
  const pagedStore: DirectorySourceStore = {
    ...store,
    async listMembers(scopeOrgId, sourceId, query) {
      assert.equal(query.limit, 1_000);
      return query.after
        ? { members: [secondPageMember], next: null }
        : { members: [firstPageMember], next: { externalSubjectId: firstPageMember.externalSubjectId } };
    },
  };
  const pagedManaged = createManagedDirectoryService({
    orgId: ORG,
    store: pagedStore,
    sources,
    organizationStore,
    identityLinking: linking,
    identity: identityService,
    now: () => 200,
  });
  const pagedPreview = await pagedManaged.preview("source-1", "admin");
  assert.deepEqual(
    pagedPreview.members.map((plan) => plan.externalSubjectId),
    ["external-1", "external-2"],
  );

  const staleOrganizationPreview = await managed.preview("source-1", "admin");
  await organizationStore.transact(ORG, async (tx) => tx.bumpRevision(ORG));
  await assert.rejects(
    () => managed.commit("source-1", staleOrganizationPreview.id, "admin"),
    /managed_directory_preview_stale/,
  );

  let commitEntered!: () => void;
  let releaseCommit!: () => void;
  const commitEntry = new Promise<void>((resolve) => {
    commitEntered = resolve;
  });
  const commitRelease = new Promise<void>((resolve) => {
    releaseCommit = resolve;
  });
  let blockCommit = true;
  const racingOrganizationStore: OrganizationStore = {
    ...organizationStore,
    async transact(scopeOrgId, fn) {
      if (blockCommit) {
        blockCommit = false;
        commitEntered();
        await commitRelease;
      }
      return organizationStore.transact(scopeOrgId, fn);
    },
  };
  const racingManaged = createManagedDirectoryService({
    orgId: ORG,
    store,
    sources,
    organizationStore: racingOrganizationStore,
    identityLinking: linking,
    identity: identityService,
    now: () => 200,
  });
  const concurrentPreview = await racingManaged.preview("source-1", "admin");
  const concurrentCommit = racingManaged.commit("source-1", concurrentPreview.id, "admin");
  await commitEntry;
  await organizationStore.transact(ORG, async (tx) => tx.bumpRevision(ORG));
  releaseCommit();
  await assert.rejects(() => concurrentCommit, /managed_directory_preview_stale/);
  assert.equal((await store.getManagedPreview(ORG, "source-1", concurrentPreview.id))?.status, "blocked");

  let interruptCommit = true;
  const interruptedOrganizationStore: OrganizationStore = {
    ...organizationStore,
    async transact(scopeOrgId, fn) {
      if (interruptCommit) {
        interruptCommit = false;
        throw new Error("organization_transaction_unavailable");
      }
      return organizationStore.transact(scopeOrgId, fn);
    },
  };
  const interruptedManaged = createManagedDirectoryService({
    orgId: ORG,
    store,
    sources,
    organizationStore: interruptedOrganizationStore,
    identityLinking: linking,
    identity: identityService,
    now: () => 200,
  });
  const interruptedPreview = await interruptedManaged.preview("source-1", "admin");
  await assert.rejects(
    () => interruptedManaged.commit("source-1", interruptedPreview.id, "admin"),
    /organization_transaction_unavailable/,
  );
  assert.equal((await store.getManagedPreview(ORG, "source-1", interruptedPreview.id))?.status, "committing");
  await organizationStore.transact(ORG, async (tx) => tx.bumpRevision(ORG));
  await assert.rejects(() => interruptedManaged.recoverCommitting(), /managed_directory_recovery_failed/);
  assert.equal((await store.getManagedPreview(ORG, "source-1", interruptedPreview.id))?.status, "blocked");

  const externalIdentity = (await organizationStore.listIdentities(ORG))[0];
  assert.ok(externalIdentity);
  await organizationStore.putUser(user({ principalId: "manual-user", email: "manual@example.com" }));
  await organizationStore.putIdentity({ ...externalIdentity, principalId: "manual-user", updatedAt: 201 });
  const ownershipConflict = await managed.preview("source-1", "admin");
  assert.equal(ownershipConflict.status, "blocked");
  assert.deepEqual(ownershipConflict.conflicts, ["managed_user_ownership_principal_conflict:external-1"]);
  await organizationStore.putIdentity({ ...externalIdentity, updatedAt: 202 });

  await organizationStore.putUser({
    ...managedUser,
    status: "suspended",
    sessionVersion: managedUser.sessionVersion + 1,
    updatedAt: 201,
    updatedBy: "admin",
  });
  const manuallySuspended = await managed.preview("source-1", "admin");
  assert.equal(manuallySuspended.status, "blocked");
  assert.deepEqual(manuallySuspended.conflicts, ["managed_member_status_conflict:external-1"]);

  await organizationStore.putUser({
    ...managedUser,
    status: "active",
    sessionVersion: managedUser.sessionVersion + 2,
    updatedAt: 202,
    updatedBy: "admin",
  });
  await store.upsertMember(member({ status: "inactive", observedAt: 203 }));
  const suspensionPreview = await managed.preview("source-1", "admin");
  assert.equal(suspensionPreview.members[0]?.action, "suspend");
  const deactivate = identityService.deactivate.bind(identityService);
  let projectionFailures = 2;
  identityService.deactivate = async (...args) => {
    if (projectionFailures > 0) {
      projectionFailures--;
      throw new Error("projection_unavailable");
    }
    await deactivate(...args);
  };
  await assert.rejects(() => managed.commit("source-1", suspensionPreview.id, "admin"), /projection_unavailable/);
  assert.equal((await store.getManagedPreview(ORG, "source-1", suspensionPreview.id))?.status, "committing");
  await assert.rejects(() => managed.preview("source-1", "admin"), /managed_directory_commit_in_progress/);
  managed.start();
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await store.getManagedPreview(ORG, "source-1", suspensionPreview.id))?.status === "committed") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await store.getManagedPreview(ORG, "source-1", suspensionPreview.id))?.status, "committed");
  const suspendedUser = await organizationStore.getUser(ORG, managedUser.principalId);
  assert.equal(suspendedUser?.status, "suspended");
  assert.equal(
    (await store.listManagedUserOwnership(ORG, "source-1"))[0]?.suspendedSessionVersion,
    suspendedUser?.sessionVersion,
  );

  await store.upsertMember(member({ status: "active", observedAt: 204 }));
  const reactivationPreview = await managed.preview("source-1", "admin");
  assert.equal(reactivationPreview.status, "ready");
  await managed.commit("source-1", reactivationPreview.id, "admin");
  assert.equal((await organizationStore.getUser(ORG, managedUser.principalId))?.status, "active");
  assert.deepEqual(
    (await store.listManagedUserOwnership(ORG, "source-1")).map((ownership) => ({
      suspendedBySource: ownership.suspendedBySource,
      suspendedSessionVersion: ownership.suspendedSessionVersion,
    })),
    [{ suspendedBySource: false, suspendedSessionVersion: null }],
  );
  managed.stop();
  sync.stop();
});

test("managed directory resolves same-name manual units with explicit create or map decisions", async () => {
  const store = createMemoryDirectorySourceStore();
  const unit: NormalizedDirectoryUnit = {
    orgId: ORG,
    sourceId: "source-1",
    provider: "fake",
    externalTenantId: "tenant-1",
    externalUnitId: "engineering",
    parentExternalUnitId: null,
    displayName: "Engineering",
    sortOrder: 10,
    status: "active",
    revision: "unit-revision-1",
    observedAt: 100,
    profileHash: "unit-hash-1",
  };
  const state = { members: [member({ primaryDepartmentId: "engineering" })], units: [unit], lookups: 0 };
  const adapter = automaticProvider(state);
  const providers = createDirectoryProviderRegistry([adapter]);
  await seedMemorySource(store, {
    mode: "managed_directory",
    syncEnabled: true,
    previewConfirmedRevision: 1,
    capabilities: adapter.capabilities,
  });
  const sources = createDirectorySourceService({
    orgId: ORG,
    store,
    providers,
    keyMaterial: "directory-test-key-material-0123456789",
    auditLog: createAuditLog(),
  });
  await sources.ready;
  const pending: Promise<void>[] = [];
  const sync = createDirectorySyncEngine({
    orgId: ORG,
    store,
    sources,
    providers,
    leaderLease: createNoopLeaderLease(),
    onBackgroundTask: (task) => pending.push(task),
  });
  await sync.request({ sourceId: "source-1", kind: "manual", idempotencyKey: "manual-unit-collision" });
  await Promise.all(pending.splice(0));
  const organizationStore = createMemoryOrganizationStore({ auditLog: createAuditLog() });
  await organizationStore.ensureOrgRoot({ orgId: ORG, name: "Acme", actor: "admin", now: 100 });
  const root = (await organizationStore.listUnits(ORG)).find((candidate) => candidate.parentId === null);
  assert.ok(root);
  await organizationStore.putUnit({
    orgId: ORG,
    id: "manual-engineering",
    parentId: root.id,
    name: "Engineering",
    kind: "department",
    status: "active",
    sortOrder: 5,
    createdAt: 100,
    updatedAt: 100,
    createdBy: "admin",
    updatedBy: "admin",
  });
  const identityService = createIdentityService();
  const linking = createIdentityLinkingService({
    orgId: ORG,
    organizationStore,
    directoryStore: store,
    sources,
    identity: identityService,
  });
  const managed = createManagedDirectoryService({
    orgId: ORG,
    store,
    sources,
    organizationStore,
    identityLinking: linking,
    identity: identityService,
    now: () => 200,
  });
  const blocked = await managed.preview("source-1", "admin");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.units[0]?.collisionUnitId, "manual-engineering");
  assert.deepEqual(blocked.conflicts, ["manual_unit_name_collision:engineering"]);
  await organizationStore.transact(ORG, (tx) => tx.bumpRevision(ORG));
  assert.equal(
    await managed.decideUnitMapping({
      sourceId: "source-1",
      previewId: blocked.id,
      externalUnitId: "engineering",
      decision: "create",
      actor: "admin",
    }),
    "conflict",
  );
  const currentBlocked = await managed.preview("source-1", "admin");
  assert.equal(
    await managed.decideUnitMapping({
      sourceId: "source-1",
      previewId: currentBlocked.id,
      externalUnitId: "engineering",
      decision: "create",
      actor: "admin",
    }),
    "mapped",
  );
  const createPreview = await managed.preview("source-1", "admin");
  assert.equal(createPreview.status, "ready");
  assert.equal(createPreview.units[0]?.ownership, "source");
  assert.equal(createPreview.units[0]?.action, "create");
  const mappingTarget = await organizationStore.getUnit(ORG, "manual-engineering");
  assert.ok(mappingTarget);
  const putUnitMapping = store.putUnitMapping.bind(store);
  let mappingWriteEntered!: () => void;
  let releaseMappingWrite!: () => void;
  const mappingWriteEntry = new Promise<void>((resolve) => {
    mappingWriteEntered = resolve;
  });
  const mappingWriteRelease = new Promise<void>((resolve) => {
    releaseMappingWrite = resolve;
  });
  let blockMappingWrite = true;
  store.putUnitMapping = async (mapping, audit) => {
    if (blockMappingWrite) {
      blockMappingWrite = false;
      mappingWriteEntered();
      await mappingWriteRelease;
    }
    await putUnitMapping(mapping, audit);
  };
  const mapDecision = managed.decideUnitMapping({
    sourceId: "source-1",
    previewId: createPreview.id,
    externalUnitId: "engineering",
    decision: "map",
    actor: "admin",
  });
  await mappingWriteEntry;
  let concurrentRenameFinished = false;
  const concurrentRename = organizationStore
    .transact(ORG, async (tx) => {
      await tx.putUnit({ ...mappingTarget, name: "Engineering Renamed", updatedAt: 201, updatedBy: "admin" });
      await tx.bumpRevision(ORG);
    })
    .then(() => {
      concurrentRenameFinished = true;
    });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(concurrentRenameFinished, false);
  releaseMappingWrite();
  assert.equal(await mapDecision, "mapped");
  await concurrentRename;
  await organizationStore.transact(ORG, async (tx) => {
    await tx.putUnit({ ...mappingTarget, updatedAt: 202, updatedBy: "admin" });
    await tx.bumpRevision(ORG);
  });
  await assert.rejects(() => managed.commit("source-1", createPreview.id, "admin"), /managed_directory_preview_stale/);
  const mappedPreview = await managed.preview("source-1", "admin");
  assert.equal(mappedPreview.status, "ready");
  assert.equal(mappedPreview.units[0]?.ownership, "manual");
  assert.equal(mappedPreview.units[0]?.action, "unchanged");
  assert.ok(mappedPreview.preserved.some((item) => item.kind === "manual_unit"));
  assert.equal(mappedPreview.relations[0]?.action, "add");
  await managed.commit("source-1", mappedPreview.id, "admin");
  const manual = await organizationStore.getUnit(ORG, "manual-engineering");
  assert.equal(manual?.createdBy, "admin");
  assert.equal(manual?.sortOrder, 5);
  assert.equal((await store.listUnitMappings(ORG, "source-1"))[0]?.ownership, "manual");
  assert.equal((await organizationStore.listUnits(ORG)).length, 2);
  managed.stop();
  sync.stop();
});

test("migration preview classifies candidates without writing bindings or member match state", async () => {
  const state = { members: [member()] };
  const { store, service } = setupSource(state);
  const created = await service.create(
    {
      provider: "fake",
      name: "Corporate directory",
      publicConfig: { tenant: "tenant-1", redirectUri: "https://agent.example.test/idp/directory/callback" },
      secretConfig: { secret: "provider-secret" },
    },
    "admin",
  );
  await store.upsertMember(member({ sourceId: created.id }));
  const organization = createMemoryOrganizationStore({ auditLog: createAuditLog() });
  await organization.putUser(user());
  const migration = createDirectoryIdentityMigrationService({
    orgId: ORG,
    organizationStore: organization,
    directoryStore: store,
    sources: service,
    now: () => 42,
  });
  const preview = await migration.preview(created.id);
  assert.equal(preview.generatedAt, 42);
  assert.equal(preview.counts.unique_corporate_email_candidate, 1);
  assert.equal((await organization.listIdentities(ORG)).length, 0);
  assert.equal((await store.getMember(ORG, created.id, "external-1"))?.matchState, "unmatched");
});

test("WeCom adapter fixes API hosts and preserves corporate versus personal email semantics", async () => {
  const calls: URL[] = [];
  const emailLookupBodies: unknown[] = [];
  let listCalls = 0;
  const adapter = createWeComDirectoryProvider({
    fetchImpl: async (input, init) => {
      const url = new URL(input.toString());
      calls.push(url);
      if (url.pathname === "/cgi-bin/gettoken") {
        const token =
          url.searchParams.get("corpsecret") === "directory-secret" ? "directory-token" : "application-token";
        return new Response(JSON.stringify({ errcode: 0, access_token: token, expires_in: 7200 }));
      }
      if (url.pathname === "/cgi-bin/agent/get") {
        return new Response(JSON.stringify({ errcode: 0, agentid: 1000002 }));
      }
      if (url.pathname === "/cgi-bin/user/list_id") {
        listCalls++;
        return new Response(
          JSON.stringify({ errcode: 0, dept_user: listCalls === 1 ? [] : [{ userid: "alice" }], next_cursor: "" }),
        );
      }
      if (url.pathname === "/cgi-bin/user/get") {
        return new Response(
          JSON.stringify({
            errcode: 0,
            userid: "alice",
            name: "Alice",
            biz_mail: "Alice@Corp.Example",
            email: "alice@personal.example",
            department: [2],
            mobile: "+8613800000000",
            status: 1,
          }),
        );
      }
      if (url.pathname === "/cgi-bin/user/get_userid_by_email") {
        emailLookupBodies.push(JSON.parse(String(init?.body)) as unknown);
        return new Response(JSON.stringify({ errcode: 0, userid: "alice" }));
      }
      if (url.pathname === "/cgi-bin/department/simplelist") {
        return new Response(
          JSON.stringify({
            errcode: 0,
            department_id: [
              { id: 1, parentid: 0, order: 1 },
              { id: 2, parentid: 1, order: 20 },
            ],
          }),
        );
      }
      if (url.pathname === "/cgi-bin/department/get") {
        const id = url.searchParams.get("id");
        return new Response(
          JSON.stringify({
            errcode: 0,
            department: {
              id: Number(id),
              name: id === "1" ? "Acme" : "Engineering",
              parentid: id === "1" ? 0 : 1,
              order: id === "1" ? 1 : 20,
            },
          }),
        );
      }
      return new Response(JSON.stringify({ errcode: 40000 }), { status: 400 });
    },
  });
  const config = {
    publicConfig: {
      corpId: "wwcorp",
      agentId: "1000002",
      redirectUri: "https://agent.example.test/idp/directory/callback",
    },
    secretConfig: { applicationSecret: "application-secret", directorySyncSecret: "directory-secret" },
  };
  const tested = await adapter.testConnection(config);
  assert.equal(tested.externalTenantId, "wwcorp");
  assert.equal(tested.capabilities.fullSync, true);
  const synchronized: NormalizedDirectoryMember[] = [];
  for await (const value of adapter.fullSync(config, { orgId: ORG, sourceId: "source-wecom" }))
    synchronized.push(value);
  assert.deepEqual(synchronized[0]?.emails, [
    { value: "alice@corp.example", kind: "corporate", verified: true },
    { value: "alice@personal.example", kind: "personal", verified: false },
  ]);
  assert.equal(
    calls.every((url) => url.hostname === "qyapi.weixin.qq.com"),
    true,
  );
  assert.equal(
    calls.find((url) => url.pathname === "/cgi-bin/agent/get")?.searchParams.get("access_token"),
    "application-token",
  );
  assert.deepEqual(await adapter.lookupByCorporateEmail?.(config, { email: "alice@corp.example" }), {
    status: "resolved",
    externalSubjectId: "alice",
  });
  assert.deepEqual(emailLookupBodies, [{ email: "alice@corp.example", email_type: 1 }]);
  assert.equal(
    calls.find((url) => url.pathname === "/cgi-bin/user/get_userid_by_email")?.searchParams.get("access_token"),
    "application-token",
  );
  const units: NormalizedDirectoryUnit[] = [];
  for await (const unit of adapter.organizationUnits?.(config, { orgId: ORG, sourceId: "source-wecom" }) ?? []) {
    units.push(unit);
  }
  assert.deepEqual(
    units.map((unit) => [unit.externalUnitId, unit.parentExternalUnitId, unit.displayName]),
    [
      ["1", null, "Acme"],
      ["2", "1", "Engineering"],
    ],
  );
  assert.equal(
    calls.find((url) => url.pathname === "/cgi-bin/user/list_id")?.searchParams.get("access_token"),
    "directory-token",
  );
  assert.equal(
    calls.find((url) => url.pathname === "/cgi-bin/user/get")?.searchParams.get("access_token"),
    "application-token",
  );
  const loginOnlyConfig = {
    ...config,
    secretConfig: { applicationSecret: "application-secret" },
  };
  const loginOnly = await adapter.testConnection(loginOnlyConfig);
  assert.equal(loginOnly.capabilities.fullSync, false);
  await assert.rejects(async () => {
    for await (const _member of adapter.fullSync(loginOnlyConfig, { orgId: ORG, sourceId: "source-wecom" })) {
      void _member;
    }
  }, /directory_sync_secret_missing/);
  const authorize = new URL(adapter.authorizeUrl(config.publicConfig, { sourceId: "source-wecom", state: "sealed" }));
  assert.equal(authorize.hostname, "open.work.weixin.qq.com");
  assert.equal(authorize.searchParams.get("state"), "sealed");
});

test("WeCom QR identity resolution does not depend on the member-detail endpoint", async () => {
  const calls: string[] = [];
  const adapter = createWeComDirectoryProvider({
    fetchImpl: async (input) => {
      const url = new URL(input.toString());
      calls.push(url.pathname);
      if (url.pathname === "/cgi-bin/gettoken") {
        return new Response(JSON.stringify({ errcode: 0, access_token: "application-token", expires_in: 7200 }));
      }
      if (url.pathname === "/cgi-bin/auth/getuserinfo") {
        return new Response(JSON.stringify({ errcode: 0, UserId: "alice" }));
      }
      throw new Error(`unexpected endpoint ${url.pathname}`);
    },
  });
  const identity = await adapter.resolveLoginCode(
    {
      publicConfig: {
        corpId: "wwcorp",
        agentId: "1000002",
        redirectUri: "https://agent.example.test/idp/directory/callback",
      },
      secretConfig: { applicationSecret: "application-secret" },
    },
    { sourceId: "source-wecom", code: "qr-code" },
  );
  assert.deepEqual(identity, {
    sourceId: "source-wecom",
    provider: "wecom",
    externalTenantId: "wwcorp",
    externalSubjectId: "alice",
    displayName: "alice",
    corporateEmail: null,
    personalEmail: null,
    employeeNumber: null,
    mobile: null,
    status: "active",
  });
  assert.deepEqual(calls, ["/cgi-bin/gettoken", "/cgi-bin/auth/getuserinfo"]);
});

test("WeCom rejects callback URLs containing credentials on every authorization path", async () => {
  const adapter = createWeComDirectoryProvider({
    fetchImpl: async () => {
      throw new Error("provider request must not be sent");
    },
  });
  const publicConfig = {
    corpId: "wwcorp",
    agentId: "1000002",
    redirectUri: "https://operator:secret@agent.example.test/idp/directory/callback",
  };
  const config = { publicConfig, secretConfig: { applicationSecret: "application-secret" } };

  assert.throws(
    () => adapter.authorizeUrl(publicConfig, { sourceId: "source-wecom", state: "login-state" }),
    /wecom_redirect_uri_invalid/,
  );
  assert.throws(
    () => adapter.profileAuthorizeUrl?.(publicConfig, { sourceId: "source-wecom", state: "profilestate" }),
    /wecom_redirect_uri_invalid/,
  );
  await assert.rejects(() => adapter.testConnection(config), /wecom_redirect_uri_invalid/);
});

test("WeCom authorization prompts are best effort and never claim an undelivered message", async () => {
  const sent: unknown[] = [];
  const adapter = (rejected: Record<string, string> = {}) =>
    createWeComDirectoryProvider({
      fetchImpl: async (input, init) => {
        const url = new URL(input.toString());
        if (url.pathname === "/cgi-bin/gettoken") {
          return new Response(JSON.stringify({ errcode: 0, access_token: "application-token", expires_in: 7200 }));
        }
        if (url.pathname === "/cgi-bin/message/send") {
          sent.push(JSON.parse(String(init?.body)) as unknown);
          return new Response(JSON.stringify({ errcode: 0, ...rejected }));
        }
        return new Response(JSON.stringify({ errcode: 40000 }), { status: 400 });
      },
    });
  const config = {
    publicConfig: { corpId: "wwcorp", agentId: "1000002", redirectUri: "https://agent.example.test/cb" },
    secretConfig: { applicationSecret: "application-secret" },
  };
  const input = { externalSubjectId: "alice", authorizeUrl: "https://open.weixin.qq.com/x", brandName: "qm" };

  assert.equal(await adapter().sendProfileAuthorizationPrompt?.(config, input), true);
  const body = sent[0] as { touser: string; msgtype: string; agentid: number; textcard: { url: string } };
  assert.equal(body.touser, "alice");
  assert.equal(body.msgtype, "textcard");
  assert.equal(body.agentid, 1000002);
  assert.equal(body.textcard.url, input.authorizeUrl);

  assert.equal(
    await adapter({ invaliduser: "alice" }).sendProfileAuthorizationPrompt?.(config, input),
    false,
    "errcode 0 with invaliduser means the member never got it",
  );
  assert.equal(
    await adapter({ unlicenseduser: "alice" }).sendProfileAuthorizationPrompt?.(config, input),
    false,
    "errcode 0 with unlicenseduser means the member never got it",
  );
  assert.equal(
    await adapter().sendProfileAuthorizationPrompt?.(config, {
      ...input,
      authorizeUrl: `https://x/${"u".repeat(2100)}`,
    }),
    false,
    "an over-long url is refused before it reaches WeCom",
  );

  const broken = createWeComDirectoryProvider({
    fetchImpl: async () => new Response(JSON.stringify({ errcode: 40001 }), { status: 200 }),
  });
  assert.equal(
    await broken.sendProfileAuthorizationPrompt?.(config, input),
    false,
    "a provider failure degrades to the QR path instead of throwing",
  );
});

test("WeCom profile authorization resolves consented corporate email and fences the QR UserID", async () => {
  const profileBodies: unknown[] = [];
  let detailedSubjectId = "alice";
  const adapter = createWeComDirectoryProvider({
    fetchImpl: async (input, init) => {
      const url = new URL(input.toString());
      if (url.pathname === "/cgi-bin/gettoken") {
        return new Response(JSON.stringify({ errcode: 0, access_token: "application-token", expires_in: 7200 }));
      }
      if (url.pathname === "/cgi-bin/user/getuserinfo") {
        assert.equal(url.searchParams.get("access_token"), "application-token");
        assert.equal(url.searchParams.get("code"), "profile-code");
        return new Response(JSON.stringify({ errcode: 0, UserId: "alice", user_ticket: "user-ticket" }));
      }
      if (url.pathname === "/cgi-bin/auth/getuserdetail") {
        profileBodies.push(JSON.parse(String(init?.body)) as unknown);
        return new Response(
          JSON.stringify({
            errcode: 0,
            userid: detailedSubjectId,
            name: "Alice Authorized",
            biz_mail: "Alice@Corp.Example",
            email: "alice@personal.example",
            mobile: "+8613800000000",
          }),
        );
      }
      return new Response(JSON.stringify({ errcode: 40000 }), { status: 400 });
    },
  });
  const config = {
    publicConfig: {
      corpId: "wwcorp",
      agentId: "1000002",
      redirectUri: "https://agent.example.test/idp/directory/callback",
    },
    secretConfig: { applicationSecret: "application-secret" },
  };
  const authorize = new URL(
    adapter.profileAuthorizeUrl?.(config.publicConfig, { sourceId: "source-wecom", state: "sealedProfile" }) ?? "",
  );
  assert.equal(`${authorize.origin}${authorize.pathname}`, "https://open.weixin.qq.com/connect/oauth2/authorize");
  assert.equal(authorize.searchParams.get("appid"), "wwcorp");
  assert.equal(authorize.searchParams.get("agentid"), "1000002");
  assert.equal(authorize.searchParams.get("redirect_uri"), config.publicConfig.redirectUri);
  assert.equal(authorize.searchParams.get("response_type"), "code");
  assert.equal(authorize.searchParams.get("scope"), "snsapi_privateinfo");
  assert.equal(authorize.searchParams.get("state"), "sealedProfile");
  assert.equal(authorize.hash, "#wechat_redirect");
  assert.throws(
    () => adapter.profileAuthorizeUrl?.(config.publicConfig, { sourceId: "source-wecom", state: "invalid-state" }),
    /profile_state_invalid/,
  );

  const identity = await adapter.resolveProfileAuthorizationCode?.(config, {
    sourceId: "source-wecom",
    code: "profile-code",
    expectedExternalSubjectId: "alice",
  });
  assert.deepEqual(profileBodies, [{ user_ticket: "user-ticket" }]);
  assert.deepEqual(identity, {
    sourceId: "source-wecom",
    provider: "wecom",
    externalTenantId: "wwcorp",
    externalSubjectId: "alice",
    displayName: "Alice Authorized",
    corporateEmail: "alice@corp.example",
    personalEmail: "alice@personal.example",
    employeeNumber: null,
    mobile: "+8613800000000",
    status: "active",
  });

  detailedSubjectId = "mallory";
  await assert.rejects(
    () =>
      adapter.resolveProfileAuthorizationCode!(config, {
        sourceId: "source-wecom",
        code: "profile-code",
        expectedExternalSubjectId: "alice",
      }),
    /profile_detail_user_mismatch/,
  );
});

test("WeCom full sync rejects cursor cycles, malformed cursors, malformed list entries, and unknown member status", async () => {
  const config = {
    publicConfig: {
      corpId: "wwcorp",
      agentId: "1000002",
      redirectUri: "https://agent.example.test/idp/directory/callback",
    },
    secretConfig: { applicationSecret: "application-secret", directorySyncSecret: "directory-secret" },
  };
  const collect = async (adapter: DirectoryProviderAdapter): Promise<void> => {
    for await (const _member of adapter.fullSync(config, { orgId: ORG, sourceId: "source-wecom" })) void _member;
  };
  const adapterFor = (mode: "cursor" | "malformed-cursor" | "entry" | "status") => {
    let listCalls = 0;
    return createWeComDirectoryProvider({
      fetchImpl: async (input) => {
        const url = new URL(input.toString());
        if (url.pathname === "/cgi-bin/gettoken") {
          return new Response(JSON.stringify({ errcode: 0, access_token: "token", expires_in: 7200 }));
        }
        if (url.pathname === "/cgi-bin/user/list_id") {
          if (mode === "cursor") {
            listCalls++;
            return new Response(
              JSON.stringify({ errcode: 0, dept_user: [], next_cursor: ["A", "B", "A"][listCalls - 1] }),
            );
          }
          if (mode === "malformed-cursor") {
            return new Response(JSON.stringify({ errcode: 0, dept_user: [], next_cursor: 42 }));
          }
          if (mode === "entry") return new Response(JSON.stringify({ errcode: 0, dept_user: [{}], next_cursor: "" }));
          return new Response(JSON.stringify({ errcode: 0, dept_user: [{ userid: "alice" }], next_cursor: "" }));
        }
        if (url.pathname === "/cgi-bin/user/get") {
          return new Response(JSON.stringify({ errcode: 0, userid: "alice", name: "Alice" }));
        }
        return new Response(JSON.stringify({ errcode: 40000 }), { status: 400 });
      },
    });
  };
  await assert.rejects(() => collect(adapterFor("cursor")), /repeated_cursor/);
  await assert.rejects(() => collect(adapterFor("malformed-cursor")), /invalid_cursor/);
  await assert.rejects(() => collect(adapterFor("entry")), /invalid_user/);
  await assert.rejects(() => collect(adapterFor("status")), /status_invalid/);
});
