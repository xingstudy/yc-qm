import { createHash, randomUUID } from "node:crypto";
import type { IdentityService } from "../identity/identity-service.ts";
import type { OrganizationStore, OrgUnit, OrgUnitMember } from "../organization/organization-store.ts";
import type { ScopeId } from "../types.ts";
import { errMessage } from "../util/errors.ts";
import { createSweeper } from "../util/sweeper.ts";
import type { DirectorySourceService } from "./directory-source-service.ts";
import type { DirectorySourceStore } from "./directory-source-store.ts";
import type { IdentityLinkingService } from "./identity-linking-service.ts";
import type {
  DirectoryManagedUserOwnership,
  DirectoryMemberCursor,
  DirectoryUnitMapping,
  DirectoryUnitMemberOwnership,
  ManagedDirectoryAuthorizationImpact,
  ManagedDirectoryMemberPlan,
  ManagedDirectoryPreservedItem,
  ManagedDirectoryPreview,
  ManagedDirectoryRelationPlan,
  ManagedDirectoryUnitPlan,
  NormalizedDirectoryMember,
  NormalizedDirectoryUnit,
} from "./types.ts";

export interface ManagedDirectoryService {
  preview(sourceId: string, actor: string): Promise<ManagedDirectoryPreview>;
  commit(sourceId: string, previewId: string, actor: string): Promise<ManagedDirectoryPreview>;
  decideUnitMapping(input: {
    sourceId: string;
    previewId: string;
    externalUnitId: string;
    decision: "create" | "map";
    actor: string;
  }): Promise<"mapped" | "conflict" | "not_found">;
  recoverCommitting(): Promise<void>;
  start(): void;
  stop(): void;
}

const PREVIEW_TTL_MS = 30 * 60_000;

interface ManagedCommitProjection {
  principals: Array<[string, string]>;
  createdOwnership: DirectoryManagedUserOwnership[];
  desiredOwnership: DirectoryUnitMemberOwnership[];
  removedOwnership: DirectoryUnitMemberOwnership[];
  suspended: Array<{ principalId: string; sessionVersion: number }>;
  reactivated: Array<{ principalId: string; sessionVersion: number }>;
  changedUserOwnership: DirectoryManagedUserOwnership[];
}

function commitProjectionFrom(value: Record<string, unknown>): ManagedCommitProjection {
  const fields = [
    value.principals,
    value.createdOwnership,
    value.desiredOwnership,
    value.removedOwnership,
    value.suspended,
    value.reactivated,
    value.changedUserOwnership,
  ];
  if (fields.some((field) => !Array.isArray(field))) throw new Error("managed_directory_commit_result_invalid");
  return value as unknown as ManagedCommitProjection;
}

function externalIdentityKey(provider: string, tenant: string, subject: string): string {
  return `${provider}\n${tenant}\n${subject}`;
}

function identityFingerprint(
  identities: readonly {
    provider?: string | null;
    externalTenantId?: string | null;
    externalSubjectId?: string | null;
    principalId: string;
  }[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        identities
          .filter((identity) => identity.provider && identity.externalTenantId && identity.externalSubjectId)
          .map((identity) => [
            identity.provider,
            identity.externalTenantId,
            identity.externalSubjectId,
            identity.principalId,
          ])
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      ),
    )
    .digest("base64url");
}

function mappingFingerprint(mappings: readonly DirectoryUnitMapping[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        mappings
          .map((mapping) => [mapping.externalUnitId, mapping.unitId, mapping.ownership])
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      ),
    )
    .digest("base64url");
}

function memberFingerprint(members: readonly NormalizedDirectoryMember[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        members
          .map((member) => [
            member.externalSubjectId,
            member.snapshotRevision,
            member.profileHash,
            member.status,
            member.matchState,
            member.matchReason,
            member.matchedPrincipalId,
            member.ignoredBy,
            member.ignoredReason,
          ])
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      ),
    )
    .digest("base64url");
}

function stableUnitId(provider: string, tenant: string, externalUnitId: string): string {
  const digest = createHash("sha256")
    .update(`${provider}\n${tenant}\n${externalUnitId}`)
    .digest("base64url")
    .slice(0, 32);
  return `directory-unit:${digest}`;
}

function managedActorFor(sourceId: string): string {
  return `system:managed-directory:${sourceId}`;
}

function depth(unit: NormalizedDirectoryUnit, units: Map<string, NormalizedDirectoryUnit>): number {
  let result = 0;
  let current = unit;
  const seen = new Set<string>();
  while (current.parentExternalUnitId !== null) {
    if (seen.has(current.externalUnitId)) throw new Error("managed_directory_unit_cycle");
    seen.add(current.externalUnitId);
    const parent = units.get(current.parentExternalUnitId);
    if (!parent) throw new Error("managed_directory_unit_parent_missing");
    result++;
    current = parent;
  }
  return result;
}

async function listAllMembers(
  store: DirectorySourceStore,
  orgId: string,
  sourceId: string,
): Promise<NormalizedDirectoryMember[]> {
  const members: NormalizedDirectoryMember[] = [];
  const cursors = new Set<string>();
  let after: DirectoryMemberCursor | null = null;
  do {
    const page = await store.listMembers(orgId, sourceId, { after, limit: 1_000 });
    members.push(...page.members);
    if (page.next) {
      if (cursors.has(page.next.externalSubjectId)) throw new Error("managed_directory_member_cursor_cycle");
      cursors.add(page.next.externalSubjectId);
    }
    after = page.next;
  } while (after);
  return members;
}

