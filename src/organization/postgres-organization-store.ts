import { createPgPool, type Pool, type PoolClient, withPgTransaction } from "../persistence/pg-pool.ts";
import { sleep } from "../util/async.ts";
import type { PostgresAuditLog } from "../admin/postgres-audit-log.ts";
import type {
  AccessGroup,
  AccessGroupMember,
  AuthIdentity,
  DirectorySubjectKind,
  DirectoryUserCursor,
  DirectoryUserPage,
  DirectoryViewMode,
  DirectoryViewPolicy,
  DirectoryViewRoot,
  OrganizationStore,
  OrganizationTx,
  OrganizationUser,
  OrganizationUserStatus,
  OrgMemberRole,
  OrgUnit,
  OrgUnitMember,
  SkillAccessGrant,
  SkillAccessMode,
  SkillAccessPolicy,
  SubtreeImpact,
  UnitImpact,
} from "./organization-store.ts";
import { jsonbStringify } from "../persistence/durable-map.ts";
import type { Skill } from "../skills/skill-store.ts";
import type { Permission, ScopeId } from "../types.ts";

type Rows = Record<string, unknown>[];
type Exec = (text: string, params?: unknown[]) => Promise<{ rows: Rows; rowCount: number }>;

function clientExec(client: PoolClient): Exec {
  return async (text, params) => {
    const res = await client.query(text, params);
    return { rows: res.rows as Rows, rowCount: res.rowCount ?? 0 };
  };
}

function rowToUser(r: Record<string, unknown>): OrganizationUser {
  return {
    orgId: r.org_id as string,
    principalId: r.principal_id as string,
    email: (r.email as string | null) ?? null,
    displayName: r.display_name as string,
    jobTitle: (r.job_title as string | null) ?? null,
    mobile: (r.mobile as string | null) ?? null,
    employeeNumber: (r.employee_number as string | null) ?? null,
    status: r.status as OrganizationUserStatus,
    sessionVersion: Number(r.session_version),
    profileRevision: Number(r.profile_revision),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    lastLoginAt: r.last_login_at == null ? null : Number(r.last_login_at),
    createdBy: r.created_by as string,
    updatedBy: r.updated_by as string,
  };
}

function rowToIdentity(r: Record<string, unknown>): AuthIdentity {
  const identity: AuthIdentity = {
    orgId: r.org_id as string,
    issuer: r.issuer as string,
    subject: r.subject as string,
    principalId: r.principal_id as string,
    emailAtLink: (r.email_at_link as string | null) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
  if (r.source_id == null) return identity;
  return {
    ...identity,
    sourceId: r.source_id as string,
    provider: (r.provider as string | null) ?? null,
    externalTenantId: (r.external_tenant_id as string | null) ?? null,
    externalSubjectId: (r.external_subject_id as string | null) ?? null,
    matchedBy: (r.matched_by as string | null) ?? null,
    evidence: (r.evidence_json as Record<string, string> | null) ?? null,
  };
}

function rowToUnit(r: Record<string, unknown>): OrgUnit {
  return {
    orgId: r.org_id as string,
    id: r.id as string,
    parentId: (r.parent_id as string | null) ?? null,
    name: r.name as string,
    kind: r.kind as OrgUnit["kind"],
    status: r.status as OrgUnit["status"],
    sortOrder: Number(r.sort_order),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    createdBy: r.created_by as string,
    updatedBy: r.updated_by as string,
  };
}

function rowToUnitMember(r: Record<string, unknown>): OrgUnitMember {
  return {
    orgId: r.org_id as string,
    unitId: r.unit_id as string,
    principalId: r.principal_id as string,
    role: r.role as OrgMemberRole,
    isPrimary: r.is_primary === true,
    createdAt: Number(r.created_at),
    createdBy: r.created_by as string,
  };
}

function rowToGroup(r: Record<string, unknown>): AccessGroup {
  return {
    orgId: r.org_id as string,
    id: r.id as string,
    name: r.name as string,
    status: r.status as AccessGroup["status"],
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    createdBy: r.created_by as string,
    updatedBy: r.updated_by as string,
  };
}

function rowToGroupMember(r: Record<string, unknown>): AccessGroupMember {
  return {
    orgId: r.org_id as string,
    groupId: r.group_id as string,
    principalId: r.principal_id as string,
    role: r.role as OrgMemberRole,
    createdAt: Number(r.created_at),
    createdBy: r.created_by as string,
  };
}

function rowToDirectoryPolicy(r: Record<string, unknown>): DirectoryViewPolicy {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    subjectKind: r.subject_kind as DirectorySubjectKind,
    subjectId: r.subject_id as string,
    mode: r.mode as DirectoryViewMode,
    revision: Number(r.revision),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    updatedBy: r.updated_by as string,
  };
}

function rowToDirectoryRoot(r: Record<string, unknown>): DirectoryViewRoot {
  return {
    orgId: r.org_id as string,
    policyId: r.policy_id as string,
    unitId: r.unit_id as string,
    includeDescendants: r.include_descendants === true,
  };
}

function rowToSkillAccessPolicy(r: Record<string, unknown>): SkillAccessPolicy {
  return {
    orgId: r.org_id as string,
    skillId: r.skill_id as string,
    ownerScopeId: r.owner_scope_id as ScopeId,
    mode: r.mode as SkillAccessMode,
    revision: Number(r.revision),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    updatedBy: r.updated_by as string,
  };
}

function rowToSkillAccessGrant(r: Record<string, unknown>): SkillAccessGrant {
  return {
    orgId: r.org_id as string,
    ownerScopeId: r.owner_scope_id as ScopeId,
    path: r.path as string,
    granteeScopeId: r.grantee_scope_id as ScopeId,
    permission: r.permission as Permission,
    grantedBy: r.granted_by as string,
    grantedAt: Number(r.granted_at),
  };
}

const USER_COLUMNS =
  "org_id, principal_id, email, display_name, job_title, mobile, employee_number, status, session_version, profile_revision, created_at, updated_at, last_login_at, created_by, updated_by";

const IDENTITY_COLUMNS =
  "org_id, issuer, subject, principal_id, email_at_link, source_id, provider, external_tenant_id, external_subject_id, matched_by, evidence_json, created_at, updated_at";

const UNIT_COLUMNS =
  "org_id, id, parent_id, name, kind, status, sort_order, created_at, updated_at, created_by, updated_by";

const UNIT_MEMBER_COLUMNS = "org_id, unit_id, principal_id, role, is_primary, created_at, created_by";

const GROUP_COLUMNS = "org_id, id, name, status, created_at, updated_at, created_by, updated_by";

const GROUP_MEMBER_COLUMNS = "org_id, group_id, principal_id, role, created_at, created_by";

const DIRECTORY_POLICY_COLUMNS =
  "id, org_id, subject_kind, subject_id, mode, revision, created_at, updated_at, updated_by";

const DIRECTORY_ROOT_COLUMNS = "org_id, policy_id, unit_id, include_descendants";

const SKILL_ACCESS_POLICY_COLUMNS =
  "org_id, skill_id, owner_scope_id, mode, revision, created_at, updated_at, updated_by";

const SKILL_ACCESS_GRANT_COLUMNS = "org_id, owner_scope_id, path, grantee_scope_id, permission, granted_by, granted_at";

const CLOSURE_DELETE_SQL = `DELETE FROM org_unit_closure
 WHERE org_id = $1
   AND descendant_id IN (SELECT descendant_id FROM org_unit_closure WHERE org_id = $1 AND ancestor_id = $2)
   AND ancestor_id NOT IN (SELECT descendant_id FROM org_unit_closure WHERE org_id = $1 AND ancestor_id = $2)`;

