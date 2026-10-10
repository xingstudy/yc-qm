import { mentionText } from "../../../plugins/chassis/src/mentions.ts";
import type { NotificationRecord } from "../../notifications/notification-store.ts";
import { entrySearchText } from "../../sessions/entry-search.ts";
import { deliveryStatusForRun } from "../../delivery/delivery-store.ts";
import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";

function viewerOf(ctx: ApiCtx): string | null {
  const requested = ctx.url.searchParams.get("principalId");
  if (ctx.actor?.p && requested && ctx.actor.p !== requested) return null;
  return ctx.actor?.p ?? requested;
}

async function visibleNotification(ctx: ApiCtx, record: NotificationRecord, allowedCrons: Set<string>) {
  const base = {
    id: record.id,
    kind: record.kind,
    createdAt: record.createdAt,
    readAt: record.readAt ?? null,
    sessionId: record.sessionId,
    entrySeq: record.entrySeq,
    cronId: record.cronId,
    fireKey: record.fireKey,
    approvalId: record.approvalId,
  };
  if (record.sessionId && record.approvalId) {
    const source = await ctx.app.getSessionForViewer(record.sessionId, record.recipient, { tailTurns: 1 });
    if (!source) return { ...base, unavailable: true, sessionId: undefined, approvalId: undefined };
    const approvals = await ctx.app.listSessionApprovals(record.sessionId, record.recipient);
    return {
      ...base,
      source: source.session.title ?? source.session.channelName ?? "Conversation",
      summary: approvals.some((approval) => approval.requestId === record.approvalId)
        ? "Approval or input needed"
        : "Action no longer pending",
    };
  }
  if (record.cronId && record.fireKey && allowedCrons.has(record.cronId)) {
    const cron = await ctx.app.getCron(record.cronId);
    const runs = await ctx.app.listCronFires(record.cronId);
    const run = runs.runs.find((entry) => entry.fireKey === record.fireKey);
    if (cron && run) {
      const deliveryStatus = await deliveryStatusForRun(ctx.deps.deliveries, run);
      const chatVisible =
        record.sessionId && record.entrySeq !== undefined
          ? !!(await ctx.app.getSessionEntryForViewer(record.sessionId, record.recipient, record.entrySeq))
          : false;
      const destinationSession =
        cron.destination?.type === "web" ? await ctx.deps.sessions?.getByThread(cron.destination.target) : null;
      const linkedSessionId =
        destinationSession &&
        (await ctx.app.getSessionForViewer(destinationSession.id, record.recipient, { tailTurns: 1 }))
          ? destinationSession.id
          : undefined;
      return {
        ...base,
        sessionId: chatVisible ? record.sessionId : linkedSessionId,
        entrySeq: chatVisible ? record.entrySeq : undefined,
        source: cron.title ?? "Scheduled task",
        summary:
          cron.destination?.type === "web" && !chatVisible && !linkedSessionId ? undefined : run.note?.slice(0, 120),
        deliveryStatus,
      };
    }
  }
  if (record.sessionId && record.entrySeq !== undefined) {
    const found = await ctx.app.getSessionEntryForViewer(record.sessionId, record.recipient, record.entrySeq);
    const session = found ? await ctx.deps.sessions?.get(record.sessionId) : null;
    if (!found || !session)
      return {
        ...base,
        unavailable: true,
        sessionId: undefined,
        entrySeq: undefined,
        cronId: undefined,
        fireKey: undefined,
      };
    const display = (found.entry.payload as { display?: unknown } | null)?.display;
    const text = typeof display === "string" && display.trim() ? display : entrySearchText(found.entry.payload);
    return {
      ...base,
      cronId: undefined,
      fireKey: undefined,
      source: session.title ?? session.channelName ?? "Project conversation",
      summary: text ? mentionText(text).replace(/\s+/g, " ").slice(0, 120) : "New message",
    };
  }
  return { ...base, unavailable: true, cronId: undefined, fireKey: undefined };
}

