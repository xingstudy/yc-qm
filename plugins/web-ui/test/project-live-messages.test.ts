import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { metadata } from "./model-metadata.ts";
import type { Conversation } from "../src/conv-types.ts";
import type { SessionEntry } from "../src/core-bridge.ts";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Array<(event: { data: string }) => void>>();
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  emit(name: string, data: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) listener({ data: JSON.stringify(data) });
  }

  close(): void {
    this.listeners.clear();
  }
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not settle");
}

test("an open project conversation receives peer messages during a run and reconciles once", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/",
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, value: "visible" });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    customElements: dom.window.customElements,
    Node: dom.window.Node,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    InputEvent: dom.window.InputEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    EventSource: FakeEventSource,
  };
  const previous = new Map<string, unknown>();
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, (globalThis as Record<string, unknown>)[key]);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const row = {
    id: "project-session",
    threadRef: "web:owner:project",
    scopeId: "group:project",
    title: "Project chat",
    forkedFrom: { sessionId: "parent-session", title: "Parent chat" },
    forkBoundarySeq: 9,
    type: "dm" as const,
    createdAt: Date.now(),
  };
  const initial: SessionEntry = {
    seq: 10,
    type: "user",
    createdAt: Date.now(),
    payload: { text: "Start", authorId: "owner" },
  };
  const peer: SessionEntry = {
    seq: 12,
    type: "user",
    createdAt: Date.now() + 1,
    payload: { text: "Message from B", authorId: "peer" },
  };
  const inherited: SessionEntry = {
    seq: 0,
    type: "user",
    createdAt: Date.now() - 1000,
    payload: { text: "Old message from the parent chat", authorId: "peer" },
  };
  const reply: SessionEntry = {
    seq: 11,
    type: "assistant",
    createdAt: Date.now(),
    payload: { text: "Earlier assistant reply" },
  };
  let entries = [initial, reply];
  let reads = 0;
  let sentText: string | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path.includes("runtime-config"))
      return Response.json({
        scopeId: row.scopeId,
        approvedHarnesses: ["pi"],
        modelsByHarness: { pi: ["test-model"] },
        modelCatalog: { "test-model": metadata("test-model", "Test model") },
        orgDefault: { harnessId: "pi", modelId: "test-model", revision: 0 },
        effective: { harnessId: "pi", modelId: "test-model" },
        scopeOverride: null,
      });
    if (path.includes("/api/runs/active")) return Response.json({ runId: null, queued: [] });
    if (path === "/api/turn") {
      sentText = JSON.parse(String(init?.body ?? "{}"))?.text ?? null;
      return Response.json({ status: "queued", runId: "next-run" });
    }
    if (path.endsWith("/approvals")) return Response.json({ approvals: [] });
    if (path.startsWith(`/api/sessions/${row.id}`)) return Response.json({ session: row, entries, earlierEntries: 0 });
    if (path === `/api/notifications/sessions/${row.id}/read`) {
      reads++;
      return Response.json({ marked: 1 });
    }
    if (path === "/api/notifications") return Response.json({ notifications: [], unread: 0 });
    if (path === "/api/sessions") return Response.json({ sessions: [row] });
    if (path === "/api/contexts") return Response.json({ contexts: [] });
    throw new Error(`Unexpected request: ${path}`);
  };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  let conv: Conversation | undefined;
  try {
    await vite.ssrLoadModule("/src/shell.ts");
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
    const { createConversation, ensureDeliveryStream } = await vite.ssrLoadModule("/src/conversations.ts");
    const { entriesToMessages } = await vite.ssrLoadModule("/src/core-bridge.ts");
    const { transcriptModel } = await vite.ssrLoadModule("/src/model-options.ts");
    const { seedRuntimeConfig } = await vite.ssrLoadModule("/src/runtime-config-store.ts");
    seedRuntimeConfig(row.scopeId, await (await globalThis.fetch("/api/runtime-config")).json());
    appState.me = { user: "owner", org: "test" };
    appState.currentView = "chats";
    sessionsState.list = [row];
    sessionsState.loaded = true;
    const host = document.querySelector<HTMLElement>("#main")!;
    appState.mainEl = host;
    ensureDeliveryStream();
    const delivery = FakeEventSource.instances.find((es) => es.url === "/api/deliveries/events")!;
    conv = createConversation({
      pane: true,
      ownsUrl: false,
      container: () => host,
      claimContainer: () => host,
      visible: () => true,
      density: () => "full",
      onDensityChange() {},
      ensureDeliveryStream,
    }) as Conversation;
    conv.mountContinuable(row.threadRef, row.id, row.scopeId, entriesToMessages(entries, transcriptModel()), null, row);
    conv.state.agent!.state.messages.push({ role: "user", content: "Just sent" } as never);
    conv.drawActiveChat();
    assert.equal(host.querySelector(".user-row:not([data-entry-seq]) .speaker-label")?.textContent, "owner");
    Object.defineProperty(conv.state.agent!.state, "isStreaming", { configurable: true, value: true });
    Object.defineProperty(conv.state.agent!.state, "streamingMessage", {
      configurable: true,
      value: { role: "assistant", content: [{ type: "text", text: "Live response" }] },
    });
    (conv.state as typeof conv.state & { liveWork: unknown }).liveWork = {
      status: "working",
      activity: [
        {
          seq: 1,
          parentSeq: null,
          type: "tool_call",
          payload: { tool: "web", action: "post", text: "Reply", callId: "post-1" },
          createdAt: Date.now(),
        },
        {
          seq: 2,
          parentSeq: null,
          type: "tool_result",
          payload: { tool: "web", action: "post", ok: true, callId: "post-1" },
          createdAt: Date.now(),
        },
      ],
    };
    conv.drawActiveChat();
    conv.composer.state.draft = "Next question";
    conv.drawActiveChat();
    host.querySelector<HTMLButtonElement>(".send-btn")!.click();
    await until(() => sentText === "Next question");
    await until(() => host.querySelector('.user-row[data-queued-run-id="next-run"]') !== null);
    assert.equal(host.querySelector('.user-row[data-queued-run-id="next-run"] .speaker-label')?.textContent, "owner");
    assert.equal(host.querySelector(".queued-strip"), null);
    assert.equal(host.querySelector(".send-btn")?.getAttribute("aria-label"), "Send");
    conv.state.agent!.state.messages.push({ role: "user", content: "Next question", runId: "next-run" } as never);
    conv.drawActiveChat();
    assert.equal(host.querySelectorAll('.user-row[data-queued-run-id="next-run"]').length, 0);
    conv.state.agent!.state.messages.pop();
    conv.composer.setQueuedRuns(row.threadRef, []);
    entries = [inherited, initial, reply, peer];
    delivery.emit("delivery", { threadRef: row.threadRef });
    await until(() => host.querySelectorAll('.user-row[data-entry-seq="12"]').length === 1);
    assert.equal(host.querySelector('.user-row[data-entry-seq="0"]'), null);
    assert.ok(host.querySelector(".user-row:not([data-entry-seq])")?.textContent?.includes("Just sent"));
    assert.equal(host.querySelectorAll(".assistant-row:not(.streaming)").length, 1);
    assert.ok(host.querySelector(".assistant-row:not(.streaming)")?.textContent?.includes("Earlier assistant reply"));
    assert.equal(host.querySelector(".assistant-row .user-bubble"), null);
    const peerRow = host.querySelector<HTMLElement>('.user-row[data-entry-seq="12"]')!;
    const liveReply = host.querySelector<HTMLElement>(".assistant-row.streaming")!;
    assert.ok(peerRow.compareDocumentPosition(liveReply) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.equal(peerRow.querySelector(".speaker-label")?.textContent, "peer");
    await until(() => reads === 1);
    conv.state.agent!.state.messages.push(...entriesToMessages([peer], transcriptModel()));
    conv.drawActiveChat();
    assert.equal(host.querySelectorAll('.user-row[data-entry-seq="12"]').length, 1);
    delivery.emit("delivery", { threadRef: row.threadRef });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(host.querySelectorAll('.user-row[data-entry-seq="12"]').length, 1);
    const scroller = host.querySelector<HTMLElement>(".chat-scroll")!;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 100 },
    });
    scroller.scrollTop = 1000;
    scroller.dispatchEvent(new Event("scroll"));
    scroller.scrollTop = 100;
    scroller.dispatchEvent(new Event("scroll"));
    const anotherPeer = { ...peer, seq: 13, payload: { text: "Another message from B", authorId: "peer" } };
    entries = [inherited, initial, reply, peer, anotherPeer];
    delivery.emit("delivery", { threadRef: row.threadRef });
    await until(() => host.querySelectorAll('.user-row[data-entry-seq="13"]').length === 1);
    assert.ok(host.querySelector(".chat-new-messages"));
    assert.equal(scroller.scrollTop, 100);
    assert.equal(reads, 1);
    host.querySelector<HTMLButtonElement>(".chat-new-messages")!.click();
    await until(() => reads === 2);
    assert.equal(host.querySelector(".chat-new-messages"), null);
    Object.defineProperty(conv.state.agent!.state, "isStreaming", { configurable: true, value: false });
    delivery.emit("delivery", { threadRef: row.threadRef });
    await until(() =>
      conv!.state.agent!.state.messages.some((message) => JSON.stringify(message).includes("Another message from B")),
    );
    assert.equal(host.querySelectorAll('.user-row[data-entry-seq="12"]').length, 1);
    assert.equal(host.querySelectorAll('.user-row[data-entry-seq="13"]').length, 1);
  } finally {
    conv?.dispose();
    for (const es of FakeEventSource.instances) es.close();
    await vite.close();
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous)
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    dom.window.close();
  }
});
