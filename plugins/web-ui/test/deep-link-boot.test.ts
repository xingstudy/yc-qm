import assert from "node:assert/strict";
import test from "node:test";
import { harness, SESSION, type Harness } from "./deep-link-boot-fixture.ts";

test("concurrent safe boots share one page initialization", async () => {
  const h = await harness({ path: "/files" });
  try {
    const boots = [h.bootSafely(), h.bootSafely()];
    h.releaseSessions();
    await Promise.all(boots);
    assert.equal(h.requests.filter((path) => path === "/api/ui-state?key=split-canvas").length, 1);
    assert.equal(h.requests.filter((path) => path === "/me").length, 1);
  } finally {
    await h.close();
  }
});

test("a later safe boot can reinitialize after the first one settles", async () => {
  const h = await harness({ path: "/files" });
  try {
    const first = h.bootSafely();
    h.releaseSessions();
    await first;
    await h.bootSafely();
    assert.equal(h.requests.filter((path) => path === "/me").length, 2);
  } finally {
    await h.close();
  }
});

test("a share link paints its conversation from the transcript, without waiting for the session list", async () => {
  const h = await harness({ path: "/s/sess-deep" });
  try {
    await h.boot();
    assert.equal(h.sessionsState.loaded, false, "the sidebar list must still be in flight");
    assert.equal(h.visibleConversation().state.sessionId, SESSION.id, "the linked chat is already mounted");
    assert.deepEqual(
      h.sessionsState.list.map((s) => s.id),
      [SESSION.id],
      "the row the transcript carried seeds the list, so the header has its title",
    );
    assert.match(h.mainText(), /Deep linked chat/);
    assert.equal(
      h.requests.filter((p) => p === "/api/sessions").length,
      1,
      "boot must not stampede the expensive list route",
    );
    assert.equal(
      h.requests.filter((p) => p === `/api/sessions/${SESSION.id}?tailTurns=25`).length,
      1,
      "the pane reuses the prefetched transcript",
    );
    const transcript = h.requests.indexOf(`/api/sessions/${SESSION.id}?tailTurns=25`);
    assert.ok(transcript >= 0, "the transcript is fetched with the tail window");
    assert.ok(transcript < h.requests.indexOf("/me"), "and is in flight before /me is even asked");
    const approvals = h.requests.indexOf(`/api/sessions/${SESSION.id}/approvals`);
    assert.ok(approvals >= 0, "the pending approvals the mount needs are fetched too");
    assert.ok(approvals < h.requests.indexOf("/me"), "…in the same first round trip, not a serial one after it");
    assert.ok(
      h.requests.indexOf("/api/runtime-config") < h.requests.indexOf("/me"),
      "runtime-config rides the same round trip rather than queueing behind /me",
    );
  } finally {
    await h.close();
  }
});

test("a share link whose transcript 404s falls back to the session list", async () => {
  const h = await harness({ path: "/s/sess-deep", transcriptStatus: 404 });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    assert.equal(h.sessionsState.loaded, true, "the fallback waits for the list");
    assert.equal(h.visibleConversation().state.sessionId, null, "no conversation is mounted");
    assert.match(h.mainText(), /Conversation not found/);
    assert.match(h.mainText(), /404/);
    assert.match(h.mainText(), /Back to chats/);
    assert.equal(location.pathname, "/s/sess-deep");
    assert.equal(document.querySelector("textarea"), null);
    assert.equal(document.activeElement?.id, "conversation-error-title");
  } finally {
    await h.close();
  }
});

test("a share link whose transcript fetch flakes still opens from the session list", async () => {
  const h = await harness({
    path: "/s/sess-deep",
    transcriptStatus: 503,
    transcriptFailures: 1,
    listSessions: [SESSION],
  });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    assert.equal(h.visibleConversation().state.sessionId, SESSION.id);
  } finally {
    await h.close();
  }
});

test("a session list that wins the race keeps its own decorated rows", async () => {
  const listed = { ...SESSION, working: true };
  const other = { id: "sess-other", threadRef: "web:tester:other", scopeId: "personal:tester", title: "Other" };
  const h = await harness({ path: "/s/sess-deep", holdTranscript: true, listSessions: [other, listed] });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await h.sessionsReady();
    h.releaseTranscript();
    await booted;
    assert.deepEqual(
      h.sessionsState.list.map((s) => s.id),
      [other.id, SESSION.id],
      "the list the server sent keeps its order — the transcript's copy must not jump the queue",
    );
    assert.equal(
      (h.sessionsState.list.find((s) => s.id === SESSION.id) as { working?: boolean }).working,
      true,
      "…nor strip the decorations only the list route computes",
    );
    assert.equal(h.visibleConversation().state.sessionId, SESSION.id);
  } finally {
    await h.close();
  }
});

