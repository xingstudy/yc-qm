import { createHash, randomUUID } from "node:crypto";
import type { OrganizationStore, SkillAccessGrant, SkillAccessPolicy } from "../organization/organization-store.ts";
import type { Skill, SkillResolution, SkillStore } from "../skills/skill-store.ts";
import { isSafeSkillName } from "../skills/skill-name.ts";
import type { ScopeId } from "../types.ts";
import { organizationAccessSubjectFromScope } from "./organization-access-subject.ts";

export interface SkillAuthorizationAudienceMember {
  principalId: string;
  sessionVersion: number;
}

interface AuthorizedSkill {
  id: string;
  version: number;
  policyRevision: number;
  contentHash: string;
}

interface SkillAuthorizationSnapshot {
  id: string;
  orgId: string;
  organizationAuthzRevision: number;
  audienceIds: string[];
  audience: SkillAuthorizationAudienceMember[];
  audienceHash: string;
  orderedScopes: ScopeId[];
  membershipVersion: string | null;
  authorized: AuthorizedSkill[];
  resolutions: SkillResolution[];
  createdAt: number;
}

export interface SkillAccessResolver {
  snapshot(input: {
    audienceIds: readonly string[];
    orderedScopes: readonly ScopeId[];
    membershipVersion?: string;
  }): Promise<SkillAuthorizationSnapshot>;
  visibleForUser(principalId: string, orderedScopes: readonly ScopeId[]): Promise<SkillResolution[]>;
  assertCurrent(
    snapshot: SkillAuthorizationSnapshot,
    membership?: { audienceIds: readonly string[]; membershipVersion: string | undefined },
  ): Promise<void>;
}

function contentHash(skill: Skill): string {
  return createHash("sha256")
    .update(JSON.stringify({ id: skill.id, version: skill.version, signature: skill.signature, status: skill.status }))
    .digest("hex");
}

function audienceHash(audience: readonly SkillAuthorizationAudienceMember[]): string {
  return createHash("sha256")
    .update(JSON.stringify(audience.map((member) => [member.principalId, member.sessionVersion])))
    .digest("hex");
}

function validGrants(skill: Skill, policy: SkillAccessPolicy, grants: readonly SkillAccessGrant[]): boolean {
  if (policy.orgId !== skill.orgId || policy.skillId !== skill.id || policy.ownerScopeId !== skill.scopeId)
    return false;
  if (policy.mode !== "restricted") return grants.length === 0;
  return grants.every(
    (grant) =>
      grant.orgId === skill.orgId &&
      grant.ownerScopeId === skill.scopeId &&
      grant.path === `skill:${skill.id}` &&
      grant.permission === "read" &&
      organizationAccessSubjectFromScope(grant.granteeScopeId) !== null,
  );
}

function resolveAuthorized(skills: readonly Skill[], orderedScopes: readonly ScopeId[]): SkillResolution[] {
  const scopeRank = new Map(orderedScopes.map((scope, index) => [scope, index]));
  const byName = new Map<string, Skill[]>();
  for (const skill of skills) {
    if (!isSafeSkillName(skill.manifest.name)) continue;
    const variants = byName.get(skill.manifest.name) ?? [];
    variants.push(skill);
    byName.set(skill.manifest.name, variants);
  }
  const resolutions: SkillResolution[] = [];
  for (const variants of byName.values()) {
    variants.sort((left, right) => {
      const leftRank = scopeRank.get(left.scopeId) ?? orderedScopes.length;
      const rightRank = scopeRank.get(right.scopeId) ?? orderedScopes.length;
      return leftRank - rightRank || left.scopeId.localeCompare(right.scopeId) || left.id.localeCompare(right.id);
    });
    const [skill, ...shadowed] = variants;
    if (skill) resolutions.push({ skill, shadowed });
  }
  return resolutions.sort((left, right) =>
    (left.skill?.manifest.name ?? "").localeCompare(right.skill?.manifest.name ?? ""),
  );
}

