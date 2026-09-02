import { sendJson } from "../../http.ts";
import { errMessage } from "../../../util/errors.ts";
import { isDirectoryMatchPolicy, isDirectorySourceMode } from "../../../directory-sources/types.ts";
import type { DirectoryMatchState } from "../../../directory-sources/types.ts";
import { authorizeAdmin, orgScope } from "../shared.ts";
import { isObj } from "../shared.ts";
import type { ApiCtx, Route } from "../route.ts";

async function authorized(ctx: ApiCtx) {
  const actor = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!actor) return null;
  if (!ctx.deps.directorySources?.durable || !ctx.deps.directorySourceStore || !ctx.deps.identityLinking) {
    sendJson(ctx.res, 503, { error: "not_configured", message: "directory sources require PostgreSQL" });
    return null;
  }
  return actor;
}

function sourceError(ctx: ApiCtx, error: unknown): void {
  const raw = errMessage(error) || "directory_source_failed";
  const code = raw.split(":")[0]!;
  let status = 400;
  if (code.includes("not_found")) status = 404;
  else if (code.includes("duplicate") || code.includes("conflict") || code.includes("stale")) status = 409;
  const messages: Record<string, string> = {
    directory_source_duplicate_tenant: "An identity source for this provider tenant already exists.",
    directory_source_environment_read_only: "This source is managed by environment configuration.",
    directory_source_incomplete_secret: "Complete every required credential field before saving.",
    directory_source_secret_unavailable: "Stored credentials are incomplete. Enter the missing credential fields.",
    directory_source_login_unsupported: "This provider does not support managed login.",
    directory_source_sync_unsupported: "This provider does not support full directory synchronization.",
    directory_source_managed_directory_unsupported: "This provider cannot manage organization units.",
    directory_source_managed_directory_conflict: "Only one active source can manage the organization directory.",
    directory_source_jit_unsupported:
      "JIT provisioning requires verified corporate-email matching and trusted email-to-user lookup.",
    directory_source_jit_snapshot_required:
      "Complete a full directory synchronization before enabling automatic provisioning.",
    directory_source_jit_reconciliation_required:
      "Complete a fresh email reconciliation before enabling automatic provisioning.",
    directory_source_reconciliation_required:
      "Complete a fresh email reconciliation before enabling automatic provisioning.",
    directory_email_resolution_snapshot_required:
      "Complete a full directory synchronization before reconciling corporate emails.",
    directory_email_resolution_unsupported:
      "This source cannot perform trusted corporate-email reconciliation under its current match policy.",
    directory_source_preview_required: "Complete a successful sync preview before enabling synchronization.",
    directory_source_deleted_tenant_restore_required: "Restore the deleted source to preserve existing bindings.",
    directory_source_environment_delete_forbidden: "Environment-managed sources can be paused but not deleted here.",
    directory_sync_source_disabled: "Enable synchronization before starting a full sync.",
    directory_sync_full_unsupported: "This provider does not support full synchronization.",
    directory_sync_targeted_unsupported: "This provider does not support targeted member refresh.",
    managed_directory_mode_required: "Switch the source to managed organization directory mode first.",
    managed_directory_snapshot_required: "Complete a full directory synchronization first.",
    managed_directory_preview_blocked: "Resolve every managed-directory conflict before committing.",
    managed_directory_preview_expired: "The managed-directory preview expired. Generate a new preview.",
    managed_directory_preview_stale: "The source changed after this preview. Generate a new preview.",
    managed_directory_manual_suspension_conflict:
      "An administrator changed this user's status after the source suspended it. Generate a new preview.",
    managed_directory_user_ownership_conflict:
      "The external identity was rebound to a different user. Resolve the binding and generate a new preview.",
  };
  const message =
    messages[code] ??
    (code.startsWith("wecom_")
      ? "WeCom rejected the request. Check app permissions and credentials."
      : "The identity source request failed.");
  sendJson(ctx.res, status, { error: code, message });
}

