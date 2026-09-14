import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import type { ExternalMember } from "../src/identity/external-members.ts";
import { createMemoryOrganizationStore } from "../src/organization/organization-store.ts";
import { createOrganizationService } from "../src/organization/organization-service.ts";
import { currentPortalActor } from "../src/api/portal-actor.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../src/auth/portal-identity.ts";
import type { ServerDeps } from "../src/api/deps.ts";

const email = "guest@partner.test";
const principalId = "person-guest";
const secret = "test-external-membership-portal-secret";

function setup() {
  const auditLog = createAuditLog();
  const store = createMemoryOrganizationStore({ auditLog });
  const externalMembers = createMemoryMap<ExternalMember>();
  let now = Date.now();
  const identity = createIdentityService(undefined, { externalMembers });
  const secondIdentity = createIdentityService(undefined, { externalMembers });
  const build = (id: typeof identity) =>
    createOrganizationService({
      store,
      auditLog,
      identity: id,
      orgId: "acme",
      admission: "invite_only",
      autoJoinDomains: [],
      now: () => now,
    });
  const organization = build(identity);
  const secondOrganization = build(secondIdentity);
  const member = (): ExternalMember => ({
    email,
    role: "member",
    invitedBy: "admin",
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 60_000,
  });
  const login = () =>
    organization.login({
      principalId,
      issuer: "https://idp.test",
      subject: email,
      email,
      emailVerified: true,
      displayName: "Guest",
    });
  return {
    store,
    identity,
    secondIdentity,
    organization,
    secondOrganization,
    member,
    login,
    advance: () => {
      now += 60_001;
    },
  };
}

test("organization and external invitations both admit verified email under invite-only policy", async () => {
  const h = setup();
  await h.organization.invite({ principalId, email, displayName: "Guest", actor: "admin" });
  assert.equal(await h.organization.emailLoginAllowed(email), true);
  assert.equal((await h.login()).status, "ok");
  const external = setup();
  await external.identity.putExternalMember(external.member());
  const result = await external.login();
  assert.equal(result.status, "ok");
  assert.equal((await external.organization.getUser(principalId))?.status, "active");
});

test("expiry invalidates canonical Portal proofs and group membership across instances", async () => {
  const h = setup();
  await h.identity.putExternalMember(h.member());
  const result = await h.login();
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const group = await h.organization.createGroup({ name: "Shared", actor: "admin" });
  await h.organization.addGroupMember({ groupId: group.id, principalId, role: "member", actor: "admin" });
  const scope = `access-group:${group.id}` as const;
  assert.equal(await h.organization.accessSubjectIncludes(scope, principalId), true);
  await h.secondIdentity.refresh(true);
  const proof = await mintPortalIdentity(
    { p: principalId, sv: result.user.sessionVersion, exp: Date.now() + 60_000 },
    secret,
  );
  const req = { headers: { [PORTAL_IDENTITY_HEADER]: proof } } as unknown as IncomingMessage;
  const deps = {
    identity: h.secondIdentity,
    organization: h.secondOrganization,
    portalIdentitySecret: secret,
  } as ServerDeps;
  assert.ok(await currentPortalActor(req, deps, undefined));
  h.advance();
  assert.equal(await currentPortalActor(req, deps, undefined), null);
  assert.equal(await h.organization.accessSubjectIncludes(scope, principalId), false);
  const state = await h.organization.checkActive(principalId);
  assert.equal(state?.status, "suspended");
  assert.equal(state?.sessionVersion, result.user.sessionVersion + 1);
  assert.equal(await h.secondOrganization.emailLoginAllowed(email), false);
  assert.deepEqual(await h.login(), { status: "denied", reason: "external_inactive" });
});

test("revocation ignores a warm identity cache and readmission never restores an old session version", async () => {
  const h = setup();
  const invitation = h.member();
  await h.identity.putExternalMember(invitation);
  const result = await h.login();
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  await h.secondIdentity.refresh(true);
  await h.identity.putExternalMember({ ...invitation, expiresAt: invitation.createdAt - 1 });
  assert.equal((await h.secondOrganization.checkActive(principalId))?.status, "suspended");
  await h.identity.putExternalMember(h.member());
  await h.organization.syncExternalMember(email);
  assert.equal((await h.organization.checkActive(principalId))?.status, "invited");
  const admitted = await h.login();
  assert.equal(admitted.status, "ok");
  if (admitted.status === "ok") assert.ok(admitted.user.sessionVersion > result.user.sessionVersion);
  await h.organization.setStatus({ principalId, status: "suspended", actor: "admin" });
  await h.identity.putExternalMember(h.member());
  await h.organization.syncExternalMember(email);
  assert.equal((await h.organization.checkActive(principalId))?.status, "suspended");
});

