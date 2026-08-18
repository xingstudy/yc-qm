import { test } from "node:test";
import assert from "node:assert/strict";
import { mintPortalIdentity } from "../plugins/chassis/src/portal-identity.ts";
import { verifyPortalIdentity } from "../src/auth/portal-identity.ts";

const SECRET = "organization-gate-test-secret";

test("a session-version claim survives chassis mint to core verify", async () => {
  const now = 1_000_000;
  const token = mintPortalIdentity({ p: "alice@default-org", sv: 3, exp: now + 60_000 }, SECRET);
  const claims = await verifyPortalIdentity(token, SECRET, now);
  assert.equal(claims?.sv, 3);
});
