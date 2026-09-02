import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import {
  createMemoryDirectorySourceStore,
  type DirectorySourceStore,
} from "../src/directory-sources/directory-source-store.ts";
import {
  createDirectorySourceService,
  type EnvironmentDirectorySource,
} from "../src/directory-sources/directory-source-service.ts";
import { createDirectoryProviderRegistry } from "../src/directory-sources/provider-registry.ts";
import type { DirectoryProviderAdapter } from "../src/directory-sources/provider.ts";
import type { IdentityLinkingService } from "../src/directory-sources/identity-linking-service.ts";
import type { ManagedDirectoryService } from "../src/directory-sources/managed-directory-service.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const SIGNING_SECRET = "directory-routes-signing-secret".repeat(2);
const PORTAL_SECRET = "directory-routes-portal-secret".repeat(2);
const CAPABILITY_SECRET = "directory-routes-capability-secret".repeat(2);
const ORG = "directory-route-org";
const ADMIN = "admin-alice";
const BASE_PATH = "/v1/admin/org/directory-sources";
const capabilities = {
  login: true,
  fullSync: true,
  targetedLookup: true,
  employeeNumber: false,
  mobile: false,
  departments: false,
  trustedCorporateEmail: true,
};

const provider: DirectoryProviderAdapter = {
  id: "fake",
  displayName: "Fake Directory",
  capabilities,
  publicFields: ["tenant", "redirectUri"],
  secretFields: ["clientId", "clientSecret"],
  async testConnection(config) {
    assert.equal(config.secretConfig.clientId, "client-id");
    assert.equal(config.secretConfig.clientSecret, "client-secret");
    return { externalTenantId: config.publicConfig.tenant!, capabilities };
  },
  async *fullSync() {},
  async targetedLookup() {
    return null;
  },
  async resolveLoginCode(config, input) {
    return {
      sourceId: input.sourceId,
      provider: "fake",
      externalTenantId: config.publicConfig.tenant!,
      externalSubjectId: "external-user",
      displayName: "External User",
      corporateEmail: null,
      personalEmail: null,
      employeeNumber: null,
      mobile: null,
      status: "active",
    };
  },
  authorizeUrl() {
    return "https://login.example.test";
  },
  profileAuthorizeUrl(_config, input) {
    return `https://profile.example.test/authorize?state=${encodeURIComponent(input.state)}`;
  },
  async sendProfileAuthorizationPrompt(_config, input) {
    return input.externalSubjectId === "external-user";
  },
  async resolveProfileAuthorizationCode(config, input) {
    return {
      sourceId: input.sourceId,
      provider: "fake",
      externalTenantId: config.publicConfig.tenant!,
      externalSubjectId: input.expectedExternalSubjectId,
      displayName: "External User",
      corporateEmail: "external@example.com",
      personalEmail: null,
      employeeNumber: null,
      mobile: null,
      status: "active",
    };
  },
};

function signedHeaders(method: string, path: string, body: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1_000);
  return {
    "content-type": "application/json",
    "x-timestamp": String(ts),
    "x-signature": signRequest(SIGNING_SECRET, ts, `${method}\n${path}\n${body}`),
  };
}

async function portalHeaders(method: string, path: string, body = ""): Promise<Record<string, string>> {
  return {
    ...signedHeaders(method, path, body),
    "x-portal-identity": await mintSignedPayload({ p: ADMIN, sv: 2, exp: Date.now() + 60_000 }, PORTAL_SECRET),
  };
}

