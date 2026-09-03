import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/test-app.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

function freshApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-session-authz-"));
  return buildApp(testConfig({ dataDir }));
}

function dm(text: string, thread: string, externalId: string): TurnRequest {
  return { surface: "test", actor: { externalId }, conversation: { kind: "dm", threadRef: thread }, text };
}

test("getSessionForViewer withholds metadata from a non-participant (no session-metadata IDOR)", async () => {
  const { app } = freshApp();

  const outcome = await app.turn(dm("my private question", "web:alice:private", "alice"));
  const sessionId = outcome.sessionId!;
  assert.ok(sessionId);

  const asAlice = await app.getSessionForViewer(sessionId, "alice");
  assert.ok(asAlice, "the owner reads her own session");
  assert.equal(asAlice!.session.id, sessionId);
  assert.equal(asAlice!.session.threadRef, "web:alice:private");

  const asCarol = await app.getSessionForViewer(sessionId, "carol");
  assert.equal(asCarol, null, "a non-participant cannot read the session row");
});

test("cron managers can read retained worklogs without adding them to conversation history", async () => {
  const built = freshApp();
  const ownerScopeId = scopeId("personal", "alice");
  const cron = await built.crons.create({
    schedule: { everyMs: 60_000 },
    action: "prepare the report",
    owner: "alice",
    createdBy: "alice",
    ownerScopeId,
  });
  const threadRef = `cron:${cron.id}:fire:run-1`;
  const session = await built.sessions.getOrCreateByThread(threadRef, "dm", ownerScopeId, undefined, "cron");
  const { lease } = await built.sessions.acquireLease(session.id);
  assert.ok(lease);
  const userEntry = await built.sessions.append(lease, {
    type: "user",
    payload: { text: "prepare the report" },
    scopeLabel: ownerScopeId,
  });
  await built.sessions.append(lease, {
    type: "assistant",
    payload: { text: "report ready" },
    scopeLabel: ownerScopeId,
  });
  await built.sessions.releaseLease(lease);
  await built.crons.recordFire(cron.id, {
    fireKey: "run-1",
    threadRef,
    firedAt: Date.now(),
    status: "ok",
    sessionId: session.id,
  });

  assert.equal(
    (await built.app.listSessions("alice")).some((candidate) => candidate.id === session.id),
    false,
  );
  const worklog = await built.app.getSessionForViewer(session.id, "alice");
  assert.deepEqual(
    worklog?.entries.map((entry) => entry.payload),
    [{ text: "prepare the report" }, { text: "report ready" }],
  );
  assert.deepEqual((await built.app.getSessionEntryForViewer(session.id, "alice", userEntry.seq))?.entry.payload, {
    text: "prepare the report",
  });
  assert.equal(await built.app.getSessionForViewer(session.id, "carol"), null);

  const unretained = await built.sessions.getOrCreateByThread(
    `cron:${cron.id}:fire:unretained`,
    "dm",
    ownerScopeId,
    undefined,
    "cron",
  );
  assert.equal(await built.app.getSessionForViewer(unretained.id, "alice"), null);
});
