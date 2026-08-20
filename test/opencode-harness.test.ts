import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assistantFailure,
  createOpenCodeHarness,
  latestAssistantParts,
  waitForSessionIdle,
} from "../src/harness/opencode-harness.ts";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { HarnessLlmRequestRecord, HarnessTurnInput } from "../src/harness/harness.ts";
import { createMemoryRunSignalStore } from "../src/runs/run-signal-store.ts";
import type { ScopeId, Session, SessionEntry } from "../src/types.ts";

function fakeSidecar(dir: string, name: string, handlers: string): string {
  const script = join(dir, `${name}.js`);
  writeFileSync(
    script,
    `const http = require("node:http");
const port = Number((process.argv.find((a) => a.startsWith("--port=")) ?? "--port=0").slice("--port=".length));
const readBody = (req) => new Promise((res) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => res(d)); });
const json = (res, value) => { const t = JSON.stringify(value); res.writeHead(200, { "content-type": "application/json" }); res.end(t); };
const capture = async (sessionId, body) =>
  fetch(process.env.OPENCODE_BRIDGE_URL + "/session/" + sessionId + "/capture", {
    method: "POST",
    headers: { authorization: "Bearer " + process.env.OPENCODE_BRIDGE_SECRET, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/global/event") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("\\n"); return; }
  const message = url.pathname.match(/^\\/session\\/([^/]+)\\/message$/);
  ${handlers}
  if (req.method === "POST" && url.pathname === "/session") { await readBody(req); return json(res, { id: "ses_main" }); }
  return json(res, {});
});
server.listen(port, "127.0.0.1", () => console.log("opencode server listening on http://127.0.0.1:" + port));
`,
  );
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const promptHandlers = (assistant: string) => `
  if (req.method === "POST" && message) {
    await readBody(req);
    await capture(message[1], { system: "s", messages: [{ role: "user" }] });
    return json(res, ${assistant});
  }
  if (req.method === "GET" && message) return json(res, [${assistant}]);
`;

const definitionHandlers = `
  if (message) {
    await readBody(req);
    const definitions = await (await fetch(process.env.OPENCODE_BRIDGE_URL + "/definitions", {
      headers: { authorization: "Bearer " + process.env.OPENCODE_BRIDGE_SECRET },
    })).json();
    const response = {
      info: {
        id: "msg_1", sessionID: message[1], role: "assistant", time: { created: 1000, completed: 1001 },
        parentID: "", modelID: "gpt-5", providerID: "openai", mode: "qm", path: { cwd: "/", root: "/" },
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop",
      },
      parts: [{ id: "prt_1", sessionID: message[1], messageID: "msg_1", type: "text", text: definitions.map((d) => d.name).join(",") }],
    };
    return json(res, req.method === "GET" ? [response] : response);
  }
`;

const routeSnapshotHandlers = (statePath: string) => `
  if (req.method === "POST" && url.pathname === "/session") {
    await readBody(req);
    require("node:fs").writeFileSync(${JSON.stringify(statePath)}, "new");
    return json(res, { id: "ses_main" });
  }
  if (message) {
    await readBody(req);
    const result = await (await fetch(process.env.OPENCODE_BRIDGE_URL + "/session/" + message[1] + "/tool", {
      method: "POST",
      headers: { authorization: "Bearer " + process.env.OPENCODE_BRIDGE_SECRET, "content-type": "application/json" },
      body: JSON.stringify({ tool: "crm_query", callID: "call_1", args: {} }),
    })).json();
    const response = {
      info: {
        id: "msg_1", sessionID: message[1], role: "assistant", time: { created: 1000, completed: 1001 },
        parentID: "", modelID: "gpt-5", providerID: "openai", mode: "qm", path: { cwd: "/", root: "/" },
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop",
      },
      parts: [{ id: "prt_1", sessionID: message[1], messageID: "msg_1", type: "text", text: result.output }],
    };
    return json(res, req.method === "GET" ? [response] : response);
  }
`;

const erroredAssistant = (error: string) => `{
  info: {
    id: "msg_1", sessionID: "ses_main", role: "assistant", time: { created: 1000 },
    error: ${error},
    parentID: "", modelID: "gpt-5", providerID: "openai", mode: "qm", path: { cwd: "/", root: "/" },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  parts: [],
}`;

const errorAssistant = erroredAssistant(
  `{ name: "ProviderAuthError", data: { providerID: "openai", message: "401 Incorrect API key provided" } }`,
);

const okAssistant = `{
  info: {
    id: "msg_1", sessionID: "ses_main", role: "assistant", time: { created: 1000, completed: 2929 },
    parentID: "", modelID: "gpt-5", providerID: "openai", mode: "qm", path: { cwd: "/", root: "/" },
    cost: 0.0353, tokens: { input: 100, output: 20, reasoning: 3, cache: { read: 50, write: 10 } },
    finish: "stop",
  },
  parts: [{ id: "prt_1", sessionID: "ses_main", messageID: "msg_1", type: "text", text: "hello from fake" }],
}`;

const securityAssistant = okAssistant.replace(
  '"hello from fake"',
  JSON.stringify(JSON.stringify({ decision: "auto" })),
);

function turnInput(entries: SessionEntry[], llmRows: HarnessLlmRequestRecord[]): HarnessTurnInput {
  const scope = { kind: "org", id: "test" } as unknown as ScopeId;
  const session = { id: "session-1" } as Session;
  return {
    session,
    input: "hi",
    model: "openai/gpt-5",
    systemPrompt: "be concise",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: scope,
    orgScopeId: scope,
    emit: async (entry) => {
      const saved = { ...entry, sessionId: session.id, seq: entries.length + 1, createdAt: Date.now() } as SessionEntry;
      entries.push(saved);
      return saved;
    },
    recordModelCall: () => {},
    recordLlmRequest: async (rec) => {
      llmRows.push(rec);
    },
  };
}

test("OpenCode surfaces a provider error as a non-retryable failure, never a successful empty reply", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  const harness = createOpenCodeHarness({
    binaryPath: fakeSidecar(dir, "provider-error", promptHandlers(errorAssistant)),
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const entries: SessionEntry[] = [];
  const llmRows: HarnessLlmRequestRecord[] = [];
  await assert.rejects(harness.turns.runTurn(turnInput(entries, llmRows)), (error: Error) => {
    assert.equal(error.name, "NonRetryableTurnError");
    assert.match(error.message, /ProviderAuthError/);
    assert.match(error.message, /401 Incorrect API key provided/);
    return true;
  });
  assert.deepEqual(
    entries.map((entry) => entry.type),
    ["user"],
  );
  assert.equal(llmRows.length, 1);
  assert.equal(llmRows[0]!.step, 0);
});

test("OpenCode records real usage, cost, and timings for each captured model call", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  const harness = createOpenCodeHarness({ binaryPath: fakeSidecar(dir, "usage", promptHandlers(okAssistant)) });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const entries: SessionEntry[] = [];
  const llmRows: HarnessLlmRequestRecord[] = [];
  const result = await harness.turns.runTurn(turnInput(entries, llmRows));
  assert.equal(result.reply, "hello from fake");
  assert.equal(result.modelCalls, 1);
  assert.equal(llmRows.length, 1);
  const row = llmRows[0]!;
  assert.equal(row.turnSeq, 1);
  assert.equal(row.step, 0);
  assert.equal(row.model, "openai/gpt-5");
  assert.equal(row.truncated, false);
  assert.deepEqual(row.promptEnvelope, { system: "s" }, "messages stay on the tape, not in the envelope");
  assert.deepEqual(row.transport, { modelId: "openai/gpt-5" });
  assert.equal(row.durationMs, 1929);
  assert.deepEqual(row.usage, {
    input: 100,
    output: 20,
    cacheRead: 50,
    cacheWrite: 10,
    totalTokens: 183,
    costUsd: 0.0353,
  });
});

test("OpenCode security screening uses an auxiliary runtime while a primary turn holds its lease", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  const harness = createOpenCodeHarness({
    binaryPath: fakeSidecar(dir, "security-auxiliary", promptHandlers(securityAssistant)),
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  let releaseEmit!: () => void;
  const emitGate = new Promise<void>((resolve) => {
    releaseEmit = resolve;
  });
  let started!: () => void;
  const startedEmit = new Promise<void>((resolve) => {
    started = resolve;
  });
  const primary = turnInput([], []);
  const emit = primary.emit;
  primary.emit = async (entry) => {
    if (entry.type === "user") {
      started();
      await emitGate;
    }
    return emit(entry);
  };
  const primaryTurn = harness.turns.runTurn(primary);
  await startedEmit;
  const verdict = await harness.models.screenSecurity!({
    payload: "untrusted content",
    signal: new AbortController().signal,
    recordModelCall: () => {},
  });
  assert.deepEqual(verdict, { decision: "auto" });
  releaseEmit();
  assert.equal((await primaryTurn).reply, '{"decision":"auto"}');
});

test("OpenCode restarts its bridge when MCP definitions refresh and reserves workspace aliases", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  let mcpTools = [] as Array<{
    name: string;
    serverId: string;
    remoteName: string;
    description: string;
    inputSchema: Record<string, unknown>;
    readOnly: boolean;
    capability: string;
  }>;
  const harness = createOpenCodeHarness({
    binaryPath: fakeSidecar(dir, "definitions", definitionHandlers),
    mcpTools: () => mcpTools,
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const first = await harness.turns.runTurn(turnInput([], []));
  assert.ok(!first.reply.includes("crm_query"));
  mcpTools = [
    {
      name: "crm_query",
      serverId: "crm",
      remoteName: "query",
      description: "Query CRM",
      inputSchema: { type: "object" },
      readOnly: true,
      capability: "crm-query",
    },
    {
      name: "workspace_execute",
      serverId: "workspace",
      remoteName: "execute",
      description: "Pretend workspace execution",
      inputSchema: { type: "object" },
      readOnly: false,
      capability: "workspace-execute",
    },
    {
      name: "web",
      serverId: "web",
      remoteName: "spoof",
      description: "Spoof web surface",
      inputSchema: { type: "string" },
      readOnly: false,
      capability: "spoof-web",
    },
  ];
  const secondTurn = turnInput([], []);
  secondTurn.surfaceTools = true;
  secondTurn.surfaceName = "web";
  const second = await harness.turns.runTurn(secondTurn);
  assert.ok(second.reply.includes("crm_query"));
  assert.equal(second.reply.split(",").filter((name) => name === "workspace_execute").length, 1);
  assert.equal(second.reply.split(",").filter((name) => name === "web").length, 1);
});

test("OpenCode restarts for each turn's surface and credential tool contract", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  const harness = createOpenCodeHarness({ binaryPath: fakeSidecar(dir, "turn-contract", definitionHandlers) });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const webTurn = turnInput([], []);
  webTurn.surfaceTools = true;
  webTurn.surfaceName = "web";
  const web = await harness.turns.runTurn(webTurn);
  assert.ok(web.reply.split(",").includes("web"));
  assert.ok(!web.reply.split(",").includes("credential_exec"));
  const credentialTurn = turnInput([], []);
  credentialTurn.surfaceTools = true;
  credentialTurn.surfaceName = "slack";
  credentialTurn.credentialExecServices = [{ service: "acme", binary: "acme" }];
  const credential = await harness.turns.runTurn(credentialTurn);
  assert.ok(credential.reply.split(",").includes("slack"));
  assert.ok(!credential.reply.split(",").includes("web"));
  assert.ok(credential.reply.split(",").includes("credential_exec"));
});

test("OpenCode reserved surface names cannot replace native or workspace tools", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  const harness = createOpenCodeHarness({ binaryPath: fakeSidecar(dir, "reserved-surfaces", definitionHandlers) });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  for (const surfaceName of ["task", "read", "workspace_execute"]) {
    const turn = turnInput([], []);
    turn.surfaceTools = true;
    turn.surfaceName = surfaceName;
    const names = (await harness.turns.runTurn(turn)).reply.split(",");
    assert.equal(names.filter((name) => name === "workspace_execute").length, 1);
    assert.equal(names.filter((name) => name === "workspace_read").length, 1);
    assert.ok(!names.includes("task"));
  }
});

test("OpenCode runs distinct surface contracts concurrently", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  const harness = createOpenCodeHarness({ binaryPath: fakeSidecar(dir, "surface-pool", definitionHandlers) });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const webTurn = turnInput([], []);
  webTurn.surfaceTools = true;
  webTurn.surfaceName = "web";
  const slackTurn = turnInput([], []);
  slackTurn.surfaceTools = true;
  slackTurn.surfaceName = "slack";
  const [web, slack] = await Promise.all([harness.turns.runTurn(webTurn), harness.turns.runTurn(slackTurn)]);
  assert.ok(web.reply.split(",").includes("web"));
  assert.ok(!web.reply.split(",").includes("slack"));
  assert.ok(slack.reply.split(",").includes("slack"));
  assert.ok(!slack.reply.split(",").includes("web"));
});

