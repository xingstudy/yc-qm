import { createHmac } from "node:crypto";
import type { DirectoryMetricSample } from "../admin/metrics-sink.ts";
import type { OrganizationStore } from "../organization/organization-store.ts";
import type { DirectorySourceService } from "./directory-source-service.ts";
import type { DirectorySourceStore } from "./directory-source-store.ts";
import type { DirectoryProviderRegistry } from "./provider.ts";
import type { DirectoryEmailResolution, DirectorySource } from "./types.ts";
import { normalizeDirectoryEmail } from "./types.ts";

export interface DirectoryEmailResolutionService {
  resolve(sourceId: string, email: string): Promise<DirectoryEmailResolution>;
  resolveEnabled(email: string): Promise<Array<{ source: DirectorySource; resolution: DirectoryEmailResolution }>>;
  reconcile(sourceId: string): Promise<{
    status: "ready" | "blocked" | "conflict";
    total: number;
    resolved: number;
    notFound: number;
    blocked: number;
  }>;
}

const DAY_MS = 24 * 60 * 60_000;
const RESOLVED_TTL_MS = DAY_MS;
const NOT_FOUND_TTL_MS = 6 * 60 * 60_000;
const UNAUTHORIZED_TTL_MS = 60 * 60_000;
const RATE_LIMIT_TTL_MS = 60 * 60_000;
const MAX_TEMPORARY_BACKOFF_MS = 60 * 60_000;

function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/.test(value);
}

function retryAt(status: DirectoryEmailResolution["status"], failures: number, at: number): number {
  if (status === "resolved") return at + RESOLVED_TTL_MS;
  if (status === "not_found" || status === "conflict") return at + NOT_FOUND_TTL_MS;
  if (status === "unauthorized") return at + UNAUTHORIZED_TTL_MS;
  if (status === "rate_limited") return at + RATE_LIMIT_TTL_MS;
  return at + Math.min(MAX_TEMPORARY_BACKOFF_MS, 30_000 * 2 ** Math.min(7, Math.max(0, failures - 1)));
}