test("a list that omits the open conversation does not drop its row", async () => {
  const other = { id: "sess-other", threadRef: "web:tester:other", scopeId: "personal:tester", title: "Other" };
  const h = await harness({ path: "/s/sess-deep", listSessions: [other] });
  try {
    await h.boot();
    h.releaseSessions();
    await h.sessionsReady();
    assert.equal(h.visibleConversation().state.sessionId, SESSION.id);
    assert.ok(
      h.sessionsState.list.some((s) => s.id === SESSION.id),
      "the conversation the user is reading must keep its sidebar row",
    );
  } finally {
    await h.close();
  }
});

test("a list landing mid-open still keeps the row of the conversation being opened", async () => {
  const other = { id: "sess-other", threadRef: "web:tester:other", scopeId: "personal:tester", title: "Other" };
  const h = await harness({ path: "/s/sess-deep", holdApprovals: true, listSessions: [other] });
  try {
    const booted = h.boot();
    while (!h.sessionsState.openingKey) await new Promise((resolve) => setTimeout(resolve, 0));
    h.releaseSessions();
    await h.sessionsReady();
    h.releaseApprovals();
    await booted;
    assert.ok(
      h.sessionsState.list.some((s) => s.id === SESSION.id),
      "the row must survive a refresh that lands between the open starting and the mount finishing",
    );
  } finally {
    await h.close();
  }
});

test("a bare entry still mints a new chat once the list lands", async () => {
  const h = await harness({ path: "/" });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    assert.equal(h.sessionsState.loaded, true);
    assert.equal(h.appState.currentView, "chats");
    assert.equal(h.visibleConversation().state.sessionId, null);
    assert.ok(h.visibleConversation().state.threadRef, "a fresh chat is mounted");
  } finally {
    await h.close();
  }
});

test("a bare entry resumes the last conversation instead of creating another", async () => {
  const newer = { ...SESSION, id: "sess-newer", threadRef: "web:tester:newer", lastActivityAt: 2 };
  const h = await harness({ path: "/", listSessions: [newer, SESSION], lastChatId: SESSION.id });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    assert.equal(h.visibleConversation().state.sessionId, SESSION.id);
    assert.equal(location.pathname, `/s/${SESSION.id}`);
  } finally {
    await h.close();
  }
});

test("a bare entry opens the newest web conversation when no last conversation was saved", async () => {
  const h = await harness({ path: "/", listSessions: [SESSION] });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    assert.equal(h.visibleConversation().state.sessionId, SESSION.id);
  } finally {
    await h.close();
  }
});

test("a view deep link still waits for the list and never fetches a transcript", async () => {
  const h = await harness({ path: "/crons" });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    assert.equal(h.appState.currentView, "crons");
    assert.equal(h.sessionsState.loaded, true);
    assert.equal(h.requests.filter((p) => p.startsWith(`/api/sessions/${SESSION.id}`)).length, 0);
    for (let i = 0; i < 20 && !document.querySelector(".crons-page .list-page-action"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const create = document.querySelector<HTMLButtonElement>(".crons-page .list-page-action");
    assert.ok(create);
    assert.equal(create.textContent?.trim(), "New cron");
    create.click();
    assert.match(h.mainText(), /Ask the agent to set it up/);
  } finally {
    await h.close();
  }
});

test("new cron setup continues in the selected existing conversation", async () => {
  const h = await harness({
    path: "/crons",
    listSessions: [{ ...SESSION, type: "dm", createdAt: Date.now() }],
  });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    const create = document.querySelector<HTMLButtonElement>(".crons-page .list-page-action");
    assert.ok(create);
    create.click();
    const form = document.querySelector<HTMLFormElement>(".cron-form");
    const target = form?.querySelector<HTMLSelectElement>('select[name="sessionId"]');
    const description = form?.querySelector<HTMLTextAreaElement>('textarea[name="text"]');
    assert.ok(form && target && description);
    assert.ok([...target.options].some((option) => option.value === SESSION.id));
    target.value = SESSION.id;
    description.value = "Every morning, summarize my inbox";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 20 && h.visibleConversation().state.sessionId !== SESSION.id; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.visibleConversation().state.sessionId, SESSION.id);
  } finally {
    await h.close();
  }
});

