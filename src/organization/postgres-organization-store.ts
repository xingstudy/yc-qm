import { createPgPool } from "../persistence/pg-pool.ts";
import type {
  AuthIdentity,
  OrganizationStore,
  OrganizationUser,
  OrganizationUserStatus,
} from "./organization-store.ts";

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

const USER_COLUMNS =
  "org_id, principal_id, email, display_name, status, session_version, created_at, updated_at, last_login_at, created_by, updated_by";

const IDENTITY_COLUMNS = "org_id, issuer, subject, principal_id, email_at_link, created_at, updated_at";

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
];

export function createPostgresOrganizationStore(connectionString: string): OrganizationStore {
  const pg = createPgPool(connectionString, SCHEMA_SQL);

  const notImplemented = async (): Promise<never> => {
    throw new Error("postgres org tree store not implemented yet");
  };

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
      await pg.query(
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
    getUnit: notImplemented,
    listUnits: notImplemented,
    putUnit: notImplemented,
    isDescendant: notImplemented,
    listSubtreeUnitIds: notImplemented,
    listManagedSubtreeUnitIds: notImplemented,
    unitImpact: notImplemented,
    listUnitMembers: notImplemented,
    putUnitMember: notImplemented,
    removeUnitMember: notImplemented,
    getGroup: notImplemented,
    listGroups: notImplemented,
    putGroup: notImplemented,
    listGroupMembers: notImplemented,
    putGroupMember: notImplemented,
    removeGroupMember: notImplemented,
    getAuthzRevision: notImplemented,
    ensureOrgRoot: notImplemented,
    transact: notImplemented,
  };
}
