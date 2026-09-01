import type { AuditEvent } from "../audit/audit-log.ts";
import { isDeepStrictEqual } from "node:util";
import type { DurableMap } from "../persistence/durable-map.ts";
import type {
  OrganizationStore,
  OrganizationTx,
  OrgUnitMember,
  SkillAccessGrant,
  SkillAccessMode,
  SkillAccessPolicy,
} from "../organization/organization-store.ts";
import { createSkillStore, type Skill, type SkillManifest, type SkillStore } from "../skills/skill-store.ts";
import { parseScopeId, type ScopeId } from "../types.ts";
import type {
  DirectoryActor,
  DirectoryVisibilityResolver,
  ResolvedDirectoryVisibility,
} from "./directory-visibility.ts";
import {
  organizationAccessSubjectFromScope,
  organizationAccessSubjectScope,
  type OrganizationAccessSubject,
} from "./organization-access-subject.ts";

export const MAX_SKILL_ACCESS_SUBJECTS = 100;

export type SkillAccessSubject = OrganizationAccessSubject;

export interface SkillAccessActor extends DirectoryActor {
  principalId: string;
}

export interface SkillAccessView {
  mode: SkillAccessMode;
  subjects: SkillAccessSubject[];
  hiddenSubjectCount: number;
  editable: boolean;
  organizationModeAllowed: boolean;
  revision: number;
  updatedAt: number;
  updatedBy: string;
  effectiveSummary: {
    activeUsers: number | null;
    orgUnits: number | null;
    accessGroups: number | null;
    directUsers: number | null;
  };
}

export class SkillAccessConflictError extends Error {
  readonly currentRevision: number | undefined;

  constructor(message: string, currentRevision?: number) {
    super(message);
    this.currentRevision = currentRevision;
  }
}

export class SkillAccessNotFoundError extends Error {}

export interface SkillAccessRepository extends SkillStore {
  ready(): Promise<void>;
  getAccess(skillId: string, actor: SkillAccessActor): Promise<SkillAccessView>;
  setAccess(
    skillId: string,
    actor: SkillAccessActor,
    input: { mode: SkillAccessMode; subjects: readonly SkillAccessSubject[]; expectedRevision: number },
  ): Promise<SkillAccessView>;
  addAccessSubject(skillId: string, actor: SkillAccessActor, subject: SkillAccessSubject): Promise<SkillAccessView>;
  removeAccessSubject(skillId: string, actor: SkillAccessActor, subject: SkillAccessSubject): Promise<SkillAccessView>;
  canManage(skillId: string, actor: SkillAccessActor): Promise<boolean>;
}

interface UnitAccessContext {
  visibility: ResolvedDirectoryVisibility | null;
  activeUsers: ReadonlySet<string>;
  subtrees: ReadonlyMap<string, readonly string[]>;
  membersByUnit: ReadonlyMap<string, readonly OrgUnitMember[]>;
}

function skillPath(skillId: string): string {
  return `skill:${skillId}`;
}

function transactionalBacking(tx: OrganizationTx, orgId: string): DurableMap<Skill> {
  const mergeValue = (value: Skill, patch: Partial<Skill>): Skill => {
    const next = { ...value } as Record<string, unknown>;
    for (const [key, patchValue] of Object.entries(patch)) {
      if (patchValue === undefined) delete next[key];
      else next[key] = patchValue;
    }
    return next as unknown as Skill;
  };
  return {
    all: () => tx.listSkills(orgId),
    async entries() {
      return (await tx.listSkills(orgId)).map((skill) => [skill.id, skill]);
    },
    get: (id) => tx.getSkill(orgId, id),
    async put(id, skill) {
      if (id !== skill.id) throw new Error("skill id mismatch");
      await tx.putSkill(skill);
    },
    async putIfAbsent(id, skill) {
      const existing = await tx.getSkill(orgId, id);
      if (existing) return existing;
      await tx.putSkill(skill);
      return skill;
    },
    async insertIfAbsent(id, skill) {
      if (await tx.getSkill(orgId, id)) return false;
      await tx.putSkill(skill);
      return true;
    },
    async merge(id, patch) {
      const current = await tx.getSkill(orgId, id);
      if (!current) return null;
      const next = mergeValue(current, patch);
      await tx.putSkill(next);
      return next;
    },
    async update(id, update) {
      const current = await tx.getSkill(orgId, id);
      if (!current) return null;
      const next = update(current);
      await tx.putSkill(next);
      return next;
    },
    async deleteIf(id, predicate) {
      const current = await tx.getSkill(orgId, id);
      if (!current || !predicate(current)) return false;
      await tx.deleteSkill(orgId, id);
      return true;
    },
    delete: (id) => tx.deleteSkill(orgId, id),
    async take(id) {
      const current = await tx.getSkill(orgId, id);
      if (current) await tx.deleteSkill(orgId, id);
      return current;
    },
  };
}

