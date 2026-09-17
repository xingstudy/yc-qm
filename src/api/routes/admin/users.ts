import { createMemoryAdvisoryLock } from "../../../persistence/advisory-lock.ts";
import { scopeId as makeScopeId } from "../../../types.ts";
import { publicUrlOf } from "../../../deploy/deploy-store.ts";
import { adminStatusFromGrants, AdminError } from "../../../admin/admin-service.ts";
import { personKey, samePerson } from "../../../directory/person.ts";
import type { AdminRole } from "../../../admin/admin-grant-store.ts";
import type { DirectoryMember } from "../../../directory/directory-store.ts";
import { computeUsers } from "../../../admin/users.ts";
import { adminImBindingsByPrincipal, parseAdminImBindings } from "../../../admin/im-bindings.ts";
import { forEachAttributedTurn } from "../../../admin/attribution.ts";
import { INVITE_EMAIL_NOT_CONFIGURED, renderInviteEmail } from "../../../admin/invite-email.ts";
import { externalMemberActive, validEmail, type ExternalMember } from "../../../identity/external-members.ts";
import { resolveBranding } from "../../../resolution/branding.ts";
import { errMessage } from "../../../util/errors.ts";
import { normalizeInboundExpiresAt } from "../../expiry.ts";
import { detectOnboardingStatus, setOnboardingStatus, type OnboardingStatus } from "../../../onboarding/onboarding.ts";
import type { KeychainCredentialMeta } from "../../../credentials/keychain.ts";
import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, isObj, orgScope } from "../shared.ts";
import { type ApiCtx } from "../route.ts";
import { FILES_PAGE_SIZE } from "./common.ts";
import { uiStateId } from "../../../surfaces/ui-state.ts";

const externalMemberLocks = createMemoryAdvisoryLock();
const USER_CONVERSATIONS_MAX = 100;
const USER_FILES_MAX = 200;
const EXTERNAL_ORG_ADMIN_PORTAL_ONLY =
  "granting or removing org admin for an external user is portal-only — the agent cannot manage who governs the org";
const ALREADY_A_MEMBER =
  "that address already belongs to a member of the org — manage them under Users and Admins, not as an external user";
const HOLDS_OWN_GRANT =
  "that address holds an org admin grant of its own — revoke it under Admins first, or re-invite with role org_admin";
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const FORGET_AFTER_MS = 24 * 60 * 60 * 1000;

type AdminCredentialMetadata = Pick<
  KeychainCredentialMeta,
  "id" | "ownerId" | "service" | "kind" | "envKey" | "targets" | "host" | "accountLabel" | "expiresAt"
>;

function adminCredentialMetadata(credential: KeychainCredentialMeta): AdminCredentialMetadata {
  return {
    id: credential.id,
    ownerId: credential.ownerId,
    service: credential.service,
    kind: credential.kind,
    ...(credential.envKey !== undefined ? { envKey: credential.envKey } : {}),
    ...(credential.targets !== undefined ? { targets: credential.targets } : {}),
    ...(credential.host !== undefined ? { host: credential.host } : {}),
    ...(credential.accountLabel !== undefined ? { accountLabel: credential.accountLabel } : {}),
    ...(credential.expiresAt !== undefined ? { expiresAt: credential.expiresAt } : {}),
  };
}