test("notifications deep link renders localized unread items without clearing them", async () => {
  const h = await harness({
    path: "/notifications",
    locale: "zh-CN",
    notifications: [
      {
        id: "mention:1",
        kind: "mention",
        createdAt: Date.now(),
        readAt: null,
        source: "Shared project",
        summary: "Hello @tester",
        sessionId: SESSION.id,
        entrySeq: 3,
      },
    ],
  });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    for (let i = 0; i < 20 && !h.mainText().includes("Shared project"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(h.appState.currentView, "notifications");
    assert.match(h.mainText(), /提及我/);
    assert.match(h.mainText(), /Shared project/);
    assert.doesNotMatch(h.mainText(), /选择一个对话/);
    assert.equal(document.querySelectorAll(".notification-row.unread").length, 1);
    assert.equal(document.querySelectorAll(".notification-filter-chip").length, 5);
    const card = document.querySelector<HTMLAnchorElement>(".notification-row .notification-content");
    assert.ok(card?.href.includes(SESSION.id));
    assert.ok(card?.textContent?.includes("Shared project"));
    const completed = [...document.querySelectorAll<HTMLButtonElement>(".notification-filter-chip")].find((button) =>
      button.textContent?.includes("任务完成"),
    );
    completed?.click();
    assert.match(h.mainText(), /暂无此类通知/);
    assert.equal(document.querySelectorAll(".notification-row").length, 0);
    assert.equal(h.requests.filter((path) => path.includes("/read")).length, 0);
  } finally {
    await h.close();
  }
});

test("a scheduled result notification offers its conversation and run detail", async () => {
  const fireKey = "cron:cron-test:run-1";
  const h = await harness({
    path: "/notifications",
    locale: "zh-CN",
    notifications: [
      {
        id: "cron-result:1",
        kind: "cron_success",
        createdAt: Date.now(),
        readAt: null,
        source: "Morning report",
        summary: "Done",
        sessionId: SESSION.id,
        entrySeq: 7,
        cronId: "cron-test",
        fireKey,
      },
      {
        id: "cron-failure:1",
        kind: "cron_failure",
        createdAt: Date.now() - 1,
        readAt: null,
        source: "Morning report",
        cronId: "cron-test",
        fireKey: "cron:cron-test:run-2",
      },
    ],
  });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    const result = document.querySelector<HTMLElement>(".notification-row.cron_success");
    const chat = result?.querySelector<HTMLAnchorElement>(".notification-content");
    const detail = result?.querySelector<HTMLAnchorElement>(".notification-detail-link");
    assert.ok(chat?.href.includes(`${SESSION.id}?entry=7`));
    assert.ok(detail?.href.includes(`/crons/cron-test?run=${encodeURIComponent(fireKey)}`));
    assert.match(result?.textContent ?? "", /查看对话/);
    assert.match(result?.textContent ?? "", /任务详情/);
    const failure = document.querySelector<HTMLElement>(".notification-row.cron_failure");
    assert.ok(
      failure?.querySelector<HTMLAnchorElement>(".notification-content")?.href.includes("/crons/cron-test?run="),
    );
    assert.equal(failure?.querySelector(".notification-detail-link"), null);
  } finally {
    await h.close();
  }
});

