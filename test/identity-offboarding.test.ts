import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";
import { scopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "offboarding-secret".repeat(3);

const member = (principalId: string) => ({ principalId, displayName: principalId, type: "internal" as const });

describe("offboarding: directory sync and the /v1/principals routes drive deactivation (§3)", () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;
  let nextTimestamp = Math.floor(Date.now() / 1000);

  const signedPost = (path: string) => {
    const ts = nextTimestamp++;
    return fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-timestamp": String(ts),
        "x-signature": signRequest(SECRET, ts, `POST\n${path}\n`),
      },
    });
  };

  before(async () => {
    built = buildApp(
      testConfig({
        dataDir: mkdtempSync(join(tmpdir(), "offboarding-")),
        signingSecret: SECRET,
      }),
    );
    await built.identity.hydrate();
    await built.organization.provisionPlayground("U-manual");
    await built.organization.provisionPlayground("admin-alice");
    await built.organization.provisionPlayground("admin-bob");
    server = createServer(built.app, {
      signingSecret: SECRET,
      identity: built.identity,
      organization: built.organization,
      admin: built.admin,
      advisoryLock: built.advisoryLock,
      auditLog: built.auditLog,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("a roster swap that drops a member deactivates them; reappearing reactivates", async () => {
    await built.app.upsertDirectory([member("U-stay"), member("U-leave")]);
    assert.equal(built.identity.classify("U-leave").type, "internal");

    await built.app.upsertDirectory([member("U-stay")]);
    assert.equal(built.identity.classify("U-leave").type, "guest");
    assert.equal(built.identity.classify("U-stay").type, "internal");
    assert.ok(
      (await built.auditLog.events()).some((e) => e.action === "principal.deactivate" && e.principalId === "U-leave"),
    );

    await built.app.upsertDirectory([member("U-stay"), member("U-leave")]);
    assert.equal(built.identity.classify("U-leave").type, "internal");
    assert.ok(
      (await built.auditLog.events()).some((e) => e.action === "principal.reactivate" && e.principalId === "U-leave"),
    );
  });

  it("the deactivate/reactivate routes flip classification and are audited", async () => {
    const initial = await built.organization.checkActive("U-manual");
    assert.equal(initial?.status, "active");
    const off = await signedPost("/v1/principals/U-manual/deactivate");
    assert.equal(off.status, 200);
    assert.deepEqual(await off.json(), { ok: true, principalId: "U-manual", active: false });
    assert.equal(built.identity.classify("U-manual").type, "guest");
    const suspended = await built.organization.checkActive("U-manual");
    assert.equal(suspended?.status, "suspended");
    assert.ok(suspended && initial && suspended.sessionVersion > initial.sessionVersion);
    assert.equal((await signedPost("/v1/principals/U-manual/deactivate")).status, 200);

    await built.app.upsertDirectory([member("U-manual")]);
    assert.equal(built.identity.classify("U-manual").type, "guest");

    const on = await signedPost("/v1/principals/U-manual/reactivate");
    assert.equal(on.status, 200);
    assert.deepEqual(await on.json(), { ok: true, principalId: "U-manual", active: true });
    assert.equal(built.identity.classify("U-manual").type, "internal");
    const active = await built.organization.checkActive("U-manual");
    assert.equal(active?.status, "active");
    assert.ok(active && suspended && active.sessionVersion > suspended.sessionVersion);
    assert.ok(
      (await built.auditLog.events()).some(
        (e) => e.action === "org.user.status" && e.resource === "U-manual" && e.status === "active",
      ),
    );
  });

  it("an agent capability token cannot reach the principals routes (source-auth only)", async () => {
    const cap = await mintCapabilityToken(
      { actorId: "U-stay", scopeId: scopeId("personal", "U-stay"), exp: Date.now() + CAPABILITY_TTL_MS },
      SECRET,
    );
    const res = await fetch(`${base}/v1/principals/U-stay/deactivate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": cap },
    });
    assert.equal(res.status, 401);
  });

  it("the principals route cannot suspend the last active organization administrator", async () => {
    assert.equal((await signedPost("/v1/principals/admin-bob/deactivate")).status, 200);
    const blocked = await signedPost("/v1/principals/admin-alice/deactivate");
    assert.equal(blocked.status, 409);
    assert.deepEqual(await blocked.json(), { error: "last_active_admin" });
    assert.equal((await built.organization.getUser("admin-alice"))?.status, "active");
  });
});
