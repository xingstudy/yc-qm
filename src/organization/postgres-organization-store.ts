import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import type { PoolClient } from "../persistence/pg-pool.ts";
import type { PostgresAuditLog } from "../admin/postgres-audit-log.ts";
import type {
  AccessGroup,
  AccessGroupMember,
  AuthIdentity,
  OrganizationStore,
  OrganizationTx,
  OrganizationUser,
  OrganizationUserStatus,
  OrgMemberRole,
  OrgUnit,
  OrgUnitMember,
  UnitImpact,
} from "./organization-store.ts";

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
    status: r.status as OrganizationUserStatus,
    sessionVersion: Number(r.session_version),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    lastLoginAt: r.last_login_at == null ? null : Number(r.last_login_at),
    createdBy: r.created_by as string,
    updatedBy: r.updated_by as string,
  };
}

function rowToIdentity(r: Record<string, unknown>): AuthIdentity {
  return {
    orgId: r.org_id as string,
    issuer: r.issuer as string,
    subject: r.subject as string,
    principalId: r.principal_id as string,
    emailAtLink: (r.email_at_link as string | null) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
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

const USER_COLUMNS =
  "org_id, principal_id, email, display_name, status, session_version, created_at, updated_at, last_login_at, created_by, updated_by";

const IDENTITY_COLUMNS = "org_id, issuer, subject, principal_id, email_at_link, created_at, updated_at";

const UNIT_COLUMNS =
  "org_id, id, parent_id, name, kind, status, sort_order, created_at, updated_at, created_by, updated_by";

const UNIT_MEMBER_COLUMNS = "org_id, unit_id, principal_id, role, created_at, created_by";

const GROUP_COLUMNS = "org_id, id, name, status, created_at, updated_at, created_by, updated_by";

const GROUP_MEMBER_COLUMNS = "org_id, group_id, principal_id, role, created_at, created_by";

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
    status TEXT NOT NULL,
    session_version BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    last_login_at BIGINT,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    PRIMARY KEY (org_id, principal_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS organization_users_email ON organization_users(org_id, lower(email)) WHERE email IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS organization_users_status ON organization_users(org_id, status)`,
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
  `CREATE INDEX IF NOT EXISTS auth_identities_principal ON auth_identities(org_id, principal_id)`,
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
    created_at BIGINT NOT NULL,
    created_by TEXT NOT NULL,
    PRIMARY KEY (org_id, unit_id, principal_id)
  )`,
  `CREATE INDEX IF NOT EXISTS org_unit_members_by_principal ON org_unit_members(org_id, principal_id)`,
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
  `CREATE TABLE IF NOT EXISTS organization_authz_state(
    org_id TEXT PRIMARY KEY,
    revision BIGINT NOT NULL,
    skill_access_policy_version INTEGER NOT NULL DEFAULT 0,
    skill_access_enforced_at BIGINT,
    updated_at BIGINT NOT NULL
  )`,
];

async function putUserOn(exec: Exec, u: OrganizationUser): Promise<void> {
  await exec(
    `INSERT INTO organization_users (${USER_COLUMNS})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (org_id, principal_id)
     DO UPDATE SET
       email = EXCLUDED.email,
       display_name = EXCLUDED.display_name,
       status = EXCLUDED.status,
       session_version = EXCLUDED.session_version,
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
      u.status,
      u.sessionVersion,
      u.createdAt,
      u.updatedAt,
      u.lastLoginAt,
      u.createdBy,
      u.updatedBy,
    ],
  );
}

async function relinkClosure(exec: Exec, orgId: string, unitId: string, parentId: string | null): Promise<void> {
  await exec(CLOSURE_DELETE_SQL, [orgId, unitId]);
  await exec(CLOSURE_INSERT_SQL, [orgId, unitId, parentId]);
}

async function putUnitOn(exec: Exec, unit: OrgUnit): Promise<void> {
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
  const locked = await exec(
    `SELECT id FROM org_units WHERE org_id = $1 AND id IN ($2, $3) ORDER BY id FOR UPDATE`,
    [orgId, unitId, newParentId],
  );
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
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (org_id, unit_id, principal_id)
     DO UPDATE SET role = EXCLUDED.role, created_at = EXCLUDED.created_at, created_by = EXCLUDED.created_by`,
    [m.orgId, m.unitId, m.principalId, m.role, m.createdAt, m.createdBy],
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

async function bumpRevisionOn(exec: Exec, orgId: string): Promise<number> {
  const res = await exec(
    `INSERT INTO organization_authz_state (org_id, revision, updated_at) VALUES ($1, 2, $2)
     ON CONFLICT (org_id) DO UPDATE SET revision = organization_authz_state.revision + 1, updated_at = $2
     RETURNING revision`,
    [orgId, Date.now()],
  );
  return Number(res.rows[0]!.revision);
}

export function createPostgresOrganizationStore(
  connectionString: string,
  opts: { auditLog?: PostgresAuditLog } = {},
): OrganizationStore {
  const pg = createPgPool(connectionString, SCHEMA_SQL);

  return {
    async getUser(orgId, principalId) {
      const rows = await pg.q(`SELECT ${USER_COLUMNS} FROM organization_users WHERE org_id = $1 AND principal_id = $2`, [
        orgId,
        principalId,
      ]);
      return rows[0] ? rowToUser(rows[0]) : null;
    },
    async findUserByEmail(orgId, email) {
      const rows = await pg.q(
        `SELECT ${USER_COLUMNS} FROM organization_users WHERE org_id = $1 AND lower(email) = lower($2)`,
        [orgId, email],
      );
      return rows[0] ? rowToUser(rows[0]) : null;
    },
    async listUsers(orgId) {
      const rows = await pg.q(`SELECT ${USER_COLUMNS} FROM organization_users WHERE org_id = $1 ORDER BY principal_id`, [
        orgId,
      ]);
      return rows.map(rowToUser);
    },
    async putUser(u) {
      await putUserOn(pg.query, u);
    },
    async getIdentity(orgId, issuer, subject) {
      const rows = await pg.q(
        `SELECT ${IDENTITY_COLUMNS} FROM auth_identities WHERE org_id = $1 AND issuer = $2 AND subject = $3`,
        [orgId, issuer, subject],
      );
      return rows[0] ? rowToIdentity(rows[0]) : null;
    },
    async putIdentity(i) {
      await pg.query(
        `INSERT INTO auth_identities (${IDENTITY_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (org_id, issuer, subject)
         DO UPDATE SET
           principal_id = EXCLUDED.principal_id,
           email_at_link = EXCLUDED.email_at_link,
           created_at = EXCLUDED.created_at,
           updated_at = EXCLUDED.updated_at`,
        [i.orgId, i.issuer, i.subject, i.principalId, i.emailAtLink, i.createdAt, i.updatedAt],
      );
    },
    async getUnit(orgId, id) {
      const rows = await pg.q(`SELECT ${UNIT_COLUMNS} FROM org_units WHERE org_id = $1 AND id = $2`, [orgId, id]);
      return rows[0] ? rowToUnit(rows[0]) : null;
    },
    async listUnits(orgId) {
      const rows = await pg.q(`SELECT ${UNIT_COLUMNS} FROM org_units WHERE org_id = $1 ORDER BY sort_order, id`, [
        orgId,
      ]);
      return rows.map(rowToUnit);
    },
    async putUnit(unit) {
      await withPgTransaction(await pg.pool(), (client) => putUnitOn(clientExec(client), unit));
    },
    async isDescendant(orgId, ancestorId, descendantId) {
      const rows = await pg.q(
        `SELECT 1 FROM org_unit_closure WHERE org_id = $1 AND ancestor_id = $2 AND descendant_id = $3 LIMIT 1`,
        [orgId, ancestorId, descendantId],
      );
      return rows.length > 0;
    },
    async listSubtreeUnitIds(orgId, unitId) {
      const rows = await pg.q(
        `SELECT descendant_id FROM org_unit_closure WHERE org_id = $1 AND ancestor_id = $2 ORDER BY descendant_id`,
        [orgId, unitId],
      );
      return rows.map((r) => r.descendant_id as string);
    },
    async listManagedSubtreeUnitIds(orgId, principalId) {
      const rows = await pg.q(
        `SELECT DISTINCT c.descendant_id
           FROM org_unit_members m
           JOIN org_unit_closure c ON c.org_id = m.org_id AND c.ancestor_id = m.unit_id
          WHERE m.org_id = $1 AND m.principal_id = $2 AND m.role = 'manager'
          ORDER BY c.descendant_id`,
        [orgId, principalId],
      );
      return rows.map((r) => r.descendant_id as string);
    },
    async unitImpact(orgId, unitId): Promise<UnitImpact> {
      const rows = await pg.q(
        `SELECT
           (SELECT count(*) FROM org_units WHERE org_id = $1 AND parent_id = $2 AND status = 'active') AS active_child_units,
           (SELECT count(*) FROM org_unit_members m
              JOIN organization_users u ON u.org_id = m.org_id AND u.principal_id = m.principal_id
             WHERE m.org_id = $1 AND m.unit_id = $2 AND u.status <> 'deprovisioned') AS active_members`,
        [orgId, unitId],
      );
      return {
        activeChildUnits: Number(rows[0]!.active_child_units),
        activeMembers: Number(rows[0]!.active_members),
        directoryRoots: 0,
        skillGrants: 0,
      };
    },
    async listUnitMembers(orgId, unitId) {
      const rows = await pg.q(
        `SELECT ${UNIT_MEMBER_COLUMNS} FROM org_unit_members WHERE org_id = $1 AND unit_id = $2 ORDER BY principal_id`,
        [orgId, unitId],
      );
      return rows.map(rowToUnitMember);
    },
    async putUnitMember(m) {
      await putUnitMemberOn(pg.query, m);
    },
    async removeUnitMember(orgId, unitId, principalId) {
      await removeUnitMemberOn(pg.query, orgId, unitId, principalId);
    },
    async getGroup(orgId, id) {
      const rows = await pg.q(`SELECT ${GROUP_COLUMNS} FROM access_groups WHERE org_id = $1 AND id = $2`, [orgId, id]);
      return rows[0] ? rowToGroup(rows[0]) : null;
    },
    async listGroups(orgId) {
      const rows = await pg.q(`SELECT ${GROUP_COLUMNS} FROM access_groups WHERE org_id = $1 ORDER BY id`, [orgId]);
      return rows.map(rowToGroup);
    },
    async putGroup(g) {
      await putGroupOn(pg.query, g);
    },
    async listGroupMembers(orgId, groupId) {
      const rows = await pg.q(
        `SELECT ${GROUP_MEMBER_COLUMNS} FROM access_group_members WHERE org_id = $1 AND group_id = $2 ORDER BY principal_id`,
        [orgId, groupId],
      );
      return rows.map(rowToGroupMember);
    },
    async putGroupMember(m) {
      await putGroupMemberOn(pg.query, m);
    },
    async removeGroupMember(orgId, groupId, principalId) {
      await removeGroupMemberOn(pg.query, orgId, groupId, principalId);
    },
    async getAuthzRevision(orgId) {
      const rows = await pg.q(`SELECT revision FROM organization_authz_state WHERE org_id = $1`, [orgId]);
      return rows[0] ? Number(rows[0].revision) : 0;
    },
    async ensureOrgRoot({ orgId, name, actor, now }) {
      await withPgTransaction(await pg.pool(), async (client) => {
        const exec = clientExec(client);
        await exec(`SELECT pg_advisory_xact_lock(hashtext('org-bootstrap'), hashtext($1))`, [orgId]);
        const existing = await exec(
          `SELECT id FROM org_units WHERE org_id = $1 AND parent_id IS NULL AND status = 'active' LIMIT 1`,
          [orgId],
        );
        if (existing.rows.length > 0) return;
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
        await exec(
          `INSERT INTO organization_authz_state (org_id, revision, updated_at) VALUES ($1, 1, $2)
           ON CONFLICT (org_id) DO NOTHING`,
          [orgId, now],
        );
      });
    },
    async transact(fn) {
      return withPgTransaction(await pg.pool(), async (client) => {
        const exec = clientExec(client);
        const tx: OrganizationTx = {
          putUser: (u) => putUserOn(exec, u),
          putUnit: (u) => putUnitOn(exec, u),
          moveUnitSubtree: (orgId, unitId, newParentId) => moveUnitSubtreeOn(exec, orgId, unitId, newParentId),
          putUnitMember: (m) => putUnitMemberOn(exec, m),
          removeUnitMember: (orgId, unitId, principalId) => removeUnitMemberOn(exec, orgId, unitId, principalId),
          putGroup: (g) => putGroupOn(exec, g),
          putGroupMember: (m) => putGroupMemberOn(exec, m),
          removeGroupMember: (orgId, groupId, principalId) => removeGroupMemberOn(exec, orgId, groupId, principalId),
          bumpRevision: (orgId) => bumpRevisionOn(exec, orgId),
          audit: async (event) => {
            if (!opts.auditLog) throw new Error("postgres organization store: auditLog not configured");
            await opts.auditLog.recordInTransaction(client, event);
          },
        };
        return fn(tx);
      });
    },
  };
}
