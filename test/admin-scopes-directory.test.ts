import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

function start() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-scopes-")) }));
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    sessions: built.sessions,
    config: built.config,
    environments: built.environments,
    organization: built.organization,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const ALICE_ADMIN = { "x-admin-actor": "admin-alice@default-org" };
const json = async (r: Response): Promise<any> => r.json();

test("the admin scope directory lists every known scope with labels and counts (powers the picker)", async () => {
  const s = start();
  try {
    const session = await s.built.sessions.getOrCreateByThread("T1", "channel", "channel:C9", "eng");
    await s.built.sessions.addParticipant(session.id, "U1");
    const { lease } = await s.built.sessions.acquireLease(session.id);
    await s.built.sessions.append(lease!, {
      type: "user",
      payload: { text: "ship the board deck" },
      scopeLabel: "channel:C9",
    });
    await s.built.sessions.releaseLease(lease!);
    await s.built.app.createCron({
      ownerScopeId: "channel:GONE",
      owner: "U1",
      createdBy: "U1",
      schedule: { everyMs: 60_000 },
      action: "ping",
    });

    const r = await fetch(`${s.base}/v1/admin/scopes`, { headers: ALICE_ADMIN });
    assert.equal(r.status, 200);
    const d = await json(r);
    const byId = new Map(d.scopes.map((row: any) => [row.scopeId, row]));

    assert.ok(byId.has("org:default-org"), "the org scope is always listed");
    assert.ok(byId.has("channel:C9"), "session scopes are listed");
    assert.ok(byId.has("personal:U1"), "every participant gets a personal-scope row");
    assert.ok(byId.has("personal:admin-alice"), "grant holders are listed even if they never spoke");
    assert.ok(byId.has("channel:GONE"), "artifact owners are listed even with no session");

    const c9: any = byId.get("channel:C9");
    assert.equal(c9.label, "#eng", "channel rows carry the human channel name");
    assert.equal(c9.sessions, 1);
    assert.equal(c9.lastMessage, "ship the board deck", "rows carry the newest conversation's last-message preview");
    const gone: any = byId.get("channel:GONE");
    assert.equal(gone.crons, 1, "rows carry artifact counts");
    assert.equal(gone.sessions, 0);
    assert.equal(d.scopes[0].scopeId, "channel:C9", "most-active scopes sort first");

    assert.equal(
      (await fetch(`${s.base}/v1/admin/scopes`, { headers: { "x-admin-actor": "nobody@default-org" } })).status,
      403,
      "org_admin-only",
    );
    assert.ok(
      (await s.built.auditLog.events()).some((e) => e.action === "scopes.read"),
      "the directory read is audited",
    );
  } finally {
    await s.close();
  }
});

test("governance directory includes active organization levels and access groups with independently saved rules", async () => {
  const s = start();
  try {
    await s.built.organizationStore.ensureOrgRoot({ orgId: "default-org", name: "Test", actor: "admin-alice", now: 1 });
    const department = await s.built.organization.createUnit({
      parentId: "root",
      name: "Engineering",
      kind: "department",
      actor: "admin-alice",
    });
    const team = await s.built.organization.createUnit({
      parentId: department.id,
      name: "Platform",
      kind: "team",
      actor: "admin-alice",
    });
    const group = await s.built.organization.createGroup({ name: "Release", actor: "admin-alice" });
    const archived = await s.built.organization.createGroup({ name: "Old", actor: "admin-alice" });
    await s.built.organizationStore.putGroup({ ...archived, status: "archived" });
    const directory = await json(await fetch(`${s.base}/v1/admin/scopes`, { headers: ALICE_ADMIN }));
    const byId = new Map(directory.scopes.map((row: any) => [row.scopeId, row]));
    assert.equal((byId.get(`org-unit:${team.id}`) as any).parentScopeId, `org-unit:${department.id}`);
    assert.equal((byId.get(`access-group:${group.id}`) as any).label, "Release");
    assert.ok(!byId.has(`access-group:${archived.id}`));
    const headers = { ...ALICE_ADMIN, "content-type": "application/json" };
    const put = async (scope: string, resource: string, body: unknown, requestHeaders = headers) =>
      fetch(`${s.base}/v1/admin/scopes/${encodeURIComponent(scope)}/${resource}`, {
        method: "PUT",
        headers: requestHeaders,
        body: JSON.stringify(body),
      });
    assert.equal((await put(`org-unit:${department.id}`, "security-posture", { posture: "strict" })).status, 200);
    const child = await json(await fetch(`${s.base}/v1/admin/scopes/org-unit:${team.id}`, { headers: ALICE_ADMIN }));
    assert.equal(child.securityPosture, "strict");
    assert.ok(child.governanceScopes.includes(`org-unit:${department.id}`));
    const org = await json(await fetch(`${s.base}/v1/admin/scopes/org:default-org`, { headers: ALICE_ADMIN }));
    assert.equal(org.securityPosture, "auto");
    assert.equal(
      (
        await put(`access-group:${group.id}`, "command-policy", {
          mode: "denylist",
          rules: [{ pattern: "deploy", decision: "deny" }],
        })
      ).status,
      200,
    );
    const simulate = await json(
      await put(`access-group:${group.id}`, "command-policy-simulate", { command: "deploy production" }),
    );
    assert.equal(simulate.decision, "deny");
    assert.equal(simulate.ruleScopeId, `access-group:${group.id}`);
    assert.equal((await put(`access-group:${group.id}`, "security-posture", { posture: "invalid" })).status, 400);
    assert.equal(
      (
        await put(
          `access-group:${group.id}`,
          "security-posture",
          { posture: "strict" },
          { ...headers, "x-admin-actor": "nobody@default-org" },
        )
      ).status,
      403,
    );
    for (const id of [`access-group:${archived.id}`, "org-unit:missing"]) {
      assert.equal((await put(id, "security-posture", { posture: "strict" })).status, 404);
      assert.equal((await fetch(`${s.base}/v1/admin/scopes/${id}`, { headers: ALICE_ADMIN })).status, 404);
    }
  } finally {
    await s.close();
  }
});

