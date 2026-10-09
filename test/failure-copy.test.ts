import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_BUSY_FIRE_TEXT,
  SESSION_BUSY_USER_TEXT,
  standaloneFailureText,
  userFacingFailureClause,
  userFacingFailureText,
} from "../src/core/failure-copy.ts";
import { SECURITY_QUARANTINE_REFUSAL_TEXT } from "../plugins/chassis/src/security-quarantine.ts";
import { GENERIC_FAILURE_TEXT } from "../plugins/chassis/src/failure-copy.ts";
import { NonRetryableTurnError, turnFailureMessage } from "../src/core/turn-error.ts";

test("the shared failure policy renders quarantine canned, refused reasons verbatim, everything else generic", () => {
  const quarantine = {
    status: "refused",
    refusalKind: "security_quarantine",
    reason: "internal screening details",
  } as const;
  assert.equal(userFacingFailureText(quarantine), SECURITY_QUARANTINE_REFUSAL_TEXT);
  assert.doesNotMatch(userFacingFailureText(quarantine), /internal screening details/);
  assert.equal(userFacingFailureClause(quarantine), SECURITY_QUARANTINE_REFUSAL_TEXT);
  assert.equal(standaloneFailureText(quarantine), SECURITY_QUARANTINE_REFUSAL_TEXT);

  const busy = { status: "refused", refusalKind: "session_busy", reason: SESSION_BUSY_USER_TEXT } as const;
  assert.equal(userFacingFailureText(busy), SESSION_BUSY_USER_TEXT);
  assert.equal(standaloneFailureText(busy), SESSION_BUSY_USER_TEXT);
  assert.equal(userFacingFailureClause(busy), "the conversation was busy with another task");

  const busyFire = { status: "refused", refusalKind: "session_busy", reason: SESSION_BUSY_FIRE_TEXT } as const;
  assert.equal(userFacingFailureText(busyFire), SESSION_BUSY_FIRE_TEXT);
  assert.doesNotMatch(userFacingFailureText(busyFire), /send that again/i);

  const authored = { status: "refused", reason: "you're not a member of that context" };
  assert.equal(userFacingFailureText(authored), "you're not a member of that context");
  assert.equal(userFacingFailureClause(authored), "you're not a member of that context");
  assert.equal(standaloneFailureText(authored), undefined);

  const failed = { status: "failed", reason: "TypeError: fetch failed at sandbox.ts:42" };
  assert.equal(userFacingFailureText(failed), GENERIC_FAILURE_TEXT);
  assert.equal(
    userFacingFailureClause(failed),
    "an unexpected internal error interrupted the turn; try again or contact an administrator",
  );
  assert.doesNotMatch(userFacingFailureText(failed), /TypeError|sandbox\.ts/);

  assert.equal(userFacingFailureText({ status: "refused" }), GENERIC_FAILURE_TEXT);
});

test("known infrastructure failures explain the cause without exposing raw diagnostics", () => {
  for (const [error, expected] of [
    [new Error("provider returned 429; token=private"), "rate limiting"],
    [new Error("request timed out at /private/path"), "timed out"],
    [new Error("fetch failed", { cause: new Error("ECONNRESET private-host") }), "could not be reached"],
    [new Error("provider HTTP 503 private-host"), "temporarily unavailable"],
    [new Error("invalid api key private-token"), "could not authenticate"],
    [new Error("maximum context length is 200000 private-token"), "context limit"],
  ] as const) {
    const reason = turnFailureMessage(error);
    const visible = userFacingFailureText({ status: "failed", reason });
    assert.match(visible, new RegExp(expected));
    assert.equal(userFacingFailureClause({ status: "failed", reason }), reason);
    assert.doesNotMatch(visible, /private/);
  }
  assert.equal(userFacingFailureText({ status: "failed", reason: "provider 429 private" }), GENERIC_FAILURE_TEXT);
  assert.equal(turnFailureMessage(new NonRetryableTurnError("swarm service unavailable")), "swarm service unavailable");
  const wallClock = turnFailureMessage(new NonRetryableTurnError("Codex turn exceeded 300s wall clock"));
  assert.equal(wallClock, "Codex turn exceeded 300s wall clock");
  assert.match(userFacingFailureText({ status: "failed", reason: wallClock }), /timed out; try again/);
  assert.equal(
    userFacingFailureClause({ status: "failed", reason: wallClock }),
    "the AI service or a tool timed out; try again",
  );
  assert.equal(
    userFacingFailureText({ status: "failed", reason: "private" }, "r-1"),
    `${GENERIC_FAILURE_TEXT} (run r-1)`,
  );
});