function sourceInput(body: unknown) {
  if (!isObj(body)) return null;
  const allowed = new Set([
    "provider",
    "name",
    "publicConfig",
    "secretConfig",
    "loginEnabled",
    "syncEnabled",
    "mode",
    "jitProvisioningEnabled",
    "scheduleMinutes",
    "matchPolicy",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return null;
  if (
    typeof body.provider !== "string" ||
    typeof body.name !== "string" ||
    !isObj(body.publicConfig) ||
    Object.values(body.publicConfig).some((value) => typeof value !== "string") ||
    !isObj(body.secretConfig) ||
    Object.values(body.secretConfig).some((value) => typeof value !== "string") ||
    (body.loginEnabled !== undefined && typeof body.loginEnabled !== "boolean") ||
    (body.syncEnabled !== undefined && typeof body.syncEnabled !== "boolean") ||
    (body.mode !== undefined && !isDirectorySourceMode(body.mode)) ||
    (body.jitProvisioningEnabled !== undefined && typeof body.jitProvisioningEnabled !== "boolean") ||
    (body.scheduleMinutes !== undefined && typeof body.scheduleMinutes !== "number") ||
    (body.matchPolicy !== undefined && !isDirectoryMatchPolicy(body.matchPolicy))
  ) {
    return null;
  }
  return {
    provider: body.provider,
    name: body.name,
    publicConfig: body.publicConfig as Record<string, string>,
    secretConfig: body.secretConfig as Record<string, string>,
    ...(typeof body.loginEnabled === "boolean" ? { loginEnabled: body.loginEnabled } : {}),
    ...(typeof body.syncEnabled === "boolean" ? { syncEnabled: body.syncEnabled } : {}),
    ...(isDirectorySourceMode(body.mode) ? { mode: body.mode } : {}),
    ...(typeof body.jitProvisioningEnabled === "boolean"
      ? { jitProvisioningEnabled: body.jitProvisioningEnabled }
      : {}),
    ...(typeof body.scheduleMinutes === "number" ? { scheduleMinutes: body.scheduleMinutes } : {}),
    ...(isDirectoryMatchPolicy(body.matchPolicy) ? { matchPolicy: body.matchPolicy } : {}),
  };
}

async function catalog(ctx: ApiCtx): Promise<void> {
  if (!(await authorized(ctx))) return;
  return sendJson(ctx.res, 200, { providers: ctx.deps.directorySources!.catalog() });
}

async function listSources(ctx: ApiCtx): Promise<void> {
  if (!(await authorized(ctx))) return;
  return sendJson(ctx.res, 200, {
    sources: await ctx.deps.directorySources!.list(ctx.url.searchParams.get("includeDeleted") === "true"),
    providers: ctx.deps.directorySources!.catalog(),
  });
}

async function migrationPreview(ctx: ApiCtx): Promise<void> {
  if (!(await authorized(ctx))) return;
  if (!ctx.deps.directoryIdentityMigration) return sendJson(ctx.res, 503, { error: "not_configured" });
  try {
    const sourceId = ctx.url.searchParams.get("sourceId")?.trim() || undefined;
    return sendJson(ctx.res, 200, await ctx.deps.directoryIdentityMigration.preview(sourceId));
  } catch (error) {
    return sourceError(ctx, error);
  }
}

async function createSource(ctx: ApiCtx): Promise<void> {
  const actor = await authorized(ctx);
  if (!actor) return;
  const input = sourceInput(ctx.body);
  if (!input) return sendJson(ctx.res, 400, { error: "bad_request" });
  try {
    return sendJson(ctx.res, 201, { source: await ctx.deps.directorySources!.create(input, actor.id) });
  } catch (error) {
    return sourceError(ctx, error);
  }
}

async function getSource(ctx: ApiCtx): Promise<void> {
  if (!(await authorized(ctx))) return;
  const source = await ctx.deps.directorySources!.get(ctx.params.sourceId ?? "", true);
  if (!source) return sendJson(ctx.res, 404, { error: "not_found" });
  const [runs, members] = await Promise.all([
    ctx.deps.directorySync?.list(source.id, 10) ?? [],
    ctx.deps.directorySourceStore!.listMembers(ctx.deps.organizationOrgId!, source.id, { limit: 1 }),
  ]);
  return sendJson(ctx.res, 200, { source, runs, hasMembers: members.members.length > 0 });
}

async function patchSource(ctx: ApiCtx): Promise<void> {
  const actor = await authorized(ctx);
  if (!actor) return;
  if (!isObj(ctx.body) || typeof ctx.body.expectedRevision !== "number") {
    return sendJson(ctx.res, 400, { error: "bad_request" });
  }
  const body = ctx.body;
  const allowed = new Set([
    "expectedRevision",
    "name",
    "publicConfig",
    "secretConfig",
    "loginEnabled",
    "syncEnabled",
    "mode",
    "jitProvisioningEnabled",
    "scheduleMinutes",
    "matchPolicy",
    "status",
  ]);
  if (
    Object.keys(body).some((key) => !allowed.has(key)) ||
    (body.name !== undefined && typeof body.name !== "string") ||
    (body.publicConfig !== undefined &&
      (!isObj(body.publicConfig) || Object.values(body.publicConfig).some((value) => typeof value !== "string"))) ||
    (body.secretConfig !== undefined &&
      (!isObj(body.secretConfig) || Object.values(body.secretConfig).some((value) => typeof value !== "string"))) ||
    (body.loginEnabled !== undefined && typeof body.loginEnabled !== "boolean") ||
    (body.syncEnabled !== undefined && typeof body.syncEnabled !== "boolean") ||
    (body.mode !== undefined && !isDirectorySourceMode(body.mode)) ||
    (body.jitProvisioningEnabled !== undefined && typeof body.jitProvisioningEnabled !== "boolean") ||
    (body.scheduleMinutes !== undefined && typeof body.scheduleMinutes !== "number") ||
    (body.matchPolicy !== undefined && !isDirectoryMatchPolicy(body.matchPolicy)) ||
    (body.status !== undefined && body.status !== "active" && body.status !== "paused")
  ) {
    return sendJson(ctx.res, 400, { error: "bad_request" });
  }
  try {
    const prior =
      body.status === "paused" ? await ctx.deps.directorySources!.get(ctx.params.sourceId ?? "", true) : null;
    const result = await ctx.deps.directorySources!.update(
      ctx.params.sourceId ?? "",
      {
        expectedRevision: body.expectedRevision as number,
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(isObj(body.publicConfig) ? { publicConfig: body.publicConfig as Record<string, string> } : {}),
        ...(isObj(body.secretConfig) ? { secretConfig: body.secretConfig as Record<string, string> } : {}),
        ...(typeof body.loginEnabled === "boolean" ? { loginEnabled: body.loginEnabled } : {}),
        ...(typeof body.syncEnabled === "boolean" ? { syncEnabled: body.syncEnabled } : {}),
        ...(isDirectorySourceMode(body.mode) ? { mode: body.mode } : {}),
        ...(typeof body.jitProvisioningEnabled === "boolean"
          ? { jitProvisioningEnabled: body.jitProvisioningEnabled }
          : {}),
        ...(typeof body.scheduleMinutes === "number" ? { scheduleMinutes: body.scheduleMinutes } : {}),
        ...(isDirectoryMatchPolicy(body.matchPolicy) ? { matchPolicy: body.matchPolicy } : {}),
        ...(body.status === "active" || body.status === "paused" ? { status: body.status } : {}),
      },
      actor.id,
    );
    if (result === "conflict") return sendJson(ctx.res, 409, { error: "revision_conflict" });
    const affectedUsers =
      prior?.status === "active" && result.status === "paused"
        ? await ctx.deps.identityLinking!.invalidateSourceSessions(result.id, actor.id, result.revision)
        : undefined;
    return sendJson(ctx.res, 200, { source: result, ...(affectedUsers === undefined ? {} : { affectedUsers }) });
  } catch (error) {
    return sourceError(ctx, error);
  }
}

async function deleteSource(ctx: ApiCtx): Promise<void> {
  const actor = await authorized(ctx);
  if (!actor) return;
  const expectedRevision = Number(ctx.url.searchParams.get("expectedRevision"));
  if (!Number.isInteger(expectedRevision)) return sendJson(ctx.res, 400, { error: "bad_request" });
  const sourceId = ctx.params.sourceId ?? "";
  try {
    const source = await ctx.deps.directorySources!.get(sourceId, true);
    if (!source) return sendJson(ctx.res, 404, { error: "not_found" });
    if (source.revision !== expectedRevision) return sendJson(ctx.res, 409, { error: "revision_conflict" });
    if (source.origin === "environment") throw new Error("directory_source_environment_delete_forbidden");
    const paused = await ctx.deps.directorySources!.pause(sourceId, expectedRevision, actor.id);
    if (!paused) return sendJson(ctx.res, 404, { error: "not_found" });
    if (paused === "conflict") return sendJson(ctx.res, 409, { error: "revision_conflict" });
    const affectedUsers = await ctx.deps.identityLinking!.invalidateSourceSessions(sourceId, actor.id, paused.revision);
    const result = await ctx.deps.directorySources!.delete(sourceId, paused.revision, actor.id);
    if (!result) return sendJson(ctx.res, 404, { error: "not_found" });
    if (result === "conflict") return sendJson(ctx.res, 409, { error: "revision_conflict" });
    return sendJson(ctx.res, 200, { source: result, affectedUsers });
  } catch (error) {
    return sourceError(ctx, error);
  }
}

async function sourceImpact(ctx: ApiCtx): Promise<void> {
  if (!(await authorized(ctx))) return;
  const source = await ctx.deps.directorySources!.get(ctx.params.sourceId ?? "", true);
  if (!source) return sendJson(ctx.res, 404, { error: "not_found" });
  return sendJson(ctx.res, 200, {
    sourceRevision: source.revision,
    ...(await ctx.deps.identityLinking!.sourceImpact(source.id)),
  });
}

async function pauseSource(ctx: ApiCtx): Promise<void> {
  const actor = await authorized(ctx);
  if (!actor) return;
  if (!isObj(ctx.body) || !Number.isInteger(ctx.body.expectedRevision)) {
    return sendJson(ctx.res, 400, { error: "bad_request" });
  }
  const sourceId = ctx.params.sourceId ?? "";
  const prior = await ctx.deps.directorySources!.get(sourceId, true);
  const result = await ctx.deps.directorySources!.pause(sourceId, ctx.body.expectedRevision as number, actor.id);
  if (!result) return sendJson(ctx.res, 404, { error: "not_found" });
  if (result === "conflict") return sendJson(ctx.res, 409, { error: "revision_conflict" });
  const affectedUsers =
    prior?.status === "active"
      ? await ctx.deps.identityLinking!.invalidateSourceSessions(sourceId, actor.id, result.revision)
      : 0;
  return sendJson(ctx.res, 200, { source: result, affectedUsers });
}

async function restoreSource(ctx: ApiCtx): Promise<void> {
  const actor = await authorized(ctx);
  if (!actor) return;
  if (
    !isObj(ctx.body) ||
    !Number.isInteger(ctx.body.expectedRevision) ||
    !isObj(ctx.body.secretConfig) ||
    Object.values(ctx.body.secretConfig).some((value) => typeof value !== "string")
  ) {
    return sendJson(ctx.res, 400, { error: "bad_request" });
  }
  try {
    const result = await ctx.deps.directorySources!.restore(
      ctx.params.sourceId ?? "",
      ctx.body.expectedRevision as number,
      ctx.body.secretConfig as Record<string, string>,
      actor.id,
    );
    if (!result) return sendJson(ctx.res, 404, { error: "not_found" });
    if (result === "conflict") return sendJson(ctx.res, 409, { error: "revision_conflict" });
    return sendJson(ctx.res, 200, { source: result });
  } catch (error) {
    return sourceError(ctx, error);
  }
}

async function testSource(ctx: ApiCtx): Promise<void> {
  if (!(await authorized(ctx))) return;
  try {
    const source = await ctx.deps.directorySources!.test(ctx.params.sourceId ?? "");
    if (!source) return sendJson(ctx.res, 404, { error: "not_found" });
    return sendJson(ctx.res, 200, { source });
  } catch (error) {
    return sourceError(ctx, error);
  }
}

async function requestSync(ctx: ApiCtx, preview: boolean): Promise<void> {
  if (!(await authorized(ctx))) return;
  if (!ctx.deps.directorySync) return sendJson(ctx.res, 503, { error: "not_configured" });
  try {
    const run = await ctx.deps.directorySync.request({
      sourceId: ctx.params.sourceId ?? "",
      kind: preview ? "preview" : "manual",
    });
    return sendJson(ctx.res, 202, { run });
  } catch (error) {
    return sourceError(ctx, error);
  }
}

async function reconcileSource(ctx: ApiCtx): Promise<void> {
  if (!(await authorized(ctx))) return;
  if (!ctx.deps.directoryEmailResolutions) return sendJson(ctx.res, 503, { error: "not_configured" });
  try {
    return sendJson(ctx.res, 200, await ctx.deps.directoryEmailResolutions.reconcile(ctx.params.sourceId ?? ""));
  } catch (error) {
    return sourceError(ctx, error);
  }
}

async function managedPreview(ctx: ApiCtx): Promise<void> {
  const actor = await authorized(ctx);
  if (!actor) return;
  if (!ctx.deps.managedDirectory) return sendJson(ctx.res, 503, { error: "not_configured" });
  try {
    return sendJson(ctx.res, 200, await ctx.deps.managedDirectory.preview(ctx.params.sourceId ?? "", actor.id));
  } catch (error) {
    return sourceError(ctx, error);
  }
}

async function decideManagedUnitMapping(ctx: ApiCtx): Promise<void> {
  const actor = await authorized(ctx);
  if (!actor) return;
  if (!ctx.deps.managedDirectory) return sendJson(ctx.res, 503, { error: "not_configured" });
  if (
    !isObj(ctx.body) ||
    typeof ctx.body.previewId !== "string" ||
    !ctx.body.previewId.trim() ||
    typeof ctx.body.externalUnitId !== "string" ||
    !ctx.body.externalUnitId.trim() ||
    (ctx.body.decision !== "create" && ctx.body.decision !== "map")
  ) {
    return sendJson(ctx.res, 400, { error: "bad_request" });
  }
  const result = await ctx.deps.managedDirectory.decideUnitMapping({
    sourceId: ctx.params.sourceId ?? "",
    previewId: ctx.body.previewId.trim(),
    externalUnitId: ctx.body.externalUnitId.trim(),
    decision: ctx.body.decision,
    actor: actor.id,
  });
  if (result === "not_found") return sendJson(ctx.res, 404, { status: result });
  if (result === "conflict") return sendJson(ctx.res, 409, { status: result });
  return sendJson(ctx.res, 200, { status: result });
}

async function commitManagedPreview(ctx: ApiCtx): Promise<void> {
  const actor = await authorized(ctx);
  if (!actor) return;
  if (!ctx.deps.managedDirectory) return sendJson(ctx.res, 503, { error: "not_configured" });
  if (!isObj(ctx.body) || typeof ctx.body.previewId !== "string" || !ctx.body.previewId.trim()) {
    return sendJson(ctx.res, 400, { error: "bad_request" });
  }
  try {
    return sendJson(
      ctx.res,
      200,
      await ctx.deps.managedDirectory.commit(ctx.params.sourceId ?? "", ctx.body.previewId.trim(), actor.id),
    );
  } catch (error) {
    return sourceError(ctx, error);
  }
}

async function listRuns(ctx: ApiCtx): Promise<void> {
  if (!(await authorized(ctx))) return;
  const runs = await ctx.deps.directorySync?.list(ctx.params.sourceId ?? "", 50);
  return sendJson(ctx.res, 200, { runs: runs ?? [] });
}

async function getRun(ctx: ApiCtx): Promise<void> {
  if (!(await authorized(ctx))) return;
  const run = await ctx.deps.directorySync?.get(ctx.params.sourceId ?? "", ctx.params.runId ?? "");
  if (!run) return sendJson(ctx.res, 404, { error: "not_found" });
  return sendJson(ctx.res, 200, { run });
}

async function listMembers(ctx: ApiCtx): Promise<void> {
  if (!(await authorized(ctx))) return;
  const limit = Number(ctx.url.searchParams.get("limit") ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return sendJson(ctx.res, 400, { error: "bad_request" });
  const state = ctx.url.searchParams.getAll("state").filter(Boolean);
  const allowedStates = new Set(["bound", "suggested", "unmatched", "conflict", "ignored", "inactive"]);
  if (state.some((value) => !allowedStates.has(value))) return sendJson(ctx.res, 400, { error: "bad_request" });
  const selectedStates = state.length ? new Set(state as DirectoryMatchState[]) : null;
  const sourceId = ctx.params.sourceId ?? "";
  const members: Array<Record<string, unknown>> = [];
  let after = ctx.url.searchParams.get("cursor");
  let exhausted = false;
  while (members.length <= limit && !exhausted) {
    const page = await ctx.deps.directorySourceStore!.listMembers(ctx.deps.organizationOrgId!, sourceId, {
      limit: 100,
      ...(ctx.url.searchParams.get("q") ? { query: ctx.url.searchParams.get("q")! } : {}),
      ...(after ? { after: { externalSubjectId: after } } : {}),
    });
    const matches = await ctx.deps.identityLinking!.evaluatePage(
      sourceId,
      page.members.map((member) => member.externalSubjectId),
    );
    for (const member of page.members) {
      const match = matches.get(member.externalSubjectId);
      const matchState = match?.state ?? member.matchState;
      if (!selectedStates || selectedStates.has(matchState)) {
        members.push({
          ...member,
          matchState,
          matchReason: match?.reason ?? member.matchReason,
          matchedPrincipalId: match?.state === "bound" ? match.principalId : member.matchedPrincipalId,
          match,
        });
      }
    }
    after = page.next?.externalSubjectId ?? null;
    exhausted = !after;
  }
  const pageMembers = members.slice(0, limit);
  return sendJson(ctx.res, 200, {
    members: pageMembers,
    cursor:
      members.length > limit && pageMembers.length
        ? String(pageMembers[pageMembers.length - 1]!.externalSubjectId)
        : null,
  });
}

async function getMember(ctx: ApiCtx): Promise<void> {
  if (!(await authorized(ctx))) return;
  const sourceId = ctx.params.sourceId ?? "";
  const externalSubjectId = ctx.params.externalSubjectId ?? "";
  const member = await ctx.deps.directorySourceStore!.getMember(
    ctx.deps.organizationOrgId!,
    sourceId,
    externalSubjectId,
  );
  if (!member) return sendJson(ctx.res, 404, { error: "not_found" });
  return sendJson(ctx.res, 200, {
    member,
    match: await ctx.deps.identityLinking!.evaluate(sourceId, externalSubjectId),
  });
}

async function bindMember(ctx: ApiCtx, rebind: boolean): Promise<void> {
  const actor = await authorized(ctx);
  if (!actor) return;
  if (
    !isObj(ctx.body) ||
    typeof ctx.body.principalId !== "string" ||
    !ctx.body.principalId.trim() ||
    !Number.isInteger(ctx.body.expectedSourceRevision) ||
    typeof ctx.body.expectedProfileHash !== "string" ||
    !ctx.body.expectedProfileHash
  ) {
    return sendJson(ctx.res, 400, { error: "bad_request" });
  }
  const input = {
    sourceId: ctx.params.sourceId ?? "",
    externalSubjectId: ctx.params.externalSubjectId ?? "",
    principalId: ctx.body.principalId.trim(),
    actor: actor.id,
    expectedSourceRevision: ctx.body.expectedSourceRevision as number,
    expectedProfileHash: ctx.body.expectedProfileHash,
  };
  const result = rebind
    ? await ctx.deps.identityLinking!.rebind(input)
    : await ctx.deps.identityLinking!.bind({ ...input, matchedBy: "manual" });
  let status = 409;
  if (result === "bound") status = 200;
  else if (result === "not_found") status = 404;
  return sendJson(ctx.res, status, { status: result });
}

async function refreshMember(ctx: ApiCtx): Promise<void> {
  if (!(await authorized(ctx))) return;
  if (!ctx.deps.directorySync) return sendJson(ctx.res, 503, { error: "not_configured" });
  try {
    const run = await ctx.deps.directorySync.request({
      sourceId: ctx.params.sourceId ?? "",
      kind: "targeted",
      targetExternalSubjectId: ctx.params.externalSubjectId ?? "",
    });
    return sendJson(ctx.res, 202, { run });
  } catch (error) {
    return sourceError(ctx, error);
  }
}

async function ignoreMember(ctx: ApiCtx): Promise<void> {
  const actor = await authorized(ctx);
  if (!actor) return;
  const reason = isObj(ctx.body) && typeof ctx.body.reason === "string" ? ctx.body.reason : "";
  const ignored = await ctx.deps.identityLinking!.ignore(
    ctx.params.sourceId ?? "",
    ctx.params.externalSubjectId ?? "",
    actor.id,
    reason,
  );
  return sendJson(ctx.res, ignored ? 200 : 409, { status: ignored ? "ignored" : "conflict" });
}

async function unignoreMember(ctx: ApiCtx): Promise<void> {
  const actor = await authorized(ctx);
  if (!actor) return;
  const removed = await ctx.deps.identityLinking!.unignore(
    ctx.params.sourceId ?? "",
    ctx.params.externalSubjectId ?? "",
    actor.id,
  );
  return sendJson(ctx.res, removed ? 200 : 409, { status: removed ? "unmatched" : "conflict" });
}

export const directorySourceAdminRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/admin/org/directory-sources/catalog", auth: "either", handle: catalog },
  {
    method: "GET",
    path: "/v1/admin/org/directory-sources/migration-preview",
    auth: "either",
    handle: migrationPreview,
  },
  { method: "GET", path: "/v1/admin/org/directory-sources", auth: "either", handle: listSources },
  { method: "POST", path: "/v1/admin/org/directory-sources", auth: "either", handle: createSource },
  { method: "GET", path: "/v1/admin/org/directory-sources/:sourceId", auth: "either", handle: getSource },
  { method: "PATCH", path: "/v1/admin/org/directory-sources/:sourceId", auth: "either", handle: patchSource },
  { method: "DELETE", path: "/v1/admin/org/directory-sources/:sourceId", auth: "either", handle: deleteSource },
  { method: "GET", path: "/v1/admin/org/directory-sources/:sourceId/impact", auth: "either", handle: sourceImpact },
  { method: "POST", path: "/v1/admin/org/directory-sources/:sourceId/pause", auth: "either", handle: pauseSource },
  { method: "POST", path: "/v1/admin/org/directory-sources/:sourceId/restore", auth: "either", handle: restoreSource },
  { method: "POST", path: "/v1/admin/org/directory-sources/:sourceId/test", auth: "either", handle: testSource },
  {
    method: "POST",
    path: "/v1/admin/org/directory-sources/:sourceId/reconcile",
    auth: "either",
    handle: reconcileSource,
  },
  {
    method: "POST",
    path: "/v1/admin/org/directory-sources/:sourceId/managed-preview",
    auth: "either",
    handle: managedPreview,
  },
  {
    method: "POST",
    path: "/v1/admin/org/directory-sources/:sourceId/managed-unit-mapping",
    auth: "either",
    handle: decideManagedUnitMapping,
  },
  {
    method: "POST",
    path: "/v1/admin/org/directory-sources/:sourceId/managed-commit",
    auth: "either",
    handle: commitManagedPreview,
  },
  {
    method: "POST",
    path: "/v1/admin/org/directory-sources/:sourceId/sync-preview",
    auth: "either",
    handle: (ctx) => requestSync(ctx, true),
  },
  {
    method: "POST",
    path: "/v1/admin/org/directory-sources/:sourceId/sync",
    auth: "either",
    handle: (ctx) => requestSync(ctx, false),
  },
  { method: "GET", path: "/v1/admin/org/directory-sources/:sourceId/runs", auth: "either", handle: listRuns },
  {
    method: "GET",
    path: "/v1/admin/org/directory-sources/:sourceId/runs/:runId",
    auth: "either",
    handle: getRun,
  },
  { method: "GET", path: "/v1/admin/org/directory-sources/:sourceId/members", auth: "either", handle: listMembers },
  {
    method: "GET",
    path: "/v1/admin/org/directory-sources/:sourceId/members/:externalSubjectId",
    auth: "either",
    handle: getMember,
  },
  {
    method: "POST",
    path: "/v1/admin/org/directory-sources/:sourceId/members/:externalSubjectId/refresh",
    auth: "either",
    handle: refreshMember,
  },
  {
    method: "POST",
    path: "/v1/admin/org/directory-sources/:sourceId/members/:externalSubjectId/bind",
    auth: "either",
    handle: (ctx) => bindMember(ctx, false),
  },
  {
    method: "POST",
    path: "/v1/admin/org/directory-sources/:sourceId/members/:externalSubjectId/rebind",
    auth: "either",
    handle: (ctx) => bindMember(ctx, true),
  },
  {
    method: "POST",
    path: "/v1/admin/org/directory-sources/:sourceId/members/:externalSubjectId/ignore",
    auth: "either",
    handle: ignoreMember,
  },
  {
    method: "DELETE",
    path: "/v1/admin/org/directory-sources/:sourceId/members/:externalSubjectId/ignore",
    auth: "either",
    handle: unignoreMember,
  },
];
