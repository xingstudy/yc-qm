import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPostgresOrganizationStore } from "../src/organization/postgres-organization-store.ts";
import type { AuthIdentity, OrganizationUser } from "../src/organization/organization-store.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres organization-store tests";

beforeEach(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS auth_identities CASCADE");
  await p.query("DROP TABLE IF EXISTS organization_users CASCADE");
  await p.end();
});

const user = (over: Partial<OrganizationUser> = {}): OrganizationUser => ({
  orgId: "org1",
  principalId: "U1",
  email: "alice@example.com",
  displayName: "Alice",
  status: "active",
  sessionVersion: 1,
  createdAt: 100,
  updatedAt: 100,
  lastLoginAt: null,
  createdBy: "admin",
  updatedBy: "admin",
  ...over,
});

const identity = (over: Partial<AuthIdentity> = {}): AuthIdentity => ({
  orgId: "org1",
  issuer: "https://idp.example.com",
  subject: "sub-1",
  principalId: "U1",
  emailAtLink: "alice@example.com",
  createdAt: 100,
  updatedAt: 100,
  ...over,
});

test("pg organization store: putUser upserts on (org, principal); getUser and listUsers round-trip", { skip }, async () => {
  const store = createPostgresOrganizationStore(URL!);
  assert.equal(await store.getUser("org1", "U1"), null);

  await store.putUser(user());
  await store.putUser(user());
  assert.deepEqual(await store.getUser("org1", "U1"), user());
  assert.equal((await store.listUsers("org1")).length, 1, "put dedups on (org, principal)");

  await store.putUser(user({ displayName: "Alice Cooper", updatedAt: 200, lastLoginAt: 150 }));
  const got = await store.getUser("org1", "U1");
  assert.equal(got!.displayName, "Alice Cooper");
  assert.equal(got!.lastLoginAt, 150);
  assert.equal((await store.listUsers("org1")).length, 1, "second put is an upsert, not an insert");

  await store.putUser(user({ orgId: "org2" }));
  assert.equal((await store.listUsers("org1")).length, 1);
  assert.equal((await store.listUsers("org2")).length, 1, "listUsers is org-scoped");
  assert.equal(await store.getUser("org1", "missing"), null);
});

test("pg organization store: findUserByEmail is case-insensitive and org-scoped", { skip }, async () => {
  const store = createPostgresOrganizationStore(URL!);
  await store.putUser(user({ email: "Alice@Example.com" }));
  assert.equal((await store.findUserByEmail("org1", "alice@example.COM"))!.principalId, "U1");
  assert.equal(await store.findUserByEmail("org2", "alice@example.com"), null);
  assert.equal(await store.findUserByEmail("org1", "nobody@example.com"), null);
});

test("pg organization store: duplicate email rejected within an org, allowed across orgs; null emails exempt", { skip }, async () => {
  const store = createPostgresOrganizationStore(URL!);
  await store.putUser(user({ email: "alice@example.com" }));
  await assert.rejects(
    () => store.putUser(user({ principalId: "U2", email: "ALICE@example.com" })),
    (e: unknown) => (e as { code?: string }).code === "23505",
    "unique index rejects a case-variant duplicate email in the same org",
  );

  await store.putUser(user({ principalId: "U2", orgId: "org2", email: "alice@example.com" }));
  await store.putUser(user({ principalId: "U3", email: null }));
  await store.putUser(user({ principalId: "U4", email: null }));
  assert.equal((await store.listUsers("org1")).length, 3, "other orgs and null emails coexist");
});

test("pg organization store: identities round-trip keyed by (org, issuer, subject)", { skip }, async () => {
  const store = createPostgresOrganizationStore(URL!);
  await store.putUser(user());
  assert.equal(await store.getIdentity("org1", "https://idp.example.com", "sub-1"), null);

  await store.putIdentity(identity());
  assert.deepEqual(await store.getIdentity("org1", "https://idp.example.com", "sub-1"), identity());

  await store.putIdentity(identity({ emailAtLink: "new@example.com", updatedAt: 200 }));
  const got = await store.getIdentity("org1", "https://idp.example.com", "sub-1");
  assert.equal(got!.emailAtLink, "new@example.com", "putIdentity upserts on (org, issuer, subject)");

  await store.putIdentity(identity({ subject: "sub-2" }));
  assert.equal((await store.getIdentity("org1", "https://idp.example.com", "sub-2"))!.subject, "sub-2");
  assert.equal(await store.getIdentity("org1", "https://idp.example.com", "missing"), null);
  assert.equal(await store.getIdentity("org2", "https://idp.example.com", "sub-1"), null);
});

test("pg organization store: rows survive a second store instance", { skip }, async () => {
  const boot1 = createPostgresOrganizationStore(URL!);
  await boot1.putUser(user({ principalId: "U-durable" }));
  await boot1.putIdentity(identity({ principalId: "U-durable", subject: "sub-durable" }));

  const boot2 = createPostgresOrganizationStore(URL!);
  assert.equal((await boot2.getUser("org1", "U-durable"))!.principalId, "U-durable");
  assert.equal(
    (await boot2.getIdentity("org1", "https://idp.example.com", "sub-durable"))!.principalId,
    "U-durable",
  );
});
