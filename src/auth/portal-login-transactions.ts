import { createHash, randomUUID } from "node:crypto";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { createSweeper } from "../util/sweeper.ts";

type PortalLoginTransactionStatus = "created" | "conflict" | "client_limited" | "global_limited";

type PortalLoginClaim =
  { status: "claimed"; payload: string; claimId: string } | { status: "missing" | "used" | "expired" };

type PortalLoginCompletion = { status: "completed" | "missing" | "mismatch" };

export interface PortalLoginTransactionStore {
  readonly durable: boolean;
  create(
    state: string,
    payload: string,
    expiresAtMs: number,
    clientBucket: string,
  ): Promise<PortalLoginTransactionStatus>;
  claim(state: string): Promise<PortalLoginClaim>;
  complete(state: string, claimId: string, outcome: "succeeded" | "failed"): Promise<PortalLoginCompletion>;
}

type Transaction = {
  status: "pending" | "claimed" | "succeeded" | "failed";
  claimId: string | null;
  payload: string | null;
  expiresAtMs: number;
};

const PRUNE_INTERVAL_MS = 60_000;
const RATE_WINDOW_MS = 60_000;
const RATE_CLIENT_LIMIT = 10;
const RATE_GLOBAL_LIMIT = 64;
const RATE_GLOBAL_BUCKET = "global";