function policyFor(skill: Skill, actor: string, at: number): SkillAccessPolicy {
  return {
    orgId: skill.orgId,
    skillId: skill.id,
    ownerScopeId: skill.scopeId,
    mode: "home",
    revision: 1,
    createdAt: at,
    updatedAt: at,
    updatedBy: actor,
  };
}

function auditEvent(orgId: string, actor: string, action: string, skill: Skill, detail?: string): AuditEvent {
  return {
    at: Date.now(),
    principalId: actor,
    action,
    resource: `skill:${skill.id}`,
    scopeLabel: skill.scopeId,
    status: "ok",
    orgId,
    actorKind: actor.startsWith("system:") ? "system" : "user",
    source: "skill-access",
    result: "success",
    ...(detail ? { detail } : {}),
  };
}

export function createSkillAccessRepository(input: {
  orgId: string;
  signingSecret: string;
  store: OrganizationStore;
  base: SkillStore;
  directory: DirectoryVisibilityResolver;
}): SkillAccessRepository {
  const { orgId, signingSecret, store, base, directory } = input;
  let readyPromise: Promise<void> | null = null;

  const txSkills = (tx: OrganizationTx): SkillStore =>
    createSkillStore({ orgId, signingSecret, backing: transactionalBacking(tx, orgId) });

  const activeManager = async (tx: OrganizationTx, skill: Skill, actor: SkillAccessActor): Promise<boolean> => {
    if ((await tx.getUser(orgId, actor.principalId))?.status !== "active") return false;
    if (actor.isAdmin) return true;
    const user =
      (await tx.getUser(orgId, skill.createdBy)) ??
      (skill.createdBy.includes("@") ? await tx.findUserByEmail(orgId, skill.createdBy) : null);
    return user?.status === "active" && user.principalId === actor.principalId;
  };

  const requirePolicy = async (tx: OrganizationTx, skill: Skill): Promise<SkillAccessPolicy> => {
    if (skill.orgId !== orgId) throw new SkillAccessNotFoundError("skill not found");
    const policy = await tx.getSkillAccessPolicy(orgId, skill.id);
    if (!policy || policy.ownerScopeId !== skill.scopeId) throw new Error(`invalid skill access policy: ${skill.id}`);
    return policy;
  };

  const replaceOwner = async (
    tx: OrganizationTx,
    skill: Skill,
    actor: string,
    previousPolicy: SkillAccessPolicy | null,
  ): Promise<void> => {
    const at = Date.now();
    const policy = previousPolicy
      ? {
          ...previousPolicy,
          ownerScopeId: skill.scopeId,
          revision: previousPolicy.revision + 1,
          updatedAt: at,
          updatedBy: actor,
        }
      : policyFor(skill, actor, at);
    const grants = await tx.listSkillAccessGrants(orgId, skill.id);
    await tx.putSkillAccessPolicy(policy);
    await tx.replaceSkillAccessGrants(
      orgId,
      skill.id,
      grants.map((grant) => ({ ...grant, ownerScopeId: skill.scopeId })),
    );
  };

  const write = async <T>(
    actor: string,
    action: string,
    operation: (skills: SkillStore, tx: OrganizationTx) => Promise<{ result: T; skill: Skill }>,
  ): Promise<T> =>
    repository.ready().then(() =>
      store.transact(orgId, async (tx) => {
        if ((await tx.getSkillAccessPolicyVersion(orgId)) !== 1) throw new Error("skill access is not enforced");
        const outcome = await operation(txSkills(tx), tx);
        if (outcome.skill.orgId !== orgId) throw new Error("skill organization mismatch");
        await tx.bumpRevision(orgId);
        await tx.audit(auditEvent(orgId, actor, action, outcome.skill));
        return outcome.result;
      }),
    );

  const unitAccessContext = async (
    actor: SkillAccessActor,
    subjects: readonly SkillAccessSubject[],
  ): Promise<UnitAccessContext | null> => {
    const roots = [...new Set(subjects.filter((subject) => subject.kind === "org_unit").map((subject) => subject.id))];
    if (roots.length === 0) return null;
    const [visibility, accounts, subtreeEntries] = await Promise.all([
      directory.resolve(actor),
      store.listUsers(orgId),
      Promise.all(roots.map(async (root) => [root, await store.listSubtreeUnitIds(orgId, root)] as const)),
    ]);
    const subtrees = new Map(subtreeEntries);
    const unitIds = [...new Set(subtreeEntries.flatMap(([, ids]) => ids))];
    const membersByUnit = new Map(unitIds.map((unitId) => [unitId, [] as OrgUnitMember[]]));
    for (const member of await store.listUnitMembersForUnits(orgId, unitIds)) {
      const members = membersByUnit.get(member.unitId) ?? [];
      members.push(member);
      membersByUnit.set(member.unitId, members);
    }
    return {
      visibility,
      activeUsers: new Set(
        accounts.filter((account) => account.status === "active").map((account) => account.principalId),
      ),
      subtrees,
      membersByUnit,
    };
  };

  const subjectVisible = async (
    actor: SkillAccessActor,
    subject: SkillAccessSubject,
    context: UnitAccessContext | null = null,
  ): Promise<boolean> => {
    if (actor.isAdmin) return true;
    if (subject.kind === "user") return (await directory.visibleUser(actor, subject.id)) !== null;
    if (subject.kind === "access_group") return (await directory.visibleGroup(actor, subject.id)) !== null;
    const visibility = context?.visibility ?? (await directory.resolve(actor));
    if (!visibility) return false;
    const unit = await store.getUnit(orgId, subject.id);
    if (!unit || unit.status !== "active" || (visibility.unitIds !== null && !visibility.unitIds.has(subject.id))) {
      return false;
    }
    if (visibility.unitIds === null) return true;
    const activeUsers =
      context?.activeUsers ??
      new Set(
        (await store.listUsers(orgId)).filter((user) => user.status === "active").map((user) => user.principalId),
      );
    const subtree = context?.subtrees.get(subject.id) ?? (await store.listSubtreeUnitIds(orgId, subject.id));
    for (const unitId of subtree) {
      if (visibility.unitIds.has(unitId)) continue;
      const members = context?.membersByUnit.get(unitId) ?? (await store.listUnitMembers(orgId, unitId));
      for (const member of members) {
        if (activeUsers.has(member.principalId)) return false;
      }
    }
    return true;
  };

  const validateSubject = async (tx: OrganizationTx, subject: SkillAccessSubject): Promise<void> => {
    if (!subject.id) throw new SkillAccessNotFoundError("access subject not found");
    if (subject.kind === "user") {
      if ((await tx.getUser(orgId, subject.id))?.status !== "active")
        throw new SkillAccessNotFoundError("access subject not found");
      return;
    }
    if (subject.kind === "org_unit") {
      if ((await tx.getUnit(orgId, subject.id))?.status !== "active")
        throw new SkillAccessNotFoundError("access subject not found");
      return;
    }
    if ((await tx.getGroup(orgId, subject.id))?.status !== "active")
      throw new SkillAccessNotFoundError("access subject not found");
  };

  const subjectName = async (subject: SkillAccessSubject): Promise<string> => {
    if (subject.kind === "user") {
      const user = await store.getUser(orgId, subject.id);
      return user?.displayName ?? subject.id;
    }
    if (subject.kind === "org_unit") return (await store.getUnit(orgId, subject.id))?.name ?? subject.id;
    return (await store.getGroup(orgId, subject.id))?.name ?? subject.id;
  };

  const effectiveUsers = async (
    subjects: readonly SkillAccessSubject[],
    context: UnitAccessContext | null = null,
  ): Promise<Set<string>> => {
    const users = new Set<string>();
    const activeUsers =
      context?.activeUsers ??
      new Set(
        (await store.listUsers(orgId)).filter((user) => user.status === "active").map((user) => user.principalId),
      );
    for (const subject of subjects) {
      if (subject.kind === "user") {
        if (activeUsers.has(subject.id)) users.add(subject.id);
        continue;
      }
      if (subject.kind === "access_group") {
        for (const member of await store.listGroupMembers(orgId, subject.id)) {
          if (activeUsers.has(member.principalId)) users.add(member.principalId);
        }
        continue;
      }
      const subtree = context?.subtrees.get(subject.id) ?? (await store.listSubtreeUnitIds(orgId, subject.id));
      for (const unitId of subtree) {
        const members = context?.membersByUnit.get(unitId) ?? (await store.listUnitMembers(orgId, unitId));
        for (const member of members) {
          if (activeUsers.has(member.principalId)) users.add(member.principalId);
        }
      }
    }
    return users;
  };

  const view = async (skillId: string, actor: SkillAccessActor): Promise<SkillAccessView> => {
    await repository.ready();
    const skill = await base.get(skillId);
    if (!skill || skill.orgId !== orgId) throw new SkillAccessNotFoundError("skill not found");
    const policy = await store.getSkillAccessPolicy(orgId, skillId);
    if (!policy || policy.ownerScopeId !== skill.scopeId) throw new SkillAccessNotFoundError("skill not found");
    if (!(await repository.canManage(skillId, actor))) throw new SkillAccessNotFoundError("skill not found");
    const grants = await store.listSkillAccessGrants(orgId, skillId);
    const validInvariant =
      policy.mode === "restricted"
        ? grants.every(
            (grant) =>
              grant.ownerScopeId === skill.scopeId &&
              grant.path === skillPath(skillId) &&
              grant.permission === "read" &&
              organizationAccessSubjectFromScope(grant.granteeScopeId) !== null,
          )
        : grants.length === 0;
    if (!validInvariant) throw new Error(`invalid skill access grants: ${skillId}`);
    const decoded = grants
      .map((grant) => organizationAccessSubjectFromScope(grant.granteeScopeId))
      .filter((x): x is SkillAccessSubject => x !== null);
    const context = await unitAccessContext(actor, decoded);
    const visible: SkillAccessSubject[] = [];
    let hiddenSubjectCount = 0;
    for (const subject of decoded) {
      if (await subjectVisible(actor, subject, context)) visible.push({ ...subject, name: await subjectName(subject) });
      else hiddenSubjectCount += 1;
    }
    const discloseSummary = actor.isAdmin || hiddenSubjectCount === 0;
    const activeUsers = discloseSummary ? await effectiveUsers(decoded, context) : null;
    const home = parseScopeId(skill.scopeId);
    let activeUserCount: number | null = null;
    if (policy.mode === "restricted") activeUserCount = activeUsers?.size ?? null;
    else if (policy.mode === "organization")
      activeUserCount = (await store.listUsers(orgId)).filter((user) => user.status === "active").length;
    else if (home.kind === "personal" && (await store.getUser(orgId, home.ref))?.status === "active")
      activeUserCount = 1;
    return {
      mode: policy.mode,
      subjects: visible,
      hiddenSubjectCount,
      editable: hiddenSubjectCount === 0,
      organizationModeAllowed: actor.isAdmin,
      revision: policy.revision,
      updatedAt: policy.updatedAt,
      updatedBy: policy.updatedBy,
      effectiveSummary: {
        activeUsers: activeUserCount,
        orgUnits: discloseSummary ? decoded.filter((subject) => subject.kind === "org_unit").length : null,
        accessGroups: discloseSummary ? decoded.filter((subject) => subject.kind === "access_group").length : null,
        directUsers: discloseSummary ? decoded.filter((subject) => subject.kind === "user").length : null,
      },
    };
  };

  const changeAccessSubject = async (
    skillId: string,
    actor: SkillAccessActor,
    subject: SkillAccessSubject,
    operation: "add" | "remove",
  ): Promise<SkillAccessView> => {
    await repository.ready();
    if (!(await repository.canManage(skillId, actor))) throw new SkillAccessNotFoundError("skill not found");
    const currentSubjects = (await store.listSkillAccessGrants(orgId, skillId))
      .map((grant) => organizationAccessSubjectFromScope(grant.granteeScopeId))
      .filter((current): current is SkillAccessSubject => current !== null);
    const context = await unitAccessContext(actor, [subject, ...currentSubjects]);
    const visibility = context?.visibility ?? (await directory.resolve(actor));
    if (!visibility || (!(await subjectVisible(actor, subject, context)) && !actor.isAdmin))
      throw new SkillAccessNotFoundError("access subject not found");
    await store.transact(orgId, async (tx) => {
      if ((await tx.getSkillAccessPolicyVersion(orgId)) !== 1) throw new Error("skill access is not enforced");
      if ((await tx.getAuthzRevision(orgId)) !== visibility.revision)
        throw new SkillAccessConflictError("authorization changed; retry the share operation");
      const skill = await tx.getSkill(orgId, skillId);
      if (!skill || !(await activeManager(tx, skill, actor))) throw new SkillAccessNotFoundError("skill not found");
      const policy = await requirePolicy(tx, skill);
      if (policy.mode !== "restricted")
        throw new SkillAccessConflictError("Skill share requires restricted access mode");
      const currentGrants = await tx.listSkillAccessGrants(orgId, skillId);
      if (
        currentGrants.some(
          (grant) =>
            grant.orgId !== orgId ||
            grant.ownerScopeId !== skill.scopeId ||
            grant.path !== skillPath(skillId) ||
            grant.permission !== "read",
        )
      )
        throw new Error(`invalid skill access grants: ${skillId}`);
      const transactionalSubjects = currentGrants.map((grant) =>
        organizationAccessSubjectFromScope(grant.granteeScopeId),
      );
      if (transactionalSubjects.some((current) => current === null))
        throw new Error(`invalid skill access grants: ${skillId}`);
      for (const current of transactionalSubjects as SkillAccessSubject[]) {
        if (!(await subjectVisible(actor, current, context)))
          throw new SkillAccessConflictError(
            "hidden access subjects require an organization administrator",
            policy.revision,
          );
      }
      if (operation === "add") await validateSubject(tx, subject);
      const targetScope = organizationAccessSubjectScope(subject);
      const retained = currentGrants.filter((grant) => grant.granteeScopeId !== targetScope);
      if (
        (operation === "add" && retained.length !== currentGrants.length) ||
        (operation === "remove" && retained.length === currentGrants.length)
      )
        return;
      const at = Date.now();
      const nextGrants =
        operation === "add"
          ? [
              ...retained,
              {
                orgId,
                ownerScopeId: skill.scopeId,
                path: skillPath(skillId),
                granteeScopeId: targetScope,
                permission: "read" as const,
                grantedBy: actor.principalId,
                grantedAt: at,
              },
            ]
          : retained;
      await tx.putSkillAccessPolicy({
        ...policy,
        revision: policy.revision + 1,
        updatedAt: at,
        updatedBy: actor.principalId,
      });
      await tx.replaceSkillAccessGrants(orgId, skillId, nextGrants);
      await tx.bumpRevision(orgId);
      await tx.audit(
        auditEvent(
          orgId,
          actor.principalId,
          `skill.access.subject.${operation}`,
          skill,
          JSON.stringify({ kind: subject.kind, id: subject.id }),
        ),
      );
    });
    return view(skillId, actor);
  };

  const repository: SkillAccessRepository = {
    async ready() {
      if (!readyPromise) {
        readyPromise = store
          .transact(orgId, async (tx) => {
            const version = await tx.getSkillAccessPolicyVersion(orgId);
            const skills = await tx.listSkills(orgId);
            if (version === 1) {
              const policies = await tx.listSkillAccessPolicies(orgId);
              if (skills.length !== policies.length) throw new Error("skill access policy migration is incomplete");
              for (const skill of skills) await requirePolicy(tx, skill);
              return;
            }
            if (version !== 0) throw new Error(`unsupported skill access policy version: ${version}`);
            const actor = "system:skill-access-migration";
            const at = Date.now();
            for (const stored of skills) {
              const skill = stored.orgId ? stored : ({ ...stored, orgId } as Skill);
              if (skill.orgId !== orgId) throw new Error(`skill belongs to another organization: ${skill.id}`);
              const legacyGrants = await tx.listSkillAccessGrants(orgId, skill.id);
              if (legacyGrants.length > 0)
                throw new Error(`legacy skill grants require migration confirmation: ${skill.id}`);
              if (!stored.orgId) await tx.putSkill(skill);
              const existing = await tx.getSkillAccessPolicy(orgId, skill.id);
              if (!existing) await tx.putSkillAccessPolicy(policyFor(skill, actor, at));
              else if (existing.ownerScopeId !== skill.scopeId)
                throw new Error(`skill policy owner mismatch: ${skill.id}`);
            }
            const policies = await tx.listSkillAccessPolicies(orgId);
            if (skills.length !== policies.length) throw new Error("skill access policy migration is incomplete");
            await tx.markSkillAccessEnforced(orgId, 1, at);
            await tx.bumpRevision(orgId);
            await tx.audit({
              at,
              principalId: actor,
              action: "skill.access.cutover",
              resource: "skill-access",
              scopeLabel: `org:${orgId}` as ScopeId,
              status: "ok",
              orgId,
              actorKind: "system",
              source: "skill-access",
              result: "success",
              detail: JSON.stringify({ skills: skills.length, policies: policies.length }),
            });
          })
          .catch((error) => {
            readyPromise = null;
            throw error;
          });
      }
      await readyPromise;
    },
    async create(createInput: { scopeId: ScopeId; manifest: SkillManifest; createdBy: string; pack?: Skill["pack"] }) {
      return write(createInput.createdBy, "skill.create", async (skills, tx) => {
        const skill = await skills.create(createInput);
        await tx.putSkillAccessPolicy(policyFor(skill, createInput.createdBy, Date.now()));
        await tx.replaceSkillAccessGrants(orgId, skill.id, []);
        return { result: skill, skill };
      });
    },
    async update(id, manifest, actorId) {
      const before = await base.get(id);
      if (!before || before.orgId !== orgId) throw new Error(`unknown skill: ${id}`);
      const actor = actorId ?? before.createdBy;
      return write(actor, "skill.update", async (skills, tx) => {
        const current = await tx.getSkill(orgId, id);
        if (!current) throw new Error(`unknown skill: ${id}`);
        await requirePolicy(tx, current);
        const skill = await skills.update(id, manifest);
        return { result: skill, skill };
      });
    },
    async get(id) {
      await repository.ready();
      const skill = await base.get(id);
      return skill?.orgId === orgId ? skill : null;
    },
    async list() {
      await repository.ready();
      return (await base.list()).filter((skill) => skill.orgId === orgId);
    },
    verify: (skill) => skill.orgId === orgId && base.verify(skill),
    async review(id, reviewer, grantCapabilities) {
      return write(reviewer, "skill.review", async (skills, tx) => {
        const current = await tx.getSkill(orgId, id);
        if (!current) throw new Error(`unknown skill: ${id}`);
        await requirePolicy(tx, current);
        const skill = await skills.review(id, reviewer, grantCapabilities);
        return { result: skill, skill };
      });
    },
    async publish(id, actorId) {
      const before = await base.get(id);
      if (!before || before.orgId !== orgId) throw new Error(`unknown skill: ${id}`);
      const actor = actorId ?? before.createdBy;
      return write(actor, "skill.publish", async (skills, tx) => {
        const current = await tx.getSkill(orgId, id);
        if (!current) throw new Error(`unknown skill: ${id}`);
        await requirePolicy(tx, current);
        const skill = await skills.publish(id);
        return { result: skill, skill };
      });
    },
    async archive(id, actorId) {
      const before = await base.get(id);
      if (!before || before.orgId !== orgId) throw new Error(`unknown skill: ${id}`);
      const actor = actorId ?? before.createdBy;
      return write(actor, "skill.archive", async (skills, tx) => {
        const current = await tx.getSkill(orgId, id);
        if (!current) throw new Error(`unknown skill: ${id}`);
        await requirePolicy(tx, current);
        const skill = await skills.archive(id);
        return { result: skill, skill };
      });
    },
    async restore(restored, actorId, expectedCurrent) {
      const actor = actorId ?? restored.createdBy;
      await write(actor, "skill.restore", async (skills, tx) => {
        const current = await tx.getSkill(orgId, restored.id);
        if (expectedCurrent !== undefined && !isDeepStrictEqual(current, expectedCurrent))
          throw new SkillAccessConflictError("skill changed while restoring");
        const skill = { ...restored, orgId };
        await skills.restore(skill);
        const currentPolicy = await tx.getSkillAccessPolicy(orgId, skill.id);
        if (!currentPolicy) await tx.putSkillAccessPolicy(policyFor(skill, actor, Date.now()));
        else if (currentPolicy.ownerScopeId !== skill.scopeId) await replaceOwner(tx, skill, actor, currentPolicy);
        return { result: undefined, skill };
      });
    },
    async delete(id, actorId, expectedCurrent) {
      const fallback = await base.get(id);
      if ((!fallback || fallback.orgId !== orgId) && expectedCurrent === undefined) return;
      const actor = actorId ?? fallback?.createdBy ?? "system:skill-delete";
      await write(actor, "skill.delete", async (skills, tx) => {
        const current = await tx.getSkill(orgId, id);
        if (!current || (expectedCurrent !== undefined && !isDeepStrictEqual(current, expectedCurrent))) {
          throw new SkillAccessConflictError("skill changed while deleting");
        }
        await requirePolicy(tx, current);
        await skills.delete(id);
        await tx.replaceSkillAccessGrants(orgId, id, []);
        await tx.deleteSkillAccessPolicy(orgId, id);
        return { result: undefined, skill: current };
      });
    },
    async recordUse(id, at) {
      await repository.ready();
      await store.transact(orgId, async (tx) => {
        if ((await tx.getSkillAccessPolicyVersion(orgId)) !== 1) throw new Error("skill access is not enforced");
        const skill = await tx.getSkill(orgId, id);
        if (!skill) return;
        await requirePolicy(tx, skill);
        await txSkills(tx).recordUse(id, at);
      });
    },
    async resolve(name, orderedScopes) {
      await repository.ready();
      return base.resolve(name, orderedScopes);
    },
    async visibleFor(orderedScopes, granted) {
      await repository.ready();
      return base.visibleFor(orderedScopes, granted);
    },
    async promote(id, targetScopeId, actorId) {
      const before = await base.get(id);
      if (!before || before.orgId !== orgId) throw new Error(`unknown skill: ${id}`);
      const actor = actorId ?? before.createdBy;
      return write(actor, "skill.promote", async (skills, tx) => {
        const sourcePolicy = await requirePolicy(tx, before);
        const sourceGrants = await tx.listSkillAccessGrants(orgId, before.id);
        const skill = await skills.promote(id, targetScopeId);
        const existingPolicy = await tx.getSkillAccessPolicy(orgId, skill.id);
        if (existingPolicy) {
          await replaceOwner(tx, skill, actor, existingPolicy);
        } else {
          const at = Date.now();
          const policy: SkillAccessPolicy = {
            ...sourcePolicy,
            skillId: skill.id,
            ownerScopeId: skill.scopeId,
            mode: sourcePolicy.mode === "home" ? "organization" : sourcePolicy.mode,
            revision: 1,
            createdAt: at,
            updatedAt: at,
            updatedBy: actor,
          };
          const grants =
            policy.mode === "restricted"
              ? sourceGrants.map((grant) => ({
                  ...grant,
                  ownerScopeId: skill.scopeId,
                  path: skillPath(skill.id),
                  grantedBy: actor,
                  grantedAt: at,
                }))
              : [];
          await tx.putSkillAccessPolicy(policy);
          await tx.replaceSkillAccessGrants(orgId, skill.id, grants);
        }
        return { result: skill, skill };
      });
    },
    async move(id, targetScopeId, actorInput) {
      const fallback = await base.get(id);
      if (!fallback || fallback.orgId !== orgId) throw new Error(`unknown skill: ${id}`);
      const actor =
        typeof actorInput === "string"
          ? { principalId: actorInput, isAdmin: false }
          : (actorInput ?? { principalId: fallback.createdBy, isAdmin: false });
      return write(actor.principalId, "skill.move", async (skills, tx) => {
        const before = await tx.getSkill(orgId, id);
        if (!before || !(await activeManager(tx, before, actor))) throw new SkillAccessNotFoundError("skill not found");
        const currentPolicy = await requirePolicy(tx, before);
        if (
          currentPolicy.mode === "home" &&
          targetScopeId !== before.scopeId &&
          parseScopeId(targetScopeId).kind !== "personal"
        )
          throw new SkillAccessConflictError("set an explicit Skill Access mode before moving to a shared home");
        const skill = await skills.move(id, targetScopeId);
        await replaceOwner(tx, skill, actor.principalId, currentPolicy);
        return { result: skill, skill };
      });
    },
    async canManage(skillId, actor) {
      await repository.ready();
      const skill = await base.get(skillId);
      if (!skill || skill.orgId !== orgId) return false;
      if ((await store.getUser(orgId, actor.principalId))?.status !== "active") return false;
      if (actor.isAdmin) return true;
      const user =
        (await store.getUser(orgId, skill.createdBy)) ??
        (skill.createdBy.includes("@") ? await store.findUserByEmail(orgId, skill.createdBy) : null);
      return user?.status === "active" && user.principalId === actor.principalId;
    },
    getAccess: view,
    addAccessSubject(skillId, actor, subject) {
      return changeAccessSubject(skillId, actor, subject, "add");
    },
    removeAccessSubject(skillId, actor, subject) {
      return changeAccessSubject(skillId, actor, subject, "remove");
    },
    async setAccess(skillId, actor, accessInput) {
      await repository.ready();
      if (!(await repository.canManage(skillId, actor))) throw new SkillAccessNotFoundError("skill not found");
      if (!Number.isSafeInteger(accessInput.expectedRevision) || accessInput.expectedRevision < 1)
        throw new SkillAccessConflictError("invalid expected revision");
      if (accessInput.subjects.length > MAX_SKILL_ACCESS_SUBJECTS)
        throw new SkillAccessConflictError("too many access subjects");
      if (accessInput.mode !== "restricted" && accessInput.subjects.length > 0)
        throw new SkillAccessConflictError("subjects require restricted mode");
      if (accessInput.mode === "organization" && !actor.isAdmin) throw new SkillAccessNotFoundError("skill not found");
      const deduped = [
        ...new Map(accessInput.subjects.map((subject) => [`${subject.kind}:${subject.id}`, subject])).values(),
      ];
      const currentSubjects = (await store.listSkillAccessGrants(orgId, skillId))
        .map((grant) => organizationAccessSubjectFromScope(grant.granteeScopeId))
        .filter((subject): subject is SkillAccessSubject => subject !== null);
      const context = await unitAccessContext(actor, [...deduped, ...currentSubjects]);
      const visibility = context?.visibility ?? (await directory.resolve(actor));
      if (!visibility) throw new SkillAccessNotFoundError("access subject not found");
      if (visibility.mode === "none" && !actor.isAdmin && deduped.length > 0)
        throw new SkillAccessNotFoundError("access subject not found");
      for (const subject of deduped) {
        if (!(await subjectVisible(actor, subject, context)))
          throw new SkillAccessNotFoundError("access subject not found");
      }
      await store.transact(orgId, async (tx) => {
        if ((await tx.getSkillAccessPolicyVersion(orgId)) !== 1) throw new Error("skill access is not enforced");
        if ((await tx.getAuthzRevision(orgId)) !== visibility.revision)
          throw new SkillAccessConflictError("authorization changed; reload and retry");
        const skill = await tx.getSkill(orgId, skillId);
        if (!skill || !(await activeManager(tx, skill, actor))) throw new SkillAccessNotFoundError("skill not found");
        if (
          !actor.isAdmin &&
          (accessInput.mode === "organization" ||
            (accessInput.mode === "home" && parseScopeId(skill.scopeId).kind === "org"))
        )
          throw new SkillAccessNotFoundError("skill not found");
        const policy = await requirePolicy(tx, skill);
        if (policy.revision !== accessInput.expectedRevision)
          throw new SkillAccessConflictError("skill access revision conflict", policy.revision);
        const currentGrants = await tx.listSkillAccessGrants(orgId, skillId);
        for (const grant of currentGrants) {
          const subject = organizationAccessSubjectFromScope(grant.granteeScopeId);
          if (!subject || !(await subjectVisible(actor, subject, context)))
            throw new SkillAccessConflictError(
              "hidden access subjects require an organization administrator",
              policy.revision,
            );
        }
        for (const subject of deduped) await validateSubject(tx, subject);
        const at = Date.now();
        const nextPolicy: SkillAccessPolicy = {
          ...policy,
          mode: accessInput.mode,
          revision: policy.revision + 1,
          updatedAt: at,
          updatedBy: actor.principalId,
        };
        const grants: SkillAccessGrant[] =
          accessInput.mode === "restricted"
            ? deduped.map((subject) => ({
                orgId,
                ownerScopeId: skill.scopeId,
                path: skillPath(skillId),
                granteeScopeId: organizationAccessSubjectScope(subject),
                permission: "read",
                grantedBy: actor.principalId,
                grantedAt: at,
              }))
            : [];
        if (nextPolicy.mode === "restricted") {
          await tx.putSkillAccessPolicy(nextPolicy);
          await tx.replaceSkillAccessGrants(orgId, skillId, grants);
        } else {
          await tx.replaceSkillAccessGrants(orgId, skillId, []);
          await tx.putSkillAccessPolicy(nextPolicy);
        }
        await tx.bumpRevision(orgId);
        await tx.audit(
          auditEvent(
            orgId,
            actor.principalId,
            "skill.access.update",
            skill,
            JSON.stringify({
              before: { mode: policy.mode, subjects: currentGrants.length },
              after: { mode: nextPolicy.mode, subjects: grants.length },
            }),
          ),
        );
      });
      return view(skillId, actor);
    },
  };

  return repository;
}
