import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuditLog, type AuditLog } from "../src/audit/audit-log.ts";
import { createIdentityService, type IdentityService } from "../src/identity/identity-service.ts";
import { createOrganizationService, type LoginInput, type OrgAdmission } from "../src/organization/organization-service.ts";
import {
  createMemoryOrganizationStore,
  type OrganizationStore,
  type OrganizationUser,
} from "../src/organization/organization-store.ts";

const ORG = "default-org";
const ISSUER = "https://idp.example.com";
const SCOPE = "org:default-org";

interface Harness {
  store: OrganizationStore;
  auditLog: AuditLog;
  identity: IdentityService;
  service: ReturnType<typeof createOrganizationService>;
  advance(ms: number): void;
}

function setup(over: { admission?: OrgAdmission; autoJoinDomains?: readonly string[]; store?: OrganizationStore } = {}): Harness {
  const store = over.store ?? createMemoryOrganizationStore();
  const auditLog = createAuditLog();
  const identity = createIdentityService();
  let nowMs = 1_700_000_000_000;
  const service = createOrganizationService({
    store,
    orgId: ORG,
    admission: over.admission ?? "invite_only",
    autoJoinDomains: over.autoJoinDomains ?? [],
    auditLog,
    identity,
    now: () => nowMs,
  });
  return { store, auditLog, identity, service, advance: (ms) => void (nowMs += ms) };
}

const loginInput = (over: Partial<LoginInput> = {}): LoginInput => ({
  principalId: "alice@acme.com",
  issuer: ISSUER,
  subject: "sub-1",
  email: "alice@acme.com",
  emailVerified: true,
  displayName: "Alice",
  ...over,
});

const orgUser = (over: Partial<OrganizationUser> = {}): OrganizationUser => ({
  orgId: ORG,
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

const boundIdentity = (over: Partial<{ subject: string; principalId: string }> = {}) => ({
  orgId: ORG,
  issuer: ISSUER,
  subject: over.subject ?? "sub-1",
  principalId: over.principalId ?? "alice@acme.com",
  emailAtLink: "alice@acme.com",
  createdAt: 1,
  updatedAt: 1,
});

test("login: unknown user under invite_only is denied not_invited", async () => {
  const { service } = setup();
  const result = await service.login(loginInput());
  assert.deepEqual(result, { status: "denied", reason: "not_invited" });
});

test("login: domain_auto_join creates an active user and links the identity", async () => {
  const { service, store } = setup({ admission: "domain_auto_join", autoJoinDomains: ["acme.com"] });
  const result = await service.login(loginInput());
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.user.status, "active");
  assert.equal(result.user.sessionVersion, 1);
  assert.equal(result.user.createdBy, "system:login");
  assert.equal(result.user.updatedBy, "system:login");
  const persisted = await store.getUser(ORG, "alice@acme.com");
  assert.equal(persisted?.status, "active");
  const linked = await store.getIdentity(ORG, ISSUER, "sub-1");
  assert.equal(linked?.principalId, "alice@acme.com");
});

test("login: domain_auto_join denies an email outside the allowed domains", async () => {
  const { service } = setup({ admission: "domain_auto_join", autoJoinDomains: ["other.com"] });
  const result = await service.login(loginInput());
  assert.deepEqual(result, { status: "denied", reason: "not_invited" });
});

test("login: domain_auto_join denies an unverified email as email_unverified", async () => {
  const { service } = setup({ admission: "domain_auto_join", autoJoinDomains: ["acme.com"] });
  const result = await service.login(loginInput({ emailVerified: false }));
  assert.deepEqual(result, { status: "denied", reason: "email_unverified" });
});

test("login: invited user matched by email activates and binds the identity", async () => {
  const { service, store } = setup();
  await service.invite({ principalId: "alice@acme.com", email: "Alice@Acme.com", displayName: "Alice", actor: "admin@acme.com" });
  const result = await service.login(loginInput({ email: "alice@acme.com" }));
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.user.status, "active");
  assert.equal(result.user.sessionVersion, 2);
  const linked = await store.getIdentity(ORG, ISSUER, "sub-1");
  assert.equal(linked?.principalId, "alice@acme.com");
  const again = await service.login(loginInput({ email: null, emailVerified: false }));
  assert.equal(again.status, "ok");
  if (again.status !== "ok") return;
  assert.equal(again.user.principalId, "alice@acme.com");
});