const CLOSURE_INSERT_SQL = `INSERT INTO org_unit_closure (org_id, ancestor_id, descendant_id, depth)
SELECT $1, up.ancestor_id, sub.descendant_id, up.depth + sub.depth + 1
  FROM org_unit_closure up
  JOIN org_unit_closure sub ON sub.org_id = $1
 WHERE up.org_id = $1 AND up.descendant_id = $3 AND sub.ancestor_id = $2`;

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS organization_users(
    org_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    email TEXT,
    display_name TEXT NOT NULL,
    job_title TEXT,
    mobile TEXT,
    employee_number TEXT,
    status TEXT NOT NULL,
    session_version BIGINT NOT NULL,
    profile_revision BIGINT NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    last_login_at BIGINT,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    PRIMARY KEY (org_id, principal_id)
  )`,
  `ALTER TABLE organization_users ADD COLUMN IF NOT EXISTS job_title TEXT`,
  `ALTER TABLE organization_users ADD COLUMN IF NOT EXISTS mobile TEXT`,
  `ALTER TABLE organization_users ADD COLUMN IF NOT EXISTS employee_number TEXT`,
  `ALTER TABLE organization_users ADD COLUMN IF NOT EXISTS profile_revision BIGINT NOT NULL DEFAULT 1`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS organization_users_principal_ci ON organization_users(org_id, lower(principal_id)) WHERE position('@' IN principal_id) > 0`,
  `CREATE UNIQUE INDEX IF NOT EXISTS organization_users_email ON organization_users(org_id, lower(email)) WHERE email IS NOT NULL`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS organization_users_employee_number_ci ON organization_users(org_id, lower(employee_number)) WHERE employee_number IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS organization_users_status ON organization_users(org_id, status)`,
  `CREATE TABLE IF NOT EXISTS organization_identity_status(
    id TEXT PRIMARY KEY,
    json JSONB NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS deactivated_principals(
    id TEXT PRIMARY KEY,
    json JSONB NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS durable_map_versions(
    tbl TEXT PRIMARY KEY,
    v BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS organization_schema_migrations(
    id TEXT PRIMARY KEY,
    applied_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS organization_legacy_runtime_eligible(
    person_key TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    captured_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS organization_operation_results(
    org_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    result JSONB NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY(org_id, idempotency_key)
  )`,
  `CREATE TABLE IF NOT EXISTS organization_database_owner(
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
    org_id TEXT NOT NULL UNIQUE
  )`,
  `CREATE TABLE IF NOT EXISTS auth_identities(
    org_id TEXT NOT NULL,
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    email_at_link TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (org_id, issuer, subject)
  )`,
  `ALTER TABLE auth_identities ADD COLUMN IF NOT EXISTS source_id TEXT`,
  `ALTER TABLE auth_identities ADD COLUMN IF NOT EXISTS provider TEXT`,
  `ALTER TABLE auth_identities ADD COLUMN IF NOT EXISTS external_tenant_id TEXT`,
  `ALTER TABLE auth_identities ADD COLUMN IF NOT EXISTS external_subject_id TEXT`,
  `ALTER TABLE auth_identities ADD COLUMN IF NOT EXISTS matched_by TEXT`,
  `ALTER TABLE auth_identities ADD COLUMN IF NOT EXISTS evidence_json JSONB`,
  `CREATE INDEX IF NOT EXISTS auth_identities_principal ON auth_identities(org_id, principal_id)`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS auth_identities_source_subject
   ON auth_identities(org_id, source_id, external_subject_id) WHERE source_id IS NOT NULL`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS auth_identities_source_principal
   ON auth_identities(org_id, source_id, principal_id) WHERE source_id IS NOT NULL`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS auth_identities_external_subject
   ON auth_identities(org_id, provider, external_tenant_id, external_subject_id)
   WHERE provider IS NOT NULL AND external_tenant_id IS NOT NULL AND external_subject_id IS NOT NULL`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auth_identities_user_fk') THEN
       ALTER TABLE auth_identities ADD CONSTRAINT auth_identities_user_fk
       FOREIGN KEY (org_id, principal_id) REFERENCES organization_users(org_id, principal_id);
     END IF;
   END $$`,
  `CREATE TABLE IF NOT EXISTS org_units(
    org_id TEXT NOT NULL,
    id TEXT NOT NULL,
    parent_id TEXT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    PRIMARY KEY (org_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS org_units_children ON org_units(org_id, parent_id, status, sort_order)`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS org_units_one_active_root ON org_units(org_id) WHERE parent_id IS NULL AND status = 'active'`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_units_parent_fk') THEN
       ALTER TABLE org_units ADD CONSTRAINT org_units_parent_fk
       FOREIGN KEY (org_id, parent_id) REFERENCES org_units(org_id, id);
     END IF;
   END $$`,
  `CREATE TABLE IF NOT EXISTS org_unit_closure(
    org_id TEXT NOT NULL,
    ancestor_id TEXT NOT NULL,
    descendant_id TEXT NOT NULL,
    depth INTEGER NOT NULL,
    PRIMARY KEY (org_id, ancestor_id, descendant_id)
  )`,
  `CREATE INDEX IF NOT EXISTS org_unit_closure_by_descendant ON org_unit_closure(org_id, descendant_id, ancestor_id)`,
  `CREATE INDEX IF NOT EXISTS org_unit_closure_by_ancestor_depth ON org_unit_closure(org_id, ancestor_id, depth, descendant_id)`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_unit_closure_ancestor_fk') THEN
       ALTER TABLE org_unit_closure ADD CONSTRAINT org_unit_closure_ancestor_fk
       FOREIGN KEY (org_id, ancestor_id) REFERENCES org_units(org_id, id);
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_unit_closure_descendant_fk') THEN
       ALTER TABLE org_unit_closure ADD CONSTRAINT org_unit_closure_descendant_fk
       FOREIGN KEY (org_id, descendant_id) REFERENCES org_units(org_id, id);
     END IF;
   END $$`,
  `CREATE TABLE IF NOT EXISTS org_unit_members(
    org_id TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    role TEXT NOT NULL,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    created_at BIGINT NOT NULL,
    created_by TEXT NOT NULL,
    PRIMARY KEY (org_id, unit_id, principal_id)
  )`,
  `ALTER TABLE org_unit_members ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE`,
  `CREATE INDEX IF NOT EXISTS org_unit_members_by_principal ON org_unit_members(org_id, principal_id)`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS org_unit_members_one_primary ON org_unit_members(org_id, principal_id) WHERE is_primary`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_unit_members_unit_fk') THEN
       ALTER TABLE org_unit_members ADD CONSTRAINT org_unit_members_unit_fk
       FOREIGN KEY (org_id, unit_id) REFERENCES org_units(org_id, id);
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_unit_members_user_fk') THEN
       ALTER TABLE org_unit_members ADD CONSTRAINT org_unit_members_user_fk
       FOREIGN KEY (org_id, principal_id) REFERENCES organization_users(org_id, principal_id);
     END IF;
   END $$`,
  `CREATE TABLE IF NOT EXISTS access_groups(
    org_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    PRIMARY KEY (org_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS access_group_members(
    org_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    created_by TEXT NOT NULL,
    PRIMARY KEY (org_id, group_id, principal_id)
  )`,
  `CREATE INDEX IF NOT EXISTS access_group_members_by_principal ON access_group_members(org_id, principal_id)`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'access_group_members_group_fk') THEN
       ALTER TABLE access_group_members ADD CONSTRAINT access_group_members_group_fk
       FOREIGN KEY (org_id, group_id) REFERENCES access_groups(org_id, id);
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'access_group_members_user_fk') THEN
       ALTER TABLE access_group_members ADD CONSTRAINT access_group_members_user_fk
       FOREIGN KEY (org_id, principal_id) REFERENCES organization_users(org_id, principal_id);
     END IF;
   END $$`,
  `CREATE TABLE IF NOT EXISTS directory_view_policies(
    id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    subject_kind TEXT NOT NULL CHECK(subject_kind IN ('user', 'org_unit', 'access_group')),
    subject_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('all', 'limited', 'none')),
    revision BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    updated_by TEXT NOT NULL,
    PRIMARY KEY (org_id, id),
    UNIQUE (org_id, subject_kind, subject_id)
  )`,
  `CREATE TABLE IF NOT EXISTS directory_view_roots(
    org_id TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    include_descendants BOOLEAN NOT NULL,
    PRIMARY KEY (org_id, policy_id, unit_id)
  )`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'directory_view_roots_policy_fk') THEN
       ALTER TABLE directory_view_roots ADD CONSTRAINT directory_view_roots_policy_fk
       FOREIGN KEY (org_id, policy_id) REFERENCES directory_view_policies(org_id, id) ON DELETE CASCADE;
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'directory_view_roots_unit_fk') THEN
       ALTER TABLE directory_view_roots ADD CONSTRAINT directory_view_roots_unit_fk
       FOREIGN KEY (org_id, unit_id) REFERENCES org_units(org_id, id);
     END IF;
   END $$`,
  `CREATE INDEX IF NOT EXISTS directory_view_roots_by_unit ON directory_view_roots(org_id, unit_id)`,
  `CREATE TABLE IF NOT EXISTS skills(
    id TEXT PRIMARY KEY,
    json JSONB NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS skill_access_policies(
    org_id TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    owner_scope_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('home', 'organization', 'restricted')),
    revision BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    updated_by TEXT NOT NULL,
    PRIMARY KEY (org_id, skill_id)
  )`,
  `CREATE INDEX IF NOT EXISTS skill_access_policies_owner ON skill_access_policies(org_id, owner_scope_id)`,
  `CREATE TABLE IF NOT EXISTS acl_grants(
    org_id TEXT,
    owner_scope_id TEXT NOT NULL,
    path TEXT NOT NULL,
    grantee_scope_id TEXT NOT NULL,
    permission TEXT NOT NULL,
    granted_by TEXT NOT NULL,
    granted_at BIGINT,
    PRIMARY KEY (owner_scope_id, path, grantee_scope_id, permission)
  )`,
  `ALTER TABLE acl_grants ADD COLUMN IF NOT EXISTS org_id TEXT`,
  `ALTER TABLE acl_grants ADD COLUMN IF NOT EXISTS granted_at BIGINT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS acl_grants_legacy_identity
    ON acl_grants(owner_scope_id, path, grantee_scope_id, permission)`,
  `CREATE INDEX IF NOT EXISTS acl_grants_by_org_path ON acl_grants(org_id, path)`,
  `CREATE TABLE IF NOT EXISTS acl_grants_version(
    only_row BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (only_row),
    v BIGINT NOT NULL
  )`,
  `INSERT INTO acl_grants_version(only_row, v) VALUES (TRUE, 0) ON CONFLICT (only_row) DO NOTHING`,
  `CREATE OR REPLACE FUNCTION acl_grants_bump_version() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      INSERT INTO acl_grants_version(only_row, v) VALUES (TRUE, 1)
      ON CONFLICT (only_row) DO UPDATE SET v = acl_grants_version.v + 1;
      RETURN NULL;
    END
    $fn$`,
  `DROP TRIGGER IF EXISTS acl_grants_bump ON acl_grants`,
  `CREATE TRIGGER acl_grants_bump
    AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON acl_grants
    FOR EACH STATEMENT EXECUTE FUNCTION acl_grants_bump_version()`,
  `CREATE TABLE IF NOT EXISTS organization_authz_state(
    org_id TEXT PRIMARY KEY,
    revision BIGINT NOT NULL,
    skill_access_policy_version INTEGER NOT NULL DEFAULT 0,
    skill_access_enforced_at BIGINT,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE OR REPLACE FUNCTION organization_authz_lock_row() RETURNS trigger LANGUAGE plpgsql AS $fn$
   DECLARE scope_org_id TEXT;
   DECLARE owner_org_id TEXT;
   BEGIN
     PERFORM pg_advisory_xact_lock(hashtext('organization-database-owner'));
     SELECT org_id INTO owner_org_id FROM organization_database_owner WHERE singleton;
     scope_org_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;
     scope_org_id := COALESCE(scope_org_id, owner_org_id);
     IF owner_org_id IS NOT NULL AND owner_org_id <> scope_org_id THEN
       RAISE EXCEPTION 'organization database belongs to %, not %', owner_org_id, scope_org_id
         USING ERRCODE = '23514';
     END IF;
     IF TG_TABLE_NAME = 'acl_grants' AND TG_OP <> 'DELETE' THEN
       NEW.org_id := scope_org_id;
       NEW.granted_at := COALESCE(NEW.granted_at, floor(extract(epoch FROM clock_timestamp()) * 1000));
     END IF;
     PERFORM pg_advisory_xact_lock(
       hashtext('organization-authz'),
       hashtext(scope_org_id)
     );
     IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
     RETURN NEW;
   END
   $fn$`,
  `DO $do$
   DECLARE table_name TEXT;
   DECLARE trigger_name TEXT;
   BEGIN
     FOREACH table_name IN ARRAY ARRAY[
       'organization_users',
       'auth_identities',
       'org_units',
       'org_unit_closure',
       'org_unit_members',
       'access_groups',
       'access_group_members',
       'directory_view_policies',
       'directory_view_roots',
       'skill_access_policies',
       'acl_grants',
       'organization_authz_state'
     ] LOOP
       trigger_name := 'organization_authz_lock_' || table_name;
       IF NOT EXISTS (
         SELECT 1 FROM pg_trigger
          WHERE tgname = trigger_name AND tgrelid = to_regclass(table_name)
       ) THEN
         EXECUTE format(
           'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION organization_authz_lock_row()',
           trigger_name,
           table_name
         );
       END IF;
     END LOOP;
   END
   $do$`,
  `CREATE OR REPLACE FUNCTION skill_access_legacy_lock() RETURNS trigger LANGUAGE plpgsql AS $fn$
   DECLARE scope_org_id TEXT;
   DECLARE owner_org_id TEXT;
   BEGIN
     PERFORM pg_advisory_xact_lock(hashtext('organization-database-owner'));
     SELECT org_id INTO owner_org_id FROM organization_database_owner WHERE singleton;
     scope_org_id := COALESCE(
       CASE WHEN TG_OP = 'DELETE' THEN OLD.json ->> 'orgId' ELSE NEW.json ->> 'orgId' END,
       owner_org_id
     );
     IF owner_org_id IS NOT NULL AND scope_org_id IS DISTINCT FROM owner_org_id THEN
       RAISE EXCEPTION 'organization database belongs to %, not %', owner_org_id, scope_org_id
         USING ERRCODE = '23514';
     END IF;
     IF TG_OP = 'UPDATE' AND OLD.id IS DISTINCT FROM NEW.id THEN
       RAISE EXCEPTION 'skill id cannot change' USING ERRCODE = '23514';
     END IF;
     IF TG_OP = 'UPDATE' AND COALESCE(OLD.json ->> 'orgId', owner_org_id) IS DISTINCT FROM scope_org_id THEN
       RAISE EXCEPTION 'skill organization cannot change' USING ERRCODE = '23514';
     END IF;
     IF TG_OP <> 'DELETE' AND scope_org_id IS NOT NULL AND NOT(NEW.json ? 'orgId') THEN
       NEW.json := jsonb_set(NEW.json, '{orgId}', to_jsonb(scope_org_id));
     END IF;
     IF scope_org_id IS NOT NULL THEN
       PERFORM pg_advisory_xact_lock(hashtext('organization-authz'), hashtext(scope_org_id));
     END IF;
     IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
     RETURN NEW;
   END
   $fn$`,
  `DROP TRIGGER IF EXISTS skill_access_legacy_lock ON skills`,
  `CREATE TRIGGER skill_access_legacy_lock
    BEFORE INSERT OR UPDATE OR DELETE ON skills
    FOR EACH ROW EXECUTE FUNCTION skill_access_legacy_lock()`,
  `CREATE OR REPLACE FUNCTION skill_access_legacy_sync() RETURNS trigger LANGUAGE plpgsql AS $fn$
   DECLARE scope_org_id TEXT;
   DECLARE policy_version INTEGER;
   DECLARE legacy_skill_id TEXT;
   DECLARE owner_scope TEXT;
   DECLARE actor_id TEXT;
   DECLARE at_ms BIGINT;
   BEGIN
     IF pg_trigger_depth() > 1 OR current_setting('qm.skill_access_writer', TRUE) = 'transactional' THEN RETURN NULL; END IF;
     scope_org_id := COALESCE(
       CASE WHEN TG_OP = 'DELETE' THEN OLD.json ->> 'orgId' ELSE NEW.json ->> 'orgId' END,
       (SELECT org_id FROM organization_database_owner WHERE singleton)
     );
     SELECT skill_access_policy_version INTO policy_version
       FROM organization_authz_state WHERE org_id = scope_org_id;
     IF scope_org_id IS NULL OR policy_version IS DISTINCT FROM 1 THEN RETURN NULL; END IF;
     legacy_skill_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
     owner_scope := CASE WHEN TG_OP = 'DELETE' THEN OLD.json ->> 'scopeId' ELSE NEW.json ->> 'scopeId' END;
     IF TG_OP = 'UPDATE' AND OLD.json ->> 'scopeId' IS NOT DISTINCT FROM NEW.json ->> 'scopeId' THEN
       RETURN NULL;
     END IF;
     actor_id := COALESCE(
       CASE WHEN TG_OP = 'DELETE' THEN OLD.json ->> 'createdBy' ELSE NEW.json ->> 'createdBy' END,
       'system:legacy-skill-writer'
     );
     at_ms := floor(extract(epoch FROM clock_timestamp()) * 1000);
     IF TG_OP = 'DELETE' THEN
       DELETE FROM acl_grants WHERE (org_id = scope_org_id OR org_id IS NULL) AND path = 'skill:' || legacy_skill_id;
       DELETE FROM skill_access_policies
        WHERE org_id = scope_org_id AND skill_access_policies.skill_id = legacy_skill_id;
     ELSE
       INSERT INTO skill_access_policies(
         org_id, skill_id, owner_scope_id, mode, revision, created_at, updated_at, updated_by
       ) VALUES(scope_org_id, legacy_skill_id, owner_scope, 'home', 1, at_ms, at_ms, actor_id)
       ON CONFLICT(org_id, skill_id) DO UPDATE SET
         owner_scope_id = EXCLUDED.owner_scope_id,
         revision = skill_access_policies.revision + 1,
         updated_at = EXCLUDED.updated_at,
         updated_by = EXCLUDED.updated_by;
       UPDATE acl_grants SET owner_scope_id = owner_scope
        WHERE (org_id = scope_org_id OR org_id IS NULL) AND path = 'skill:' || legacy_skill_id;
     END IF;
     UPDATE organization_authz_state
        SET revision = revision + 1, updated_at = at_ms
      WHERE org_id = scope_org_id;
     IF to_regclass('public.audit_log') IS NOT NULL THEN
       INSERT INTO audit_log(at, principal_id, action, resource, scope_label, status, detail)
       VALUES(
         at_ms,
         'system:legacy-skill-writer',
         'skill.legacy.' || lower(TG_OP),
         'skill:' || legacy_skill_id,
         COALESCE(owner_scope, 'org:' || scope_org_id),
         'ok',
         actor_id
       );
     END IF;
     RETURN NULL;
   END
   $fn$`,
  `DROP TRIGGER IF EXISTS skill_access_legacy_sync ON skills`,
  `CREATE TRIGGER skill_access_legacy_sync
    AFTER INSERT OR UPDATE OR DELETE ON skills
    FOR EACH ROW EXECUTE FUNCTION skill_access_legacy_sync()`,
  `CREATE OR REPLACE FUNCTION skill_access_legacy_grant_sync() RETURNS trigger LANGUAGE plpgsql AS $fn$
   DECLARE scope_org_id TEXT;
   DECLARE policy_version INTEGER;
   DECLARE old_skill_id TEXT;
   DECLARE new_skill_id TEXT;
   DECLARE actor_id TEXT;
   DECLARE at_ms BIGINT;
   DECLARE changed BOOLEAN := FALSE;
   BEGIN
     IF pg_trigger_depth() > 1 OR current_setting('qm.skill_access_writer', TRUE) = 'transactional' THEN RETURN NULL; END IF;
     scope_org_id := COALESCE(
       CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END,
       (SELECT org_id FROM organization_database_owner WHERE singleton)
     );
     SELECT skill_access_policy_version INTO policy_version
       FROM organization_authz_state WHERE org_id = scope_org_id;
     IF scope_org_id IS NULL OR policy_version IS DISTINCT FROM 1 THEN RETURN NULL; END IF;
     old_skill_id := CASE
       WHEN TG_OP <> 'INSERT' AND OLD.path LIKE 'skill:%' THEN substring(OLD.path FROM 7)
       ELSE NULL
     END;
     new_skill_id := CASE
       WHEN TG_OP <> 'DELETE' AND NEW.path LIKE 'skill:%' THEN substring(NEW.path FROM 7)
       ELSE NULL
     END;
     IF old_skill_id IS NULL AND new_skill_id IS NULL THEN RETURN NULL; END IF;
     actor_id := COALESCE(
       CASE WHEN TG_OP = 'DELETE' THEN OLD.granted_by ELSE NEW.granted_by END,
       'system:legacy-acl-writer'
     );
     at_ms := floor(extract(epoch FROM clock_timestamp()) * 1000);
     IF old_skill_id IS NOT NULL THEN
       UPDATE skill_access_policies
          SET revision = revision + 1,
              updated_at = at_ms,
              updated_by = actor_id
        WHERE org_id = scope_org_id AND skill_id = old_skill_id;
       changed := FOUND;
     END IF;
     IF new_skill_id IS NOT NULL AND new_skill_id IS DISTINCT FROM old_skill_id THEN
       UPDATE skill_access_policies
          SET revision = revision + 1,
              updated_at = at_ms,
              updated_by = actor_id
        WHERE org_id = scope_org_id AND skill_id = new_skill_id;
       IF FOUND THEN changed := TRUE; END IF;
     END IF;
     IF NOT changed THEN RETURN NULL; END IF;
     UPDATE organization_authz_state
        SET revision = revision + 1, updated_at = at_ms
      WHERE org_id = scope_org_id;
     IF to_regclass('public.audit_log') IS NOT NULL THEN
       INSERT INTO audit_log(at, principal_id, action, resource, scope_label, status, detail)
       VALUES(
         at_ms,
         'system:legacy-acl-writer',
         'skill.access.legacy.' || lower(TG_OP),
         'skill:' || COALESCE(new_skill_id, old_skill_id),
         'org:' || scope_org_id,
         'ok',
         actor_id
       );
     END IF;
     RETURN NULL;
   END
   $fn$`,
  `DROP TRIGGER IF EXISTS skill_access_legacy_grant_sync ON acl_grants`,
  `CREATE TRIGGER skill_access_legacy_grant_sync
    AFTER INSERT OR UPDATE OR DELETE ON acl_grants
    FOR EACH ROW EXECUTE FUNCTION skill_access_legacy_grant_sync()`,
  `CREATE OR REPLACE FUNCTION organization_identity_projection_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
   DECLARE projection_principal_id TEXT;
   DECLARE account_status TEXT;
   DECLARE account_version BIGINT;
   BEGIN
     projection_principal_id := COALESCE(
       CASE WHEN TG_OP = 'DELETE' THEN OLD.json ->> 'principalId' ELSE NEW.json ->> 'principalId' END,
       CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END
     );
     SELECT account.status, account.session_version
       INTO account_status, account_version
       FROM organization_users account
      WHERE (
              NOT EXISTS (SELECT 1 FROM organization_database_owner) OR
              account.org_id = (SELECT org_id FROM organization_database_owner WHERE singleton)
            )
        AND (
              account.principal_id = projection_principal_id OR
              (position('@' IN projection_principal_id) > 0 AND lower(account.principal_id) = lower(projection_principal_id))
            )
      ORDER BY CASE WHEN account.principal_id = projection_principal_id THEN 0 ELSE 1 END
      LIMIT 1;
     IF FOUND THEN
       IF TG_OP IN ('INSERT', 'UPDATE') THEN
         IF account_status = 'active' THEN
           RAISE EXCEPTION 'organization identity projection does not match user state for %', projection_principal_id USING ERRCODE = '40001';
         END IF;
         IF jsonb_typeof(NEW.json -> 'sessionVersion') IS DISTINCT FROM 'number' THEN
           NEW.json := NEW.json || jsonb_build_object(
             'principalId', projection_principal_id,
             'status', 'deactivated',
             'sessionVersion', account_version
           );
         ELSIF (NEW.json ->> 'sessionVersion')::BIGINT <> account_version THEN
           RAISE EXCEPTION 'organization identity projection does not match user state for %', projection_principal_id USING ERRCODE = '40001';
         END IF;
       END IF;
       IF TG_OP = 'DELETE' AND account_status <> 'active' THEN
         RAISE EXCEPTION 'inactive organization identity projection cannot be removed for %', projection_principal_id USING ERRCODE = '40001';
       END IF;
     END IF;
     IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
     RETURN NEW;
   END
   $fn$`,
  `DO $do$
   BEGIN
     DROP TRIGGER IF EXISTS organization_identity_projection_guard ON deactivated_principals;
     CREATE TRIGGER organization_identity_projection_guard
     BEFORE INSERT OR UPDATE OR DELETE ON deactivated_principals
     FOR EACH ROW EXECUTE FUNCTION organization_identity_projection_guard();
   END
   $do$`,
  `CREATE OR REPLACE FUNCTION organization_project_user_identity() RETURNS trigger LANGUAGE plpgsql AS $fn$
   DECLARE identity_key TEXT;
   DECLARE identity_status TEXT;
   DECLARE status_record JSONB;
   BEGIN
     identity_key := CASE WHEN position('@' IN NEW.principal_id) > 0 THEN lower(NEW.principal_id) ELSE NEW.principal_id END;
     identity_status := CASE WHEN NEW.status = 'active' THEN 'active' ELSE 'deactivated' END;
     status_record := jsonb_build_object(
       'principalId', NEW.principal_id,
       'source', 'manual',
       'status', identity_status,
       'sessionVersion', NEW.session_version,
       'at', NEW.updated_at
     );
     INSERT INTO durable_map_versions(tbl, v) VALUES('organization_identity_status', 1)
     ON CONFLICT (tbl) DO UPDATE SET v = durable_map_versions.v + 1;
     INSERT INTO organization_identity_status(id, json) VALUES(identity_key, status_record)
     ON CONFLICT (id) DO UPDATE SET json = EXCLUDED.json
     WHERE COALESCE((organization_identity_status.json ->> 'sessionVersion')::BIGINT, -1) <= NEW.session_version;
     INSERT INTO durable_map_versions(tbl, v) VALUES('deactivated_principals', 1)
     ON CONFLICT (tbl) DO UPDATE SET v = durable_map_versions.v + 1;
     IF NEW.status = 'active' THEN
       DELETE FROM deactivated_principals WHERE id = identity_key;
     ELSE
       INSERT INTO deactivated_principals(id, json) VALUES(identity_key, status_record)
       ON CONFLICT (id) DO UPDATE SET json = EXCLUDED.json;
     END IF;
     RETURN NEW;
   END
   $fn$`,
  `DO $do$
   BEGIN
     DROP TRIGGER IF EXISTS organization_project_user_identity ON organization_users;
     CREATE TRIGGER organization_project_user_identity
     AFTER INSERT OR UPDATE OF status, session_version ON organization_users
     FOR EACH ROW EXECUTE FUNCTION organization_project_user_identity();
   END
   $do$`,
  `CREATE OR REPLACE FUNCTION organization_user_version_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
   BEGIN
     IF NEW.session_version < OLD.session_version OR
        (NEW.status IS DISTINCT FROM OLD.status AND NEW.session_version <= OLD.session_version) THEN
       RAISE EXCEPTION 'organization user session version regression for %', OLD.principal_id USING ERRCODE = '40001';
     END IF;
     IF NEW.session_version = OLD.session_version AND NEW.updated_at < OLD.updated_at THEN
       RAISE EXCEPTION 'organization user update timestamp regression for %', OLD.principal_id USING ERRCODE = '40001';
     END IF;
     IF NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
       RAISE EXCEPTION 'organization user creator fields are immutable for %', OLD.principal_id USING ERRCODE = '23514';
     END IF;
     IF OLD.status = 'deprovisioned' AND NEW.status <> 'deprovisioned' AND EXISTS (
       SELECT 1
         FROM org_unit_members member
         JOIN org_units unit ON unit.org_id = member.org_id AND unit.id = member.unit_id
        WHERE member.org_id = OLD.org_id
          AND member.principal_id = OLD.principal_id
          AND unit.status = 'archived'
     ) THEN
       RAISE EXCEPTION 'organization user % belongs to an archived unit', OLD.principal_id USING ERRCODE = '23514';
     END IF;
     RETURN NEW;
   END
   $fn$`,
  `DO $do$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE tgname = 'organization_user_version_guard' AND tgrelid = 'organization_users'::regclass
     ) THEN
       CREATE TRIGGER organization_user_version_guard
       BEFORE UPDATE ON organization_users
       FOR EACH ROW EXECUTE FUNCTION organization_user_version_guard();
     END IF;
   END
   $do$`,
  `CREATE OR REPLACE FUNCTION auth_identity_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
   BEGIN
     IF NEW.created_at IS DISTINCT FROM OLD.created_at
        OR (OLD.source_id IS NULL AND NEW.principal_id IS DISTINCT FROM OLD.principal_id)
        OR NEW.source_id IS DISTINCT FROM OLD.source_id
        OR NEW.provider IS DISTINCT FROM OLD.provider
        OR NEW.external_tenant_id IS DISTINCT FROM OLD.external_tenant_id
        OR NEW.external_subject_id IS DISTINCT FROM OLD.external_subject_id THEN
       RAISE EXCEPTION 'organization identity binding is immutable for %', OLD.subject USING ERRCODE = '23514';
     END IF;
     RETURN NEW;
   END
   $fn$`,
  `DO $do$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE tgname = 'auth_identity_immutable_guard' AND tgrelid = 'auth_identities'::regclass
     ) THEN
       CREATE TRIGGER auth_identity_immutable_guard
       BEFORE UPDATE ON auth_identities
       FOR EACH ROW EXECUTE FUNCTION auth_identity_immutable_guard();
     END IF;
   END
   $do$`,
  `CREATE OR REPLACE FUNCTION organization_unit_state_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
   DECLARE parent_status TEXT;
   BEGIN
     IF TG_OP = 'DELETE' THEN
       IF OLD.parent_id IS NULL THEN
         RAISE EXCEPTION 'organization root cannot be deleted for %', OLD.org_id USING ERRCODE = '23514';
       END IF;
       RETURN OLD;
     END IF;
     IF NEW.parent_id IS NULL AND NEW.status <> 'active' THEN
       RAISE EXCEPTION 'organization root must remain active for %', NEW.org_id USING ERRCODE = '23514';
     END IF;
     IF NEW.status = 'active' AND NEW.parent_id IS NOT NULL THEN
       SELECT status INTO parent_status
         FROM org_units
        WHERE org_id = NEW.org_id AND id = NEW.parent_id;
       IF parent_status IS DISTINCT FROM 'active' THEN
         RAISE EXCEPTION 'active organization unit % requires an active parent', NEW.id USING ERRCODE = '23514';
       END IF;
     END IF;
     IF TG_OP = 'UPDATE' AND OLD.status = 'active' AND NEW.status = 'archived' THEN
       IF EXISTS (
         SELECT 1 FROM org_units
          WHERE org_id = NEW.org_id AND parent_id = NEW.id AND status = 'active'
       ) THEN
         RAISE EXCEPTION 'organization unit % has active children', NEW.id USING ERRCODE = '23514';
       END IF;
       IF EXISTS (
         SELECT 1
           FROM org_unit_members member
           JOIN organization_users account
             ON account.org_id = member.org_id AND account.principal_id = member.principal_id
          WHERE member.org_id = NEW.org_id
            AND member.unit_id = NEW.id
            AND account.status <> 'deprovisioned'
       ) THEN
         RAISE EXCEPTION 'organization unit % has assignable members', NEW.id USING ERRCODE = '23514';
       END IF;
       IF EXISTS (
         SELECT 1 FROM directory_view_roots root
          WHERE root.org_id = NEW.org_id AND root.unit_id = NEW.id
       ) OR EXISTS (
         SELECT 1 FROM directory_view_policies policy
          WHERE policy.org_id = NEW.org_id AND policy.subject_kind = 'org_unit' AND policy.subject_id = NEW.id
       ) OR EXISTS (
         SELECT 1 FROM acl_grants grant_row
          WHERE grant_row.org_id = NEW.org_id
            AND (grant_row.owner_scope_id = 'org-unit:' || NEW.id
              OR grant_row.grantee_scope_id = 'org-unit:' || NEW.id)
       ) OR EXISTS (
         SELECT 1 FROM skill_access_policies policy
          WHERE policy.org_id = NEW.org_id
            AND policy.owner_scope_id = 'org-unit:' || NEW.id
       ) THEN
         RAISE EXCEPTION 'organization unit % has authorization references', NEW.id USING ERRCODE = '23514';
       END IF;
     END IF;
     RETURN NEW;
   END
   $fn$`,
  `DO $do$
   BEGIN
     DROP TRIGGER IF EXISTS organization_unit_state_guard ON org_units;
     CREATE TRIGGER organization_unit_state_guard
     BEFORE INSERT OR UPDATE OR DELETE ON org_units
     FOR EACH ROW EXECUTE FUNCTION organization_unit_state_guard();
   END
   $do$`,
  `CREATE OR REPLACE FUNCTION organization_group_state_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
   BEGIN
     IF TG_OP = 'UPDATE' AND OLD.status = 'active' AND NEW.status = 'archived' AND (
       EXISTS (
         SELECT 1 FROM directory_view_policies policy
          WHERE policy.org_id = NEW.org_id AND policy.subject_kind = 'access_group' AND policy.subject_id = NEW.id
       ) OR EXISTS (
         SELECT 1 FROM acl_grants grant_row
          WHERE grant_row.org_id = NEW.org_id
            AND grant_row.path LIKE 'skill:%'
            AND (grant_row.owner_scope_id = 'access-group:' || NEW.id
              OR grant_row.grantee_scope_id = 'access-group:' || NEW.id)
       ) OR EXISTS (
         SELECT 1 FROM skill_access_policies policy
          WHERE policy.org_id = NEW.org_id
            AND policy.owner_scope_id = 'access-group:' || NEW.id
       )
     ) THEN
       RAISE EXCEPTION 'access group % has authorization references', NEW.id USING ERRCODE = '23514';
     END IF;
     RETURN NEW;
   END
   $fn$`,
  `DO $do$
   BEGIN
     DROP TRIGGER IF EXISTS organization_group_state_guard ON access_groups;
     CREATE TRIGGER organization_group_state_guard
     BEFORE UPDATE ON access_groups
     FOR EACH ROW EXECUTE FUNCTION organization_group_state_guard();
   END
   $do$`,
  `CREATE OR REPLACE FUNCTION directory_policy_subject_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
   DECLARE subject_status TEXT;
   BEGIN
     IF NEW.subject_kind = 'user' THEN
       SELECT status INTO subject_status FROM organization_users
        WHERE org_id = NEW.org_id AND principal_id = NEW.subject_id;
     ELSIF NEW.subject_kind = 'org_unit' THEN
       SELECT status INTO subject_status FROM org_units
        WHERE org_id = NEW.org_id AND id = NEW.subject_id;
     ELSE
       SELECT status INTO subject_status FROM access_groups
        WHERE org_id = NEW.org_id AND id = NEW.subject_id;
     END IF;
     IF subject_status IS DISTINCT FROM 'active' THEN
       RAISE EXCEPTION 'directory policy subject must be active' USING ERRCODE = '23514';
     END IF;
     RETURN NEW;
   END
   $fn$`,
  `DO $do$
   BEGIN
     DROP TRIGGER IF EXISTS directory_policy_subject_guard ON directory_view_policies;
     CREATE TRIGGER directory_policy_subject_guard
     BEFORE INSERT OR UPDATE ON directory_view_policies
     FOR EACH ROW EXECUTE FUNCTION directory_policy_subject_guard();
   END
   $do$`,
  `CREATE OR REPLACE FUNCTION directory_root_unit_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
   DECLARE unit_status TEXT;
   BEGIN
     SELECT status INTO unit_status FROM org_units WHERE org_id = NEW.org_id AND id = NEW.unit_id;
     IF unit_status IS DISTINCT FROM 'active' THEN
       RAISE EXCEPTION 'directory root unit must be active' USING ERRCODE = '23514';
     END IF;
     RETURN NEW;
   END
   $fn$`,
  `DO $do$
   BEGIN
     DROP TRIGGER IF EXISTS directory_root_unit_guard ON directory_view_roots;
     CREATE TRIGGER directory_root_unit_guard
     BEFORE INSERT OR UPDATE ON directory_view_roots
     FOR EACH ROW EXECUTE FUNCTION directory_root_unit_guard();
   END
   $do$`,
  `CREATE OR REPLACE FUNCTION skill_access_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
   DECLARE skill_json JSONB;
   BEGIN
     SELECT json INTO skill_json FROM skills WHERE id = NEW.skill_id;
     IF skill_json IS NULL OR skill_json ->> 'orgId' IS DISTINCT FROM NEW.org_id THEN
       RAISE EXCEPTION 'skill access policy requires a same-organization skill' USING ERRCODE = '23514';
     END IF;
     IF skill_json ->> 'scopeId' IS DISTINCT FROM NEW.owner_scope_id THEN
       RAISE EXCEPTION 'skill access policy owner mismatch' USING ERRCODE = '23514';
     END IF;
     IF NEW.mode <> 'restricted' AND EXISTS (
       SELECT 1 FROM acl_grants grant_row
        WHERE grant_row.org_id = NEW.org_id AND grant_row.path = 'skill:' || NEW.skill_id
     ) THEN
       RAISE EXCEPTION 'non-restricted skill access policy cannot retain grants' USING ERRCODE = '23514';
     END IF;
     RETURN NEW;
   END
   $fn$`,
  `DO $do$
   BEGIN
     DROP TRIGGER IF EXISTS skill_access_policy_guard ON skill_access_policies;
     CREATE TRIGGER skill_access_policy_guard
     BEFORE INSERT OR UPDATE ON skill_access_policies
     FOR EACH ROW EXECUTE FUNCTION skill_access_policy_guard();
   END
   $do$`,
  `CREATE OR REPLACE FUNCTION skill_access_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
   DECLARE policy_mode TEXT;
   DECLARE policy_owner TEXT;
   DECLARE subject_status TEXT;
   DECLARE subject_id TEXT;
   BEGIN
     IF NEW.path NOT LIKE 'skill:%' THEN RETURN NEW; END IF;
     IF NEW.org_id IS NULL OR NEW.granted_at IS NULL THEN RETURN NEW; END IF;
     IF NEW.permission <> 'read' THEN
       RAISE EXCEPTION 'skill access grants require read permission' USING ERRCODE = '23514';
     END IF;
     SELECT mode, owner_scope_id INTO policy_mode, policy_owner
       FROM skill_access_policies
      WHERE org_id = NEW.org_id AND skill_id = substring(NEW.path FROM 7);
     IF policy_mode IS DISTINCT FROM 'restricted' OR policy_owner IS DISTINCT FROM NEW.owner_scope_id THEN
       RAISE EXCEPTION 'skill access grant requires a matching restricted policy' USING ERRCODE = '23514';
     END IF;
     IF NEW.grantee_scope_id LIKE 'personal:%' THEN
       subject_id := substring(NEW.grantee_scope_id FROM 10);
       SELECT status INTO subject_status FROM organization_users
        WHERE org_id = NEW.org_id AND principal_id = subject_id;
     ELSIF NEW.grantee_scope_id LIKE 'org-unit:%' THEN
       subject_id := substring(NEW.grantee_scope_id FROM 10);
       SELECT status INTO subject_status FROM org_units
        WHERE org_id = NEW.org_id AND id = subject_id;
     ELSIF NEW.grantee_scope_id LIKE 'access-group:%' THEN
       subject_id := substring(NEW.grantee_scope_id FROM 14);
       SELECT status INTO subject_status FROM access_groups
        WHERE org_id = NEW.org_id AND id = subject_id;
     ELSE
       RAISE EXCEPTION 'invalid skill access subject' USING ERRCODE = '23514';
     END IF;
     IF subject_status IS DISTINCT FROM 'active' THEN
       RAISE EXCEPTION 'skill access subject must be active' USING ERRCODE = '23514';
     END IF;
     RETURN NEW;
   END
   $fn$`,
  `DO $do$
   BEGIN
     DROP TRIGGER IF EXISTS skill_access_grant_guard ON acl_grants;
     CREATE TRIGGER skill_access_grant_guard
     BEFORE INSERT OR UPDATE ON acl_grants
     FOR EACH ROW EXECUTE FUNCTION skill_access_grant_guard();
   END
   $do$`,
  `CREATE OR REPLACE FUNCTION organization_membership_write_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
   DECLARE target_status TEXT;
   DECLARE user_status TEXT;
   BEGIN
     IF TG_TABLE_NAME = 'org_unit_members' THEN
       SELECT status INTO target_status
         FROM org_units
        WHERE org_id = NEW.org_id AND id = NEW.unit_id;
     ELSE
       SELECT status INTO target_status
         FROM access_groups
        WHERE org_id = NEW.org_id AND id = NEW.group_id;
     END IF;
     SELECT status INTO user_status
       FROM organization_users
      WHERE org_id = NEW.org_id AND principal_id = NEW.principal_id;
     IF target_status IS DISTINCT FROM 'active' THEN
       RAISE EXCEPTION 'organization membership target must be active' USING ERRCODE = '23514';
     END IF;
     IF user_status IS DISTINCT FROM 'active' THEN
       RAISE EXCEPTION 'organization membership user must be assignable' USING ERRCODE = '23514';
     END IF;
     RETURN NEW;
   END
   $fn$`,
  `DO $do$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE tgname = 'organization_unit_membership_write_guard' AND tgrelid = 'org_unit_members'::regclass
     ) THEN
       CREATE TRIGGER organization_unit_membership_write_guard
       BEFORE INSERT OR UPDATE ON org_unit_members
       FOR EACH ROW EXECUTE FUNCTION organization_membership_write_guard();
     END IF;
     IF NOT EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE tgname = 'organization_group_membership_write_guard' AND tgrelid = 'access_group_members'::regclass
     ) THEN
       CREATE TRIGGER organization_group_membership_write_guard
       BEFORE INSERT OR UPDATE ON access_group_members
       FOR EACH ROW EXECUTE FUNCTION organization_membership_write_guard();
     END IF;
   END
   $do$`,
  `DO $do$
   BEGIN
     IF EXISTS (
       SELECT 1
         FROM org_units child
         LEFT JOIN org_units parent ON parent.org_id = child.org_id AND parent.id = child.parent_id
        WHERE (child.parent_id IS NULL AND child.status <> 'active')
           OR (child.status = 'active' AND child.parent_id IS NOT NULL AND parent.status IS DISTINCT FROM 'active')
     ) THEN
       RAISE EXCEPTION 'historical organization unit state is invalid' USING ERRCODE = '23514';
     END IF;
     IF EXISTS (
       SELECT 1
         FROM organization_authz_state state
         LEFT JOIN org_units root
           ON root.org_id = state.org_id AND root.parent_id IS NULL AND root.status = 'active'
        GROUP BY state.org_id
       HAVING count(root.id) <> 1
     ) THEN
       RAISE EXCEPTION 'historical organization root state is invalid' USING ERRCODE = '23514';
     END IF;
     IF EXISTS (
       SELECT 1
         FROM org_units unit
         JOIN org_unit_members member ON member.org_id = unit.org_id AND member.unit_id = unit.id
         JOIN organization_users account
           ON account.org_id = member.org_id AND account.principal_id = member.principal_id
        WHERE unit.status = 'archived' AND account.status <> 'deprovisioned'
     ) THEN
       RAISE EXCEPTION 'historical archived organization unit has assignable members' USING ERRCODE = '23514';
     END IF;
   END
   $do$`,
  `CREATE OR REPLACE FUNCTION organization_validate_unit_closure(scope_org_id TEXT) RETURNS void LANGUAGE plpgsql AS $fn$
   DECLARE invalid BOOLEAN;
   BEGIN
     WITH RECURSIVE walk AS (
       SELECT id AS ancestor_id, id AS descendant_id, 0 AS depth, ARRAY[id] AS path, FALSE AS cycle
         FROM org_units
        WHERE org_id = scope_org_id
       UNION ALL
       SELECT walk.ancestor_id,
              child.id,
              walk.depth + 1,
              walk.path || child.id,
              child.id = ANY(walk.path)
         FROM walk
         JOIN org_units child
           ON child.org_id = scope_org_id AND child.parent_id = walk.descendant_id
        WHERE NOT walk.cycle
     )
     SELECT EXISTS(SELECT 1 FROM walk WHERE cycle) INTO invalid;
     IF invalid THEN
       RAISE EXCEPTION 'organization unit cycle for %', scope_org_id USING ERRCODE = '23514';
     END IF;
     WITH RECURSIVE walk AS (
       SELECT id AS ancestor_id, id AS descendant_id, 0 AS depth, ARRAY[id] AS path
         FROM org_units
        WHERE org_id = scope_org_id
       UNION ALL
       SELECT walk.ancestor_id, child.id, walk.depth + 1, walk.path || child.id
         FROM walk
         JOIN org_units child
           ON child.org_id = scope_org_id AND child.parent_id = walk.descendant_id
        WHERE NOT child.id = ANY(walk.path)
     ),
     expected AS (
       SELECT ancestor_id, descendant_id, min(depth) AS depth
         FROM walk
        GROUP BY ancestor_id, descendant_id
     ),
     difference AS (
       (SELECT ancestor_id, descendant_id, depth FROM expected
        EXCEPT
        SELECT ancestor_id, descendant_id, depth FROM org_unit_closure WHERE org_id = scope_org_id)
       UNION ALL
       (SELECT ancestor_id, descendant_id, depth FROM org_unit_closure WHERE org_id = scope_org_id
        EXCEPT
        SELECT ancestor_id, descendant_id, depth FROM expected)
     )
     SELECT EXISTS(SELECT 1 FROM difference) INTO invalid;
     IF invalid THEN
       RAISE EXCEPTION 'organization unit closure mismatch for %', scope_org_id USING ERRCODE = '23514';
     END IF;
   END
   $fn$`,
  `CREATE TABLE IF NOT EXISTS organization_closure_validation_queue(
    transaction_id BIGINT NOT NULL,
    org_id TEXT NOT NULL,
    PRIMARY KEY (transaction_id, org_id)
  )`,
  `CREATE OR REPLACE FUNCTION organization_enqueue_closure_validation() RETURNS trigger LANGUAGE plpgsql AS $fn$
   DECLARE scope_org_id TEXT;
   BEGIN
     scope_org_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;
     INSERT INTO organization_closure_validation_queue(transaction_id, org_id)
     VALUES (txid_current(), scope_org_id)
     ON CONFLICT DO NOTHING;
     IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
     RETURN NEW;
   END
   $fn$`,
  `CREATE OR REPLACE FUNCTION organization_process_closure_validation() RETURNS trigger LANGUAGE plpgsql AS $fn$
   BEGIN
     PERFORM organization_validate_unit_closure(NEW.org_id);
     DELETE FROM organization_closure_validation_queue
      WHERE transaction_id = NEW.transaction_id AND org_id = NEW.org_id;
     RETURN NEW;
   END
   $fn$`,
  `DO $do$
   BEGIN
     DROP TRIGGER IF EXISTS organization_units_closure_guard ON org_units;
     DROP TRIGGER IF EXISTS organization_closure_guard ON org_unit_closure;
     DROP TRIGGER IF EXISTS organization_units_closure_enqueue ON org_units;
     DROP TRIGGER IF EXISTS organization_closure_enqueue ON org_unit_closure;
     DROP TRIGGER IF EXISTS organization_closure_validation ON organization_closure_validation_queue;
     CREATE TRIGGER organization_units_closure_enqueue
       AFTER INSERT OR UPDATE OR DELETE ON org_units
       FOR EACH ROW EXECUTE FUNCTION organization_enqueue_closure_validation();
     CREATE TRIGGER organization_closure_enqueue
       AFTER INSERT OR UPDATE OR DELETE ON org_unit_closure
       FOR EACH ROW EXECUTE FUNCTION organization_enqueue_closure_validation();
     CREATE CONSTRAINT TRIGGER organization_closure_validation
       AFTER INSERT ON organization_closure_validation_queue
       DEFERRABLE INITIALLY DEFERRED
       FOR EACH ROW EXECUTE FUNCTION organization_process_closure_validation();
   END
   $do$`,
];

const ORGANIZATION_CLOSURE_MIGRATION_SQL = `DO $do$
   DECLARE scope_org_id TEXT;
   BEGIN
     INSERT INTO organization_schema_migrations(id, applied_at)
     VALUES('organization_unit_closure_validated_v1', (extract(epoch FROM clock_timestamp()) * 1000)::BIGINT)
     ON CONFLICT (id) DO NOTHING;
     IF FOUND THEN
       FOR scope_org_id IN
         SELECT org_id FROM org_units
         UNION
         SELECT org_id FROM org_unit_closure
       LOOP
         PERFORM pg_advisory_xact_lock(hashtext('organization-authz'), hashtext(scope_org_id));
         PERFORM organization_validate_unit_closure(scope_org_id);
       END LOOP;
     END IF;
   END
   $do$`;

const ORGANIZATION_IDENTITY_PROJECTION_MIGRATION_SQL = `DO $do$
   BEGIN
     INSERT INTO organization_schema_migrations(id, applied_at)
     VALUES('organization_identity_projection_v1', (extract(epoch FROM clock_timestamp()) * 1000)::BIGINT)
     ON CONFLICT (id) DO NOTHING;
     IF FOUND THEN
       INSERT INTO organization_identity_status(id, json)
       SELECT
         CASE WHEN position('@' IN principal_id) > 0 THEN lower(principal_id) ELSE principal_id END,
         jsonb_build_object(
           'principalId', principal_id,
           'source', 'manual',
           'status', CASE WHEN status = 'active' THEN 'active' ELSE 'deactivated' END,
           'sessionVersion', session_version,
           'at', updated_at
         )
       FROM organization_users
       ON CONFLICT (id) DO UPDATE SET json = EXCLUDED.json
       WHERE COALESCE((organization_identity_status.json ->> 'sessionVersion')::BIGINT, -1)
             <= (EXCLUDED.json ->> 'sessionVersion')::BIGINT;
       INSERT INTO deactivated_principals(id, json)
       SELECT
         CASE WHEN position('@' IN principal_id) > 0 THEN lower(principal_id) ELSE principal_id END,
         jsonb_build_object(
           'principalId', principal_id,
           'source', 'manual',
           'status', 'deactivated',
           'sessionVersion', session_version,
           'at', updated_at
         )
       FROM organization_users
       WHERE status <> 'active'
       ON CONFLICT (id) DO UPDATE SET json = EXCLUDED.json
       WHERE COALESCE((deactivated_principals.json ->> 'sessionVersion')::BIGINT, -1)
             <= (EXCLUDED.json ->> 'sessionVersion')::BIGINT;
       DELETE FROM deactivated_principals projection
       USING organization_users account
       WHERE projection.id = CASE
               WHEN position('@' IN account.principal_id) > 0 THEN lower(account.principal_id)
               ELSE account.principal_id
             END
         AND account.status = 'active'
         AND COALESCE((projection.json ->> 'sessionVersion')::BIGINT, -1) <= account.session_version;
       INSERT INTO durable_map_versions(tbl, v)
       VALUES('organization_identity_status', 1), ('deactivated_principals', 1)
       ON CONFLICT (tbl) DO UPDATE SET v = durable_map_versions.v + 1;
     END IF;
   END
   $do$`;

const ORGANIZATION_LEGACY_RUNTIME_ELIGIBILITY_SQL = `DO $do$
   DECLARE captured BIGINT := (extract(epoch FROM clock_timestamp()) * 1000)::BIGINT;
   BEGIN
     INSERT INTO organization_schema_migrations(id, applied_at)
     VALUES('organization_legacy_runtime_eligibility_v1', captured)
     ON CONFLICT (id) DO NOTHING;
     IF FOUND AND to_regclass('participants') IS NOT NULL THEN
       INSERT INTO organization_legacy_runtime_eligible(person_key, principal_id, captured_at)
       SELECT person_key, min(principal_id), captured
       FROM (
         SELECT CASE
                  WHEN position('@' IN btrim(principal_id)) > 0 THEN lower(btrim(principal_id))
                  ELSE btrim(principal_id)
                END AS person_key,
                btrim(principal_id) AS principal_id
         FROM participants
         WHERE principal_id IS NOT NULL AND btrim(principal_id) <> ''
       ) eligible
       GROUP BY person_key
       ON CONFLICT (person_key) DO NOTHING;
     END IF;
   END
   $do$`;

async function putUserOn(exec: Exec, u: OrganizationUser): Promise<void> {
  await exec(
    `INSERT INTO organization_users (${USER_COLUMNS})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (org_id, principal_id)
     DO UPDATE SET
       email = EXCLUDED.email,
       display_name = EXCLUDED.display_name,
       job_title = EXCLUDED.job_title,
       mobile = EXCLUDED.mobile,
       employee_number = EXCLUDED.employee_number,
       status = EXCLUDED.status,
       session_version = EXCLUDED.session_version,
       profile_revision = EXCLUDED.profile_revision,
       created_at = EXCLUDED.created_at,
       updated_at = EXCLUDED.updated_at,
       last_login_at = EXCLUDED.last_login_at,
       created_by = EXCLUDED.created_by,
       updated_by = EXCLUDED.updated_by`,
    [
      u.orgId,
      u.principalId,
      u.email,
      u.displayName,
      u.jobTitle,
      u.mobile,
      u.employeeNumber,
      u.status,
      u.sessionVersion,
      u.profileRevision,
      u.createdAt,
      u.updatedAt,
      u.lastLoginAt,
      u.createdBy,
      u.updatedBy,
    ],
  );
}

async function insertUserOn(exec: Exec, u: OrganizationUser): Promise<boolean> {
  const result = await exec(
    `INSERT INTO organization_users (${USER_COLUMNS})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT DO NOTHING`,
    [
      u.orgId,
      u.principalId,
      u.email,
      u.displayName,
      u.jobTitle,
      u.mobile,
      u.employeeNumber,
      u.status,
      u.sessionVersion,
      u.profileRevision,
      u.createdAt,
      u.updatedAt,
      u.lastLoginAt,
      u.createdBy,
      u.updatedBy,
    ],
  );
  return result.rowCount > 0;
}

async function putIdentityOn(exec: Exec, i: AuthIdentity): Promise<void> {
  await exec(
    `INSERT INTO auth_identities (${IDENTITY_COLUMNS})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
     ON CONFLICT (org_id, issuer, subject)
     DO UPDATE SET
       principal_id = EXCLUDED.principal_id,
       email_at_link = EXCLUDED.email_at_link,
       source_id = EXCLUDED.source_id,
       provider = EXCLUDED.provider,
       external_tenant_id = EXCLUDED.external_tenant_id,
       external_subject_id = EXCLUDED.external_subject_id,
       matched_by = EXCLUDED.matched_by,
       evidence_json = EXCLUDED.evidence_json,
       created_at = EXCLUDED.created_at,
       updated_at = EXCLUDED.updated_at`,
    [
      i.orgId,
      i.issuer,
      i.subject,
      i.principalId,
      i.emailAtLink,
      i.sourceId ?? null,
      i.provider ?? null,
      i.externalTenantId ?? null,
      i.externalSubjectId ?? null,
      i.matchedBy ?? null,
      i.evidence ? JSON.stringify(i.evidence) : null,
      i.createdAt,
      i.updatedAt,
    ],
  );
}

async function relinkClosure(exec: Exec, orgId: string, unitId: string, parentId: string | null): Promise<void> {
  await exec(CLOSURE_DELETE_SQL, [orgId, unitId]);
  await exec(CLOSURE_INSERT_SQL, [orgId, unitId, parentId]);
}

async function putUnitOn(exec: Exec, unit: OrgUnit): Promise<void> {
  if (unit.parentId === null && unit.status !== "active") throw new Error("org root must remain active");
  await exec(
    `INSERT INTO org_units (${UNIT_COLUMNS})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (org_id, id)
     DO UPDATE SET
       parent_id = EXCLUDED.parent_id,
       name = EXCLUDED.name,
       kind = EXCLUDED.kind,
       status = EXCLUDED.status,
       sort_order = EXCLUDED.sort_order,
       created_at = EXCLUDED.created_at,
       updated_at = EXCLUDED.updated_at,
       created_by = EXCLUDED.created_by,
       updated_by = EXCLUDED.updated_by`,
    [
      unit.orgId,
      unit.id,
      unit.parentId,
      unit.name,
      unit.kind,
      unit.status,
      unit.sortOrder,
      unit.createdAt,
      unit.updatedAt,
      unit.createdBy,
      unit.updatedBy,
    ],
  );
  if (unit.parentId !== null) {
    const cycle = await exec(
      `SELECT 1 FROM org_unit_closure WHERE org_id = $1 AND ancestor_id = $2 AND descendant_id = $3 LIMIT 1`,
      [unit.orgId, unit.id, unit.parentId],
    );
    if (cycle.rows.length > 0) {
      throw new Error(`org unit cycle: ${unit.parentId} is a descendant of ${unit.id}`);
    }
  }
  await exec(
    `INSERT INTO org_unit_closure (org_id, ancestor_id, descendant_id, depth) VALUES ($1, $2, $2, 0)
     ON CONFLICT (org_id, ancestor_id, descendant_id) DO NOTHING`,
    [unit.orgId, unit.id],
  );
  await relinkClosure(exec, unit.orgId, unit.id, unit.parentId);
}

async function moveUnitSubtreeOn(exec: Exec, orgId: string, unitId: string, newParentId: string): Promise<void> {
  const locked = await exec(`SELECT id FROM org_units WHERE org_id = $1 AND id IN ($2, $3) ORDER BY id FOR UPDATE`, [
    orgId,
    unitId,
    newParentId,
  ]);
  if (!locked.rows.some((r) => r.id === unitId)) {
    throw new Error(`org unit not found: ${unitId}`);
  }
  const cycle = await exec(
    `SELECT 1 FROM org_unit_closure WHERE org_id = $1 AND ancestor_id = $2 AND descendant_id = $3 LIMIT 1`,
    [orgId, unitId, newParentId],
  );
  if (cycle.rows.length > 0) {
    throw new Error(`org unit cycle: cannot move ${unitId} under its descendant ${newParentId}`);
  }
  await exec(`UPDATE org_units SET parent_id = $3 WHERE org_id = $1 AND id = $2`, [orgId, unitId, newParentId]);
  await relinkClosure(exec, orgId, unitId, newParentId);
}

async function putUnitMemberOn(exec: Exec, m: OrgUnitMember): Promise<void> {
  await exec(
    `INSERT INTO org_unit_members (${UNIT_MEMBER_COLUMNS})
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (org_id, unit_id, principal_id)
     DO UPDATE SET
       role = EXCLUDED.role,
       is_primary = EXCLUDED.is_primary,
       created_at = EXCLUDED.created_at,
       created_by = EXCLUDED.created_by`,
    [m.orgId, m.unitId, m.principalId, m.role, m.isPrimary === true, m.createdAt, m.createdBy],
  );
}

async function removeUnitMemberOn(exec: Exec, orgId: string, unitId: string, principalId: string): Promise<void> {
  await exec(`DELETE FROM org_unit_members WHERE org_id = $1 AND unit_id = $2 AND principal_id = $3`, [
    orgId,
    unitId,
    principalId,
  ]);
}

async function putGroupOn(exec: Exec, g: AccessGroup): Promise<void> {
  await exec(
    `INSERT INTO access_groups (${GROUP_COLUMNS})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (org_id, id)
     DO UPDATE SET
       name = EXCLUDED.name,
       status = EXCLUDED.status,
       created_at = EXCLUDED.created_at,
       updated_at = EXCLUDED.updated_at,
       created_by = EXCLUDED.created_by,
       updated_by = EXCLUDED.updated_by`,
    [g.orgId, g.id, g.name, g.status, g.createdAt, g.updatedAt, g.createdBy, g.updatedBy],
  );
}

async function putGroupMemberOn(exec: Exec, m: AccessGroupMember): Promise<void> {
  await exec(
    `INSERT INTO access_group_members (${GROUP_MEMBER_COLUMNS})
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (org_id, group_id, principal_id)
     DO UPDATE SET role = EXCLUDED.role, created_at = EXCLUDED.created_at, created_by = EXCLUDED.created_by`,
    [m.orgId, m.groupId, m.principalId, m.role, m.createdAt, m.createdBy],
  );
}

async function removeGroupMemberOn(exec: Exec, orgId: string, groupId: string, principalId: string): Promise<void> {
  await exec(`DELETE FROM access_group_members WHERE org_id = $1 AND group_id = $2 AND principal_id = $3`, [
    orgId,
    groupId,
    principalId,
  ]);
}

async function getDirectoryPolicyOn(
  exec: Exec,
  orgId: string,
  subjectKind: DirectorySubjectKind,
  subjectId: string,
): Promise<DirectoryViewPolicy | null> {
  const res = await exec(
    `SELECT ${DIRECTORY_POLICY_COLUMNS}
       FROM directory_view_policies
      WHERE org_id = $1 AND subject_kind = $2 AND subject_id = $3`,
    [orgId, subjectKind, subjectId],
  );
  return res.rows[0] ? rowToDirectoryPolicy(res.rows[0]) : null;
}

async function putDirectoryPolicyOn(exec: Exec, policy: DirectoryViewPolicy): Promise<void> {
  await exec(
    `INSERT INTO directory_view_policies (${DIRECTORY_POLICY_COLUMNS})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (org_id, subject_kind, subject_id)
     DO UPDATE SET
       mode = EXCLUDED.mode,
       revision = EXCLUDED.revision,
       updated_at = EXCLUDED.updated_at,
       updated_by = EXCLUDED.updated_by`,
    [
      policy.id,
      policy.orgId,
      policy.subjectKind,
      policy.subjectId,
      policy.mode,
      policy.revision,
      policy.createdAt,
      policy.updatedAt,
      policy.updatedBy,
    ],
  );
}

async function deleteDirectoryPolicyOn(
  exec: Exec,
  orgId: string,
  subjectKind: DirectorySubjectKind,
  subjectId: string,
): Promise<void> {
  await exec(`DELETE FROM directory_view_policies WHERE org_id = $1 AND subject_kind = $2 AND subject_id = $3`, [
    orgId,
    subjectKind,
    subjectId,
  ]);
}

async function listDirectoryRootsOn(exec: Exec, orgId: string, policyId: string): Promise<DirectoryViewRoot[]> {
  const res = await exec(
    `SELECT ${DIRECTORY_ROOT_COLUMNS}
       FROM directory_view_roots
      WHERE org_id = $1 AND policy_id = $2
      ORDER BY unit_id`,
    [orgId, policyId],
  );
  return res.rows.map(rowToDirectoryRoot);
}

async function replaceDirectoryRootsOn(
  exec: Exec,
  orgId: string,
  policyId: string,
  roots: readonly DirectoryViewRoot[],
): Promise<void> {
  await exec(`DELETE FROM directory_view_roots WHERE org_id = $1 AND policy_id = $2`, [orgId, policyId]);
  for (const root of roots) {
    await exec(`INSERT INTO directory_view_roots (${DIRECTORY_ROOT_COLUMNS}) VALUES ($1, $2, $3, $4)`, [
      orgId,
      policyId,
      root.unitId,
      root.includeDescendants,
    ]);
  }
}

async function getSkillOn(exec: Exec, orgId: string, skillId: string): Promise<Skill | null> {
  const res = await exec(`SELECT json FROM skills WHERE id = $1 AND (json ->> 'orgId' = $2 OR NOT(json ? 'orgId'))`, [
    skillId,
    orgId,
  ]);
  return res.rows[0] ? (res.rows[0].json as Skill) : null;
}

async function listSkillsOn(exec: Exec, orgId: string): Promise<Skill[]> {
  const res = await exec(`SELECT json FROM skills WHERE json ->> 'orgId' = $1 OR NOT(json ? 'orgId') ORDER BY id`, [
    orgId,
  ]);
  return res.rows.map((row) => row.json as Skill);
}

async function putSkillOn(exec: Exec, skill: Skill): Promise<void> {
  await exec(
    `INSERT INTO durable_map_versions(tbl, v) VALUES('skills', 1)
     ON CONFLICT(tbl) DO UPDATE SET v = durable_map_versions.v + 1`,
  );
  await exec(`SELECT set_config('qm.skill_access_writer', 'transactional', TRUE)`);
  await exec(
    `INSERT INTO skills(id, json) VALUES($1, $2)
     ON CONFLICT(id) DO UPDATE SET json = EXCLUDED.json`,
    [skill.id, jsonbStringify(skill)],
  );
}

async function deleteSkillOn(exec: Exec, orgId: string, skillId: string): Promise<void> {
  await exec(`INSERT INTO durable_map_versions(tbl, v) VALUES('skills', 0) ON CONFLICT(tbl) DO NOTHING`);
  await exec(`SELECT v FROM durable_map_versions WHERE tbl = 'skills' FOR UPDATE`);
  await exec(`SELECT set_config('qm.skill_access_writer', 'transactional', TRUE)`);
  const removed = await exec(`DELETE FROM skills WHERE id = $1 AND json ->> 'orgId' = $2`, [skillId, orgId]);
  if (removed.rowCount > 0) {
    await exec(`UPDATE durable_map_versions SET v = v + 1 WHERE tbl = 'skills'`);
  }
}

async function getSkillAccessPolicyOn(exec: Exec, orgId: string, skillId: string): Promise<SkillAccessPolicy | null> {
  const res = await exec(
    `SELECT ${SKILL_ACCESS_POLICY_COLUMNS} FROM skill_access_policies WHERE org_id = $1 AND skill_id = $2`,
    [orgId, skillId],
  );
  return res.rows[0] ? rowToSkillAccessPolicy(res.rows[0]) : null;
}

async function listSkillAccessPoliciesOn(exec: Exec, orgId: string): Promise<SkillAccessPolicy[]> {
  const res = await exec(
    `SELECT ${SKILL_ACCESS_POLICY_COLUMNS} FROM skill_access_policies WHERE org_id = $1 ORDER BY skill_id`,
    [orgId],
  );
  return res.rows.map(rowToSkillAccessPolicy);
}

async function putSkillAccessPolicyOn(exec: Exec, policy: SkillAccessPolicy): Promise<void> {
  await exec(
    `INSERT INTO skill_access_policies(${SKILL_ACCESS_POLICY_COLUMNS}) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT(org_id, skill_id) DO UPDATE SET
       owner_scope_id = EXCLUDED.owner_scope_id,
       mode = EXCLUDED.mode,
       revision = EXCLUDED.revision,
       updated_at = EXCLUDED.updated_at,
       updated_by = EXCLUDED.updated_by`,
    [
      policy.orgId,
      policy.skillId,
      policy.ownerScopeId,
      policy.mode,
      policy.revision,
      policy.createdAt,
      policy.updatedAt,
      policy.updatedBy,
    ],
  );
}

async function deleteSkillAccessPolicyOn(exec: Exec, orgId: string, skillId: string): Promise<void> {
  await exec(`DELETE FROM skill_access_policies WHERE org_id = $1 AND skill_id = $2`, [orgId, skillId]);
}

async function listSkillAccessGrantsOn(exec: Exec, orgId: string, skillId: string): Promise<SkillAccessGrant[]> {
  const res = await exec(
    `SELECT ${SKILL_ACCESS_GRANT_COLUMNS}
       FROM acl_grants
      WHERE (org_id = $1 OR org_id IS NULL) AND path = $2
      ORDER BY grantee_scope_id, permission`,
    [orgId, `skill:${skillId}`],
  );
  return res.rows.map(rowToSkillAccessGrant);
}

async function replaceSkillAccessGrantsOn(
  exec: Exec,
  orgId: string,
  skillId: string,
  grants: readonly SkillAccessGrant[],
): Promise<void> {
  const path = `skill:${skillId}`;
  for (const grant of grants) {
    if (grant.orgId !== orgId || grant.path !== path) throw new Error("skill access grant scope mismatch");
  }
  const lockedOwners = await exec(
    `SELECT owner_scope_id FROM acl_grants
      WHERE (org_id = $1 OR org_id IS NULL) AND path = $2
     UNION
     SELECT owner_scope_id FROM skill_access_policies WHERE org_id = $1 AND skill_id = $3`,
    [orgId, path, skillId],
  );
  const ownerScopeIds = [
    ...new Set([
      ...lockedOwners.rows.map((row) => String(row.owner_scope_id)),
      ...grants.map((grant) => grant.ownerScopeId),
    ]),
  ].sort();
  if (ownerScopeIds.length === 0) throw new Error("skill access policy not found");
  for (const ownerScopeId of ownerScopeIds) {
    await exec(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`acl-grants:${ownerScopeId}\n${path}`]);
  }
  await exec(`SELECT set_config('qm.skill_access_writer', 'transactional', TRUE)`);
  await exec(`DELETE FROM acl_grants WHERE (org_id = $1 OR org_id IS NULL) AND path = $2`, [orgId, path]);
  for (const grant of grants) {
    await exec(`INSERT INTO acl_grants(${SKILL_ACCESS_GRANT_COLUMNS}) VALUES($1,$2,$3,$4,$5,$6,$7)`, [
      grant.orgId,
      grant.ownerScopeId,
      grant.path,
      grant.granteeScopeId,
      grant.permission,
      grant.grantedBy,
      grant.grantedAt,
    ]);
  }
}

async function countSkillAccessGrantsForSubjectOn(exec: Exec, orgId: string, granteeScopeId: ScopeId): Promise<number> {
  const res = await exec(
    `SELECT count(*) AS total FROM acl_grants
      WHERE (org_id = $1 OR org_id IS NULL) AND path LIKE 'skill:%' AND grantee_scope_id = $2`,
    [orgId, granteeScopeId],
  );
  return Number(res.rows[0]!.total);
}

async function bumpRevisionOn(exec: Exec, orgId: string): Promise<number> {
  const res = await exec(
    `INSERT INTO organization_authz_state (org_id, revision, updated_at) VALUES ($1, 2, $2)
     ON CONFLICT (org_id) DO UPDATE SET revision = organization_authz_state.revision + 1, updated_at = $2
     RETURNING revision`,
    [orgId, Date.now()],
  );
  return Number(res.rows[0]!.revision);
}

async function lockOrgOn(exec: Exec, orgId: string): Promise<void> {
  await exec(`SELECT pg_advisory_xact_lock(hashtext('organization-authz'), hashtext($1))`, [orgId]);
}

async function lockDatabaseOwnerOn(exec: Exec): Promise<void> {
  await exec(`SELECT pg_advisory_xact_lock(hashtext('organization-database-owner'))`);
}

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

async function withOrganizationTransaction<T>(
  pool: Pool,
  orgId: string,
  fn: (exec: Exec, client: PoolClient) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await withPgTransaction(pool, async (client) => {
        const exec = clientExec(client);
        await lockDatabaseOwnerOn(exec);
        await lockOrgOn(exec, orgId);
        await exec(`SET LOCAL lock_timeout = '100ms'`);
        return fn(exec, client);
      });
    } catch (error) {
      lastError = error;
      const code = postgresErrorCode(error);
      if ((code !== "55P03" && code !== "40P01") || attempt === 4) throw error;
      await sleep(attempt * 10);
    }
  }
  throw lastError;
}

