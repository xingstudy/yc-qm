import { createKeyedQueue } from "../util/async.ts";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AuditEvent } from "../audit/audit-log.ts";
import type {
  DirectoryMemberPage,
  DirectoryMemberQuery,
  DirectoryEmailLookupGuard,
  DirectoryEmailResolution,
  DirectoryManagedUserOwnership,
  DirectoryUnitMapping,
  DirectoryUnitMemberOwnership,
  ManagedDirectoryPreview,
  DirectorySyncCounts,
  DirectorySyncRun,
  NormalizedDirectoryMember,
  NormalizedDirectoryUnit,
  StoredDirectorySource,
} from "./types.ts";

export interface DirectorySourceStore {
  readonly durable: boolean;
  withSourceLock<T>(orgId: string, sourceId: string, fn: () => Promise<T>): Promise<T>;
  listSources(orgId: string, includeDeleted?: boolean): Promise<StoredDirectorySource[]>;
  getSource(orgId: string, sourceId: string): Promise<StoredDirectorySource | null>;
  putSource(source: StoredDirectorySource, expectedRevision: number | null, audit?: AuditEvent): Promise<boolean>;
  getMember(orgId: string, sourceId: string, externalSubjectId: string): Promise<NormalizedDirectoryMember | null>;
  listMembers(orgId: string, sourceId: string, query: DirectoryMemberQuery): Promise<DirectoryMemberPage>;
  listUnits(orgId: string, sourceId: string): Promise<NormalizedDirectoryUnit[]>;
  listUnitMappings(orgId: string, sourceId: string): Promise<DirectoryUnitMapping[]>;
  putUnitMapping(mapping: DirectoryUnitMapping, audit?: AuditEvent): Promise<void>;
  listUnitMemberOwnership(orgId: string, sourceId: string): Promise<DirectoryUnitMemberOwnership[]>;
  putUnitMemberOwnership(ownership: DirectoryUnitMemberOwnership): Promise<void>;
  deleteUnitMemberOwnership(orgId: string, sourceId: string, unitId: string, principalId: string): Promise<void>;
  listManagedUserOwnership(orgId: string, sourceId: string): Promise<DirectoryManagedUserOwnership[]>;
  putManagedUserOwnership(ownership: DirectoryManagedUserOwnership): Promise<void>;
  getManagedPreview(orgId: string, sourceId: string, previewId: string): Promise<ManagedDirectoryPreview | null>;
  listManagedPreviews(orgId: string, status: ManagedDirectoryPreview["status"]): Promise<ManagedDirectoryPreview[]>;
  putManagedPreview(preview: ManagedDirectoryPreview): Promise<void>;
  replaceMembers(
    orgId: string,
    sourceId: string,
    members: readonly NormalizedDirectoryMember[],
    preview: boolean,
  ): Promise<DirectorySyncCounts>;
  upsertMember(member: NormalizedDirectoryMember): Promise<void>;
  updateMemberMatch(
    orgId: string,
    sourceId: string,
    externalSubjectId: string,
    update: Pick<
      NormalizedDirectoryMember,
      "matchState" | "matchReason" | "matchedPrincipalId" | "ignoredBy" | "ignoredReason" | "lastLoginAttemptAt"
    >,
    audit?: AuditEvent,
    expectedProfileHash?: string,
  ): Promise<NormalizedDirectoryMember | null>;
  getEmailResolution(orgId: string, sourceId: string, emailHash: string): Promise<DirectoryEmailResolution | null>;
  listEmailResolutions(orgId: string, sourceId: string): Promise<DirectoryEmailResolution[]>;
  putEmailResolution(resolution: DirectoryEmailResolution): Promise<void>;
  getEmailLookupGuard(orgId: string, sourceId: string): Promise<DirectoryEmailLookupGuard | null>;
  putEmailLookupGuard(guard: DirectoryEmailLookupGuard): Promise<void>;
  createRun(run: DirectorySyncRun): Promise<DirectorySyncRun>;
  getRun(orgId: string, sourceId: string, runId: string): Promise<DirectorySyncRun | null>;
  listRuns(orgId: string, sourceId: string, limit?: number): Promise<DirectorySyncRun[]>;
  claimRun(
    orgId: string,
    sourceId: string,
    runId: string,
    owner: string,
    at: number,
    leaseExpiresAt: number,
  ): Promise<DirectorySyncRun | null>;
  renewRun(
    orgId: string,
    sourceId: string,
    runId: string,
    owner: string,
    at: number,
    leaseExpiresAt: number,
  ): Promise<boolean>;
  finishRun(
    run: DirectorySyncRun,
    expectedOwner: string,
    mutation?: DirectoryRunMutation,
  ): Promise<DirectorySyncRun | null>;
  findRunningRun(orgId: string, sourceId: string): Promise<DirectorySyncRun | null>;
  latestSucceededAt(orgId: string, sourceId: string): Promise<number | null>;
  close(): Promise<void>;
}

