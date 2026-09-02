import { createHash } from "node:crypto";
import type { IdentityService } from "../identity/identity-service.ts";
import type {
  AuthIdentity,
  OrganizationStore,
  OrganizationTx,
  OrganizationUser,
} from "../organization/organization-store.ts";
import type { ScopeId } from "../types.ts";
import { createSweeper } from "../util/sweeper.ts";
import type { DirectoryMetricSample } from "../admin/metrics-sink.ts";
import type { DirectorySourceService } from "./directory-source-service.ts";
import type { DirectorySourceStore } from "./directory-source-store.ts";
import type { DirectoryEmailResolutionService } from "./email-resolution-service.ts";
import { matchDirectoryMember } from "./identity-match.ts";
import type {
  DirectoryEmailResolution,
  DirectoryMatchResult,
  DirectorySource,
  ExternalIdentityAssertion,
  NormalizedDirectoryMember,
} from "./types.ts";

export type ExternalIdentityLoginResult =
  | { status: "ok"; user: OrganizationUser }
  | {
      status: "denied";
      reason:
        | "unknown"
        | "suspended"
        | "deprovisioned"
        | "source_disabled"
        | "external_inactive"
        | "identity_unmatched"
        | "identity_conflict";
    };

export type EmailIdentityLoginResult = ExternalIdentityLoginResult | { status: "not_applicable" };

export interface IdentityLinkingService {
  start(): void;
  stop(): void;
  sourceImpact(sourceId: string): Promise<{ members: number; bindings: number; affectedUsers: number }>;
  invalidateSourceSessions(sourceId: string, actor: string, sourceRevision?: number): Promise<number>;
  evaluate(sourceId: string, externalSubjectId: string): Promise<DirectoryMatchResult | null>;
  evaluatePage(sourceId: string, externalSubjectIds: readonly string[]): Promise<Map<string, DirectoryMatchResult>>;
  bind(input: {
    sourceId: string;
    externalSubjectId: string;
    principalId: string;
    actor: string;
    matchedBy: "automatic" | "manual" | "migration";
    expectedSourceRevision: number;
    expectedProfileHash: string;
  }): Promise<"bound" | "not_found" | "conflict" | "deprovisioned" | "stale">;
  rebind(input: {
    sourceId: string;
    externalSubjectId: string;
    principalId: string;
    actor: string;
    expectedSourceRevision: number;
    expectedProfileHash: string;
  }): Promise<"bound" | "not_found" | "conflict" | "deprovisioned" | "stale">;
  ignore(sourceId: string, externalSubjectId: string, actor: string, reason: string): Promise<boolean>;
  unignore(sourceId: string, externalSubjectId: string, actor: string): Promise<boolean>;
  hasStableBinding(assertion: ExternalIdentityAssertion): Promise<boolean>;
  login(input: {
    issuer: string;
    subject: string;
    assertion: ExternalIdentityAssertion;
  }): Promise<ExternalIdentityLoginResult>;
  loginEmail(input: {
    principalId: string;
    issuer: string;
    subject: string;
    email: string;
    displayName: string;
    allowCreate: boolean;
  }): Promise<EmailIdentityLoginResult>;
  provisionSnapshotMemberWithSourceLockHeld(
    member: NormalizedDirectoryMember,
    actor: string,
  ): Promise<ExternalIdentityLoginResult>;
  provisionSnapshotMemberInTransactionWithSourceLockHeld(
    tx: OrganizationTx,
    member: NormalizedDirectoryMember,
    actor: string,
  ): Promise<ExternalIdentityLoginResult>;
}

function stableIssuer(identity: Pick<ExternalIdentityAssertion, "provider" | "externalTenantId">): string {
  return `directory:${identity.provider}:${identity.externalTenantId}`;
}

function stableSubject(assertion: Pick<ExternalIdentityAssertion, "externalSubjectId">): string {
  return assertion.externalSubjectId;
}

function legacyIssuer(sourceId: string): string {
  return `directory:${sourceId}`;
}

function legacySubject(identity: Pick<ExternalIdentityAssertion, "externalTenantId" | "externalSubjectId">): string {
  return `${identity.externalTenantId}:${identity.externalSubjectId}`;
}

function externalIdentityMatches(
  identity: AuthIdentity,
  external: Pick<ExternalIdentityAssertion, "sourceId" | "provider" | "externalTenantId" | "externalSubjectId">,
): boolean {
  return (
    (identity.provider === external.provider &&
      identity.externalTenantId === external.externalTenantId &&
      identity.externalSubjectId === external.externalSubjectId) ||
    (identity.issuer === legacyIssuer(external.sourceId) && identity.subject === legacySubject(external))
  );
}

function sanitizeDisplayName(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .slice(0, 200);
  return cleaned || fallback;
}

function jitPrincipalId(assertion: ExternalIdentityAssertion): string {
  const digest = createHash("sha256")
    .update(`${assertion.provider}\n${assertion.externalTenantId}\n${assertion.externalSubjectId}`)
    .digest("base64url")
    .slice(0, 32);
  return `directory-user:${digest}`;
}