export function createManagedDirectoryService(options: {
  orgId: string;
  store: DirectorySourceStore;
  sources: DirectorySourceService;
  organizationStore: OrganizationStore;
  identityLinking: IdentityLinkingService;
  identity: IdentityService;
  now?: () => number;
  recoveryIntervalMs?: number;
}): ManagedDirectoryService {
  const { orgId, store, sources, organizationStore, identityLinking, identity } = options;
  const now = options.now ?? Date.now;
  const scopeLabel = `org:${orgId}` as ScopeId;
  const event = (actor: string, action: string, sourceId: string, detail: Record<string, unknown>) => ({
    at: now(),
    principalId: actor,
    action,
    resource: sourceId,
    scopeLabel,
    orgId,
    actorKind: actor.startsWith("system:") ? ("system" as const) : ("user" as const),
    source: "managed-directory",
    result: "success",
    detail: JSON.stringify(detail),
  });

  const buildPreview = async (sourceId: string, actor: string): Promise<ManagedDirectoryPreview> => {
    if ((await store.listManagedPreviews(orgId, "committing")).some((preview) => preview.sourceId === sourceId)) {
      throw new Error("managed_directory_commit_in_progress");
    }
    const source = await sources.get(sourceId);
    if (!source || source.status !== "active") throw new Error("managed_directory_source_disabled");
    if (source.mode !== "managed_directory") throw new Error("managed_directory_mode_required");
    if (!source.memberSnapshotRevision) throw new Error("managed_directory_snapshot_required");
    const [
      snapshotUnits,
      snapshotMembers,
      mappings,
      orgUnits,
      identities,
      orgUsers,
      ownership,
      userOwnership,
      organizationRevision,
    ] = await Promise.all([
      store.listUnits(orgId, sourceId),
      listAllMembers(store, orgId, sourceId),
      store.listUnitMappings(orgId, sourceId),
      organizationStore.listUnits(orgId),
      organizationStore.listIdentities(orgId),
      organizationStore.listUsers(orgId),
      store.listUnitMemberOwnership(orgId, sourceId),
      store.listManagedUserOwnership(orgId, sourceId),
      organizationStore.getAuthzRevision(orgId),
    ]);
    const externalUnits = new Map(snapshotUnits.map((unit) => [unit.externalUnitId, unit]));
    const mappingByExternal = new Map(mappings.map((mapping) => [mapping.externalUnitId, mapping]));
    const orgById = new Map(orgUnits.map((unit) => [unit.id, unit]));
    const managedActor = managedActorFor(sourceId);
    const root = orgUnits.find((unit) => unit.parentId === null && unit.status === "active");
    if (!root) throw new Error("managed_directory_org_root_missing");
    const plannedUnitIds = new Map<string, string>();
    for (const unit of snapshotUnits) {
      plannedUnitIds.set(
        unit.externalUnitId,
        mappingByExternal.get(unit.externalUnitId)?.unitId ??
          stableUnitId(source.provider, source.externalTenantId, unit.externalUnitId),
      );
    }
    const conflicts: string[] = [];
    const unitPlans: ManagedDirectoryUnitPlan[] = [];
    const preserved: ManagedDirectoryPreservedItem[] = [];
    const authorizationImpacts: ManagedDirectoryAuthorizationImpact[] = [];
    const activeUnits = snapshotUnits
      .filter((unit) => unit.status === "active")
      .sort((left, right) => depth(left, externalUnits) - depth(right, externalUnits));
    for (const unit of activeUnits) {
      const mapping = mappingByExternal.get(unit.externalUnitId);
      const unitId = plannedUnitIds.get(unit.externalUnitId)!;
      const parentUnitId = unit.parentExternalUnitId ? plannedUnitIds.get(unit.parentExternalUnitId) : root.id;
      if (!parentUnitId) {
        conflicts.push(`unit_parent_missing:${unit.externalUnitId}`);
        continue;
      }
      const name = unit.displayName?.trim() ?? "";
      if (!name) {
        conflicts.push(`unit_name_missing:${unit.externalUnitId}`);
        continue;
      }
      const current = orgById.get(unitId);
      if (current && !mappingByExternal.has(unit.externalUnitId) && current.createdBy !== managedActor) {
        conflicts.push(`managed_unit_id_collision:${unit.externalUnitId}`);
      }
      const collision = orgUnits.find(
        (candidate) =>
          candidate.id !== unitId &&
          candidate.parentId === parentUnitId &&
          candidate.status === "active" &&
          candidate.name.toLowerCase() === name.toLowerCase(),
      );
      if (collision && !mapping) conflicts.push(`manual_unit_name_collision:${unit.externalUnitId}`);
      let action: ManagedDirectoryUnitPlan["action"] = "unchanged";
      if (mapping?.ownership === "manual" && (!current || current.status !== "active")) {
        conflicts.push(`manual_unit_mapping_missing:${unit.externalUnitId}`);
      } else if (!current) action = "create";
      else if (
        mapping?.ownership !== "manual" &&
        (current.name !== name ||
          current.parentId !== parentUnitId ||
          current.sortOrder !== unit.sortOrder ||
          current.status !== "active")
      ) {
        action = "update";
      }
      unitPlans.push({
        externalUnitId: unit.externalUnitId,
        unitId,
        parentUnitId: mapping?.ownership === "manual" && current ? (current.parentId ?? root.id) : parentUnitId,
        name: mapping?.ownership === "manual" && current ? current.name : name,
        sortOrder: mapping?.ownership === "manual" && current ? current.sortOrder : unit.sortOrder,
        ownership: mapping?.ownership ?? "source",
        collisionUnitId: collision?.id ?? null,
        action,
      });
      if (mapping?.ownership === "manual") {
        preserved.push({ kind: "manual_unit", resourceId: unitId, detail: unit.externalUnitId });
      }
    }
    const inactiveUnits = snapshotUnits
      .filter((unit) => unit.status === "inactive")
      .sort((left, right) => depth(left, externalUnits) - depth(right, externalUnits));
    const inactiveUnitIds = new Set(inactiveUnits.map((unit) => unit.externalUnitId));
    const ownershipKeys = new Set(ownership.map((item) => `${item.unitId}\n${item.principalId}`));
    for (const unit of inactiveUnits) {
      const mapping = mappingByExternal.get(unit.externalUnitId);
      if (!mapping) continue;
      const current = orgById.get(mapping.unitId);
      if (!current || current.status === "archived") continue;
      if (mapping.ownership === "manual") {
        unitPlans.push({
          externalUnitId: unit.externalUnitId,
          unitId: current.id,
          parentUnitId: current.parentId ?? root.id,
          name: current.name,
          sortOrder: current.sortOrder,
          ownership: "manual",
          collisionUnitId: null,
          action: "unchanged",
        });
        preserved.push({ kind: "manual_unit", resourceId: current.id, detail: unit.externalUnitId });
        continue;
      }
      const [impact, members] = await Promise.all([
        organizationStore.unitImpact(orgId, current.id),
        organizationStore.listUnitMembers(orgId, current.id),
      ]);
      const unrelatedChild = orgUnits.some(
        (candidate) =>
          candidate.parentId === current.id &&
          candidate.status === "active" &&
          ![...inactiveUnitIds].some(
            (externalUnitId) => mappingByExternal.get(externalUnitId)?.unitId === candidate.id,
          ),
      );
      const unrelatedMember = members.some(
        (member) => member.role === "manager" || !ownershipKeys.has(`${member.unitId}\n${member.principalId}`),
      );
      authorizationImpacts.push({
        externalUnitId: unit.externalUnitId,
        unitId: current.id,
        activeChildUnits: impact.activeChildUnits,
        activeMembers: impact.activeMembers,
        directoryRoots: impact.directoryRoots,
        accessGrants: impact.accessGrants,
      });
      if (unrelatedChild || unrelatedMember || impact.directoryRoots > 0 || impact.accessGrants > 0) {
        conflicts.push(`managed_unit_archive_conflict:${unit.externalUnitId}`);
      }
      unitPlans.push({
        externalUnitId: unit.externalUnitId,
        unitId: current.id,
        parentUnitId: current.parentId ?? root.id,
        name: current.name,
        sortOrder: current.sortOrder,
        ownership: "source",
        collisionUnitId: null,
        action: "archive",
      });
    }
    const identityByExternal = new Map(
      identities
        .filter((identity) => identity.provider && identity.externalTenantId && identity.externalSubjectId)
        .map((identity) => [
          externalIdentityKey(identity.provider!, identity.externalTenantId!, identity.externalSubjectId!),
          identity,
        ]),
    );
    const managedBySubject = new Map(userOwnership.map((item) => [item.externalSubjectId, item]));
    const userByPrincipal = new Map(orgUsers.map((user) => [user.principalId, user]));
    const memberPlans: ManagedDirectoryMemberPlan[] = [];
    for (const member of snapshotMembers) {
      const linked = identityByExternal.get(
        externalIdentityKey(member.provider, member.externalTenantId, member.externalSubjectId),
      );
      if (member.matchState === "conflict" || member.matchState === "ignored") {
        conflicts.push(`managed_member_${member.matchState}:${member.externalSubjectId}`);
        continue;
      }
      const externalUnitIds = member.departmentIds.filter((externalUnitId) => {
        if (plannedUnitIds.has(externalUnitId)) return true;
        conflicts.push(`member_unit_missing:${member.externalSubjectId}:${externalUnitId}`);
        return false;
      });
      if (member.status === "active") {
        const principalId = linked?.principalId ?? member.matchedPrincipalId;
        const linkedUser = principalId ? userByPrincipal.get(principalId) : null;
        const owned = managedBySubject.get(member.externalSubjectId);
        if (owned && principalId && owned.principalId !== principalId) {
          conflicts.push(`managed_user_ownership_principal_conflict:${member.externalSubjectId}`);
          continue;
        }
        if (
          linkedUser?.status === "deprovisioned" ||
          (linkedUser?.status === "suspended" &&
            (!owned?.suspendedBySource || owned.suspendedSessionVersion !== linkedUser.sessionVersion))
        ) {
          conflicts.push(`managed_member_status_conflict:${member.externalSubjectId}`);
          continue;
        }
        memberPlans.push({
          externalSubjectId: member.externalSubjectId,
          principalId,
          externalUnitIds,
          primaryExternalUnitId:
            member.primaryDepartmentId && externalUnitIds.includes(member.primaryDepartmentId)
              ? member.primaryDepartmentId
              : (externalUnitIds[0] ?? null),
          action: linked || member.matchedPrincipalId ? "update" : "provision",
          snapshotMember: member,
        });
      } else {
        const owned = managedBySubject.get(member.externalSubjectId);
        if (owned && linked && owned.principalId !== linked.principalId) {
          conflicts.push(`managed_user_ownership_principal_conflict:${member.externalSubjectId}`);
          continue;
        }
        if (owned) {
          memberPlans.push({
            externalSubjectId: member.externalSubjectId,
            principalId: owned.principalId,
            externalUnitIds: [],
            primaryExternalUnitId: null,
            action: "suspend",
            snapshotMember: member,
          });
        }
      }
    }
    const knownPrincipalIds = [
      ...new Set(memberPlans.map((plan) => plan.principalId).filter((value): value is string => Boolean(value))),
    ];
    const currentRelations = knownPrincipalIds.length
      ? await organizationStore.listUnitMembersForUsers(orgId, knownPrincipalIds)
      : [];
    const relationPlans: ManagedDirectoryRelationPlan[] = [];
    const unitPlanByExternal = new Map(unitPlans.map((plan) => [plan.externalUnitId, plan]));
    for (const plan of memberPlans) {
      const desired = new Map(
        plan.externalUnitIds.map((externalUnitId) => {
          const unitPlan = unitPlanByExternal.get(externalUnitId);
          if (!unitPlan) throw new Error("managed_directory_unit_mapping_missing");
          return [externalUnitId, unitPlan] as const;
        }),
      );
      const prior = plan.principalId ? ownership.filter((item) => item.principalId === plan.principalId) : [];
      const direct = plan.principalId ? currentRelations.filter((item) => item.principalId === plan.principalId) : [];
      for (const [externalUnitId, unitPlan] of desired) {
        const primary = plan.primaryExternalUnitId === externalUnitId;
        const priorOwned = prior.find((item) => item.unitId === unitPlan.unitId);
        const current = direct.find((item) => item.unitId === unitPlan.unitId);
        let action: ManagedDirectoryRelationPlan["action"] = "add";
        if (priorOwned) action = priorOwned.primary === primary ? "unchanged" : "update";
        else if (current) action = "preserve";
        relationPlans.push({
          externalSubjectId: plan.externalSubjectId,
          principalId: plan.principalId,
          externalUnitId,
          unitId: unitPlan.unitId,
          primary,
          action,
        });
        if (action === "preserve") {
          preserved.push({
            kind: "manual_relation",
            resourceId: `${unitPlan.unitId}:${plan.principalId}`,
            detail: primary ? "primary" : "secondary",
          });
        }
      }
      for (const priorOwned of prior) {
        if ([...desired.values()].some((unitPlan) => unitPlan.unitId === priorOwned.unitId)) continue;
        relationPlans.push({
          externalSubjectId: plan.externalSubjectId,
          principalId: plan.principalId,
          externalUnitId: null,
          unitId: priorOwned.unitId,
          primary: priorOwned.primary,
          action: "remove",
        });
      }
      for (const current of direct) {
        if (
          prior.some((item) => item.unitId === current.unitId) ||
          [...desired.values()].some((unitPlan) => unitPlan.unitId === current.unitId)
        ) {
          continue;
        }
        relationPlans.push({
          externalSubjectId: plan.externalSubjectId,
          principalId: plan.principalId,
          externalUnitId: null,
          unitId: current.unitId,
          primary: current.isPrimary === true,
          action: "preserve",
        });
        preserved.push({
          kind: "manual_relation",
          resourceId: `${current.unitId}:${plan.principalId}`,
          detail: current.isPrimary ? "primary" : "secondary",
        });
      }
      if (plan.principalId) {
        const currentUser = userByPrincipal.get(plan.principalId);
        if (currentUser) {
          const snapshot = plan.snapshotMember;
          if (!snapshot.emails.some((email) => email.kind === "corporate" && email.verified) && currentUser.email) {
            preserved.push({ kind: "profile_field", resourceId: plan.principalId, detail: "email" });
          }
          if (snapshot.mobile === null && currentUser.mobile) {
            preserved.push({ kind: "profile_field", resourceId: plan.principalId, detail: "mobile" });
          }
          if (snapshot.employeeNumber === null && currentUser.employeeNumber) {
            preserved.push({ kind: "profile_field", resourceId: plan.principalId, detail: "employeeNumber" });
          }
        }
      }
    }
    const at = now();
    const priorPreviews = (
      await Promise.all(
        (["ready", "blocked", "committing", "committed"] as const).map((status) =>
          store.listManagedPreviews(orgId, status),
        ),
      )
    )
      .flat()
      .filter((preview) => preview.sourceId === sourceId);
    const preview: ManagedDirectoryPreview = {
      id: randomUUID(),
      orgId,
      sourceId,
      generation: Math.max(0, ...priorPreviews.map((candidate) => candidate.generation)) + 1,
      sourceRevision: source.revision,
      snapshotRevision: source.memberSnapshotRevision,
      organizationRevision,
      identityFingerprint: identityFingerprint(identities),
      mappingFingerprint: mappingFingerprint(mappings),
      memberFingerprint: memberFingerprint(snapshotMembers),
      status: conflicts.length ? "blocked" : "ready",
      units: unitPlans,
      members: memberPlans,
      relations: relationPlans,
      preserved,
      authorizationImpacts,
      conflicts,
      createdAt: at,
      expiresAt: at + PREVIEW_TTL_MS,
      committedAt: null,
      actor,
    };
    await store.putManagedPreview(preview);
    return preview;
  };

  const supersedeIfCommittedGenerationWon = async (
    preview: ManagedDirectoryPreview,
  ): Promise<ManagedDirectoryPreview | null> => {
    const newer = (await store.listManagedPreviews(orgId, "committed")).some(
      (candidate) =>
        candidate.sourceId === preview.sourceId &&
        (candidate.generation > preview.generation ||
          (candidate.generation === 0 && preview.generation === 0 && candidate.createdAt > preview.createdAt)),
    );
    if (!newer) return null;
    const blocked: ManagedDirectoryPreview = {
      ...preview,
      status: "blocked",
      conflicts: [...new Set([...preview.conflicts, "superseded_by_newer_commit"])],
    };
    await store.putManagedPreview(blocked);
    return blocked;
  };

  const recoverCommitting = async (): Promise<void> => {
    const errors: unknown[] = [];
    for (const preview of await store.listManagedPreviews(orgId, "committing")) {
      try {
        await service.commit(preview.sourceId, preview.id, preview.actor);
      } catch (error) {
        if (errMessage(error) !== "managed_directory_preview_superseded") errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "managed_directory_recovery_failed");
  };
  const recovery = createSweeper(recoverCommitting, options.recoveryIntervalMs ?? 30_000, {
    label: "managed-directory-recovery",
    immediate: true,
  });
  const service: ManagedDirectoryService = {
    preview(sourceId, actor) {
      return store.withSourceLock(orgId, sourceId, () => buildPreview(sourceId, actor));
    },
    async decideUnitMapping(input) {
      return store.withSourceLock(orgId, input.sourceId, async () => {
        const source = await sources.get(input.sourceId);
        if (!source || source.status !== "active" || source.mode !== "managed_directory") return "not_found";
        const preview = await store.getManagedPreview(orgId, input.sourceId, input.previewId);
        if (!preview || preview.expiresAt <= now()) return "not_found";
        const plan = preview.units.find((unit) => unit.externalUnitId === input.externalUnitId);
        if (
          !plan?.collisionUnitId ||
          source.revision !== preview.sourceRevision ||
          source.memberSnapshotRevision !== preview.snapshotRevision
        ) {
          return "conflict";
        }
        const externalUnit = (await store.listUnits(orgId, input.sourceId)).find(
          (unit) => unit.externalUnitId === input.externalUnitId && unit.status === "active",
        );
        if (!externalUnit) return "not_found";
        return organizationStore.transact(orgId, async (tx) => {
          const [mappings, organizationRevision, identities] = await Promise.all([
            store.listUnitMappings(orgId, input.sourceId),
            tx.getAuthzRevision(orgId),
            tx.listIdentities(orgId),
          ]);
          if (
            mappingFingerprint(mappings) !== preview.mappingFingerprint ||
            organizationRevision !== preview.organizationRevision ||
            identityFingerprint(identities) !== preview.identityFingerprint
          ) {
            return "conflict";
          }
          const prior = mappings.find((mapping) => mapping.externalUnitId === input.externalUnitId);
          const unitId =
            input.decision === "create"
              ? stableUnitId(source.provider, source.externalTenantId, input.externalUnitId)
              : plan.collisionUnitId;
          if (!unitId) return "not_found";
          if (
            mappings.some((mapping) => mapping.externalUnitId !== input.externalUnitId && mapping.unitId === unitId)
          ) {
            return "conflict";
          }
          const unit = await tx.getUnit(orgId, unitId);
          if (
            input.decision === "map" &&
            (!unit ||
              unit.status !== "active" ||
              unit.parentId === null ||
              unit.parentId !== plan.parentUnitId ||
              unit.name.trim().toLowerCase() !== plan.name.trim().toLowerCase())
          ) {
            return "not_found";
          }
          if (input.decision === "create" && unit && unit.createdBy !== managedActorFor(input.sourceId)) {
            return "conflict";
          }
          const at = now();
          const mapping = {
            orgId,
            provider: source.provider,
            externalTenantId: source.externalTenantId,
            externalUnitId: input.externalUnitId,
            sourceId: input.sourceId,
            unitId,
            ownership: input.decision === "map" ? "manual" : "source",
            createdAt: prior?.createdAt ?? at,
            updatedAt: at,
          } as const;
          const audit = event(input.actor, "managed_directory.unit_mapping_decide", input.sourceId, {
            externalUnitId: input.externalUnitId,
            unitId,
            decision: input.decision,
            previewId: input.previewId,
          });
          await store.putUnitMapping(mapping, audit);
          if (!store.durable) await tx.audit(audit);
          return "mapped";
        });
      });
    },
    async commit(sourceId, previewId, actor) {
      return store.withSourceLock(orgId, sourceId, async () => {
        const storedPreview = await store.getManagedPreview(orgId, sourceId, previewId);
        if (!storedPreview) throw new Error("managed_directory_preview_not_found");
        let preview = storedPreview;
        if (preview.status === "committed") return preview;
        if (preview.status === "committing" && (await supersedeIfCommittedGenerationWon(preview))) {
          throw new Error("managed_directory_preview_superseded");
        }
        if (
          (await store.listManagedPreviews(orgId, "committing")).some(
            (candidate) => candidate.sourceId === sourceId && candidate.id !== preview.id,
          )
        ) {
          throw new Error("managed_directory_commit_in_progress");
        }
        if ((preview.status !== "ready" && preview.status !== "committing") || preview.conflicts.length) {
          throw new Error("managed_directory_preview_blocked");
        }
        const resuming = preview.status === "committing";
        if (!resuming && preview.expiresAt <= now()) throw new Error("managed_directory_preview_expired");
        const source = await sources.get(sourceId, resuming);
        if (
          !source ||
          (!resuming &&
            (source.status !== "active" ||
              source.mode !== "managed_directory" ||
              source.revision !== preview.sourceRevision ||
              source.memberSnapshotRevision !== preview.snapshotRevision))
        ) {
          throw new Error("managed_directory_preview_stale");
        }
        if (!resuming) {
          const [currentMappings, currentMembers] = await Promise.all([
            store.listUnitMappings(orgId, sourceId),
            listAllMembers(store, orgId, sourceId),
          ]);
          if (
            mappingFingerprint(currentMappings) !== preview.mappingFingerprint ||
            memberFingerprint(currentMembers) !== preview.memberFingerprint
          ) {
            throw new Error("managed_directory_preview_stale");
          }
        }
        if (!resuming) {
          const [currentOrganizationRevision, currentIdentities] = await Promise.all([
            organizationStore.getAuthzRevision(orgId),
            organizationStore.listIdentities(orgId),
          ]);
          if (
            currentOrganizationRevision !== preview.organizationRevision ||
            identityFingerprint(currentIdentities) !== preview.identityFingerprint
          ) {
            throw new Error("managed_directory_preview_stale");
          }
        }
        if (!resuming) {
          preview = { ...preview, status: "committing", actor };
          await store.putManagedPreview(preview);
        }
        if (
          preview.members.some(
            (plan) =>
              !plan.snapshotMember ||
              plan.snapshotMember.sourceId !== sourceId ||
              plan.snapshotMember.externalSubjectId !== plan.externalSubjectId,
          )
        ) {
          throw new Error("managed_directory_preview_stale");
        }
        const existingUserOwnership = await store.listManagedUserOwnership(orgId, sourceId);
        const ownedSubjects = new Set(existingUserOwnership.map((ownership) => ownership.externalSubjectId));
        const memberBySubject = new Map(preview.members.map((plan) => [plan.externalSubjectId, plan.snapshotMember]));
        const principals = new Map<string, string>();
        const createdOwnership: DirectoryManagedUserOwnership[] = [];
        const managedActor = managedActorFor(sourceId);
        const [priorOwnership, priorUserOwnership] = await Promise.all([
          store.listUnitMemberOwnership(orgId, sourceId),
          store.listManagedUserOwnership(orgId, sourceId),
        ]);
        const planByExternalUnit = new Map(preview.units.map((plan) => [plan.externalUnitId, plan]));
        const desiredOwnership: DirectoryUnitMemberOwnership[] = [];
        const removedOwnership: DirectoryUnitMemberOwnership[] = [];
        const suspended: Array<{ principalId: string; sessionVersion: number }> = [];
        const reactivated: Array<{ principalId: string; sessionVersion: number }> = [];
        const changedUserOwnership: DirectoryManagedUserOwnership[] = [];
        const operationKey = `managed-directory:${orgId}:${sourceId}:${previewId}`;
        let organizationApplied = false;
        try {
          await organizationStore.transact(orgId, async (tx) => {
            const storedProjection = await tx.getOperationResult(operationKey);
            if (storedProjection) {
              const projection = commitProjectionFrom(storedProjection);
              for (const [externalSubjectId, principalId] of projection.principals) {
                principals.set(externalSubjectId, principalId);
              }
              createdOwnership.push(...projection.createdOwnership);
              desiredOwnership.push(...projection.desiredOwnership);
              removedOwnership.push(...projection.removedOwnership);
              suspended.push(...projection.suspended);
              reactivated.push(...projection.reactivated);
              changedUserOwnership.push(...projection.changedUserOwnership);
              organizationApplied = true;
              return;
            }
            const at = now();
            const [currentSource, currentMappings, currentMembers, currentOrganizationRevision, currentIdentities] =
              await Promise.all([
                sources.get(sourceId),
                store.listUnitMappings(orgId, sourceId),
                listAllMembers(store, orgId, sourceId),
                tx.getAuthzRevision(orgId),
                tx.listIdentities(orgId),
              ]);
            if (
              !currentSource ||
              currentSource.status !== "active" ||
              currentSource.mode !== "managed_directory" ||
              currentSource.revision !== preview.sourceRevision ||
              currentSource.memberSnapshotRevision !== preview.snapshotRevision ||
              mappingFingerprint(currentMappings) !== preview.mappingFingerprint ||
              memberFingerprint(currentMembers) !== preview.memberFingerprint ||
              currentOrganizationRevision !== preview.organizationRevision ||
              identityFingerprint(currentIdentities) !== preview.identityFingerprint
            ) {
              throw new Error("managed_directory_preview_stale");
            }
            for (const plan of preview.members) {
              if (plan.action === "suspend") {
                if (plan.principalId) principals.set(plan.externalSubjectId, plan.principalId);
                continue;
              }
              if (plan.principalId) {
                principals.set(plan.externalSubjectId, plan.principalId);
                continue;
              }
              const result = await identityLinking.provisionSnapshotMemberInTransactionWithSourceLockHeld(
                tx,
                plan.snapshotMember,
                managedActor,
              );
              if (result.status !== "ok") throw new Error(`managed_directory_provision_${result.reason}`);
              principals.set(plan.externalSubjectId, result.user.principalId);
              reactivated.push({ principalId: result.user.principalId, sessionVersion: result.user.sessionVersion });
              if (result.user.createdBy === managedActor) {
                createdOwnership.push({
                  orgId,
                  sourceId,
                  externalSubjectId: plan.externalSubjectId,
                  principalId: result.user.principalId,
                  suspendedBySource: false,
                  suspendedSessionVersion: null,
                  createdAt: at,
                  updatedAt: at,
                });
              }
            }
            for (const plan of preview.members.filter((member) => member.action !== "suspend")) {
              const principalId = principals.get(plan.externalSubjectId) ?? plan.principalId;
              if (!principalId) continue;
              if (
                ownedSubjects.has(plan.externalSubjectId) ||
                createdOwnership.some((ownership) => ownership.externalSubjectId === plan.externalSubjectId)
              ) {
                continue;
              }
              const user = await tx.getUser(orgId, principalId);
              if (user?.createdBy !== managedActor) continue;
              createdOwnership.push({
                orgId,
                sourceId,
                externalSubjectId: plan.externalSubjectId,
                principalId,
                suspendedBySource: false,
                suspendedSessionVersion: null,
                createdAt: at,
                updatedAt: at,
              });
            }
            for (const plan of preview.units.filter(
              (unit) => unit.action !== "archive" && unit.ownership === "source",
            )) {
              const current = await tx.getUnit(orgId, plan.unitId);
              const unit: OrgUnit = current
                ? {
                    ...current,
                    parentId: plan.parentUnitId,
                    name: plan.name,
                    status: "active",
                    sortOrder: plan.sortOrder,
                    updatedAt: at,
                    updatedBy: actor,
                  }
                : {
                    orgId,
                    id: plan.unitId,
                    parentId: plan.parentUnitId,
                    name: plan.name,
                    kind: "department",
                    status: "active",
                    sortOrder: plan.sortOrder,
                    createdAt: at,
                    updatedAt: at,
                    createdBy: managedActor,
                    updatedBy: actor,
                  };
              await tx.putUnit(unit);
            }
            const priorByPrincipal = new Map<string, DirectoryUnitMemberOwnership[]>();
            for (const ownership of priorOwnership) {
              const list = priorByPrincipal.get(ownership.principalId) ?? [];
              list.push(ownership);
              priorByPrincipal.set(ownership.principalId, list);
            }
            for (const plan of preview.members) {
              const principalId = principals.get(plan.externalSubjectId) ?? plan.principalId;
              if (!principalId) throw new Error("managed_directory_principal_missing");
              const user = await tx.getUser(orgId, principalId);
              if (!user) throw new Error("managed_directory_user_missing");
              const ownedUser = [...priorUserOwnership, ...createdOwnership].find(
                (ownership) =>
                  ownership.externalSubjectId === plan.externalSubjectId && ownership.principalId === principalId,
              );
              if (
                [...priorUserOwnership, ...createdOwnership].some(
                  (ownership) =>
                    ownership.externalSubjectId === plan.externalSubjectId && ownership.principalId !== principalId,
                )
              ) {
                throw new Error("managed_directory_user_ownership_conflict");
              }
              const direct = await tx.listUnitMembersForUser(orgId, principalId);
              const prior = priorByPrincipal.get(principalId) ?? [];
              const expectedUnitIds = new Set(
                plan.externalUnitIds.map((externalUnitId) => {
                  const unitId = planByExternalUnit.get(externalUnitId)?.unitId;
                  if (!unitId) throw new Error("managed_directory_unit_mapping_missing");
                  return unitId;
                }),
              );
              for (const ownership of prior) {
                if (expectedUnitIds.has(ownership.unitId) && plan.action !== "suspend") continue;
                const current = direct.find((member) => member.unitId === ownership.unitId);
                if (current?.role === "member") await tx.removeUnitMember(orgId, ownership.unitId, principalId);
                removedOwnership.push(ownership);
              }
              if (plan.action === "suspend") {
                if (!ownedUser || user.status === "deprovisioned") continue;
                if (user.status !== "suspended") {
                  const next = {
                    ...user,
                    status: "suspended" as const,
                    sessionVersion: user.sessionVersion + 1,
                    updatedAt: at,
                    updatedBy: managedActor,
                  };
                  await tx.putUser(next);
                  suspended.push({ principalId, sessionVersion: next.sessionVersion });
                  changedUserOwnership.push({
                    ...ownedUser,
                    suspendedBySource: true,
                    suspendedSessionVersion: next.sessionVersion,
                    updatedAt: at,
                  });
                } else {
                  const recoverable =
                    (ownedUser.suspendedBySource && ownedUser.suspendedSessionVersion === user.sessionVersion) ||
                    user.updatedBy === managedActor;
                  if (!recoverable) throw new Error("managed_directory_manual_suspension_conflict");
                  if (!ownedUser.suspendedBySource || ownedUser.suspendedSessionVersion !== user.sessionVersion) {
                    changedUserOwnership.push({
                      ...ownedUser,
                      suspendedBySource: true,
                      suspendedSessionVersion: user.sessionVersion,
                      updatedAt: at,
                    });
                  }
                  suspended.push({ principalId, sessionVersion: user.sessionVersion });
                }
                continue;
              }
              const primaryUnitId = plan.primaryExternalUnitId
                ? (planByExternalUnit.get(plan.primaryExternalUnitId)?.unitId ?? null)
                : null;
              const foreignPrimary = direct.find(
                (member) =>
                  member.isPrimary === true &&
                  member.unitId !== primaryUnitId &&
                  !prior.some((ownership) => ownership.unitId === member.unitId),
              );
              if (foreignPrimary && primaryUnitId) throw new Error("managed_directory_primary_unit_conflict");
              for (const ownership of prior) {
                const current = direct.find((member) => member.unitId === ownership.unitId);
                if (current?.isPrimary && ownership.unitId !== primaryUnitId) {
                  await tx.putUnitMember({ ...current, isPrimary: false });
                }
              }
              for (const unitId of expectedUnitIds) {
                const current = direct.find((member) => member.unitId === unitId);
                const priorOwned = prior.find((ownership) => ownership.unitId === unitId);
                if (current && !priorOwned && current.createdBy !== managedActor) continue;
                const relation: OrgUnitMember = current
                  ? { ...current, isPrimary: unitId === primaryUnitId }
                  : {
                      orgId,
                      unitId,
                      principalId,
                      role: "member",
                      isPrimary: unitId === primaryUnitId,
                      createdAt: at,
                      createdBy: managedActor,
                    };
                await tx.putUnitMember(relation);
                desiredOwnership.push({
                  orgId,
                  sourceId,
                  unitId,
                  principalId,
                  primary: unitId === primaryUnitId,
                  createdAt: priorOwned?.createdAt ?? at,
                  updatedAt: at,
                });
              }
              if (ownedUser) {
                const member = memberBySubject.get(plan.externalSubjectId);
                if (!member) throw new Error("managed_directory_member_missing");
                const corporateEmail = member.emails.find(
                  (email) => email.kind === "corporate" && email.verified,
                )?.value;
                const sourceReactivation =
                  user.status === "suspended" &&
                  ownedUser.suspendedBySource &&
                  ownedUser.suspendedSessionVersion === user.sessionVersion;
                if (user.status === "suspended" && !sourceReactivation) {
                  throw new Error("managed_directory_manual_suspension_conflict");
                }
                const displayName = member.displayName.trim() || user.displayName;
                const email = user.email ?? corporateEmail ?? null;
                const mobile = member.mobile ?? user.mobile;
                const employeeNumber = member.employeeNumber ?? user.employeeNumber;
                const profileChanged =
                  email !== user.email ||
                  displayName !== user.displayName ||
                  mobile !== user.mobile ||
                  employeeNumber !== user.employeeNumber;
                const next = {
                  ...user,
                  email,
                  displayName,
                  mobile,
                  employeeNumber,
                  status: sourceReactivation ? ("active" as const) : user.status,
                  sessionVersion: user.sessionVersion + (sourceReactivation ? 1 : 0),
                  profileRevision: user.profileRevision + (profileChanged ? 1 : 0),
                  updatedAt: at,
                  updatedBy: managedActor,
                };
                await tx.putUser(next);
                if (next.status === "active") {
                  reactivated.push({ principalId, sessionVersion: next.sessionVersion });
                }
                if (sourceReactivation || (user.status === "active" && ownedUser.suspendedBySource)) {
                  changedUserOwnership.push({
                    ...ownedUser,
                    suspendedBySource: false,
                    suspendedSessionVersion: null,
                    updatedAt: at,
                  });
                }
              }
            }
            const archivePlans = [...preview.units].reverse().filter((unit) => unit.action === "archive");
            const archiveUnitIds = new Set(archivePlans.map((plan) => plan.unitId));
            const currentUnits = await tx.listUnits(orgId);
            const ownershipKeys = new Set(priorOwnership.map((item) => `${item.unitId}\n${item.principalId}`));
            for (const plan of archivePlans) {
              const current = await tx.getUnit(orgId, plan.unitId);
              if (!current || current.parentId === null) continue;
              const [impact, members] = await Promise.all([
                tx.unitImpact(orgId, current.id),
                tx.listUnitMembers(orgId, current.id),
              ]);
              const unrelatedChild = currentUnits.some(
                (candidate) =>
                  candidate.parentId === current.id &&
                  candidate.status === "active" &&
                  !archiveUnitIds.has(candidate.id),
              );
              const unrelatedMember = members.some(
                (member) => member.role === "manager" || !ownershipKeys.has(`${member.unitId}\n${member.principalId}`),
              );
              if (unrelatedChild || unrelatedMember || impact.directoryRoots > 0 || impact.accessGrants > 0) {
                throw new Error("managed_directory_preview_stale");
              }
              await tx.putUnit({ ...current, status: "archived", updatedAt: at, updatedBy: actor });
            }
            await tx.bumpRevision(orgId);
            await tx.audit({
              ...event(actor, "managed_directory.commit", sourceId, {
                previewId,
                units: preview.units.length,
                members: preview.members.length,
              }),
              idempotencyKey: operationKey,
            });
            await tx.putOperationResult(operationKey, {
              principals: [...principals],
              createdOwnership,
              desiredOwnership,
              removedOwnership,
              suspended,
              reactivated,
              changedUserOwnership,
            });
            organizationApplied = true;
          });
        } catch (error) {
          if (!organizationApplied && errMessage(error) === "managed_directory_preview_stale") {
            preview = {
              ...preview,
              status: "blocked",
              conflicts: [...new Set([...preview.conflicts, "managed_directory_preview_stale"])],
            };
            await store.putManagedPreview(preview);
          }
          throw error;
        }
        const at = now();
        for (const ownership of createdOwnership) await store.putManagedUserOwnership(ownership);
        const priorMappings = await store.listUnitMappings(orgId, sourceId);
        for (const plan of preview.units.filter((unit) => unit.action !== "archive")) {
          const prior = priorMappings.find((mapping) => mapping.externalUnitId === plan.externalUnitId);
          const mapping: DirectoryUnitMapping = {
            orgId,
            provider: source.provider,
            externalTenantId: source.externalTenantId,
            externalUnitId: plan.externalUnitId,
            sourceId,
            unitId: plan.unitId,
            ownership: plan.ownership,
            createdAt: prior?.createdAt ?? at,
            updatedAt: at,
          };
          await store.putUnitMapping(mapping);
        }
        for (const ownership of removedOwnership) {
          await store.deleteUnitMemberOwnership(orgId, sourceId, ownership.unitId, ownership.principalId);
        }
        for (const ownership of desiredOwnership) await store.putUnitMemberOwnership(ownership);
        for (const ownership of changedUserOwnership) await store.putManagedUserOwnership(ownership);
        for (const item of suspended)
          await identity.deactivate(item.principalId, "directory-sync", item.sessionVersion);
        for (const item of reactivated) await identity.reactivate(item.principalId, item.sessionVersion);
        const committed = { ...preview, status: "committed" as const, committedAt: at, actor };
        await store.putManagedPreview(committed);
        return committed;
      });
    },
    recoverCommitting,
    start() {
      recovery.start();
    },
    stop() {
      recovery.stop();
    },
  };
  return service;
}
