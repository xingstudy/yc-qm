import assert from "node:assert/strict";
import test from "node:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { ComposerSurface, ConvCtx } from "../src/conv-types.ts";

test("project mentions search, select, preserve draft identity, and send through direct and queued paths", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><div id="composer"></div>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const requests: string[] = [];
  const sent: unknown[] = [];
  const queuedBodies: Record<string, unknown>[] = [];
  const people = [
    { principalId: "zhou@example.com", displayName: "周明" },
    { principalId: "zhou-2", displayName: "周平" },
  ];
  let searchFailure = false;
  let pendingSearch: ((response: Response) => void) | undefined;
  const globals = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    customElements: dom.window.customElements,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      requests.push(path);
      if (path.includes("member-candidates")) {
        const query = new URL(path, "http://localhost").searchParams.get("q");
        if (query === "旧")
          return new Promise<Response>((resolve) => {
            pendingSearch = resolve;
          });
        if (searchFailure) return Response.json({ error: "search failed" }, { status: 500 });
        if (query === "无人") return Response.json({ matches: [] });
        if (query === "同名")
          return Response.json({
            matches: [
              { principalId: "same-1", displayName: "同名" },
              { principalId: "same-2", displayName: "同名" },
            ],
          });
        return Response.json({ matches: people });
      }
      if (path === "/api/turn") queuedBodies.push(JSON.parse(String(init?.body)));
      return Response.json({ runId: "queued-test", sessions: [] });
    },
  };
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  let composer: ComposerSurface | undefined;
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { createComposerSurface, mentionQuery } = await vite.ssrLoadModule("/src/composer.ts");
    const { storedDraft, flushDrafts } = await vite.ssrLoadModule("/src/drafts.ts");
    const { seedRuntimeConfig, getRuntimeConfig } = await vite.ssrLoadModule("/src/runtime-config-store.ts");
    const { render } = await vite.ssrLoadModule("lit");
    appState.me = { user: "tester", org: "test" };
    const model = {
      id: "alpha",
      name: "Alpha",
      label: "Alpha",
      buttonLabel: "Alpha",
      provider: "openai",
      api: "openai-responses",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4096,
    };
    seedRuntimeConfig("group:web-project-p1", {
      scopeId: "group:web-project-p1",
      approvedHarnesses: ["pi"],
      modelsByHarness: { pi: ["alpha"] },
      modelCatalog: { alpha: model },
      orgDefault: { harnessId: "pi", modelId: "alpha", revision: 1 },
      effective: { harnessId: "pi", modelId: "alpha" },
      scopeOverride: null,
      upgradeAvailable: false,
    });
    const host = document.querySelector<HTMLElement>("#composer")!;

    const agentState = { isStreaming: false, model, messages: [] };
    const agent = {
      state: agentState,
      prompt: async (message: unknown) => {
        sent.push(message);
      },
    } as unknown as Agent;
    const draw = (): void => render([composer!.queuedStrip(agent), composer!.composerForm(agent)], host);
    const ctx = {
      pane: false,
      chat: {
        state: {
          agent,
          host,
          threadRef: "web:tester:stopping",
          sessionId: "test-session",
          scopeId: "group:web-project-p1",
          resolvingApprovals: new Set<string>(),
        },
        activePendingApprovals: () => [],
        hasUnresolvedApproval: () => false,
        hasPostedReply: () => false,
        hasLiveRun: () => agentState.isStreaming,
        isStopping: () => false,
        drawActiveChat: draw,

        notePendingSessionOnSend() {},
        scrollToBottom() {},
      },
    } as unknown as ConvCtx;
    composer = createComposerSurface(ctx);
    ctx.composer = composer!;
    const button = (selector: string): HTMLButtonElement => host.querySelector<HTMLButtonElement>(selector)!;
    const type = (value: string): void => {
      const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
      input.value = value;
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    };
    const wait = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 260));
    };
    const key = (key: string): void => {
      host
        .querySelector("textarea")!
        .dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    };
    const submit = async (): Promise<void> => {
      host.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 25));
    };
    assert.deepEqual(mentionQuery("找 @周 后续", 4), { query: "周", start: 2, end: 4 });
    assert.equal(mentionQuery("mail@周", 6), null);
    draw();
    type("请联系 @周");
    await wait();
    assert.equal(new URL(requests[0]!, "http://localhost").pathname, "/api/projects/p1/member-candidates");
    assert.equal(new URL(requests[0]!, "http://localhost").searchParams.get("q"), "周");
    assert.equal(new URL(requests[0]!, "http://localhost").searchParams.get("membersOnly"), "true");
    assert.equal(host.querySelectorAll(".mention-popover [role=option]").length, 2);
    assert.equal(button(".mention-popover [role=option]").textContent?.trim(), "@周明");
    assert.ok(!host.querySelector(".mention-popover")?.textContent?.includes("zhou@example.com"));
    key("ArrowDown");
    key("Enter");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(composer!.state.draft, "请联系 @周平 ");
    assert.equal(sent.length, 0, "accepting a mention does not submit the message");
    assert.equal(host.querySelector(".mention-popover"), null);
    flushDrafts();
    const draft = storedDraft("web:tester:stopping");
    assert.equal(draft, "请联系 <@zhou-2|周平> ");
    composer!.resetComposer();
    composer!.state.draft = draft;
    draw();
    assert.equal(host.querySelector<HTMLTextAreaElement>("textarea")!.value, "请联系 @周平 ");
    await submit();
    assert.equal((sent[0] as { content: string }).content, "请联系 <@zhou-2|周平>");
    agentState.isStreaming = true;
    type("@周");
    await wait();
    button(".mention-popover [role=option]").click();
    await submit();
    assert.equal(queuedBodies[0]?.text, "<@zhou@example.com|周明>");
    assert.ok(host.querySelector(".queued-text")?.textContent?.includes("@周明"));
    type("@旧");
    await wait();
    assert.ok(pendingSearch);
    type("@周");
    await wait();
    pendingSearch!(Response.json({ matches: [{ principalId: "stale", displayName: "过期结果" }] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(!host.textContent?.includes("过期结果"));
    key("Escape");
    assert.equal(host.querySelector(".mention-popover"), null);
    type("@无人");
    await wait();
    assert.equal(host.querySelectorAll(".mention-popover [role=option]").length, 0);
    const count = queuedBodies.length;
    key("Enter");
    assert.equal(queuedBodies.length, count);
    searchFailure = true;
    type("@错误");
    await wait();
    assert.ok(host.querySelector(".mention-popover [role=status]")?.textContent);
    searchFailure = false;
    composer!.resetComposer();
    agentState.isStreaming = false;
    type("@同名");
    await wait();
    button(".mention-popover [role=option]").click();
    await new Promise((resolve) => setTimeout(resolve, 25));
    type(composer!.state.draft + "@同名");
    await wait();
    key("ArrowDown");
    key("Tab");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(composer!.state.draft, "@同名 (1) @同名 (2) ");
    await submit();
    assert.equal((sent[1] as { content: string }).content, "<@same-1|同名 (1)> <@same-2|同名 (2)>");
    seedRuntimeConfig("personal:tester", { ...getRuntimeConfig("group:web-project-p1"), scopeId: "personal:tester" });
    ctx.chat.state.scopeId = "personal:tester";
    composer!.resetComposer();
    draw();
    const requestCount = requests.length;
    type("@周");
    await wait();
    assert.equal(requests.length, requestCount, "personal chats do not search project members");
    assert.equal(host.querySelector(".mention-popover"), null);
  } finally {
    composer?.dispose();
    await vite.close();
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