test("revocation and forgetting during login cannot recreate an active principal", async (t) => {
  const h = setup();
  const member = h.member();
  await h.identity.putExternalMember(member);
  const read = h.identity.readExternalMember.bind(h.identity);
  let calls = 0;
  const reached = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  t.mock.method(h.identity, "readExternalMember", async (value: string) => {
    const result = await read(value);
    if (++calls === 2) {
      reached.resolve();
      await resume.promise;
    }
    return result;
  });
  const pending = h.login();
  await reached.promise;
  await h.secondIdentity.putExternalMember({ ...member, expiresAt: 0 });
  await h.secondOrganization.syncExternalMember(email);
  await h.secondIdentity.removeExternalMember(email);
  resume.resolve();
  assert.equal((await pending).status, "denied");
  assert.equal((await h.secondOrganization.checkActive(principalId))?.status, "suspended");
  const user = await h.organization.getUser(principalId);
  const proof = await mintPortalIdentity(
    { p: principalId, sv: user!.sessionVersion, exp: Date.now() + 60_000 },
    secret,
  );
  assert.equal(
    await currentPortalActor(
      { headers: { [PORTAL_IDENTITY_HEADER]: proof } } as unknown as IncomingMessage,
      { organization: h.organization, identity: h.identity, portalIdentitySecret: secret } as ServerDeps,
      undefined,
    ),
    null,
  );
});

test("a failed identity projection is retried after the organization transition has committed", async (t) => {
  const h = setup();
  await h.identity.putExternalMember(h.member());
  await h.login();
  const deactivate = h.secondIdentity.deactivate.bind(h.secondIdentity);
  let calls = 0;
  t.mock.method(h.secondIdentity, "deactivate", async (...args: Parameters<typeof deactivate>) => {
    if (++calls === 1) throw new Error("projection unavailable");
    await deactivate(...args);
  });
  h.advance();
  await assert.rejects(h.secondOrganization.checkActive(principalId), /projection unavailable/);
  assert.equal((await h.secondOrganization.checkActive(principalId))?.status, "suspended");
  assert.equal(calls, 2);
});

test("profile email edits cannot evade expiry or steal another principal's invited email", async () => {
  const h = setup();
  await h.identity.putExternalMember(h.member());
  await h.login();
  const update = await h.organization.updateUserProfile({
    principalId,
    patch: { email: "renamed@partner.test" },
    expectedProfileRevision: 1,
    actor: "admin",
  });
  assert.equal(update.ok, true);
  await h.organization.invite({
    principalId: "other",
    email: "other@partner.test",
    displayName: "Other",
    actor: "admin",
  });
  const conflict = await h.organization.updateUserProfile({
    principalId: "other",
    patch: { email },
    expectedProfileRevision: 1,
    actor: "admin",
  });
  assert.deepEqual(conflict, { ok: false, reason: "duplicate_email" });
  assert.equal((await h.store.findUserByEmail("acme", email))?.principalId, principalId);
  const beforeProbe = await h.organization.checkActive(principalId);
  assert.equal(await h.organization.emailLoginAllowed("renamed@partner.test"), false);
  assert.deepEqual(await h.organization.checkActive(principalId), beforeProbe);
  assert.equal(await h.organization.emailLoginAllowed(email), true);
  h.advance();
  assert.equal((await h.secondOrganization.checkActive(principalId))?.status, "suspended");
});

test("an administrator can take ownership of an expiry suspension before readmission", async () => {
  const h = setup();
  await h.identity.putExternalMember(h.member());
  await h.login();
  h.advance();
  await h.organization.syncExternalMember(email);
  await h.organization.setStatus({ principalId, status: "suspended", actor: "admin" });
  await h.identity.putExternalMember(h.member());
  await h.secondOrganization.syncExternalMember(email);
  const user = await h.organization.getUser(principalId);
  assert.equal(user?.status, "suspended");
  assert.equal(user?.updatedBy, "admin");
});

test("an external row never takes over an existing independent organization invitation", async () => {
  const h = setup();
  await h.organization.invite({ principalId, email, displayName: "Independent", actor: "admin" });
  await assert.rejects(h.organization.reserveExternalMember(email, "different", "admin"), /already belongs/);
  await h.identity.putExternalMember(h.member());
  assert.equal((await h.login()).status, "denied");
  h.advance();
  await h.organization.syncExternalMember(email);
  const user = await h.organization.getUser(principalId);
  assert.equal(user?.status, "invited");
  assert.equal(user?.externalMembership, undefined);
});
