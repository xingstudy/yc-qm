import { createPgPool } from "../persistence/pg-pool.ts";
import type { Pool, PoolClient } from "../persistence/pg-pool.ts";
import type { ScopeId } from "../types.ts";
import type { AuditEvent, AuditLog } from "../audit/audit-log.ts";

export interface PostgresAuditLog extends AuditLog {
  pool(): Promise<Pool>;
  recordInTransaction(client: PoolClient, e: AuditEvent): Promise<void>;
}

function rowToEvent(r: Record<string, unknown>): AuditEvent {
  return {
    at: Number(r.at),
    principalId: String(r.principal_id),
    action: String(r.action),
    resource: String(r.resource),
    scopeLabel: r.scope_label as ScopeId,
    ...(r.status == null ? {} : { status: String(r.status) }),
    ...(r.detail == null ? {} : { detail: String(r.detail) }),
    ...(r.org_id == null ? {} : { orgId: String(r.org_id) }),
    ...(r.actor_kind == null ? {} : { actorKind: String(r.actor_kind) }),
    ...(r.request_id == null ? {} : { requestId: String(r.request_id) }),
    ...(r.before_digest == null ? {} : { beforeDigest: String(r.before_digest) }),
    ...(r.after_digest == null ? {} : { afterDigest: String(r.after_digest) }),
    ...(r.source == null ? {} : { source: String(r.source) }),
    ...(r.result == null ? {} : { result: String(r.result) }),
  };
}

const COLS =
  "at, principal_id, action, resource, scope_label, status, detail, org_id, actor_kind, request_id, before_digest, after_digest, source, result";
const VALUES = "$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14";
const MAX = 50000;

function eventParams(e: AuditEvent): unknown[] {
  return [
    e.at,
    e.principalId,
    e.action,
    e.resource,
    e.scopeLabel,
    e.status ?? null,
    e.detail ?? null,
    e.orgId ?? null,
    e.actorKind ?? null,
    e.requestId ?? null,
    e.beforeDigest ?? null,
    e.afterDigest ?? null,
    e.source ?? null,
    e.result ?? null,
  ];
}

export function createPostgresAuditLog(connectionString: string): PostgresAuditLog {
  const pg = createPgPool(connectionString, [
    `CREATE TABLE IF NOT EXISTS audit_log(
        id BIGSERIAL PRIMARY KEY,
        at BIGINT NOT NULL,
        principal_id TEXT NOT NULL,
        action TEXT NOT NULL,
        resource TEXT NOT NULL,
        scope_label TEXT NOT NULL,
        status TEXT,
        detail TEXT
      )`,
    `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS idempotency_key TEXT`,
    `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS org_id TEXT`,
    `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_kind TEXT`,
    `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS request_id TEXT`,
    `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS before_digest TEXT`,
    `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS after_digest TEXT`,
    `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS source TEXT`,
    `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS result TEXT`,
    `CREATE INDEX IF NOT EXISTS audit_log_by_at ON audit_log(at DESC)`,
    `CREATE INDEX IF NOT EXISTS audit_log_by_scope_at ON audit_log(scope_label, at DESC)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS audit_log_by_idempotency_key ON audit_log(idempotency_key) WHERE idempotency_key IS NOT NULL`,
    `DO $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('agent-platform:audit-log-migrate'));
        IF to_regclass('public.audit_events') IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM audit_log LIMIT 1) THEN
          INSERT INTO audit_log (at, principal_id, action, resource, scope_label, status, detail)
          SELECT (json->>'at')::bigint, json->>'principalId', json->>'action', json->>'resource',
                 json->>'scopeLabel', json->>'status', json->>'detail'
          FROM audit_events
          WHERE json ? 'at'
          ORDER BY (json->>'at')::bigint ASC;
        END IF;
      END $$`,
  ]);
  const { q } = pg;

  const pendingWrites = new Set<Promise<void>>();
  return {
    pool: pg.pool,
    record(e) {
      const write = q(`INSERT INTO audit_log(${COLS}) VALUES (${VALUES})`, eventParams(e))
        .then(() => undefined)
        .catch((err) => console.error("[audit] failed to persist event to durable store:", err));
      pendingWrites.add(write);
      void write.finally(() => pendingWrites.delete(write));
    },
    async recordOnce(key, e) {
      await q(
        `INSERT INTO audit_log(${COLS}, idempotency_key) VALUES (${VALUES},$15)
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
        [...eventParams(e), key],
      );
    },
    async recordInTransaction(client, e) {
      if (e.idempotencyKey === undefined) {
        await client.query(`INSERT INTO audit_log(${COLS}) VALUES (${VALUES})`, eventParams(e));
        return;
      }
      await client.query(
        `INSERT INTO audit_log(${COLS}, idempotency_key) VALUES (${VALUES},$15)
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
        [...eventParams(e), e.idempotencyKey],
      );
    },
    async events() {
      await Promise.allSettled(pendingWrites);
      const rows = await q(`SELECT ${COLS} FROM audit_log ORDER BY at DESC, id DESC LIMIT $1`, [MAX]);
      return rows.map(rowToEvent).reverse();
    },
    async tail({ limit, scopeLabel, action, since }) {
      await Promise.allSettled(pendingWrites);
      const params: unknown[] = [];
      const conds: string[] = [];
      if (scopeLabel !== undefined) {
        params.push(scopeLabel);
        conds.push(`scope_label = $${params.length}`);
      }
      if (action !== undefined) {
        params.push(action);
        conds.push(`action = $${params.length}`);
      }
      if (since !== undefined) {
        params.push(since);
        conds.push(`at >= $${params.length}`);
      }
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
      params.push(limit);
      const rows = await q(
        `SELECT ${COLS} FROM audit_log ${where} ORDER BY at DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map(rowToEvent);
    },
  };
}