function assertionMember(
  orgId: string,
  assertion: ExternalIdentityAssertion,
  at: number,
  trustedCorporateEmail: boolean,
  previous?: NormalizedDirectoryMember | null,
): NormalizedDirectoryMember {
  const emails = [
    ...(assertion.corporateEmail
      ? [
          {
            value: assertion.corporateEmail.toLowerCase(),
            kind: "corporate" as const,
            verified: trustedCorporateEmail,
          },
        ]
      : []),
    ...(assertion.personalEmail && assertion.personalEmail !== assertion.corporateEmail
      ? [{ value: assertion.personalEmail.toLowerCase(), kind: "personal" as const, verified: false }]
      : []),
  ];
  const profile = {
    externalSubjectId: assertion.externalSubjectId,
    displayName: assertion.displayName,
    emails,
    employeeNumber: assertion.employeeNumber,
    mobile: assertion.mobile,
    departmentIds: previous?.departmentIds ?? [],
    status: assertion.status,
  };
  const profileHash = createHash("sha256").update(JSON.stringify(profile)).digest("base64url");
  return {
    orgId,
    sourceId: assertion.sourceId,
    provider: assertion.provider,
    externalTenantId: assertion.externalTenantId,
    ...profile,
    ...(previous?.primaryDepartmentId === undefined ? {} : { primaryDepartmentId: previous.primaryDepartmentId }),
    revision: profileHash,
    observedAt: at,
    profileHash,
    snapshotRevision: previous?.snapshotRevision ?? null,
    ...(previous?.missingFromFullSyncCount === undefined
      ? {}
      : { missingFromFullSyncCount: previous.missingFromFullSyncCount }),
    matchState: previous?.matchState ?? (assertion.status === "inactive" ? "inactive" : "unmatched"),
    matchReason: previous?.matchReason ?? (assertion.status === "inactive" ? "external_inactive" : "login_observed"),
    matchedPrincipalId: previous?.matchedPrincipalId ?? null,
    ignoredBy: previous?.ignoredBy ?? null,
    ignoredReason: previous?.ignoredReason ?? null,
    lastLoginAttemptAt: at,
  };
}

function snapshotAssertion(member: NormalizedDirectoryMember): ExternalIdentityAssertion {
  return {
    sourceId: member.sourceId,
    provider: member.provider,
    externalTenantId: member.externalTenantId,
    externalSubjectId: member.externalSubjectId,
    displayName: member.displayName,
    corporateEmail: member.emails.find((email) => email.kind === "corporate" && email.verified)?.value ?? null,
    corporateEmailVerified: member.emails.some((email) => email.kind === "corporate" && email.verified),
    personalEmail: member.emails.find((email) => email.kind === "personal")?.value ?? null,
    employeeNumber: member.employeeNumber,
    mobile: member.mobile,
    status: member.status,
  };
}

