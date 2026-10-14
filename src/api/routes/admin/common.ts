import type { App } from "../../app.ts";
import type { ServerDeps } from "../../deps.ts";
import { parseScopeId, scopeId as makeScopeId, type Principal } from "../../../types.ts";
import { sendJson } from "../../http.ts";
import { orgScope, requireScopedAdmin } from "../shared.ts";
import { type ApiCtx } from "../route.ts";
import { projectScopeId } from "../../../projects/project-store.ts";
import { projectScopeName } from "../../../../plugins/chassis/src/project-label.js";

export async function requireScopedResource<T>(
  ctx: ApiCtx,
  load: () => Promise<T | null | undefined> | T | null | undefined,
  scopeOf: (record: T) => string,
  noun: string,
  scopeMismatch: "forbid" | "fallback" = "forbid",
): Promise<{ actor: Principal; scope: string; record: T } | null> {
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return null;
  const record = await load();
  if (!record) {
    sendJson(ctx.res, 404, { error: "not_found" });
    return null;
  }
  if (parseScopeId(authz.scope).kind !== "org" && scopeOf(record) !== authz.scope) {
    if (scopeMismatch === "forbid") {
      sendJson(ctx.res, 403, { error: "forbidden", message: `${noun} is outside the requested scope` });
      return null;
    }
    return { actor: authz.actor, scope: scopeOf(record), record };
  }
  return { ...authz, record };
}

export const FILES_PAGE_SIZE = 200;

export async function discoverScopes(
  app: App,
  deps: ServerDeps,
  extraScopeIds: Iterable<string> = [],
): Promise<Map<string, string>> {
  const labels = new Map<string, string>([[orgScope(deps), "org-wide"]]);
  for (const s of (await deps.sessions?.distinctScopes()) ?? []) {
    if (!labels.has(s.scopeId) || (s.channelName && !labels.get(s.scopeId))) {
      labels.set(s.scopeId, s.channelName ? (projectScopeName(s.scopeId, s.channelName) ?? `#${s.channelName}`) : "");
    }
  }
  const people = [
    ...((await deps.sessions?.distinctParticipants()) ?? []),
    ...((await deps.admin?.listGrants()) ?? []).map((g) => g.principalId),
  ];
  for (const principalId of people) {
    const personal = makeScopeId("personal", principalId);
    if (!labels.has(personal)) labels.set(personal, "");
  }
  for (const id of extraScopeIds) {
    if (!labels.has(id)) labels.set(id, "");
  }
  for (const project of (await deps.projects?.directory(orgScope(deps).slice(4))) ?? [])
    labels.set(projectScopeId(project.id), project.name);
  for (const [id, label] of labels) {
    const name = projectScopeName(id, label, "名称未知 Project");
    if (name) labels.set(id, name);
  }
  if ([...labels.values()].some((l) => !l)) {
    const membersById = new Map((await app.directoryMembers()).map((m) => [m.principalId, m.displayName]));
    const channelsById = new Map((await app.directoryChannels()).map((c) => [c.channelId, c.name]));
    for (const [id, label] of labels) {
      if (label) continue;
      const { kind, ref } = parseScopeId(id);
      if (kind === "personal" && ref) {
        labels.set(id, membersById.get(ref) ?? "");
      } else if (kind === "channel" && ref) {
        const name = channelsById.get(ref);
        if (name) labels.set(id, `#${name}`);
      }
    }
  }
  return labels;
}
