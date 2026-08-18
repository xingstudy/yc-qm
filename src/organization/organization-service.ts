import type { AuditLog } from "../audit/audit-log.ts";
import { personKey } from "../directory/person.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import type { OrganizationStore, OrganizationUser, OrganizationUserStatus } from "./organization-store.ts";

export type OrgAdmission = "invite_only" | "domain_auto_join";

export interface LoginInput {
  principalId: string;
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string;
}

export type LoginResult =
  | { status: "ok"; user: OrganizationUser }
  | { status: "denied"; reason: "unknown" | "suspended" | "deprovisioned" | "not_invited" | "email_unverified" };

export interface ActiveCheck {
  status: OrganizationUserStatus;
  sessionVersion: number;
}

export interface OrganizationService {
  login(input: LoginInput): Promise<LoginResult>;
  invite(input: {
    principalId: string;
    email: string | null;
    displayName: string;
    actor: string;
  }): Promise<OrganizationUser>;
  setStatus(input: {
    principalId: string;
    status: OrganizationUserStatus;
    actor: string;
  }): Promise<OrganizationUser | null>;
  checkActive(principalId: string): Promise<ActiveCheck | null>;
  refresh(): Promise<void>;
  hydrate(): Promise<void>;
}

const REFRESH_TTL_MS = 5_000;
const LOGIN_ACTOR = "system:login";

function sanitizeDisplayName(name: string): string {
  return name.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 200);
}

function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).toLowerCase();
}

