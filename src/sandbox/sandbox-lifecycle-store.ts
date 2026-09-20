import { randomUUID } from "node:crypto";
import { createPgPool } from "../persistence/pg-pool.ts";

export type SandboxLifecycleState =
  "legacy_unknown" | "observing" | "ready" | "draining" | "migrating" | "parked" | "error";

export interface SandboxRuntimeInstance {
  orgId: string;
  backend: string;
  scopeId: string;
  containerName: string;
  currentGeneration?: string;
  desiredGeneration: string;
  state: SandboxLifecycleState;
  firstObservedAt: number;
  lastObservedAt: number;
  lastActiveAt: number;
  parkedAt?: number;
  migrationToken?: string;
  migrationExpiresAt?: number;
  lastError?: string;
}

export interface SandboxRuntimeLease {
  leaseId: string;
  orgId: string;
  backend: string;
  scopeId: string;
  containerName: string;
  holder: string;
  expiresAt: number;
  createdAt: number;
}

export interface ObserveSandboxInput {
  orgId: string;
  backend: string;
  scopeId: string;
  containerName: string;
  currentGeneration?: string;
  desiredGeneration: string;
  running: boolean;
  now: number;
}

export interface SandboxLifecycleStore {
  observe(input: ObserveSandboxInput): Promise<SandboxRuntimeInstance>;
  get(orgId: string, backend: string, scopeId: string): Promise<SandboxRuntimeInstance | null>;
  list(orgId: string, backend: string): Promise<SandboxRuntimeInstance[]>;
  acquireLease(
    input: Omit<SandboxRuntimeLease, "leaseId" | "createdAt"> & { leaseId?: string; createdAt?: number },
  ): Promise<SandboxRuntimeLease>;
  renewLease(leaseId: string, expiresAt: number): Promise<boolean>;
  releaseLease(leaseId: string): Promise<boolean>;
  activeLeases(orgId: string, backend: string, containerName: string, now: number): Promise<SandboxRuntimeLease[]>;
  mark(
    orgId: string,
    backend: string,
    scopeId: string,
    patch: Partial<
      Pick<
        SandboxRuntimeInstance,
        | "currentGeneration"
        | "desiredGeneration"
        | "state"
        | "lastObservedAt"
        | "lastActiveAt"
        | "parkedAt"
        | "migrationToken"
        | "migrationExpiresAt"
        | "lastError"
      >
    >,
  ): Promise<void>;
  tryClaimMigration(
    orgId: string,
    backend: string,
    scopeId: string,
    token: string,
    now: number,
    expiresAt: number,
  ): Promise<boolean>;
  delete(orgId: string, backend: string, scopeId: string): Promise<void>;
  close?(): void | Promise<void>;
}

const keyOf = (orgId: string, backend: string, scopeId: string): string => `${orgId}\0${backend}\0${scopeId}`;

function observedState(currentGeneration: string | undefined, running: boolean): SandboxLifecycleState {
  if (!currentGeneration) return "legacy_unknown";
  return running ? "ready" : "parked";
}

export function createMemorySandboxLifecycleStore(): SandboxLifecycleStore {
  const instances = new Map<string, SandboxRuntimeInstance>();
  const leases = new Map<string, SandboxRuntimeLease>();
  return {
    async observe(input) {
      const key = keyOf(input.orgId, input.backend, input.scopeId);
      const existing = instances.get(key);
      const row: SandboxRuntimeInstance = existing
        ? {
            ...existing,
            containerName: input.containerName,
            ...(input.currentGeneration ? { currentGeneration: input.currentGeneration } : {}),
            desiredGeneration: input.desiredGeneration,
            lastObservedAt: input.now,
          }
        : {
            orgId: input.orgId,
            backend: input.backend,
            scopeId: input.scopeId,
            containerName: input.containerName,
            ...(input.currentGeneration ? { currentGeneration: input.currentGeneration } : {}),
            desiredGeneration: input.desiredGeneration,
            state: observedState(input.currentGeneration, input.running),
            firstObservedAt: input.now,
            lastObservedAt: input.now,
            lastActiveAt: input.now,
            ...(input.running ? {} : { parkedAt: input.now }),
          };
      instances.set(key, row);
      return { ...row };
    },
    async get(orgId, backend, scopeId) {
      const row = instances.get(keyOf(orgId, backend, scopeId));
      return row ? { ...row } : null;
    },
    async list(orgId, backend) {
      return [...instances.values()]
        .filter((row) => row.orgId === orgId && row.backend === backend)
        .map((row) => ({ ...row }));
    },
    async acquireLease(input) {
      const row: SandboxRuntimeLease = {
        ...input,
        leaseId: input.leaseId ?? randomUUID(),
        createdAt: input.createdAt ?? Date.now(),
      };
      leases.set(row.leaseId, row);
      const instance = instances.get(keyOf(row.orgId, row.backend, row.scopeId));
      if (instance) {
        instance.lastActiveAt = row.createdAt;
        instance.state = "ready";
        instance.parkedAt = undefined;
      }
      return { ...row };
    },
    async renewLease(leaseId, expiresAt) {
      const row = leases.get(leaseId);
      if (!row) return false;
      row.expiresAt = expiresAt;
      return true;
    },
    async releaseLease(leaseId) {
      return leases.delete(leaseId);
    },
    async activeLeases(orgId, backend, containerName, now) {
      for (const [id, lease] of leases) if (lease.expiresAt <= now) leases.delete(id);
      return [...leases.values()]
        .filter((lease) => lease.orgId === orgId && lease.backend === backend && lease.containerName === containerName)
        .map((lease) => ({ ...lease }));
    },
    async mark(orgId, backend, scopeId, patch) {
      const row = instances.get(keyOf(orgId, backend, scopeId));
      if (!row) return;
      Object.assign(row, patch);
      for (const field of [
        "currentGeneration",
        "parkedAt",
        "migrationToken",
        "migrationExpiresAt",
        "lastError",
      ] as const) {
        if (field in patch && patch[field] === undefined) delete row[field];
      }
    },
    async tryClaimMigration(orgId, backend, scopeId, token, now, expiresAt) {
      const row = instances.get(keyOf(orgId, backend, scopeId));
      if (!row || (row.migrationToken && (row.migrationExpiresAt ?? 0) > now)) return false;
      row.migrationToken = token;
      row.migrationExpiresAt = expiresAt;
      row.state = "migrating";
      row.lastError = undefined;
      return true;
    },
    async delete(orgId, backend, scopeId) {
      instances.delete(keyOf(orgId, backend, scopeId));
      for (const [id, lease] of leases)
        if (lease.orgId === orgId && lease.backend === backend && lease.scopeId === scopeId) leases.delete(id);
    },
  };
}

