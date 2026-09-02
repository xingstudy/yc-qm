import assert from "node:assert/strict";
import test from "node:test";
import { createDirectorySourceClient } from "../../chassis/src/directory-source-client.ts";

const identity = {
  sourceId: "source-wecom",
  provider: "wecom",
  externalTenantId: "wwcorp",
  externalSubjectId: "alice",
  displayName: "Alice",
  corporateEmail: null,
  corporateEmailVerified: false,
  personalEmail: null,
  employeeNumber: null,
  mobile: null,
  status: "active",
  proof: "signed-proof",
};

test("directory source client rejects a pre-profile-authorization Core protocol", async () => {
  const client = createDirectorySourceClient({
    coreApiUrl: "https://core.example.test",
    signingSecret: "test-secret",
    fetchImpl: async () => Response.json({ identity }),
  });
  await assert.rejects(() => client.resolveCode(identity.sourceId, "code"), /invalid identity response/);
});

test("directory source client recognizes the versioned profile-authorization precondition", async () => {
  const client = createDirectorySourceClient({
    coreApiUrl: "https://core.example.test",
    signingSecret: "test-secret",
    fetchImpl: async () =>
      Response.json({ protocolVersion: 2, identity, authorizationRequired: true }, { status: 428 }),
  });
  assert.deepEqual(await client.resolveCode(identity.sourceId, "code"), {
    identity,
    authorizationRequired: true,
  });
});

test("directory source client accepts a versioned completed resolution", async () => {
  const client = createDirectorySourceClient({
    coreApiUrl: "https://core.example.test",
    signingSecret: "test-secret",
    fetchImpl: async () => Response.json({ protocolVersion: 2, identity, authorizationRequired: false }),
  });
  assert.deepEqual(await client.resolveCode(identity.sourceId, "code"), {
    identity,
    authorizationRequired: false,
  });
});