async function listNotifications(ctx: ApiCtx): Promise<void> {
  const viewer = viewerOf(ctx);
  if (!viewer || !ctx.deps.notifications) return sendJson(ctx.res, 403, { error: "forbidden" });
  ctx.res.setHeader("Cache-Control", "no-store");
  const records = await ctx.deps.notifications.list(viewer);
  const { owned } = await ctx.app.listCronsForViewer(viewer);
  const allowedCrons = new Set(owned.map((cron) => cron.id));
  const notifications = await Promise.all(
    records
      .filter((record) => record.kind !== "message")
      .slice(0, 200)
      .map((record) => visibleNotification(ctx, record, allowedCrons)),
  );
  const unreadSessions = await Promise.all(
    [
      ...new Set(
        records
          .filter((record) => (record.kind === "message" || record.kind === "mention") && record.readAt === undefined)
          .map((record) => record.sessionId),
      ),
    ]
      .filter((id): id is string => !!id)
      .map(async (id) => ((await ctx.app.getSessionForViewer(id, viewer, { tailTurns: 1 })) ? id : null)),
  );
  const visibleSessions = new Set(unreadSessions.filter((id): id is string => !!id));
  const conversationUnread = records
    .filter((record) => record.sessionId && visibleSessions.has(record.sessionId) && record.readAt === undefined)
    .reduce<Record<string, { messages: number; mentions: number }>>((counts, record) => {
      if (record.kind !== "message" && record.kind !== "mention") return counts;
      const current = (counts[record.sessionId!] ??= { messages: 0, mentions: 0 });
      current.messages++;
      if (record.kind === "mention") current.mentions++;
      return counts;
    }, {});
  return sendJson(ctx.res, 200, {
    notifications,
    unread: records.filter((record) => record.kind !== "message" && record.readAt === undefined).length,
    conversationUnread,
  });
}

async function markRead(ctx: ApiCtx): Promise<void> {
  const viewer = viewerOf(ctx);
  if (!viewer || !ctx.deps.notifications) return sendJson(ctx.res, 403, { error: "forbidden" });
  ctx.res.setHeader("Cache-Control", "no-store");
  const marked = await ctx.deps.notifications.markRead(viewer, ctx.params.id!);
  return sendJson(ctx.res, marked ? 200 : 404, marked ? { ok: true } : { error: "not_found" });
}

async function markAllRead(ctx: ApiCtx): Promise<void> {
  const viewer = viewerOf(ctx);
  if (!viewer || !ctx.deps.notifications) return sendJson(ctx.res, 403, { error: "forbidden" });
  ctx.res.setHeader("Cache-Control", "no-store");
  return sendJson(ctx.res, 200, { marked: await ctx.deps.notifications.markAllRead(viewer) });
}

async function markSessionMessagesRead(ctx: ApiCtx): Promise<void> {
  const viewer = viewerOf(ctx);
  if (!viewer || !ctx.deps.notifications) return sendJson(ctx.res, 403, { error: "forbidden" });
  const sessionId = ctx.params.id!;
  if (!(await ctx.app.getSessionForViewer(sessionId, viewer, { tailTurns: 1 })))
    return sendJson(ctx.res, 404, { error: "not_found" });
  ctx.res.setHeader("Cache-Control", "no-store");
  return sendJson(ctx.res, 200, { marked: await ctx.deps.notifications.markSessionMessagesRead(viewer, sessionId) });
}

export const notificationRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/notifications", auth: "source", handle: listNotifications },
  { method: "POST", path: "/v1/notifications/read-all", auth: "source", handle: markAllRead },
  { method: "POST", path: "/v1/notifications/sessions/:id/read", auth: "source", handle: markSessionMessagesRead },
  { method: "POST", path: "/v1/notifications/:id/read", auth: "source", handle: markRead },
];
