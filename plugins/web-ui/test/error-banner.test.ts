import assert from "node:assert/strict";
import { test } from "node:test";

import { Agent } from "@earendil-works/pi-agent-core";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";

import { showStateError, userErrorMessage } from "../src/error-banner.ts";
import { translateText } from "../src/i18n.ts";
import { FAILURE_REASONS, usageLimitFailureReason } from "../../chassis/src/failure-copy.ts";
import { SECURITY_QUARANTINE_REFUSAL_TEXT } from "../../chassis/src/security-quarantine.ts";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

const zeroUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function failed(errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: zeroUsage(),
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  };
}

test("a failed run records its error on BOTH the transcript message and agent state", async () => {
  const streamFn: StreamFn = () => {
    const stream = createAssistantMessageEventStream();
    const error = failed("model call failed");
    stream.push({ type: "error", reason: "error", error });
    stream.end(error);
    return stream;
  };
  const agent = new Agent({
    initialState: {
      systemPrompt: "",
      model: { id: "test", provider: "anthropic", api: "anthropic-messages" } as never,
      messages: [],
      tools: [],
    },
    streamFn,
    convertToLlm: () => [],
  });
  await agent.prompt("hi");

  const last = agent.state.messages[agent.state.messages.length - 1] as AssistantMessage;
  assert.equal(last.stopReason, "error");
  assert.equal(last.errorMessage, "model call failed");
  assert.equal(agent.state.errorMessage, "model call failed", "the same error is also copied onto agent state");

  assert.equal(
    showStateError(agent.state.messages, agent.state.errorMessage),
    false,
    "so the state-level banner must not render it again",
  );
});

test("the state banner is suppressed when the trailing message already shows the same error", () => {
  assert.equal(showStateError([failed("boom")], "boom"), false);
});

test("the state banner still renders an error the transcript does not carry", () => {
  assert.equal(showStateError([], "boom"), true);
  assert.equal(showStateError([{ role: "user", content: "hi" }], "boom"), true);
  assert.equal(showStateError([failed("other error")], "boom"), true, "a different trailing error is not this error");
});

test("no banner without an error, and aborted turns show the Stopped note instead", () => {
  assert.equal(showStateError([], undefined), false);
  assert.equal(showStateError([], ""), false);
  assert.equal(showStateError([failed("aborted")], "aborted"), false);
});

test("usage limit guidance and provider reset estimates are localized without claiming a live countdown", () => {
  const reason = usageLimitFailureReason('usage_limit_reached {"reset_seconds":11143}')!;
  const translated = translateText(reason, "zh-CN");
  assert.match(translated, /本次请求失败时.*约 3 小时 6 分钟后恢复/);
  assert.match(translated, /等待额度恢复.*其他可用模型.*管理员/);
  assert.match(translated, /立即重试不会恢复额度/);
  assert.doesNotMatch(translateText(usageLimitFailureReason("usage_limit_reached")!, "zh-CN"), /预计|分钟|小时/);
  assert.equal(translateText(reason, "en"), reason);
});

test("user-facing errors classify HTTP failures and hide unknown exceptions without changing diagnostics", () => {
  for (const [status, expected] of [
    [400, /missing or invalid/],
    [401, /Reconnect the account/],
    [403, /check permissions/],
    [404, /removed or moved/],
    [409, /Refresh its status/],
    [413, /smaller file/],
    [415, /supported file format/],
    [422, /missing or invalid/],
    [429, /Wait a few minutes/],
    [500, /cause is unclear/],
    [503, /temporarily unavailable/],
  ] as const) {
    const error = Object.assign(new Error("private provider stack"), { status });
    const visible = userErrorMessage(error);
    assert.match(visible, expected);
    assert.doesNotMatch(visible, /private|stack|HTTP/);
    assert.equal(error.message, "private provider stack");
  }
  for (const error of [
    new TypeError("private data"),
    "private data",
    null,
    { message: "private data" },
    new Error("__proto__"),
    new Error("toString"),
  ]) {
    const visible = userErrorMessage(error, "Could not load memory.");
    assert.match(visible, /Could not load memory\..*cause is unclear/);
    assert.doesNotMatch(visible, /private|TypeError|internal error/);
  }
  assert.match(userErrorMessage(new Error("unknown (run abc-123)")), /\(run abc-123\)$/);
});

