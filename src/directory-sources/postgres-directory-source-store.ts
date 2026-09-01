import { createPgPool, withPgTransaction, type PoolClient } from "../persistence/pg-pool.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import type { PostgresAuditLog } from "../admin/postgres-audit-log.ts";
import type { DirectorySourceStore } from "./directory-source-store.ts";
import {
  cloneDirectoryMember,
  combinedSnapshotRevision,
  snapshotResult,
  unitSnapshotResult,
  validateMembers,
  validateUnits,
  type DirectoryRunMutation,
} from "./directory-source-store.ts";
import type {
  DirectoryMemberQuery,
  DirectoryEmailLookupGuard,
  DirectoryEmailResolution,
  DirectoryManagedUserOwnership,
  DirectoryProviderCapabilities,
  DirectorySyncCounts,
  DirectorySyncRun,
  NormalizedDirectoryMember,
  NormalizedDirectoryUnit,
  DirectoryUnitMapping,
  DirectoryUnitMemberOwnership,
  ManagedDirectoryPreview,
  StoredDirectorySource,
} from "./types.ts";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS directory_sources(
    org_id TEXT NOT NULL,
    id TEXT NOT NULL,
    provider TEXT NOT NULL,
    name TEXT NOT NULL,
    external_tenant_id TEXT NOT NULL,
    status TEXT NOT NULL,
    origin TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'identity_only',
    login_enabled BOOLEAN NOT NULL,
    sync_enabled BOOLEAN NOT NULL,
    jit_provisioning_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    schedule_minutes INTEGER NOT NULL,
    match_policy TEXT NOT NULL,
    capabilities JSONB NOT NULL,
    public_config JSONB NOT NULL,
    environment_config_fingerprint TEXT,
    revision BIGINT NOT NULL,
    preview_confirmed_revision BIGINT,
    member_snapshot_revision TEXT,
    reconciliation_status TEXT NOT NULL DEFAULT 'not_started',
    reconciled_source_revision BIGINT,
    reconciled_member_snapshot_revision TEXT,
    reconciled_at BIGINT,
    reconciliation_expires_at BIGINT,
    last_test_at BIGINT,
    last_test_status TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    PRIMARY KEY(org_id, id)
  )`,
  `ALTER TABLE directory_sources ADD COLUMN IF NOT EXISTS preview_confirmed_revision BIGINT`,
  `ALTER TABLE directory_sources ADD COLUMN IF NOT EXISTS environment_config_fingerprint TEXT`,
  `ALTER TABLE directory_sources ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'identity_only'`,
  `ALTER TABLE directory_sources ADD COLUMN IF NOT EXISTS jit_provisioning_enabled BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE directory_sources ADD COLUMN IF NOT EXISTS member_snapshot_revision TEXT`,
  `ALTER TABLE directory_sources ADD COLUMN IF NOT EXISTS reconciliation_status TEXT NOT NULL DEFAULT 'not_started'`,
  `ALTER TABLE directory_sources ADD COLUMN IF NOT EXISTS reconciled_source_revision BIGINT`,
  `ALTER TABLE directory_sources ADD COLUMN IF NOT EXISTS reconciled_member_snapshot_revision TEXT`,
  `ALTER TABLE directory_sources ADD COLUMN IF NOT EXISTS reconciled_at BIGINT`,
  `ALTER TABLE directory_sources ADD COLUMN IF NOT EXISTS reconciliation_expires_at BIGINT`,
  `DO $$
   BEGIN
     PERFORM pg_advisory_xact_lock(hashtext('qm:directory-sources-tenant-index'));
     IF EXISTS (
       SELECT 1 FROM pg_indexes
       WHERE schemaname=current_schema() AND indexname='directory_sources_tenant_unique'
         AND indexdef NOT LIKE '%WHERE (status = ''active''::text)%'
     ) THEN
       DROP INDEX directory_sources_tenant_unique;
     END IF;
     IF NOT EXISTS (
       SELECT 1 FROM pg_indexes
       WHERE schemaname=current_schema() AND indexname='directory_sources_tenant_unique'
     ) THEN
       CREATE UNIQUE INDEX directory_sources_tenant_unique
       ON directory_sources(org_id, provider, external_tenant_id) WHERE status = 'active';
     END IF;
   END $$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS directory_sources_one_managed_directory
   ON directory_sources(org_id) WHERE status = 'active' AND mode = 'managed_directory'`,
  `CREATE TABLE IF NOT EXISTS directory_source_secrets(
    org_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_revision BIGINT,
    purpose TEXT NOT NULL,
    secret_enc TEXT NOT NULL,
    version BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY(org_id, source_id, purpose),
    FOREIGN KEY(org_id, source_id) REFERENCES directory_sources(org_id, id)
  )`,
  `ALTER TABLE directory_source_secrets ADD COLUMN IF NOT EXISTS source_revision BIGINT`,
  `UPDATE directory_source_secrets secret
   SET source_revision = source.revision
   FROM directory_sources source
   WHERE secret.org_id = source.org_id
     AND secret.source_id = source.id
      AND secret.source_revision IS NULL`,
  `CREATE OR REPLACE FUNCTION directory_source_secret_revision_default()
   RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF NEW.source_revision IS NULL THEN
       SELECT revision INTO NEW.source_revision
       FROM directory_sources
       WHERE org_id=NEW.org_id AND id=NEW.source_id;
     END IF;
     RETURN NEW;
   END $$`,
  `DO $$
   BEGIN
     PERFORM pg_advisory_xact_lock(hashtext('qm:directory-source-secret-revision-trigger'));
     IF NOT EXISTS (
       SELECT 1 FROM pg_trigger WHERE tgname='directory_source_secret_revision_default_trigger'
     ) THEN
       CREATE TRIGGER directory_source_secret_revision_default_trigger
       BEFORE INSERT OR UPDATE ON directory_source_secrets
       FOR EACH ROW EXECUTE FUNCTION directory_source_secret_revision_default();
     END IF;
   END $$`,
  `CREATE TABLE IF NOT EXISTS directory_source_members(
    org_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    external_subject_id TEXT NOT NULL,
    data JSONB NOT NULL,
    profile_hash TEXT NOT NULL,
    match_state TEXT NOT NULL,
    match_reason TEXT NOT NULL,
    matched_principal_id TEXT,
    ignored_by TEXT,
    ignored_reason TEXT,
    last_login_attempt_at BIGINT,
    observed_at BIGINT NOT NULL,
    PRIMARY KEY(org_id, source_id, external_subject_id),
    FOREIGN KEY(org_id, source_id) REFERENCES directory_sources(org_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS directory_source_members_state
   ON directory_source_members(org_id, source_id, match_state, external_subject_id)`,
  `CREATE TABLE IF NOT EXISTS directory_source_units(
    org_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    external_unit_id TEXT NOT NULL,
    data JSONB NOT NULL,
    profile_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    observed_at BIGINT NOT NULL,
    PRIMARY KEY(org_id, source_id, external_unit_id),
    FOREIGN KEY(org_id, source_id) REFERENCES directory_sources(org_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS directory_unit_mappings(
    org_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    external_tenant_id TEXT NOT NULL,
    external_unit_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    ownership TEXT NOT NULL DEFAULT 'source',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY(org_id, provider, external_tenant_id, external_unit_id),
    UNIQUE(org_id, source_id, unit_id),
    FOREIGN KEY(org_id, source_id) REFERENCES directory_sources(org_id, id)
  )`,
  `ALTER TABLE directory_unit_mappings ADD COLUMN IF NOT EXISTS ownership TEXT NOT NULL DEFAULT 'source'`,
  `CREATE TABLE IF NOT EXISTS directory_unit_member_ownership(
    org_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    is_primary BOOLEAN NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY(org_id, source_id, unit_id, principal_id),
    FOREIGN KEY(org_id, source_id) REFERENCES directory_sources(org_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS directory_managed_user_ownership(
    org_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    external_subject_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    suspended_by_source BOOLEAN NOT NULL DEFAULT FALSE,
    suspended_session_version BIGINT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY(org_id, source_id, external_subject_id),
    UNIQUE(org_id, source_id, principal_id),
    FOREIGN KEY(org_id, source_id) REFERENCES directory_sources(org_id, id)
  )`,
  `ALTER TABLE directory_managed_user_ownership
   ADD COLUMN IF NOT EXISTS suspended_by_source BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE directory_managed_user_ownership
   ADD COLUMN IF NOT EXISTS suspended_session_version BIGINT`,
  `CREATE TABLE IF NOT EXISTS directory_managed_previews(
    org_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    id TEXT NOT NULL,
    source_revision BIGINT NOT NULL,
    snapshot_revision TEXT NOT NULL,
    status TEXT NOT NULL,
    data JSONB NOT NULL,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    committed_at BIGINT,
    actor TEXT NOT NULL,
    PRIMARY KEY(org_id, source_id, id),
    FOREIGN KEY(org_id, source_id) REFERENCES directory_sources(org_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS directory_email_resolutions(
    org_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    email_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    external_subject_id TEXT,
    source_revision BIGINT NOT NULL,
    member_snapshot_revision TEXT,
    checked_at BIGINT NOT NULL,
    retry_at BIGINT NOT NULL,
    failure_count INTEGER NOT NULL,
    error_code TEXT,
    PRIMARY KEY(org_id, source_id, email_hash),
    FOREIGN KEY(org_id, source_id) REFERENCES directory_sources(org_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS directory_email_resolutions_retry
   ON directory_email_resolutions(org_id, source_id, status, retry_at)`,
  `CREATE TABLE IF NOT EXISTS directory_email_lookup_guards(
    org_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    window_started_at BIGINT NOT NULL,
    attempts INTEGER NOT NULL,
    not_found INTEGER NOT NULL,
    circuit_open_until BIGINT,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY(org_id, source_id),
    FOREIGN KEY(org_id, source_id) REFERENCES directory_sources(org_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS directory_sync_runs(
    org_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    id TEXT NOT NULL,
    source_revision BIGINT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    target_external_subject_id TEXT,
    counts JSONB NOT NULL,
    error_code TEXT,
    error_message TEXT,
    lease_owner TEXT,
    lease_expires_at BIGINT,
    created_at BIGINT NOT NULL,
    started_at BIGINT,
    completed_at BIGINT,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY(org_id, source_id, id),
    UNIQUE(org_id, source_id, idempotency_key),
    FOREIGN KEY(org_id, source_id) REFERENCES directory_sources(org_id, id)
  )`,
  `ALTER TABLE directory_sync_runs ADD COLUMN IF NOT EXISTS source_revision BIGINT NOT NULL DEFAULT 1`,
  `CREATE UNIQUE INDEX IF NOT EXISTS directory_sync_runs_one_running
   ON directory_sync_runs(org_id, source_id) WHERE status = 'running'`,
];

const SOURCE_COLUMNS = `source.org_id, source.id, source.provider, source.name, source.external_tenant_id,
  source.status, source.origin, source.mode, source.login_enabled, source.sync_enabled, source.jit_provisioning_enabled,
  source.schedule_minutes,
  source.match_policy, source.capabilities, source.public_config, source.environment_config_fingerprint,
  source.revision, source.preview_confirmed_revision, source.member_snapshot_revision,
  source.reconciliation_status, source.reconciled_source_revision, source.reconciled_member_snapshot_revision,
  source.reconciled_at, source.reconciliation_expires_at, source.last_test_at, source.last_test_status,
  source.created_at, source.updated_at, source.created_by, source.updated_by,
  secret.secret_enc`;

function sourceFrom(row: Record<string, unknown>): StoredDirectorySource {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    provider: String(row.provider),
    name: String(row.name),
    externalTenantId: String(row.external_tenant_id),
    status: row.status as StoredDirectorySource["status"],
    origin: row.origin as StoredDirectorySource["origin"],
    mode: row.mode === "managed_directory" ? "managed_directory" : "identity_only",
    loginEnabled: row.login_enabled === true,
    syncEnabled: row.sync_enabled === true,
    jitProvisioningEnabled: row.jit_provisioning_enabled === true,
    scheduleMinutes: Number(row.schedule_minutes),
    matchPolicy: row.match_policy as StoredDirectorySource["matchPolicy"],
    capabilities: row.capabilities as DirectoryProviderCapabilities,
    publicConfig: row.public_config as Record<string, string>,
    environmentConfigFingerprint:
      typeof row.environment_config_fingerprint === "string" ? row.environment_config_fingerprint : null,
    hasSecret: typeof row.secret_enc === "string" && row.secret_enc.length > 0,
    secretEnc: typeof row.secret_enc === "string" ? row.secret_enc : null,
    revision: Number(row.revision),
    previewConfirmedRevision: row.preview_confirmed_revision == null ? null : Number(row.preview_confirmed_revision),
    memberSnapshotRevision: typeof row.member_snapshot_revision === "string" ? row.member_snapshot_revision : null,
    reconciliationStatus:
      row.reconciliation_status === "running" ||
      row.reconciliation_status === "ready" ||
      row.reconciliation_status === "blocked" ||
      row.reconciliation_status === "stale"
        ? row.reconciliation_status
        : "not_started",
    reconciledSourceRevision: row.reconciled_source_revision == null ? null : Number(row.reconciled_source_revision),
    reconciledMemberSnapshotRevision:
      typeof row.reconciled_member_snapshot_revision === "string" ? row.reconciled_member_snapshot_revision : null,
    reconciledAt: row.reconciled_at == null ? null : Number(row.reconciled_at),
    reconciliationExpiresAt: row.reconciliation_expires_at == null ? null : Number(row.reconciliation_expires_at),
    lastTestAt: row.last_test_at == null ? null : Number(row.last_test_at),
    lastTestStatus: row.last_test_status as StoredDirectorySource["lastTestStatus"],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    createdBy: String(row.created_by),
    updatedBy: String(row.updated_by),
  };
}

function memberFrom(row: Record<string, unknown>): NormalizedDirectoryMember {
  const data = row.data as Omit<
    NormalizedDirectoryMember,
    | "profileHash"
    | "matchState"
    | "matchReason"
    | "matchedPrincipalId"
    | "ignoredBy"
    | "ignoredReason"
    | "lastLoginAttemptAt"
    | "observedAt"
  >;
  return cloneDirectoryMember({
    ...data,
    profileHash: String(row.profile_hash),
    matchState: row.match_state as NormalizedDirectoryMember["matchState"],
    matchReason: String(row.match_reason),
    matchedPrincipalId: row.matched_principal_id == null ? null : String(row.matched_principal_id),
    ignoredBy: row.ignored_by == null ? null : String(row.ignored_by),
    ignoredReason: row.ignored_reason == null ? null : String(row.ignored_reason),
    lastLoginAttemptAt: row.last_login_attempt_at == null ? null : Number(row.last_login_attempt_at),
    observedAt: Number(row.observed_at),
  });
}

function unitFrom(row: Record<string, unknown>): NormalizedDirectoryUnit {
  const data = row.data as Omit<NormalizedDirectoryUnit, "profileHash" | "status" | "observedAt">;
  return {
    ...data,
    profileHash: String(row.profile_hash),
    status: row.status as NormalizedDirectoryUnit["status"],
    observedAt: Number(row.observed_at),
  };
}

function runFrom(row: Record<string, unknown>): DirectorySyncRun {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    sourceId: String(row.source_id),
    sourceRevision: Number(row.source_revision),
    kind: row.kind as DirectorySyncRun["kind"],
    status: row.status as DirectorySyncRun["status"],
    idempotencyKey: String(row.idempotency_key),
    targetExternalSubjectId: row.target_external_subject_id == null ? null : String(row.target_external_subject_id),
    counts: row.counts as DirectorySyncCounts,
    errorCode: row.error_code == null ? null : String(row.error_code),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    leaseOwner: row.lease_owner == null ? null : String(row.lease_owner),
    leaseExpiresAt: row.lease_expires_at == null ? null : Number(row.lease_expires_at),
    createdAt: Number(row.created_at),
    startedAt: row.started_at == null ? null : Number(row.started_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
    updatedAt: Number(row.updated_at),
  };
}

function emailResolutionFrom(row: Record<string, unknown>): DirectoryEmailResolution {
  return {
    orgId: String(row.org_id),
    sourceId: String(row.source_id),
    emailHash: String(row.email_hash),
    status: row.status as DirectoryEmailResolution["status"],
    externalSubjectId: row.external_subject_id == null ? null : String(row.external_subject_id),
    sourceRevision: Number(row.source_revision),
    memberSnapshotRevision: typeof row.member_snapshot_revision === "string" ? row.member_snapshot_revision : null,
    checkedAt: Number(row.checked_at),
    retryAt: Number(row.retry_at),
    failureCount: Number(row.failure_count),
    errorCode: row.error_code == null ? null : String(row.error_code),
  };
}

function emailLookupGuardFrom(row: Record<string, unknown>): DirectoryEmailLookupGuard {
  return {
    orgId: String(row.org_id),
    sourceId: String(row.source_id),
    windowStartedAt: Number(row.window_started_at),
    attempts: Number(row.attempts),
    notFound: Number(row.not_found),
    circuitOpenUntil: row.circuit_open_until == null ? null : Number(row.circuit_open_until),
    updatedAt: Number(row.updated_at),
  };
}

function unitMappingFrom(row: Record<string, unknown>): DirectoryUnitMapping {
  return {
    orgId: String(row.org_id),
    provider: String(row.provider),
    externalTenantId: String(row.external_tenant_id),
    externalUnitId: String(row.external_unit_id),
    sourceId: String(row.source_id),
    unitId: String(row.unit_id),
    ownership: row.ownership === "manual" ? "manual" : "source",
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function unitMemberOwnershipFrom(row: Record<string, unknown>): DirectoryUnitMemberOwnership {
  return {
    orgId: String(row.org_id),
    sourceId: String(row.source_id),
    unitId: String(row.unit_id),
    principalId: String(row.principal_id),
    primary: row.is_primary === true,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function managedUserOwnershipFrom(row: Record<string, unknown>): DirectoryManagedUserOwnership {
  return {
    orgId: String(row.org_id),
    sourceId: String(row.source_id),
    externalSubjectId: String(row.external_subject_id),
    principalId: String(row.principal_id),
    suspendedBySource: row.suspended_by_source === true,
    suspendedSessionVersion: row.suspended_session_version === null ? null : Number(row.suspended_session_version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function managedPreviewFrom(row: Record<string, unknown>): ManagedDirectoryPreview {
  const data = row.data as Pick<
    ManagedDirectoryPreview,
    | "units"
    | "members"
    | "relations"
    | "preserved"
    | "authorizationImpacts"
    | "conflicts"
    | "organizationRevision"
    | "identityFingerprint"
    | "mappingFingerprint"
    | "memberFingerprint"
    | "generation"
  >;
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    sourceId: String(row.source_id),
    generation: Number(data.generation ?? 0),
    sourceRevision: Number(row.source_revision),
    snapshotRevision: String(row.snapshot_revision),
    organizationRevision: Number(data.organizationRevision ?? -1),
    identityFingerprint: String(data.identityFingerprint ?? ""),
    mappingFingerprint: String(data.mappingFingerprint ?? ""),
    memberFingerprint: String(data.memberFingerprint ?? ""),
    status: row.status as ManagedDirectoryPreview["status"],
    units: (data.units ?? []).map((unit) => ({
      ...unit,
      ownership: unit.ownership === "manual" ? "manual" : "source",
      collisionUnitId: unit.collisionUnitId ?? null,
    })),
    members: data.members,
    relations: data.relations ?? [],
    preserved: data.preserved ?? [],
    authorizationImpacts: data.authorizationImpacts ?? [],
    conflicts: data.conflicts,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    committedAt: row.committed_at == null ? null : Number(row.committed_at),
    actor: String(row.actor),
  };
}

async function writeMember(
  client: PoolClient,
  orgId: string,
  sourceId: string,
  member: NormalizedDirectoryMember,
): Promise<void> {
  const {
    profileHash,
    matchState,
    matchReason,
    matchedPrincipalId,
    ignoredBy,
    ignoredReason,
    lastLoginAttemptAt,
    observedAt,
    ...data
  } = member;
  await client.query(
    `INSERT INTO directory_source_members(
      org_id, source_id, external_subject_id, data, profile_hash, match_state, match_reason,
      matched_principal_id, ignored_by, ignored_reason, last_login_attempt_at, observed_at
    ) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT(org_id, source_id, external_subject_id) DO UPDATE SET
      data=EXCLUDED.data, profile_hash=EXCLUDED.profile_hash, match_state=EXCLUDED.match_state,
      match_reason=EXCLUDED.match_reason, matched_principal_id=EXCLUDED.matched_principal_id,
      ignored_by=EXCLUDED.ignored_by, ignored_reason=EXCLUDED.ignored_reason,
      last_login_attempt_at=EXCLUDED.last_login_attempt_at, observed_at=EXCLUDED.observed_at`,
    [
      orgId,
      sourceId,
      member.externalSubjectId,
      JSON.stringify(data),
      profileHash,
      matchState,
      matchReason,
      matchedPrincipalId,
      ignoredBy,
      ignoredReason,
      lastLoginAttemptAt,
      observedAt,
    ],
  );
}

async function writeUnit(
  client: PoolClient,
  orgId: string,
  sourceId: string,
  unit: NormalizedDirectoryUnit,
): Promise<void> {
  const { profileHash, status, observedAt, ...data } = unit;
  await client.query(
    `INSERT INTO directory_source_units(
      org_id,source_id,external_unit_id,data,profile_hash,status,observed_at
     ) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)
     ON CONFLICT(org_id,source_id,external_unit_id) DO UPDATE SET
      data=EXCLUDED.data,profile_hash=EXCLUDED.profile_hash,status=EXCLUDED.status,observed_at=EXCLUDED.observed_at`,
    [orgId, sourceId, unit.externalUnitId, JSON.stringify(data), profileHash, status, observedAt],
  );
}

async function sourceScope(
  client: PoolClient,
  orgId: string,
  sourceId: string,
): Promise<{
  provider: string;
  externalTenantId: string;
  status: string;
  syncEnabled: boolean;
  revision: number;
  capabilities: StoredDirectorySource["capabilities"];
}> {
  const rows = await client.query(
    `SELECT provider,external_tenant_id,status,sync_enabled,revision,capabilities
     FROM directory_sources WHERE org_id=$1 AND id=$2`,
    [orgId, sourceId],
  );
  const row = rows.rows[0];
  if (!row) throw new Error("directory_sync_source_not_found");
  return {
    provider: String(row.provider),
    externalTenantId: String(row.external_tenant_id),
    status: String(row.status),
    syncEnabled: row.sync_enabled === true,
    revision: Number(row.revision),
    capabilities: row.capabilities as StoredDirectorySource["capabilities"],
  };
}

async function applyRunMutation(
  client: PoolClient,
  run: DirectorySyncRun,
  mutation: DirectoryRunMutation,
): Promise<DirectorySyncCounts> {
  const source = await sourceScope(client, run.orgId, run.sourceId);
  if (mutation.kind === "full") {
    validateMembers(run.orgId, run.sourceId, mutation.members, source);
    const rows = await client.query(
      `SELECT * FROM directory_source_members WHERE org_id=$1 AND source_id=$2 FOR UPDATE`,
      [run.orgId, run.sourceId],
    );
    const result = snapshotResult(
      rows.rows.map((row) => memberFrom(row as Record<string, unknown>)),
      mutation.members,
    );
    validateUnits(run.orgId, run.sourceId, mutation.units ?? [], source);
    const unitRows = await client.query(
      `SELECT * FROM directory_source_units WHERE org_id=$1 AND source_id=$2 FOR UPDATE`,
      [run.orgId, run.sourceId],
    );
    const units = unitSnapshotResult(
      unitRows.rows.map((row) => unitFrom(row as Record<string, unknown>)),
      mutation.units ?? [],
    );
    if (!mutation.preview) {
      const nextSnapshotRevision = combinedSnapshotRevision(result.members, units);
      for (const member of result.members) {
        await writeMember(client, run.orgId, run.sourceId, { ...member, snapshotRevision: nextSnapshotRevision });
      }
      for (const unit of units) await writeUnit(client, run.orgId, run.sourceId, unit);
      await client.query(
        `UPDATE directory_sources SET
          reconciliation_status=CASE WHEN member_snapshot_revision IS NOT DISTINCT FROM $3 THEN reconciliation_status ELSE 'stale' END,
          reconciled_source_revision=CASE WHEN member_snapshot_revision IS NOT DISTINCT FROM $3 THEN reconciled_source_revision ELSE NULL END,
          reconciled_member_snapshot_revision=CASE WHEN member_snapshot_revision IS NOT DISTINCT FROM $3 THEN reconciled_member_snapshot_revision ELSE NULL END,
          reconciled_at=CASE WHEN member_snapshot_revision IS NOT DISTINCT FROM $3 THEN reconciled_at ELSE NULL END,
          reconciliation_expires_at=CASE WHEN member_snapshot_revision IS NOT DISTINCT FROM $3 THEN reconciliation_expires_at ELSE NULL END,
          jit_provisioning_enabled=CASE WHEN member_snapshot_revision IS NOT DISTINCT FROM $3 THEN jit_provisioning_enabled ELSE FALSE END,
          member_snapshot_revision=$3
         WHERE org_id=$1 AND id=$2`,
        [run.orgId, run.sourceId, nextSnapshotRevision],
      );
    }
    return result.counts;
  }
  if (mutation.member) validateMembers(run.orgId, run.sourceId, [mutation.member], source);
  const rows = await client.query(
    `SELECT * FROM directory_source_members
     WHERE org_id=$1 AND source_id=$2 AND external_subject_id=$3 FOR UPDATE`,
    [run.orgId, run.sourceId, mutation.externalSubjectId],
  );
  const previous = rows.rows[0] ? memberFrom(rows.rows[0] as Record<string, unknown>) : null;
  if (mutation.member) {
    const result = snapshotResult(previous ? [previous] : [], [mutation.member]);
    await writeMember(client, run.orgId, run.sourceId, { ...result.members[0]!, snapshotRevision: null });
    await client.query(
      `UPDATE directory_sources SET
        member_snapshot_revision=NULL,reconciliation_status='stale',reconciled_source_revision=NULL,
        reconciled_member_snapshot_revision=NULL,reconciled_at=NULL,reconciliation_expires_at=NULL,
        jit_provisioning_enabled=FALSE
       WHERE org_id=$1 AND id=$2`,
      [run.orgId, run.sourceId],
    );
    return { ...result.counts, inactive: mutation.member.status === "inactive" ? 1 : 0 };
  }
  if (!previous) return { observed: 0, added: 0, changed: 0, inactive: 0, unchanged: 0 };
  await writeMember(client, run.orgId, run.sourceId, {
    ...previous,
    status: "inactive",
    observedAt: run.completedAt ?? run.updatedAt,
    matchState: "inactive",
    matchReason: "target_not_found",
    snapshotRevision: null,
  });
  await client.query(
    `UPDATE directory_sources SET
      member_snapshot_revision=NULL,reconciliation_status='stale',reconciled_source_revision=NULL,
      reconciled_member_snapshot_revision=NULL,reconciled_at=NULL,reconciliation_expires_at=NULL,
      jit_provisioning_enabled=FALSE
     WHERE org_id=$1 AND id=$2`,
    [run.orgId, run.sourceId],
  );
  return { observed: 0, added: 0, changed: 1, inactive: 1, unchanged: 0 };
}

function runParams(run: DirectorySyncRun): unknown[] {
  return [
    run.orgId,
    run.sourceId,
    run.id,
    run.sourceRevision,
    run.kind,
    run.status,
    run.idempotencyKey,
    run.targetExternalSubjectId,
    JSON.stringify(run.counts),
    run.errorCode,
    run.errorMessage,
    run.leaseOwner,
    run.leaseExpiresAt,
    run.createdAt,
    run.startedAt,
    run.completedAt,
    run.updatedAt,
  ];
}

const sourceLockKey = (orgId: string, sourceId: string): string => `qm:directory-source:${orgId}:${sourceId}`;

export function createPostgresDirectorySourceStore(
  connectionString: string,
  options: { exclusiveOrgId?: string; auditLog?: PostgresAuditLog } = {},
): DirectorySourceStore {
  const pg = createPgPool(connectionString, SCHEMA);
  const sourceLocks = createPgPool(connectionString, []);
  const sourceLockContext = new AsyncLocalStorage<Set<string>>();
  const assertOrg = (orgId: string): void => {
    if (options.exclusiveOrgId && orgId !== options.exclusiveOrgId) throw new Error("directory source org mismatch");
  };
  const withSourceAdvisoryLock = async <T>(orgId: string, sourceId: string, fn: () => Promise<T>): Promise<T> => {
    const key = sourceLockKey(orgId, sourceId);
    const held = sourceLockContext.getStore();
    if (held?.has(key)) return fn();
    const client = await (await sourceLocks.pool()).connect();
    let discard = false;
    try {
      await client.query(`SELECT pg_advisory_lock(hashtext($1))`, [key]);
      let outcome: { ok: true; value: T } | { ok: false; error: unknown };
      try {
        outcome = { ok: true, value: await sourceLockContext.run(new Set([...(held ?? []), key]), fn) };
      } catch (error) {
        outcome = { ok: false, error };
      }
      try {
        const released = await client.query<{ released: boolean }>(
          `SELECT pg_advisory_unlock(hashtext($1)) AS released`,
          [key],
        );
        if (released.rows[0]?.released !== true) throw new Error("directory_source_lock_release_failed");
      } catch (error) {
        discard = true;
        throw error;
      }
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    } finally {
      client.release(discard);
    }
  };
  const withSourceTransaction = <T>(
    orgId: string,
    sourceId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> => withSourceAdvisoryLock(orgId, sourceId, async () => withPgTransaction(await pg.pool(), fn));
  const sourceQuery = `SELECT ${SOURCE_COLUMNS} FROM directory_sources source
    LEFT JOIN directory_source_secrets secret
      ON secret.org_id=source.org_id AND secret.source_id=source.id
        AND secret.source_revision=source.revision AND secret.purpose='provider'`;
  return {
    durable: true,
    async withSourceLock(orgId, sourceId, fn) {
      assertOrg(orgId);
      return withSourceAdvisoryLock(orgId, sourceId, fn);
    },
    async listSources(orgId, includeDeleted = false) {
      assertOrg(orgId);
      const rows = await pg.q(
        `${sourceQuery} WHERE source.org_id=$1 ${includeDeleted ? "" : "AND source.status <> 'deleted'"}
         ORDER BY source.name, source.id`,
        [orgId],
      );
      return rows.map(sourceFrom);
    },
    async getSource(orgId, sourceId) {
      assertOrg(orgId);
      const rows = await pg.q(`${sourceQuery} WHERE source.org_id=$1 AND source.id=$2`, [orgId, sourceId]);
      return rows[0] ? sourceFrom(rows[0]) : null;
    },
    async putSource(source, expectedRevision, audit) {
      assertOrg(source.orgId);
      if (audit) {
        if (!options.auditLog) throw new Error("directory_source_audit_unavailable");
        await options.auditLog.pool();
      }
      return withSourceTransaction(source.orgId, source.id, async (client) => {
        const result = await client.query(
          `INSERT INTO directory_sources(
            org_id,id,provider,name,external_tenant_id,status,origin,mode,login_enabled,sync_enabled,
            jit_provisioning_enabled,schedule_minutes,match_policy,capabilities,public_config,
            environment_config_fingerprint,revision,preview_confirmed_revision,member_snapshot_revision,
            reconciliation_status,reconciled_source_revision,reconciled_member_snapshot_revision,
            reconciled_at,reconciliation_expires_at,last_test_at,last_test_status,
            created_at,updated_at,created_by,updated_by
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
          ON CONFLICT(org_id,id) DO UPDATE SET
            provider=EXCLUDED.provider,name=EXCLUDED.name,external_tenant_id=EXCLUDED.external_tenant_id,
            status=EXCLUDED.status,origin=EXCLUDED.origin,mode=EXCLUDED.mode,
            login_enabled=EXCLUDED.login_enabled,sync_enabled=EXCLUDED.sync_enabled,
            jit_provisioning_enabled=EXCLUDED.jit_provisioning_enabled,schedule_minutes=EXCLUDED.schedule_minutes,
            match_policy=EXCLUDED.match_policy,capabilities=EXCLUDED.capabilities,public_config=EXCLUDED.public_config,
            environment_config_fingerprint=EXCLUDED.environment_config_fingerprint,
            revision=EXCLUDED.revision,preview_confirmed_revision=EXCLUDED.preview_confirmed_revision,
            member_snapshot_revision=EXCLUDED.member_snapshot_revision,
            reconciliation_status=EXCLUDED.reconciliation_status,
            reconciled_source_revision=EXCLUDED.reconciled_source_revision,
            reconciled_member_snapshot_revision=EXCLUDED.reconciled_member_snapshot_revision,
            reconciled_at=EXCLUDED.reconciled_at,reconciliation_expires_at=EXCLUDED.reconciliation_expires_at,
            last_test_at=EXCLUDED.last_test_at,last_test_status=EXCLUDED.last_test_status,
            updated_at=EXCLUDED.updated_at,updated_by=EXCLUDED.updated_by
          WHERE directory_sources.revision=$31`,
          [
            source.orgId,
            source.id,
            source.provider,
            source.name,
            source.externalTenantId,
            source.status,
            source.origin,
            source.mode,
            source.loginEnabled,
            source.syncEnabled,
            source.jitProvisioningEnabled,
            source.scheduleMinutes,
            source.matchPolicy,
            JSON.stringify(source.capabilities),
            JSON.stringify(source.publicConfig),
            source.environmentConfigFingerprint,
            source.revision,
            source.previewConfirmedRevision,
            source.memberSnapshotRevision,
            source.reconciliationStatus,
            source.reconciledSourceRevision,
            source.reconciledMemberSnapshotRevision,
            source.reconciledAt,
            source.reconciliationExpiresAt,
            source.lastTestAt,
            source.lastTestStatus,
            source.createdAt,
            source.updatedAt,
            source.createdBy,
            source.updatedBy,
            expectedRevision,
          ],
        );
        if ((result.rowCount ?? 0) === 0) return false;
        if (source.secretEnc) {
          await client.query(
            `INSERT INTO directory_source_secrets(org_id,source_id,source_revision,purpose,secret_enc,version,updated_at)
             VALUES($1,$2,$3,'provider',$4,$5,$6)
             ON CONFLICT(org_id,source_id,purpose) DO UPDATE SET
               source_revision=EXCLUDED.source_revision,secret_enc=EXCLUDED.secret_enc,
               version=EXCLUDED.version,updated_at=EXCLUDED.updated_at`,
            [source.orgId, source.id, source.revision, source.secretEnc, source.revision, source.updatedAt],
          );
        } else {
          await client.query(
            `DELETE FROM directory_source_secrets WHERE org_id=$1 AND source_id=$2 AND purpose='provider'`,
            [source.orgId, source.id],
          );
        }
        if (audit) {
          if (!options.auditLog) throw new Error("directory_source_audit_unavailable");
          await options.auditLog.recordInTransaction(client, audit);
        }
        return true;
      });
    },
    async getMember(orgId, sourceId, externalSubjectId) {
      assertOrg(orgId);
      const rows = await pg.q(
        `SELECT * FROM directory_source_members WHERE org_id=$1 AND source_id=$2 AND external_subject_id=$3`,
        [orgId, sourceId, externalSubjectId],
      );
      return rows[0] ? memberFrom(rows[0]) : null;
    },
    async listMembers(orgId, sourceId, query: DirectoryMemberQuery) {
      assertOrg(orgId);
      if (query.states && query.states.length === 0) return { members: [], next: null };
      const params: unknown[] = [orgId, sourceId];
      const where = ["org_id=$1", "source_id=$2"];
      if (query.states?.length) {
        params.push(query.states);
        where.push(`match_state=ANY($${params.length}::text[])`);
      }
      if (query.query?.trim()) {
        params.push(`%${query.query.trim().toLowerCase()}%`);
        where.push(`lower(data::text) LIKE $${params.length}`);
      }
      if (query.after) {
        params.push(query.after.externalSubjectId);
        where.push(`external_subject_id > $${params.length}`);
      }
      params.push(query.limit + 1);
      const rows = await pg.q(
        `SELECT * FROM directory_source_members WHERE ${where.join(" AND ")}
         ORDER BY external_subject_id LIMIT $${params.length}`,
        params,
      );
      const hasNext = rows.length > query.limit;
      const page = rows.slice(0, query.limit).map(memberFrom);
      return {
        members: page,
        next: hasNext && page.length ? { externalSubjectId: page[page.length - 1]!.externalSubjectId } : null,
      };
    },
    async listUnits(orgId, sourceId) {
      assertOrg(orgId);
      return (
        await pg.q(`SELECT * FROM directory_source_units WHERE org_id=$1 AND source_id=$2 ORDER BY external_unit_id`, [
          orgId,
          sourceId,
        ])
      ).map(unitFrom);
    },
    async listUnitMappings(orgId, sourceId) {
      assertOrg(orgId);
      return (
        await pg.q(`SELECT * FROM directory_unit_mappings WHERE org_id=$1 AND source_id=$2 ORDER BY external_unit_id`, [
          orgId,
          sourceId,
        ])
      ).map(unitMappingFrom);
    },
    async putUnitMapping(mapping, audit) {
      assertOrg(mapping.orgId);
      if (audit) {
        if (!options.auditLog) throw new Error("directory_source_audit_unavailable");
        await options.auditLog.pool();
      }
      await withPgTransaction(await pg.pool(), async (client) => {
        await client.query(
          `INSERT INTO directory_unit_mappings(
            org_id,provider,external_tenant_id,external_unit_id,source_id,unit_id,ownership,created_at,updated_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT(org_id,provider,external_tenant_id,external_unit_id) DO UPDATE SET
            source_id=EXCLUDED.source_id,unit_id=EXCLUDED.unit_id,ownership=EXCLUDED.ownership,updated_at=EXCLUDED.updated_at`,
          [
            mapping.orgId,
            mapping.provider,
            mapping.externalTenantId,
            mapping.externalUnitId,
            mapping.sourceId,
            mapping.unitId,
            mapping.ownership,
            mapping.createdAt,
            mapping.updatedAt,
          ],
        );
        if (audit) await options.auditLog!.recordInTransaction(client, audit);
      });
    },
    async listUnitMemberOwnership(orgId, sourceId) {
      assertOrg(orgId);
      return (
        await pg.q(
          `SELECT * FROM directory_unit_member_ownership WHERE org_id=$1 AND source_id=$2 ORDER BY unit_id,principal_id`,
          [orgId, sourceId],
        )
      ).map(unitMemberOwnershipFrom);
    },
    async putUnitMemberOwnership(ownership) {
      assertOrg(ownership.orgId);
      await pg.q(
        `INSERT INTO directory_unit_member_ownership(
          org_id,source_id,unit_id,principal_id,is_primary,created_at,updated_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(org_id,source_id,unit_id,principal_id) DO UPDATE SET
          is_primary=EXCLUDED.is_primary,updated_at=EXCLUDED.updated_at`,
        [
          ownership.orgId,
          ownership.sourceId,
          ownership.unitId,
          ownership.principalId,
          ownership.primary,
          ownership.createdAt,
          ownership.updatedAt,
        ],
      );
    },
    async deleteUnitMemberOwnership(orgId, sourceId, unitId, principalId) {
      assertOrg(orgId);
      await pg.q(
        `DELETE FROM directory_unit_member_ownership
         WHERE org_id=$1 AND source_id=$2 AND unit_id=$3 AND principal_id=$4`,
        [orgId, sourceId, unitId, principalId],
      );
    },
    async listManagedUserOwnership(orgId, sourceId) {
      assertOrg(orgId);
      return (
        await pg.q(
          `SELECT * FROM directory_managed_user_ownership WHERE org_id=$1 AND source_id=$2 ORDER BY external_subject_id`,
          [orgId, sourceId],
        )
      ).map(managedUserOwnershipFrom);
    },
    async putManagedUserOwnership(ownership) {
      assertOrg(ownership.orgId);
      await pg.q(
        `INSERT INTO directory_managed_user_ownership(
          org_id,source_id,external_subject_id,principal_id,suspended_by_source,suspended_session_version,created_at,updated_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(org_id,source_id,external_subject_id) DO UPDATE SET
          principal_id=EXCLUDED.principal_id,suspended_by_source=EXCLUDED.suspended_by_source,
          suspended_session_version=EXCLUDED.suspended_session_version,
          updated_at=EXCLUDED.updated_at`,
        [
          ownership.orgId,
          ownership.sourceId,
          ownership.externalSubjectId,
          ownership.principalId,
          ownership.suspendedBySource,
          ownership.suspendedSessionVersion,
          ownership.createdAt,
          ownership.updatedAt,
        ],
      );
    },
    async getManagedPreview(orgId, sourceId, previewId) {
      assertOrg(orgId);
      const rows = await pg.q(`SELECT * FROM directory_managed_previews WHERE org_id=$1 AND source_id=$2 AND id=$3`, [
        orgId,
        sourceId,
        previewId,
      ]);
      return rows[0] ? managedPreviewFrom(rows[0]) : null;
    },
    async listManagedPreviews(orgId, status) {
      assertOrg(orgId);
      return (
        await pg.q(`SELECT * FROM directory_managed_previews WHERE org_id=$1 AND status=$2 ORDER BY created_at,id`, [
          orgId,
          status,
        ])
      ).map(managedPreviewFrom);
    },
    async putManagedPreview(preview) {
      assertOrg(preview.orgId);
      await pg.q(
        `INSERT INTO directory_managed_previews(
          org_id,source_id,id,source_revision,snapshot_revision,status,data,created_at,expires_at,committed_at,actor
         ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)
         ON CONFLICT(org_id,source_id,id) DO UPDATE SET
          status=EXCLUDED.status,data=EXCLUDED.data,expires_at=EXCLUDED.expires_at,
          committed_at=EXCLUDED.committed_at,actor=EXCLUDED.actor`,
        [
          preview.orgId,
          preview.sourceId,
          preview.id,
          preview.sourceRevision,
          preview.snapshotRevision,
          preview.status,
          JSON.stringify({
            units: preview.units,
            members: preview.members,
            relations: preview.relations,
            preserved: preview.preserved,
            authorizationImpacts: preview.authorizationImpacts,
            conflicts: preview.conflicts,
            organizationRevision: preview.organizationRevision,
            identityFingerprint: preview.identityFingerprint,
            mappingFingerprint: preview.mappingFingerprint,
            memberFingerprint: preview.memberFingerprint,
            generation: preview.generation,
          }),
          preview.createdAt,
          preview.expiresAt,
          preview.committedAt,
          preview.actor,
        ],
      );
    },
    async replaceMembers(orgId, sourceId, incoming, preview) {
      assertOrg(orgId);
      return withSourceTransaction(orgId, sourceId, async (client) => {
        const source = await sourceScope(client, orgId, sourceId);
        validateMembers(orgId, sourceId, incoming, source);
        const rows = await client.query(
          `SELECT * FROM directory_source_members WHERE org_id=$1 AND source_id=$2 FOR UPDATE`,
          [orgId, sourceId],
        );
        const result = snapshotResult(
          rows.rows.map((row) => memberFrom(row as Record<string, unknown>)),
          incoming,
        );
        if (!preview) {
          const unitRows = await client.query(
            `SELECT * FROM directory_source_units WHERE org_id=$1 AND source_id=$2 FOR UPDATE`,
            [orgId, sourceId],
          );
          const nextSnapshotRevision = combinedSnapshotRevision(
            result.members,
            unitRows.rows.map((row) => unitFrom(row as Record<string, unknown>)),
          );
          for (const member of result.members) {
            await writeMember(client, orgId, sourceId, { ...member, snapshotRevision: nextSnapshotRevision });
          }
          await client.query(
            `UPDATE directory_sources SET
              reconciliation_status=CASE WHEN member_snapshot_revision IS NOT DISTINCT FROM $3 THEN reconciliation_status ELSE 'stale' END,
              reconciled_source_revision=CASE WHEN member_snapshot_revision IS NOT DISTINCT FROM $3 THEN reconciled_source_revision ELSE NULL END,
              reconciled_member_snapshot_revision=CASE WHEN member_snapshot_revision IS NOT DISTINCT FROM $3 THEN reconciled_member_snapshot_revision ELSE NULL END,
              reconciled_at=CASE WHEN member_snapshot_revision IS NOT DISTINCT FROM $3 THEN reconciled_at ELSE NULL END,
              reconciliation_expires_at=CASE WHEN member_snapshot_revision IS NOT DISTINCT FROM $3 THEN reconciliation_expires_at ELSE NULL END,
              jit_provisioning_enabled=CASE WHEN member_snapshot_revision IS NOT DISTINCT FROM $3 THEN jit_provisioning_enabled ELSE FALSE END,
              member_snapshot_revision=$3
             WHERE org_id=$1 AND id=$2`,
            [orgId, sourceId, nextSnapshotRevision],
          );
        }
        return result.counts;
      });
    },
    async upsertMember(member) {
      assertOrg(member.orgId);
      await withSourceTransaction(member.orgId, member.sourceId, async (client) => {
        const source = await sourceScope(client, member.orgId, member.sourceId);
        validateMembers(member.orgId, member.sourceId, [member], source);
        const rows = await client.query(
          `SELECT * FROM directory_source_members
           WHERE org_id=$1 AND source_id=$2 AND external_subject_id=$3 FOR UPDATE`,
          [member.orgId, member.sourceId, member.externalSubjectId],
        );
        const previous = rows.rows[0] ? memberFrom(rows.rows[0] as Record<string, unknown>) : null;
        const result = snapshotResult(previous ? [previous] : [], [member]);
        await writeMember(client, member.orgId, member.sourceId, result.members[0]!);
      });
    },
    async updateMemberMatch(orgId, sourceId, externalSubjectId, update, audit, expectedProfileHash) {
      assertOrg(orgId);
      if (audit) {
        if (!options.auditLog) throw new Error("directory_source_audit_unavailable");
        await options.auditLog.pool();
      }
      return withSourceTransaction(orgId, sourceId, async (client) => {
        const rows = await client.query(
          `UPDATE directory_source_members SET
            match_state=$4,match_reason=$5,matched_principal_id=$6,ignored_by=$7,ignored_reason=$8,last_login_attempt_at=$9
           WHERE org_id=$1 AND source_id=$2 AND external_subject_id=$3
             AND ($10::text IS NULL OR profile_hash=$10) RETURNING *`,
          [
            orgId,
            sourceId,
            externalSubjectId,
            update.matchState,
            update.matchReason,
            update.matchedPrincipalId,
            update.ignoredBy,
            update.ignoredReason,
            update.lastLoginAttemptAt,
            expectedProfileHash ?? null,
          ],
        );
        if (!rows.rows[0]) return null;
        if (audit) {
          if (!options.auditLog) throw new Error("directory_source_audit_unavailable");
          await options.auditLog.recordInTransaction(client, audit);
        }
        return memberFrom(rows.rows[0] as Record<string, unknown>);
      });
    },
    async getEmailResolution(orgId, sourceId, emailHash) {
      assertOrg(orgId);
      const rows = await pg.q(
        `SELECT * FROM directory_email_resolutions WHERE org_id=$1 AND source_id=$2 AND email_hash=$3`,
        [orgId, sourceId, emailHash],
      );
      return rows[0] ? emailResolutionFrom(rows[0]) : null;
    },
    async listEmailResolutions(orgId, sourceId) {
      assertOrg(orgId);
      return (
        await pg.q(`SELECT * FROM directory_email_resolutions WHERE org_id=$1 AND source_id=$2 ORDER BY email_hash`, [
          orgId,
          sourceId,
        ])
      ).map(emailResolutionFrom);
    },
    async putEmailResolution(resolution) {
      assertOrg(resolution.orgId);
      await pg.q(
        `INSERT INTO directory_email_resolutions(
            org_id,source_id,email_hash,status,external_subject_id,source_revision,member_snapshot_revision,
            checked_at,retry_at,failure_count,error_code
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT(org_id,source_id,email_hash) DO UPDATE SET
            status=EXCLUDED.status,external_subject_id=EXCLUDED.external_subject_id,
            source_revision=EXCLUDED.source_revision,member_snapshot_revision=EXCLUDED.member_snapshot_revision,
            checked_at=EXCLUDED.checked_at,retry_at=EXCLUDED.retry_at,
            failure_count=EXCLUDED.failure_count,error_code=EXCLUDED.error_code`,
        [
          resolution.orgId,
          resolution.sourceId,
          resolution.emailHash,
          resolution.status,
          resolution.externalSubjectId,
          resolution.sourceRevision,
          resolution.memberSnapshotRevision,
          resolution.checkedAt,
          resolution.retryAt,
          resolution.failureCount,
          resolution.errorCode,
        ],
      );
    },
    async getEmailLookupGuard(orgId, sourceId) {
      assertOrg(orgId);
      const rows = await pg.q(`SELECT * FROM directory_email_lookup_guards WHERE org_id=$1 AND source_id=$2`, [
        orgId,
        sourceId,
      ]);
      return rows[0] ? emailLookupGuardFrom(rows[0]) : null;
    },
    async putEmailLookupGuard(guard) {
      assertOrg(guard.orgId);
      await pg.q(
        `INSERT INTO directory_email_lookup_guards(
            org_id,source_id,window_started_at,attempts,not_found,circuit_open_until,updated_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT(org_id,source_id) DO UPDATE SET
            window_started_at=EXCLUDED.window_started_at,attempts=EXCLUDED.attempts,
            not_found=EXCLUDED.not_found,circuit_open_until=EXCLUDED.circuit_open_until,
            updated_at=EXCLUDED.updated_at`,
        [
          guard.orgId,
          guard.sourceId,
          guard.windowStartedAt,
          guard.attempts,
          guard.notFound,
          guard.circuitOpenUntil,
          guard.updatedAt,
        ],
      );
    },
    async createRun(run) {
      assertOrg(run.orgId);
      try {
        const rows = await pg.q(
          `INSERT INTO directory_sync_runs(
            org_id,source_id,id,source_revision,kind,status,idempotency_key,target_external_subject_id,counts,error_code,error_message,
            lease_owner,lease_expires_at,created_at,started_at,completed_at,updated_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT(org_id,source_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
           RETURNING *`,
          runParams(run),
        );
        return runFrom(rows[0]!);
      } catch (error) {
        const running = await this.findRunningRun(run.orgId, run.sourceId);
        if (running) return running;
        throw error;
      }
    },
    async getRun(orgId, sourceId, runId) {
      assertOrg(orgId);
      const rows = await pg.q(`SELECT * FROM directory_sync_runs WHERE org_id=$1 AND source_id=$2 AND id=$3`, [
        orgId,
        sourceId,
        runId,
      ]);
      return rows[0] ? runFrom(rows[0]) : null;
    },
    async listRuns(orgId, sourceId, limit = 50) {
      assertOrg(orgId);
      const rows = await pg.q(
        `SELECT * FROM directory_sync_runs WHERE org_id=$1 AND source_id=$2 ORDER BY created_at DESC LIMIT $3`,
        [orgId, sourceId, limit],
      );
      return rows.map(runFrom);
    },
    async claimRun(orgId, sourceId, runId, owner, at, leaseExpiresAt) {
      assertOrg(orgId);
      const rows = await pg.q(
        `UPDATE directory_sync_runs SET
          lease_owner=$4,lease_expires_at=$6,started_at=COALESCE(started_at,$5),updated_at=$5
         WHERE org_id=$1 AND source_id=$2 AND id=$3 AND status='running'
           AND (lease_owner IS NULL OR lease_owner=$4 OR COALESCE(lease_expires_at,0)<=$5)
         RETURNING *`,
        [orgId, sourceId, runId, owner, at, leaseExpiresAt],
      );
      return rows[0] ? runFrom(rows[0]) : null;
    },
    async renewRun(orgId, sourceId, runId, owner, at, leaseExpiresAt) {
      assertOrg(orgId);
      const rows = await pg.q(
        `UPDATE directory_sync_runs SET lease_expires_at=$6,updated_at=$5
         WHERE org_id=$1 AND source_id=$2 AND id=$3 AND status='running' AND lease_owner=$4 RETURNING id`,
        [orgId, sourceId, runId, owner, at, leaseExpiresAt],
      );
      return rows.length === 1;
    },
    async finishRun(run, expectedOwner, mutation) {
      assertOrg(run.orgId);
      return withSourceTransaction(run.orgId, run.sourceId, async (client) => {
        const claimed = await client.query(
          `SELECT * FROM directory_sync_runs
           WHERE org_id=$1 AND source_id=$2 AND id=$3 AND status='running' AND lease_owner=$4 FOR UPDATE`,
          [run.orgId, run.sourceId, run.id, expectedOwner],
        );
        if (!claimed.rows[0]) return null;
        const source = await sourceScope(client, run.orgId, run.sourceId);
        const sourceChanged =
          source.status !== "active" ||
          source.revision !== run.sourceRevision ||
          (mutation?.kind === "full" && !mutation.preview && !source.syncEnabled);
        const finalized = sourceChanged
          ? {
              ...run,
              status: "failed" as const,
              errorCode: "directory_sync_source_changed",
              errorMessage: "directory_sync_source_changed",
            }
          : run;
        const counts = mutation && !sourceChanged ? await applyRunMutation(client, run, mutation) : run.counts;
        const completed = { ...finalized, counts, leaseOwner: null, leaseExpiresAt: null };
        const rows = await client.query(
          `UPDATE directory_sync_runs SET
            source_revision=$4,kind=$5,status=$6,idempotency_key=$7,target_external_subject_id=$8,
            counts=$9::jsonb,error_code=$10,error_message=$11,lease_owner=$12,lease_expires_at=$13,
            created_at=$14,started_at=$15,completed_at=$16,updated_at=$17
           WHERE org_id=$1 AND source_id=$2 AND id=$3 AND status='running' AND lease_owner=$18 RETURNING *`,
          [...runParams(completed), expectedOwner],
        );
        return rows.rows[0] ? runFrom(rows.rows[0] as Record<string, unknown>) : null;
      });
    },
    async findRunningRun(orgId, sourceId) {
      assertOrg(orgId);
      const rows = await pg.q(
        `SELECT * FROM directory_sync_runs WHERE org_id=$1 AND source_id=$2 AND status='running' LIMIT 1`,
        [orgId, sourceId],
      );
      return rows[0] ? runFrom(rows[0]) : null;
    },
    async latestSucceededAt(orgId, sourceId) {
      assertOrg(orgId);
      const rows = await pg.q(
        `SELECT max(completed_at) AS completed_at FROM directory_sync_runs
         WHERE org_id=$1 AND source_id=$2 AND status='succeeded'`,
        [orgId, sourceId],
      );
      return rows[0]?.completed_at == null ? null : Number(rows[0].completed_at);
    },
    async close() {
      await Promise.all([pg.close(), sourceLocks.close()]);
    },
  };
}