export function createOrganizationService(deps: {
  store: OrganizationStore;
  orgId: string;
  admission: OrgAdmission;
  autoJoinDomains: readonly string[];
  auditLog: AuditLog;
  identity: IdentityService;
  now?: () => number;
}): OrganizationService {
  const { store, orgId, admission, auditLog, identity } = deps;
  const now = deps.now ?? Date.now;
  const autoJoinDomains = deps.autoJoinDomains.map((d) => d.toLowerCase());
  const scopeLabel = `org:${orgId}`;
  const cache = new Map<string, ActiveCheck>();
  let refreshedAt = 0;
  let refreshP: Promise<void> | null = null;
  let hydrateP: Promise<void> | null = null;

  function record(action: string, principalId: string, status?: string): void {
    auditLog.record({ at: now(), principalId, action, resource: principalId, scopeLabel, ...(status ? { status } : {}) });
  }

  function cacheUser(user: OrganizationUser): void {
    cache.set(personKey(user.principalId), { status: user.status, sessionVersion: user.sessionVersion });
  }

  async function persistUser(user: OrganizationUser): Promise<void> {
    await store.putUser(user);
    cacheUser(user);
  }

  async function linkIdentity(input: LoginInput, principalId: string): Promise<void> {
    const at = now();
    await store.putIdentity({
      orgId,
      issuer: input.issuer,
      subject: input.subject,
      principalId,
      emailAtLink: input.email,
      createdAt: at,
      updatedAt: at,
    });
  }

  function withLoginProfile(user: OrganizationUser, input: LoginInput): OrganizationUser {
    const at = now();
    return {
      ...user,
      displayName: sanitizeDisplayName(input.displayName),
      email: input.email ?? user.email,
      lastLoginAt: at,
      updatedAt: at,
      updatedBy: LOGIN_ACTOR,
    };
  }

  async function activate(user: OrganizationUser, input: LoginInput): Promise<OrganizationUser> {
    const next = withLoginProfile({ ...user, status: "active", sessionVersion: user.sessionVersion + 1 }, input);
    await persistUser(next);
    record("org.user.activate", next.principalId);
    return next;
  }

  function autoJoinAdmits(input: LoginInput): boolean {
    if (admission !== "domain_auto_join") return false;
    if (autoJoinDomains.length === 0) return true;
    return input.email !== null && autoJoinDomains.includes(emailDomain(input.email));
  }

  async function login(input: LoginInput): Promise<LoginResult> {
    const bound = await store.getIdentity(orgId, input.issuer, input.subject);
    if (bound) {
      const user = await store.getUser(orgId, bound.principalId);
      if (!user) {
        record("org.user.login_denied", bound.principalId, "unknown");
        return { status: "denied", reason: "unknown" };
      }
      if (user.status === "active") {
        const next = withLoginProfile(user, input);
        await persistUser(next);
        record("org.user.login", next.principalId);
        return { status: "ok", user: next };
      }
      if (user.status === "invited") {
        const next = await activate(user, input);
        record("org.user.login", next.principalId);
        return { status: "ok", user: next };
      }
      record("org.user.login_denied", user.principalId, user.status);
      return { status: "denied", reason: user.status };
    }
    if (input.email !== null && input.emailVerified) {
      const invitedUser = await store.findUserByEmail(orgId, input.email);
      if (invitedUser && invitedUser.status === "invited") {
        await linkIdentity(input, invitedUser.principalId);
        const next = await activate(invitedUser, input);
        return { status: "ok", user: next };
      }
    }
    if (autoJoinAdmits(input) && input.emailVerified) {
      const at = now();
      const user: OrganizationUser = {
        orgId,
        principalId: input.principalId,
        email: input.email,
        displayName: sanitizeDisplayName(input.displayName),
        status: "active",
        sessionVersion: 1,
        createdAt: at,
        updatedAt: at,
        lastLoginAt: at,
        createdBy: LOGIN_ACTOR,
        updatedBy: LOGIN_ACTOR,
      };
      await persistUser(user);
      await linkIdentity(input, user.principalId);
      record("org.user.auto_join", user.principalId);
      return { status: "ok", user };
    }
    const reason = autoJoinAdmits(input) && !input.emailVerified ? "email_unverified" : "not_invited";
    record("org.user.login_denied", input.principalId, reason);
    return { status: "denied", reason };
  }

  async function invite(input: {
    principalId: string;
    email: string | null;
    displayName: string;
    actor: string;
  }): Promise<OrganizationUser> {
    const existing = await store.getUser(orgId, input.principalId);
    if (existing) return existing;
    const at = now();
    const user: OrganizationUser = {
      orgId,
      principalId: input.principalId,
      email: input.email,
      displayName: sanitizeDisplayName(input.displayName),
      status: "invited",
      sessionVersion: 1,
      createdAt: at,
      updatedAt: at,
      lastLoginAt: null,
      createdBy: input.actor,
      updatedBy: input.actor,
    };
    await persistUser(user);
    return user;
  }

  async function setStatus(input: {
    principalId: string;
    status: OrganizationUserStatus;
    actor: string;
  }): Promise<OrganizationUser | null> {
    const user = await store.getUser(orgId, input.principalId);
    if (!user) return null;
    if (user.status === input.status) return user;
    const next: OrganizationUser = {
      ...user,
      status: input.status,
      sessionVersion: user.sessionVersion + 1,
      updatedAt: now(),
      updatedBy: input.actor,
    };
    await persistUser(next);
    if (input.status === "suspended" || input.status === "deprovisioned") {
      await identity.deactivate(input.principalId, "manual");
    } else if (input.status === "active") {
      await identity.reactivate(input.principalId);
    }
    record("org.user.status", next.principalId, input.status);
    return next;
  }

  async function refresh(): Promise<void> {
    const at = now();
    if (refreshP) return refreshP;
    if (at - refreshedAt < REFRESH_TTL_MS) return;
    refreshP = store
      .listUsers(orgId)
      .then((users) => {
        cache.clear();
        for (const user of users) cacheUser(user);
        refreshedAt = now();
      })
      .finally(() => {
        refreshP = null;
      });
    return refreshP;
  }

  return {
    login,
    invite,
    setStatus,
    async checkActive(principalId: string): Promise<ActiveCheck | null> {
      await refresh();
      return cache.get(personKey(principalId)) ?? null;
    },
    refresh,
    hydrate(): Promise<void> {
      if (!hydrateP) {
        hydrateP = store.listUsers(orgId).then((users) => {
          for (const user of users) {
            if (!cache.has(personKey(user.principalId))) cacheUser(user);
          }
        });
      }
      return hydrateP;
    },
  };
}