test("live and historical failures render localized guidance with diagnostics collapsed", async () => {
  const dom = new JSDOM('<!doctype html><div id="notice"></div>', { url: "http://localhost/" });
  const globals = { document: dom.window.document, localStorage: dom.window.localStorage };
  const original = Object.getOwnPropertyDescriptors(globalThis);
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true },
    ssr: { noExternal: ["lit", "lit-html", "lit-element", /^@lit\//] },
    appType: "custom",
  });
  try {
    const { composerErrorNotice, turnErrorNotice } = await vite.ssrLoadModule("/src/error-banner.ts");
    const { render } = await vite.ssrLoadModule("lit");
    dom.window.localStorage.setItem("qm:locale", "zh-CN");
    const { userErrorMessage: localizedError } = await vite.ssrLoadModule("/src/error-banner.ts");
    assert.match(localizedError(Object.assign(new Error("private"), { status: 403 })), /管理员检查访问权限/);
    assert.doesNotMatch(localizedError(new Error("private")), /private|unclear/);
    const raw =
      'openai-qf2 API error (429): {"code":"model_cooldown","last_upstream_error":"usage_limit_reached","reset_seconds":11143} (run r-1)';
    const host = dom.window.document.getElementById("notice")!;
    for (const message of [raw, `${usageLimitFailureReason(raw)} (run r-1)`]) {
      render(turnErrorNotice(message), host);
      assert.equal(host.querySelector("strong")?.textContent, "AI 用量已用完");
      assert.equal(host.querySelector("[role=status]")?.classList.contains("composer-error"), false);
      assert.match(host.querySelector("p:last-of-type")?.textContent ?? "", /3 小时 6 分钟/);
      const details = host.querySelector("details")!;
      assert.equal(details.open, false);
      assert.match(details.textContent ?? "", /run r-1/);
      assert.equal(details.querySelector("div")?.textContent, message);
    }
    for (const [message, title, detail] of [
      ["rate_limit_error private", "服务请求过多，请稍后再试", /等几分钟/],
      [FAILURE_REASONS.timeout, "任务执行超时", /缩小任务范围/],
      ["fetch failed private", "暂时无法连接所需服务", /检查网络连接/],
      ["HTTP 503 private", "所需服务暂时不可用", /稍后重试/],
      ["invalid_api_key private", "需要重新连接账户", /重新连接对应账户/],
      ["context_length_exceeded private", "对话或请求内容过长", /新开对话/],
      ["insufficient_quota private", "AI 账户余额或额度不足", /检查账户账单/],
      ["403 Forbidden private", "当前权限不足，暂时无法继续", /检查访问权限/],
      ["model_not_found private", "当前选择的 AI 模型不可用", /选择其他可用模型/],
      [
        "Give me a moment — I'm still finishing something else in this conversation.",
        "当前对话还有任务正在执行",
        /等待当前任务结束/,
      ],
      [SECURITY_QUARANTINE_REFUSAL_TEXT, "本次请求需要安全检查", /安全检查拦截/],
      ["Approve or deny the pending command to continue.", "需要你确认后才能继续", /允许或拒绝/],
      [
        "This approval is no longer available — it may have expired or already been handled.",
        "这项确认已失效或已处理",
        /最新状态/,
      ],
      ["Timed out waiting for the agent to respond.", "暂时无法确认任务状态", /任务可能仍在执行.*避免重复发送/],
      ["Nothing to send.", "消息尚未发送", /请输入消息或添加附件/],
      ["TypeError: private <img src=x onerror=alert(1)>", "本次请求未能完成", /原因暂时无法判断.*管理员排查/],
    ] as const) {
      render(turnErrorNotice(message), host);
      assert.equal(host.querySelector("strong")?.textContent, title, message);
      const body = host.querySelector("p")?.textContent ?? "";
      assert.match(body, detail);
      assert.doesNotMatch(body, /private|API error|TypeError|系统故障|系统 bug/);
      assert.equal(host.querySelector("details")?.open, false);
      assert.equal(host.querySelector("details div")?.textContent, message);
      assert.equal(host.querySelector("img"), null);
      assert.equal(host.querySelector(".composer-error"), null);
    }
    const permission =
      "this request is not allowed with the current access; ask an administrator to check permissions (run 7dfed805-477d-4765-8a55-1f1c68555806)";
    for (const notice of [turnErrorNotice, composerErrorNotice]) {
      render(notice(permission), host);
      assert.equal(host.querySelector("strong")?.textContent, "当前权限不足，暂时无法继续");
      assert.match(host.querySelector("p")?.textContent ?? "", /管理员检查访问权限/);
      assert.equal(host.querySelector("details div")?.textContent, permission);
      assert.equal(host.querySelector(".composer-error"), null);
    }
    render(composerErrorNotice("Approve or deny the pending command to continue."), host);
    assert.equal(host.querySelector("strong")?.textContent, "需要你确认后才能继续");
    render(composerErrorNotice("文件太大，请选择较小的文件。"), host);
    assert.equal(host.querySelector(".composer-error")?.textContent, "文件太大，请选择较小的文件。");
    assert.equal(host.querySelector("details"), null);
    dom.window.localStorage.setItem("qm:locale", "en");
    render(turnErrorNotice("invalid_api_key private"), host);
    assert.equal(host.querySelector("strong")?.textContent, "An account needs to be reconnected");
    assert.match(host.querySelector("p")?.textContent ?? "", /Reconnect the account/);
  } finally {
    await vite.close();
    dom.window.close();
    for (const key of Object.keys(globals)) {
      if (original[key]) Object.defineProperty(globalThis, key, original[key]!);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
