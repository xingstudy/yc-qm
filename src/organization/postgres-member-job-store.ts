import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { createSweeper } from "../util/sweeper.ts";
import type {
  OrganizationMemberJob,
  OrganizationMemberJobDetail,
  OrganizationMemberJobItem,
  OrganizationMemberJobItemStatus,
  OrganizationMemberJobPage,
  OrganizationMemberJobKind,
  OrganizationMemberJobStatus,
  OrganizationMemberJobStore,
} from "./member-job-store.ts";
import { OrganizationMemberJobConflictError } from "./member-job-store.ts";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS organization_member_jobs(
    id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    expected_authz_revision BIGINT NOT NULL,
    summary JSONB NOT NULL,
    created_at BIGINT NOT NULL,
    started_at BIGINT,
    claim_token TEXT,
    lease_expires_at BIGINT,
    completed_at BIGINT,
    expires_at BIGINT NOT NULL,
    error TEXT,
    PRIMARY KEY(org_id, id),
    UNIQUE(org_id, actor_id, idempotency_key)
  )`,
  `ALTER TABLE organization_member_jobs ADD COLUMN IF NOT EXISTS claim_token TEXT`,
  `ALTER TABLE organization_member_jobs ADD COLUMN IF NOT EXISTS lease_expires_at BIGINT`,
  `CREATE TABLE IF NOT EXISTS organization_member_job_items(
    org_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    item_index INTEGER NOT NULL,
    principal_id TEXT,
    expected_profile_revision BIGINT,
    normalized_input JSONB NOT NULL,
    changes JSONB NOT NULL,
    status TEXT NOT NULL,
    errors JSONB NOT NULL,
    warnings JSONB NOT NULL,
    PRIMARY KEY(org_id, job_id, item_index),
    FOREIGN KEY(org_id, job_id) REFERENCES organization_member_jobs(org_id, id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS organization_member_jobs_expiry ON organization_member_jobs(status, expires_at)`,
];

type Row = Record<string, unknown>;

function rowToJob(row: Row): OrganizationMemberJob {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    kind: row.kind as OrganizationMemberJobKind,
    status: row.status as OrganizationMemberJobStatus,
    actorId: row.actor_id as string,
    idempotencyKey: row.idempotency_key as string,
    inputHash: row.input_hash as string,
    expectedAuthzRevision: Number(row.expected_authz_revision),
    summary: (row.summary ?? {}) as Record<string, unknown>,
    createdAt: Number(row.created_at),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    claimToken: (row.claim_token as string | null) ?? null,
    leaseExpiresAt: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    expiresAt: Number(row.expires_at),
    error: (row.error as string | null) ?? null,
  };
}

function rowToItem(row: Row): OrganizationMemberJobItem {
  return {
    orgId: row.org_id as string,
    jobId: row.job_id as string,
    itemIndex: Number(row.item_index),
    principalId: (row.principal_id as string | null) ?? null,
    expectedProfileRevision: row.expected_profile_revision === null ? null : Number(row.expected_profile_revision),
    normalizedInput: (row.normalized_input ?? {}) as Record<string, unknown>,
    changes: (row.changes ?? {}) as Record<string, unknown>,
    status: row.status as OrganizationMemberJobItemStatus,
    errors: (row.errors ?? []) as string[],
    warnings: (row.warnings ?? []) as string[],
  };
}

export function createPostgresOrganizationMemberJobStore(connectionString: string): OrganizationMemberJobStore {
  const pg = createPgPool(connectionString, SCHEMA);
  const load = async (orgId: string, jobId: string, actorId: string): Promise<OrganizationMemberJobDetail | null> => {
    const jobs = await pg.q(`SELECT * FROM organization_member_jobs WHERE org_id = $1 AND id = $2 AND actor_id = $3`, [
      orgId,
      jobId,
      actorId,
    ]);
    if (!jobs[0]) return null;
    const items = await pg.q(
      `SELECT * FROM organization_member_job_items WHERE org_id = $1 AND job_id = $2 ORDER BY item_index`,
      [orgId, jobId],
    );
    return { job: rowToJob(jobs[0]), items: items.map(rowToItem) };
  };
  const loadPage = async (
    orgId: string,
    jobId: string,
    actorId: string,
    offset: number,
    limit: number,
  ): Promise<OrganizationMemberJobPage | null> => {
    const jobs = await pg.q(`SELECT * FROM organization_member_jobs WHERE org_id = $1 AND id = $2 AND actor_id = $3`, [
      orgId,
      jobId,
      actorId,
    ]);
    if (!jobs[0]) return null;
    const [items, counts] = await Promise.all([
      pg.q(
        `SELECT *
           FROM organization_member_job_items
          WHERE org_id = $1 AND job_id = $2
          ORDER BY item_index
          OFFSET $3 LIMIT $4`,
        [orgId, jobId, offset, limit],
      ),
      pg.q(`SELECT count(*)::BIGINT AS total FROM organization_member_job_items WHERE org_id = $1 AND job_id = $2`, [
        orgId,
        jobId,
      ]),
    ]);
    return {
      detail: { job: rowToJob(jobs[0]), items: items.map(rowToItem) },
      itemTotal: Number(counts[0]?.total ?? 0),
    };
  };
  const store: OrganizationMemberJobStore = {
    async create(job, items) {
      const pool = await pg.pool();
      const result = await withPgTransaction(pool, async (client) => {
        const inserted = await client.query(
          `INSERT INTO organization_member_jobs(
             id, org_id, kind, status, actor_id, idempotency_key, input_hash, expected_authz_revision,
             summary, created_at, started_at, claim_token, lease_expires_at, completed_at, expires_at, error
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT(org_id, actor_id, idempotency_key) DO NOTHING
           RETURNING id`,
          [
            job.id,
            job.orgId,
            job.kind,
            job.status,
            job.actorId,
            job.idempotencyKey,
            job.inputHash,
            job.expectedAuthzRevision,
            JSON.stringify(job.summary),
            job.createdAt,
            job.startedAt,
            job.claimToken,
            job.leaseExpiresAt,
            job.completedAt,
            job.expiresAt,
            job.error,
          ],
        );
        if (inserted.rowCount === 0) {
          const existing = await client.query(
            `SELECT id, kind, input_hash
               FROM organization_member_jobs
              WHERE org_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
            [job.orgId, job.actorId, job.idempotencyKey],
          );
          if (existing.rows[0]!.kind !== job.kind || existing.rows[0]!.input_hash !== job.inputHash) {
            throw new OrganizationMemberJobConflictError();
          }
          return { id: existing.rows[0]!.id as string, created: false };
        }
        for (const item of items) {
          await client.query(
            `INSERT INTO organization_member_job_items(
               org_id, job_id, item_index, principal_id, expected_profile_revision, normalized_input,
               changes, status, errors, warnings
             ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::jsonb,$10::jsonb)`,
            [
              item.orgId,
              item.jobId,
              item.itemIndex,
              item.principalId,
              item.expectedProfileRevision,
              JSON.stringify(item.normalizedInput),
              JSON.stringify(item.changes),
              item.status,
              JSON.stringify(item.errors),
              JSON.stringify(item.warnings),
            ],
          );
        }
        return { id: job.id, created: true };
      });
      return { detail: (await load(job.orgId, result.id, job.actorId))!, created: result.created };
    },
    get: load,
    page: loadPage,
    async claim(orgId, jobId, actorId, claimToken, now, leaseExpiresAt) {
      const changed = await pg.query(
        `UPDATE organization_member_jobs
            SET status = 'running', started_at = $5, claim_token = $4, lease_expires_at = $6
          WHERE org_id = $1 AND id = $2 AND actor_id = $3
            AND expires_at > $5
            AND (status = 'previewed' OR (status = 'running' AND COALESCE(lease_expires_at, 0) <= $5))`,
        [orgId, jobId, actorId, claimToken, now, leaseExpiresAt],
      );
      if (changed.rowCount === 0) {
        const existing = await load(orgId, jobId, actorId);
        return existing ? { detail: existing, acquired: false } : null;
      }
      return { detail: (await load(orgId, jobId, actorId))!, acquired: true };
    },
    async complete(orgId, jobId, actorId, claimToken, summary, now) {
      const completed = await withPgTransaction(await pg.pool(), async (client) => {
        const changed = await client.query(
          `UPDATE organization_member_jobs
              SET status = 'completed', completed_at = $5, summary = $6::jsonb, error = NULL,
                  claim_token = NULL, lease_expires_at = NULL
            WHERE org_id = $1 AND id = $2 AND actor_id = $3 AND status = 'running' AND claim_token = $4`,
          [orgId, jobId, actorId, claimToken, now, JSON.stringify(summary)],
        );
        if (changed.rowCount === 0) return false;
        await client.query(
          `UPDATE organization_member_job_items
              SET status = CASE WHEN status = 'ready' THEN 'completed' ELSE status END
            WHERE org_id = $1 AND job_id = $2`,
          [orgId, jobId],
        );
        return true;
      });
      return completed ? load(orgId, jobId, actorId) : null;
    },
    async fail(orgId, jobId, actorId, claimToken, error, now) {
      await pg.query(
        `UPDATE organization_member_jobs
            SET status = 'failed', completed_at = $5, error = $6, claim_token = NULL, lease_expires_at = NULL
          WHERE org_id = $1 AND id = $2 AND actor_id = $3 AND status = 'running' AND claim_token = $4`,
        [orgId, jobId, actorId, claimToken, now, error.slice(0, 500)],
      );
    },
    async expire(now) {
      return withPgTransaction(await pg.pool(), async (client) => {
        const expired = await client.query(
          `UPDATE organization_member_jobs
              SET status = 'expired', claim_token = NULL, lease_expires_at = NULL
            WHERE status IN ('previewed', 'running') AND expires_at <= $1
            RETURNING org_id, id`,
          [now],
        );
        for (const row of expired.rows) {
          await client.query(`DELETE FROM organization_member_job_items WHERE org_id = $1 AND job_id = $2`, [
            row.org_id,
            row.id,
          ]);
        }
        return expired.rowCount ?? 0;
      });
    },
    async close() {
      sweeper.stop();
      await pg.close();
    },
  };
  const sweeper = createSweeper(() => store.expire(Date.now()), 60 * 60 * 1_000, {
    label: "organization-member-jobs",
    immediate: true,
  });
  sweeper.start();
  return store;
}
