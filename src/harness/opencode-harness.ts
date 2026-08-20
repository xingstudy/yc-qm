import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sanitizeTitle, TITLE_GENERATION_PROMPT, titleUserPrompt } from "./pi-harness.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { CONFIG_DEFAULTS, type Config } from "../config.ts";
import { isCustomModelId } from "../model/custom-providers.ts";
import type { CustomProviderSpec } from "../model/custom-providers.ts";
import { DEFAULT_AGENT_MODEL_ID, resolveModel } from "../model/pi-models.ts";
import { startSignalPoll, type RunSignalStore } from "../runs/run-signal-store.ts";
import type { LlmCallUsage } from "../sessions/session-store.ts";
import type { ScopeId, SessionEntry } from "../types.ts";
import type { TaskStore } from "../tasks/task-store.ts";
import { errMessage, swallow } from "../util/errors.ts";
import { sleep } from "../util/async.ts";
import { NonRetryableTurnError } from "../core/turn-error.ts";
import {
  defineHarness,
  envelopeWithoutMessages,
  type Harness,
  type HarnessTurnInput,
  type HarnessTurnResult,
} from "./harness.ts";
import { coreToolOptions, createPiTools, type PiToolsOptions, type ToolContextRef } from "./pi-tools.ts";
import type { McpToolDescriptor } from "../mcp/mcp-tool-service.ts";
import { reconstructMessagesFromHistory } from "./replay.ts";
import { parseSecurityScreenVerdict, SECURITY_SCREEN_SYSTEM_PROMPT } from "../security/security-posture.ts";
import { countTokens } from "../util/tokens.ts";

const OPENCODE_VERSION = "1.17.18";
const OPENCODE_IDLE_WAIT_MS = 30 * 60_000;
const OPENCODE_RUNTIME_POOL_LIMIT = 4;
const OPENCODE_CLOSE_DRAIN_MS = 2_000;
export const OPENCODE_STARTUP_TIMEOUT_MS = 90_000;

class OpenCodeTurnCancelled extends Error {}

class OpenCodeTurnDeadlineExceeded extends NonRetryableTurnError {}

export interface OpenCodeHarnessOptions {
  modelId?: string | ((scope?: ScopeId) => string | undefined);
  defaultModelId?: string;
  apiKey?: string;
  openaiApiKey?: string;
  scratchExec?: boolean;
  ownerAuthExec?: boolean;
  reachExec?: boolean;
  mcpTools?: () => McpToolDescriptor[];
  controlTools?: boolean;
  turnWallClockMs?: number;
  execTimeoutMs?: number;
  execTimeoutCeilingMs?: number;
  backgroundJobTtlMs?: number;
  backgroundJobTtlMaxMs?: number;
  signals?: RunSignalStore;
  binaryPath?: string;
  startupTimeoutMs?: number;
  tasks?: TaskStore;
  resolveCustomProviders?: () => Promise<Array<{ spec: CustomProviderSpec; apiKey?: string }>>;
  customProvidersVersion?: () => number;
}

export function openCodeHarnessConfigOptions(config: Config): OpenCodeHarnessOptions {
  return {
    ...(config.modelId ? { defaultModelId: config.modelId } : {}),
    ...(config.anthropicApiKey ? { apiKey: config.anthropicApiKey } : {}),
    ...(config.openaiApiKey ? { openaiApiKey: config.openaiApiKey } : {}),
    ...coreToolOptions(config),
    turnWallClockMs: config.turnWallClockMs,
  };
}

type BridgedTool = {
  name: string;
  description: string;
  parameters: unknown;
  execute(callId: string, args: unknown): Promise<{ content?: Array<{ type?: string; text?: string }> }>;
};

type LlmCapture = { sessionId: string; step: number; model: string; request: unknown; at: number };

type ActiveTurn = {
  turn: HarnessTurnInput;
  ref: ToolContextRef;
  tools: Map<string, BridgedTool>;
  system: string;
  history: unknown[];
  userSeq: number | null;
  captures: LlmCapture[];
  model: string;
  seenText: Map<string, string>;
  seenTasks: Map<string, string>;
  eventTail: Promise<void>;
  stopped: boolean;
  child: boolean;
};

type Runtime = {
  client: OpencodeClient;
  process: ChildProcess;
  bridge: ReturnType<typeof createServer>;
  jail: string;
  bridgeUrl: string;
  customProvidersVersion: number;
  definitionKey: string;
  definitionNames: string[];
  mcpTools: McpToolDescriptor[];
  toolContract: BridgeToolContract;
  lastUsed: number;
  namespace: string;
  close(): Promise<void>;
};

type BridgeToolContract = Pick<
  HarnessTurnInput,
  "readOnly" | "surfaceTools" | "surfaceName" | "credentialExecServices"
>;

function toolOptions(
  opts: OpenCodeHarnessOptions,
  turn?: BridgeToolContract,
  mcpTools: (() => McpToolDescriptor[]) | undefined = opts.mcpTools,
): PiToolsOptions {
  return {
    scratchExec: opts.scratchExec,
    ownerAuthExec: opts.ownerAuthExec,
    reachExec: opts.reachExec,
    ...(mcpTools ? { mcpTools } : {}),
    controlTools: opts.controlTools,
    execTimeoutMs: opts.execTimeoutMs,
    execTimeoutCeilingMs: opts.execTimeoutCeilingMs,
    backgroundJobTtlMs: opts.backgroundJobTtlMs,
    backgroundJobTtlMaxMs: opts.backgroundJobTtlMaxMs,
    ...(turn
      ? {
          readOnly: turn.readOnly,
          surfaceTools: turn.surfaceTools,
          surfaceName: turn.surfaceName,
          credentialExecServices: turn.credentialExecServices,
        }
      : { surfaceTools: true, surfaceName: "slack" }),
  };
}

function asTools(ref: ToolContextRef, options: PiToolsOptions): BridgedTool[] {
  return createPiTools(ref, options) as unknown as BridgedTool[];
}

type BridgeDefinition = { name: string; description: string; parameters: unknown };

type BridgeDefinitionSnapshot = {
  definitions: BridgeDefinition[];
  key: string;
  mcpTools: McpToolDescriptor[];
  toolContract: BridgeToolContract;
};

const OPENCODE_RESERVED_TOOL_NAMES = new Set([
  "task",
  "read",
  "write",
  "bash",
  "edit",
  "apply_patch",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "codesearch",
  "patch",
  "question",
  "skill",
  "todowrite",
  "todoread",
  "workspace_execute",
  "workspace_read",
  "workspace_write",
]);

export function bridgeToolName(name: string): string {
  if (name === "execute") return "workspace_execute";
  if (name === "read") return "workspace_read";
  if (name === "write") return "workspace_write";
  return name;
}

function bridgeTools(ref: ToolContextRef, options: PiToolsOptions): BridgedTool[] {
  const seen = new Set<string>();
  return asTools(ref, options).filter((tool) => {
    const name = bridgeToolName(tool.name);
    if (seen.has(name) || (OPENCODE_RESERVED_TOOL_NAMES.has(name) && !["execute", "read", "write"].includes(tool.name)))
      return false;
    seen.add(name);
    return true;
  });
}

