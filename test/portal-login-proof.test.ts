import assert from "node:assert/strict";
import { test } from "node:test";
import { mintPortalLoginProof, verifyPortalLoginProof } from "../plugins/chassis/src/portal-login-proof.ts";

const SECRET = "portal-login-proof-test-secret-000001";

test("portal login proofs bind claims and stop being valid at their exact expiry", () => {
  const claims = {
    principalId: "alice",
    issuer: "https://issuer.example.test",
    subject: "subject-1",
    email: "Alice@Example.COM",
    emailVerified: true,
  };
  const proof = mintPortalLoginProof(claims, SECRET, 1_000);
  assert.ok(verifyPortalLoginProof(proof, claims, SECRET, 60_999));
  assert.equal(verifyPortalLoginProof(proof, claims, SECRET, 61_000), null);
  assert.equal(verifyPortalLoginProof(proof, { ...claims, email: "mallory@example.com" }, SECRET, 2_000), null);
  assert.equal(verifyPortalLoginProof(proof, claims, `${SECRET}-wrong`, 2_000), null);
});
