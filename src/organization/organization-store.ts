export type OrganizationUserStatus = "invited" | "active" | "suspended" | "deprovisioned";

export interface OrganizationUser {
  orgId: string;
  principalId: string;
  email: string | null;
  displayName: string;
  status: OrganizationUserStatus;
  sessionVersion: number;
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number | null;
  createdBy: string;
  updatedBy: string;
}

export interface AuthIdentity {
  orgId: string;
  issuer: string;
  subject: string;
  principalId: string;
  emailAtLink: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface OrganizationStore {
  getUser(orgId: string, principalId: string): Promise<OrganizationUser | null>;
  findUserByEmail(orgId: string, email: string): Promise<OrganizationUser | null>;
  listUsers(orgId: string): Promise<OrganizationUser[]>;
  putUser(user: OrganizationUser): Promise<void>;
  getIdentity(orgId: string, issuer: string, subject: string): Promise<AuthIdentity | null>;
  putIdentity(identity: AuthIdentity): Promise<void>;
}

const userKey = (orgId: string, principalId: string): string => `${orgId}\n${principalId}`;
const identityKey = (orgId: string, issuer: string, subject: string): string => `${orgId}\n${issuer}\n${subject}`;

export function createMemoryOrganizationStore(): OrganizationStore {
  const users = new Map<string, OrganizationUser>();
  const identities = new Map<string, AuthIdentity>();

  return {
    async getUser(orgId, principalId) {
      const found = users.get(userKey(orgId, principalId));
      return found ? { ...found } : null;
    },
    async findUserByEmail(orgId, email) {
      const needle = email.toLowerCase();
      for (const u of users.values()) {
        if (u.orgId === orgId && u.email !== null && u.email.toLowerCase() === needle) {
          return { ...u };
        }
      }
      return null;
    },
    async listUsers(orgId) {
      const out: OrganizationUser[] = [];
      for (const u of users.values()) {
        if (u.orgId === orgId) out.push({ ...u });
      }
      return out;
    },
    async putUser(user) {
      users.set(userKey(user.orgId, user.principalId), { ...user });
    },
    async getIdentity(orgId, issuer, subject) {
      const found = identities.get(identityKey(orgId, issuer, subject));
      return found ? { ...found } : null;
    },
    async putIdentity(identity) {
      identities.set(identityKey(identity.orgId, identity.issuer, identity.subject), { ...identity });
    },
  };
}
