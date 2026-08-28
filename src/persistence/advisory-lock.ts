import type { PgPool } from "./pg-pool.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";

export interface AdvisoryLock {
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  tryWithLock?<T>(key: string, fn: () => Promise<T>): Promise<T | null>;
}

const DEFAULT_ADVISORY_LOCK_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_ADVISORY_LOCK_POLL_MS = 300;

export function createNoopAdvisoryLock(): AdvisoryLock {
  return {
    async withLock<T>(_key: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async tryWithLock<T>(_key: string, fn: () => Promise<T>): Promise<T | null> {
      return fn();
    },
  };
}

export function createMemoryAdvisoryLock(): AdvisoryLock {
  const queue = createKeyedQueue<string>();
  const held = new Set<string>();
  const withLock = <T>(key: string, fn: () => Promise<T>): Promise<T> =>
    queue(key, async () => {
      held.add(key);
      try {
        return await fn();
      } finally {
        held.delete(key);
      }
    });
  return {
    withLock,
    async tryWithLock(key, fn) {
      if (held.has(key)) return null;
      return withLock(key, fn);
    },
  };
}

export function createPostgresAdvisoryLock(
  pg: PgPool,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): AdvisoryLock {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ADVISORY_LOCK_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_ADVISORY_LOCK_POLL_MS;

  return {
    async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const deadline = Date.now() + timeoutMs;
      const pool = await pg.pool();
      for (;;) {
        const client = await pool.connect();
        let discard = false;
        try {
          const res = await client.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
            [key],
          );
          const held = res.rows[0]?.locked === true;
          if (held) {
            let outcome: { ok: true; value: T } | { ok: false; error: unknown };
            try {
              outcome = { ok: true, value: await fn() };
            } catch (error) {
              outcome = { ok: false, error };
            }
            try {
              await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
            } catch (error) {
              discard = true;
              throw error;
            }
            if (!outcome.ok) throw outcome.error;
            return outcome.value;
          }
        } finally {
          client.release(discard);
        }
        if (Date.now() >= deadline) throw new Error(`timeout acquiring advisory lock for ${key}`);
        await sleep(pollMs);
      }
    },

    async tryWithLock<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
      const pool = await pg.pool();
      const client = await pool.connect();
      let discard = false;
      try {
        const res = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
          [key],
        );
        if (res.rows[0]?.locked !== true) return null;
        let outcome: { ok: true; value: T } | { ok: false; error: unknown };
        try {
          outcome = { ok: true, value: await fn() };
        } catch (error) {
          outcome = { ok: false, error };
        }
        try {
          await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
        } catch (error) {
          discard = true;
          throw error;
        }
        if (!outcome.ok) throw outcome.error;
        return outcome.value;
      } finally {
        client.release(discard);
      }
    },
  };
}