export function createSkillAccessResolver(input: {
  orgId: string;
  store: OrganizationStore;
  skills: SkillStore;
  canReadHome(principalId: string, scopeId: ScopeId): Promise<boolean>;
  resolveAudienceMember?(principalId: string): Promise<SkillAuthorizationAudienceMember | null>;
  onInvalid?(skillId: string, reason: string): void;
}): SkillAccessResolver {
  const { orgId, store, skills, canReadHome, resolveAudienceMember, onInvalid } = input;

  const activeAudienceMember = async (principalId: string): Promise<SkillAuthorizationAudienceMember | null> => {
    const user = await store.getUser(orgId, principalId);
    if (user) {
      return user.status === "active" ? { principalId: user.principalId, sessionVersion: user.sessionVersion } : null;
    }
    return (await resolveAudienceMember?.(principalId)) ?? null;
  };

  const build = async (
    audienceIds: readonly string[],
    orderedScopes: readonly ScopeId[],
    membershipVersion: string | null,
  ): Promise<SkillAuthorizationSnapshot> => {
    if ((await store.getSkillAccessPolicyVersion(orgId)) !== 1) throw new Error("skill access is not enforced");
    const revision = await store.getAuthzRevision(orgId);
    const ids = [...new Set(audienceIds)];
    const audience = (await Promise.all(ids.map(activeAudienceMember)))
      .filter((member): member is SkillAuthorizationAudienceMember => member !== null)
      .sort((left, right) => left.principalId.localeCompare(right.principalId));
    let authorizedSkills: Skill[] = [];
    const policyBySkill = new Map<string, SkillAccessPolicy>();
    if (ids.length > 0 && audience.length === ids.length) {
      const allSkills = (await skills.list()).filter((skill) => skill.orgId === orgId && skill.status === "published");
      const policies = await store.listSkillAccessPolicies(orgId);
      for (const policy of policies) policyBySkill.set(policy.skillId, policy);
      const unitIds = new Map<string, Set<string>>();
      const groupIds = new Map<string, Set<string>>();
      for (const member of audience) {
        const directUnits = await store.listDirectUnitIdsForUser(orgId, member.principalId);
        const effectiveUnits = new Set<string>();
        for (const unitId of directUnits) {
          for (const ancestor of await store.listAncestorUnitIds(orgId, unitId)) effectiveUnits.add(ancestor);
        }
        unitIds.set(member.principalId, effectiveUnits);
        groupIds.set(member.principalId, new Set(await store.listDirectGroupIdsForUser(orgId, member.principalId)));
      }
      for (const skill of allSkills) {
        if (!skills.verify(skill)) {
          onInvalid?.(skill.id, "signature verification failed");
          continue;
        }
        const policy = policyBySkill.get(skill.id);
        if (!policy) {
          onInvalid?.(skill.id, "access policy missing");
          continue;
        }
        const grants = await store.listSkillAccessGrants(orgId, skill.id);
        if (!validGrants(skill, policy, grants)) {
          onInvalid?.(skill.id, "access policy and grants violate invariants");
          continue;
        }
        let allowed: boolean;
        if (policy.mode === "organization") allowed = true;
        else if (policy.mode === "home") {
          allowed =
            orderedScopes.includes(skill.scopeId) &&
            (await Promise.all(audience.map((member) => canReadHome(member.principalId, skill.scopeId)))).every(
              Boolean,
            );
        } else {
          allowed = audience.every((member) =>
            grants.some((grant) => {
              const subject = organizationAccessSubjectFromScope(grant.granteeScopeId);
              if (subject?.kind === "user") return subject.id === member.principalId;
              if (subject?.kind === "org_unit") return unitIds.get(member.principalId)?.has(subject.id) === true;
              return subject?.kind === "access_group" && groupIds.get(member.principalId)?.has(subject.id) === true;
            }),
          );
        }
        if (allowed) authorizedSkills.push(skill);
      }
    }
    const latestRevision = await store.getAuthzRevision(orgId);
    if (latestRevision !== revision) throw new Error("organization authorization changed while resolving skills");
    const resolutions = resolveAuthorized(authorizedSkills, orderedScopes);
    authorizedSkills = resolutions.flatMap((resolution) =>
      resolution.skill ? [resolution.skill, ...resolution.shadowed] : resolution.shadowed,
    );
    return {
      id: randomUUID(),
      orgId,
      organizationAuthzRevision: revision,
      audienceIds: [...ids].sort(),
      audience,
      audienceHash: audienceHash(audience),
      orderedScopes: [...orderedScopes],
      membershipVersion,
      authorized: authorizedSkills.map((skill) => ({
        id: skill.id,
        version: skill.version,
        policyRevision: policyBySkill.get(skill.id)?.revision ?? 0,
        contentHash: contentHash(skill),
      })),
      resolutions,
      createdAt: Date.now(),
    };
  };

  return {
    async snapshot(snapshotInput) {
      const membershipVersion = snapshotInput.membershipVersion ?? null;
      try {
        return await build(snapshotInput.audienceIds, snapshotInput.orderedScopes, membershipVersion);
      } catch (error) {
        if (error instanceof Error && error.message === "organization authorization changed while resolving skills")
          return build(snapshotInput.audienceIds, snapshotInput.orderedScopes, membershipVersion);
        throw error;
      }
    },
    async visibleForUser(principalId, orderedScopes) {
      return (await build([principalId], orderedScopes, null)).resolutions;
    },
    async assertCurrent(snapshot, membership) {
      if (snapshot.orgId !== orgId || (await store.getAuthzRevision(orgId)) !== snapshot.organizationAuthzRevision)
        throw new Error("skill authorization snapshot expired");
      if (snapshot.membershipVersion !== null) {
        const currentIds = [...new Set(membership?.audienceIds ?? [])].sort();
        const snapshotIds = [...snapshot.audienceIds].sort();
        if (
          membership?.membershipVersion !== snapshot.membershipVersion ||
          currentIds.length !== snapshotIds.length ||
          currentIds.some((id, index) => id !== snapshotIds[index])
        )
          throw new Error("skill authorization snapshot expired");
      }
      for (const member of snapshot.audience) {
        const current = await activeAudienceMember(member.principalId);
        if (!current || current.sessionVersion !== member.sessionVersion)
          throw new Error("skill authorization snapshot expired");
      }
    },
  };
}