test("OpenCode queues distinct contracts fairly within cancellation and wall-clock bounds", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  const harness = createOpenCodeHarness({ binaryPath: fakeSidecar(dir, "surface-capacity", definitionHandlers) });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  let startedCount = 0;
  let allStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    allStarted = resolve;
  });
  const releases = new Map<string, () => void>();
  const running = ["alpha", "beta", "gamma", "delta"].map((surfaceName) => {
    const gate = new Promise<void>((resolve) => {
      releases.set(surfaceName, resolve);
    });
    const turn = turnInput([], []);
    turn.surfaceTools = true;
    turn.surfaceName = surfaceName;
    const emit = turn.emit;
    turn.emit = async (entry) => {
      if (entry.type === "user") {
        startedCount += 1;
        if (startedCount === 4) allStarted();
        await gate;
      }
      return emit(entry);
    };
    return harness.turns.runTurn(turn);
  });
  await started;
  const fifth = turnInput([], []);
  fifth.surfaceTools = true;
  fifth.surfaceName = "epsilon";
  let fifthSettled = false;
  const fifthRun = harness.turns.runTurn(fifth).finally(() => {
    fifthSettled = true;
  });
  const cancelled = new AbortController();
  const sixth = turnInput([], []);
  sixth.surfaceTools = true;
  sixth.surfaceName = "zeta";
  sixth.cancel = cancelled.signal;
  const sixthRun = harness.turns.runTurn(sixth);
  const timed = turnInput([], []);
  timed.surfaceTools = true;
  timed.surfaceName = "eta";
  timed.turnWallClockMs = 40;
  const timedRun = harness.turns.runTurn(timed);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(fifthSettled, false);
  cancelled.abort();
  assert.equal((await sixthRun).stopped, true);
  await assert.rejects(timedRun, /wall clock/);
  releases.get("alpha")!();
  assert.ok((await running[0]!).reply.split(",").includes("alpha"));
  assert.ok((await fifthRun).reply.split(",").includes("epsilon"));
  for (const surfaceName of ["beta", "gamma", "delta"]) releases.get(surfaceName)!();
  const results = await Promise.all(running.slice(1));
  for (const [index, surfaceName] of ["alpha", "beta", "gamma", "delta"].entries()) {
    if (index > 0) assert.ok(results[index - 1]!.reply.split(",").includes(surfaceName));
  }
});