export type DirectoryRunMutation =
  | {
      kind: "full";
      members: readonly NormalizedDirectoryMember[];
      units?: readonly NormalizedDirectoryUnit[];
      preview: boolean;
    }
  | { kind: "targeted"; externalSubjectId: string; member: NormalizedDirectoryMember | null };

const sourceKey = (orgId: string, sourceId: string): string => `${orgId}\n${sourceId}`;
const memberKey = (orgId: string, sourceId: string, externalSubjectId: string): string =>
  `${orgId}\n${sourceId}\n${externalSubjectId}`;
const runKey = (orgId: string, sourceId: string, runId: string): string => `${orgId}\n${sourceId}\n${runId}`;
const unitKey = (orgId: string, sourceId: string, externalUnitId: string): string =>
  `${orgId}\n${sourceId}\n${externalUnitId}`;
const emailResolutionKey = (orgId: string, sourceId: string, emailHash: string): string =>
  `${orgId}\n${sourceId}\n${emailHash}`;
const unitMappingKey = (orgId: string, provider: string, tenantId: string, externalUnitId: string): string =>
  `${orgId}\n${provider}\n${tenantId}\n${externalUnitId}`;
const unitOwnershipKey = (orgId: string, sourceId: string, unitId: string, principalId: string): string =>
  `${orgId}\n${sourceId}\n${unitId}\n${principalId}`;
const managedUserOwnershipKey = (orgId: string, sourceId: string, externalSubjectId: string): string =>
  `${orgId}\n${sourceId}\n${externalSubjectId}`;
const managedPreviewKey = (orgId: string, sourceId: string, previewId: string): string =>
  `${orgId}\n${sourceId}\n${previewId}`;

function cloneSource(source: StoredDirectorySource): StoredDirectorySource {
  return {
    ...source,
    capabilities: { ...source.capabilities },
    publicConfig: { ...source.publicConfig },
  };
}

export function cloneDirectoryMember(member: NormalizedDirectoryMember): NormalizedDirectoryMember {
  return {
    ...member,
    emails: member.emails.map((email) => ({ ...email })),
    departmentIds: [...member.departmentIds],
    primaryDepartmentId: member.primaryDepartmentId ?? null,
  };
}

function cloneRun(run: DirectorySyncRun): DirectorySyncRun {
  return { ...run, counts: { ...run.counts } };
}

function cloneDirectoryUnit(unit: NormalizedDirectoryUnit): NormalizedDirectoryUnit {
  return { ...unit };
}

function cloneManagedPreview(preview: ManagedDirectoryPreview): ManagedDirectoryPreview {
  return {
    ...preview,
    units: preview.units.map((unit) => ({ ...unit })),
    members: preview.members.map((member) => ({
      ...member,
      externalUnitIds: [...member.externalUnitIds],
    })),
    relations: preview.relations.map((relation) => ({ ...relation })),
    preserved: preview.preserved.map((item) => ({ ...item })),
    authorizationImpacts: preview.authorizationImpacts.map((impact) => ({ ...impact })),
    conflicts: [...preview.conflicts],
  };
}