export async function listUsers(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const scope = orgScope(deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  audit(deps, { principalId: actor.id, action: "users.read", resource: "users", scopeLabel: scope });
  const [participants, turns, grants, uiStateEntries] = await Promise.all([
    deps.sessions?.listParticipants() ?? Promise.resolve([]),
    deps.sessions?.attributedTurns() ?? Promise.resolve([]),
    deps.admin?.listGrants() ?? Promise.resolve([]),
    deps.uiState?.entries() ?? Promise.resolve([]),
  ]);
  const imBindings = adminImBindingsByPrincipal(uiStateEntries);
  const users = await Promise.all(
    computeUsers({ participants, turns, grants, principalIds: [...imBindings.keys()] }).map(async (user) => ({
      ...user,
      admin: await deps.admin!.adminStatusOf({ id: user.principalId, type: "internal" }),
      imBindings: imBindings.get(user.principalId) ?? [],
    })),
  );
  users.sort((a, b) => Number(b.admin.isAdmin) - Number(a.admin.isAdmin) || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
  const now = Date.now();
  const externalUsers = ((await deps.identity?.listExternalMembers()) ?? [])
    .map((m) => ({ ...m, status: externalMemberActive(m, now) ? ("active" as const) : ("expired" as const) }))
    .sort((a, b) => Number(b.status === "active") - Number(a.status === "active") || a.expiresAt - b.expiresAt);
  const signInUrl = signInUrlOf(deps);
  const inviteEmail = {
    configured: deps.inviteMailer !== undefined,
    ...(deps.inviteMailer ? {} : { problem: INVITE_EMAIL_NOT_CONFIGURED }),
    ...(signInUrl ? { signInUrl } : {}),
  };
  return sendJson(res, 200, { scopeId: scope, users, grants, externalUsers, inviteEmail });
}

function signInUrlOf(deps: ApiCtx["deps"]): string | undefined {
  return deps.portalUrl ? `${deps.portalUrl.replace(/\/+$/, "")}/auth/login` : undefined;
}

function endOfDayUtc(value: unknown): unknown {
  return typeof value === "string" && DATE_ONLY.test(value.trim()) ? `${value.trim()}T23:59:59.999Z` : value;
}

function grantError(res: ApiCtx["res"], error: string, e: unknown): void {
  if (e instanceof AdminError) return sendJson(res, e.status, { error, message: e.message });
  throw e;
}

async function orgMember(ctx: ApiCtx, email: string, includeSessions: boolean): Promise<boolean> {
  const { deps } = ctx;
  if (deps.emailAuthDomain && email.endsWith(`@${deps.emailAuthDomain}`)) return true;
  if ((deps.emailAuthPrincipals ?? []).some((principal) => samePerson(principal, email))) return true;
  if (await deps.directory?.get(email)) return true;
  const organizationUser = await deps.organization?.findUserByEmail(email);
  if (
    organizationUser &&
    (!organizationUser.externalMembership || organizationUser.invitedEmail?.toLowerCase() !== email)
  )
    return true;
  if (!includeSessions) return false;
  const participants = (await deps.sessions?.listParticipants()) ?? [];
  return participants.some((participant) => samePerson(participant.principalId, email));
}

export async function inviteExternalUser(ctx: ApiCtx): Promise<void> {
  const email = (isObj(ctx.body) ? String(ctx.body.email ?? "") : "").trim().toLowerCase();
  return (ctx.deps.advisoryLock ?? externalMemberLocks).withLock(`external-member:${orgScope(ctx.deps)}:${email}`, () =>
    inviteExternalUserLocked(ctx),
  );
}

async function inviteExternalUserLocked(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  const scope = orgScope(deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!deps.identity) return sendJson(res, 404, { error: "not_found" });
  const bad = (message: string) => sendJson(res, 400, { error: "bad_request", message });
  const b = isObj(body) ? body : {};
  const email = String(b.email ?? "")
    .trim()
    .toLowerCase();
  if (!validEmail(email)) return bad("a valid email address is required");
  const role = b.role ?? "member";
  if (role !== "member" && role !== "org_admin") return bad("role must be member or org_admin");
  const expiry = normalizeInboundExpiresAt(endOfDayUtc(b.expiresAt));
  if (!expiry.ok) return bad(expiry.message);
  const now = Date.now();
  if (expiry.value === undefined || expiry.value <= now) return bad("expiresAt is required and must be in the future");
  await deps.identity.refresh(true);
  const existing = deps.identity.externalMember(email);
  const holdsGrant = adminStatusFromGrants(await deps.admin!.listGrants(), email).isAdmin;
  const ownsGrant = existing?.role === "org_admin";
  if ((!existing && holdsGrant) || (await orgMember(ctx, email, !existing)))
    return sendJson(res, 409, { error: "conflict", message: ALREADY_A_MEMBER });
  if (ctx.capability && (role === "org_admin" || ownsGrant || holdsGrant)) {
    return sendJson(res, 403, { error: "forbidden", message: EXTERNAL_ORG_ADMIN_PORTAL_ONLY });
  }
  if (role === "member" && holdsGrant && !ownsGrant)
    return sendJson(res, 409, { error: "conflict", message: HOLDS_OWN_GRANT });
  const organizationUser = await deps.organization?.findUserByEmail(email);
  if (
    organizationUser &&
    (organizationUser.status === "deprovisioned" ||
      (organizationUser.status === "suspended" && organizationUser.updatedBy !== "system:external-member-expiry"))
  ) {
    return sendJson(res, 409, {
      error: "conflict",
      message: "This organization member is disabled. Restore the member before sending an invitation.",
    });
  }
  try {
    await deps.organization?.reserveExternalMember(email, email, actor.id);
  } catch {
    return sendJson(res, 409, { error: "conflict", message: ALREADY_A_MEMBER });
  }
  let grantChange: "grant.create" | "grant.revoke" | null = null;
  if (role === "org_admin" && !holdsGrant) grantChange = "grant.create";
  else if (role === "member" && holdsGrant) grantChange = "grant.revoke";
  if (grantChange && samePerson(actor.id, email))
    return sendJson(res, 403, {
      error: "forbidden",
      message: "Another administrator must change your external administrator role.",
    });
  try {
    if (grantChange === "grant.create")
      await deps.admin!.createGrant(actor, { principalId: email, role: "org_admin", scopeId: scope });
    else if (grantChange === "grant.revoke") await deps.admin!.revokeGrant(actor, email, scope, "org_admin");
  } catch (e) {
    return grantError(res, "grant_failed", e);
  }
  if (grantChange)
    audit(deps, { principalId: actor.id, action: grantChange, resource: `${email}/org_admin`, scopeLabel: scope });
  const created = existing === undefined;
  const readmitted = existing !== undefined && !externalMemberActive(existing, now);
  const member: ExternalMember = {
    email,
    role,
    expiresAt: expiry.value,
    invitedBy: existing?.invitedBy ?? actor.id,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  try {
    if (readmitted) await deps.organization?.syncExternalMember(email);
    await deps.identity.putExternalMember(member);
  } catch (error) {
    try {
      if (grantChange === "grant.create") await deps.admin!.revokeGrant(actor, email, scope, "org_admin");
      else if (grantChange === "grant.revoke")
        await deps.admin!.createGrant(actor, { principalId: email, role: "org_admin", scopeId: scope });
      if (grantChange)
        audit(deps, {
          principalId: actor.id,
          action: grantChange === "grant.create" ? "grant.revoke" : "grant.create",
          resource: `${email}/org_admin`,
          scopeLabel: scope,
        });
    } catch (compensationError) {
      audit(deps, {
        principalId: actor.id,
        action: "external_user.compensation_failed",
        resource: email,
        scopeLabel: scope,
      });
      throw compensationError;
    }
    audit(deps, { principalId: actor.id, action: "external_user.update_failed", resource: email, scopeLabel: scope });
    throw error;
  }
  audit(deps, {
    principalId: actor.id,
    action: created || readmitted ? "external_user.invite" : "external_user.update",
    resource: email,
    scopeLabel: scope,
  });
  try {
    await deps.organization?.syncExternalMember(email);
  } catch (error) {
    audit(deps, { principalId: actor.id, action: "external_user.update_failed", resource: email, scopeLabel: scope });
    throw error;
  }
  const signInUrl = signInUrlOf(deps);
  let emailSent = false;
  let emailProblem: string | undefined;
  if (created || readmitted || b.resendInvite === true) {
    if (!deps.inviteMailer) emailProblem = INVITE_EMAIL_NOT_CONFIGURED;
    else if (!signInUrl)
      emailProblem = "no sign-in URL is configured on core (set PUBLIC_WEB_URL) — share the portal address by hand";
    else {
      const branding = await resolveBranding(deps.config, scope, deps.brandingDefault);
      try {
        await deps.inviteMailer.send({
          to: email,
          ...renderInviteEmail({
            to: email,
            brandName: branding.selfLabel ?? "qm",
            invitedBy: actor.id,
            signInUrl,
            expiresAt: member.expiresAt,
          }),
        });
        emailSent = true;
      } catch (e) {
        emailProblem = errMessage(e);
      }
    }
  }
  return sendJson(res, 200, {
    ok: true,
    member,
    created,
    emailSent,
    ...(emailProblem ? { emailProblem } : {}),
    ...(signInUrl ? { signInUrl } : {}),
  });
}

export async function revokeExternalUser(ctx: ApiCtx): Promise<void> {
  const email = (ctx.params.email ?? "").trim().toLowerCase();
  return (ctx.deps.advisoryLock ?? externalMemberLocks).withLock(`external-member:${orgScope(ctx.deps)}:${email}`, () =>
    revokeExternalUserLocked(ctx),
  );
}

async function revokeExternalUserLocked(ctx: ApiCtx): Promise<void> {
  const { res, deps, params } = ctx;
  const scope = orgScope(deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!deps.identity) return sendJson(res, 404, { error: "not_found" });
  await deps.identity.refresh(true);
  const existing = deps.identity.externalMember(params.email ?? "");
  if (!existing) return sendJson(res, 404, { error: "not_found", message: "external user not found" });
  const holdsGrant = adminStatusFromGrants(await deps.admin!.listGrants(), existing.email).isAdmin;
  const ownsGrant = existing.role === "org_admin";
  if (ctx.capability && (ownsGrant || holdsGrant)) {
    return sendJson(res, 403, { error: "forbidden", message: EXTERNAL_ORG_ADMIN_PORTAL_ONLY });
  }
  if (holdsGrant && !ownsGrant) return sendJson(res, 409, { error: "conflict", message: HOLDS_OWN_GRANT });
  if (holdsGrant && samePerson(actor.id, existing.email))
    return sendJson(res, 403, {
      error: "forbidden",
      message: "Another administrator must revoke your external administrator membership.",
    });
  if (holdsGrant) {
    try {
      await deps.admin!.revokeGrant(actor, existing.email, scope, "org_admin");
    } catch (e) {
      return grantError(res, "revoke_failed", e);
    }
    audit(deps, {
      principalId: actor.id,
      action: "grant.revoke",
      resource: `${existing.email}/org_admin`,
      scopeLabel: scope,
    });
  }
  const now = Date.now();
  const tombstone: ExternalMember = {
    ...existing,
    role: "member",
    expiresAt: Math.min(existing.expiresAt, now),
    updatedAt: now,
  };
  if (externalMemberActive(existing, now) || existing.role !== "member") {
    try {
      await deps.identity.putExternalMember(tombstone);
    } catch (error) {
      if (holdsGrant) {
        try {
          await deps.admin!.createGrant(actor, { principalId: existing.email, role: "org_admin", scopeId: scope });
          audit(deps, {
            principalId: actor.id,
            action: "grant.create",
            resource: `${existing.email}/org_admin`,
            scopeLabel: scope,
          });
        } catch (compensationError) {
          audit(deps, {
            principalId: actor.id,
            action: "external_user.compensation_failed",
            resource: existing.email,
            scopeLabel: scope,
          });
          throw compensationError;
        }
      }
      audit(deps, {
        principalId: actor.id,
        action: "external_user.revoke_failed",
        resource: existing.email,
        scopeLabel: scope,
      });
      throw error;
    }
    audit(deps, { principalId: actor.id, action: "external_user.revoke", resource: existing.email, scopeLabel: scope });
  }
  try {
    await deps.organization?.syncExternalMember(existing.email);
    if (now - tombstone.expiresAt < FORGET_AFTER_MS) return sendJson(res, 200, { ok: true, removed: false });
    await deps.identity.removeExternalMember(existing.email);
  } catch (error) {
    audit(deps, {
      principalId: actor.id,
      action: "external_user.revoke_failed",
      resource: existing.email,
      scopeLabel: scope,
    });
    throw error;
  }
  audit(deps, { principalId: actor.id, action: "external_user.forget", resource: existing.email, scopeLabel: scope });
  return sendJson(res, 200, { ok: true, removed: true });
}

export async function searchDirectory(ctx: ApiCtx): Promise<void> {
  const { res, deps, app, url } = ctx;
  const actor = await authorizeAdmin(ctx, orgScope(deps));
  if (!actor) return;
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q || !deps.directory) return sendJson(res, 200, { members: [] });
  const r = await app.resolveRecipient(q);
  let members: DirectoryMember[] = [];
  if (r.kind === "one") members = [r.member];
  else if (r.kind === "ambiguous") members = r.candidates;
  return sendJson(res, 200, {
    members: members.map((m) => ({ principalId: m.principalId, displayName: m.displayName })),
  });
}

export async function listKeychainStatus(ctx: ApiCtx): Promise<void> {
  const { res, app, deps } = ctx;
  const scope = orgScope(deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  audit(deps, { principalId: actor.id, action: "keychain.read", resource: "keychain", scopeLabel: scope });

  if (!deps.keychain)
    return sendJson(res, 200, { scopeId: scope, people: [], credentials: [], grants: [], asks: [], enabled: false });

  const [credentialRecords, grants, asks, participantIds, adminGrants] = await Promise.all([
    deps.keychain.listAllMetadata(),
    deps.keychain.listGrants({}),
    deps.keychain.listAsks({}),
    deps.sessions?.distinctParticipants() ?? Promise.resolve([]),
    deps.admin?.listGrants() ?? Promise.resolve([]),
  ]);
  const credentials = credentialRecords.map(adminCredentialMetadata);
  const ids = new Set<string>([
    ...credentials.map((c) => c.ownerId),
    ...grants.map((g) => g.ownerId),
    ...grants.map((g) => g.usedBy).filter((id): id is string => !!id),
    ...asks.map((a) => a.ownerId),
    ...asks.map((a) => a.requesterId),
    ...participantIds,
    ...adminGrants.map((g) => g.principalId),
  ]);

  const members = await app.directoryMembers();
  const namesByKey = new Map(members.map((m) => [personKey(m.principalId), m.displayName]));
  const rosterIdByKey = new Map(members.map((m) => [personKey(m.principalId), m.principalId]));
  const idByKey = new Map<string, string>();
  for (const id of ids) {
    const key = personKey(id);
    if (!idByKey.has(key)) idByKey.set(key, rosterIdByKey.get(key) ?? id);
  }
  const people = [...idByKey.values()].sort().map((principalId) => ({
    principalId,
    displayName: namesByKey.get(personKey(principalId)) ?? null,
    credentialCount: credentials.filter((c) => samePerson(c.ownerId, principalId)).length,
    activeGrantCount: grants.filter(
      (g) =>
        samePerson(g.ownerId, principalId) &&
        g.status === "active" &&
        (g.expiresAt === undefined || g.expiresAt > Date.now()),
    ).length,
    pendingAskCount: asks.filter((a) => samePerson(a.ownerId, principalId) && a.status === "pending").length,
  }));

  const tally = (await deps.auditLog?.tallyByResource?.("keychain.materialize")) ?? new Map<string, number>();
  const useCountByGrant = new Map<string, number>();
  for (const [resource, n] of tally) {
    const m = /\(grant ([0-9a-f]+)\)$/.exec(resource);
    if (m) useCountByGrant.set(m[1]!, (useCountByGrant.get(m[1]!) ?? 0) + n);
  }
  const grantsWithUse = grants.map((g) => ({ ...g, useCount: useCountByGrant.get(g.id) ?? 0 }));

  return sendJson(res, 200, { scopeId: scope, people, credentials, grants: grantsWithUse, asks, enabled: true });
}

export async function getUserDetail(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, params } = ctx;
  const org = orgScope(deps);
  const actor = await authorizeAdmin(ctx, org);
  if (!actor) return;
  const principalId = params.principalId!;
  const personal = makeScopeId("personal", principalId);
  audit(deps, { principalId: actor.id, action: "user.read", resource: principalId, scopeLabel: org });

  const member = await app.directoryMember(principalId);

  const participants = (await deps.sessions?.listParticipants()) ?? [];
  const attributed = (await deps.sessions?.attributedTurns()) ?? [];
  const mySessionIds = new Set<string>();
  const turnsBySession = new Map<string, number>();
  let firstSeenAt: number | null = null;
  let lastSeenAt: number | null = null;
  const mark = (t: number) => {
    if (firstSeenAt == null || t < firstSeenAt) firstSeenAt = t;
    if (lastSeenAt == null || t > lastSeenAt) lastSeenAt = t;
  };
  forEachAttributedTurn(
    { participants, turns: attributed },
    {
      onWindow(sessionId, w) {
        if (!samePerson(w.principalId, principalId)) return;
        mySessionIds.add(sessionId);
        mark(w.validFrom);
      },
      onTurn(w, turn) {
        if (!samePerson(w.principalId, principalId)) return;
        turnsBySession.set(w.sessionId, (turnsBySession.get(w.sessionId) ?? 0) + turn.turns);
        mark(turn.firstAt);
        mark(turn.lastAt);
      },
    },
  );
  const turns = [...turnsBySession.values()].reduce((a, b) => a + b, 0);

  const summaries = mySessionIds.size
    ? ((await deps.sessions?.scopeSessionSummaries(org, true, undefined, [...mySessionIds])) ?? [])
    : [];
  const conversations = summaries
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .slice(0, USER_CONVERSATIONS_MAX)
    .map((s) => ({
      id: s.id,
      type: s.type,
      scopeId: s.scopeId,
      turns: s.turns,
      messages: s.messages,
      userTurns: turnsBySession.get(s.id) ?? 0,
      lastActivity: s.lastActivity,
      createdAt: s.createdAt,
      firstMessage: s.firstMessage,
      lastMessage: s.lastMessage,
    }));

  const files: Array<{
    id: string;
    name: string;
    path: string;
    mimetype: string;
    size: number;
    direction: string;
    createdAt: number;
    openable: boolean;
  }> = [];
  if (deps.files) {
    let cursor: string | undefined;
    do {
      const page = await deps.files.listOwnedByScopes([personal], {
        limit: FILES_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      for (const a of page.files) {
        files.push({
          id: a.id,
          name: a.name,
          path: a.path,
          mimetype: a.mimetype,
          size: a.sizeBytes,
          direction: a.direction,
          createdAt: a.createdAt,
          openable: a.blobKey != null,
        });
      }
      cursor = page.nextCursor;
    } while (cursor && files.length < USER_FILES_MAX);
  }
  const crons = (await app.listCrons())
    .filter((c) => c.ownerScopeId === personal)
    .map((c) => ({
      id: c.id,
      title: c.title,
      action: c.action,
      message: c.message,
      owner: c.owner,
      createdBy: c.createdBy,
      enabled: c.enabled,
      archived: c.archived,
      schedule: c.schedule,
      createdAt: c.createdAt,
      lastFiredAt: c.lastFiredAt,
    }));
  const deployments = (await app.listDeployments())
    .filter((d) => d.ownerScopeId === personal)
    .map((d) => ({
      id: d.id,
      name: d.displayName || d.name,
      status: d.status,
      currentVersion: d.currentVersion,
      versions: d.versions.length,
      createdBy: d.createdBy,
      lastAccessAt: d.lastAccessAt,
      publicUrl: publicUrlOf(d.endpoint),
    }));
  const config = deps.config
    ? {
        hasSoul: !!deps.config.getSoul(personal),
        soulVersion: deps.config.soulVersion(personal),
        securityPosture: await deps.config.getSecurityPostureDurable(personal),
        commandPolicy: deps.config.getCommandPolicy(personal),
        egress: deps.config.getEgress(personal),
        baseModel: deps.config.getBaseModel(personal),
        connectors: await deps.config.listConnectorClients(personal),
      }
    : null;
  const onboarding = deps.memory ? detectOnboardingStatus(await deps.memory.read(personal)) : null;
  const imBindings = deps.uiState
    ? parseAdminImBindings((await deps.uiState.get(uiStateId(principalId, "im-bindings")))?.value)
    : [];

  return sendJson(res, 200, {
    principalId,
    scopeId: personal,
    ...(member?.displayName ? { displayName: member.displayName } : {}),
    admin: (await deps.admin?.adminStatusOf({ id: principalId, type: "internal" })) ?? { isAdmin: false },
    stats: { sessions: mySessionIds.size, turns, firstSeenAt, lastSeenAt },
    conversations,
    files,
    deployments,
    crons,
    config,
    onboarding,
    imBindings,
  });
}

export async function startImpersonation(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, body } = ctx;
  const org = orgScope(deps);
  const actor = await authorizeAdmin(ctx, org);
  if (!actor) return;
  const target = String((body as { target?: string } | undefined)?.target ?? "").trim();
  if (!target) return sendJson(res, 400, { error: "bad_request", message: "target principal required" });
  if (target === actor.id) return sendJson(res, 400, { error: "bad_request", message: "cannot impersonate yourself" });
  const organizationUser = deps.organization ? await deps.organization.checkActive(target) : null;
  if (deps.organization && (!organizationUser || organizationUser.status !== "active")) {
    return sendJson(res, 404, { error: "not_found", message: "target principal not found" });
  }
  const member = await app.directoryMember(target);
  audit(deps, { principalId: actor.id, action: "impersonate.start", resource: target, scopeLabel: org });
  return sendJson(res, 200, {
    ok: true,
    target,
    displayName: member?.displayName ?? target,
    ...(organizationUser ? { sessionVersion: organizationUser.sessionVersion } : {}),
  });
}

export async function stopImpersonation(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  const org = orgScope(deps);
  const actor = await authorizeAdmin(ctx, org);
  if (!actor) return;
  const target = String((body as { target?: string } | undefined)?.target ?? "").trim();
  audit(deps, { principalId: actor.id, action: "impersonate.stop", resource: target || "-", scopeLabel: org });
  return sendJson(res, 200, { ok: true });
}

const ONBOARDING_STATUSES = new Set<OnboardingStatus>(["not_started", "pending", "completed", "dismissed"]);

export async function setUserOnboarding(ctx: ApiCtx): Promise<void> {
  const { res, deps, body, params } = ctx;
  const actor = await authorizeAdmin(ctx, orgScope(deps));
  if (!actor) return;
  if (!deps.memory) return sendJson(res, 404, { error: "not_found" });
  const principalId = params.principalId!;
  const status = (body as { status?: unknown }).status;
  if (typeof status !== "string" || !ONBOARDING_STATUSES.has(status as OnboardingStatus)) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "onboarding requires { status: not_started|pending|completed|dismissed }",
    });
  }
  const personal = makeScopeId("personal", principalId);
  const today = new Date().toISOString().slice(0, 10);
  const next = setOnboardingStatus(await deps.memory.read(personal), status as OnboardingStatus, today);
  await deps.memory.replace(personal, next, actor.id);
  audit(deps, {
    principalId: actor.id,
    action: "user.onboarding.set",
    resource: `${principalId}/${status}`,
    scopeLabel: personal,
  });
  return sendJson(res, 200, { ok: true, scopeId: personal, status });
}