test("login: pre-bound invited user activates on first login", async () => {
  const { service, store } = setup();
  await service.invite({ principalId: "alice@acme.com", email: "alice@acme.com", displayName: "Alice", actor: "admin@acme.com" });
  await store.putIdentity(boundIdentity({ subject: "sub-9" }));
  const result = await service.login(loginInput({ subject: "sub-9", email: null, emailVerified: false }));
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.user.status, "active");
  assert.equal(result.user.sessionVersion, 2);
});

test("login: suspended and deprovisioned users are denied with their reason", async () => {
  const { service, store } = setup();
  await store.putUser(orgUser({ status: "suspended" }));
  await store.putIdentity(boundIdentity());
  const suspended = await service.login(loginInput());
  assert.deepEqual(suspended, { status: "denied", reason: "suspended" });
  await store.putUser(orgUser({ status: "deprovisioned" }));
  const deprovisioned = await service.login(loginInput());
  assert.deepEqual(deprovisioned, { status: "denied", reason: "deprovisioned" });
});

test("login: identity without a user row is denied unknown", async () => {
  const { service, store } = setup();
  await store.putIdentity(boundIdentity({ principalId: "ghost@acme.com" }));
  const result = await service.login(loginInput({ principalId: "ghost@acme.com", email: "ghost@acme.com" }));
  assert.deepEqual(result, { status: "denied", reason: "unknown" });
});

test("login: email match on a non-invited user fails closed and never recreates the row", async () => {
  const active = setup({ admission: "domain_auto_join", autoJoinDomains: ["acme.com"] });
  await active.store.putUser(orgUser({ status: "active", sessionVersion: 5 }));
  const activeResult = await active.service.login(loginInput({ subject: "sub-new" }));
  assert.deepEqual(activeResult, { status: "denied", reason: "unknown" });
  assert.equal((await active.store.getUser(ORG, "alice@acme.com"))?.sessionVersion, 5, "active user row untouched");

  const suspended = setup({ admission: "domain_auto_join", autoJoinDomains: ["acme.com"] });
  await suspended.store.putUser(orgUser({ status: "suspended", sessionVersion: 3 }));
  const suspendedResult = await suspended.service.login(loginInput({ subject: "sub-new" }));
  assert.deepEqual(suspendedResult, { status: "denied", reason: "suspended" });
  assert.equal((await suspended.store.getUser(ORG, "alice@acme.com"))?.sessionVersion, 3, "suspended user row untouched");

  const fresh = setup({ admission: "domain_auto_join", autoJoinDomains: ["acme.com"] });
  const freshResult = await fresh.service.login(loginInput({ principalId: "new@acme.com", email: "new@acme.com", subject: "sub-new" }));
  assert.equal(freshResult.status, "ok");
  if (freshResult.status !== "ok") return;
  assert.equal(freshResult.user.sessionVersion, 1, "genuinely new email still auto-joins");
});