export function createIdentityLinkingService(options: {
  orgId: string;
  organizationStore: OrganizationStore;
  directoryStore: DirectorySourceStore;
  sources: DirectorySourceService;
  identity: IdentityService;
  emailResolutions?: DirectoryEmailResolutionService;
  now?: () => number;
  sessionInvalidationIntervalMs?: number;
  onMetric?: (sample: Omit<DirectoryMetricSample, "ts" | "scopeLabel">) => void;
}): IdentityLinkingService {
  const { orgId, organizationStore, directoryStore, sources, identity } = options;
  const now = options.now ?? Date.now;
  const scopeLabel = `org:${orgId}` as ScopeId;

  const loginMetric = (assertion: ExternalIdentityAssertion, result: string, reason: string): void => {
    options.onMetric?.({
      name: "login_result",
      provider: assertion.provider,
      sourceId: assertion.sourceId,
      result,
      reason,
    });
    if (reason === "identity_unmatched" || reason === "identity_conflict") {
      options.onMetric?.({
        name: "duplicate_creation_blocked",
        provider: assertion.provider,
        sourceId: assertion.sourceId,
        result: "blocked",
        reason,
        value: 1,
      });
    }
  };

  const sourceStillAllowsLogin = async (
    initial: NonNullable<Awaited<ReturnType<DirectorySourceService["get"]>>>,
    assertion: ExternalIdentityAssertion,
  ): Promise<boolean> => {
    const current = await sources.get(initial.id);
    return Boolean(
      current &&
      current.revision === initial.revision &&
      current.status === "active" &&
      current.loginEnabled &&
      current.provider === assertion.provider &&
      current.externalTenantId === assertion.externalTenantId,
    );
  };

  const event = (actor: string, action: string, resource: string, result: string, detail: Record<string, unknown>) => ({
    at: now(),
    principalId: actor,
    action,
    resource,
    scopeLabel,
    orgId,
    actorKind: actor.startsWith("system:") ? "system" : "user",
    source: "directory-source",
    result,
    detail: JSON.stringify(detail),
  });

  const sourceMemberIdentity = (
    member: NormalizedDirectoryMember,
    principalId: string,
    matchedBy: string,
    at: number,
  ): AuthIdentity => ({
    orgId,
    issuer: stableIssuer(member),
    subject: stableSubject(member),
    principalId,
    emailAtLink: member.emails.find((email) => email.kind === "corporate")?.value ?? null,
    sourceId: member.sourceId,
    provider: member.provider,
    externalTenantId: member.externalTenantId,
    externalSubjectId: member.externalSubjectId,
    matchedBy,
    evidence: { reason: matchedBy },
    createdAt: at,
    updatedAt: at,
  });

  const evaluateMember = async (member: NormalizedDirectoryMember): Promise<DirectoryMatchResult> => {
    const source = await sources.get(member.sourceId);
    if (!source)
      return { state: "conflict", reason: "source_missing", automatic: false, principalId: null, candidates: [] };
    const [users, identities] = await Promise.all([
      organizationStore.listUsers(orgId),
      organizationStore.listIdentities(orgId),
    ]);
    const trustedMember =
      source.capabilities.trustedCorporateEmail === true
        ? member
        : {
            ...member,
            emails: member.emails.map((email) => (email.kind === "corporate" ? { ...email, verified: false } : email)),
          };
    return matchDirectoryMember({ member: trustedMember, policy: source.matchPolicy, users, identities });
  };

  const recordMatch = async (member: NormalizedDirectoryMember, match: DirectoryMatchResult): Promise<void> => {
    await directoryStore.updateMemberMatch(
      orgId,
      member.sourceId,
      member.externalSubjectId,
      {
        matchState: match.state,
        matchReason: match.reason,
        matchedPrincipalId: match.state === "bound" ? match.principalId : null,
        ignoredBy: member.ignoredBy,
        ignoredReason: member.ignoredReason,
        lastLoginAttemptAt: member.lastLoginAttemptAt,
      },
      undefined,
      member.profileHash,
    );
  };

  const bindInTransaction = async (
    tx: OrganizationTx,
    member: NormalizedDirectoryMember,
    principalId: string,
    actor: string,
    matchedBy: string,
    allowRebind: boolean,
  ): Promise<{ result: "bound" | "not_found" | "conflict" | "deprovisioned"; oldPrincipalId?: string }> => {
    const user = await tx.getUser(orgId, principalId);
    if (!user) return { result: "not_found" };
    if (user.status === "deprovisioned") return { result: "deprovisioned" };
    const identities = await tx.listIdentities(orgId);
    const existing = identities.find((candidate) => externalIdentityMatches(candidate, member));
    if (existing && existing.principalId !== principalId && !allowRebind) return { result: "conflict" };
    const principalConflict = identities.find(
      (candidate) =>
        candidate.provider === member.provider &&
        candidate.externalTenantId === member.externalTenantId &&
        candidate.principalId === principalId &&
        candidate.externalSubjectId !== member.externalSubjectId,
    );
    if (principalConflict) return { result: "conflict" };
    const at = now();
    const oldPrincipalId = existing?.principalId;
    const identityRecord = sourceMemberIdentity(member, principalId, matchedBy, at);
    if (existing) {
      identityRecord.issuer = existing.issuer;
      identityRecord.subject = existing.subject;
      identityRecord.createdAt = existing.createdAt;
    }
    await tx.putIdentity(identityRecord);
    if (allowRebind && oldPrincipalId && oldPrincipalId !== principalId) {
      const oldUser = await tx.getUser(orgId, oldPrincipalId);
      if (oldUser)
        await tx.putUser({ ...oldUser, sessionVersion: oldUser.sessionVersion + 1, updatedAt: at, updatedBy: actor });
      await tx.putUser({ ...user, sessionVersion: user.sessionVersion + 1, updatedAt: at, updatedBy: actor });
    }
    await tx.audit(
      event(
        actor,
        allowRebind ? "directory_identity.rebind" : "directory_identity.bind",
        member.externalSubjectId,
        "success",
        {
          sourceId: member.sourceId,
          principalId,
          matchedBy,
          ...(oldPrincipalId && oldPrincipalId !== principalId ? { oldPrincipalId } : {}),
        },
      ),
    );
    return { result: "bound", ...(oldPrincipalId ? { oldPrincipalId } : {}) };
  };

  const bind = async (input: {
    sourceId: string;
    externalSubjectId: string;
    principalId: string;
    actor: string;
    matchedBy: "automatic" | "manual" | "migration";
    allowRebind: boolean;
    expectedSourceRevision: number;
    expectedProfileHash: string;
  }): Promise<"bound" | "not_found" | "conflict" | "deprovisioned" | "stale"> => {
    await sources.ready;
    const outcome = await directoryStore.withSourceLock(orgId, input.sourceId, async () => {
      const source = await sources.get(input.sourceId);
      if (!source || source.status !== "active") return { result: "not_found" as const };
      if (source.revision !== input.expectedSourceRevision) return { result: "stale" as const };
      const member = await directoryStore.getMember(orgId, input.sourceId, input.externalSubjectId);
      if (!member || member.status !== "active") return { result: "not_found" as const };
      if (member.profileHash !== input.expectedProfileHash) return { result: "stale" as const };
      return organizationStore.transact(orgId, (tx) =>
        bindInTransaction(tx, member, input.principalId, input.actor, input.matchedBy, input.allowRebind),
      );
    });
    if (outcome.result !== "bound") return outcome.result;
    if (input.allowRebind && outcome.oldPrincipalId && outcome.oldPrincipalId !== input.principalId) {
      const [oldUser, newUser] = await Promise.all([
        organizationStore.getUser(orgId, outcome.oldPrincipalId),
        organizationStore.getUser(orgId, input.principalId),
      ]);
      if (oldUser) {
        if (oldUser.status === "active") await identity.reactivate(oldUser.principalId, oldUser.sessionVersion);
        else await identity.deactivate(oldUser.principalId, "manual", oldUser.sessionVersion);
      }
      if (newUser) {
        if (newUser.status === "active") await identity.reactivate(newUser.principalId, newUser.sessionVersion);
        else await identity.deactivate(newUser.principalId, "manual", newUser.sessionVersion);
      }
    }
    return "bound";
  };

  const jitReady = async (
    source: NonNullable<Awaited<ReturnType<DirectorySourceService["get"]>>>,
    member?: NormalizedDirectoryMember,
    assertion?: ExternalIdentityAssertion,
  ): Promise<boolean> => {
    if (
      !source.jitProvisioningEnabled ||
      source.matchPolicy !== "verified_corporate_email" ||
      source.capabilities.corporateEmailSubjectLookup !== true ||
      source.capabilities.trustedCorporateEmail !== true ||
      source.memberSnapshotRevision === null
    ) {
      return false;
    }
    const guard = await directoryStore.getEmailLookupGuard(orgId, source.id);
    if ((guard?.circuitOpenUntil ?? 0) > now()) return false;
    const assertedEmail =
      assertion?.corporateEmailVerified === true ? assertion.corporateEmail?.trim().toLowerCase() : null;
    if (
      member &&
      assertion &&
      assertedEmail &&
      member.sourceId === source.id &&
      member.provider === assertion.provider &&
      member.externalTenantId === assertion.externalTenantId &&
      member.externalSubjectId === assertion.externalSubjectId &&
      member.status === "active" &&
      member.snapshotRevision === source.memberSnapshotRevision &&
      member.emails.some(
        (email) => email.kind === "corporate" && email.verified && email.value.toLowerCase() === assertedEmail,
      )
    ) {
      return true;
    }
    return (
      source.reconciliationStatus === "ready" &&
      source.reconciledSourceRevision === source.revision &&
      source.reconciledMemberSnapshotRevision === source.memberSnapshotRevision &&
      (source.reconciliationExpiresAt ?? 0) > now()
    );
  };

  const provisionInTransaction = async (
    tx: OrganizationTx,
    source: NonNullable<Awaited<ReturnType<DirectorySourceService["get"]>>>,
    currentMember: NormalizedDirectoryMember,
    assertion: ExternalIdentityAssertion,
    context: { requireJit: boolean; actor: string; login: boolean },
  ): Promise<ExternalIdentityLoginResult> => {
    const identities = await tx.listIdentities(orgId);
    const existing = identities.find((candidate) => externalIdentityMatches(candidate, assertion));
    if (existing) {
      const user = await tx.getUser(orgId, existing.principalId);
      if (!user) return { status: "denied", reason: "unknown" };
      if (user.status === "suspended" || user.status === "deprovisioned") {
        return { status: "denied", reason: user.status };
      }
      return { status: "ok", user };
    }
    const emailUser = assertion.corporateEmail ? await tx.findUserByEmail(orgId, assertion.corporateEmail) : null;
    if (emailUser?.status === "suspended" || emailUser?.status === "deprovisioned") {
      return { status: "denied", reason: emailUser.status };
    }
    const principalId = emailUser?.principalId ?? jitPrincipalId(assertion);
    let user = await tx.getUser(orgId, principalId);
    const at = now();
    let created = false;
    if (!user) {
      user = {
        orgId,
        principalId,
        email: assertion.corporateEmail,
        displayName: sanitizeDisplayName(assertion.displayName, principalId),
        jobTitle: null,
        mobile: assertion.mobile,
        employeeNumber: assertion.employeeNumber,
        status: "active",
        sessionVersion: 1,
        profileRevision: 1,
        createdAt: at,
        updatedAt: at,
        lastLoginAt: context.login ? at : null,
        createdBy: context.actor,
        updatedBy: context.actor,
      };
      if (!(await tx.insertUser(user))) return { status: "denied", reason: "identity_conflict" };
      created = true;
    } else if (user.status === "invited") {
      user = {
        ...user,
        status: "active",
        sessionVersion: user.sessionVersion + 1,
        email: user.email ?? assertion.corporateEmail,
        lastLoginAt: context.login ? at : user.lastLoginAt,
        updatedAt: at,
        updatedBy: context.actor,
      };
      await tx.putUser(user);
    }
    const bound = await bindInTransaction(
      tx,
      currentMember,
      user.principalId,
      context.actor,
      context.requireJit ? "jit" : "managed_directory",
      false,
    );
    if (bound.result !== "bound") {
      return {
        status: "denied",
        reason: bound.result === "deprovisioned" ? "deprovisioned" : "identity_conflict",
      };
    }
    if (created || emailUser?.status === "invited") await tx.bumpRevision(orgId);
    await tx.audit(
      event(
        context.actor,
        context.requireJit ? "org.user.jit_provision" : "org.user.managed_provision",
        user.principalId,
        "success",
        {
          sourceId: source.id,
          created,
        },
      ),
    );
    return { status: "ok", user };
  };

  const jitLogin = async (
    source: NonNullable<Awaited<ReturnType<DirectorySourceService["get"]>>>,
    member: NormalizedDirectoryMember,
    assertion: ExternalIdentityAssertion,
    context: {
      requireJit: boolean;
      actor: string;
      login: boolean;
      sourceLockHeld?: boolean;
      trustedSnapshot?: boolean;
      updateMemberMatch?: boolean;
    } = {
      requireJit: true,
      actor: "system:directory-jit",
      login: true,
    },
  ): Promise<ExternalIdentityLoginResult> => {
    const execute = async () => {
      const current = await sources.get(source.id);
      if (!context.trustedSnapshot && (!current || current.revision !== source.revision)) {
        return { status: "denied", reason: "identity_unmatched" } as const;
      }
      const currentMember = context.trustedSnapshot
        ? member
        : await directoryStore.getMember(orgId, member.sourceId, member.externalSubjectId);
      if (!currentMember || currentMember.status !== "active" || currentMember.profileHash !== member.profileHash) {
        return { status: "denied", reason: "external_inactive" } as const;
      }
      if (
        !context.trustedSnapshot &&
        current &&
        (context.requireJit
          ? !(await jitReady(current, currentMember, assertion))
          : current.mode !== "managed_directory")
      ) {
        return { status: "denied", reason: "identity_unmatched" } as const;
      }
      return organizationStore.transact(orgId, (tx) =>
        provisionInTransaction(tx, source, currentMember, assertion, context),
      );
    };
    const result = context.sourceLockHeld
      ? await execute()
      : await directoryStore.withSourceLock(orgId, source.id, execute);
    if (result.status === "ok") {
      if (context.updateMemberMatch !== false) {
        await directoryStore.updateMemberMatch(
          orgId,
          member.sourceId,
          member.externalSubjectId,
          {
            matchState: "bound",
            matchReason: context.requireJit ? "jit_provisioned" : "managed_directory",
            matchedPrincipalId: result.user.principalId,
            ignoredBy: null,
            ignoredReason: null,
            lastLoginAttemptAt: context.login ? now() : member.lastLoginAttemptAt,
          },
          undefined,
          member.profileHash,
        );
      }
      await identity.reactivate(result.user.principalId, result.user.sessionVersion);
      if (context.login) loginMetric(assertion, "succeeded", "jit_provisioned");
    }
    return result;
  };

  const withSourceLocks = async <T>(sourceIds: readonly string[], fn: () => Promise<T>): Promise<T> => {
    const [sourceId, ...rest] = sourceIds;
    if (!sourceId) return fn();
    return directoryStore.withSourceLock(orgId, sourceId, () => withSourceLocks(rest, fn));
  };

  const loginEmail = async (input: {
    principalId: string;
    issuer: string;
    subject: string;
    email: string;
    displayName: string;
    allowCreate: boolean;
  }): Promise<EmailIdentityLoginResult> => {
    if (!options.emailResolutions) return { status: "not_applicable" };
    const [direct, emailUser] = await Promise.all([
      organizationStore.getIdentity(orgId, input.issuer, input.subject),
      organizationStore.findUserByEmail(orgId, input.email),
    ]);
    let resolved;
    try {
      resolved = await options.emailResolutions.resolveEnabled(input.email);
    } catch {
      if (direct || emailUser) return { status: "not_applicable" };
      const guarded = (await sources.list()).some(
        (source) => source.status === "active" && source.loginEnabled && source.jitProvisioningEnabled,
      );
      return guarded ? { status: "denied", reason: "identity_unmatched" } : { status: "not_applicable" };
    }
    const successful = resolved.filter(
      (item) =>
        item.source.matchPolicy === "verified_corporate_email" &&
        item.source.capabilities.trustedCorporateEmail === true &&
        item.resolution.status === "resolved" &&
        item.resolution.externalSubjectId,
    );
    if (!successful.length) {
      if (direct || emailUser) return { status: "not_applicable" };
      return resolved.some((item) => item.source.jitProvisioningEnabled)
        ? { status: "denied", reason: "identity_unmatched" }
        : { status: "not_applicable" };
    }
    const evidence: Array<{
      source: DirectorySource;
      member: NormalizedDirectoryMember;
      resolution: DirectoryEmailResolution;
    }> = [];
    for (const item of successful) {
      const externalSubjectId = item.resolution.externalSubjectId!;
      const member = await directoryStore.getMember(orgId, item.source.id, externalSubjectId);
      if (!member || member.status !== "active") return { status: "denied", reason: "identity_conflict" };
      evidence.push({ source: item.source, member, resolution: item.resolution });
    }
    const sourceIds = [...new Set(evidence.map((item) => item.source.id))].sort();
    let activated: OrganizationUser | null = null;
    const result = await withSourceLocks(sourceIds, async (): Promise<EmailIdentityLoginResult> => {
      for (const item of evidence) {
        const current = await sources.get(item.source.id);
        const member = await directoryStore.getMember(orgId, item.source.id, item.member.externalSubjectId);
        if (
          !current ||
          current.status !== "active" ||
          !current.loginEnabled ||
          current.revision !== item.resolution.sourceRevision ||
          current.memberSnapshotRevision !== item.resolution.memberSnapshotRevision ||
          !member ||
          member.status !== "active" ||
          member.profileHash !== item.member.profileHash
        ) {
          return current?.jitProvisioningEnabled
            ? { status: "denied", reason: "identity_unmatched" }
            : { status: "not_applicable" };
        }
      }
      return organizationStore.transact(orgId, async (tx): Promise<EmailIdentityLoginResult> => {
        const identities = await tx.listIdentities(orgId);
        const emailIdentity = identities.find(
          (candidate) => candidate.issuer === input.issuer && candidate.subject === input.subject,
        );
        const externalIdentities = evidence
          .map((item) => identities.find((candidate) => externalIdentityMatches(candidate, item.member)))
          .filter((value): value is AuthIdentity => Boolean(value));
        const matchedByEmail = await tx.findUserByEmail(orgId, input.email);
        const targetIds = new Set(
          [
            emailIdentity?.principalId,
            matchedByEmail?.principalId,
            ...externalIdentities.map((value) => value.principalId),
          ].filter((value): value is string => Boolean(value)),
        );
        if (targetIds.size > 1) return { status: "denied", reason: "identity_conflict" };
        let principalId = [...targetIds][0] ?? null;
        if (!principalId && !input.allowCreate) return { status: "not_applicable" };
        const resolvedTarget = principalId !== null;
        principalId ??= input.principalId;
        let user = await tx.getUser(orgId, principalId);
        if (!resolvedTarget && user) return { status: "denied", reason: "identity_conflict" };
        if (user?.status === "suspended" || user?.status === "deprovisioned") {
          return { status: "denied", reason: user.status };
        }
        for (const item of evidence) {
          const sourceConflict = identities.find(
            (candidate) =>
              candidate.provider === item.member.provider &&
              candidate.externalTenantId === item.member.externalTenantId &&
              candidate.principalId === principalId &&
              candidate.externalSubjectId !== item.member.externalSubjectId,
          );
          if (sourceConflict) return { status: "denied", reason: "identity_conflict" };
        }
        const at = now();
        let created = false;
        let activatedInvitation = false;
        if (!user) {
          user = {
            orgId,
            principalId,
            email: input.email,
            displayName: sanitizeDisplayName(input.displayName, input.email),
            jobTitle: null,
            mobile: null,
            employeeNumber: null,
            status: "active",
            sessionVersion: 1,
            profileRevision: 1,
            createdAt: at,
            updatedAt: at,
            lastLoginAt: at,
            createdBy: "system:email-directory-link",
            updatedBy: "system:email-directory-link",
          };
          if (!(await tx.insertUser(user))) return { status: "denied", reason: "identity_conflict" };
          created = true;
        } else {
          const displayName = user.displayName.trim()
            ? user.displayName
            : sanitizeDisplayName(input.displayName, input.email);
          const activating = user.status === "invited";
          activatedInvitation = activating;
          const profileChanged = displayName !== user.displayName || input.email !== user.email;
          user = {
            ...user,
            displayName,
            email: input.email,
            status: "active",
            sessionVersion: user.sessionVersion + (activating ? 1 : 0),
            profileRevision: user.profileRevision + (profileChanged ? 1 : 0),
            lastLoginAt: at,
            updatedAt: Math.max(at, user.updatedAt),
            updatedBy: "system:email-directory-link",
          };
          await tx.putUser(user);
        }
        await tx.putIdentity({
          orgId,
          issuer: input.issuer,
          subject: input.subject,
          principalId,
          emailAtLink: input.email,
          evidence: {
            ...emailIdentity?.evidence,
            emailVerified: "true",
            emailVerifiedEmail: input.email.trim().toLowerCase(),
          },
          createdAt: emailIdentity?.createdAt ?? at,
          updatedAt: at,
        });
        for (const item of evidence) {
          const existing = identities.find((candidate) => externalIdentityMatches(candidate, item.member));
          const linked = sourceMemberIdentity(item.member, principalId, "verified_corporate_email", at);
          if (existing) {
            linked.issuer = existing.issuer;
            linked.subject = existing.subject;
            linked.createdAt = existing.createdAt;
          }
          await tx.putIdentity(linked);
        }
        if (created || activatedInvitation) await tx.bumpRevision(orgId);
        await tx.audit(
          event(principalId, "org.user.login", principalId, "success", {
            linkedDirectorySources: evidence.length,
          }),
        );
        activated = user;
        return { status: "ok", user };
      });
    });
    if (result.status === "ok") {
      for (const item of evidence) {
        await directoryStore.updateMemberMatch(
          orgId,
          item.member.sourceId,
          item.member.externalSubjectId,
          {
            matchState: "bound",
            matchReason: "verified_corporate_email",
            matchedPrincipalId: result.user.principalId,
            ignoredBy: null,
            ignoredReason: null,
            lastLoginAttemptAt: item.member.lastLoginAttemptAt,
          },
          undefined,
          item.member.profileHash,
        );
      }
      if (activated) await identity.reactivate(result.user.principalId, result.user.sessionVersion);
    }
    return result;
  };

  const invalidateSourceSessions = async (
    sourceId: string,
    actor: string,
    sourceRevision?: number,
  ): Promise<number> => {
    const operationKey =
      sourceRevision === undefined ? null : `directory-source-session-invalidation:${sourceId}:${sourceRevision}`;
    const updated = await organizationStore.transact(orgId, async (tx) => {
      if (operationKey) {
        const stored = await tx.getOperationResult(operationKey);
        if (stored) {
          if (!Array.isArray(stored.users)) throw new Error("directory_source_session_result_invalid");
          return stored.users as OrganizationUser[];
        }
      }
      const identities = (await tx.listIdentities(orgId)).filter((identity) => identity.sourceId === sourceId);
      const principalIds = [...new Set(identities.map((identity) => identity.principalId))];
      const users: OrganizationUser[] = [];
      const at = now();
      for (const principalId of principalIds) {
        const user = await tx.getUser(orgId, principalId);
        if (!user) continue;
        const next = { ...user, sessionVersion: user.sessionVersion + 1, updatedAt: at, updatedBy: actor };
        await tx.putUser(next);
        users.push(next);
      }
      await tx.audit({
        ...event(actor, "directory_source.sessions_invalidated", sourceId, "success", {
          sourceId,
          affectedUsers: users.length,
        }),
        ...(operationKey ? { idempotencyKey: operationKey } : {}),
      });
      if (operationKey) await tx.putOperationResult(operationKey, { users });
      return users;
    });
    for (const user of updated) {
      if (user.status === "active") await identity.reactivate(user.principalId, user.sessionVersion);
      else await identity.deactivate(user.principalId, "manual", user.sessionVersion);
    }
    return updated.length;
  };
  const sessionInvalidation = createSweeper(
    async () => {
      for (const source of await sources.list(true)) {
        if (source.status === "paused" || source.status === "deleted") {
          await invalidateSourceSessions(source.id, "system:directory-source-state", source.revision);
        }
      }
    },
    options.sessionInvalidationIntervalMs ?? 30_000,
    { label: "directory-source-session-invalidation", immediate: true },
  );

  const service: IdentityLinkingService = {
    start() {
      sessionInvalidation.start();
    },
    stop() {
      sessionInvalidation.stop();
    },
    async sourceImpact(sourceId) {
      const identities = (await organizationStore.listIdentities(orgId)).filter(
        (identity) => identity.sourceId === sourceId,
      );
      let members = 0;
      let after: { externalSubjectId: string } | null = null;
      for (;;) {
        const page = await directoryStore.listMembers(orgId, sourceId, { limit: 100, ...(after ? { after } : {}) });
        members += page.members.length;
        if (!page.next) break;
        after = page.next;
      }
      return {
        members,
        bindings: identities.length,
        affectedUsers: new Set(identities.map((identity) => identity.principalId)).size,
      };
    },
    invalidateSourceSessions,
    async evaluate(sourceId, externalSubjectId) {
      const member = await directoryStore.getMember(orgId, sourceId, externalSubjectId);
      if (!member) return null;
      const result = await evaluateMember(member);
      await recordMatch(member, result);
      return result;
    },
    async evaluatePage(sourceId, externalSubjectIds) {
      const result = new Map<string, DirectoryMatchResult>();
      for (const externalSubjectId of externalSubjectIds) {
        const match = await service.evaluate(sourceId, externalSubjectId);
        if (match) result.set(externalSubjectId, match);
      }
      return result;
    },
    bind: (input) => bind({ ...input, allowRebind: false }),
    rebind: (input) => bind({ ...input, matchedBy: "manual", allowRebind: true }),
    async ignore(sourceId, externalSubjectId, actor, reason) {
      const member = await directoryStore.getMember(orgId, sourceId, externalSubjectId);
      if (!member || member.matchState === "bound") return false;
      const cleanReason = reason.trim().slice(0, 300);
      const updated = await directoryStore.updateMemberMatch(
        orgId,
        sourceId,
        externalSubjectId,
        {
          matchState: "ignored",
          matchReason: "administrator_ignored",
          matchedPrincipalId: null,
          ignoredBy: actor,
          ignoredReason: cleanReason || null,
          lastLoginAttemptAt: member.lastLoginAttemptAt,
        },
        event(actor, "directory_identity.ignore", externalSubjectId, "success", { sourceId }),
        member.profileHash,
      );
      if (!updated) return false;
      if (!directoryStore.durable) {
        await organizationStore.transact(orgId, async (tx) => {
          await tx.audit(event(actor, "directory_identity.ignore", externalSubjectId, "success", { sourceId }));
        });
      }
      return true;
    },
    async unignore(sourceId, externalSubjectId, actor) {
      const member = await directoryStore.getMember(orgId, sourceId, externalSubjectId);
      if (!member || member.matchState !== "ignored") return false;
      const updated = await directoryStore.updateMemberMatch(
        orgId,
        sourceId,
        externalSubjectId,
        {
          matchState: "unmatched",
          matchReason: "ignore_removed",
          matchedPrincipalId: null,
          ignoredBy: null,
          ignoredReason: null,
          lastLoginAttemptAt: member.lastLoginAttemptAt,
        },
        event(actor, "directory_identity.unignore", externalSubjectId, "success", { sourceId }),
        member.profileHash,
      );
      if (!updated) return false;
      if (!directoryStore.durable) {
        await organizationStore.transact(orgId, async (tx) => {
          await tx.audit(event(actor, "directory_identity.unignore", externalSubjectId, "success", { sourceId }));
        });
      }
      return true;
    },
    loginEmail,
    async hasStableBinding(assertion) {
      return (await organizationStore.listIdentities(orgId)).some((candidate) =>
        externalIdentityMatches(candidate, assertion),
      );
    },
    async provisionSnapshotMemberWithSourceLockHeld(member, actor) {
      const source = await sources.get(member.sourceId, true);
      if (!source) return { status: "denied", reason: "source_disabled" };
      if (!member || member.status !== "active") return { status: "denied", reason: "external_inactive" };
      return jitLogin(source, member, snapshotAssertion(member), {
        requireJit: false,
        actor,
        login: false,
        sourceLockHeld: true,
        trustedSnapshot: true,
        updateMemberMatch: false,
      });
    },
    async provisionSnapshotMemberInTransactionWithSourceLockHeld(tx, member, actor) {
      const source = await sources.get(member.sourceId, true);
      if (!source) return { status: "denied", reason: "source_disabled" };
      if (member.status !== "active") return { status: "denied", reason: "external_inactive" };
      return provisionInTransaction(tx, source, member, snapshotAssertion(member), {
        requireJit: false,
        actor,
        login: false,
      });
    },
    async login(input) {
      const { assertion } = input;
      const denied = (
        reason: Exclude<ExternalIdentityLoginResult, { status: "ok" }>["reason"],
      ): ExternalIdentityLoginResult => {
        loginMetric(assertion, "denied", reason);
        return { status: "denied", reason };
      };
      const source = await sources.get(assertion.sourceId);
      if (
        !source ||
        source.status !== "active" ||
        !source.loginEnabled ||
        source.provider !== assertion.provider ||
        source.externalTenantId !== assertion.externalTenantId
      ) {
        return denied("source_disabled");
      }
      const at = now();
      const previous = await directoryStore.getMember(orgId, assertion.sourceId, assertion.externalSubjectId);
      if (!previous) {
        await directoryStore.upsertMember(
          assertionMember(orgId, assertion, at, source.capabilities.trustedCorporateEmail === true),
        );
      }
      let member = previous ?? (await directoryStore.getMember(orgId, assertion.sourceId, assertion.externalSubjectId));
      if (!member) return denied("unknown");
      const snapshotCorporateEmail = member.emails.find((email) => email.kind === "corporate" && email.verified)?.value;
      const assertedCorporateEmail =
        assertion.corporateEmailVerified === true ? assertion.corporateEmail?.trim().toLowerCase() : null;
      if (!snapshotCorporateEmail && assertedCorporateEmail && source.capabilities.trustedCorporateEmail === true) {
        await directoryStore.upsertMember(assertionMember(orgId, assertion, at, true, member));
        member = (await directoryStore.getMember(orgId, assertion.sourceId, assertion.externalSubjectId)) ?? member;
      }
      const ignored = member.matchState === "ignored";
      const refreshed = await directoryStore.updateMemberMatch(
        orgId,
        member.sourceId,
        member.externalSubjectId,
        {
          matchState: ignored ? "unmatched" : member.matchState,
          matchReason: ignored ? "login_attempt_removed_ignore" : member.matchReason,
          matchedPrincipalId: member.matchedPrincipalId,
          ignoredBy: null,
          ignoredReason: null,
          lastLoginAttemptAt: at,
        },
        undefined,
        member.profileHash,
      );
      member = refreshed ?? member;
      if (assertion.status !== "active" || member.status !== "active") {
        return denied("external_inactive");
      }
      let activatedPrincipal: string | null = null;
      const existingResult = await directoryStore.withSourceLock(
        orgId,
        assertion.sourceId,
        async (): Promise<ExternalIdentityLoginResult | null> => {
          if (!(await sourceStillAllowsLogin(source, assertion))) {
            return { status: "denied", reason: "source_disabled" };
          }
          return organizationStore.transact(orgId, async (tx): Promise<ExternalIdentityLoginResult | null> => {
            const existing = (await tx.listIdentities(orgId)).find((candidate) =>
              externalIdentityMatches(candidate, assertion),
            );
            if (!existing) return null;
            const user = await tx.getUser(orgId, existing.principalId);
            if (!user) return { status: "denied", reason: "unknown" };
            if (user.status === "suspended" || user.status === "deprovisioned") {
              return { status: "denied", reason: user.status };
            }
            const displayName = user.displayName.trim() ? user.displayName : assertion.displayName.slice(0, 200);
            const email = user.email ?? assertion.corporateEmail;
            const activating = user.status === "invited";
            const next: OrganizationUser = {
              ...user,
              displayName,
              email,
              status: "active",
              sessionVersion: user.sessionVersion + (activating ? 1 : 0),
              profileRevision:
                user.profileRevision + (displayName !== user.displayName || email !== user.email ? 1 : 0),
              lastLoginAt: at,
              updatedAt: Math.max(at, user.updatedAt),
              updatedBy: "system:login",
            };
            await tx.putIdentity({ ...existing, emailAtLink: assertion.corporateEmail, updatedAt: at });
            await tx.putUser(next);
            if (activating) await tx.bumpRevision(orgId);
            await tx.audit(
              event(next.principalId, "org.user.login", next.principalId, "success", {
                sourceId: assertion.sourceId,
              }),
            );
            activatedPrincipal = next.principalId;
            return { status: "ok", user: next };
          });
        },
      );
      if (existingResult) {
        if (existingResult.status === "ok") {
          await directoryStore.updateMemberMatch(
            orgId,
            member.sourceId,
            member.externalSubjectId,
            {
              matchState: "bound",
              matchReason: "stable_binding",
              matchedPrincipalId: existingResult.user.principalId,
              ignoredBy: null,
              ignoredReason: null,
              lastLoginAttemptAt: at,
            },
            undefined,
            member.profileHash,
          );
          if (activatedPrincipal) await identity.reactivate(activatedPrincipal, existingResult.user.sessionVersion);
          loginMetric(assertion, "succeeded", "stable_binding");
        } else {
          loginMetric(assertion, "denied", existingResult.reason);
        }
        return existingResult;
      }
      if (!source.memberSnapshotRevision || member.snapshotRevision !== source.memberSnapshotRevision) {
        return denied("identity_unmatched");
      }
      if (
        source.capabilities.trustedCorporateEmail === true &&
        snapshotCorporateEmail &&
        snapshotCorporateEmail.trim().toLowerCase() !== assertedCorporateEmail
      ) {
        await sources.setReconciliation(source.id, source.revision, "stale");
        await directoryStore.updateMemberMatch(
          orgId,
          member.sourceId,
          member.externalSubjectId,
          {
            matchState: "conflict",
            matchReason: "login_snapshot_email_mismatch",
            matchedPrincipalId: null,
            ignoredBy: null,
            ignoredReason: null,
            lastLoginAttemptAt: at,
          },
          undefined,
          member.profileHash,
        );
        return denied("identity_conflict");
      }
      const match = await evaluateMember(member);
      await recordMatch({ ...member, lastLoginAttemptAt: at }, match);
      if (!match.automatic || !match.principalId) {
        if (
          match.state === "unmatched" &&
          member.snapshotRevision === source.memberSnapshotRevision &&
          (await jitReady(source, member, assertion))
        ) {
          return jitLogin(source, member, assertion);
        }
        let reason: "identity_conflict" | "external_inactive" | "identity_unmatched" = "identity_unmatched";
        if (match.state === "conflict") reason = "identity_conflict";
        else if (match.state === "inactive") reason = "external_inactive";
        return denied(reason);
      }
      const bound = await bind({
        sourceId: member.sourceId,
        externalSubjectId: member.externalSubjectId,
        principalId: match.principalId,
        actor: "system:login",
        matchedBy: "automatic",
        allowRebind: false,
        expectedSourceRevision: source.revision,
        expectedProfileHash: member.profileHash,
      });
      if (bound !== "bound") return denied("identity_conflict");
      return service.login(input);
    },
  };
  return service;
}