function stateHash(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

function expired(expiresAtMs: number, now: number): boolean {
  return expiresAtMs <= now;
}

export function createMemoryPortalLoginTransactionStore(now: () => number = Date.now): PortalLoginTransactionStore {
  const transactions = new Map<string, Transaction>();
  const rates = new Map<string, { window: number; used: number }>();
  let nextPruneAt = Number.NEGATIVE_INFINITY;
  const prune = (): void => {
    const current = now();
    if (current < nextPruneAt) return;
    nextPruneAt = current + PRUNE_INTERVAL_MS;
    for (const [hash, transaction] of transactions)
      if (expired(transaction.expiresAtMs, current)) transactions.delete(hash);
    const currentWindow = Math.floor(current / RATE_WINDOW_MS);
    for (const [bucket, rate] of rates) if (rate.window < currentWindow) rates.delete(bucket);
  };
  const rateUsed = (bucket: string, window: number): number => {
    const rate = rates.get(bucket);
    return rate?.window === window ? rate.used : 0;
  };
  const incrementRate = (bucket: string, window: number): void => {
    rates.set(bucket, { window, used: rateUsed(bucket, window) + 1 });
  };
  return {
    durable: false,
    async create(state, payload, expiresAtMs, clientBucket) {
      prune();
      const hash = stateHash(state);
      if (transactions.has(hash)) return "conflict";
      const window = Math.floor(now() / RATE_WINDOW_MS);
      const clientKey = `client:${clientBucket}`;
      if (rateUsed(clientKey, window) >= RATE_CLIENT_LIMIT) return "client_limited";
      if (rateUsed(RATE_GLOBAL_BUCKET, window) >= RATE_GLOBAL_LIMIT) return "global_limited";
      incrementRate(clientKey, window);
      incrementRate(RATE_GLOBAL_BUCKET, window);
      transactions.set(hash, { status: "pending", claimId: null, payload, expiresAtMs });
      return "created";
    },
    async claim(state) {
      const transaction = transactions.get(stateHash(state));
      if (!transaction) return { status: "missing" };
      if (expired(transaction.expiresAtMs, now())) {
        prune();
        return { status: "expired" };
      }
      prune();
      if (transaction.status !== "pending" || transaction.payload === null) return { status: "used" };
      const claimId = randomUUID();
      transaction.status = "claimed";
      transaction.claimId = claimId;
      return { status: "claimed", payload: transaction.payload, claimId };
    },
    async complete(state, claimId, outcome) {
      const transaction = transactions.get(stateHash(state));
      if (!transaction || expired(transaction.expiresAtMs, now())) return { status: "missing" };
      prune();
      if (transaction.status !== "claimed" || transaction.claimId !== claimId) return { status: "mismatch" };
      transaction.status = outcome;
      transaction.payload = null;
      return { status: "completed" };
    },
  };
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS portal_login_transactions (
    state_hash TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'succeeded', 'failed')),
    claim_id TEXT,
    payload TEXT,
    expires_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS portal_login_transactions_expires_at ON portal_login_transactions (expires_at)`,
  `CREATE TABLE IF NOT EXISTS portal_login_rate_limits (
    bucket TEXT PRIMARY KEY,
    window_number BIGINT NOT NULL,
    used INTEGER NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS portal_login_rate_limits_updated_at ON portal_login_rate_limits (updated_at)`,
];

export function createPostgresPortalLoginTransactionStore(connectionString: string): PortalLoginTransactionStore {
  const pg = createPgPool(connectionString, SCHEMA);
  const removeExpired = async (): Promise<void> => {
    await Promise.all([
      pg.query("DELETE FROM portal_login_transactions WHERE expires_at <= NOW()"),
      withPgTransaction(await pg.pool(), async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('portal-login-rate-limits'))");
        await client.query("DELETE FROM portal_login_rate_limits WHERE updated_at <= NOW() - INTERVAL '2 hours'");
      }),
    ]);
  };
  createSweeper(removeExpired, PRUNE_INTERVAL_MS, {
    label: "portal-login-transactions",
    immediate: true,
  }).start();
  let nextPruneAt = Number.NEGATIVE_INFINITY;
  const prune = async (): Promise<void> => {
    const current = Date.now();
    if (current < nextPruneAt) return;
    nextPruneAt = current + PRUNE_INTERVAL_MS;
    await removeExpired();
  };
  return {
    durable: true,
    async create(state, payload, expiresAtMs, clientBucket) {
      await prune();
      return withPgTransaction(await pg.pool(), async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('portal-login-rate-limits'))");
        const existing = await client.query("SELECT 1 FROM portal_login_transactions WHERE state_hash = $1", [
          stateHash(state),
        ]);
        if (existing.rowCount === 1) return "conflict";
        const current = await client.query(
          `SELECT clock.window_number, wanted.bucket AS wanted_bucket,
                  rate.window_number AS rate_window, rate.used
           FROM (VALUES ($1::text), ($2::text)) AS wanted(bucket)
           CROSS JOIN LATERAL (
             SELECT floor(extract(epoch FROM clock_timestamp()) / 60)::bigint AS window_number
           ) AS clock
           LEFT JOIN portal_login_rate_limits rate ON rate.bucket = wanted.bucket`,
          [RATE_GLOBAL_BUCKET, `client:${clientBucket}`],
        );
        const rows = current.rows as Array<{
          window_number: string;
          wanted_bucket: string;
          rate_window: string | null;
          used: number | null;
        }>;
        const window = Number(rows[0]?.window_number);
        const used = (bucket: string): number => {
          const row = rows.find((candidate) => candidate.wanted_bucket === bucket);
          return row && Number(row.rate_window) === window ? Number(row.used) : 0;
        };
        const clientKey = `client:${clientBucket}`;
        if (used(clientKey) >= RATE_CLIENT_LIMIT) return "client_limited";
        if (used(RATE_GLOBAL_BUCKET) >= RATE_GLOBAL_LIMIT) return "global_limited";
        for (const bucket of [clientKey, RATE_GLOBAL_BUCKET]) {
          await client.query(
            `INSERT INTO portal_login_rate_limits (bucket, window_number, used, updated_at)
             VALUES ($1, $2, 1, NOW())
             ON CONFLICT (bucket) DO UPDATE SET
               window_number = EXCLUDED.window_number,
               used = CASE
                 WHEN portal_login_rate_limits.window_number = EXCLUDED.window_number
                 THEN portal_login_rate_limits.used + 1
                 ELSE 1
               END,
               updated_at = NOW()`,
            [bucket, window],
          );
        }
        const result = await client.query(
          `INSERT INTO portal_login_transactions (state_hash, status, claim_id, payload, expires_at)
           VALUES ($1, 'pending', NULL, $2, to_timestamp($3 / 1000.0))
           ON CONFLICT (state_hash) DO NOTHING`,
          [stateHash(state), payload, expiresAtMs],
        );
        return result.rowCount === 1 ? "created" : "conflict";
      });
    },
    async claim(state) {
      const hash = stateHash(state);
      const claimId = randomUUID();
      const claimed = await pg.query(
        `UPDATE portal_login_transactions
         SET status = 'claimed', claim_id = $2
         WHERE state_hash = $1 AND status = 'pending' AND expires_at > NOW()
         RETURNING payload`,
        [hash, claimId],
      );
      const payload = claimed.rows[0]?.payload;
      if (claimed.rowCount === 1 && typeof payload === "string") return { status: "claimed", payload, claimId };
      const existing = await pg.query(
        "SELECT status, expires_at <= NOW() AS expired FROM portal_login_transactions WHERE state_hash = $1",
        [hash],
      );
      const transaction = existing.rows[0] as { status: Transaction["status"]; expired: boolean } | undefined;
      if (!transaction) return { status: "missing" };
      if (transaction.expired) {
        await prune();
        return { status: "expired" };
      }
      await prune();
      return { status: "used" };
    },
    async complete(state, claimId, outcome) {
      const hash = stateHash(state);
      const completed = await pg.query(
        `UPDATE portal_login_transactions
         SET status = $3, payload = NULL
         WHERE state_hash = $1 AND status = 'claimed' AND claim_id = $2 AND expires_at > NOW()
         RETURNING state_hash`,
        [hash, claimId, outcome],
      );
      if (completed.rowCount === 1) return { status: "completed" };
      const existing = await pg.query("SELECT status FROM portal_login_transactions WHERE state_hash = $1", [hash]);
      return existing.rowCount === 0 ? { status: "missing" } : { status: "mismatch" };
    },
  };
}
