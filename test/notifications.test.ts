import "./support/auto-fake-sprites.ts";

import { encodeMentions, mentionText, mentionsPerson } from "../plugins/chassis/src/mentions.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createDeliveryStore, deliveryStatusForRun } from "../src/delivery/delivery-store.ts";
import { createNotificationStore } from "../src/notifications/notification-store.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { projectGroupRef } from "../src/projects/project-store.ts";
import { buildApp } from "./support/test-app.ts";
import { testConfig } from "./support/test-config.ts";

test("notification store deduplicates per recipient and keeps read state isolated", async () => {
  const store = createNotificationStore(createMemoryMap());
  const event = { kind: "mention" as const, createdAt: 1, sessionId: "s", entrySeq: 2 };
  await store.add({ ...event, id: "one", recipient: "A" });
  await store.add({ ...event, id: "one", recipient: "A" });
  await store.add({ ...event, id: "two", recipient: "B" });
  assert.equal((await store.list("A")).length, 1);
  assert.equal(await store.markRead("B", "one", 3), false);
  assert.equal(await store.markRead("A", "one", 3), true);
  assert.equal((await store.list("A"))[0]?.readAt, 3);
  assert.equal((await store.list("B"))[0]?.readAt, undefined);
  await store.add({ ...event, id: "three", recipient: "A", kind: "message" });
  await store.add({ ...event, id: "four", recipient: "A", kind: "action" });
  assert.equal(await store.markSessionMessagesRead("A", "s", 4), 1);
  assert.equal((await store.list("A")).find((record) => record.id === "three")?.readAt, 4);
  assert.equal((await store.list("A")).find((record) => record.id === "four")?.readAt, undefined);
  assert.equal((await store.list("B"))[0]?.readAt, undefined);
  assert.equal(await store.markAllRead("A", 5), 1);
  assert.equal((await store.list("A")).find((record) => record.id === "four")?.readAt, 5);
  await store.add({ ...event, id: "five", recipient: "A", kind: "message" });
  assert.equal(await store.markAllRead("A", 6), 0);
  assert.equal((await store.list("A")).find((record) => record.id === "five")?.readAt, undefined);
});

test("delivery status is separate from the completed run status", async () => {
  const deliveries = createDeliveryStore();
  const run = { fireKey: "cron:task:manual:one", threadRef: "cron:task:fire:one", firedAt: 1, status: "ok" as const };
  const delivery = await deliveries.enqueue({
    destination: { type: "web", target: "web:owner:chat" },
    text: "Done",
    idempotencyKey: run.fireKey,
    provenance: {
      trigger: "cron",
      surface: "cron",
      fireKey: run.fireKey,
      sourceScopeId: "personal:owner",
      sourceThreadRef: run.threadRef,
    },
  });
  assert.equal(await deliveryStatusForRun(deliveries, run), "pending");
  await deliveries.ack(delivery.id, Date.now());
  assert.equal(await deliveryStatusForRun(deliveries, run), "delivered");
  const expired = createDeliveryStore({ maxAgeMs: 0 });
  await expired.enqueue({
    destination: { type: "web", target: "web:owner:chat" },
    text: "Done",
    idempotencyKey: run.fireKey,
    provenance: {
      trigger: "cron",
      surface: "cron",
      fireKey: run.fireKey,
      sourceScopeId: "personal:owner",
      sourceThreadRef: run.threadRef,
    },
  });
  await expired.claimPending("web", 1);
  assert.equal(await deliveryStatusForRun(expired, run), "failed");
  assert.equal(run.status, "ok");
});