const instanceFromPg = (row: Record<string, unknown>): SandboxRuntimeInstance => ({
  orgId: row.org_id as string,
  backend: row.backend as string,
  scopeId: row.scope_id as string,
  containerName: row.container_name as string,
  ...(row.current_generation ? { currentGeneration: row.current_generation as string } : {}),
  desiredGeneration: row.desired_generation as string,
  state: row.state as SandboxLifecycleState,
  firstObservedAt: Number(row.first_observed_at),
  lastObservedAt: Number(row.last_observed_at),
  lastActiveAt: Number(row.last_active_at),
  ...(row.parked_at == null ? {} : { parkedAt: Number(row.parked_at) }),
  ...(row.migration_token ? { migrationToken: row.migration_token as string } : {}),
  ...(row.migration_expires_at == null ? {} : { migrationExpiresAt: Number(row.migration_expires_at) }),
  ...(row.last_error ? { lastError: row.last_error as string } : {}),
});

const leaseFromPg = (row: Record<string, unknown>): SandboxRuntimeLease => ({
  leaseId: row.lease_id as string,
  orgId: row.org_id as string,
  backend: row.backend as string,
  scopeId: row.scope_id as string,
  containerName: row.container_name as string,
  holder: row.holder as string,
  expiresAt: Number(row.expires_at),
  createdAt: Number(row.created_at),
});