async function getUserOn(exec: Exec, orgId: string, principalId: string): Promise<OrganizationUser | null> {
  const res = await exec(
    `SELECT ${USER_COLUMNS}
       FROM organization_users
      WHERE org_id = $1
        AND (principal_id = $2 OR (position('@' IN $2) > 0 AND lower(principal_id) = lower($2)))
      ORDER BY (principal_id = $2) DESC
      LIMIT 1`,
    [orgId, principalId],
  );
  return res.rows[0] ? rowToUser(res.rows[0]) : null;
}

async function findUserByEmailOn(exec: Exec, orgId: string, email: string): Promise<OrganizationUser | null> {
  const res = await exec(
    `SELECT ${USER_COLUMNS} FROM organization_users WHERE org_id = $1 AND lower(email) = lower($2)`,
    [orgId, email],
  );
  return res.rows[0] ? rowToUser(res.rows[0]) : null;
}

async function getIdentityOn(exec: Exec, orgId: string, issuer: string, subject: string): Promise<AuthIdentity | null> {
  const res = await exec(
    `SELECT ${IDENTITY_COLUMNS} FROM auth_identities WHERE org_id = $1 AND issuer = $2 AND subject = $3`,
    [orgId, issuer, subject],
  );
  return res.rows[0] ? rowToIdentity(res.rows[0]) : null;
}