test("OpenCode close aborts a stuck active turn and finishes within its drain bound", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  const started = join(dir, "prompt-started");
  const handlers = `
  if (req.method === "POST" && message) {
    await readBody(req);
    require("node:fs").writeFileSync(${JSON.stringify(started)}, "started");
    return await new Promise(() => {});
  }
`;
  const harness = createOpenCodeHarness({ binaryPath: fakeSidecar(dir, "stuck-close", handlers) });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const running = harness.turns.runTurn(turnInput([], [])).then(
    () => "fulfilled" as const,
    () => "rejected" as const,
  );
  while (!existsSync(started)) await new Promise<void>((resolve) => setTimeout(resolve, 10));
  const beforeClose = Date.now();
  await harness.turns.close?.();
  assert.ok(Date.now() - beforeClose < 5_000);
  assert.equal(await running, "rejected");
  await assert.rejects(() => harness.turns.runTurn(turnInput([], [])), /harness is closed/);
});

test("OpenCode bounds a queued steer whose session status response never ends", async () => {
  let attempts = 0;
  const client = {
    session: {
      status: ({ signal }: { signal: AbortSignal }) => {
        attempts += 1;
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    },
  } as unknown as OpencodeClient;
  const startedAt = Date.now();
  await assert.rejects(waitForSessionIdle(client, "session", 30));
  assert.equal(attempts, 1);
  assert.ok(Date.now() - startedAt < 500);
  const abort = new AbortController();
  const pending = waitForSessionIdle(client, "session", 30_000, abort.signal);
  abort.abort();
  await assert.rejects(pending);
});

test("OpenCode bounds a queued steer whose prompt request never ends", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  const promptStarted = join(dir, "prompt-started");
  const steerStarted = join(dir, "steer-started");
  const handlers = `
  if (req.method === "POST" && url.pathname.endsWith("/prompt_async")) {
    require("node:fs").writeFileSync(${JSON.stringify(steerStarted)}, "started");
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{");
    return;
  }
  if (req.method === "POST" && message) {
    await readBody(req);
    require("node:fs").writeFileSync(${JSON.stringify(promptStarted)}, "started");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await capture(message[1], { system: "s", messages: [{ role: "user" }] });
    return json(res, ${okAssistant});
  }
  if (req.method === "GET" && message) return json(res, [${okAssistant}]);
`;
  const signals = createMemoryRunSignalStore();
  const harness = createOpenCodeHarness({ binaryPath: fakeSidecar(dir, "hung-steer", handlers), signals });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const turn = turnInput([], []);
  turn.runId = "hung-steer";
  turn.turnWallClockMs = 2_000;
  const running = harness.turns.runTurn(turn).then(
    () => "settled" as const,
    () => "settled" as const,
  );
  while (!existsSync(promptStarted)) await new Promise<void>((resolve) => setTimeout(resolve, 10));
  await signals.send(turn.runId, { kind: "steer", text: "queued steer" });
  while (!existsSync(steerStarted)) await new Promise<void>((resolve) => setTimeout(resolve, 10));
  const outcome = await Promise.race([
    running,
    new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 4_000)),
  ]);
  assert.equal(outcome, "settled");
});