function matchEvidence(member: NormalizedDirectoryMember): string {
  return JSON.stringify({
    emails: member.emails
      .map((email) => [email.kind, email.verified, email.value.toLowerCase()])
      .sort((a, b) => String(a).localeCompare(String(b))),
    employeeNumber: member.employeeNumber?.toLowerCase() ?? null,
    mobile: member.mobile ?? null,
  });
}

function snapshotResult(
  existing: readonly NormalizedDirectoryMember[],
  incoming: readonly NormalizedDirectoryMember[],
): { members: NormalizedDirectoryMember[]; counts: DirectorySyncCounts } {
  if (incoming.length === 0 && existing.some((member) => member.status === "active")) {
    throw new Error("directory_sync_suspicious_empty_snapshot");
  }
  const old = new Map(existing.map((member) => [member.externalSubjectId, member]));
  const next: NormalizedDirectoryMember[] = [];
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  for (const member of incoming) {
    const previous = old.get(member.externalSubjectId);
    old.delete(member.externalSubjectId);
    if (!previous) {
      added++;
      next.push(cloneDirectoryMember(member));
      continue;
    }
    const same = previous.profileHash === member.profileHash;
    if (same) unchanged++;
    else changed++;
    const bound = previous.matchState === "bound" && previous.matchedPrincipalId;
    const preserveIgnore = previous.matchState === "ignored" && matchEvidence(previous) === matchEvidence(member);
    let matchState: NormalizedDirectoryMember["matchState"] = "unmatched";
    let matchReason = "not_evaluated";
    if (member.status === "inactive") {
      matchState = "inactive";
      matchReason = "external_inactive";
    } else if (bound) {
      matchState = "bound";
      matchReason = previous.matchReason;
    } else if (preserveIgnore) {
      matchState = "ignored";
      matchReason = previous.matchReason;
    }
    next.push({
      ...cloneDirectoryMember(member),
      missingFromFullSyncCount: 0,
      matchState,
      matchReason,
      matchedPrincipalId: bound ? previous.matchedPrincipalId : null,
      ignoredBy: preserveIgnore ? previous.ignoredBy : null,
      ignoredReason: preserveIgnore ? previous.ignoredReason : null,
      lastLoginAttemptAt: previous.lastLoginAttemptAt,
    });
  }
  let inactive = 0;
  for (const previous of old.values()) {
    const missingFromFullSyncCount = (previous.missingFromFullSyncCount ?? 0) + 1;
    const confirmedMissing = missingFromFullSyncCount >= 2 || previous.status === "inactive";
    next.push(
      confirmedMissing
        ? {
            ...cloneDirectoryMember(previous),
            status: "inactive",
            matchState: "inactive",
            matchReason: "missing_from_full_sync",
            missingFromFullSyncCount,
          }
        : {
            ...cloneDirectoryMember(previous),
            missingFromFullSyncCount,
          },
    );
    if (confirmedMissing) inactive++;
  }
  return {
    members: next,
    counts: { observed: incoming.length, added, changed, inactive, unchanged },
  };
}

function snapshotRevision(members: readonly NormalizedDirectoryMember[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...members]
          .sort((left, right) => left.externalSubjectId.localeCompare(right.externalSubjectId))
          .map((member) => [member.externalSubjectId, member.profileHash, member.status]),
      ),
    )
    .digest("base64url");
}

function unitSnapshotResult(
  existing: readonly NormalizedDirectoryUnit[],
  incoming: readonly NormalizedDirectoryUnit[],
): NormalizedDirectoryUnit[] {
  if (incoming.length === 0 && existing.some((unit) => unit.status === "active")) {
    throw new Error("directory_sync_suspicious_empty_unit_snapshot");
  }
  const previous = new Map(existing.map((unit) => [unit.externalUnitId, unit]));
  const result = incoming.map((unit) => {
    previous.delete(unit.externalUnitId);
    return cloneDirectoryUnit({ ...unit, missingFromFullSyncCount: 0 });
  });
  for (const unit of previous.values()) {
    const missingFromFullSyncCount = (unit.missingFromFullSyncCount ?? 0) + 1;
    result.push({
      ...cloneDirectoryUnit(unit),
      status: missingFromFullSyncCount >= 2 || unit.status === "inactive" ? "inactive" : unit.status,
      missingFromFullSyncCount,
    });
  }
  return result;
}