async function listIdentitiesOn(exec: Exec, orgId: string): Promise<AuthIdentity[]> {
  const res = await exec(`SELECT ${IDENTITY_COLUMNS} FROM auth_identities WHERE org_id = $1 ORDER BY issuer, subject`, [
    orgId,
  ]);
  return res.rows.map(rowToIdentity);
}

async function listIdentitiesForUserOn(exec: Exec, orgId: string, principalId: string): Promise<AuthIdentity[]> {
  const res = await exec(
    `SELECT ${IDENTITY_COLUMNS}
       FROM auth_identities
      WHERE org_id = $1 AND principal_id = $2
      ORDER BY issuer, subject`,
    [orgId, principalId],
  );
  return res.rows.map(rowToIdentity);
}

async function getUnitOn(exec: Exec, orgId: string, id: string): Promise<OrgUnit | null> {
  const res = await exec(`SELECT ${UNIT_COLUMNS} FROM org_units WHERE org_id = $1 AND id = $2`, [orgId, id]);
  return res.rows[0] ? rowToUnit(res.rows[0]) : null;
}

async function listUnitsOn(exec: Exec, orgId: string): Promise<OrgUnit[]> {
  const res = await exec(`SELECT ${UNIT_COLUMNS} FROM org_units WHERE org_id = $1 ORDER BY sort_order, id`, [orgId]);
  return res.rows.map(rowToUnit);
}