export function createDirectoryEmailResolutionService(options: {
  orgId: string;
  store: DirectorySourceStore;
  sources: DirectorySourceService;
  providers: DirectoryProviderRegistry;
  organizationStore: OrganizationStore;
  allowedEmailDomains?: readonly string[];
  hashKeyMaterial: Buffer | string;
  bindResolvedIdentity?: (input: {
    sourceId: string;
    externalSubjectId: string;
    principalId: string;
    expectedSourceRevision: number;
    expectedProfileHash: string;
  }) => Promise<"bound" | "not_found" | "conflict" | "deprovisioned" | "stale">;
  now?: () => number;
  onMetric?: (sample: Omit<DirectoryMetricSample, "ts" | "scopeLabel">) => void;
}): DirectoryEmailResolutionService {
  const { orgId, store, sources, providers } = options;
  const now = options.now ?? Date.now;
  const hashKey = Buffer.isBuffer(options.hashKeyMaterial)
    ? options.hashKeyMaterial
    : Buffer.from(options.hashKeyMaterial, "utf8");
  const emailHash = (email: string): string =>
    createHmac("sha256", hashKey).update(normalizeDirectoryEmail(email)).digest("base64url");
  const allowedDomains = new Set((options.allowedEmailDomains ?? []).map((value) => value.trim().toLowerCase()));
  const allowedEmail = (email: string): boolean => {
    const normalized = normalizeDirectoryEmail(email);
    const at = normalized.lastIndexOf("@");
    return validEmail(normalized) && (allowedDomains.size === 0 || allowedDomains.has(normalized.slice(at + 1)));
  };

  const countMembers = async (sourceId: string): Promise<number> => {
    let count = 0;
    let after = null;
    for (;;) {
      const page = await store.listMembers(orgId, sourceId, { limit: 100, after });
      count += page.members.length;
      if (!page.next) return count;
      after = page.next;
    }
  };

  const metric = (source: DirectorySource, result: string, reason: string): void => {
    options.onMetric?.({
      name: "email_resolution",
      provider: source.provider,
      sourceId: source.id,
      result,
      reason,
      value: 1,
    });
  };

  const resolve = async (sourceId: string, rawEmail: string): Promise<DirectoryEmailResolution> => {
    const email = normalizeDirectoryEmail(rawEmail);
    if (!validEmail(email)) throw new Error("directory_email_resolution_invalid_email");
    return store.withSourceLock(orgId, sourceId, async () => {
      const configured = await sources.configuration(sourceId);
      if (!configured || configured.source.status !== "active") {
        throw new Error("directory_email_resolution_source_disabled");
      }
      const source = configured.source;
      const adapter = providers.get(source.provider);
      if (!adapter || source.capabilities.corporateEmailSubjectLookup !== true || !adapter.lookupByCorporateEmail) {
        throw new Error("directory_email_resolution_unsupported");
      }
      const hash = emailHash(email);
      const at = now();
      const cached = await store.getEmailResolution(orgId, source.id, hash);
      if (
        cached &&
        cached.sourceRevision === source.revision &&
        cached.memberSnapshotRevision === source.memberSnapshotRevision &&
        cached.retryAt > at
      ) {
        metric(source, cached.status, "cache");
        return cached;
      }
      const storedGuard = await store.getEmailLookupGuard(orgId, source.id);
      const guard =
        storedGuard && storedGuard.windowStartedAt + DAY_MS > at
          ? storedGuard
          : {
              orgId,
              sourceId: source.id,
              windowStartedAt: at,
              attempts: 0,
              notFound: 0,
              circuitOpenUntil: null,
              updatedAt: at,
            };
      if ((guard.circuitOpenUntil ?? 0) > at) {
        const blocked: DirectoryEmailResolution = {
          orgId,
          sourceId: source.id,
          emailHash: hash,
          status: "rate_limited",
          externalSubjectId: null,
          sourceRevision: source.revision,
          memberSnapshotRevision: source.memberSnapshotRevision,
          checkedAt: at,
          retryAt: guard.circuitOpenUntil!,
          failureCount: (cached?.failureCount ?? 0) + 1,
          errorCode: "circuit_open",
        };
        await store.putEmailResolution(blocked);
        metric(source, blocked.status, blocked.errorCode!);
        return blocked;
      }
      const memberCount = await countMembers(source.id);
      const notFoundBudget = Math.max(1, Math.floor(memberCount * 0.15));
      if (guard.notFound >= notFoundBudget) {
        const circuitOpenUntil = guard.windowStartedAt + DAY_MS;
        await store.putEmailLookupGuard({ ...guard, circuitOpenUntil, updatedAt: at });
        const blocked: DirectoryEmailResolution = {
          orgId,
          sourceId: source.id,
          emailHash: hash,
          status: "rate_limited",
          externalSubjectId: null,
          sourceRevision: source.revision,
          memberSnapshotRevision: source.memberSnapshotRevision,
          checkedAt: at,
          retryAt: circuitOpenUntil,
          failureCount: (cached?.failureCount ?? 0) + 1,
          errorCode: "error_budget_exhausted",
        };
        await store.putEmailResolution(blocked);
        metric(source, blocked.status, blocked.errorCode!);
        return blocked;
      }
      const lookup = await adapter.lookupByCorporateEmail(configured.config, { email });
      let status: DirectoryEmailResolution["status"] = lookup.status;
      let externalSubjectId = lookup.status === "resolved" ? lookup.externalSubjectId : null;
      let errorCode = lookup.status === "resolved" ? null : (lookup.errorCode ?? lookup.status);
      if (lookup.status === "resolved") {
        const member = await store.getMember(orgId, source.id, lookup.externalSubjectId);
        if (!member || member.status !== "active" || member.externalTenantId !== source.externalTenantId) {
          status = "conflict";
          externalSubjectId = lookup.externalSubjectId;
          errorCode = "subject_not_in_active_snapshot";
        }
      }
      const failureCount = status === "resolved" ? 0 : (cached?.failureCount ?? 0) + 1;
      const resolution: DirectoryEmailResolution = {
        orgId,
        sourceId: source.id,
        emailHash: hash,
        status,
        externalSubjectId,
        sourceRevision: source.revision,
        memberSnapshotRevision: source.memberSnapshotRevision,
        checkedAt: at,
        retryAt: retryAt(status, failureCount, at),
        failureCount,
        errorCode,
      };
      const notFound = guard.notFound + (status === "not_found" ? 1 : 0);
      const circuitOpenUntil =
        status === "rate_limited" || notFound >= notFoundBudget ? guard.windowStartedAt + DAY_MS : null;
      await store.putEmailLookupGuard({
        ...guard,
        attempts: guard.attempts + 1,
        notFound,
        circuitOpenUntil,
        updatedAt: at,
      });
      const storedResolution = {
        ...resolution,
        retryAt: circuitOpenUntil && status !== "resolved" ? circuitOpenUntil : resolution.retryAt,
      };
      await store.putEmailResolution(storedResolution);
      metric(source, status, errorCode ?? "resolved");
      return storedResolution;
    });
  };

  return {
    resolve,
    async resolveEnabled(email) {
      await sources.ready;
      const available = (await sources.list()).filter(
        (source) =>
          source.status === "active" &&
          source.loginEnabled &&
          source.matchPolicy === "verified_corporate_email" &&
          source.capabilities.corporateEmailSubjectLookup === true &&
          source.capabilities.trustedCorporateEmail === true,
      );
      const result: Array<{ source: DirectorySource; resolution: DirectoryEmailResolution }> = [];
      for (const source of available) result.push({ source, resolution: await resolve(source.id, email) });
      return result;
    },
    async reconcile(sourceId) {
      const source = await sources.get(sourceId);
      if (!source || source.status !== "active") throw new Error("directory_email_resolution_source_disabled");
      if (
        source.matchPolicy !== "verified_corporate_email" ||
        source.capabilities.corporateEmailSubjectLookup !== true ||
        source.capabilities.trustedCorporateEmail !== true
      ) {
        throw new Error("directory_email_resolution_unsupported");
      }
      if (!source.memberSnapshotRevision) throw new Error("directory_email_resolution_snapshot_required");
      const started = await sources.setReconciliation(source.id, source.revision, "running");
      if (started === "conflict") return { status: "conflict", total: 0, resolved: 0, notFound: 0, blocked: 0 };
      if (!started) throw new Error("directory_email_resolution_source_disabled");
      try {
        const [allUsers, identities] = await Promise.all([
          options.organizationStore.listUsers(orgId),
          options.organizationStore.listIdentities(orgId),
        ]);
        const users = allUsers.filter(
          (user) =>
            (user.status === "active" || user.status === "invited") && user.email !== null && allowedEmail(user.email),
        );
        const usersByPrincipal = new Map(users.map((user) => [user.principalId, user]));
        const verifiedIdentities = identities.filter(
          (identity) =>
            !identity.sourceId &&
            identity.emailAtLink !== null &&
            identity.evidence?.emailVerified === "true" &&
            identity.evidence.emailVerifiedEmail === identity.emailAtLink.trim().toLowerCase() &&
            usersByPrincipal.has(identity.principalId) &&
            allowedEmail(identity.emailAtLink),
        );
        const candidates: Array<{ principalId: string; email: string }> = [];
        const candidateKeys = new Set<string>();
        for (const identity of verifiedIdentities) {
          const email = normalizeDirectoryEmail(identity.emailAtLink!);
          const key = `${identity.principalId}\n${email}`;
          if (candidateKeys.has(key)) continue;
          candidateKeys.add(key);
          candidates.push({ principalId: identity.principalId, email });
        }
        const unverifiedProfiles = users.filter(
          (user) =>
            !verifiedIdentities.some(
              (identity) =>
                identity.principalId === user.principalId &&
                normalizeDirectoryEmail(identity.emailAtLink!) === normalizeDirectoryEmail(user.email!),
            ),
        );
        let resolved = 0;
        let notFound = 0;
        let blocked = unverifiedProfiles.length;
        for (const candidate of candidates) {
          const result = await resolve(source.id, candidate.email);
          if (result.status === "resolved" && result.externalSubjectId) {
            const member = await store.getMember(orgId, source.id, result.externalSubjectId);
            const binding =
              member && options.bindResolvedIdentity
                ? await options.bindResolvedIdentity({
                    sourceId: source.id,
                    externalSubjectId: member.externalSubjectId,
                    principalId: candidate.principalId,
                    expectedSourceRevision: result.sourceRevision,
                    expectedProfileHash: member.profileHash,
                  })
                : "conflict";
            if (binding === "bound") resolved++;
            else blocked++;
          } else if (result.status === "not_found") notFound++;
          else blocked++;
          if (result.status === "rate_limited" || result.status === "unauthorized") break;
        }
        const current = await sources.get(source.id);
        if (!current || current.revision !== source.revision) {
          return {
            status: "conflict",
            total: candidates.length + unverifiedProfiles.length,
            resolved,
            notFound,
            blocked,
          };
        }
        const status = blocked > 0 ? "blocked" : "ready";
        const completed = await sources.setReconciliation(source.id, source.revision, status);
        if (completed === "conflict") {
          return {
            status: "conflict",
            total: candidates.length + unverifiedProfiles.length,
            resolved,
            notFound,
            blocked,
          };
        }
        return { status, total: candidates.length + unverifiedProfiles.length, resolved, notFound, blocked };
      } catch (error) {
        const current = await sources.get(source.id);
        if (current?.revision === source.revision) await sources.setReconciliation(source.id, source.revision, "stale");
        throw error;
      }
    },
  };
}
