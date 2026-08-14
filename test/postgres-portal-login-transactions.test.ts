import { before, test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresPortalLoginTransactionStore } from "../src/auth/portal-login-transactions.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the portal login transaction tests";
const state = (n: string): string => n.padStart(64, "0");
const client = "c".repeat(43);
const clientFor = (n: number): string => n.toString(36).padStart(43, "c");

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  await pool.query("DROP TABLE IF EXISTS portal_login_transactions CASCADE");
  await pool.query("DROP TABLE IF EXISTS portal_login_rate_limits CASCADE");
  await pool.end();
});

test(
  "pg portal login transactions allow one claimant across instances and retain completion tombstones",
  { skip },
  async () => {
    const first = createPostgresPortalLoginTransactionStore(URL!);
    const second = createPostgresPortalLoginTransactionStore(URL!);
    const expiresAtMs = Date.now() + 60_000;
    assert.equal(await first.create(state("1"), JSON.stringify({ verifier: "v" }), expiresAtMs, client), "created");
    const claims = await Promise.all([first.claim(state("1")), second.claim(state("1"))]);
    const claimed = claims.find((claim) => claim.status === "claimed");
    assert.ok(claimed);
    assert.equal(claims.filter((claim) => claim.status === "claimed").length, 1);
    assert.equal(claims.filter((claim) => claim.status === "used").length, 1);
    if (!claimed || claimed.status !== "claimed") return;
    assert.deepEqual(await second.complete(state("1"), claimed.claimId, "succeeded"), { status: "completed" });
    assert.deepEqual(await first.claim(state("1")), { status: "used" });
    for (let attempt = 2; attempt <= 10; attempt++) {
      assert.equal(await first.create(state(String(attempt)), "{}", expiresAtMs, client), "created");
    }
    assert.equal(await first.create(state("11"), "{}", expiresAtMs, client), "client_limited");
    const remaining = await Promise.all(
      Array.from({ length: 54 }, (_, index) =>
        (index % 2 === 0 ? first : second).create(
          state(String(index + 100)),
          "{}",
          expiresAtMs,
          clientFor(index + 100),
        ),
      ),
    );
    assert.equal(remaining.filter((result) => result === "created").length, 54);
    const overflow = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        (index % 2 === 0 ? first : second).create(
          state(String(index + 200)),
          "{}",
          expiresAtMs,
          clientFor(index + 200),
        ),
      ),
    );
    assert.ok(overflow.every((result) => result === "global_limited"));
  },
);