async function isDescendantOn(exec: Exec, orgId: string, ancestorId: string, descendantId: string): Promise<boolean> {
  const res = await exec(
    `SELECT 1 FROM org_unit_closure WHERE org_id = $1 AND ancestor_id = $2 AND descendant_id = $3 LIMIT 1`,
    [orgId, ancestorId, descendantId],
  );
  return res.rows.length > 0;
}

async function listAncestorUnitIdsOn(exec: Exec, orgId: string, unitId: string): Promise<string[]> {
  const res = await exec(
    `SELECT closure.ancestor_id
       FROM org_unit_closure closure
       JOIN org_units unit
         ON unit.org_id = closure.org_id AND unit.id = closure.ancestor_id AND unit.status = 'active'
      WHERE closure.org_id = $1 AND closure.descendant_id = $2
      ORDER BY closure.ancestor_id`,
    [orgId, unitId],
  );
  return res.rows.map((row) => row.ancestor_id as string);
}

async function listDirectUnitIdsForUserOn(exec: Exec, orgId: string, principalId: string): Promise<string[]> {
  const res = await exec(
    `SELECT member.unit_id
       FROM org_unit_members member
       JOIN org_units unit
         ON unit.org_id = member.org_id AND unit.id = member.unit_id AND unit.status = 'active'
      WHERE member.org_id = $1 AND member.principal_id = $2
      ORDER BY member.unit_id`,
    [orgId, principalId],
  );
  return res.rows.map((row) => row.unit_id as string);
}