test("setStatus: bumps sessionVersion, drives identity deactivation, and is idempotent", async () => {
  const { service, identity, auditLog } = setup();
  await service.invite({ principalId: "alice@acme.com", email: "alice@acme.com", displayName: "Alice", actor: "admin@acme.com" });
  const suspended = await service.setStatus({ principalId: "alice@acme.com", status: "suspended", actor: "admin@acme.com" });
  assert.equal(suspended?.sessionVersion, 2);
  assert.equal(suspended?.updatedBy, "admin@acme.com");
  assert.equal(identity.classify("alice@acme.com").type, "guest");
  const active = await service.setStatus({ principalId: "alice@acme.com", status: "active", actor: "admin@acme.com" });
  assert.equal(active?.sessionVersion, 3);
  assert.equal(identity.classify("alice@acme.com").type, "internal");
  const eventsBefore = (await auditLog.events()).length;
  const unchanged = await service.setStatus({ principalId: "alice@acme.com", status: "active", actor: "admin@acme.com" });
  assert.equal(unchanged?.sessionVersion, 3, "same status is a no-op");
  assert.equal((await auditLog.events()).length, eventsBefore, "no audit event for a no-op");
  assert.equal(await service.setStatus({ principalId: "nobody@acme.com", status: "suspended", actor: "admin@acme.com" }), null);
});

test("checkActive: reflects local writes immediately and converges across instances after refresh", async () => {
  const { service, store, advance } = setup();
  assert.equal(await service.checkActive("alice@acme.com"), null);
  await service.invite({ principalId: "alice@acme.com", email: "alice@acme.com", displayName: "Alice", actor: "admin@acme.com" });
  await service.login(loginInput());
  assert.deepEqual(await service.checkActive("alice@acme.com"), { status: "active", sessionVersion: 2 });
  await service.setStatus({ principalId: "alice@acme.com", status: "suspended", actor: "admin@acme.com" });
  assert.deepEqual(await service.checkActive("alice@acme.com"), { status: "suspended", sessionVersion: 3 });
  const other = setup({ store });
  await other.service.setStatus({ principalId: "alice@acme.com", status: "active", actor: "admin@acme.com" });
  advance(10_000);
  await service.refresh();
  assert.deepEqual(await service.checkActive("alice@acme.com"), { status: "active", sessionVersion: 4 });
});

test("audit: login, denial, activation, auto-join, and status changes are recorded", async () => {
  const { service, auditLog } = setup();
  await service.invite({ principalId: "alice@acme.com", email: "alice@acme.com", displayName: "Alice", actor: "admin@acme.com" });
  await service.login(loginInput());
  await service.login(loginInput());
  await service.setStatus({ principalId: "alice@acme.com", status: "suspended", actor: "admin@acme.com" });
  await service.login(loginInput());
  await service.login(loginInput({ principalId: "stranger@acme.com", email: "stranger@acme.com", subject: "sub-2" }));
  const events = await auditLog.events();
  assert.ok(events.every((e) => e.scopeLabel === SCOPE));
  const actions = events.map((e) => `${e.action}:${e.status ?? ""}`);
  assert.deepEqual(actions, [
    "org.user.invite:",
    "org.user.activate:",
    "org.user.login:",
    "org.user.status:suspended",
    "org.user.login_denied:suspended",
    "org.user.login_denied:not_invited",
  ]);
  const deniedStranger = events.find((e) => e.principalId === "stranger@acme.com");
  assert.equal(deniedStranger?.resource, "stranger@acme.com");
  const reinvite = await service.invite({ principalId: "alice@acme.com", email: "alice@acme.com", displayName: "Alice", actor: "admin@acme.com" });
  assert.equal(reinvite.status, "suspended", "re-invite returns the stored row unchanged");
  assert.equal((await auditLog.events()).length, events.length, "re-invite no-op records no event");

  const autoJoin = setup({ admission: "domain_auto_join", autoJoinDomains: ["acme.com"] });
  await autoJoin.service.login(loginInput({ principalId: "carol@acme.com", email: "carol@acme.com", subject: "sub-3" }));
  const autoJoinEvents = await autoJoin.auditLog.events();
  assert.deepEqual(
    autoJoinEvents.map((e) => e.action),
    ["org.user.auto_join"],
  );
  assert.equal(autoJoinEvents[0]?.scopeLabel, SCOPE);
});