function bridgeDefinitionSnapshot(opts: OpenCodeHarnessOptions, turn: HarnessTurnInput): BridgeDefinitionSnapshot {
  const ref: ToolContextRef = { current: null };
  const mcpTools = structuredClone(opts.mcpTools?.() ?? []);
  const mcpToolSnapshot = () => mcpTools;
  const toolContract: BridgeToolContract = {
    readOnly: turn.readOnly,
    surfaceTools: turn.surfaceTools,
    surfaceName: turn.surfaceName,
    ...(turn.credentialExecServices ? { credentialExecServices: structuredClone(turn.credentialExecServices) } : {}),
  };
  const definitions = bridgeTools(ref, toolOptions(opts, toolContract, mcpToolSnapshot)).map((tool) => {
    const name = bridgeToolName(tool.name);
    return { name, description: tool.description, parameters: tool.parameters };
  });
  return { definitions, key: JSON.stringify({ definitions, mcpTools, toolContract }), mcpTools, toolContract };
}

function activeBridgeTools(
  ref: ToolContextRef,
  opts: OpenCodeHarnessOptions,
  runtime: Pick<Runtime, "mcpTools" | "toolContract">,
): BridgedTool[] {
  return bridgeTools(
    ref,
    toolOptions(opts, runtime.toolContract, () => runtime.mcpTools),
  );
}

function body(req: IncomingMessage, max = 16 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
    req.resume();
  });
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function bearer(req: IncomingMessage): string {
  return String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
}

function equalSecret(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sessionToken(secret: string, sessionId: string): string {
  return createHmac("sha256", secret).update(sessionId).digest("base64url");
}

export function modelRef(id: string): { providerID: string; modelID: string } {
  // A registered custom model wins before slash-splitting: gateway model ids
  // routinely contain slashes (e.g. "bedrock/claude-x" behind LiteLLM), and
  // those must route to the registered provider, not a phantom "bedrock".
  if (isCustomModelId(id)) {
    const resolved = resolveModel(id);
    if (resolved?.provider) return { providerID: String(resolved.provider), modelID: id };
  }
  const slash = id.indexOf("/");
  if (slash > 0) return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) };
  const resolved = resolveModel(id);
  return { providerID: String(resolved?.provider ?? (id.startsWith("gpt-") ? "openai" : "anthropic")), modelID: id };
}

function stripDataUrls(message: unknown): unknown {
  const m = message as { parts?: unknown[] };
  if (!m || !Array.isArray(m.parts)) return message;
  const parts = m.parts.map((part) => {
    const p = part as { url?: unknown };
    if (typeof p?.url !== "string" || !p.url.startsWith("data:")) return part;
    const { url: _url, ...rest } = p;
    return { ...rest, omitted: true };
  });
  return { ...(message as Record<string, unknown>), parts };
}

function replayMessages(
  source: ReturnType<typeof reconstructMessagesFromHistory>,
  sessionId: string,
  model: { providerID: string; modelID: string },
): unknown[] {
  const output: unknown[] = [];
  let index = 0;
  const id = (prefix: string) => `${prefix}_${sessionId}_${index++}`;
  for (let i = 0; i < source.length; i++) {
    const message = source[i]!;
    if (message.role === "user") {
      const messageID = id("msg");
      output.push({
        info: {
          id: messageID,
          sessionID: sessionId,
          role: "user",
          time: { created: message.timestamp },
          agent: "qm",
          model,
        },
        parts: message.content.map((part) => ({
          id: id("part"),
          sessionID: sessionId,
          messageID,
          type: "text",
          text: part.text,
        })),
      });
      continue;
    }
    if (message.role !== "assistant") continue;
    const messageID = id("msg");
    const parts: unknown[] = [];
    for (const part of message.content) {
      if (part.type === "text") {
        parts.push({ id: id("part"), sessionID: sessionId, messageID, type: "text", text: part.text });
        continue;
      }
      const result = source[i + 1];
      const paired = result?.role === "toolResult" && result.toolCallId === part.id ? result : null;
      if (paired) i++;
      parts.push({
        id: id("part"),
        sessionID: sessionId,
        messageID,
        type: "tool",
        callID: part.id,
        tool: bridgeToolName(part.name),
        state: paired?.isError
          ? {
              status: "error",
              input: part.arguments,
              error: paired.content.map((item) => item.text).join("\n"),
              time: { start: message.timestamp, end: paired.timestamp },
            }
          : {
              status: "completed",
              input: part.arguments,
              output: paired?.content.map((item) => item.text).join("\n") ?? "",
              title: part.name,
              metadata: {},
              time: { start: message.timestamp, end: paired?.timestamp ?? message.timestamp },
            },
      });
    }
    output.push({
      info: {
        id: messageID,
        sessionID: sessionId,
        role: "assistant",
        time: { created: message.timestamp, completed: message.timestamp },
        parentID: "",
        modelID: model.modelID,
        providerID: model.providerID,
        mode: "qm",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      },
      parts,
    });
  }
  return output;
}

function textFromParts(parts: unknown[]): string {
  return parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        Boolean(part) &&
        (part as { type?: string }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("")
    .trim();
}

function reasoningFromParts(parts: unknown[]): Array<{ thinking: string }> {
  return parts.flatMap((part) => {
    const value = part as { type?: string; text?: unknown };
    return value?.type === "reasoning" && typeof value.text === "string" && value.text.trim()
      ? [{ thinking: value.text }]
      : [];
  });
}

async function waitForServer(proc: ChildProcess, timeoutMs: number): Promise<string> {
  return await new Promise((resolveUrl, reject) => {
    let output = "";
    const diagnostics = () => output.trim().slice(-4096) || "(no output)";
    const cleanup = () => {
      clearTimeout(timer);
      proc.stdout?.off("data", onChunk);
      proc.stderr?.off("data", onChunk);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `OpenCode ${OPENCODE_VERSION} did not start within ${Math.round(timeoutMs / 1000)}s: ${diagnostics()}`,
        ),
      );
    }, timeoutMs);
    const onChunk = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/opencode server listening.*?on\s+(https?:\/\/[^\s]+)/);
      if (!match) return;
      cleanup();
      resolveUrl(match[1]!);
    };
    proc.stdout?.on("data", onChunk);
    proc.stderr?.on("data", onChunk);
    proc.once("error", (error) => {
      cleanup();
      reject(error);
    });
    proc.once("exit", (code) => {
      cleanup();
      reject(new Error(`OpenCode exited during startup (${code}): ${diagnostics()}`));
    });
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to reserve OpenCode port");
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