async function listDirectGroupIdsForUserOn(exec: Exec, orgId: string, principalId: string): Promise<string[]> {
  const res = await exec(
    `SELECT member.group_id
       FROM access_group_members member
       JOIN access_groups target
         ON target.org_id = member.org_id AND target.id = member.group_id AND target.status = 'active'
      WHERE member.org_id = $1 AND member.principal_id = $2
      ORDER BY member.group_id`,
    [orgId, principalId],
  );
  return res.rows.map((row) => row.group_id as string);
}

async function searchDirectoryUsersOn(
  exec: Exec,
  orgId: string,
  input: {
    query: string;
    unitIds: readonly string[] | null;
    excludePrincipalIds?: readonly string[];
    after: DirectoryUserCursor | null;
    limit: number;
  },
): Promise<DirectoryUserPage> {
  if (input.unitIds !== null && input.unitIds.length === 0) return { users: [], next: null };
  const res = await exec(
    `SELECT ${USER_COLUMNS}
       FROM organization_users account
      WHERE account.org_id = $1
        AND account.status = 'active'
        AND (
          $2 = ''
          OR strpos(lower(account.principal_id), lower($2)) > 0
          OR strpos(lower(account.display_name), lower($2)) > 0
          OR strpos(lower(coalesce(account.email, '')), lower($2)) > 0
        )
        AND (
          $3::text[] IS NULL
          OR EXISTS (
            SELECT 1
              FROM org_unit_members member
             WHERE member.org_id = account.org_id
               AND member.principal_id = account.principal_id
               AND member.unit_id = ANY($3::text[])
          )
        )
        AND (
          $4::text IS NULL
          OR (lower(account.display_name), account.principal_id) > (lower($4), $5)
        )
        AND (
          $6::text[] IS NULL
          OR account.principal_id <> ALL($6::text[])
        )
      ORDER BY lower(account.display_name), account.principal_id
      LIMIT $7`,
    [
      orgId,
      input.query,
      input.unitIds,
      input.after?.displayName ?? null,
      input.after?.principalId ?? null,
      input.excludePrincipalIds?.length ? input.excludePrincipalIds : null,
      input.limit + 1,
    ],
  );
  const users = res.rows.slice(0, input.limit).map(rowToUser);
  const last = users.at(-1);
  return {
    users,
    next:
      res.rows.length > input.limit && last ? { displayName: last.displayName, principalId: last.principalId } : null,
  };
}

async function listManagedSubtreeUnitIdsOn(exec: Exec, orgId: string, principalId: string): Promise<string[]> {
  const res = await exec(
    `SELECT DISTINCT c.descendant_id
       FROM org_unit_members m
       JOIN org_units managed ON managed.org_id = m.org_id AND managed.id = m.unit_id AND managed.status = 'active'
       JOIN org_unit_closure c ON c.org_id = m.org_id AND c.ancestor_id = m.unit_id
       JOIN org_units child ON child.org_id = c.org_id AND child.id = c.descendant_id AND child.status = 'active'
      WHERE m.org_id = $1 AND m.principal_id = $2 AND m.role = 'manager'
      ORDER BY c.descendant_id`,
    [orgId, principalId],
  );
  return res.rows.map((r) => r.descendant_id as string);
}

async function listManagedGroupIdsOn(exec: Exec, orgId: string, principalId: string): Promise<string[]> {
  const res = await exec(
    `SELECT m.group_id
       FROM access_group_members m
       JOIN access_groups g ON g.org_id = m.org_id AND g.id = m.group_id AND g.status = 'active'
      WHERE m.org_id = $1 AND m.principal_id = $2 AND m.role = 'manager'
      ORDER BY m.group_id`,
    [orgId, principalId],
  );
  return res.rows.map((row) => row.group_id as string);
}

async function unitImpactOn(exec: Exec, orgId: string, unitId: string): Promise<UnitImpact> {
  const res = await exec(
    `SELECT
       (SELECT count(*) FROM org_units WHERE org_id = $1 AND parent_id = $2 AND status = 'active') AS active_child_units,
       (SELECT count(*) FROM org_unit_members m
          JOIN organization_users u ON u.org_id = m.org_id AND u.principal_id = m.principal_id
         WHERE m.org_id = $1 AND m.unit_id = $2 AND u.status <> 'deprovisioned') AS active_members,
       ((SELECT count(*) FROM directory_view_roots root WHERE root.org_id = $1 AND root.unit_id = $2)
         + (SELECT count(*) FROM directory_view_policies policy
             WHERE policy.org_id = $1 AND policy.subject_kind = 'org_unit' AND policy.subject_id = $2)) AS directory_roots,
       ((SELECT count(*) FROM acl_grants grant_row
          WHERE grant_row.org_id = $1
            AND (grant_row.owner_scope_id = 'org-unit:' || $2
              OR grant_row.grantee_scope_id = 'org-unit:' || $2))
        + (SELECT count(*) FROM skill_access_policies policy
          WHERE policy.org_id = $1
            AND policy.owner_scope_id = 'org-unit:' || $2)) AS access_grants`,
    [orgId, unitId],
  );
  return {
    activeChildUnits: Number(res.rows[0]!.active_child_units),
    activeMembers: Number(res.rows[0]!.active_members),
    directoryRoots: Number(res.rows[0]!.directory_roots),
    accessGrants: Number(res.rows[0]!.access_grants),
  };
}

async function subtreeImpactOn(exec: Exec, orgId: string, unitId: string): Promise<SubtreeImpact> {
  const res = await exec(
    `SELECT
       count(DISTINCT child.id) FILTER (WHERE child.status = 'active') AS active_units,
       count(DISTINCT member.principal_id) FILTER (WHERE member_user.status = 'active') AS active_members
       FROM org_unit_closure closure
       JOIN org_units child
         ON child.org_id = closure.org_id AND child.id = closure.descendant_id
       LEFT JOIN org_unit_members member
         ON member.org_id = closure.org_id AND member.unit_id = closure.descendant_id
       LEFT JOIN organization_users member_user
         ON member_user.org_id = member.org_id AND member_user.principal_id = member.principal_id
      WHERE closure.org_id = $1 AND closure.ancestor_id = $2`,
    [orgId, unitId],
  );
  return {
    activeUnits: Number(res.rows[0]!.active_units),
    activeMembers: Number(res.rows[0]!.active_members),
  };
}

