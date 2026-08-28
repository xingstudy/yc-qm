import { createHash, randomUUID } from "node:crypto";
import type {
  AccessGroup,
  AccessGroupMember,
  OrganizationStore,
  OrganizationUser,
  OrganizationUserListQuery,
  OrganizationUserStatus,
  OrgUnit,
  OrgUnitMember,
} from "./organization-store.ts";
import {
  normalizeOrganizationUserProfilePatch,
  type OrganizationMemberMutation,
  type OrganizationService,
  type OrganizationUserProfilePatch,
} from "./organization-service.ts";
import { parseOrganizationMemberCsv } from "./member-csv.ts";
import type {
  OrganizationMemberJob,
  OrganizationMemberJobDetail,
  OrganizationMemberJobItem,
  OrganizationMemberJobStore,
} from "./member-job-store.ts";
import { createKeyedQueue } from "../util/async.ts";

const JOB_TTL_MS = 24 * 60 * 60 * 1_000;
const JOB_LEASE_MS = 60 * 1_000;
const MAX_TARGETS = 5_000;

export type OrganizationMemberBatchAction =
  | { type: "set_job_title"; value: string | null }
  | { type: "set_primary_unit"; unitId: string; keepPreviousMembership: boolean }
  | { type: "clear_primary_unit"; keepPreviousMembership: boolean }
  | { type: "add_unit" | "remove_unit"; unitId: string }
  | { type: "add_group" | "remove_group"; groupId: string }
  | { type: "suspend" | "reactivate" | "deprovision" };

