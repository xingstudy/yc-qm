import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Config } from "../src/config.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp, serverDeps, activateBootstrapUsers } from "../src/wiring.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { testConfig } from "./support/test-config.ts";
import { validateAdminStatusTargets } from "../src/organization/admin-liveness.ts";
import { adminStatusFromGrants } from "../src/admin/admin-service.ts";

const email = "external@partner.test";
const actor = "admin-alice@default-org";
const expiresAt = () => Date.now() + 86400_000;

async function setup(overrides: Partial<Config> = {}) {
  const config = testConfig({ ...overrides });
  const built = buildApp(config);
  await built.migrationsReady;
  await activateBootstrapUsers(built.organization, ["admin-alice", "admin-bob"]);
  const sent: unknown[] = [];
  const deps = {
    ...serverDeps(config, built),
    publicWebUrl: "https://portal.example.test",
    inviteMailer: {
      send: async (message: unknown) => {
        sent.push(message);
        return "test";
      },
    },
  };
  const server = createInsecureTestServer(built.app, deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const invite = (role = "member") =>
    fetch(`${base}/v1/admin/external-users`, {
      method: "POST",
      headers: { "x-admin-actor": actor, "content-type": "application/json" },
      body: JSON.stringify({ email, role, expiresAt: expiresAt(), resendInvite: true }),
    });
  const login = () =>
    built.organization.login({
      principalId: email,
      email,
      emailVerified: true,
      issuer: "https://idp.test",
      subject: email,
      displayName: "External",
    });
  return {
    built,
    base,
    sent,
    invite,
    login,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("external invite cannot take over an organization email or reactivate a manually disabled member", async () => {
  const h = await setup();
  try {
    await h.built.organization.invite({
      principalId: "canonical",
      email,
      displayName: "Existing",
      actor: "admin-alice",
    });
    assert.equal((await h.invite("org_admin")).status, 409);
    assert.equal(await h.built.identity.readExternalMember(email), null);
    assert.equal(adminStatusFromGrants(await h.built.admin.listGrants(), email).isAdmin, false);
    assert.equal(h.sent.length, 0);
  } finally {
    await h.close();
  }
  const h2 = await setup();
  try {
    assert.equal((await h2.invite()).status, 200);
    assert.equal((await h2.login()).status, "ok");
    await h2.built.organization.setStatus({ principalId: email, status: "suspended", actor: "admin-alice" });
    const member = await h2.built.identity.readExternalMember(email);
    const sent = h2.sent.length;
    assert.equal((await h2.invite("org_admin")).status, 409);
    assert.deepEqual(await h2.built.identity.readExternalMember(email), member);
    assert.equal(h2.sent.length, sent);
    assert.equal(adminStatusFromGrants(await h2.built.admin.listGrants(), email).isAdmin, false);
  } finally {
    await h2.close();
  }
});

test("external membership persistence failures compensate administrator grant creation and demotion", async (t) => {
  const h = await setup();
  try {
    const failing = t.mock.method(h.built.identity, "putExternalMember", async () => {
      throw new Error("injected external persistence failure");
    });
    assert.equal((await h.invite("org_admin")).status, 500);
    assert.equal(adminStatusFromGrants(await h.built.admin.listGrants(), email).isAdmin, false);
    assert.equal(h.sent.length, 0);
    assert.equal((await h.built.organization.checkActive(email))?.status, "suspended");
    failing.mock.restore();
    assert.equal((await h.invite("org_admin")).status, 200);
    assert.equal((await h.login()).status, "ok");
    const member = await h.built.identity.readExternalMember(email);
    const sent = h.sent.length;
    t.mock.method(h.built.identity, "putExternalMember", async () => {
      throw new Error("injected external persistence failure");
    });
    assert.equal((await h.invite("member")).status, 500);
    assert.equal(adminStatusFromGrants(await h.built.admin.listGrants(), email).isAdmin, true);
    assert.deepEqual(await h.built.identity.readExternalMember(email), member);
    assert.equal(h.sent.length, sent);
  } finally {
    await h.close();
  }
});

test("concurrent external role edits keep the persisted member and administrator grant consistent", async () => {
  const h = await setup();
  try {
    const results = await Promise.all([h.invite("org_admin"), h.invite("member")]);
    assert.deepEqual(
      results.map((result) => result.status),
      [200, 200],
    );
    const member = await h.built.identity.readExternalMember(email);
    assert.equal(adminStatusFromGrants(await h.built.admin.listGrants(), email).isAdmin, member?.role === "org_admin");
  } finally {
    await h.close();
  }
});

test("a failed compensation cannot make a member's orphan administrator grant effective", async (t) => {
  const h = await setup();
  try {
    assert.equal((await h.invite()).status, 200);
    assert.equal((await h.login()).status, "ok");
    t.mock.method(h.built.identity, "putExternalMember", async () => {
      throw new Error("membership unavailable");
    });
    t.mock.method(h.built.admin, "revokeGrant", async () => {
      throw new Error("compensation unavailable");
    });
    assert.equal((await h.invite("org_admin")).status, 500);
    assert.equal(adminStatusFromGrants(await h.built.admin.listGrants(), email).isAdmin, true);
    assert.equal((await h.built.identity.readExternalMember(email))?.role, "member");
    assert.equal((await h.built.admin.adminStatusOf({ id: email, type: "internal" })).isAdmin, false);
    assert.deepEqual(
      await validateAdminStatusTargets(
        { orgId: "default-org", organization: h.built.organization, admin: h.built.admin },
        [
          { principalId: "admin-alice", status: "suspended" },
          { principalId: "admin-bob", status: "suspended" },
        ],
      ),
      { ok: false, reason: "last_active_admin" },
    );
    for (const path of ["/v1/admin/users", "/v1/admin/org/units"]) {
      const response = await fetch(`${h.base}${path}`, { headers: { "x-admin-actor": `${email}@default-org` } });
      assert.equal(response.status, 403, `${path}: ${await response.text()}`);
    }
  } finally {
    await h.close();
  }
});

test(
  "Postgres replicas serialize external role changes after completing every registered migration",
  { skip: !process.env.DATABASE_URL, timeout: 90_000 },
  async (t) => {
    const pg = (await import("pg")).default;
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const schema = `external_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const marker = createPgPool(url.toString(), [
      {
        id: "zz-test/registration-before-initialization",
        statements: [
          "CREATE TABLE boot_migration_marker(value int)",
          "DO $$ BEGIN IF EXISTS (SELECT 1 FROM org_units) THEN RAISE EXCEPTION 'organization initialization preceded global migrations'; END IF; END $$",
        ],
      },
    ]);
    const instances: Awaited<ReturnType<typeof setup>>[] = [];
    try {
      const config: Partial<Config> = {
        databaseUrl: url.toString(),
        sessionStore: "postgres",
        runStore: "postgres",
        seedSkills: false,
        adminGrants: "admin-alice:org_admin,admin-bob:org_admin",
      };
      const first = await setup(config);
      instances.push(first);
      const second = await setup(config);
      instances.push(second);
      let entered!: () => void;
      let resume!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const put = first.built.identity.putExternalMember.bind(first.built.identity);
      t.mock.method(first.built.identity, "putExternalMember", async (member: Parameters<typeof put>[0]) => {
        entered();
        await gate;
        return put(member);
      });
      const promoting = first.invite("org_admin");
      await Promise.race([
        started,
        promoting.then(async (response) => {
          throw new Error(`promotion did not reach persistence: ${response.status}`);
        }),
      ]);
      const demoting = second.invite("member");
      resume();
      const results = await Promise.all([promoting, demoting]);
      for (const result of results) assert.equal(result.status, 200, await result.text());
      assert.equal((await first.built.identity.readExternalMember(email))?.role, "member");
      assert.equal(adminStatusFromGrants(await first.built.admin.listGrants(), email).isAdmin, false);
      assert.equal((await first.login()).status, "ok");
      assert.equal((await second.built.admin.adminStatusOf({ id: email, type: "internal" })).isAdmin, false);
    } finally {
      for (const instance of instances) {
        await instance.close();
        await instance.built.runtime.stop();
      }
      await marker.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test("readmission synchronization failures compensate a role grant and preserve failure audits", async (t) => {
  const h = await setup();
  try {
    assert.equal((await h.invite()).status, 200);
    const member = (await h.built.identity.readExternalMember(email))!;
    await h.built.identity.putExternalMember({ ...member, expiresAt: Date.now() - 1000 });
    t.mock.method(h.built.organization, "syncExternalMember", async () => {
      throw new Error("sync failed");
    });
    assert.equal((await h.invite("org_admin")).status, 500);
    assert.equal(adminStatusFromGrants(await h.built.admin.listGrants(), email).isAdmin, false);
    const actions = (await h.built.auditLog.events()).map((event) => event.action);
    assert.ok(actions.includes("external_user.update_failed"));
    assert.deepEqual(
      actions.filter((action) => action.startsWith("grant.")),
      ["grant.create", "grant.revoke"],
    );
  } finally {
    await h.close();
  }
});

test("failed revoke persistence restores the grant and committed revoke audit survives a later sync failure", async (t) => {
  const h = await setup();
  const revoke = () =>
    fetch(`${h.base}/v1/admin/external-users/${encodeURIComponent(email)}`, {
      method: "DELETE",
      headers: { "x-admin-actor": actor },
    });
  try {
    assert.equal((await h.invite("org_admin")).status, 200);
    assert.equal((await h.login()).status, "ok");
    const failingPut = t.mock.method(h.built.identity, "putExternalMember", async () => {
      throw new Error("put failed");
    });
    assert.equal((await revoke()).status, 500);
    assert.equal((await h.built.admin.adminStatusOf({ id: email, type: "internal" })).isAdmin, true);
    assert.ok((await h.built.auditLog.events()).some((event) => event.action === "external_user.revoke_failed"));
    failingPut.mock.restore();
    const failingSync = t.mock.method(h.built.organization, "syncExternalMember", async () => {
      throw new Error("sync failed");
    });
    assert.equal((await revoke()).status, 500);
    assert.ok((await h.built.auditLog.events()).some((event) => event.action === "external_user.revoke"));
    assert.equal(adminStatusFromGrants(await h.built.admin.listGrants(), email).isAdmin, false);
    failingSync.mock.restore();
    assert.equal((await revoke()).status, 200);
    assert.equal(
      (await h.built.auditLog.events()).filter((event) => event.action === "external_user.revoke").length,
      1,
    );
  } finally {
    await h.close();
  }
});

test("external administrators cannot remove the authority needed to compensate their own role changes", async () => {
  const h = await setup();
  try {
    assert.equal((await h.invite("org_admin")).status, 200);
    assert.equal((await h.login()).status, "ok");
    for (const method of ["POST", "DELETE"]) {
      const response = await fetch(
        `${h.base}/v1/admin/external-users${method === "DELETE" ? `/${encodeURIComponent(email)}` : ""}`,
        {
          method,
          headers: { "x-admin-actor": `${email}@default-org`, "content-type": "application/json" },
          ...(method === "POST" ? { body: JSON.stringify({ email, role: "member", expiresAt: expiresAt() }) } : {}),
        },
      );
      assert.equal(response.status, 403, await response.text());
    }
    assert.equal((await h.built.identity.readExternalMember(email))?.role, "org_admin");
    assert.equal((await h.built.admin.adminStatusOf({ id: email, type: "internal" })).isAdmin, true);
  } finally {
    await h.close();
  }
});

test(
  "a synchronous build failure does not migrate a partially registered database",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const pg = (await import("pg")).default;
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const schema = `failed_boot_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const inspection = new pg.Pool({ connectionString: url.toString() });
    try {
      assert.throws(
        () =>
          buildApp(
            testConfig({
              databaseUrl: url.toString(),
              seedSkills: false,
              sandboxBackend: "invalid" as Config["sandboxBackend"],
            }),
          ),
        /not a function/,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(
        (await inspection.query("SELECT to_regclass('qm_schema_migrations') AS ledger")).rows[0].ledger,
        null,
      );
      assert.equal(
        (
          await inspection.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1", [
            schema,
          ])
        ).rows[0].n,
        0,
      );
    } finally {
      await inspection.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test("an external member profile alias cannot create another invitation or orphan administrator grant", async () => {
  const h = await setup();
  const alias = "renamed@partner.test";
  try {
    assert.equal((await h.invite()).status, 200);
    assert.equal((await h.login()).status, "ok");
    await h.built.organization.updateUserProfile({
      principalId: email,
      patch: { email: alias },
      expectedProfileRevision: 1,
      actor: "admin-alice",
    });
    const sent = h.sent.length;
    const response = await fetch(`${h.base}/v1/admin/external-users`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-actor": actor },
      body: JSON.stringify({ email: alias, role: "org_admin", expiresAt: expiresAt() }),
    });
    assert.equal(response.status, 409);
    assert.equal(await h.built.identity.readExternalMember(alias), null);
    assert.equal(adminStatusFromGrants(await h.built.admin.listGrants(), alias).isAdmin, false);
    assert.equal(h.sent.length, sent);
    await assert.rejects(h.built.organization.reserveExternalMember(alias, alias, "admin-alice"), /already belongs/);
    await assert.rejects(
      h.built.organization.invite({ principalId: alias, email: alias, displayName: alias, actor: "admin-alice" }),
      /already belongs/,
    );
    assert.equal(await h.built.organization.emailLoginAllowed(email), true);
  } finally {
    await h.close();
  }
});