test("a notification run link opens the styled cron detail and keeps its run target", async () => {
  const fireKey = "cron:cron-test:123";
  const h = await harness({
    path: `/crons/cron-test?run=${encodeURIComponent(fireKey)}`,
    locale: "zh-CN",
    crons: [
      {
        id: "cron-test",
        ownerScopeId: "personal:tester",
        owner: "tester",
        title: "Morning report",
        action: "Summarize the day",
        destination: { type: "web", target: SESSION.threadRef },
        schedule: { everyMs: 86400000, firstFireAt: 123 },
        enabled: true,
        createdAt: 123,
      },
    ],
    listSessions: [SESSION],
    cronRuns: [
      {
        fireKey,
        threadRef: "test:run",
        firedAt: 123,
        status: "completed",
        reply: "Done",
        sessionId: "run-worklog",
        resultSessionId: SESSION.id,
        resultEntrySeq: 7,
      },
    ],
  });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    for (let i = 0; i < 20 && !document.querySelector(".cron-run-row.notification-target"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(h.appState.currentView, "crons");
    assert.ok(document.querySelector(".cron-detail-page .cron-detail-card"));
    assert.match(h.mainText(), /计划与投递/);
    const original = document.querySelector<HTMLAnchorElement>(".cron-detail-fields a[href*='/s/']");
    assert.ok(original?.href.includes(SESSION.id));
    assert.match(original?.textContent ?? "", /打开原对话/);
    assert.equal(document.querySelector(".cron-run-row.notification-target")?.getAttribute("data-fire-key"), fireKey);
    const resultLink = document.querySelector<HTMLAnchorElement>(".cron-run-row.notification-target .cron-run-link");
    assert.ok(resultLink?.href.includes(`${SESSION.id}?entry=7`));
    assert.match(resultLink?.textContent ?? "", /在原对话查看结果/);
    const worklog = document.querySelector<HTMLAnchorElement>(".cron-run-row.notification-target .cron-run-worklog");
    assert.ok(worklog?.href.includes("run-worklog"));
    assert.equal(location.search, `?run=${encodeURIComponent(fireKey)}`);
  } finally {
    await h.close();
  }
});

test("a task without a conversation explains where results remain and does not create a chat for editing", async () => {
  const h = await harness({
    path: "/crons/cron-alone",
    locale: "zh-CN",
    crons: [
      {
        id: "cron-alone",
        ownerScopeId: "personal:tester",
        owner: "tester",
        title: "Independent task",
        action: "Summarize the day",
        schedule: { everyMs: 86400000 },
        enabled: true,
        createdAt: 123,
      },
    ],
  });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    for (let i = 0; i < 20 && !document.querySelector(".cron-detail-fields"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.match(h.mainText(), /未关联对话，结果可在运行记录中查看/);
    document.querySelector<HTMLButtonElement>(".cron-detail-actions button")?.click();
    assert.ok(document.querySelector(".cron-edit-dialog"));
    assert.equal(
      [...document.querySelectorAll(".cron-edit-dialog button")].some((button) =>
        button.textContent?.includes("与智能体一起编辑行为"),
      ),
      false,
    );
    assert.equal(h.visibleConversation().state.sessionId, null);
  } finally {
    await h.close();
  }
});

test("a server failure shows a retry page rather than a missing conversation", async () => {
  const h = await harness({ path: "/s/sess-deep", transcriptStatus: 503 });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    assert.match(h.mainText(), /Couldn't load conversation/);
    assert.match(h.mainText(), /Try again/);
    assert.doesNotMatch(h.mainText(), /404/);
    assert.equal(location.pathname, "/s/sess-deep");
  } finally {
    await h.close();
  }
});

test("a missing share link keeps its error page instead of restoring the saved canvas", async () => {
  const h = await harness({ path: "/s/sess-deep", transcriptStatus: 404, savedCanvas: true });
  try {
    const booted = h.boot();
    h.releaseSessions();
    await booted;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(h.mainText(), /Conversation not found/);
    assert.equal(location.pathname, "/s/sess-deep");
    assert.equal(document.querySelector(".dockview-theme-light"), null);
    assert.equal(document.querySelector("textarea"), null);
  } finally {
    await h.close();
  }
});

async function waitForText(h: Harness, text: RegExp): Promise<void> {
  for (let i = 0; i < 100 && !text.test(h.mainText()); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.match(h.mainText(), text);
}

test("saved empty welcome stays an empty chat and doesn't show another starter heading", async () => {
  const h = await harness({ path: "/s/sess-deep", welcome: true });
  try {
    await h.boot();
    await waitForText(h, /Connect your apps/);
    assert.ok(document.querySelector(".empty-chat qm-onboarding-welcome"));
    assert.equal(document.querySelector(".chat-cta"), null);
  } finally {
    await h.close();
  }
});

test("a failed connection refresh removes previously verified badges", async () => {
  const h = await harness({ path: "/s/sess-deep", welcome: true });
  try {
    h.setConnections([{ id: "ca_test", toolkit: "gmail" }]);
    await h.boot();
    await waitForText(h, /Gmail connected/);
    h.setConnections([], 503);
    window.dispatchEvent(new Event("focus"));
    await waitForText(h, /Could not check connected apps/);
    assert.doesNotMatch(h.mainText(), /Gmail connected/);
  } finally {
    await h.close();
  }
});