test("scopes without a session label fall back to the org directory (people's names, channel names)", async () => {
  const s = start();
  try {
    await s.built.app.upsertDirectory([{ principalId: "U1", displayName: "Uma Ada", type: "internal" }]);
    await s.built.app.upsertChannels([
      { channelId: "C7", name: "random" },
      { channelId: "C8", name: "quiet" },
    ]);
    const session = await s.built.sessions.getOrCreateByThread("T7", "channel", "channel:C7");
    await s.built.sessions.addParticipant(session.id, "U1");
    await s.built.app.createCron({
      ownerScopeId: "channel:C8",
      owner: "U1",
      createdBy: "U1",
      schedule: { everyMs: 60_000 },
      action: "ping",
    });

    const d = await json(await fetch(`${s.base}/v1/admin/scopes`, { headers: ALICE_ADMIN }));
    const byId = new Map(d.scopes.map((row: any) => [row.scopeId, row]));
    assert.equal(
      (byId.get("channel:C7") as any).label,
      "#random",
      "channel labels fall back to the directory channel name",
    );
    assert.equal(
      (byId.get("personal:U1") as any).label,
      "Uma Ada",
      "personal scopes are labelled with the person's display name",
    );
    assert.equal(
      (byId.get("channel:C8") as any).label,
      "#quiet",
      "artifact-only owner scopes get the directory fallback too",
    );
  } finally {
    await s.close();
  }
});

test("the admin scope directory exposes named environments and attached scopes", async () => {
  const s = start();
  try {
    await s.built.app.upsertChannels([
      { channelId: "A", name: "source" },
      { channelId: "B", name: "attached" },
    ]);
    await s.built.app.createEnvironment({ scopeId: "channel:A", name: "A-permanent", actorId: "U1" });
    await s.built.app.attachScope({ scopeId: "channel:B", environmentId: "channel:A", actorId: "U1" });

    const directory = await json(await fetch(`${s.base}/v1/admin/scopes`, { headers: ALICE_ADMIN }));
    const byId = new Map(directory.scopes.map((row: any) => [row.scopeId, row]));
    assert.deepEqual(directory.environments, [
      { id: "channel:A", name: "A-permanent", ownerActorId: "U1", attachedScopes: ["channel:B"] },
    ]);
    assert.equal((byId.get("channel:A") as any).environmentName, "A-permanent");
    assert.deepEqual((byId.get("channel:B") as any).environmentAttachment, {
      environmentId: "channel:A",
      environmentName: "A-permanent",
    });

    const attached = await json(await fetch(`${s.base}/v1/admin/scopes/channel:B`, { headers: ALICE_ADMIN }));
    assert.deepEqual(attached.environmentAttachment, {
      environmentId: "channel:A",
      environmentName: "A-permanent",
    });
  } finally {
    await s.close();
  }
});

test("local Docker scope status distinguishes configured enforcement from inactive control plane", async () => {
  const built = buildApp(
    testConfig({ sandboxBackend: "local", localSandbox: { egressProxyUrl: "http://host.docker.internal:48080" } }),
  );
  for (const configured of [false, true]) {
    const server = createInsecureTestServer(built.app, {
      admin: built.admin,
      config: built.config,
      organization: built.organization,
      sandbox: built.sandbox,
      egressControlPlaneConfigured: configured,
    });
    server.listen(0);
    try {
      const response = await fetch(
        `http://localhost:${(server.address() as AddressInfo).port}/v1/admin/scopes/org:default-org`,
        { headers: ALICE_ADMIN },
      );
      assert.equal(response.status, 200);
      const body = await json(response);
      assert.equal(body.egressEnforcement.backend, "local-docker");
      assert.equal(body.egressEnforcement.declaredFidelity, "domain");
      assert.equal(body.egressEnforcement.active, configured);
      assert.equal(body.egressEnforcement.reason, configured ? "ready" : "control_plane_unconfigured");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
