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
import { createControlService } from "../src/api/control-service.ts";
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

test("reading a conversation clears delivered task replies but keeps unlinked task notices unread", async () => {
  const store = createNotificationStore(createMemoryMap());
  for (const recipient of ["A", "B"])
    for (const kind of ["cron_success", "cron_failure"] as const) {
      await store.add({ id: `${recipient}:${kind}:reply`, recipient, kind, createdAt: 1, sessionId: "s", entrySeq: 0 });
      await store.add({ id: `${recipient}:${kind}:notice`, recipient, kind, createdAt: 1, sessionId: "s" });
    }
  assert.equal(await store.markSessionMessagesRead("A", "s", 0), 2);
  assert.ok(
    (await store.list("A")).filter((record) => record.entrySeq !== undefined).every((record) => record.readAt === 0),
  );
  assert.ok(
    (await store.list("A"))
      .filter((record) => record.entrySeq === undefined)
      .every((record) => record.readAt === undefined),
  );
  assert.ok((await store.list("B")).every((record) => record.readAt === undefined));
});

test("notification status filters paginate beyond 200 and preserve read history and recipients", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "qm-unread-")), orgId: "acme" }));
  for (let i = 0; i < 201; i++)
    await built.notifications.add({
      id: `read:${i}`,
      recipient: "owner",
      kind: "action",
      createdAt: i + 10,
      readAt: 0,
    });
  await built.notifications.add({ id: "old:unread", recipient: "owner", kind: "action", createdAt: 1 });
  await built.notifications.add({ id: "message", recipient: "owner", kind: "message", createdAt: 2 });
  await built.notifications.add({ id: "other:unread", recipient: "other", kind: "mention", createdAt: 3 });
  const server = createInsecureTestServer(built.app, { notifications: built.notifications });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const list = async (query: string) => {
    const response = await fetch(`${base}/v1/notifications?${query}`);
    assert.equal(response.status, 200);
    return (await response.json()) as {
      notifications: Array<{ id: string; readAt: number | null }>;
      unread: number;
      read: number;
      total: number;
      kindCounts: Record<string, number>;
      page: number;
      pages: number;
    };
  };
  try {
    const all = await list("principalId=owner");
    assert.equal(all.notifications.length, 20);
    assert.ok(all.notifications.every((item) => item.readAt === 0));
    assert.equal(all.unread, 1);
    assert.equal(all.read, 201);
    assert.equal(all.total, 202);
    const ids = all.notifications.map((item) => item.id);
    assert.equal(all.pages, 11);
    for (let number = 2; number <= all.pages; number++) {
      const result = await list(`principalId=owner&page=${number}`);
      assert.equal(result.page, number);
      ids.push(...result.notifications.map((item) => item.id));
    }
    assert.equal((await list("principalId=owner&page=999")).page, 11);
    assert.equal(ids.length, 202);
    assert.equal(new Set(ids).size, 202);
    assert.equal(ids.at(-1), "old:unread");
    const unread = await list("principalId=owner&status=unread&kind=action");
    assert.deepEqual(
      unread.notifications.map((item) => item.id),
      ["old:unread"],
    );
    assert.deepEqual(unread.kindCounts, { action: 1 });
    assert.equal(unread.pages, 1);
    assert.deepEqual(
      (await list("principalId=other&status=unread")).notifications.map((item) => item.id),
      ["other:unread"],
    );
    assert.equal((await list("principalId=owner&status=read")).total, 201);
    const marked = await fetch(`${base}/v1/notifications/old%3Aunread/read?principalId=owner`, { method: "POST" });
    assert.equal(marked.status, 200);
    assert.deepEqual((await list("principalId=owner&status=unread")).notifications, []);
    assert.equal((await list("principalId=owner&status=read&kind=action")).total, 202);
    for (const query of [
      "limit=0",
      "limit=101",
      "limit=1.5",
      "status=invalid",
      "kind=message",
      "page=0",
      "page=-1",
      "page=1.5",
      "page=invalid",
      "page=9007199254740992",
    ])
      assert.equal((await fetch(`${base}/v1/notifications?principalId=owner&${query}`)).status, 400, query);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("notification pages order tied timestamps and clamp after read-state changes", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "qm-notice-page-")), orgId: "acme" }));
  for (const id of ["z", "m", "a"])
    await built.notifications.add({ id, recipient: "owner", kind: "mention", createdAt: 10 });
  const server = createInsecureTestServer(built.app, { notifications: built.notifications });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const list = async (page = 1) => {
    const response = await fetch(`${base}/v1/notifications?principalId=owner&status=unread&limit=2&page=${page}`);
    assert.equal(response.status, 200);
    return (await response.json()) as { notifications: Array<{ id: string }>; page: number; pages: number };
  };
  try {
    const first = await list();
    assert.deepEqual(
      first.notifications.map((item) => item.id),
      ["z", "m"],
    );
    const second = await list(2);
    assert.deepEqual(
      second.notifications.map((item) => item.id),
      ["a"],
    );
    assert.equal(second.page, 2);
    await built.notifications.markRead("owner", "m", 11);
    const clamped = await list(2);
    assert.equal(clamped.page, 1);
    assert.deepEqual(
      clamped.notifications.map((item) => item.id),
      ["z", "a"],
    );
    await built.notifications.add({ id: "new", recipient: "owner", kind: "mention", createdAt: 11 });
    const refreshed = await list();
    assert.deepEqual(
      refreshed.notifications.map((item) => item.id),
      ["new", "z"],
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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
  const created = await createControlService(built.app, built.scheduler, built.admin).createCron(
    { schedule: { everyMs: 3_600_000 }, action: "Report", scope: "personal" },
    {
      actorId: "owner",
      scopeId: "personal:owner",
      exp: Date.now() + 60_000,
      destination: { type: "web", target: threadRef, audienceScopeId: "personal:owner" },
    },
  );
  assert.ok(created.ok, JSON.stringify(created));
  const cron = created.cron;
  assert.equal(cron.destination?.type, "web");
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
    destination: cron.destination!,
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
      conversationUnread: Record<string, { messages: number; mentions: number }>;
    };
    assert.deepEqual(notices.conversationUnread[turned.sessionId!], { messages: 1, mentions: 0 });
    const failedNotice = notices.notifications.find((notice) => notice.fireKey === failedFireKey);
    assert.equal(failedNotice?.sessionId, turned.sessionId);
    assert.equal(failedNotice?.entrySeq, undefined);
    assert.equal(failedNotice?.cronId, cron.id);
    const read = await fetch(`${base}/v1/notifications/sessions/${turned.sessionId}/read?principalId=owner`, {
      method: "POST",
    });
    assert.equal(read.status, 200);
    assert.equal(((await read.json()) as { marked: number }).marked, 1);
    const after = (await fetch(`${base}/v1/notifications?principalId=owner`).then((response) => response.json())) as {
      conversationUnread: Record<string, { messages: number; mentions: number }>;
    };
    assert.deepEqual(after.conversationUnread, {});
    assert.equal(
      (await built.notifications.list("owner")).find((record) => record.fireKey === failedFireKey)?.readAt,
      undefined,
    );
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
    text: "@member，Hello <@member|周明>，请查收。",
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
    assert.deepEqual(ordinary.conversationUnread[turned.sessionId], { messages: 2, mentions: 0 });
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
    assert.deepEqual(before.conversationUnread[turned.sessionId], { messages: 2, mentions: 1 });
    const mention = before.notifications.find((item) => item.summary?.includes("Hello"));
    assert.ok(mention);
    assert.equal(mention.summary, "@member，Hello @周明，请查收。");
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
    assert.equal(((await marked.json()) as { marked: number }).marked, 2);
    assert.ok((await built.notifications.list("member")).find((record) => record.id === mention.id)?.readAt);
    assert.ok((await built.notifications.list("member")).find((record) => record.id === resultNotice?.id)?.readAt);

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

test("project notifications match a handwritten username in the original message, not the model envelope", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "qm-mention-envelope-")), orgId: "acme" }));
  await built.app.upsertDirectory([
    { principalId: "owner", displayName: "Owner", type: "internal" },
    { principalId: "qa-member", displayName: "QA Member", type: "internal" },
  ]);
  const project = await built.app.createProject("owner", "Mention envelope");
  assert.ok(project);
  assert.equal((await built.app.addProjectMember(project.id, "owner", "qa-member")).status, "ok");
  const turned = await built.app.turn({
    surface: "web",
    actor: { externalId: "owner" },
    conversation: {
      kind: "group",
      channelRef: projectGroupRef(project.id),
      threadRef: "web:owner:envelope",
      audience: [],
    },
    text: "@qa-member",
  });
  assert.equal(turned.status, "ok");
  for (let attempt = 0; attempt < 50 && !(await built.notifications.list("qa-member")).length; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await built.notifications.list("qa-member"))[0]?.kind, "mention");
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
  assert.equal(mentionsPerson("@qa-member", { principalId: "qa-member", displayName: "QA Member" }), true);
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