export async function waitForSessionIdle(
  client: OpencodeClient,
  sessionId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const timeout = AbortSignal.timeout(remaining);
    const response = await client.session.status({
      throwOnError: true,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const status = response.data?.[sessionId] as { type?: string } | undefined;
    if (!status || status.type === "idle") return;
    await sleep(100);
  }
  throw new Error("OpenCode queued steer did not settle before the turn deadline");
}

type AssistantMessageInfo = {
  role?: string;
  error?: { name?: string; data?: { message?: string; isRetryable?: boolean } };
  providerID?: string;
  modelID?: string;
  time?: { created?: number; completed?: number };
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  cost?: number;
};

export function assistantFailure(
  info: AssistantMessageInfo | undefined,
): { message: string; retryable: boolean } | null {
  const error = info?.error;
  if (!error || error.name === "MessageAbortedError" || error.name === "MessageOutputLengthError") return null;
  const detail = typeof error.data?.message === "string" ? error.data.message.trim() : "";
  const terminal =
    error.name === "ProviderAuthError" || (error.name === "APIError" && error.data?.isRetryable === false);
  return {
    message: `OpenCode provider error (${error.name ?? "unknown"})${detail ? `: ${detail}` : ""}`,
    retryable: !terminal,
  };
}

function throwAssistantFailure(info: AssistantMessageInfo | undefined): void {
  const failure = assistantFailure(info);
  if (!failure) return;
  throw failure.retryable ? new Error(failure.message) : new NonRetryableTurnError(failure.message);
}

function usageFromInfo(info: AssistantMessageInfo | undefined): LlmCallUsage | null {
  const tokens = info?.tokens;
  if (!tokens) return null;
  const input = tokens.input ?? 0;
  const output = tokens.output ?? 0;
  const reasoning = tokens.reasoning ?? 0;
  const cacheRead = tokens.cache?.read ?? 0;
  const cacheWrite = tokens.cache?.write ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + reasoning + cacheRead + cacheWrite,
    costUsd: info?.cost ?? 0,
  };
}

export async function latestAssistantParts(client: OpencodeClient, sessionId: string): Promise<unknown[] | null> {
  const response = await client.session.messages({ path: { id: sessionId } });
  const messages = response.data ?? [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { info?: AssistantMessageInfo; parts?: unknown[] };
    if (message.info?.role !== "assistant") continue;
    if (assistantFailure(message.info) || message.info.error?.name === "MessageAbortedError") continue;
    return message.parts ?? [];
  }
  return null;
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function terminateProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => proc.once("exit", () => resolveExit()));
  proc.kill("SIGTERM");
  const stopped = await Promise.race([exited.then(() => true), sleep(2_000).then(() => false as const)]);
  if (!stopped && proc.exitCode === null && proc.signalCode === null) {
    proc.kill("SIGKILL");
    await exited;
  }
}

