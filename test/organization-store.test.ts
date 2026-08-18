import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryOrganizationStore, type OrganizationUser } from "../src/organization/organization-store.ts";

const user = (over: Partial<OrganizationUser> = {}): OrganizationUser => ({
  orgId: "default-org",
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

test("memory organization store: put/get/findByEmail/list round-trip", async () => {
  const s = createMemoryOrganizationStore();
  assert.equal(await s.getUser("default-org", "alice@acme.com"), null);
  await s.putUser(user());
  assert.equal((await s.getUser("default-org", "alice@acme.com"))?.status, "active");
  assert.equal((await s.findUserByEmail("default-org", "Alice@ACME.com"))?.principalId, "alice@acme.com");
  await s.putUser(user({ principalId: "bob@acme.com", email: "bob@acme.com", status: "invited" }));
  assert.equal((await s.listUsers("default-org")).length, 2);
  assert.equal((await s.listUsers("other-org")).length, 0, "org isolation");
  await s.putUser(user({ status: "suspended", sessionVersion: 2 }));
  assert.equal((await s.getUser("default-org", "alice@acme.com"))?.sessionVersion, 2, "upsert replaces");
});

test("memory organization store: identities are keyed by issuer+subject", async () => {
  const s = createMemoryOrganizationStore();
  assert.equal(await s.getIdentity("default-org", "https://idp", "sub-1"), null);
  await s.putIdentity({ orgId: "default-org", issuer: "https://idp", subject: "sub-1", principalId: "alice@acme.com", emailAtLink: "alice@acme.com", createdAt: 1, updatedAt: 1 });
  assert.equal((await s.getIdentity("default-org", "https://idp", "sub-1"))?.principalId, "alice@acme.com");
  assert.equal(await s.getIdentity("default-org", "https://other", "sub-1"), null);
});