async function listUnitMembersOn(exec: Exec, orgId: string, unitId: string): Promise<OrgUnitMember[]> {
  const res = await exec(
    `SELECT ${UNIT_MEMBER_COLUMNS} FROM org_unit_members WHERE org_id = $1 AND unit_id = $2 ORDER BY principal_id`,
    [orgId, unitId],
  );
  return res.rows.map(rowToUnitMember);
}

async function listUnitMembersForUserOn(exec: Exec, orgId: string, principalId: string): Promise<OrgUnitMember[]> {
  const res = await exec(
    `SELECT ${UNIT_MEMBER_COLUMNS} FROM org_unit_members WHERE org_id = $1 AND principal_id = $2 ORDER BY unit_id`,
    [orgId, principalId],
  );
  return res.rows.map(rowToUnitMember);
}

async function getGroupOn(exec: Exec, orgId: string, id: string): Promise<AccessGroup | null> {
  const res = await exec(`SELECT ${GROUP_COLUMNS} FROM access_groups WHERE org_id = $1 AND id = $2`, [orgId, id]);
  return res.rows[0] ? rowToGroup(res.rows[0]) : null;
}

async function listGroupMembersOn(exec: Exec, orgId: string, groupId: string): Promise<AccessGroupMember[]> {
  const res = await exec(
    `SELECT ${GROUP_MEMBER_COLUMNS} FROM access_group_members WHERE org_id = $1 AND group_id = $2 ORDER BY principal_id`,
    [orgId, groupId],
  );
  return res.rows.map(rowToGroupMember);
}

async function listGroupMembersForUserOn(exec: Exec, orgId: string, principalId: string): Promise<AccessGroupMember[]> {
  const res = await exec(
    `SELECT ${GROUP_MEMBER_COLUMNS} FROM access_group_members WHERE org_id = $1 AND principal_id = $2 ORDER BY group_id`,
    [orgId, principalId],
  );
  return res.rows.map(rowToGroupMember);
}

function organizationDatabaseOwnerBindingSql(orgId: string): string {
  const configuredOrgId = orgId.replaceAll("'", "''");
  return `DO $do$
   DECLARE configured_org_id TEXT := '${configuredOrgId}';
   DECLARE owner_org_id TEXT;
   DECLARE observed_org_id TEXT;
   BEGIN
     PERFORM pg_advisory_xact_lock(hashtext('organization-database-owner'));
     SELECT org_id INTO owner_org_id FROM organization_database_owner WHERE singleton;
     IF owner_org_id IS NOT NULL AND owner_org_id <> configured_org_id THEN
       RAISE EXCEPTION 'organization database already belongs to %', owner_org_id USING ERRCODE = '23514';
     END IF;
     SELECT org_id INTO observed_org_id
       FROM (
         SELECT org_id FROM organization_users
         UNION ALL SELECT org_id FROM auth_identities
         UNION ALL SELECT org_id FROM org_units
         UNION ALL SELECT org_id FROM organization_authz_state
         UNION ALL SELECT org_id FROM access_groups
         UNION ALL SELECT org_id FROM directory_view_policies
         UNION ALL SELECT org_id FROM skill_access_policies
         UNION ALL SELECT org_id FROM acl_grants WHERE org_id IS NOT NULL
         UNION ALL SELECT json ->> 'orgId' AS org_id FROM skills WHERE json ? 'orgId'
       ) organizations
      WHERE org_id <> configured_org_id
      LIMIT 1;
     IF observed_org_id IS NOT NULL THEN
       RAISE EXCEPTION 'organization database contains data for %', observed_org_id USING ERRCODE = '23514';
     END IF;
     INSERT INTO organization_database_owner(singleton, org_id)
     VALUES(TRUE, configured_org_id)
     ON CONFLICT (singleton) DO NOTHING;
   END
   $do$`;
}

function skillAccessColumnMigrationSql(orgId: string): string {
  const configuredOrgId = orgId.replaceAll("'", "''");
  return `DO $do$
   DECLARE configured_org_id TEXT := '${configuredOrgId}';
   BEGIN
     UPDATE skills
        SET json = jsonb_set(json, '{orgId}', to_jsonb(configured_org_id))
      WHERE NOT(json ? 'orgId');
     UPDATE acl_grants SET org_id = configured_org_id WHERE org_id IS NULL;
     UPDATE acl_grants SET granted_at = 0 WHERE granted_at IS NULL;
   END
   $do$`;
}