export function createOpenCodeHarness(opts: OpenCodeHarnessOptions = {}): Harness {
  const active = new Map<string, ActiveTurn>();
  const bridgeSecret = randomBytes(32).toString("base64url");
  const configuredModel = opts.modelId;
  const resolveModelId = (scope?: ScopeId) =>
    (typeof configuredModel === "function" ? configuredModel(scope) : configuredModel) ??
    opts.defaultModelId ??
    DEFAULT_AGENT_MODEL_ID;
  const defaultTurnWallClockMs = opts.turnWallClockMs ?? CONFIG_DEFAULTS.turnWallClockSec * 1000;
  const runtimes = new Map<string, Runtime>();
  const starting = new Map<string, Promise<Runtime>>();
  const startingProcesses = new Set<ChildProcess>();
  let auxiliaryHarness: Harness | null = null;
  let closed = false;
  let closing: Promise<void> | null = null;
  const runtimeUsers = new Map<Runtime, number>();
  const leaseDrains = new Set<() => void>();
  const activeTurnAborts = new Set<() => Promise<void>>();
  let reservedRuntimeSlots = 0;
  let processingRuntimeWaiters = false;
  type RuntimeWaiter = {
    turn: HarnessTurnInput;
    deadline: number | null;
    wallMs: number;
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    timer?: NodeJS.Timeout;
    onCancel?: () => void;
    settled: boolean;
  };
  const runtimeWaiters: RuntimeWaiter[] = [];
  const runtimeKey = (customProvidersVersion: number, definitionKey: string) =>
    `${customProvidersVersion}:${definitionKey}`;
  const signalLeases = () => {
    if ([...runtimeUsers.values()].some((users) => users > 0)) return;
    for (const resolve of leaseDrains) resolve();
    leaseDrains.clear();
  };
  const leaseRuntime = (leased: Runtime) => {
    runtimeUsers.set(leased, (runtimeUsers.get(leased) ?? 0) + 1);
    leased.lastUsed = Date.now();
    let released = false;
    return {
      runtime: leased,
      release() {
        if (released) return;
        released = true;
        const users = Math.max(0, (runtimeUsers.get(leased) ?? 1) - 1);
        if (users === 0 && ![...runtimes.values()].includes(leased)) runtimeUsers.delete(leased);
        else runtimeUsers.set(leased, users);
        leased.lastUsed = Date.now();
        signalLeases();
        void processRuntimeWaiters();
      },
    };
  };

  const childState = (parent: ActiveTurn): ActiveTurn => ({
    ...parent,
    child: true,
    seenText: new Map(),
    seenTasks: new Map(),
    eventTail: Promise.resolve(),
  });

  const activeKey = (namespace: string, sessionId: string) => `${namespace}:${sessionId}`;

  const processEvent = async (namespace: string, event: unknown): Promise<void> => {
    const payload = (event as { payload?: unknown }).payload as
      { type?: string; properties?: Record<string, unknown> } | undefined;
    if (payload?.type === "session.created") {
      const info = payload.properties?.info as { id?: string; parentID?: string } | undefined;
      const parent = info?.parentID ? active.get(activeKey(namespace, info.parentID)) : undefined;
      if (info?.id && parent) active.set(activeKey(namespace, info.id), childState(parent));
      return;
    }
    if (payload?.type !== "message.part.updated") return;
    const part = payload.properties?.part as Record<string, unknown> | undefined;
    const sessionID = typeof part?.sessionID === "string" ? part.sessionID : "";
    const state = active.get(activeKey(namespace, sessionID));
    if (!state || !part) return;
    const operation = state.eventTail.then(async () => {
      if (part.type === "text" && typeof payload.properties?.delta === "string" && !state.child) {
        const partId = String(part.id ?? "");
        const snapshot = typeof part.text === "string" ? part.text : "";
        const delta =
          typeof payload.properties?.delta === "string"
            ? payload.properties.delta
            : snapshot.slice((state.seenText.get(partId) ?? "").length);
        if (!state.seenText.has(partId)) state.turn.onTextBlockStart?.();
        state.seenText.set(partId, snapshot);
        if (delta) state.turn.onDelta?.(delta);
      }
      if (part.type !== "tool" || part.tool !== "task") return;
      const partId = String(part.id ?? "");
      const toolState = part.state as Record<string, unknown> | undefined;
      const status = typeof toolState?.status === "string" ? toolState.status : "";
      let prior = state.seenTasks.get(partId);
      if (!prior && ["pending", "running", "completed", "error"].includes(status)) {
        const input = (toolState?.input ?? {}) as Record<string, unknown>;
        const suppliedTitle = [input.description, input.prompt].find(
          (value) => typeof value === "string" && value.trim(),
        ) as string | undefined;
        if (!suppliedTitle && status === "pending") return;
        const initialStatus = status === "running" ? "in_progress" : "pending";
        if (opts.tasks) {
          await opts.tasks
            .create({
              id: partId,
              sessionId: state.turn.session.id,
              originRunId: state.turn.runId ?? state.turn.session.id,
              title: suppliedTitle?.trim() ?? "subagent task",
              status: initialStatus,
            })
            .catch(() => undefined);
        }
        await state.turn.emit({
          type: "tool_call",
          payload: { tool: "task", callId: part.callID, ...(toolState?.input as object) },
          scopeLabel: state.turn.scopeLabel,
        });
        prior = status === "running" ? "running" : "pending";
        state.seenTasks.set(partId, prior);
      }
      if (prior !== status && (status === "completed" || status === "error")) {
        const result =
          status === "completed" ? String(toolState?.output ?? "") : String(toolState?.error ?? "task failed");
        if (opts.tasks) {
          const current = await opts.tasks.get(partId);
          if (current)
            await opts.tasks.transitionStatus(
              partId,
              current.status,
              status === "completed" ? "completed" : "failed",
              state.turn.runId ?? state.turn.session.id,
            );
        }
        await state.turn.emit({
          type: "tool_result",
          payload: { tool: "task", callId: part.callID, result, isError: status === "error" },
          scopeLabel: state.turn.scopeLabel,
        });
      }
      state.seenTasks.set(partId, status);
    });
    state.eventTail = operation.catch(() => undefined);
    await operation;
  };

  const startRuntime = (
    customProvidersVersion: number,
    definitionSnapshot: BridgeDefinitionSnapshot,
  ): Promise<Runtime> => {
    return (async () => {
      const jail = mkdtempSync(join(tmpdir(), "qm-opencode-"));
      const namespace = randomBytes(12).toString("base64url");
      let bridgeClient: OpencodeClient | undefined;
      const bridge = createServer(async (req, res) => {
        try {
          const url = new URL(req.url ?? "/", "http://127.0.0.1");
          if (url.pathname === "/definitions") {
            if (!equalSecret(bearer(req), bridgeSecret)) return json(res, 401, { error: "unauthorized" });
            return json(res, 200, definitionSnapshot.definitions);
          }
          const sessionMatch = /^\/session\/([^/]+)\/(context|tool|capture)$/.exec(url.pathname);
          if (sessionMatch) {
            if (!equalSecret(bearer(req), bridgeSecret)) return json(res, 401, { error: "unauthorized" });
            const requestedSessionId = decodeURIComponent(sessionMatch[1]!);
            let state = active.get(activeKey(namespace, requestedSessionId));
            if (!state && bridgeClient) {
              const session = await bridgeClient.session.get({ path: { id: requestedSessionId } }).catch(() => null);
              const parentId = session?.data?.parentID;
              const parent = parentId ? active.get(activeKey(namespace, parentId)) : undefined;
              if (parent) {
                state = childState(parent);
                active.set(activeKey(namespace, requestedSessionId), state);
              }
            }
            if (!state) return json(res, 404, { error: "inactive session" });
            if (sessionMatch[2] === "context")
              return json(res, 200, {
                ...(state.child ? {} : { systemPrompt: state.system, history: state.history }),
                proxyHeaders: {
                  "x-qm-session": sessionMatch[1],
                  "x-qm-token": sessionToken(bridgeSecret, sessionMatch[1]!),
                },
              });
            if (sessionMatch[2] === "capture") {
              const request = JSON.parse((await body(req)).toString("utf8")) as Record<string, unknown>;
              const model = state.model;
              state.captures.push({
                sessionId: requestedSessionId,
                step: state.captures.length,
                model,
                request,
                at: Date.now(),
              });
              state.turn.recordModelCall({
                model,
                inputTokens: countTokens(JSON.stringify(request)),
                entryCount: state.turn.history.length,
              });
              return json(res, 200, { ok: true });
            }
            const input = JSON.parse((await body(req)).toString("utf8")) as {
              tool?: string;
              callID?: string;
              args?: unknown;
            };
            const tool = input.tool ? state.tools.get(input.tool) : undefined;
            if (!tool) return json(res, 404, { output: `[tool unavailable: ${input.tool ?? "unknown"}]` });
            try {
              const result = await tool.execute(input.callID ?? randomBytes(8).toString("hex"), input.args ?? {});
              const output = (result.content ?? [])
                .filter((item) => item.type === "text")
                .map((item) => item.text ?? "")
                .join("\n");
              return json(res, 200, {
                output,
                terminate: Boolean(state.ref.pausedOnApproval || state.ref.silentRequested),
              });
            } catch (error) {
              return json(res, 200, { output: `[tool failed] ${errMessage(error)}` });
            }
          }
          return json(res, 404, { error: "not found" });
        } catch (error) {
          json(res, 500, { error: errMessage(error) });
        }
      });
      let proc: ChildProcess | null = null;
      let abortEvents: AbortController | undefined;
      let published: { key: string; runtime: Runtime } | null = null;
      try {
        await new Promise<void>((resolveListen, reject) => {
          bridge.once("error", reject);
          bridge.listen(0, "127.0.0.1", () => resolveListen());
        });
        const address = bridge.address();
        if (!address || typeof address === "string") throw new Error("failed to bind OpenCode bridge");
        const bridgeUrl = `http://127.0.0.1:${address.port}`;
        const pluginUrl = pathToFileURL(join(import.meta.dirname, "opencode-plugin.ts")).href;
        const enabledTools = Object.fromEntries(definitionSnapshot.definitions.map((item) => [item.name, true]));
        const custom = (await opts.resolveCustomProviders?.()) ?? [];
        if (closed) throw new Error("OpenCode harness is closed");
        const customProviderConfig = Object.fromEntries(
          custom.map(({ spec, apiKey }) => [
            spec.id,
            {
              npm: spec.protocol === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible",
              name: spec.name,
              options: { baseURL: spec.baseUrl, ...(apiKey ? { apiKey } : {}) },
              models: Object.fromEntries(
                spec.models.map((m) => [
                  m.id,
                  {
                    name: m.name ?? m.id,
                    ...(m.contextWindow || m.maxTokens
                      ? {
                          limit: {
                            context: m.contextWindow ?? 128_000,
                            output: m.maxTokens ?? 8_192,
                          },
                        }
                      : {}),
                  },
                ]),
              ),
            },
          ]),
        );
        const config = {
          plugin: [pluginUrl],
          autoupdate: false,
          share: "disabled",
          snapshot: false,
          lsp: false,
          formatter: false,
          instructions: [],
          enabled_providers: ["anthropic", "openai", ...custom.map(({ spec }) => spec.id)],
          provider: {
            anthropic: { options: { apiKey: opts.apiKey ?? "" } },
            openai: { options: { apiKey: opts.openaiApiKey ?? "" } },
            ...customProviderConfig,
          },
          tools: {
            ...enabledTools,
            task: true,
            read: false,
            write: false,
            bash: false,
            edit: false,
            apply_patch: false,
            glob: false,
            grep: false,
            webfetch: false,
            websearch: false,
            codesearch: false,
            patch: false,
            question: false,
            skill: false,
            todowrite: false,
            todoread: false,
          },
          permission: {
            read: "deny",
            write: "deny",
            edit: "deny",
            apply_patch: "deny",
            bash: "deny",
            glob: "deny",
            grep: "deny",
            webfetch: "deny",
            websearch: "deny",
            external_directory: "deny",
            doom_loop: "deny",
          },
          agent: {
            qm: { mode: "primary", prompt: "", tools: { ...enabledTools, task: true } },
            research: {
              mode: "subagent",
              description: "Research a bounded question and report evidence.",
              prompt: "Complete only the delegated research task.",
              tools: { ...enabledTools, task: false },
            },
            code: {
              mode: "subagent",
              description: "Implement or inspect a bounded code task.",
              prompt: "Complete only the delegated code task.",
              tools: { ...enabledTools, task: false },
            },
            consult: {
              mode: "subagent",
              description: "Provide an independent expert analysis.",
              prompt: "Complete only the delegated consultation.",
              tools: { ...enabledTools, task: false },
            },
          },
        };
        const binary = opts.binaryPath ?? resolve(import.meta.dirname, "../../node_modules/.bin/opencode");
        const cleanEnv: NodeJS.ProcessEnv = {
          PATH: `${resolve(import.meta.dirname, "../../node_modules/.bin")}:/usr/local/bin:/usr/bin:/bin`,
          HOME: jail,
          TMPDIR: jail,
          XDG_CONFIG_HOME: join(jail, ".config"),
          XDG_DATA_HOME: join(jail, ".data"),
          XDG_CACHE_HOME: join(jail, ".cache"),
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
          OPENCODE_BRIDGE_URL: bridgeUrl,
          OPENCODE_BRIDGE_SECRET: bridgeSecret,
        };
        const sidecarPort = await freePort();
        const startupTimeoutMs = opts.startupTimeoutMs ?? OPENCODE_STARTUP_TIMEOUT_MS;
        const startupDeadline = Date.now() + startupTimeoutMs;
        proc = spawn(binary, ["serve", "--hostname=127.0.0.1", `--port=${sidecarPort}`, "--log-level=ERROR"], {
          cwd: jail,
          env: cleanEnv,
          stdio: ["ignore", "pipe", "pipe"],
        });
        startingProcesses.add(proc);
        proc.once("exit", () => {
          startingProcesses.delete(proc!);
          abortEvents?.abort();
          if (published && runtimes.get(published.key) === published.runtime) {
            runtimes.delete(published.key);
            if ((runtimeUsers.get(published.runtime) ?? 0) === 0) runtimeUsers.delete(published.runtime);
            signalLeases();
            void processRuntimeWaiters();
          }
          bridge.close();
          rmSync(jail, { recursive: true, force: true });
        });
        const serverUrl = await waitForServer(proc, startupTimeoutMs);
        startingProcesses.delete(proc);
        proc.stdout?.resume();
        proc.stderr?.on("data", (chunk: Buffer) => console.error(`[opencode] ${chunk.toString().trimEnd()}`));
        const client = createOpencodeClient({ baseUrl: serverUrl, directory: jail });
        try {
          await client.session.status({
            throwOnError: true,
            signal: AbortSignal.timeout(Math.max(1, startupDeadline - Date.now())),
          });
        } catch (error) {
          throw new Error(`OpenCode failed readiness check during startup: ${errMessage(error)}`, { cause: error });
        }
        if (proc.exitCode !== null || proc.signalCode !== null) throw new Error("OpenCode exited during startup");
        bridgeClient = client;
        const events = new AbortController();
        abortEvents = events;
        void (async () => {
          while (!events.signal.aborted) {
            try {
              const stream = await client.global.event({ signal: events.signal });
              for await (const event of stream.stream) {
                try {
                  await processEvent(namespace, event);
                } catch (error) {
                  swallow("opencode event", error);
                }
              }
              if (!events.signal.aborted) await sleep(100);
            } catch (error) {
              if (!events.signal.aborted) {
                swallow("opencode event stream", error);
                await sleep(100);
              }
            }
          }
        })();
        const created: Runtime = {
          client,
          process: proc,
          bridge,
          jail,
          bridgeUrl,
          customProvidersVersion,
          definitionKey: definitionSnapshot.key,
          definitionNames: definitionSnapshot.definitions.map((definition) => definition.name),
          mcpTools: definitionSnapshot.mcpTools,
          toolContract: definitionSnapshot.toolContract,
          lastUsed: Date.now(),
          namespace,
          async close() {
            events.abort();
            await terminateProcess(proc!);
            await closeServer(bridge);
            rmSync(jail, { recursive: true, force: true });
          },
        };
        const key = runtimeKey(customProvidersVersion, definitionSnapshot.key);
        if (closed) {
          await created.close();
          throw new Error("OpenCode harness is closed");
        }
        published = { key, runtime: created };
        runtimes.set(key, created);
        return created;
      } catch (error) {
        if (proc) {
          startingProcesses.delete(proc);
          await terminateProcess(proc);
        }
        await closeServer(bridge);
        rmSync(jail, { recursive: true, force: true });
        throw error;
      }
    })();
  };

  const deadlineError = (wallMs: number) =>
    new OpenCodeTurnDeadlineExceeded(`OpenCode turn exceeded ${Math.max(1, Math.round(wallMs / 1000))}s wall clock`);

  const settleRuntimeWaiter = (waiter: RuntimeWaiter, error?: unknown, release?: () => void) => {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.onCancel) waiter.turn.cancel?.removeEventListener("abort", waiter.onCancel);
    const index = runtimeWaiters.indexOf(waiter);
    if (index >= 0) runtimeWaiters.splice(index, 1);
    if (error !== undefined) waiter.reject(error);
    else waiter.resolve(release!);
  };

  const rejectRuntimeWaiters = (error: Error) => {
    for (const waiter of [...runtimeWaiters]) settleRuntimeWaiter(waiter, error);
  };

  async function processRuntimeWaiters(): Promise<void> {
    if (processingRuntimeWaiters) return;
    processingRuntimeWaiters = true;
    try {
      while (runtimeWaiters.length > 0) {
        const waiter = runtimeWaiters[0]!;
        if (waiter.settled) {
          runtimeWaiters.shift();
          continue;
        }
        if (closed) {
          settleRuntimeWaiter(waiter, new Error("OpenCode harness is closed"));
          continue;
        }
        if (waiter.turn.cancel?.aborted) {
          settleRuntimeWaiter(waiter, new OpenCodeTurnCancelled());
          continue;
        }
        if (waiter.deadline !== null && Date.now() >= waiter.deadline) {
          settleRuntimeWaiter(waiter, deadlineError(waiter.wallMs));
          continue;
        }
        if (runtimes.size + reservedRuntimeSlots >= OPENCODE_RUNTIME_POOL_LIMIT) {
          const idle = [...runtimes.entries()]
            .filter(([, runtime]) => (runtimeUsers.get(runtime) ?? 0) === 0)
            .sort(([, left], [, right]) => left.lastUsed - right.lastUsed)[0];
          if (!idle) break;
          const [idleKey, idleRuntime] = idle;
          runtimes.delete(idleKey);
          runtimeUsers.delete(idleRuntime);
          await idleRuntime.close();
          if (waiter.settled) continue;
          if (closed) {
            settleRuntimeWaiter(waiter, new Error("OpenCode harness is closed"));
            continue;
          }
        }
        reservedRuntimeSlots += 1;
        let released = false;
        settleRuntimeWaiter(waiter, undefined, () => {
          if (released) return;
          released = true;
          reservedRuntimeSlots = Math.max(0, reservedRuntimeSlots - 1);
          void processRuntimeWaiters();
        });
      }
    } finally {
      processingRuntimeWaiters = false;
    }
  }

  const reserveRuntimeSlot = (turn: HarnessTurnInput, deadline: number | null, wallMs: number): Promise<() => void> => {
    if (closed) return Promise.reject(new Error("OpenCode harness is closed"));
    if (turn.cancel?.aborted) return Promise.reject(new OpenCodeTurnCancelled());
    if (deadline !== null && Date.now() >= deadline) return Promise.reject(deadlineError(wallMs));
    return new Promise<() => void>((resolve, reject) => {
      const waiter: RuntimeWaiter = {
        turn,
        deadline,
        wallMs,
        resolve,
        reject,
        settled: false,
      };
      if (turn.cancel) {
        waiter.onCancel = () => {
          settleRuntimeWaiter(waiter, new OpenCodeTurnCancelled());
          void processRuntimeWaiters();
        };
        turn.cancel.addEventListener("abort", waiter.onCancel, { once: true });
      }
      if (deadline !== null) {
        waiter.timer = setTimeout(
          () => {
            settleRuntimeWaiter(waiter, deadlineError(wallMs));
            void processRuntimeWaiters();
          },
          Math.max(1, deadline - Date.now()),
        );
      }
      runtimeWaiters.push(waiter);
      void processRuntimeWaiters();
    });
  };

  const waitForRuntime = async (
    pending: Promise<Runtime>,
    turn: HarnessTurnInput,
    deadline: number | null,
    wallMs: number,
  ): Promise<Runtime | null> => {
    if (turn.cancel?.aborted) return null;
    if (deadline !== null && Date.now() >= deadline) throw deadlineError(wallMs);
    let timer: NodeJS.Timeout | undefined;
    let onCancel: (() => void) | undefined;
    try {
      const outcomes: Array<Promise<Runtime | null>> = [pending];
      if (turn.cancel) {
        outcomes.push(
          new Promise<null>((resolve) => {
            onCancel = () => resolve(null);
            turn.cancel!.addEventListener("abort", onCancel, { once: true });
          }),
        );
      }
      if (deadline !== null) {
        outcomes.push(
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(deadlineError(wallMs)), Math.max(1, deadline - Date.now()));
          }),
        );
      }
      return await Promise.race(outcomes);
    } finally {
      if (timer) clearTimeout(timer);
      if (onCancel) turn.cancel?.removeEventListener("abort", onCancel);
    }
  };

  const acquireRuntimeWithin = async (
    turn: HarnessTurnInput,
    deadline: number | null,
    wallMs: number,
  ): Promise<ReturnType<typeof leaseRuntime> | null> => {
    while (true) {
      if (closed) throw new Error("OpenCode harness is closed");
      if (turn.cancel?.aborted) return null;
      if (deadline !== null && Date.now() >= deadline) throw deadlineError(wallMs);
      const expectedCustomProvidersVersion = opts.customProvidersVersion?.() ?? 0;
      const expectedDefinitions = bridgeDefinitionSnapshot(opts, turn);
      const key = runtimeKey(expectedCustomProvidersVersion, expectedDefinitions.key);
      const current = runtimes.get(key);
      if (current && current.process.exitCode === null) {
        await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
        if (runtimes.get(key) === current && current.process.exitCode === null) return leaseRuntime(current);
        continue;
      }
      let pending = starting.get(key);
      if (!pending) {
        pending = (async () => {
          const releaseReservation = await reserveRuntimeSlot(turn, deadline, wallMs);
          try {
            if (closed) throw new Error("OpenCode harness is closed");
            return await startRuntime(expectedCustomProvidersVersion, expectedDefinitions);
          } finally {
            releaseReservation();
          }
        })();
        starting.set(key, pending);
        void pending.then(
          () => {
            if (starting.get(key) === pending) starting.delete(key);
          },
          () => {
            if (starting.get(key) === pending) starting.delete(key);
          },
        );
      }
      try {
        const ready = await waitForRuntime(pending, turn, deadline, wallMs);
        if (!ready) return null;
      } catch (error) {
        if (turn.cancel?.aborted) return null;
        if (
          (error instanceof OpenCodeTurnCancelled || error instanceof OpenCodeTurnDeadlineExceeded) &&
          (deadline === null || Date.now() < deadline)
        ) {
          await pending.catch(() => undefined);
          if (starting.get(key) === pending) starting.delete(key);
          continue;
        }
        throw error;
      }
    }
  };

  const acquireRuntime = async (turn: HarnessTurnInput) => {
    const wallMs = turn.turnWallClockMs ?? defaultTurnWallClockMs;
    const deadline = wallMs > 0 ? Date.now() + wallMs : null;
    return {
      lease: await acquireRuntimeWithin(turn, deadline, wallMs),
      deadline,
      wallMs,
    };
  };

  const runPromptWithRuntime = async (
    turn: HarnessTurnInput,
    rt: Runtime,
    deadline: number | null,
    wallMs: number,
  ): Promise<HarnessTurnResult> => {
    if (turn.cancel?.aborted) return { reply: "", stopped: true };
    const selectedModel = turn.model ?? resolveModelId(turn.scopeLabel);
    const model = modelRef(selectedModel);
    const created = await rt.client.session.create({ body: { title: `qm:${turn.session.id}` } });
    const session = created.data;
    if (!session) throw new Error(`OpenCode session creation failed: ${JSON.stringify(created.error)}`);
    const sessionId = session.id;
    if (turn.cancel?.aborted) {
      await rt.client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
      await rt.client.session.delete({ path: { id: sessionId } }).catch(() => undefined);
      return { reply: "", stopped: true };
    }
    const ref: ToolContextRef = {
      current: turn.tools,
      pendingApprovals: [],
      pausedOnApproval: false,
      silentRequested: false,
      pollFire: Boolean(turn.pollFire),
      emit: turn.emit,
      scopeLabel: turn.scopeLabel,
      orgScopeId: turn.orgScopeId,
      screenExternalContent: turn.screenExternalContent,
      toolApprovalGate: turn.toolApprovalGate,
    };
    const controller = new AbortController();
    ref.abortSignal = controller.signal;
    const tools = activeBridgeTools(ref, opts, rt);
    const userEntry = await turn.emit({
      type: "user",
      payload: {
        text: turn.input,
        ...((turn.triggerTs ?? turn.entryTs) ? { ts: turn.triggerTs ?? turn.entryTs } : {}),
        ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
      },
      scopeLabel: turn.scopeLabel,
    });
    const state: ActiveTurn = {
      turn,
      ref,
      tools: new Map(tools.map((tool) => [bridgeToolName(tool.name), tool])),
      system: `${turn.systemPrompt}\n\nOpenCode tool aliases: workspace_execute is foreground \`execute\`; workspace_read reads workspace files; workspace_write writes workspace files.`,
      history: replayMessages(reconstructMessagesFromHistory(turn.history), sessionId, model),
      userSeq: userEntry.seq,
      captures: [],
      model: selectedModel,
      seenText: new Map(),
      seenTasks: new Map(),
      eventTail: Promise.resolve(),
      stopped: false,
      child: false,
    };
    active.set(activeKey(rt.namespace, sessionId), state);
    const abort = async (stopped: boolean) => {
      state.stopped ||= stopped;
      controller.abort();
      await rt.client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
    };
    const onCancel = () => {
      void abort(false);
    };
    if (turn.cancel) {
      if (turn.cancel.aborted) onCancel();
      else turn.cancel.addEventListener("abort", onCancel, { once: true });
    }
    if (turn.cancel?.aborted) {
      await abort(false);
      active.delete(activeKey(rt.namespace, sessionId));
      turn.cancel.removeEventListener("abort", onCancel);
      await rt.client.session.delete({ path: { id: sessionId } }).catch(() => undefined);
      return { reply: "", stopped: true };
    }
    const abortForClose = () => abort(true);
    activeTurnAborts.add(abortForClose);
    const queuedSignals = new Set<Promise<void>>();
    const queueSignal = (text: string): Promise<void> => {
      const pending = (async () => {
        const remaining =
          wallMs > 0 ? Math.max(1, (deadline ?? Date.now() + wallMs) - Date.now()) : OPENCODE_IDLE_WAIT_MS;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(remaining)]);
        await rt.client.session.promptAsync({
          path: { id: sessionId },
          body: { model, agent: "qm", parts: [{ type: "text", text }] },
          throwOnError: true,
          signal,
        });
        await waitForSessionIdle(
          rt.client,
          sessionId,
          wallMs > 0 ? Math.max(1, (deadline ?? Date.now() + wallMs) - Date.now()) : OPENCODE_IDLE_WAIT_MS,
          controller.signal,
        );
      })();
      queuedSignals.add(pending);
      return pending;
    };
    const stopSignals =
      opts.signals && turn.runId
        ? startSignalPoll(
            opts.signals,
            turn.runId,
            {
              onAbort: async () => abort(true),
              onSteer: async (text, ts) => {
                await turn.emit({
                  type: "user",
                  payload: { text, ...(ts ? { ts } : {}), steered: true },
                  scopeLabel: turn.scopeLabel,
                });
                await queueSignal(text);
              },
            },
            { onError: (error) => swallow("opencode signal poll", error), drainOnStop: true },
          )
        : null;
    const flushLlmRequests = async () => {
      const captures = state.captures.splice(0);
      if (!turn.recordLlmRequest || captures.length === 0) return;
      const capturesBySession = new Map<string, LlmCapture[]>();
      for (const capture of captures) {
        const group = capturesBySession.get(capture.sessionId) ?? [];
        group.push(capture);
        capturesBySession.set(capture.sessionId, group);
      }
      const infoByCapture = new Map<LlmCapture, AssistantMessageInfo>();
      await Promise.all(
        [...capturesBySession.entries()].map(async ([id, group]) => {
          const listed = await rt.client.session.messages({ path: { id } }).catch(() => null);
          const infos = (listed?.data ?? [])
            .map((message) => (message as { info?: AssistantMessageInfo }).info)
            .filter((info): info is AssistantMessageInfo => info?.role === "assistant");
          if (infos.length !== group.length) {
            console.error(
              `[opencode] llm capture misalignment for session ${id}: ${group.length} captures vs ${infos.length} assistant messages; recording without usage attribution`,
            );
            return;
          }
          group.forEach((capture, index) => infoByCapture.set(capture, infos[index]!));
        }),
      );
      for (const capture of captures) {
        const info = infoByCapture.get(capture);
        const created = info?.time?.created;
        const completed = info?.time?.completed;
        try {
          await turn.recordLlmRequest({
            turnSeq: state.userSeq,
            step: capture.step,
            model: capture.model,
            promptEnvelope: envelopeWithoutMessages(capture.request),
            truncated: false,
            transport: info?.providerID && info.modelID ? { modelId: `${info.providerID}/${info.modelID}` } : null,
            ttftMs: null,
            durationMs: created !== undefined && completed !== undefined ? completed - created : null,
            stepGapMs: null,
            toolWallMs: null,
            gapPhases: null,
            usage: usageFromInfo(info),
          });
        } catch (error) {
          swallow("opencode: llm request record", error);
        }
      }
    };
    const prompt = [turn.input, turn.environment].filter((item) => item?.trim()).join("\n\n");
    const promptParts: Array<Record<string, unknown>> = [
      { type: "text", text: prompt },
      ...(turn.images ?? []).map((image, index) => ({
        type: "file",
        mime: image.mimeType,
        filename: `image-${index + 1}`,
        url: `data:${image.mimeType};base64,${image.dataBase64}`,
      })),
    ];
    const enabled = Object.fromEntries(rt.definitionNames.map((name) => [name, false]));
    for (const tool of tools) enabled[bridgeToolName(tool.name)] = true;
    enabled.task = !turn.readOnly;
    let timer: NodeJS.Timeout | undefined;
    let signalsStopped = false;
    try {
      const request = rt.client.session.prompt({
        path: { id: sessionId },
        body: { model, agent: "qm", system: turn.systemPrompt, tools: enabled, parts: promptParts as never },
      });
      const response =
        wallMs > 0
          ? await Promise.race([
              request,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => {
                    void abort(false);
                    reject(deadlineError(wallMs));
                  },
                  Math.max(1, (deadline ?? Date.now() + wallMs) - Date.now()),
                );
              }),
            ])
          : await request;
      if (!response.data) throw new Error(`OpenCode prompt failed: ${JSON.stringify(response.error)}`);
      throwAssistantFailure((response.data as { info?: AssistantMessageInfo }).info);
      await stopSignals?.();
      signalsStopped = true;
      const hadQueuedSignals = queuedSignals.size > 0;
      await Promise.allSettled(queuedSignals);
      const parts = hadQueuedSignals
        ? ((await latestAssistantParts(rt.client, sessionId)) ?? (response.data.parts as unknown[]))
        : (response.data.parts as unknown[]);
      const messages = await rt.client.session.messages({ path: { id: sessionId } });
      for (const message of messages.data ?? []) {
        for (const part of (message as { parts?: unknown[] }).parts ?? []) {
          await processEvent(rt.namespace, { payload: { type: "message.part.updated", properties: { part } } });
        }
      }
      let tapeWriteFailed = false;
      if (turn.tape) {
        try {
          let tapedTriggerUser = false;
          for (const message of messages.data ?? []) {
            const role = (message as { info?: { role?: string } }).info?.role;
            if (role !== "user" && role !== "assistant") continue;
            const isTrigger = role === "user" && !tapedTriggerUser;
            if (isTrigger) tapedTriggerUser = true;
            await turn.tape({
              kind: "message",
              harness: "opencode",
              payload: stripDataUrls(message),
              scopeLabel: turn.scopeLabel,
              ...(isTrigger
                ? {
                    entrySeq: userEntry.seq,
                    meta: {
                      bareText: turn.input,
                      ...((turn.triggerTs ?? turn.entryTs) ? { ts: (turn.triggerTs ?? turn.entryTs)! } : {}),
                    },
                  }
                : {}),
            });
          }
        } catch (error) {
          tapeWriteFailed = true;
          swallow("opencode: tape append", error);
        }
      }
      for (const thinking of reasoningFromParts(parts))
        await turn.emit({ type: "thinking", payload: thinking, scopeLabel: turn.scopeLabel });
      const reply = textFromParts(parts);
      if (reply)
        await turn.emit({
          type: "assistant",
          payload: { text: reply, stopped: state.stopped || undefined },
          scopeLabel: turn.scopeLabel,
        });
      return {
        reply,
        ...(state.stopped ? { stopped: true as const } : {}),
        ...(ref.silentRequested ? { silent: true } : {}),
        ...(ref.pendingApprovals?.length ? { pendingApprovals: ref.pendingApprovals } : {}),
        ...(ref.pausedOnApproval ? { pausedOnApproval: true } : {}),
        modelCalls: state.captures.length,
        ...(tapeWriteFailed ? { tapeWriteFailed: true } : {}),
      };
    } finally {
      try {
        if (timer) clearTimeout(timer);
        activeTurnAborts.delete(abortForClose);
        if (!signalsStopped) await stopSignals?.();
        await Promise.allSettled(queuedSignals);
        turn.cancel?.removeEventListener("abort", onCancel);
        if (opts.tasks) {
          const taskIds = [...state.seenTasks.keys()];
          await Promise.all(
            taskIds.map(async (taskId) => {
              const task = await opts.tasks!.get(taskId);
              if (task && (task.status === "pending" || task.status === "in_progress")) {
                await opts.tasks!.transitionStatus(task.id, task.status, "failed", turn.runId ?? turn.session.id);
              }
            }),
          );
        }
        await flushLlmRequests();
      } finally {
        for (const [id, candidate] of active) if (candidate.turn === turn) active.delete(id);
        await rt.client.session.delete({ path: { id: sessionId } }).catch(() => undefined);
      }
    }
  };

  const runPrompt = async (turn: HarnessTurnInput): Promise<HarnessTurnResult> => {
    if (turn.cancel?.aborted) return { reply: "", stopped: true };
    if (closed) throw new Error("OpenCode harness is closed");
    const { lease, deadline, wallMs } = await acquireRuntime(turn);
    if (!lease) return { reply: "", stopped: true };
    try {
      return await runPromptWithRuntime(turn, lease.runtime, deadline, wallMs);
    } finally {
      lease.release();
    }
  };

  const single = async (
    system: string,
    prompt: string,
    instrumentation?: Pick<HarnessTurnInput, "recordModelCall" | "recordLlmRequest">,
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    auxiliaryHarness ??= createOpenCodeHarness({
      ...(opts.modelId !== undefined ? { modelId: opts.modelId } : {}),
      ...(opts.defaultModelId !== undefined ? { defaultModelId: opts.defaultModelId } : {}),
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      ...(opts.openaiApiKey !== undefined ? { openaiApiKey: opts.openaiApiKey } : {}),
      ...(opts.turnWallClockMs !== undefined ? { turnWallClockMs: opts.turnWallClockMs } : {}),
      ...(opts.binaryPath !== undefined ? { binaryPath: opts.binaryPath } : {}),
      ...(opts.startupTimeoutMs !== undefined ? { startupTimeoutMs: opts.startupTimeoutMs } : {}),
      ...(opts.resolveCustomProviders ? { resolveCustomProviders: opts.resolveCustomProviders } : {}),
      ...(opts.customProvidersVersion ? { customProvidersVersion: opts.customProvidersVersion } : {}),
      mcpTools: () => [],
      controlTools: false,
      scratchExec: false,
      ownerAuthExec: false,
      reachExec: false,
    });
    const session = { id: `oneshot-${randomBytes(8).toString("hex")}` } as HarnessTurnInput["session"];
    const scope = { kind: "org", id: "oneshot" } as unknown as ScopeId;
    const emitted: SessionEntry[] = [];
    const result = await auxiliaryHarness.turns.runTurn({
      session,
      input: prompt,
      systemPrompt: system,
      history: [],
      tools: {} as HarnessTurnInput["tools"],
      scopeLabel: scope,
      orgScopeId: scope,
      ...(signal ? { cancel: signal } : {}),
      emit: async (entry) => {
        const saved = {
          ...entry,
          sessionId: session.id,
          seq: emitted.length + 1,
          createdAt: Date.now(),
        } as SessionEntry;
        emitted.push(saved);
        return saved;
      },
      recordModelCall: instrumentation?.recordModelCall ?? (() => {}),
      ...(instrumentation?.recordLlmRequest ? { recordLlmRequest: instrumentation.recordLlmRequest } : {}),
      readOnly: true,
    });
    return result.reply || undefined;
  };

  const closeHarness = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    rejectRuntimeWaiters(new Error("OpenCode harness is closed"));
    closing = (async () => {
      const drainDeadline = Date.now() + OPENCODE_CLOSE_DRAIN_MS;
      const waitWithinDrain = async (pending: Promise<unknown>): Promise<void> => {
        const remaining = drainDeadline - Date.now();
        if (remaining <= 0) return;
        await Promise.race([
          pending.then(
            () => undefined,
            () => undefined,
          ),
          sleep(remaining),
        ]);
      };
      await waitWithinDrain(Promise.allSettled([...activeTurnAborts].map((abort) => abort())));
      await waitWithinDrain(Promise.all([...startingProcesses].map((proc) => terminateProcess(proc))));
      await waitWithinDrain(Promise.all([...starting.values()].map((pending) => pending.catch(() => undefined))));
      starting.clear();
      if ([...runtimeUsers.values()].some((users) => users > 0)) {
        let resolveDrain!: () => void;
        const drained = new Promise<void>((resolve) => {
          resolveDrain = resolve;
          leaseDrains.add(resolve);
        });
        await waitWithinDrain(drained);
        leaseDrains.delete(resolveDrain);
      }
      if (auxiliaryHarness?.turns.close) await waitWithinDrain(Promise.resolve(auxiliaryHarness.turns.close()));
      auxiliaryHarness = null;
      await Promise.all([...runtimes.values()].map((runtime) => runtime.close()));
      runtimes.clear();
      runtimeUsers.clear();
      activeTurnAborts.clear();
      signalLeases();
    })();
    return closing;
  };

  return defineHarness(
    {
      id: "opencode",
      controlTransport: "http",
      toolTransport: "plugin",
      transcriptFormat: "opencode",
      capabilities: new Set(["abort", "steer", "images", "provider-sessions"]),
    },
    {
      runTurn: runPrompt,
      close: closeHarness,
      resetSession: () => {},
      oneShot: single,
      judge: single,
      screenSecurity: async ({ payload, signal, recordModelCall, recordLlmRequest }) =>
        parseSecurityScreenVerdict(
          await single(
            SECURITY_SCREEN_SYSTEM_PROMPT,
            payload,
            { recordModelCall, ...(recordLlmRequest ? { recordLlmRequest } : {}) },
            signal,
          ),
        ),
      generateTitle: async (transcript) =>
        sanitizeTitle(await single(TITLE_GENERATION_PROMPT, titleUserPrompt(transcript))),
      summarizeApproval: async (command, reason, purpose) =>
        single(
          "Explain this command in one plain-English sentence for an approver.",
          [command, reason, purpose].filter(Boolean).join("\n"),
        ),
    },
    { name: bridgeToolName },
  );
}