test("scheduled web result links the owner's notification to the original chat", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "qm-notifications-")), orgId: "acme" }));
  const threadRef = "web:owner:scheduled-results";
  const turned = await built.app.turn({
    surface: "web",
    actor: { externalId: "owner" },
    conversation: { kind: "dm", threadRef },
    text: "Set up a report",
  });
  assert.equal(turned.status, "ok");
  const cron = await built.crons.create({
    schedule: { everyMs: 3_600_000 },
    action: "Report",
    owner: "owner",
    createdBy: "owner",
    ownerScopeId: "personal:owner",
    destination: { type: "web", target: threadRef },
  });
  const fireKey = `cron:${cron.id}:manual:personal`;
  const runThreadRef = `cron:${cron.id}:fire:personal`;
  await built.crons.recordFire(cron.id, {
    fireKey,
    threadRef: runThreadRef,
    firedAt: Date.now(),
    status: "ok",
    sessionId: "run-worklog",
  });
  await built.deliveries.enqueue({
    destination: { type: "web", target: threadRef },
    text: "Report is ready",
    idempotencyKey: fireKey,
    provenance: {
      trigger: "cron",
      surface: "cron",
      fireKey,
      sourceScopeId: "personal:owner",
      sourceThreadRef: runThreadRef,
    },
  });
  await built.deliveries.pending("web");
  for (let attempt = 0; attempt < 50 && !(await built.notifications.list("owner")).length; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const result = (await built.notifications.list("owner"))[0];
  assert.equal(result?.kind, "cron_success");
  assert.equal(result?.sessionId, turned.sessionId);
  assert.equal(typeof result?.entrySeq, "number");
  const failedFireKey = `cron:${cron.id}:manual:failed`;
  await built.crons.recordFire(cron.id, {
    fireKey: failedFireKey,
    threadRef: `cron:${cron.id}:fire:failed`,
    firedAt: Date.now(),
    status: "failed",
    note: "Unable to finish",
  });
  await built.notifications.add({
    id: `cron:${cron.id}:${failedFireKey}:owner`,
    recipient: "owner",
    kind: "cron_failure",
    createdAt: Date.now(),
    cronId: cron.id,
    fireKey: failedFireKey,
  });
  const server = createInsecureTestServer(built.app, {
    notifications: built.notifications,
    sessions: built.sessions,
    deliveries: built.deliveries,
  });
  server.listen(0);
  try {
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${base}/v1/crons/${cron.id}/runs?principalId=owner`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      runs: Array<{ fireKey: string; sessionId?: string; resultSessionId?: string; resultEntrySeq?: number }>;
    };
    const successfulRun = body.runs.find((entry) => entry.fireKey === fireKey);
    assert.equal(successfulRun?.sessionId, "run-worklog");
    assert.equal(successfulRun?.resultSessionId, turned.sessionId);
    assert.equal(successfulRun?.resultEntrySeq, result?.entrySeq);
    const notices = (await fetch(`${base}/v1/notifications?principalId=owner`).then((response) => response.json())) as {
      notifications: Array<{ fireKey?: string; sessionId?: string; entrySeq?: number; cronId?: string }>;
    };
    const failedNotice = notices.notifications.find((notice) => notice.fireKey === failedFireKey);
    assert.equal(failedNotice?.sessionId, turned.sessionId);
    assert.equal(failedNotice?.entrySeq, undefined);
    assert.equal(failedNotice?.cronId, cron.id);
    assert.equal((await fetch(`${base}/v1/crons/${cron.id}/runs?principalId=other`)).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("project mention notifications are scoped to current recipients and hide content after revocation", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "qm-notifications-")), orgId: "acme" }));
  await built.app.upsertDirectory([
    { principalId: "owner", displayName: "Owner", type: "internal" },
    { principalId: "member", displayName: "周明", type: "internal" },
    { principalId: "other", displayName: "Other", type: "internal" },
  ]);
  const project = await built.app.createProject("owner", "Shared chat");
  assert.ok(project);
  assert.equal((await built.app.addProjectMember(project.id, "owner", "member")).status, "ok");
  assert.equal((await built.app.addProjectMember(project.id, "owner", "other")).status, "ok");
  const turned = await built.app.turn({
    surface: "web",
    actor: { externalId: "owner" },
    conversation: {
      kind: "group",
      channelRef: projectGroupRef(project.id),
      threadRef: "web:owner:mention",
      audience: [],
    },
    text: "Hello <@member|周明>，请查收。",
  });
  assert.equal(turned.status, "ok");
  assert.ok(turned.sessionId);
  for (let attempt = 0; attempt < 50 && !(await built.notifications.list("member")).length; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await built.notifications.list("member"))[0]?.kind, "mention");
  assert.equal((await built.notifications.list("other"))[0]?.kind, "message");
  assert.deepEqual(await built.notifications.list("owner"), []);

  const fireKey = "cron:example:manual:one";
  await built.deliveries.enqueue({
    destination: { type: "web", target: "web:owner:mention" },
    text: "Scheduled result",
    idempotencyKey: fireKey,
    provenance: {
      trigger: "cron",
      surface: "cron",
      fireKey,
      sourceScopeId: project.scopeId,
      sourceThreadRef: "cron:example:fire:one",
    },
  });
  await built.deliveries.pending("web");
  for (let attempt = 0; attempt < 50 && (await built.notifications.list("member")).length < 2; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const resultNotice = (await built.notifications.list("member")).find((record) => record.fireKey === fireKey);
  assert.equal(resultNotice?.kind, "cron_success");
  assert.equal(resultNotice?.sessionId, turned.sessionId);
  assert.equal(typeof resultNotice?.entrySeq, "number");
  await built.deliveries.pending("web");
  assert.equal((await built.notifications.list("member")).filter((record) => record.fireKey === fireKey).length, 1);

  const server = createInsecureTestServer(built.app, {
    notifications: built.notifications,
    sessions: built.sessions,
    deliveries: built.deliveries,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const ordinary = (await fetch(`${base}/v1/notifications?principalId=other`).then((response) =>
      response.json(),
    )) as {
      notifications: unknown[];
      unread: number;
      conversationUnread: Record<string, { messages: number; mentions: number }>;
    };
    assert.equal(ordinary.notifications.length, 1);
    assert.equal((ordinary.notifications[0] as { kind: string }).kind, "cron_success");
    assert.equal(ordinary.unread, 1);
    assert.deepEqual(ordinary.conversationUnread[turned.sessionId], { messages: 1, mentions: 0 });
    const before = (await fetch(`${base}/v1/notifications?principalId=member`).then((response) => response.json())) as {
      notifications: Array<{
        id: string;
        summary?: string;
        sessionId?: string;
        cronId?: string;
        unavailable?: boolean;
      }>;
      unread: number;
      conversationUnread: Record<string, { messages: number; mentions: number }>;
    };
    assert.equal(before.unread, 2);
    assert.deepEqual(before.conversationUnread[turned.sessionId], { messages: 1, mentions: 1 });
    const mention = before.notifications.find((item) => item.summary?.includes("Hello"));
    assert.ok(mention);
    const sharedResult = before.notifications.find((item) => item.summary?.includes("Scheduled result"));
    assert.equal(sharedResult?.sessionId, turned.sessionId);
    assert.equal(sharedResult?.cronId, undefined);
    const denied = await fetch(`${base}/v1/notifications/${encodeURIComponent(mention.id)}/read?principalId=other`, {
      method: "POST",
    });
    assert.equal(denied.status, 404);
    assert.equal((await built.notifications.list("member"))[0]?.readAt, undefined);

    const marked = await fetch(`${base}/v1/notifications/sessions/${turned.sessionId}/read?principalId=member`, {
      method: "POST",
    });
    assert.equal(marked.status, 200);
    assert.equal(((await marked.json()) as { marked: number }).marked, 1);
    assert.ok((await built.notifications.list("member")).find((record) => record.id === mention.id)?.readAt);
    assert.equal(
      (await built.notifications.list("member")).find((record) => record.id === resultNotice?.id)?.readAt,
      undefined,
    );

    assert.equal((await built.app.removeProjectMember(project.id, "owner", "member")).status, "ok");
    const revoked = await fetch(`${base}/v1/notifications/sessions/${turned.sessionId}/read?principalId=member`, {
      method: "POST",
    });
    assert.equal(revoked.status, 404);
    const after = (await fetch(`${base}/v1/notifications?principalId=member`).then((response) => response.json())) as {
      notifications: Array<{ summary?: string; unavailable?: boolean }>;
    };
    assert.ok(after.notifications.every((item) => item.unavailable === true && item.summary === undefined));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("mentions preserve selected identities and recognize Chinese punctuation without matching emails or name prefixes", () => {
  const person = { principalId: "zhou@example.com", displayName: "周明", slackId: "U123" };
  const wire = encodeMentions("请联系 @周明，谢谢。", [person]);
  assert.equal(wire, "请联系 <@zhou@example.com|周明>，谢谢。");
  assert.equal(mentionText(wire), "请联系 @周明，谢谢。");
  assert.equal(encodeMentions(wire, [person]), wire);
  for (const text of [wire, "@周明。", "你好，@周明！", "Hello <@U123>", "<@zhou@example.com>"])
    assert.equal(mentionsPerson(text, person), true, text);
  for (const text of ["name@周明", "@周明明", "<@other|周明>", "<@zhou@example.com.other>"])
    assert.equal(mentionsPerson(text, person), false, text);
  assert.equal(mentionsPerson(wire, { principalId: "same-name", displayName: "周明" }), false);
});

test("project member search accepts one Chinese character and limits mention candidates to accessible project members", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "qm-mention-search-")), orgId: "acme" }));
  await built.app.upsertDirectory([
    { principalId: "owner", displayName: "周负责人", type: "internal" },
    { principalId: "member", displayName: "周明", type: "internal" },
    { principalId: "outsider", displayName: "周外部", type: "internal" },
  ]);
  const project = await built.app.createProject("owner", "Mention search");
  assert.ok(project);
  assert.equal((await built.app.addProjectMember(project.id, "owner", "member")).status, "ok");
  const server = createInsecureTestServer(built.app);
  server.listen(0);
  try {
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    const path = `${base}/v1/projects/${project.id}/member-candidates?q=${encodeURIComponent("周")}`;
    const candidates = await fetch(`${path}&principalId=owner`);
    assert.equal(candidates.status, 200);
    assert.deepEqual(
      ((await candidates.json()) as { matches: { principalId: string }[] }).matches.map((person) => person.principalId),
      ["outsider"],
    );
    const mentions = await fetch(`${path}&principalId=member&membersOnly=true`);
    assert.equal(mentions.status, 200);
    assert.deepEqual(
      new Set(
        ((await mentions.json()) as { matches: { principalId: string }[] }).matches.map((person) => person.principalId),
      ),
      new Set(["owner", "member"]),
    );
    assert.equal((await fetch(`${path}&principalId=outsider&membersOnly=true`)).status, 404);
    assert.equal((await fetch(`${path}&principalId=member`)).status, 404);
    await built.organization.invite({ principalId: "member", email: null, displayName: "周明", actor: "test" });
    await built.organization.setStatus({ principalId: "member", status: "suspended", actor: "test" });
    assert.equal((await fetch(`${path}&principalId=member&membersOnly=true`)).status, 404);
    await built.organization.setStatus({ principalId: "member", status: "active", actor: "test" });
    assert.equal((await built.app.removeProjectMember(project.id, "owner", "member")).status, "ok");
    assert.equal((await fetch(`${path}&principalId=member&membersOnly=true`)).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