export function createPostgresOrganizationStore(
  connectionString: string,
  opts: { auditLog?: PostgresAuditLog; exclusiveOrgId?: string } = {},
): OrganizationStore {
  const pg = createPgPool(connectionString, [
    ...SCHEMA_SQL,
    ...(opts.exclusiveOrgId ? [organizationDatabaseOwnerBindingSql(opts.exclusiveOrgId)] : []),
    ...(opts.exclusiveOrgId ? [skillAccessColumnMigrationSql(opts.exclusiveOrgId)] : []),
    ORGANIZATION_CLOSURE_MIGRATION_SQL,
    ORGANIZATION_LEGACY_RUNTIME_ELIGIBILITY_SQL,
    ORGANIZATION_IDENTITY_PROJECTION_MIGRATION_SQL,
  ]);
  function assertExclusiveOrg(orgId: string): void {
    if (opts.exclusiveOrgId && orgId !== opts.exclusiveOrgId) {
      throw new Error(`organization store is bound to ${opts.exclusiveOrgId}`);
    }
  }
  const mutate = async <T>(orgId: string, fn: (exec: Exec) => Promise<T>): Promise<T> => {
    assertExclusiveOrg(orgId);
    return withOrganizationTransaction(await pg.pool(), orgId, fn);
  };

  return {
    async legacyRuntimeAccessEligible(principalId) {
      const key = principalId.includes("@") ? principalId.toLowerCase() : principalId;
      const rows = await pg.q(`SELECT 1 FROM organization_legacy_runtime_eligible WHERE person_key = $1 LIMIT 1`, [
        key,
      ]);
      return rows.length > 0;
    },
    async getUser(orgId, principalId) {
      return getUserOn(pg.query, orgId, principalId);
    },
    async findUserByEmail(orgId, email) {
      return findUserByEmailOn(pg.query, orgId, email);
    },
    async findUserByEmployeeNumber(orgId, employeeNumber) {
      const rows = await pg.q(
        `SELECT ${USER_COLUMNS} FROM organization_users WHERE org_id = $1 AND lower(employee_number) = lower($2) LIMIT 1`,
        [orgId, employeeNumber],
      );
      return rows[0] ? rowToUser(rows[0]) : null;
    },
    async listUsers(orgId) {
      const rows = await pg.q(
        `SELECT ${USER_COLUMNS} FROM organization_users WHERE org_id = $1 ORDER BY principal_id`,
        [orgId],
      );
      return rows.map(rowToUser);
    },
    async getUsersByPrincipalIds(orgId, principalIds) {
      if (principalIds.length === 0) return [];
      const rows = await pg.q(
        `SELECT ${USER_COLUMNS}
           FROM organization_users
          WHERE org_id = $1
            AND (principal_id = ANY($2::text[]) OR lower(principal_id) = ANY($3::text[]))
          ORDER BY principal_id`,
        [orgId, principalIds, principalIds.filter((id) => id.includes("@")).map((id) => id.toLowerCase())],
      );
      return rows.map(rowToUser);
    },
    async listOrganizationUsers(orgId, input) {
      const params: unknown[] = [orgId, input.statuses];
      const where = ["u.org_id = $1", "u.status = ANY($2::text[])"];
      const addParam = (value: unknown): string => {
        params.push(value);
        return `$${params.length}`;
      };
      const query = input.query.trim();
      if (query) {
        const ref = addParam(query);
        where.push(`(
          strpos(lower(u.principal_id), lower(${ref})) > 0
          OR strpos(lower(u.display_name), lower(${ref})) > 0
          OR strpos(lower(coalesce(u.email, '')), lower(${ref})) > 0
          OR strpos(lower(coalesce(u.job_title, '')), lower(${ref})) > 0
          OR strpos(lower(coalesce(u.mobile, '')), lower(${ref})) > 0
          OR strpos(lower(coalesce(u.employee_number, '')), lower(${ref})) > 0
        )`);
      }
      if (input.unitId !== undefined) {
        const ref = addParam(input.unitId);
        where.push(
          input.includeDescendants
            ? `EXISTS (
                SELECT 1
                  FROM org_unit_members member
                  JOIN org_unit_closure closure
                    ON closure.org_id = member.org_id AND closure.descendant_id = member.unit_id
                 WHERE member.org_id = u.org_id
                   AND member.principal_id = u.principal_id
                   AND closure.ancestor_id = ${ref}
              )`
            : `EXISTS (
                SELECT 1
                  FROM org_unit_members member
                 WHERE member.org_id = u.org_id
                   AND member.principal_id = u.principal_id
                   AND member.unit_id = ${ref}
              )`,
        );
      }
      if (input.groupId !== undefined) {
        const ref = addParam(input.groupId);
        where.push(`EXISTS (
          SELECT 1
            FROM access_group_members member
           WHERE member.org_id = u.org_id
             AND member.principal_id = u.principal_id
             AND member.group_id = ${ref}
        )`);
      }
      if (input.missingPrimaryUnit === true) {
        where.push(`NOT EXISTS (
          SELECT 1
            FROM org_unit_members member
           WHERE member.org_id = u.org_id
             AND member.principal_id = u.principal_id
             AND member.is_primary
        )`);
      }
      if (input.after) {
        const nameRef = addParam(input.after.displayName.toLowerCase());
        const idRef = addParam(input.after.principalId);
        where.push(`(lower(u.display_name), u.principal_id) > (${nameRef}, ${idRef})`);
      }
      const limitRef = addParam(input.limit + 1);
      const selectedColumns = USER_COLUMNS.split(", ")
        .map((column) => `u.${column}`)
        .join(", ");
      const rows = await pg.q(
        `SELECT ${selectedColumns}
           FROM organization_users u
          WHERE ${where.join(" AND ")}
          ORDER BY lower(u.display_name), u.principal_id
          LIMIT ${limitRef}`,
        params,
      );
      const users = rows.slice(0, input.limit).map(rowToUser);
      const principalIds = users.map((user) => user.principalId);
      const [unitMembers, groupMembers] = await Promise.all([
        principalIds.length === 0
          ? Promise.resolve([])
          : pg
              .q(
                `SELECT ${UNIT_MEMBER_COLUMNS}
                   FROM org_unit_members
                  WHERE org_id = $1 AND principal_id = ANY($2::text[])
                  ORDER BY principal_id, unit_id`,
                [orgId, principalIds],
              )
              .then((items) => items.map(rowToUnitMember)),
        principalIds.length === 0
          ? Promise.resolve([])
          : pg
              .q(
                `SELECT ${GROUP_MEMBER_COLUMNS}
                   FROM access_group_members
                  WHERE org_id = $1 AND principal_id = ANY($2::text[])
                  ORDER BY principal_id, group_id`,
                [orgId, principalIds],
              )
              .then((items) => items.map(rowToGroupMember)),
      ]);
      const last = users.at(-1);
      return {
        users,
        unitMembers,
        groupMembers,
        next:
          rows.length > input.limit && last ? { displayName: last.displayName, principalId: last.principalId } : null,
      };
    },
    async searchUsers(orgId, query, limit) {
      const rows = await pg.q(
        `SELECT ${USER_COLUMNS}
           FROM organization_users
          WHERE org_id = $1
            AND status = 'active'
            AND (
              strpos(lower(principal_id), lower($2)) > 0
              OR strpos(lower(display_name), lower($2)) > 0
              OR strpos(lower(coalesce(email, '')), lower($2)) > 0
            )
          ORDER BY
            CASE
              WHEN lower(principal_id) = lower($2) OR lower(coalesce(email, '')) = lower($2) THEN 0
              WHEN strpos(lower(principal_id), lower($2)) = 1 OR strpos(lower(display_name), lower($2)) = 1 THEN 1
              ELSE 2
            END,
            lower(display_name),
            principal_id
          LIMIT $3`,
        [orgId, query, limit],
      );
      return rows.map(rowToUser);
    },
    async putUser(u) {
      await mutate(u.orgId, (exec) => putUserOn(exec, u));
    },
    async getIdentity(orgId, issuer, subject) {
      return getIdentityOn(pg.query, orgId, issuer, subject);
    },
    async listIdentities(orgId) {
      return listIdentitiesOn(pg.query, orgId);
    },
    async listIdentitiesForUser(orgId, principalId) {
      return listIdentitiesForUserOn(pg.query, orgId, principalId);
    },
    async putIdentity(i) {
      await mutate(i.orgId, (exec) => putIdentityOn(exec, i));
    },
    async getUnit(orgId, id) {
      return getUnitOn(pg.query, orgId, id);
    },
    async listUnits(orgId) {
      return listUnitsOn(pg.query, orgId);
    },
    async putUnit(unit) {
      await mutate(unit.orgId, (exec) => putUnitOn(exec, unit));
    },
    async isDescendant(orgId, ancestorId, descendantId) {
      return isDescendantOn(pg.query, orgId, ancestorId, descendantId);
    },
    async listSubtreeUnitIds(orgId, unitId) {
      const rows = await pg.q(
        `SELECT descendant_id FROM org_unit_closure WHERE org_id = $1 AND ancestor_id = $2 ORDER BY descendant_id`,
        [orgId, unitId],
      );
      return rows.map((r) => r.descendant_id as string);
    },
    async listAncestorUnitIds(orgId, unitId) {
      return listAncestorUnitIdsOn(pg.query, orgId, unitId);
    },
    async listDirectUnitIdsForUser(orgId, principalId) {
      return listDirectUnitIdsForUserOn(pg.query, orgId, principalId);
    },
    async listManagedSubtreeUnitIds(orgId, principalId) {
      return listManagedSubtreeUnitIdsOn(pg.query, orgId, principalId);
    },
    async listManagedGroupIds(orgId, principalId) {
      return listManagedGroupIdsOn(pg.query, orgId, principalId);
    },
    async listDirectGroupIdsForUser(orgId, principalId) {
      return listDirectGroupIdsForUserOn(pg.query, orgId, principalId);
    },
    async unitImpact(orgId, unitId): Promise<UnitImpact> {
      return unitImpactOn(pg.query, orgId, unitId);
    },
    async subtreeImpact(orgId, unitId): Promise<SubtreeImpact> {
      return subtreeImpactOn(pg.query, orgId, unitId);
    },
    async listUnitMembers(orgId, unitId) {
      return listUnitMembersOn(pg.query, orgId, unitId);
    },
    async listUnitMembersForUnits(orgId, unitIds) {
      if (unitIds.length === 0) return [];
      const rows = await pg.q(
        `SELECT ${UNIT_MEMBER_COLUMNS}
           FROM org_unit_members
          WHERE org_id = $1 AND unit_id = ANY($2::text[])
          ORDER BY unit_id, principal_id`,
        [orgId, unitIds],
      );
      return rows.map(rowToUnitMember);
    },
    async listUnitMembersForUsers(orgId, principalIds) {
      if (principalIds.length === 0) return [];
      const rows = await pg.q(
        `SELECT ${UNIT_MEMBER_COLUMNS}
           FROM org_unit_members
          WHERE org_id = $1 AND principal_id = ANY($2::text[])
          ORDER BY principal_id, unit_id`,
        [orgId, principalIds],
      );
      return rows.map(rowToUnitMember);
    },
    async putUnitMember(m) {
      await mutate(m.orgId, (exec) => putUnitMemberOn(exec, m));
    },
    async removeUnitMember(orgId, unitId, principalId) {
      await mutate(orgId, (exec) => removeUnitMemberOn(exec, orgId, unitId, principalId));
    },
    async getGroup(orgId, id) {
      return getGroupOn(pg.query, orgId, id);
    },
    async listGroups(orgId) {
      const rows = await pg.q(`SELECT ${GROUP_COLUMNS} FROM access_groups WHERE org_id = $1 ORDER BY id`, [orgId]);
      return rows.map(rowToGroup);
    },
    async putGroup(g) {
      await mutate(g.orgId, (exec) => putGroupOn(exec, g));
    },
    async listGroupMembers(orgId, groupId) {
      return listGroupMembersOn(pg.query, orgId, groupId);
    },
    async listGroupMembersForUsers(orgId, principalIds) {
      if (principalIds.length === 0) return [];
      const rows = await pg.q(
        `SELECT ${GROUP_MEMBER_COLUMNS}
           FROM access_group_members
          WHERE org_id = $1 AND principal_id = ANY($2::text[])
          ORDER BY principal_id, group_id`,
        [orgId, principalIds],
      );
      return rows.map(rowToGroupMember);
    },
    async putGroupMember(m) {
      await mutate(m.orgId, (exec) => putGroupMemberOn(exec, m));
    },
    async removeGroupMember(orgId, groupId, principalId) {
      await mutate(orgId, (exec) => removeGroupMemberOn(exec, orgId, groupId, principalId));
    },
    async getDirectoryPolicy(orgId, subjectKind, subjectId) {
      return getDirectoryPolicyOn(pg.query, orgId, subjectKind, subjectId);
    },
    async listDirectoryRoots(orgId, policyId) {
      return listDirectoryRootsOn(pg.query, orgId, policyId);
    },
    async searchDirectoryUsers(orgId, input) {
      return searchDirectoryUsersOn(pg.query, orgId, input);
    },
    async getSkillAccessPolicy(orgId, skillId) {
      return getSkillAccessPolicyOn(pg.query, orgId, skillId);
    },
    async listSkillAccessPolicies(orgId) {
      return listSkillAccessPoliciesOn(pg.query, orgId);
    },
    async listSkillAccessGrants(orgId, skillId) {
      return listSkillAccessGrantsOn(pg.query, orgId, skillId);
    },
    async getSkillAccessPolicyVersion(orgId) {
      const rows = await pg.q(`SELECT skill_access_policy_version FROM organization_authz_state WHERE org_id = $1`, [
        orgId,
      ]);
      return rows[0] ? Number(rows[0].skill_access_policy_version) : 0;
    },
    async getAuthzRevision(orgId) {
      const rows = await pg.q(`SELECT revision FROM organization_authz_state WHERE org_id = $1`, [orgId]);
      return rows[0] ? Number(rows[0].revision) : 0;
    },
    async ensureOrgRoot({ orgId, name, actor, now }) {
      assertExclusiveOrg(orgId);
      await withOrganizationTransaction(await pg.pool(), orgId, async (exec) => {
        const existing = await exec(
          `SELECT id FROM org_units WHERE org_id = $1 AND parent_id IS NULL AND status = 'active' LIMIT 1`,
          [orgId],
        );
        if (existing.rows.length === 0) {
          await putUnitOn(exec, {
            orgId,
            id: "root",
            parentId: null,
            name,
            kind: "organization",
            status: "active",
            sortOrder: 0,
            createdAt: now,
            updatedAt: now,
            createdBy: actor,
            updatedBy: actor,
          });
        }
        await exec(
          `INSERT INTO organization_authz_state (org_id, revision, updated_at) VALUES ($1, 1, $2)
           ON CONFLICT (org_id) DO NOTHING`,
          [orgId, now],
        );
      });
    },
    async transact(orgId, fn) {
      assertExclusiveOrg(orgId);
      if (opts.auditLog) await opts.auditLog.pool();
      return withOrganizationTransaction(await pg.pool(), orgId, async (exec, client) => {
        const assertOrg = (scopeOrgId: string): void => {
          if (scopeOrgId !== orgId) throw new Error(`organization transaction scope mismatch: ${scopeOrgId}`);
        };
        const tx: OrganizationTx = {
          getUser: (scopeOrgId, principalId) => {
            assertOrg(scopeOrgId);
            return getUserOn(exec, scopeOrgId, principalId);
          },
          findUserByEmail: (scopeOrgId, email) => {
            assertOrg(scopeOrgId);
            return findUserByEmailOn(exec, scopeOrgId, email);
          },
          findUserByEmployeeNumber: async (scopeOrgId, employeeNumber) => {
            assertOrg(scopeOrgId);
            const result = await exec(
              `SELECT ${USER_COLUMNS} FROM organization_users WHERE org_id = $1 AND lower(employee_number) = lower($2) LIMIT 1`,
              [scopeOrgId, employeeNumber],
            );
            return result.rows[0] ? rowToUser(result.rows[0]) : null;
          },
          listUsers: async (scopeOrgId) => {
            assertOrg(scopeOrgId);
            const result = await exec(`SELECT ${USER_COLUMNS} FROM organization_users WHERE org_id = $1`, [scopeOrgId]);
            return result.rows.map(rowToUser);
          },
          putUser: (u) => {
            assertOrg(u.orgId);
            return putUserOn(exec, u);
          },
          insertUser: (u) => {
            assertOrg(u.orgId);
            return insertUserOn(exec, u);
          },
          getIdentity: (scopeOrgId, issuer, subject) => {
            assertOrg(scopeOrgId);
            return getIdentityOn(exec, scopeOrgId, issuer, subject);
          },
          listIdentities: (scopeOrgId) => {
            assertOrg(scopeOrgId);
            return listIdentitiesOn(exec, scopeOrgId);
          },
          listIdentitiesForUser: (scopeOrgId, principalId) => {
            assertOrg(scopeOrgId);
            return listIdentitiesForUserOn(exec, scopeOrgId, principalId);
          },
          putIdentity: (identity) => {
            assertOrg(identity.orgId);
            return putIdentityOn(exec, identity);
          },
          getUnit: (scopeOrgId, id) => {
            assertOrg(scopeOrgId);
            return getUnitOn(exec, scopeOrgId, id);
          },
          listUnits: (scopeOrgId) => {
            assertOrg(scopeOrgId);
            return listUnitsOn(exec, scopeOrgId);
          },
          isDescendant: (scopeOrgId, ancestorId, descendantId) => {
            assertOrg(scopeOrgId);
            return isDescendantOn(exec, scopeOrgId, ancestorId, descendantId);
          },
          listManagedSubtreeUnitIds: (scopeOrgId, principalId) => {
            assertOrg(scopeOrgId);
            return listManagedSubtreeUnitIdsOn(exec, scopeOrgId, principalId);
          },
          listManagedGroupIds: (scopeOrgId, principalId) => {
            assertOrg(scopeOrgId);
            return listManagedGroupIdsOn(exec, scopeOrgId, principalId);
          },
          unitImpact: (scopeOrgId, unitId) => {
            assertOrg(scopeOrgId);
            return unitImpactOn(exec, scopeOrgId, unitId);
          },
          subtreeImpact: (scopeOrgId, unitId) => {
            assertOrg(scopeOrgId);
            return subtreeImpactOn(exec, scopeOrgId, unitId);
          },
          listUnitMembers: (scopeOrgId, unitId) => {
            assertOrg(scopeOrgId);
            return listUnitMembersOn(exec, scopeOrgId, unitId);
          },
          listUnitMembersForUser: (scopeOrgId, principalId) => {
            assertOrg(scopeOrgId);
            return listUnitMembersForUserOn(exec, scopeOrgId, principalId);
          },
          putUnit: (u) => {
            assertOrg(u.orgId);
            return putUnitOn(exec, u);
          },
          moveUnitSubtree: (scopeOrgId, unitId, newParentId) => {
            assertOrg(scopeOrgId);
            return moveUnitSubtreeOn(exec, scopeOrgId, unitId, newParentId);
          },
          putUnitMember: (m) => {
            assertOrg(m.orgId);
            return putUnitMemberOn(exec, m);
          },
          removeUnitMember: (scopeOrgId, unitId, principalId) => {
            assertOrg(scopeOrgId);
            return removeUnitMemberOn(exec, scopeOrgId, unitId, principalId);
          },
          getGroup: (scopeOrgId, id) => {
            assertOrg(scopeOrgId);
            return getGroupOn(exec, scopeOrgId, id);
          },
          listGroupMembers: (scopeOrgId, groupId) => {
            assertOrg(scopeOrgId);
            return listGroupMembersOn(exec, scopeOrgId, groupId);
          },
          listGroupMembersForUser: (scopeOrgId, principalId) => {
            assertOrg(scopeOrgId);
            return listGroupMembersForUserOn(exec, scopeOrgId, principalId);
          },
          putGroup: (g) => {
            assertOrg(g.orgId);
            return putGroupOn(exec, g);
          },
          putGroupMember: (m) => {
            assertOrg(m.orgId);
            return putGroupMemberOn(exec, m);
          },
          removeGroupMember: (scopeOrgId, groupId, principalId) => {
            assertOrg(scopeOrgId);
            return removeGroupMemberOn(exec, scopeOrgId, groupId, principalId);
          },
          getDirectoryPolicy: (scopeOrgId, subjectKind, subjectId) => {
            assertOrg(scopeOrgId);
            return getDirectoryPolicyOn(exec, scopeOrgId, subjectKind, subjectId);
          },
          putDirectoryPolicy: (policy) => {
            assertOrg(policy.orgId);
            return putDirectoryPolicyOn(exec, policy);
          },
          deleteDirectoryPolicy: (scopeOrgId, subjectKind, subjectId) => {
            assertOrg(scopeOrgId);
            return deleteDirectoryPolicyOn(exec, scopeOrgId, subjectKind, subjectId);
          },
          listDirectoryRoots: (scopeOrgId, policyId) => {
            assertOrg(scopeOrgId);
            return listDirectoryRootsOn(exec, scopeOrgId, policyId);
          },
          replaceDirectoryRoots: (scopeOrgId, policyId, roots) => {
            assertOrg(scopeOrgId);
            return replaceDirectoryRootsOn(exec, scopeOrgId, policyId, roots);
          },
          getSkill: (scopeOrgId, skillId) => {
            assertOrg(scopeOrgId);
            return getSkillOn(exec, scopeOrgId, skillId);
          },
          listSkills: (scopeOrgId) => {
            assertOrg(scopeOrgId);
            return listSkillsOn(exec, scopeOrgId);
          },
          putSkill: (skill) => {
            assertOrg(skill.orgId);
            return putSkillOn(exec, skill);
          },
          deleteSkill: (scopeOrgId, skillId) => {
            assertOrg(scopeOrgId);
            return deleteSkillOn(exec, scopeOrgId, skillId);
          },
          getSkillAccessPolicy: (scopeOrgId, skillId) => {
            assertOrg(scopeOrgId);
            return getSkillAccessPolicyOn(exec, scopeOrgId, skillId);
          },
          listSkillAccessPolicies: (scopeOrgId) => {
            assertOrg(scopeOrgId);
            return listSkillAccessPoliciesOn(exec, scopeOrgId);
          },
          putSkillAccessPolicy: (policy) => {
            assertOrg(policy.orgId);
            return putSkillAccessPolicyOn(exec, policy);
          },
          deleteSkillAccessPolicy: (scopeOrgId, skillId) => {
            assertOrg(scopeOrgId);
            return deleteSkillAccessPolicyOn(exec, scopeOrgId, skillId);
          },
          listSkillAccessGrants: (scopeOrgId, skillId) => {
            assertOrg(scopeOrgId);
            return listSkillAccessGrantsOn(exec, scopeOrgId, skillId);
          },
          replaceSkillAccessGrants: (scopeOrgId, skillId, grants) => {
            assertOrg(scopeOrgId);
            return replaceSkillAccessGrantsOn(exec, scopeOrgId, skillId, grants);
          },
          countSkillAccessGrantsForSubject: (scopeOrgId, granteeScopeId) => {
            assertOrg(scopeOrgId);
            return countSkillAccessGrantsForSubjectOn(exec, scopeOrgId, granteeScopeId);
          },
          getSkillAccessPolicyVersion: async (scopeOrgId) => {
            assertOrg(scopeOrgId);
            const state = await exec(
              `SELECT skill_access_policy_version FROM organization_authz_state WHERE org_id = $1`,
              [scopeOrgId],
            );
            return state.rows[0] ? Number(state.rows[0].skill_access_policy_version) : 0;
          },
          markSkillAccessEnforced: async (scopeOrgId, version, at) => {
            assertOrg(scopeOrgId);
            await exec(
              `INSERT INTO organization_authz_state(
                 org_id, revision, skill_access_policy_version, skill_access_enforced_at, updated_at
               ) VALUES($1, 1, $2, $3, $3)
               ON CONFLICT(org_id) DO UPDATE SET
                 skill_access_policy_version = EXCLUDED.skill_access_policy_version,
                 skill_access_enforced_at = EXCLUDED.skill_access_enforced_at,
                 updated_at = EXCLUDED.updated_at`,
              [scopeOrgId, version, at],
            );
          },
          getAuthzRevision: async (scopeOrgId) => {
            assertOrg(scopeOrgId);
            const state = await exec(`SELECT revision FROM organization_authz_state WHERE org_id = $1`, [scopeOrgId]);
            return state.rows[0] ? Number(state.rows[0].revision) : 0;
          },
          bumpRevision: (scopeOrgId) => {
            assertOrg(scopeOrgId);
            return bumpRevisionOn(exec, scopeOrgId);
          },
          getOperationResult: async (idempotencyKey) => {
            const found = await exec(
              `SELECT result FROM organization_operation_results WHERE org_id = $1 AND idempotency_key = $2`,
              [orgId, idempotencyKey],
            );
            return found.rows[0] ? (found.rows[0].result as Record<string, unknown>) : null;
          },
          putOperationResult: async (idempotencyKey, result) => {
            await exec(
              `INSERT INTO organization_operation_results(org_id, idempotency_key, result, created_at)
               VALUES($1, $2, $3::jsonb, $4)
               ON CONFLICT(org_id, idempotency_key) DO NOTHING`,
              [orgId, idempotencyKey, JSON.stringify(result), Date.now()],
            );
          },
          hasAudit: async (idempotencyKey) => {
            const found = await exec(`SELECT 1 FROM audit_log WHERE idempotency_key = $1 LIMIT 1`, [idempotencyKey]);
            return found.rowCount > 0;
          },
          audit: async (event) => {
            if (!opts.auditLog) throw new Error("postgres organization store: auditLog not configured");
            if (event.orgId !== undefined) assertOrg(event.orgId);
            await opts.auditLog.recordInTransaction(client, event);
          },
        };
        return fn(tx);
      });
    },
  };
}