export interface OrganizationMemberBatchService {
  previewImport(input: {
    csv: string | Uint8Array;
    actor: string;
    idempotencyKey: string;
  }): Promise<OrganizationMemberJobDetail>;
  previewBatch(input: {
    principalIds?: readonly string[];
    query?: Omit<OrganizationUserListQuery, "after" | "limit">;
    action: OrganizationMemberBatchAction;
    actor: string;
    idempotencyKey: string;
  }): Promise<OrganizationMemberJobDetail>;
  get(jobId: string, actor: string): Promise<OrganizationMemberJobDetail | null>;
  page(jobId: string, actor: string, offset: number, limit: number): ReturnType<OrganizationMemberJobStore["page"]>;
  commit(input: {
    jobId: string;
    actor: string;
    inputHash: string;
  }): Promise<
    | { ok: true; detail: OrganizationMemberJobDetail }
    | { ok: false; reason: string; detail?: OrganizationMemberJobDetail }
  >;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function splitIds(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[;,|]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function mutationChanged(mutation: OrganizationMemberMutation): boolean {
  return Boolean(
    mutation.profile ||
    mutation.primaryUnit ||
    mutation.addUnitIds?.length ||
    mutation.removeUnitIds?.length ||
    mutation.addGroupIds?.length ||
    mutation.removeGroupIds?.length ||
    mutation.status,
  );
}

function profilePreviewValue(
  field: keyof OrganizationUserProfilePatch,
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (field === "email") {
    const at = value.lastIndexOf("@");
    return at > 0 ? `${value.slice(0, 1)}…${value.slice(at)}` : "••••";
  }
  if (field === "mobile") return `••••${value.slice(-4)}`;
  return value;
}

function mutationChanges(input: {
  mutation: OrganizationMemberMutation;
  user: OrganizationUser;
  unitMembers: readonly OrgUnitMember[];
  groupMembers: readonly AccessGroupMember[];
  units: ReadonlyMap<string, OrgUnit>;
  groups: ReadonlyMap<string, AccessGroup>;
  action?: OrganizationMemberBatchAction["type"];
}): Record<string, unknown> {
  const { mutation, user } = input;
  const changes: Record<string, unknown> = input.action ? { action: input.action } : {};
  if (mutation.profile) {
    const profile = Object.fromEntries(
      (Object.keys(mutation.profile) as Array<keyof OrganizationUserProfilePatch>)
        .filter((field) => mutation.profile![field] !== user[field])
        .map((field) => [
          field,
          {
            before: profilePreviewValue(field, user[field] as string | null),
            after: profilePreviewValue(field, mutation.profile![field]),
          },
        ]),
    );
    if (Object.keys(profile).length > 0) changes.profile = profile;
  }
  const unitRef = (id: string | null) => (id === null ? null : { id, name: input.units.get(id)?.name ?? id });
  const groupRef = (id: string) => ({ id, name: input.groups.get(id)?.name ?? id });
  const currentPrimary = input.unitMembers.find((member) => member.isPrimary === true)?.unitId ?? null;
  if (mutation.primaryUnit !== undefined && mutation.primaryUnit.unitId !== currentPrimary) {
    changes.primaryUnit = { before: unitRef(currentPrimary), after: unitRef(mutation.primaryUnit.unitId) };
  }
  if ((mutation.addUnitIds?.length ?? 0) > 0 || (mutation.removeUnitIds?.length ?? 0) > 0) {
    const before = new Set(input.unitMembers.filter((member) => !member.isPrimary).map((member) => member.unitId));
    const after = new Set(before);
    for (const id of mutation.addUnitIds ?? []) after.add(id);
    for (const id of mutation.removeUnitIds ?? []) after.delete(id);
    changes.additionalUnits = {
      before: [...before].map(unitRef),
      after: [...after].map(unitRef),
    };
  }
  if ((mutation.addGroupIds?.length ?? 0) > 0 || (mutation.removeGroupIds?.length ?? 0) > 0) {
    const before = new Set(input.groupMembers.map((member) => member.groupId));
    const after = new Set(before);
    for (const id of mutation.addGroupIds ?? []) after.add(id);
    for (const id of mutation.removeGroupIds ?? []) after.delete(id);
    changes.accessGroups = {
      before: [...before].map(groupRef),
      after: [...after].map(groupRef),
    };
  }
  if (mutation.status !== undefined && mutation.status !== user.status) {
    changes.status = { before: user.status, after: mutation.status };
  }
  return changes;
}

function batchActionTarget(
  action: OrganizationMemberBatchAction,
  units: ReadonlyMap<string, OrgUnit>,
  groups: ReadonlyMap<string, AccessGroup>,
): Record<string, unknown> {
  if (action.type === "set_job_title") return { value: action.value };
  if (action.type === "set_primary_unit") {
    return {
      unit: { id: action.unitId, name: units.get(action.unitId)?.name ?? action.unitId },
      keepPreviousMembership: action.keepPreviousMembership,
    };
  }
  if (action.type === "clear_primary_unit") {
    return { unit: null, keepPreviousMembership: action.keepPreviousMembership };
  }
  if (action.type === "add_unit" || action.type === "remove_unit") {
    return { unit: { id: action.unitId, name: units.get(action.unitId)?.name ?? action.unitId } };
  }
  if (action.type === "add_group" || action.type === "remove_group") {
    return { group: { id: action.groupId, name: groups.get(action.groupId)?.name ?? action.groupId } };
  }
  let status: OrganizationUserStatus = "deprovisioned";
  if (action.type === "reactivate") status = "active";
  if (action.type === "suspend") status = "suspended";
  return { status };
}

function jobSummary(items: readonly OrganizationMemberJobItem[]): Record<string, unknown> {
  const errors = items.filter((item) => item.errors.length > 0).length;
  const warnings = items.filter((item) => item.warnings.length > 0).length;
  const unchanged = items.filter((item) => item.status === "unchanged").length;
  return {
    total: items.length,
    ready: items.length - errors - unchanged,
    unchanged,
    warnings,
    errors,
    affectedMembers: new Set(items.map((item) => item.principalId).filter(Boolean)).size,
  };
}

function makeJob(input: {
  orgId: string;
  kind: "import" | "batch";
  actor: string;
  idempotencyKey: string;
  inputHash: string;
  expectedAuthzRevision: number;
  summary: Record<string, unknown>;
  now: number;
}): OrganizationMemberJob {
  return {
    id: `member-job-${randomUUID()}`,
    orgId: input.orgId,
    kind: input.kind,
    status: "previewed",
    actorId: input.actor,
    idempotencyKey: input.idempotencyKey,
    inputHash: input.inputHash,
    expectedAuthzRevision: input.expectedAuthzRevision,
    summary: input.summary,
    createdAt: input.now,
    startedAt: null,
    claimToken: null,
    leaseExpiresAt: null,
    completedAt: null,
    expiresAt: input.now + JOB_TTL_MS,
    error: null,
  };
}

function itemFor(input: {
  orgId: string;
  jobId: string;
  itemIndex: number;
  principalId: string | null;
  expectedProfileRevision: number | null;
  mutation?: OrganizationMemberMutation;
  changes?: Record<string, unknown>;
  errors?: string[];
  warnings?: string[];
}): OrganizationMemberJobItem {
  const errors = input.errors ?? [];
  const warnings = input.warnings ?? [];
  const changed = input.mutation ? mutationChanged(input.mutation) : false;
  let status: OrganizationMemberJobItem["status"] = "unchanged";
  if (changed) status = "ready";
  if (errors.length > 0) status = "error";
  return {
    orgId: input.orgId,
    jobId: input.jobId,
    itemIndex: input.itemIndex,
    principalId: input.principalId,
    expectedProfileRevision: input.expectedProfileRevision,
    normalizedInput: input.mutation ? { mutation: input.mutation } : {},
    changes: input.changes ?? {},
    status,
    errors,
    warnings: changed || errors.length > 0 ? warnings : [...warnings, "no_changes"],
  };
}

export function createOrganizationMemberBatchService(deps: {
  orgId: string;
  store: OrganizationStore;
  organization: OrganizationService;
  jobs: OrganizationMemberJobStore;
  now?: () => number;
  validateStatusTargets?: (
    mutations: readonly OrganizationMemberMutation[],
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  withStatusLock?: <T>(fn: () => Promise<T>) => Promise<T>;
}): OrganizationMemberBatchService {
  const { orgId, store, organization, jobs } = deps;
  const now = deps.now ?? Date.now;
  const commitQueue = createKeyedQueue<string>();

  async function previewImport(input: {
    csv: string | Uint8Array;
    actor: string;
    idempotencyKey: string;
  }): Promise<OrganizationMemberJobDetail> {
    const parsed = parseOrganizationMemberCsv(input.csv);
    const inputHash = hash(parsed.normalizedText);
    const [users, units, groups, expectedAuthzRevision] = await Promise.all([
      store.listUsers(orgId),
      store.listUnits(orgId),
      store.listGroups(orgId),
      store.getAuthzRevision(orgId),
    ]);
    const byId = new Map(users.map((user) => [user.principalId, user]));
    const byEmployeeNumber = new Map(
      users.filter((user) => user.employeeNumber).map((user) => [user.employeeNumber!.toLowerCase(), user]),
    );
    const byEmail = new Map(users.filter((user) => user.email).map((user) => [user.email!.toLowerCase(), user]));
    const unitsById = new Map(units.map((unit) => [unit.id, unit]));
    const groupsById = new Map(groups.map((group) => [group.id, group]));
    const headers = new Set(parsed.headers);
    const matched = parsed.rows.map((row) => {
      const principalId = row.principalId?.trim();
      const employeeNumber = row.employeeNumber?.trim().toLowerCase();
      const email = row.email?.trim().toLowerCase();
      if (principalId) return byId.get(principalId) ?? null;
      if (employeeNumber) return byEmployeeNumber.get(employeeNumber) ?? null;
      if (email) return byEmail.get(email) ?? null;
      return null;
    });
    const matchedPrincipalIds = matched
      .filter((user): user is OrganizationUser => user !== null)
      .map((user) => user.principalId);
    const [unitMembers, groupMembers] = await Promise.all([
      store.listUnitMembersForUsers(orgId, matchedPrincipalIds),
      store.listGroupMembersForUsers(orgId, matchedPrincipalIds),
    ]);
    const unitMembersByUser = new Map<string, typeof unitMembers>();
    const groupMembersByUser = new Map<string, typeof groupMembers>();
    for (const member of unitMembers) {
      const list = unitMembersByUser.get(member.principalId) ?? [];
      list.push(member);
      unitMembersByUser.set(member.principalId, list);
    }
    for (const member of groupMembers) {
      const list = groupMembersByUser.get(member.principalId) ?? [];
      list.push(member);
      groupMembersByUser.set(member.principalId, list);
    }
    const createdAt = now();
    const jobId = `member-job-${randomUUID()}`;
    const seen = new Set<string>();
    const items = parsed.rows.map((row, itemIndex) => {
      const user = matched[itemIndex] ?? null;
      const errors: string[] = [];
      const warnings: string[] = [];
      if (!user) errors.push("member_not_found");
      if (user && seen.has(user.principalId)) errors.push("duplicate_member");
      if (user) seen.add(user.principalId);
      const profile: OrganizationUserProfilePatch = {};
      if (headers.has("displayName")) profile.displayName = row.displayName ?? "";
      if (headers.has("email")) profile.email = row.email?.trim() || null;
      if (headers.has("jobTitle")) profile.jobTitle = row.jobTitle?.trim() || null;
      if (headers.has("mobile")) profile.mobile = row.mobile?.trim() || null;
      if (headers.has("employeeNumber")) profile.employeeNumber = row.employeeNumber?.trim() || null;
      const normalized = normalizeOrganizationUserProfilePatch(profile);
      if (!normalized.ok) errors.push(`invalid_${normalized.field}`);
      const mutation: OrganizationMemberMutation | undefined = user
        ? {
            principalId: user.principalId,
            expectedProfileRevision: user.profileRevision,
            ...(Object.keys(profile).length > 0 && normalized.ok ? { profile: normalized.patch } : {}),
          }
        : undefined;
      if (user && mutation && headers.has("primaryUnitId")) {
        const unitId = row.primaryUnitId?.trim() || null;
        if (unitId) {
          const unit = unitsById.get(unitId);
          if (!unit) errors.push("unknown_primary_unit");
          else if (unit.status !== "active") errors.push("archived_primary_unit");
          else if (unit.kind === "organization") errors.push("root_primary_unit");
        }
        mutation.primaryUnit = { unitId, keepPreviousMembership: true };
      }
      if (user && mutation && headers.has("additionalUnitIds")) {
        const desired = new Set(splitIds(row.additionalUnitIds ?? ""));
        const existing = unitMembersByUser.get(user.principalId) ?? [];
        const primary =
          mutation.primaryUnit !== undefined
            ? mutation.primaryUnit.unitId
            : existing.find((member) => member.isPrimary === true)?.unitId;
        if (primary) desired.delete(primary);
        for (const unitId of desired) {
          const unit = unitsById.get(unitId);
          if (!unit) errors.push("unknown_additional_unit");
          else if (unit.status !== "active") errors.push("archived_additional_unit");
        }
        const existingIds = new Set(
          existing.filter((member) => member.unitId !== primary).map((member) => member.unitId),
        );
        mutation.addUnitIds = [...desired].filter((unitId) => !existingIds.has(unitId));
        mutation.removeUnitIds = [...existingIds].filter((unitId) => !desired.has(unitId));
        if (existing.some((member) => member.role === "manager" && mutation.removeUnitIds!.includes(member.unitId))) {
          errors.push("manager_unit_conflict");
        }
      }
      if (user && mutation && headers.has("accessGroupIds")) {
        const desired = new Set(splitIds(row.accessGroupIds ?? ""));
        const existing = groupMembersByUser.get(user.principalId) ?? [];
        for (const groupId of desired) {
          const group = groupsById.get(groupId);
          if (!group) errors.push("unknown_access_group");
          else if (group.status !== "active") errors.push("archived_access_group");
        }
        const existingIds = new Set(existing.map((member) => member.groupId));
        mutation.addGroupIds = [...desired].filter((groupId) => !existingIds.has(groupId));
        mutation.removeGroupIds = [...existingIds].filter((groupId) => !desired.has(groupId));
        if (existing.some((member) => member.role === "manager" && mutation.removeGroupIds!.includes(member.groupId))) {
          errors.push("manager_group_conflict");
        }
      }
      if (mutation?.profile && user) {
        const unchanged = Object.entries(mutation.profile).every(
          ([field, value]) => user[field as keyof OrganizationUser] === value,
        );
        if (unchanged) delete mutation.profile;
      }
      const currentUnitMembers = user ? (unitMembersByUser.get(user.principalId) ?? []) : [];
      const currentGroupMembers = user ? (groupMembersByUser.get(user.principalId) ?? []) : [];
      if (
        mutation?.primaryUnit !== undefined &&
        mutation.primaryUnit.unitId === (currentUnitMembers.find((member) => member.isPrimary === true)?.unitId ?? null)
      ) {
        delete mutation.primaryUnit;
      }
      return itemFor({
        orgId,
        jobId,
        itemIndex,
        principalId: user?.principalId ?? null,
        expectedProfileRevision: user?.profileRevision ?? null,
        ...(mutation ? { mutation } : {}),
        changes:
          mutation && user
            ? mutationChanges({
                mutation,
                user,
                unitMembers: currentUnitMembers,
                groupMembers: currentGroupMembers,
                units: unitsById,
                groups: groupsById,
              })
            : {},
        errors,
        warnings,
      });
    });
    const proposedEmails = new Map<string, number>();
    const proposedEmployeeNumbers = new Map<string, number>();
    for (const item of items) {
      const mutation = item.normalizedInput.mutation as OrganizationMemberMutation | undefined;
      const email = mutation?.profile?.email?.toLowerCase();
      const employeeNumber = mutation?.profile?.employeeNumber?.toLowerCase();
      if (email) {
        const existing = byEmail.get(email);
        if (existing && existing.principalId !== item.principalId) item.errors.push("duplicate_email");
        const prior = proposedEmails.get(email);
        if (prior !== undefined) {
          item.errors.push("duplicate_email_in_file");
          items[prior]!.errors.push("duplicate_email_in_file");
        } else proposedEmails.set(email, item.itemIndex);
      }
      if (employeeNumber) {
        const existing = byEmployeeNumber.get(employeeNumber);
        if (existing && existing.principalId !== item.principalId) item.errors.push("duplicate_employee_number");
        const prior = proposedEmployeeNumbers.get(employeeNumber);
        if (prior !== undefined) {
          item.errors.push("duplicate_employee_number_in_file");
          items[prior]!.errors.push("duplicate_employee_number_in_file");
        } else proposedEmployeeNumbers.set(employeeNumber, item.itemIndex);
      }
    }
    for (const item of items) if (item.errors.length > 0) item.status = "error";
    const summary = { ...jobSummary(items), inputHash, rows: parsed.rows.length };
    const job = makeJob({
      orgId,
      kind: "import",
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      inputHash,
      expectedAuthzRevision,
      summary,
      now: createdAt,
    });
    job.id = jobId;
    return (await jobs.create(job, items)).detail;
  }

  async function resolveBatchTargets(input: {
    principalIds?: readonly string[];
    query?: Omit<OrganizationUserListQuery, "after" | "limit">;
  }): Promise<{ users: OrganizationUser[]; missingPrincipalIds: string[]; targetIds: string[] }> {
    if (input.principalIds) {
      const unique = [...new Set(input.principalIds.map((value) => value.trim()).filter(Boolean))];
      if (unique.length > MAX_TARGETS) throw new Error("organization member batch exceeds 5,000 targets");
      const users = await store.getUsersByPrincipalIds(orgId, unique);
      const found = new Set(users.map((user) => user.principalId));
      return { users, missingPrincipalIds: unique.filter((principalId) => !found.has(principalId)), targetIds: unique };
    }
    if (!input.query) throw new Error("organization member batch requires principalIds or query");
    const users: OrganizationUser[] = [];
    let after = null;
    do {
      const page = await store.listOrganizationUsers(orgId, { ...input.query, after, limit: 100 });
      users.push(...page.users);
      if (users.length > MAX_TARGETS) throw new Error("organization member batch exceeds 5,000 targets");
      after = page.next;
    } while (after);
    return { users, missingPrincipalIds: [], targetIds: users.map((user) => user.principalId) };
  }

  async function previewBatch(input: {
    principalIds?: readonly string[];
    query?: Omit<OrganizationUserListQuery, "after" | "limit">;
    action: OrganizationMemberBatchAction;
    actor: string;
    idempotencyKey: string;
  }): Promise<OrganizationMemberJobDetail> {
    const { users, missingPrincipalIds, targetIds } = await resolveBatchTargets(input);
    const expectedAuthzRevision = await store.getAuthzRevision(orgId);
    const principalIds = users.map((user) => user.principalId);
    const [unitMembers, groupMembers] = await Promise.all([
      store.listUnitMembersForUsers(orgId, principalIds),
      store.listGroupMembersForUsers(orgId, principalIds),
    ]);
    const [units, groups] = await Promise.all([store.listUnits(orgId), store.listGroups(orgId)]);
    const unitsById = new Map(units.map((unit) => [unit.id, unit]));
    const groupsById = new Map(groups.map((group) => [group.id, group]));
    if ("unitId" in input.action) {
      const unit = await store.getUnit(orgId, input.action.unitId);
      if (!unit || unit.status !== "active") throw new Error("organization member batch unit is unavailable");
      if (input.action.type === "set_primary_unit" && unit.kind === "organization") {
        throw new Error("organization root cannot be a primary unit");
      }
    }
    if ("groupId" in input.action) {
      const group = await store.getGroup(orgId, input.action.groupId);
      if (!group || group.status !== "active") throw new Error("organization member batch group is unavailable");
    }
    const normalizedInput = JSON.stringify({ principalIds: [...targetIds].sort(), action: input.action });
    const inputHash = hash(normalizedInput);
    const createdAt = now();
    const jobId = `member-job-${randomUUID()}`;
    const normalizedJobTitle =
      input.action.type === "set_job_title"
        ? normalizeOrganizationUserProfilePatch({ jobTitle: input.action.value })
        : null;
    const items = users.map((user, itemIndex) => {
      const errors: string[] = [];
      const mutation: OrganizationMemberMutation = {
        principalId: user.principalId,
        expectedProfileRevision: user.profileRevision,
      };
      const action = input.action;
      const currentUnitMembers = unitMembers.filter((member) => member.principalId === user.principalId);
      const currentGroupMembers = groupMembers.filter((member) => member.principalId === user.principalId);
      if (action.type === "set_job_title") {
        if (normalizedJobTitle?.ok) mutation.profile = normalizedJobTitle.patch;
        else errors.push("invalid_jobTitle");
      }
      if (action.type === "set_primary_unit") {
        const current = currentUnitMembers.find((member) => member.isPrimary === true)?.unitId ?? null;
        if (current !== action.unitId) {
          mutation.primaryUnit = { unitId: action.unitId, keepPreviousMembership: action.keepPreviousMembership };
        }
      }
      if (action.type === "clear_primary_unit") {
        if (currentUnitMembers.some((member) => member.isPrimary === true)) {
          mutation.primaryUnit = { unitId: null, keepPreviousMembership: action.keepPreviousMembership };
        }
      }
      if (action.type === "add_unit" && !currentUnitMembers.some((member) => member.unitId === action.unitId))
        mutation.addUnitIds = [action.unitId];
      if (action.type === "remove_unit") {
        const existing = currentUnitMembers.find((member) => member.unitId === action.unitId);
        if (existing) mutation.removeUnitIds = [action.unitId];
        if (existing?.role === "manager") errors.push("manager_unit_conflict");
        if (existing?.isPrimary === true) errors.push("primary_unit_conflict");
      }
      if (action.type === "add_group" && !currentGroupMembers.some((member) => member.groupId === action.groupId))
        mutation.addGroupIds = [action.groupId];
      if (action.type === "remove_group") {
        if (currentGroupMembers.some((member) => member.groupId === action.groupId)) {
          mutation.removeGroupIds = [action.groupId];
        }
        if (currentGroupMembers.find((member) => member.groupId === action.groupId)?.role === "manager") {
          errors.push("manager_group_conflict");
        }
      }
      if (action.type === "suspend") mutation.status = "suspended";
      if (action.type === "reactivate") mutation.status = "active";
      if (action.type === "deprovision") mutation.status = "deprovisioned";
      if (
        mutation.status &&
        mutation.status !== user.status &&
        !(
          (user.status === "active" && ["suspended", "deprovisioned"].includes(mutation.status)) ||
          (user.status === "suspended" && ["active", "deprovisioned"].includes(mutation.status))
        )
      ) {
        errors.push("invalid_transition");
      }
      if (mutation.profile?.jobTitle === user.jobTitle) delete mutation.profile;
      if (mutation.status === user.status) delete mutation.status;
      return itemFor({
        orgId,
        jobId,
        itemIndex,
        principalId: user.principalId,
        expectedProfileRevision: user.profileRevision,
        mutation,
        changes: mutationChanges({
          mutation,
          user,
          unitMembers: currentUnitMembers,
          groupMembers: currentGroupMembers,
          units: unitsById,
          groups: groupsById,
          action: action.type,
        }),
        errors,
      });
    });
    for (const principalId of missingPrincipalIds) {
      items.push(
        itemFor({
          orgId,
          jobId,
          itemIndex: items.length,
          principalId,
          expectedProfileRevision: null,
          errors: ["member_not_found"],
          changes: { action: input.action.type },
        }),
      );
    }
    const statusValidation = deps.validateStatusTargets
      ? await deps.validateStatusTargets(
          items
            .map((item) => item.normalizedInput.mutation as OrganizationMemberMutation)
            .filter((mutation) => mutation.status !== undefined),
        )
      : { ok: true as const };
    if (!statusValidation.ok && items[0]) {
      items[0].errors.push(statusValidation.reason);
      items[0].status = "error";
    }
    const summary = {
      ...jobSummary(items),
      action: input.action.type,
      target: batchActionTarget(input.action, unitsById, groupsById),
      inputHash,
    };
    const job = makeJob({
      orgId,
      kind: "batch",
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      inputHash,
      expectedAuthzRevision,
      summary,
      now: createdAt,
    });
    job.id = jobId;
    return (await jobs.create(job, items)).detail;
  }

  async function commit(input: {
    jobId: string;
    actor: string;
    inputHash: string;
  }): Promise<
    | { ok: true; detail: OrganizationMemberJobDetail }
    | { ok: false; reason: string; detail?: OrganizationMemberJobDetail }
  > {
    const execute = async () => {
      const existing = await jobs.get(orgId, input.jobId, input.actor);
      if (!existing) return { ok: false as const, reason: "not_found" };
      if (existing.job.status === "completed") return { ok: true as const, detail: existing };
      if (!["previewed", "running"].includes(existing.job.status)) {
        return { ok: false as const, reason: existing.job.status, detail: existing };
      }
      if (existing.job.status === "running" && (existing.job.leaseExpiresAt ?? Infinity) > now()) {
        return { ok: false as const, reason: "running", detail: existing };
      }
      if (existing.job.expiresAt <= now()) return { ok: false as const, reason: "expired", detail: existing };
      if (existing.job.inputHash !== input.inputHash)
        return { ok: false as const, reason: "input_hash_conflict", detail: existing };
      if (Number(existing.job.summary.errors ?? 0) > 0)
        return { ok: false as const, reason: "preview_has_errors", detail: existing };
      const claimAt = now();
      const claimToken = randomUUID();
      const claim = await jobs.claim(orgId, input.jobId, input.actor, claimToken, claimAt, claimAt + JOB_LEASE_MS);
      const claimed = claim?.detail;
      if (!claimed) return { ok: false as const, reason: "conflict" };
      if (claimed.job.status === "completed") return { ok: true as const, detail: claimed };
      if (!claim?.acquired) return { ok: false as const, reason: claimed.job.status, detail: claimed };
      const mutations = claimed.items
        .filter((item) => item.status === "ready")
        .map((item) => (item.normalizedInput as { mutation: OrganizationMemberMutation }).mutation);
      const statusValidation = deps.validateStatusTargets
        ? await deps.validateStatusTargets(mutations)
        : { ok: true as const };
      const result = statusValidation.ok
        ? await organization.applyMemberMutations({
            mutations,
            expectedAuthzRevision: claimed.job.expectedAuthzRevision,
            actor: input.actor,
            idempotencyKey: claimed.job.id,
          })
        : statusValidation;
      if (!result.ok) {
        await jobs.fail(orgId, input.jobId, input.actor, claimToken, result.reason, now());
        return { ok: false as const, reason: result.reason };
      }
      const detail = await jobs.complete(
        orgId,
        input.jobId,
        input.actor,
        claimToken,
        {
          ...claimed.job.summary,
          authorizationRevision: result.authorizationRevision,
          completedMembers: result.users.length,
        },
        now(),
      );
      if (detail) return { ok: true as const, detail };
      const current = await jobs.get(orgId, input.jobId, input.actor);
      return {
        ok: false as const,
        reason: current?.job.status ?? "conflict",
        ...(current ? { detail: current } : {}),
      };
    };
    return commitQueue(input.jobId, () => (deps.withStatusLock ? deps.withStatusLock(execute) : execute()));
  }

  return {
    previewImport,
    previewBatch,
    get: (jobId, actor) => jobs.get(orgId, jobId, actor),
    page: (jobId, actor, offset, limit) => jobs.page(orgId, jobId, actor, offset, limit),
    commit,
  };
}
