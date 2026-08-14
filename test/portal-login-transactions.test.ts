import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryPortalLoginTransactionStore } from "../src/auth/portal-login-transactions.ts";

const state = (n: string): string => n.padStart(64, "0");
const client = (n: string): string => n.padStart(43, "c");

test("portal login transactions claim once, preserve tombstones, and clear their payload", async () => {
  const now = { ms: 1_000_000 };
  const store = createMemoryPortalLoginTransactionStore(() => now.ms);
  assert.equal(
    await store.create(state("1"), JSON.stringify({ verifier: "v" }), now.ms + 60_000, client("1")),
    "created",
  );
  assert.equal(
    await store.create(state("1"), JSON.stringify({ verifier: "other" }), now.ms + 60_000, client("1")),
    "conflict",
  );
  const claimed = await store.claim(state("1"));
  assert.equal(claimed.status, "claimed");
  if (claimed.status !== "claimed") return;
  assert.equal(claimed.payload, JSON.stringify({ verifier: "v" }));
  assert.deepEqual(await store.claim(state("1")), { status: "used" });
  assert.deepEqual(await store.complete(state("1"), "not-the-claim", "failed"), { status: "mismatch" });
  assert.deepEqual(await store.complete(state("1"), claimed.claimId, "succeeded"), { status: "completed" });
  assert.deepEqual(await store.complete(state("1"), claimed.claimId, "succeeded"), { status: "mismatch" });
  assert.deepEqual(await store.claim(state("1")), { status: "used" });
});

test("portal login transactions reject expired records and prune them", async () => {
  const now = { ms: 2_000_000 };
  const store = createMemoryPortalLoginTransactionStore(() => now.ms);
  assert.equal(await store.create(state("2"), "{}", now.ms + 1, client("2")), "created");
  now.ms += 60_001;
  assert.deepEqual(await store.claim(state("2")), { status: "expired" });
  assert.equal(await store.create(state("2"), "{}", now.ms + 60_000, client("2")), "created");
});

test("portal login transactions allow exactly one concurrent claimant", async () => {
  const store = createMemoryPortalLoginTransactionStore();
  assert.equal(await store.create(state("3"), "{}", Date.now() + 60_000, client("3")), "created");
  const results = await Promise.all([store.claim(state("3")), store.claim(state("3"))]);
  assert.equal(results.filter((result) => result.status === "claimed").length, 1);
  assert.equal(results.filter((result) => result.status === "used").length, 1);
});

test("portal login transactions enforce client and global limits without consuming global capacity on client denial", async () => {
  const now = { ms: 3_000_000 };
  const store = createMemoryPortalLoginTransactionStore(() => now.ms);
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal(await store.create(state(`1${attempt}`), "{}", now.ms + 60_000, client("1")), "created");
  }
  assert.equal(await store.create(state("199"), "{}", now.ms + 60_000, client("1")), "client_limited");
  for (let attempt = 0; attempt < 54; attempt++) {
    assert.equal(await store.create(state(`2${attempt}`), "{}", now.ms + 60_000, client(`2${attempt}`)), "created");
  }
  assert.equal(await store.create(state("299"), "{}", now.ms + 60_000, client("299")), "global_limited");
});