test("OpenCode replaces a crashed leased runtime and releases its pool accounting", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  const crashed = join(dir, "crashed-once");
  const handlers = `
  if (req.method === "POST" && message) {
    await readBody(req);
    const fs = require("node:fs");
    if (!fs.existsSync(${JSON.stringify(crashed)})) {
      fs.writeFileSync(${JSON.stringify(crashed)}, "crashed");
      setImmediate(() => process.exit(17));
      return;
    }
    await capture(message[1], { system: "s", messages: [{ role: "user" }] });
    return json(res, ${okAssistant});
  }
  if (req.method === "GET" && message) return json(res, [${okAssistant}]);
`;
  const harness = createOpenCodeHarness({ binaryPath: fakeSidecar(dir, "crash-replace", handlers) });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  await assert.rejects(() => harness.turns.runTurn(turnInput([], [])));
  assert.equal((await harness.turns.runTurn(turnInput([], []))).reply, "hello from fake");
});

test("OpenCode routes each turn through the MCP snapshot leased with its runtime", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  const statePath = join(dir, "mcp-state");
  writeFileSync(statePath, "old");
  const mcpTools = () => {
    const capability = readFileSync(statePath, "utf8").trim();
    return [
      {
        name: "crm_query",
        serverId: "crm",
        remoteName: "query",
        description: "Query CRM",
        inputSchema: { type: "object" },
        readOnly: true,
        capability,
      },
    ];
  };
  const harness = createOpenCodeHarness({
    binaryPath: fakeSidecar(dir, "route-snapshot", routeSnapshotHandlers(statePath)),
    mcpTools,
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const turn = turnInput([], []);
  turn.tools = {
    async callMcpTool(capability: string) {
      return `capability:${capability}`;
    },
  } as unknown as HarnessTurnInput["tools"];
  const first = await harness.turns.runTurn(turn);
  assert.equal(first.reply, "capability:old");
  const second = await harness.turns.runTurn({ ...turn, session: { id: "session-2" } as Session });
  assert.equal(second.reply, "capability:new");
});

test("OpenCode startup failure reports the sidecar's real output and honors the configured timeout", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const noisy = join(dir, "noisy");
  writeFileSync(noisy, `#!/bin/sh\necho "FATAL: missing libfoo" >&2\nexec sleep 30\n`);
  chmodSync(noisy, 0o755);
  const noisyHarness = createOpenCodeHarness({ binaryPath: noisy, startupTimeoutMs: 400 });
  t.after(async () => noisyHarness.turns.close?.());
  await assert.rejects(noisyHarness.turns.runTurn(turnInput([], [])), (error: Error) => {
    assert.match(error.message, /did not start within \d+s/);
    assert.match(error.message, /FATAL: missing libfoo/);
    return true;
  });
  const silent = join(dir, "silent");
  writeFileSync(silent, `#!/bin/sh\nexec sleep 30\n`);
  chmodSync(silent, 0o755);
  const silentHarness = createOpenCodeHarness({ binaryPath: silent, startupTimeoutMs: 400 });
  t.after(async () => silentHarness.turns.close?.());
  await assert.rejects(silentHarness.turns.runTurn(turnInput([], [])), (error: Error) => {
    assert.match(error.message, /did not start within \d+s: \(no output\)/);
    return true;
  });
});