export async function resetUserToBrandNew(ctx: ApiCtx): Promise<void> {
  const { res, deps, params } = ctx;
  const actor = await authorizeAdmin(ctx, orgScope(deps));
  if (!actor) return;
  if (!deps.memory) return sendJson(res, 404, { error: "not_found" });
  const principalId = params.principalId!;
  const personal = makeScopeId("personal", principalId);
  const today = new Date().toISOString().slice(0, 10);
  await deps.memory.replace(
    personal,
    setOnboardingStatus(await deps.memory.read(personal), "not_started", today),
    actor.id,
  );
  let deletedSessions = 0;
  if (deps.sessions) {
    const own = (await deps.sessions.listByParticipant(principalId)).filter((s) => s.scopeId === personal);
    for (const s of own) {
      await deps.sessions.deleteSession(s.id);
      deletedSessions++;
    }
  }
  audit(deps, {
    principalId: actor.id,
    action: "user.reset",
    resource: `${principalId}/sessions=${deletedSessions}`,
    scopeLabel: personal,
  });
  return sendJson(res, 200, { ok: true, scopeId: personal, deletedSessions });
}

export async function createAdminGrant(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  const actor = await authorizeAdmin(ctx, orgScope(deps));
  if (!actor) return;
  const b = body as { principalId?: string; role?: string; scopeId?: string };
  try {
    const grant = await deps.admin!.createGrant(actor, {
      principalId: String(b.principalId ?? ""),
      role: b.role as AdminRole,
      scopeId: String(b.scopeId ?? ""),
    });
    audit(deps, {
      principalId: actor.id,
      action: "grant.create",
      resource: `${grant.principalId}/${grant.role}`,
      scopeLabel: grant.scopeId,
    });
    return sendJson(res, 200, { ok: true, grant });
  } catch (e) {
    if (e instanceof AdminError) return sendJson(res, e.status, { error: "grant_failed", message: e.message });
    throw e;
  }
}

export async function revokeAdminGrant(ctx: ApiCtx): Promise<void> {
  const { res, deps, url, params } = ctx;
  const actor = await authorizeAdmin(ctx, orgScope(deps));
  if (!actor) return;
  const principalId = params.principalId!;
  const scope = url.searchParams.get("scope") ?? "";
  const role = url.searchParams.get("role") ?? "";
  if (!principalId || !scope || role !== "org_admin") {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "principalId (path), and scope + role=org_admin (query) required",
    });
  }
  try {
    await deps.admin!.revokeGrant(actor, principalId, scope, role);
    audit(deps, {
      principalId: actor.id,
      action: "grant.revoke",
      resource: `${principalId}/${role}`,
      scopeLabel: scope,
    });
    return sendJson(res, 200, { ok: true });
  } catch (e) {
    if (e instanceof AdminError) return sendJson(res, e.status, { error: "revoke_failed", message: e.message });
    throw e;
  }
}