function combinedSnapshotRevision(
  members: readonly NormalizedDirectoryMember[],
  units: readonly NormalizedDirectoryUnit[],
): string {
  return createHash("sha256")
    .update(snapshotRevision(members))
    .update(
      JSON.stringify(
        [...units]
          .sort((left, right) => left.externalUnitId.localeCompare(right.externalUnitId))
          .map((unit) => [unit.externalUnitId, unit.profileHash, unit.status]),
      ),
    )
    .digest("base64url");
}

function withSnapshotRevision(source: StoredDirectorySource, memberSnapshotRevision: string): StoredDirectorySource {
  if (source.memberSnapshotRevision === memberSnapshotRevision) return { ...source, memberSnapshotRevision };
  return {
    ...source,
    memberSnapshotRevision,
    reconciliationStatus: "stale",
    reconciledSourceRevision: null,
    reconciledMemberSnapshotRevision: null,
    reconciledAt: null,
    reconciliationExpiresAt: null,
    jitProvisioningEnabled: false,
  };
}

export function createMemoryDirectorySourceStore(): DirectorySourceStore {
  const sources = new Map<string, StoredDirectorySource>();
  const members = new Map<string, NormalizedDirectoryMember>();
  const units = new Map<string, NormalizedDirectoryUnit>();
  const runs = new Map<string, DirectorySyncRun>();
  const emailResolutions = new Map<string, DirectoryEmailResolution>();
  const emailLookupGuards = new Map<string, DirectoryEmailLookupGuard>();
  const unitMappings = new Map<string, DirectoryUnitMapping>();
  const unitMemberOwnership = new Map<string, DirectoryUnitMemberOwnership>();
  const managedUserOwnership = new Map<string, DirectoryManagedUserOwnership>();
  const managedPreviews = new Map<string, ManagedDirectoryPreview>();
  const enqueue = createKeyedQueue<string>();
  const sourceLockContext = new AsyncLocalStorage<Set<string>>();
  const withSourceLock = <T>(orgId: string, sourceId: string, fn: () => Promise<T>): Promise<T> => {
    const key = sourceKey(orgId, sourceId);
    const held = sourceLockContext.getStore();
    if (held?.has(key)) return fn();
    return enqueue(key, () => sourceLockContext.run(new Set([...(held ?? []), key]), fn));
  };
  return {
    durable: false,
    withSourceLock,
    async listSources(orgId, includeDeleted = false) {
      return [...sources.values()]
        .filter((source) => source.orgId === orgId && (includeDeleted || source.status !== "deleted"))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
        .map(cloneSource);
    },
    async getSource(orgId, sourceId) {
      const source = sources.get(sourceKey(orgId, sourceId));
      return source ? cloneSource(source) : null;
    },
    async putSource(source, expectedRevision) {
      return withSourceLock(source.orgId, source.id, () =>
        enqueue(`directory-source-org:${source.orgId}`, async () => {
          const current = sources.get(sourceKey(source.orgId, source.id));
          if (expectedRevision === null ? current !== undefined : current?.revision !== expectedRevision) return false;
          if (source.status === "active") {
            const peers = [...sources.values()].filter(
              (candidate) =>
                candidate.orgId === source.orgId && candidate.id !== source.id && candidate.status === "active",
            );
            if (
              peers.some(
                (candidate) =>
                  candidate.provider === source.provider && candidate.externalTenantId === source.externalTenantId,
              )
            ) {
              throw new Error("directory_source_tenant_conflict");
            }
            if (
              source.mode === "managed_directory" &&
              peers.some((candidate) => candidate.mode === "managed_directory")
            ) {
              throw new Error("directory_source_managed_directory_conflict");
            }
          }
          sources.set(sourceKey(source.orgId, source.id), cloneSource(source));
          return true;
        }),
      );
    },
    async getMember(orgId, sourceId, externalSubjectId) {
      const member = members.get(memberKey(orgId, sourceId, externalSubjectId));
      return member ? cloneDirectoryMember(member) : null;
    },
    async listMembers(orgId, sourceId, query) {
      const states = query.states ? new Set(query.states) : null;
      const needle = query.query?.trim().toLowerCase() ?? "";
      const filtered = [...members.values()]
        .filter((member) => member.orgId === orgId && member.sourceId === sourceId)
        .filter((member) => !states || states.has(member.matchState))
        .filter(
          (member) =>
            !needle ||
            [
              member.externalSubjectId,
              member.displayName,
              member.employeeNumber ?? "",
              member.mobile ?? "",
              ...member.emails.map((email) => email.value),
            ].some((value) => value.toLowerCase().includes(needle)),
        )
        .sort((a, b) => a.externalSubjectId.localeCompare(b.externalSubjectId))
        .filter((member) => !query.after || member.externalSubjectId > query.after.externalSubjectId);
      const page = filtered.slice(0, query.limit);
      return {
        members: page.map(cloneDirectoryMember),
        next:
          filtered.length > page.length && page.length > 0
            ? { externalSubjectId: page[page.length - 1]!.externalSubjectId }
            : null,
      };
    },
    async listUnits(orgId, sourceId) {
      return [...units.values()]
        .filter((unit) => unit.orgId === orgId && unit.sourceId === sourceId)
        .sort((left, right) => left.externalUnitId.localeCompare(right.externalUnitId))
        .map(cloneDirectoryUnit);
    },
    async listUnitMappings(orgId, sourceId) {
      return [...unitMappings.values()]
        .filter((mapping) => mapping.orgId === orgId && mapping.sourceId === sourceId)
        .sort((left, right) => left.externalUnitId.localeCompare(right.externalUnitId))
        .map((mapping) => ({ ...mapping }));
    },
    async putUnitMapping(mapping) {
      unitMappings.set(
        unitMappingKey(mapping.orgId, mapping.provider, mapping.externalTenantId, mapping.externalUnitId),
        { ...mapping },
      );
    },
    async listUnitMemberOwnership(orgId, sourceId) {
      return [...unitMemberOwnership.values()]
        .filter((ownership) => ownership.orgId === orgId && ownership.sourceId === sourceId)
        .map((ownership) => ({ ...ownership }));
    },
    async putUnitMemberOwnership(ownership) {
      unitMemberOwnership.set(
        unitOwnershipKey(ownership.orgId, ownership.sourceId, ownership.unitId, ownership.principalId),
        { ...ownership },
      );
    },
    async deleteUnitMemberOwnership(orgId, sourceId, unitId, principalId) {
      unitMemberOwnership.delete(unitOwnershipKey(orgId, sourceId, unitId, principalId));
    },
    async listManagedUserOwnership(orgId, sourceId) {
      return [...managedUserOwnership.values()]
        .filter((ownership) => ownership.orgId === orgId && ownership.sourceId === sourceId)
        .map((ownership) => ({ ...ownership }));
    },
    async putManagedUserOwnership(ownership) {
      managedUserOwnership.set(
        managedUserOwnershipKey(ownership.orgId, ownership.sourceId, ownership.externalSubjectId),
        { ...ownership },
      );
    },
    async getManagedPreview(orgId, sourceId, previewId) {
      const preview = managedPreviews.get(managedPreviewKey(orgId, sourceId, previewId));
      return preview ? cloneManagedPreview(preview) : null;
    },
    async listManagedPreviews(orgId, status) {
      return [...managedPreviews.values()]
        .filter((preview) => preview.orgId === orgId && preview.status === status)
        .sort((left, right) => left.createdAt - right.createdAt)
        .map(cloneManagedPreview);
    },
    async putManagedPreview(preview) {
      managedPreviews.set(managedPreviewKey(preview.orgId, preview.sourceId, preview.id), cloneManagedPreview(preview));
    },
    async replaceMembers(orgId, sourceId, incoming, preview) {
      return enqueue(sourceKey(orgId, sourceId), async () => {
        const source = sources.get(sourceKey(orgId, sourceId));
        if (!source) throw new Error("directory_sync_source_not_found");
        validateMembers(orgId, sourceId, incoming, source);
        const existing = [...members.values()].filter(
          (member) => member.orgId === orgId && member.sourceId === sourceId,
        );
        const result = snapshotResult(existing, incoming);
        if (!preview) {
          const existingUnits = [...units.values()].filter(
            (unit) => unit.orgId === orgId && unit.sourceId === sourceId,
          );
          const nextSnapshotRevision = combinedSnapshotRevision(result.members, existingUnits);
          for (const [key, member] of members) {
            if (member.orgId === orgId && member.sourceId === sourceId) members.delete(key);
          }
          for (const member of result.members) {
            members.set(
              memberKey(orgId, sourceId, member.externalSubjectId),
              cloneDirectoryMember({ ...member, snapshotRevision: nextSnapshotRevision }),
            );
          }
          sources.set(sourceKey(orgId, sourceId), withSnapshotRevision(source, nextSnapshotRevision));
        }
        return result.counts;
      });
    },
    async upsertMember(member) {
      const key = memberKey(member.orgId, member.sourceId, member.externalSubjectId);
      await enqueue(sourceKey(member.orgId, member.sourceId), async () => {
        const source = sources.get(sourceKey(member.orgId, member.sourceId));
        if (!source) throw new Error("directory_sync_source_not_found");
        validateMembers(member.orgId, member.sourceId, [member], source);
        const previous = members.get(key);
        const result = snapshotResult(previous ? [previous] : [], [member]);
        members.set(key, cloneDirectoryMember(result.members[0]!));
      });
    },
    async updateMemberMatch(orgId, sourceId, externalSubjectId, update, _audit, expectedProfileHash) {
      return enqueue(sourceKey(orgId, sourceId), async () => {
        const key = memberKey(orgId, sourceId, externalSubjectId);
        const member = members.get(key);
        if (!member || (expectedProfileHash !== undefined && member.profileHash !== expectedProfileHash)) return null;
        const next = { ...member, ...update };
        members.set(key, cloneDirectoryMember(next));
        return cloneDirectoryMember(next);
      });
    },
    async getEmailResolution(orgId, sourceId, emailHash) {
      const value = emailResolutions.get(emailResolutionKey(orgId, sourceId, emailHash));
      return value ? { ...value } : null;
    },
    async listEmailResolutions(orgId, sourceId) {
      return [...emailResolutions.values()]
        .filter((value) => value.orgId === orgId && value.sourceId === sourceId)
        .sort((left, right) => left.emailHash.localeCompare(right.emailHash))
        .map((value) => ({ ...value }));
    },
    async putEmailResolution(resolution) {
      if (!sources.has(sourceKey(resolution.orgId, resolution.sourceId))) {
        throw new Error("directory_email_resolution_source_not_found");
      }
      emailResolutions.set(emailResolutionKey(resolution.orgId, resolution.sourceId, resolution.emailHash), {
        ...resolution,
      });
    },
    async getEmailLookupGuard(orgId, sourceId) {
      const value = emailLookupGuards.get(sourceKey(orgId, sourceId));
      return value ? { ...value } : null;
    },
    async putEmailLookupGuard(guard) {
      if (!sources.has(sourceKey(guard.orgId, guard.sourceId))) {
        throw new Error("directory_email_guard_source_not_found");
      }
      emailLookupGuards.set(sourceKey(guard.orgId, guard.sourceId), { ...guard });
    },
    async createRun(run) {
      return enqueue(sourceKey(run.orgId, run.sourceId), async () => {
        const replay = [...runs.values()].find(
          (candidate) =>
            candidate.orgId === run.orgId &&
            candidate.sourceId === run.sourceId &&
            candidate.idempotencyKey === run.idempotencyKey,
        );
        if (replay) return cloneRun(replay);
        const running = [...runs.values()].find(
          (candidate) =>
            candidate.orgId === run.orgId && candidate.sourceId === run.sourceId && candidate.status === "running",
        );
        if (running) return cloneRun(running);
        runs.set(runKey(run.orgId, run.sourceId, run.id), cloneRun(run));
        return cloneRun(run);
      });
    },
    async getRun(orgId, sourceId, runId) {
      const run = runs.get(runKey(orgId, sourceId, runId));
      return run ? cloneRun(run) : null;
    },
    async listRuns(orgId, sourceId, limit = 50) {
      return [...runs.values()]
        .filter((run) => run.orgId === orgId && run.sourceId === sourceId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
        .map(cloneRun);
    },
    async claimRun(orgId, sourceId, runId, owner, at, leaseExpiresAt) {
      return enqueue(sourceKey(orgId, sourceId), async () => {
        const key = runKey(orgId, sourceId, runId);
        const current = runs.get(key);
        if (
          !current ||
          current.status !== "running" ||
          (current.leaseOwner !== null && current.leaseOwner !== owner && (current.leaseExpiresAt ?? 0) > at)
        ) {
          return null;
        }
        const claimed = {
          ...current,
          leaseOwner: owner,
          leaseExpiresAt,
          startedAt: current.startedAt ?? at,
          updatedAt: at,
        };
        runs.set(key, cloneRun(claimed));
        return cloneRun(claimed);
      });
    },
    async finishRun(run, expectedOwner, mutation) {
      return enqueue(sourceKey(run.orgId, run.sourceId), async () => {
        const key = runKey(run.orgId, run.sourceId, run.id);
        const current = runs.get(key);
        if (!current || current.status !== "running" || current.leaseOwner !== expectedOwner) return null;
        const source = sources.get(sourceKey(run.orgId, run.sourceId));
        if (!source) throw new Error("directory_sync_source_not_found");
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
        let counts = run.counts;
        if (!sourceChanged && mutation?.kind === "full") {
          validateMembers(run.orgId, run.sourceId, mutation.members, source);
          const existing = [...members.values()].filter(
            (member) => member.orgId === run.orgId && member.sourceId === run.sourceId,
          );
          const result = snapshotResult(existing, mutation.members);
          const existingUnits = [...units.values()].filter(
            (unit) => unit.orgId === run.orgId && unit.sourceId === run.sourceId,
          );
          validateUnits(run.orgId, run.sourceId, mutation.units ?? [], source);
          const nextUnits = unitSnapshotResult(existingUnits, mutation.units ?? []);
          counts = result.counts;
          if (!mutation.preview) {
            const nextSnapshotRevision = combinedSnapshotRevision(result.members, nextUnits);
            for (const [memberMapKey, member] of members) {
              if (member.orgId === run.orgId && member.sourceId === run.sourceId) members.delete(memberMapKey);
            }
            for (const member of result.members) {
              members.set(
                memberKey(run.orgId, run.sourceId, member.externalSubjectId),
                cloneDirectoryMember({ ...member, snapshotRevision: nextSnapshotRevision }),
              );
            }
            for (const [unitMapKey, unit] of units) {
              if (unit.orgId === run.orgId && unit.sourceId === run.sourceId) units.delete(unitMapKey);
            }
            for (const unit of nextUnits) {
              units.set(unitKey(run.orgId, run.sourceId, unit.externalUnitId), cloneDirectoryUnit(unit));
            }
            sources.set(sourceKey(run.orgId, run.sourceId), withSnapshotRevision(source, nextSnapshotRevision));
          }
        } else if (!sourceChanged && mutation?.kind === "targeted") {
          if (mutation.member) validateMembers(run.orgId, run.sourceId, [mutation.member], source);
          const targetKey = memberKey(run.orgId, run.sourceId, mutation.externalSubjectId);
          const previous = members.get(targetKey);
          if (mutation.member) {
            const result = snapshotResult(previous ? [previous] : [], [mutation.member]);
            members.set(targetKey, cloneDirectoryMember({ ...result.members[0]!, snapshotRevision: null }));
            counts = {
              ...result.counts,
              inactive: mutation.member.status === "inactive" ? 1 : 0,
            };
          } else if (previous) {
            members.set(
              targetKey,
              cloneDirectoryMember({
                ...previous,
                status: "inactive",
                observedAt: run.completedAt ?? run.updatedAt,
                matchState: "inactive",
                matchReason: "target_not_found",
                snapshotRevision: null,
              }),
            );
            counts = { observed: 0, added: 0, changed: 1, inactive: 1, unchanged: 0 };
          }
          if (mutation.member || previous) {
            sources.set(sourceKey(run.orgId, run.sourceId), {
              ...source,
              memberSnapshotRevision: null,
              reconciliationStatus: "stale",
              reconciledSourceRevision: null,
              reconciledMemberSnapshotRevision: null,
              reconciledAt: null,
              reconciliationExpiresAt: null,
              jitProvisioningEnabled: false,
            });
          }
        }
        const completed = { ...finalized, counts, leaseOwner: null, leaseExpiresAt: null };
        runs.set(key, cloneRun(completed));
        return cloneRun(completed);
      });
    },
    async renewRun(orgId, sourceId, runId, owner, at, leaseExpiresAt) {
      return enqueue(sourceKey(orgId, sourceId), async () => {
        const key = runKey(orgId, sourceId, runId);
        const current = runs.get(key);
        if (!current || current.status !== "running" || current.leaseOwner !== owner) return false;
        runs.set(key, cloneRun({ ...current, leaseExpiresAt, updatedAt: at }));
        return true;
      });
    },
    async findRunningRun(orgId, sourceId) {
      const run = [...runs.values()].find(
        (candidate) => candidate.orgId === orgId && candidate.sourceId === sourceId && candidate.status === "running",
      );
      return run ? cloneRun(run) : null;
    },
    async latestSucceededAt(orgId, sourceId) {
      const completed = [...runs.values()]
        .filter((run) => run.orgId === orgId && run.sourceId === sourceId && run.status === "succeeded")
        .map((run) => run.completedAt ?? 0);
      return completed.length ? Math.max(...completed) : null;
    },
    async close() {},
  };
}

export function validateMembers(
  orgId: string,
  sourceId: string,
  members: readonly NormalizedDirectoryMember[],
  source?: Pick<StoredDirectorySource, "provider" | "externalTenantId" | "capabilities">,
): void {
  const subjects = new Set<string>();
  for (const member of members) {
    if (
      member.orgId !== orgId ||
      member.sourceId !== sourceId ||
      (source && (member.provider !== source.provider || member.externalTenantId !== source.externalTenantId)) ||
      !member.externalSubjectId ||
      subjects.has(member.externalSubjectId)
    ) {
      throw new Error("directory_sync_member_scope_mismatch");
    }
    if (
      source?.capabilities.trustedCorporateEmail !== true &&
      member.emails.some((email) => email.kind === "corporate" && email.verified)
    ) {
      throw new Error("directory_sync_untrusted_corporate_email");
    }
    subjects.add(member.externalSubjectId);
  }
}

export function validateUnits(
  orgId: string,
  sourceId: string,
  units: readonly NormalizedDirectoryUnit[],
  source?: Pick<StoredDirectorySource, "provider" | "externalTenantId">,
): void {
  const ids = new Set<string>();
  for (const unit of units) {
    if (
      unit.orgId !== orgId ||
      unit.sourceId !== sourceId ||
      (source && (unit.provider !== source.provider || unit.externalTenantId !== source.externalTenantId)) ||
      !unit.externalUnitId ||
      ids.has(unit.externalUnitId)
    ) {
      throw new Error("directory_sync_unit_scope_mismatch");
    }
    ids.add(unit.externalUnitId);
  }
  if (units.some((unit) => unit.parentExternalUnitId !== null && !ids.has(unit.parentExternalUnitId))) {
    throw new Error("directory_sync_unit_parent_missing");
  }
}

export { combinedSnapshotRevision, snapshotResult, unitSnapshotResult };