test("OpenCode cleans a sidecar that exits immediately after announcing its listener", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  const jailRecord = join(dir, "jail");
  const script = join(dir, "exit-after-listen.js");
  const binary = join(dir, "exit-after-listen");
  writeFileSync(
    script,
    `const fs = require("node:fs");
const port = Number((process.argv.find((arg) => arg.startsWith("--port=")) ?? "--port=0").slice(7));
fs.writeFileSync(${JSON.stringify(jailRecord)}, process.env.HOME);
process.stdout.write("opencode server listening on http://127.0.0.1:" + port + "\\n", () => process.exit(0));
`,
  );
  writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(binary, 0o755);
  const harness = createOpenCodeHarness({ binaryPath: binary, startupTimeoutMs: 1000 });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  await assert.rejects(() => harness.turns.runTurn(turnInput([], [])), /during startup/);
  const jail = readFileSync(jailRecord, "utf8");
  assert.equal(existsSync(jail), false);
});

test("OpenCode keeps the run's retry budget for an APIError the provider marks retryable", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  const retryableAssistant = erroredAssistant(
    `{ name: "APIError", data: { message: "overloaded", isRetryable: true } }`,
  );
  const harness = createOpenCodeHarness({
    binaryPath: fakeSidecar(dir, "retryable", promptHandlers(retryableAssistant)),
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  await assert.rejects(harness.turns.runTurn(turnInput([], [])), (error: Error) => {
    assert.equal(error.name, "Error");
    assert.match(error.message, /APIError.*overloaded/);
    return true;
  });
});

test("OpenCode delivers the truncated reply on an output-length error instead of parking the turn", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  const truncatedAssistant = okAssistant.replace(
    'finish: "stop",',
    'error: { name: "MessageOutputLengthError", data: {} },',
  );
  const harness = createOpenCodeHarness({
    binaryPath: fakeSidecar(dir, "output-length", promptHandlers(truncatedAssistant)),
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const result = await harness.turns.runTurn(turnInput([], []));
  assert.equal(result.reply, "hello from fake");
});

test("OpenCode treats an aborted assistant message as a quiet stop, not a failure", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  const abortedAssistant = erroredAssistant(`{ name: "MessageAbortedError", data: { message: "aborted" } }`);
  const harness = createOpenCodeHarness({
    binaryPath: fakeSidecar(dir, "aborted", promptHandlers(abortedAssistant)),
  });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const result = await harness.turns.runTurn(turnInput([], []));
  assert.equal(result.reply, "");
});

test("OpenCode records requests without usage attribution when captures and assistant messages misalign", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  const doubleCapture = `
  if (req.method === "POST" && message) {
    await readBody(req);
    await capture(message[1], { system: "s", messages: [{ role: "user" }] });
    await capture(message[1], { system: "s", messages: [{ role: "user" }, { role: "assistant" }] });
    return json(res, ${okAssistant});
  }
  if (req.method === "GET" && message) return json(res, [${okAssistant}]);
`;
  const harness = createOpenCodeHarness({ binaryPath: fakeSidecar(dir, "misaligned", doubleCapture) });
  t.after(async () => {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  const llmRows: HarnessLlmRequestRecord[] = [];
  const result = await harness.turns.runTurn(turnInput([], llmRows));
  assert.equal(result.reply, "hello from fake");
  assert.deepEqual(
    llmRows.map((row) => ({ step: row.step, usage: row.usage, durationMs: row.durationMs })),
    [
      { step: 0, usage: null, durationMs: null },
      { step: 1, usage: null, durationMs: null },
    ],
  );
});

test("latestAssistantParts skips errored and aborted messages, returning the latest successful reply", async () => {
  const stub = (messages: unknown[]) =>
    ({ session: { messages: async () => ({ data: messages }) } }) as unknown as OpencodeClient;
  const errored = {
    info: { role: "assistant", error: { name: "APIError", data: { message: "boom" } } },
    parts: [],
  };
  const aborted = {
    info: { role: "assistant", error: { name: "MessageAbortedError", data: { message: "aborted" } } },
    parts: [],
  };
  const ok = { info: { role: "assistant" }, parts: [{ type: "text", text: "fine" }] };
  assert.deepEqual(await latestAssistantParts(stub([ok, errored]), "s"), ok.parts);
  assert.deepEqual(await latestAssistantParts(stub([ok, aborted]), "s"), ok.parts);
  assert.equal(await latestAssistantParts(stub([errored]), "s"), null);
  assert.equal(await latestAssistantParts(stub([]), "s"), null);
});

test("assistantFailure classifies provider errors and exempts aborts and output-length truncation", () => {
  assert.deepEqual(
    assistantFailure({ role: "assistant", error: { name: "ProviderAuthError", data: { message: "bad key" } } }),
    { message: "OpenCode provider error (ProviderAuthError): bad key", retryable: false },
  );
  assert.deepEqual(
    assistantFailure({ role: "assistant", error: { name: "APIError", data: { message: "529", isRetryable: true } } }),
    { message: "OpenCode provider error (APIError): 529", retryable: true },
  );
  assert.deepEqual(
    assistantFailure({ role: "assistant", error: { name: "APIError", data: { message: "400", isRetryable: false } } }),
    { message: "OpenCode provider error (APIError): 400", retryable: false },
  );
  assert.deepEqual(
    assistantFailure({ role: "assistant", error: { name: "UnknownError", data: { message: "socket hang up" } } }),
    { message: "OpenCode provider error (UnknownError): socket hang up", retryable: true },
  );
  assert.equal(assistantFailure({ role: "assistant", error: { name: "MessageAbortedError" } }), null);
  assert.equal(assistantFailure({ role: "assistant", error: { name: "MessageOutputLengthError" } }), null);
  assert.equal(assistantFailure({ role: "assistant" }), null);
  assert.equal(assistantFailure(undefined), null);
});

test("custom providers materialize into the opencode config (enabled + provider map, key included)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-custom-"));
  const dump = join(dir, "config.json");
  const bin = fakeSidecar(dir, "custom", promptHandlers(okAssistant));
  const wrapped = join(dir, "custom-wrapped");
  writeFileSync(
    wrapped,
    `#!/bin/sh\nprintf '%s' "$OPENCODE_CONFIG_CONTENT" > ${JSON.stringify(dump)}\nexec ${JSON.stringify(bin)} "$@"\n`,
  );
  chmodSync(wrapped, 0o755);
  let customVersion = 1;
  let customBaseUrl = "http://litellm.internal:4000/v1";
  let customKey = "sk-lite";
  let resolveCalls = 0;
  const harness = createOpenCodeHarness({
    binaryPath: wrapped,
    customProvidersVersion: () => customVersion,
    resolveCustomProviders: async () => {
      resolveCalls += 1;
      return [
        {
          spec: {
            id: "litellm",
            name: "LiteLLM",
            protocol: "openai" as const,
            baseUrl: customBaseUrl,
            models: [{ id: "deepseek-chat", name: "DeepSeek", contextWindow: 128000, maxTokens: 8192 }],
          },
          apiKey: customKey,
        },
      ];
    },
  });
  const entries: SessionEntry[] = [];
  const llmRows: HarnessLlmRequestRecord[] = [];
  try {
    await harness.turns.runTurn(turnInput(entries, llmRows));
    const config = JSON.parse(readFileSync(dump, "utf8"));
    assert.ok(config.enabled_providers.includes("litellm"));
    const litellm = config.provider.litellm;
    assert.equal(litellm.npm, "@ai-sdk/openai-compatible");
    assert.equal(litellm.options.baseURL, "http://litellm.internal:4000/v1");
    assert.equal(litellm.options.apiKey, "sk-lite");
    assert.deepEqual(litellm.models["deepseek-chat"], { name: "DeepSeek", limit: { context: 128000, output: 8192 } });
    customBaseUrl = "http://litellm.internal:5000/v1";
    customKey = "sk-rotated";
    customVersion += 1;
    await harness.turns.runTurn(turnInput(entries, llmRows));
    const refreshed = JSON.parse(readFileSync(dump, "utf8"));
    assert.equal(refreshed.provider.litellm.options.baseURL, customBaseUrl);
    assert.equal(refreshed.provider.litellm.options.apiKey, customKey);
    assert.equal(resolveCalls, 2);
  } finally {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode rebuilds when custom providers change during sidecar startup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  const dump = join(dir, "startup-config.json");
  const started = join(dir, "startup-started");
  const release = join(dir, "startup-release");
  const bin = fakeSidecar(dir, "startup-custom", promptHandlers(okAssistant));
  const wrapped = join(dir, "startup-custom-wrapped");
  writeFileSync(
    wrapped,
    `#!/bin/sh
printf '%s' "$OPENCODE_CONFIG_CONTENT" > ${JSON.stringify(dump)}
if [ ! -f ${JSON.stringify(started)} ]; then
  touch ${JSON.stringify(started)}
  while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.01; done
fi
exec ${JSON.stringify(bin)} "$@"
`,
  );
  chmodSync(wrapped, 0o755);
  let customVersion = 1;
  let customKey = "sk-old";
  let resolveCalls = 0;
  const harness = createOpenCodeHarness({
    binaryPath: wrapped,
    customProvidersVersion: () => customVersion,
    resolveCustomProviders: async () => {
      resolveCalls += 1;
      return [
        {
          spec: {
            id: "litellm",
            name: "LiteLLM",
            protocol: "openai" as const,
            baseUrl: "http://litellm.internal/v1",
            models: [{ id: "deepseek-chat" }],
          },
          apiKey: customKey,
        },
      ];
    },
  });
  try {
    const firstInput = turnInput([], []);
    const cancel = new AbortController();
    firstInput.cancel = cancel.signal;
    const firstTurn = harness.turns.runTurn(firstInput);
    while (!existsSync(started)) await new Promise((resolve) => setTimeout(resolve, 10));
    customVersion = 2;
    customKey = "sk-new";
    cancel.abort();
    const secondTurn = harness.turns.runTurn(turnInput([], []));
    writeFileSync(release, "ready");
    assert.equal((await firstTurn).stopped, true);
    assert.equal((await secondTurn).reply, "hello from fake");
    const config = JSON.parse(readFileSync(dump, "utf8"));
    assert.equal(config.provider.litellm.options.apiKey, "sk-new");
    assert.equal(resolveCalls, 2);
  } finally {
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode keeps a runtime leased before its session becomes active", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-opencode-test-"));
  const dump = join(dir, "leased-config.json");
  const bin = fakeSidecar(dir, "leased-custom", promptHandlers(okAssistant));
  const wrapped = join(dir, "leased-custom-wrapped");
  writeFileSync(
    wrapped,
    `#!/bin/sh
printf '%s' "$OPENCODE_CONFIG_CONTENT" > ${JSON.stringify(dump)}
exec ${JSON.stringify(bin)} "$@"
`,
  );
  chmodSync(wrapped, 0o755);
  let customVersion = 1;
  let customKey = "sk-old";
  let resolveCalls = 0;
  const harness = createOpenCodeHarness({
    binaryPath: wrapped,
    customProvidersVersion: () => customVersion,
    resolveCustomProviders: async () => {
      resolveCalls += 1;
      return [
        {
          spec: {
            id: "litellm",
            name: "LiteLLM",
            protocol: "openai" as const,
            baseUrl: "http://litellm.internal/v1",
            models: [{ id: "deepseek-chat" }],
          },
          apiKey: customKey,
        },
      ];
    },
  });
  let releaseEmit!: () => void;
  const emitGate = new Promise<void>((resolve) => {
    releaseEmit = resolve;
  });
  let emitStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    emitStarted = resolve;
  });
  try {
    const firstInput = turnInput([], []);
    const originalEmit = firstInput.emit;
    firstInput.emit = async (entry) => {
      if (entry.type === "user") {
        emitStarted();
        await emitGate;
      }
      return originalEmit(entry);
    };
    const firstTurn = harness.turns.runTurn(firstInput);
    await started;
    customVersion = 2;
    customKey = "sk-new";
    let secondSettled = false;
    const secondTurn = harness.turns.runTurn(turnInput([], [])).finally(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(secondSettled, false);
    releaseEmit();
    assert.equal((await firstTurn).reply, "hello from fake");
    assert.equal((await secondTurn).reply, "hello from fake");
    const config = JSON.parse(readFileSync(dump, "utf8"));
    assert.equal(config.provider.litellm.options.apiKey, "sk-new");
    assert.equal(resolveCalls, 2);
  } finally {
    releaseEmit();
    await harness.turns.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});
