import "./support/auto-fake-sprites.ts";

import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { resolveRuntimeChoiceDurable } from "../src/harness/harness-router.ts";
import { testConfig } from "./support/test-config.ts";

const ADMIN = { "x-admin-actor": "admin-alice@default-org", "content-type": "application/json" };
const ORG = "org:default-org";
const PERSONAL = "personal:recursive-alice";
const fallback = { harnessId: "pi" as const, modelId: "claude-opus-4-8" };

for (const persistence of ["memory", "postgres"] as const) {
  test(
    `governance API recursively resolves user runtimes and live membership across ${persistence} instances`,
    {
      skip: persistence === "postgres" && !process.env.DATABASE_URL ? "requires a dedicated DATABASE_URL" : false,
    },
    async () => {
      const config = testConfig({
        harness: "pi",
        adminGrants: "admin-alice:org_admin",
        seedSkills: false,
        anthropicApiKey: "test-anthropic-key",
        openaiApiKey: "test-openai-key",
        ...(persistence === "postgres"
          ? { databaseUrl: process.env.DATABASE_URL, sessionStore: "postgres", runStore: "postgres" }
          : {}),
      });
      const writer = buildApp(config);
      const reader = persistence === "postgres" ? buildApp(config) : writer;
      const servers = [writer, reader].map((built) => {
        const server = createInsecureTestServer(built.app, serverDeps(config, built));
        server.listen(0);
        return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
      });
      const request = async (base: string, path: string, method = "GET", body?: unknown, headers = ADMIN) => {
        const response = await fetch(base + path, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const data = (await response.json()) as any;
        assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(data)}`);
        return data;
      };
      const put = (scope: string, resource: string, body: unknown) =>
        request(servers[0]!.base, `/v1/admin/scopes/${encodeURIComponent(scope)}/${resource}`, "PUT", body);
      const verify = async (scope: string, expected: { harnessId: string; modelId: string }) => {
        const admin = await request(servers[1]!.base, `/v1/admin/scopes/${PERSONAL}`);
        assert.equal(admin.runtimeScope, scope);
        assert.equal(admin.baseModelDefault, expected.modelId);
        assert.equal(admin.harnessDefault, expected.harnessId);
        assert.ok(
          admin.modelsByHarness[expected.harnessId].some((model: { id: string }) => model.id === expected.modelId),
          "admin picker includes the effective inherited model",
        );
        const user = await request(
          servers[1]!.base,
          `/v1/runtime-config?principalId=recursive-alice&scopeId=${PERSONAL}`,
        );
        assert.deepEqual(user.effective, expected);
        assert.equal(user.scopeOverride !== null, scope === PERSONAL);
        assert.deepEqual(await resolveRuntimeChoiceDurable(reader.config, ORG, PERSONAL, fallback), expected);
        return { admin, user };
      };
      try {
        await writer.organizationStore.ensureOrgRoot({
          orgId: "default-org",
          name: "Test",
          actor: "admin-alice",
          now: 1,
        });
        await writer.organizationStore.putUser({
          orgId: "default-org",
          principalId: "recursive-alice",
          email: "recursive-alice@example.test",
          displayName: "Recursive Alice",
          jobTitle: null,
          mobile: null,
          employeeNumber: null,
          status: "active",
          sessionVersion: 1,
          profileRevision: 1,
          createdAt: 1,
          updatedAt: 1,
          lastLoginAt: null,
          createdBy: "admin-alice",
          updatedBy: "admin-alice",
        });
        const department = await writer.organization.createUnit({
          parentId: "root",
          name: "Recursive department",
          kind: "department",
          actor: "admin-alice",
        });
        const team = await writer.organization.createUnit({
          parentId: department.id,
          name: "Recursive team",
          kind: "team",
          actor: "admin-alice",
        });
        await writer.organization.addUnitMember({
          unitId: team.id,
          principalId: "recursive-alice",
          role: "member",
          actor: "admin-alice",
        });
        const groups = await Promise.all(
          ["First", "Second"].map((name) => writer.organization.createGroup({ name, actor: "admin-alice" })),
        );
        groups.sort((a, b) => a.id.localeCompare(b.id));
        for (const group of groups)
          await writer.organization.addGroupMember({
            groupId: group.id,
            principalId: "recursive-alice",
            role: "member",
            actor: "admin-alice",
          });
        await put(ORG, "approved-harnesses", { ids: ["pi", "codex"] });
        const layers = [
          { scope: ORG, runtime: fallback },
          { scope: `org-unit:${department.id}`, runtime: { harnessId: "pi", modelId: "claude-sonnet-4-6" } },
          { scope: `org-unit:${team.id}`, runtime: { harnessId: "pi", modelId: "claude-haiku-4-5" } },
          { scope: `access-group:${groups[0]!.id}`, runtime: { harnessId: "codex", modelId: "gpt-5.5" } },
          { scope: `access-group:${groups[1]!.id}`, runtime: { harnessId: "pi", modelId: "gpt-5.5" } },
          { scope: PERSONAL, runtime: fallback },
        ];
        for (const layer of layers) {
          await put(layer.scope, "runtime", layer.runtime);
          await verify(layer.scope, layer.runtime);
        }
        await put(PERSONAL, "runtime", { inherit: true });
        await verify(layers[4]!.scope, layers[4]!.runtime);
        await writer.organizationStore.removeGroupMember("default-org", groups[1]!.id, "recursive-alice");
        await verify(layers[3]!.scope, layers[3]!.runtime);
        await writer.organizationStore.putGroup({ ...groups[0]!, status: "archived" });
        await verify(layers[2]!.scope, layers[2]!.runtime);
        await put(layers[2]!.scope, "runtime", { inherit: true });
        await verify(layers[1]!.scope, layers[1]!.runtime);
        await put(layers[1]!.scope, "security-posture", { posture: "strict" });
        const inherited = await verify(layers[1]!.scope, layers[1]!.runtime);
        assert.equal(inherited.admin.securityPosture, "strict");
        const moved = (await writer.organizationStore.getUnit("default-org", team.id))!;
        await writer.organizationStore.putUnit({ ...moved, parentId: "root" });
        const afterMove = await verify(ORG, fallback);
        assert.equal(afterMove.admin.securityPosture, "auto");
        assert.ok(!afterMove.admin.governanceScopes.includes(layers[1]!.scope));
        const otherUser = await request(
          servers[1]!.base,
          "/v1/runtime-config?principalId=unrelated-user&scopeId=personal:unrelated-user",
        );
        assert.deepEqual(otherUser.effective, fallback);
        const forbidden = await fetch(`${servers[0]!.base}/v1/admin/scopes/${PERSONAL}/runtime`, {
          method: "PUT",
          headers: { ...ADMIN, "x-admin-actor": "recursive-alice@default-org" },
          body: JSON.stringify(layers[3]!.runtime),
        });
        assert.equal(forbidden.status, 403);
        await verify(ORG, fallback);
        await writer.organization.addGroupMember({
          groupId: groups[1]!.id,
          principalId: "recursive-alice",
          role: "member",
          actor: "admin-alice",
        });
        const controlScope = layers[4]!.scope;
        const controls = [
          ["interactive-fast-mode", { on: true }],
          ["approved-harnesses", { ids: ["pi"] }],
          ["webui-models", { ids: ["claude-sonnet-4-6"] }],
          ["browse-model", { modelId: "claude-sonnet-4-6" }],
          ["browse-max-steps", { steps: 20 }],
          ["turn-wall-clock", { sec: 120 }],
        ] as const;
        for (const [resource, body] of controls) await put(controlScope, resource, body);
        await put(PERSONAL, "browse-max-steps", { steps: 100 });
        await put(PERSONAL, "turn-wall-clock", { sec: 0 });
        const governed = await request(servers[1]!.base, `/v1/admin/scopes/${PERSONAL}`);
        assert.equal(governed.interactiveFastMode, true);
        assert.deepEqual(governed.approvedHarnesses, ["pi"]);
        assert.deepEqual(governed.webuiModels, ["claude-sonnet-4-6"]);
        assert.equal(governed.browseModel, "claude-sonnet-4-6");
        assert.equal(governed.browseMaxSteps, 20);
        assert.equal(governed.turnWallClockSec, 120);
        assert.equal(governed.runtimeEffective.modelId, "claude-sonnet-4-6");
        const userGoverned = await request(
          servers[1]!.base,
          `/v1/runtime-config?principalId=recursive-alice&scopeId=${PERSONAL}`,
        );
        assert.equal(userGoverned.interactiveFastMode, true);
        assert.deepEqual(userGoverned.approvedHarnesses, ["pi"]);
        assert.deepEqual(userGoverned.modelsByHarness.pi, ["claude-sonnet-4-6"]);
        assert.equal(userGoverned.effective.modelId, "claude-sonnet-4-6");
        const rejected = await fetch(`${servers[0]!.base}/v1/runtime-config`, {
          method: "PUT",
          headers: ADMIN,
          body: JSON.stringify({
            principalId: "recursive-alice",
            scopeId: PERSONAL,
            harnessId: "pi",
            modelId: "claude-opus-4-8",
          }),
        });
        assert.equal(rejected.status, 400);
        await put(PERSONAL, "webui-models", { ids: ["claude-opus-4-8"] });
        const blocked = await fetch(
          `${servers[1]!.base}/v1/runtime-config?principalId=recursive-alice&scopeId=${PERSONAL}`,
          { headers: ADMIN },
        );
        assert.equal(blocked.status, 403);
        assert.equal((await request(servers[1]!.base, `/v1/admin/scopes/${PERSONAL}`)).runtimeUnavailable, true);
        await put(PERSONAL, "webui-models", { inherit: true });
        await put(PERSONAL, "interactive-fast-mode", { on: false });
        assert.equal((await request(servers[1]!.base, `/v1/admin/scopes/${PERSONAL}`)).interactiveFastMode, false);
        await put(PERSONAL, "interactive-fast-mode", { inherit: true });
        assert.equal((await request(servers[1]!.base, `/v1/admin/scopes/${PERSONAL}`)).interactiveFastMode, true);
        for (const [resource] of controls) await put(controlScope, resource, { inherit: true });
        const cleared = await request(servers[1]!.base, `/v1/admin/scopes/${PERSONAL}`);
        assert.equal(cleared.interactiveFastMode, false);
        assert.deepEqual(cleared.approvedHarnesses, ["pi", "codex"]);
        assert.equal(cleared.webuiModels, null);
        assert.equal(cleared.browseModel, null);
        assert.equal(cleared.browseMaxSteps, 100);
        assert.equal(cleared.turnWallClockSec, 0);
      } finally {
        await Promise.all(servers.map(({ server }) => new Promise<void>((resolve) => server.close(() => resolve()))));
      }
    },
  );
}