async function start(withDirectory: boolean, environmentSources: readonly EnvironmentDirectorySource[] = []) {
  const cfg = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "directory-routes-")),
    orgId: ORG,
  });
  const built = buildApp(cfg);
  const memory = createMemoryDirectorySourceStore();
  const store: DirectorySourceStore = { ...memory, durable: true };
  const directorySources = createDirectorySourceService({
    orgId: ORG,
    store,
    providers: createDirectoryProviderRegistry([provider]),
    keyMaterial: cfg.connectorSecretKey!,
    auditLog: built.auditLog,
    environmentSources,
  });
  await directorySources.ready;
  const identityEvents = { invalidatedSources: [] as string[], invalidatedRevisions: [] as number[] };
  let stableBinding = false;
  const identityLinking = {
    async sourceImpact() {
      return { members: 4, bindings: 2, affectedUsers: 2 };
    },
    async invalidateSourceSessions(sourceId: string, _actor: string, sourceRevision?: number) {
      identityEvents.invalidatedSources.push(sourceId);
      if (sourceRevision !== undefined) identityEvents.invalidatedRevisions.push(sourceRevision);
      return 2;
    },
    async hasStableBinding() {
      return stableBinding;
    },
  } as unknown as IdentityLinkingService;
  const managedEvents = {
    mappingDecisions: [] as Array<{
      sourceId: string;
      previewId: string;
      externalUnitId: string;
      decision: "create" | "map";
      actor: string;
    }>,
  };
  const managedDirectory = {
    async decideUnitMapping(input: (typeof managedEvents.mappingDecisions)[number]) {
      managedEvents.mappingDecisions.push(input);
      return "mapped" as const;
    },
  } as unknown as ManagedDirectoryService;
  const server = createServer(built.app, {
    signingSecret: SIGNING_SECRET,
    capabilitySecret: CAPABILITY_SECRET,
    portalIdentitySecret: PORTAL_SECRET,
    requireSignedPortalIdentity: true,
    admin: built.admin,
    organization: built.organization,
    auditLog: built.auditLog,
    advisoryLock: built.advisoryLock,
    organizationOrgId: ORG,
    ...(withDirectory
      ? {
          directorySources,
          directorySourceStore: store,
          identityLinking,
          managedDirectory,
        }
      : {}),
  });
  server.listen(0);
  await built.organization.invite({ principalId: ADMIN, email: null, displayName: ADMIN, actor: "test" });
  await built.organization.setStatus({ principalId: ADMIN, status: "active", actor: "test" });
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    directorySources,
    identityEvents,
    managedEvents,
    setStableBinding(value: boolean) {
      stableBinding = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("directory source admin routes fail closed without a durable source service", async () => {
  const server = await start(false);
  try {
    const response = await fetch(`${server.base}${BASE_PATH}`, {
      headers: await portalHeaders("GET", BASE_PATH),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "not_configured",
      message: "directory sources require PostgreSQL",
    });
  } finally {
    await server.close();
  }
});

test("directory sign-in requests profile authorization only for an unbound identity without corporate email", async () => {
  const server = await start(true);
  try {
    const source = await server.directorySources.create(
      {
        provider: "fake",
        name: "Corporate directory",
        publicConfig: {
          tenant: "tenant-1",
          redirectUri: "https://agent.example.test/idp/directory/callback",
        },
        secretConfig: { clientId: "client-id", clientSecret: "client-secret" },
        loginEnabled: true,
      },
      ADMIN,
    );
    const resolvePath = `/v1/auth/directory-sources/${source.id}/resolve-code`;
    const firstBody = JSON.stringify({ code: "first-code" });
    const first = await fetch(`${server.base}${resolvePath}`, {
      method: "POST",
      headers: signedHeaders("POST", resolvePath, firstBody),
      body: firstBody,
    });
    assert.equal(first.status, 428);
    const firstResult = (await first.json()) as {
      protocolVersion: number;
      authorizationRequired: boolean;
      identity: { externalSubjectId: string; corporateEmail: string | null; proof: string };
    };
    assert.equal(firstResult.protocolVersion, 2);
    assert.equal(firstResult.authorizationRequired, true);
    assert.equal(firstResult.identity.externalSubjectId, "external-user");
    assert.equal(firstResult.identity.corporateEmail, null);
    assert.ok(firstResult.identity.proof);

    server.setStableBinding(true);
    const secondBody = JSON.stringify({ code: "second-code" });
    const second = await fetch(`${server.base}${resolvePath}`, {
      method: "POST",
      headers: signedHeaders("POST", resolvePath, secondBody),
      body: secondBody,
    });
    assert.equal(second.status, 200);
    const secondResult = (await second.json()) as { protocolVersion: number; authorizationRequired: boolean };
    assert.equal(secondResult.protocolVersion, 2);
    assert.equal(secondResult.authorizationRequired, false);

    const urlPath = `/v1/auth/directory-sources/${source.id}/profile-authorization-url`;
    const urlBody = JSON.stringify({ state: "sealed-profile-state" });
    const urlResponse = await fetch(`${server.base}${urlPath}`, {
      method: "POST",
      headers: signedHeaders("POST", urlPath, urlBody),
      body: urlBody,
    });
    assert.equal(urlResponse.status, 200);
    assert.deepEqual(await urlResponse.json(), {
      authorizeUrl: "https://profile.example.test/authorize?state=sealed-profile-state",
      promptDelivered: false,
    });

    const promptBody = JSON.stringify({ state: "sealed-profile-state-2", externalSubjectId: "external-user" });
    const promptResponse = await fetch(`${server.base}${urlPath}`, {
      method: "POST",
      headers: signedHeaders("POST", urlPath, promptBody),
      body: promptBody,
    });
    assert.equal(promptResponse.status, 200);
    assert.equal(((await promptResponse.json()) as { promptDelivered: boolean }).promptDelivered, true);

    const profilePath = `/v1/auth/directory-sources/${source.id}/resolve-profile-authorization-code`;
    const profileBody = JSON.stringify({
      code: "profile-code",
      provider: "fake",
      externalTenantId: "tenant-1",
      externalSubjectId: "external-user",
    });
    const profile = await fetch(`${server.base}${profilePath}`, {
      method: "POST",
      headers: signedHeaders("POST", profilePath, profileBody),
      body: profileBody,
    });
    assert.equal(profile.status, 200);
    const profileResult = (await profile.json()) as {
      identity: { corporateEmail: string; corporateEmailVerified: boolean; proof: string };
    };
    assert.equal(profileResult.identity.corporateEmail, "external@example.com");
    assert.equal(profileResult.identity.corporateEmailVerified, true);
    assert.ok(profileResult.identity.proof);
  } finally {
    await server.close();
  }
});

test("directory source admin routes accept provider-shaped secrets and never return them", async () => {
  const server = await start(true);
  try {
    const body = JSON.stringify({
      provider: "fake",
      name: "Corporate directory",
      publicConfig: {
        tenant: "tenant-1",
        redirectUri: "https://agent.example.test/idp/directory/callback",
      },
      secretConfig: { clientId: "client-id", clientSecret: "client-secret" },
    });
    const created = await fetch(`${server.base}${BASE_PATH}`, {
      method: "POST",
      headers: await portalHeaders("POST", BASE_PATH, body),
      body,
    });
    assert.equal(created.status, 201);
    const createdData = (await created.json()) as { source: Record<string, unknown> };
    assert.equal(createdData.source.externalTenantId, "tenant-1");
    assert.equal(createdData.source.hasSecret, true);
    assert.deepEqual(createdData.source.secretPresence, { clientId: true, clientSecret: true });
    assert.equal("secretConfig" in createdData.source, false);
    assert.equal("secretEnc" in createdData.source, false);
    assert.equal("environmentConfigFingerprint" in createdData.source, false);

    const listed = await fetch(`${server.base}${BASE_PATH}`, {
      headers: await portalHeaders("GET", BASE_PATH),
    });
    assert.equal(listed.status, 200);
    const listedData = (await listed.json()) as {
      sources: Array<Record<string, unknown>>;
      providers: Array<Record<string, unknown>>;
    };
    assert.equal(listedData.sources.length, 1);
    assert.deepEqual(listedData.providers[0]?.secretFields, ["clientId", "clientSecret"]);
    assert.deepEqual(listedData.providers[0]?.requiredSecretFields, ["clientId", "clientSecret"]);

    const conflictPath = `${BASE_PATH}/${createdData.source.id as string}`;
    const conflictBody = JSON.stringify({ expectedRevision: 0, name: "Changed" });
    const conflict = await fetch(`${server.base}${conflictPath}`, {
      method: "PATCH",
      headers: await portalHeaders("PATCH", conflictPath, conflictBody),
      body: conflictBody,
    });
    assert.equal(conflict.status, 409);

    const invalidBody = JSON.stringify({
      provider: "fake",
      name: "Invalid",
      publicConfig: { tenant: "tenant-2", redirectUri: "https://agent.example.test/callback" },
      secret: "legacy-shape",
    });
    const invalid = await fetch(`${server.base}${BASE_PATH}`, {
      method: "POST",
      headers: await portalHeaders("POST", BASE_PATH, invalidBody),
      body: invalidBody,
    });
    assert.equal(invalid.status, 400);
  } finally {
    await server.close();
  }
});

test("managed unit mapping validates decisions and forwards the administrator preview fence", async () => {
  const server = await start(true);
  try {
    const path = `${BASE_PATH}/source-1/managed-unit-mapping`;
    const invalidBody = JSON.stringify({
      externalUnitId: "engineering",
      decision: "map",
    });
    const invalid = await fetch(`${server.base}${path}`, {
      method: "POST",
      headers: await portalHeaders("POST", path, invalidBody),
      body: invalidBody,
    });
    assert.equal(invalid.status, 400);

    const body = JSON.stringify({
      previewId: "preview-1",
      externalUnitId: "engineering",
      decision: "map",
    });
    const mapped = await fetch(`${server.base}${path}`, {
      method: "POST",
      headers: await portalHeaders("POST", path, body),
      body,
    });
    assert.equal(mapped.status, 200);
    assert.deepEqual(await mapped.json(), { status: "mapped" });
    assert.deepEqual(server.managedEvents.mappingDecisions, [
      {
        sourceId: "source-1",
        previewId: "preview-1",
        externalUnitId: "engineering",
        decision: "map",
        actor: ADMIN,
      },
    ]);
  } finally {
    await server.close();
  }
});

test("both source pause routes invalidate sessions with the committed source revision", async () => {
  const server = await start(true);
  try {
    const create = async (tenant: string) => {
      const body = JSON.stringify({
        provider: "fake",
        name: `Directory ${tenant}`,
        publicConfig: { tenant, redirectUri: "https://agent.example.test/idp/directory/callback" },
        secretConfig: { clientId: "client-id", clientSecret: "client-secret" },
      });
      const response = await fetch(`${server.base}${BASE_PATH}`, {
        method: "POST",
        headers: await portalHeaders("POST", BASE_PATH, body),
        body,
      });
      return ((await response.json()) as { source: { id: string; revision: number } }).source;
    };
    const patchedSource = await create("tenant-patch");
    const patchPath = `${BASE_PATH}/${patchedSource.id}`;
    const patchBody = JSON.stringify({ expectedRevision: patchedSource.revision, status: "paused" });
    const patched = await fetch(`${server.base}${patchPath}`, {
      method: "PATCH",
      headers: await portalHeaders("PATCH", patchPath, patchBody),
      body: patchBody,
    });
    assert.equal(patched.status, 200);
    assert.equal(((await patched.json()) as { affectedUsers: number }).affectedUsers, 2);

    const pausedSource = await create("tenant-pause");
    const pausePath = `${BASE_PATH}/${pausedSource.id}/pause`;
    const pauseBody = JSON.stringify({ expectedRevision: pausedSource.revision });
    const paused = await fetch(`${server.base}${pausePath}`, {
      method: "POST",
      headers: await portalHeaders("POST", pausePath, pauseBody),
      body: pauseBody,
    });
    assert.equal(paused.status, 200);
    assert.equal(((await paused.json()) as { affectedUsers: number }).affectedUsers, 2);
    assert.deepEqual(server.identityEvents.invalidatedSources, [patchedSource.id, pausedSource.id]);
    assert.deepEqual(server.identityEvents.invalidatedRevisions, [2, 2]);
  } finally {
    await server.close();
  }
});

test("directory source deletion exposes impact, invalidates sessions, keeps a tombstone, and restores the same source", async () => {
  const server = await start(true);
  try {
    const createBody = JSON.stringify({
      provider: "fake",
      name: "Corporate directory",
      publicConfig: {
        tenant: "tenant-1",
        redirectUri: "https://agent.example.test/idp/directory/callback",
      },
      secretConfig: { clientId: "client-id", clientSecret: "client-secret" },
    });
    const created = await fetch(`${server.base}${BASE_PATH}`, {
      method: "POST",
      headers: await portalHeaders("POST", BASE_PATH, createBody),
      body: createBody,
    });
    const source = ((await created.json()) as { source: { id: string; revision: number } }).source;
    const impactPath = `${BASE_PATH}/${source.id}/impact`;
    const impact = await fetch(`${server.base}${impactPath}`, {
      headers: await portalHeaders("GET", impactPath),
    });
    assert.equal(impact.status, 200);
    assert.deepEqual(await impact.json(), { sourceRevision: 1, members: 4, bindings: 2, affectedUsers: 2 });

    const deletePath = `${BASE_PATH}/${source.id}?expectedRevision=${source.revision}`;
    const deleted = await fetch(`${server.base}${deletePath}`, {
      method: "DELETE",
      headers: await portalHeaders("DELETE", deletePath),
    });
    assert.equal(deleted.status, 200);
    const deletedData = (await deleted.json()) as {
      source: { id: string; revision: number; status: string; hasSecret: boolean };
      affectedUsers: number;
    };
    assert.equal(deletedData.source.id, source.id);
    assert.equal(deletedData.source.status, "deleted");
    assert.equal(deletedData.source.hasSecret, false);
    assert.equal(deletedData.affectedUsers, 2);
    assert.deepEqual(server.identityEvents.invalidatedSources, [source.id]);

    const listPath = `${BASE_PATH}?includeDeleted=true`;
    const listed = await fetch(`${server.base}${listPath}`, {
      headers: await portalHeaders("GET", listPath),
    });
    const listedData = (await listed.json()) as { sources: Array<{ id: string; status: string }> };
    assert.deepEqual(
      listedData.sources.map(({ id, status }) => ({ id, status })),
      [{ id: source.id, status: "deleted" }],
    );

    const restorePath = `${BASE_PATH}/${source.id}/restore`;
    const restoreBody = JSON.stringify({
      expectedRevision: deletedData.source.revision,
      secretConfig: { clientId: "client-id", clientSecret: "client-secret" },
    });
    const restored = await fetch(`${server.base}${restorePath}`, {
      method: "POST",
      headers: await portalHeaders("POST", restorePath, restoreBody),
      body: restoreBody,
    });
    assert.equal(restored.status, 200);
    const restoredSource = (await restored.json()) as {
      source: { id: string; status: string; loginEnabled: boolean; syncEnabled: boolean };
    };
    assert.equal(restoredSource.source.id, source.id);
    assert.equal(restoredSource.source.status, "paused");
    assert.equal(restoredSource.source.loginEnabled, false);
    assert.equal(restoredSource.source.syncEnabled, false);
  } finally {
    await server.close();
  }
});

test("deleting an environment source is rejected before pause or session invalidation", async () => {
  const server = await start(true, [
    {
      provider: "fake",
      name: "Environment directory",
      publicConfig: {
        tenant: "tenant-1",
        redirectUri: "https://agent.example.test/idp/directory/callback",
      },
      secretConfig: { clientId: "client-id", clientSecret: "client-secret" },
      loginEnabled: true,
    },
  ]);
  try {
    const listed = await fetch(`${server.base}${BASE_PATH}`, {
      headers: await portalHeaders("GET", BASE_PATH),
    });
    const source = ((await listed.json()) as { sources: Array<{ id: string; revision: number }> }).sources[0]!;
    const deletePath = `${BASE_PATH}/${source.id}?expectedRevision=${source.revision}`;
    const deleted = await fetch(`${server.base}${deletePath}`, {
      method: "DELETE",
      headers: await portalHeaders("DELETE", deletePath),
    });
    assert.equal(deleted.status, 400);
    assert.equal(((await deleted.json()) as { error: string }).error, "directory_source_environment_delete_forbidden");
    assert.deepEqual(server.identityEvents.invalidatedSources, []);

    const detailPath = `${BASE_PATH}/${source.id}`;
    const detail = await fetch(`${server.base}${detailPath}`, {
      headers: await portalHeaders("GET", detailPath),
    });
    const current = (await detail.json()) as { source: { status: string; loginEnabled: boolean; revision: number } };
    assert.equal(current.source.status, "active");
    assert.equal(current.source.loginEnabled, true);
    assert.equal(current.source.revision, source.revision);
  } finally {
    await server.close();
  }
});