export function createPostgresSandboxLifecycleStore(connectionString: string): SandboxLifecycleStore {
  const pg = createPgPool(connectionString, "sandbox/lifecycle/0001", [
    `CREATE TABLE IF NOT EXISTS sandbox_runtime_instances(
       org_id TEXT NOT NULL, backend TEXT NOT NULL, scope_id TEXT NOT NULL, container_name TEXT NOT NULL,
       current_generation TEXT, desired_generation TEXT NOT NULL, state TEXT NOT NULL,
       first_observed_at BIGINT NOT NULL, last_observed_at BIGINT NOT NULL, last_active_at BIGINT NOT NULL,
       parked_at BIGINT, migration_token TEXT, migration_expires_at BIGINT, last_error TEXT,
       PRIMARY KEY(org_id, backend, scope_id)
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_sandbox_runtime_container
       ON sandbox_runtime_instances(org_id, backend, container_name)`,
    `CREATE TABLE IF NOT EXISTS sandbox_runtime_leases(
       lease_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, backend TEXT NOT NULL, scope_id TEXT NOT NULL,
       container_name TEXT NOT NULL, holder TEXT NOT NULL, expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_sandbox_runtime_lease_container
       ON sandbox_runtime_leases(org_id, backend, container_name, expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_sandbox_runtime_lease_scope
       ON sandbox_runtime_leases(org_id, backend, scope_id)`,
  ]);
  const q = pg.q.bind(pg);
  return {
    async observe(input) {
      const state = observedState(input.currentGeneration, input.running);
      const rows = await q(
        `INSERT INTO sandbox_runtime_instances(
           org_id, backend, scope_id, container_name, current_generation, desired_generation, state,
           first_observed_at, last_observed_at, last_active_at, parked_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$8,$9)
         ON CONFLICT(org_id, backend, scope_id) DO UPDATE SET
           container_name=EXCLUDED.container_name,
           current_generation=COALESCE(EXCLUDED.current_generation, sandbox_runtime_instances.current_generation),
           desired_generation=EXCLUDED.desired_generation,
           last_observed_at=EXCLUDED.last_observed_at
         RETURNING *`,
        [
          input.orgId,
          input.backend,
          input.scopeId,
          input.containerName,
          input.currentGeneration ?? null,
          input.desiredGeneration,
          state,
          input.now,
          input.running ? null : input.now,
        ],
      );
      return instanceFromPg(rows[0]!);
    },
    async get(orgId, backend, scopeId) {
      const rows = await q("SELECT * FROM sandbox_runtime_instances WHERE org_id=$1 AND backend=$2 AND scope_id=$3", [
        orgId,
        backend,
        scopeId,
      ]);
      return rows[0] ? instanceFromPg(rows[0]) : null;
    },
    async list(orgId, backend) {
      return (await q("SELECT * FROM sandbox_runtime_instances WHERE org_id=$1 AND backend=$2", [orgId, backend])).map(
        instanceFromPg,
      );
    },
    async acquireLease(input) {
      const row: SandboxRuntimeLease = {
        ...input,
        leaseId: input.leaseId ?? randomUUID(),
        createdAt: input.createdAt ?? Date.now(),
      };
      await q(
        `INSERT INTO sandbox_runtime_leases(
           lease_id, org_id, backend, scope_id, container_name, holder, expires_at, created_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [row.leaseId, row.orgId, row.backend, row.scopeId, row.containerName, row.holder, row.expiresAt, row.createdAt],
      );
      await q(
        `UPDATE sandbox_runtime_instances
           SET last_active_at=$4, state='ready', parked_at=NULL
         WHERE org_id=$1 AND backend=$2 AND scope_id=$3`,
        [row.orgId, row.backend, row.scopeId, row.createdAt],
      );
      return row;
    },
    async renewLease(leaseId, expiresAt) {
      return (
        (
          await q("UPDATE sandbox_runtime_leases SET expires_at=$2 WHERE lease_id=$1 RETURNING lease_id", [
            leaseId,
            expiresAt,
          ])
        ).length > 0
      );
    },
    async releaseLease(leaseId) {
      return (await q("DELETE FROM sandbox_runtime_leases WHERE lease_id=$1 RETURNING lease_id", [leaseId])).length > 0;
    },
    async activeLeases(orgId, backend, containerName, now) {
      await q("DELETE FROM sandbox_runtime_leases WHERE expires_at <= $1", [now]);
      return (
        await q(
          `SELECT * FROM sandbox_runtime_leases
           WHERE org_id=$1 AND backend=$2 AND container_name=$3 AND expires_at>$4`,
          [orgId, backend, containerName, now],
        )
      ).map(leaseFromPg);
    },
    async mark(orgId, backend, scopeId, patch) {
      const fields: string[] = [];
      const values: unknown[] = [orgId, backend, scopeId];
      const names = {
        currentGeneration: "current_generation",
        desiredGeneration: "desired_generation",
        state: "state",
        lastObservedAt: "last_observed_at",
        lastActiveAt: "last_active_at",
        parkedAt: "parked_at",
        migrationToken: "migration_token",
        migrationExpiresAt: "migration_expires_at",
        lastError: "last_error",
      } as const;
      for (const [key, column] of Object.entries(names) as Array<[keyof typeof names, string]>) {
        if (!(key in patch)) continue;
        values.push(patch[key] ?? null);
        fields.push(`${column}=$${values.length}`);
      }
      if (!fields.length) return;
      await q(
        `UPDATE sandbox_runtime_instances SET ${fields.join(",")} WHERE org_id=$1 AND backend=$2 AND scope_id=$3`,
        values,
      );
    },
    async tryClaimMigration(orgId, backend, scopeId, token, now, expiresAt) {
      return (
        (
          await q(
            `UPDATE sandbox_runtime_instances
           SET migration_token=$4, migration_expires_at=$6, state='migrating', last_error=NULL
           WHERE org_id=$1 AND backend=$2 AND scope_id=$3
             AND (migration_token IS NULL OR migration_expires_at <= $5)
           RETURNING scope_id`,
            [orgId, backend, scopeId, token, now, expiresAt],
          )
        ).length > 0
      );
    },
    async delete(orgId, backend, scopeId) {
      await q("DELETE FROM sandbox_runtime_leases WHERE org_id=$1 AND backend=$2 AND scope_id=$3", [
        orgId,
        backend,
        scopeId,
      ]);
      await q("DELETE FROM sandbox_runtime_instances WHERE org_id=$1 AND backend=$2 AND scope_id=$3", [
        orgId,
        backend,
        scopeId,
      ]);
    },
    close: () => pg.close(),
  };
}
