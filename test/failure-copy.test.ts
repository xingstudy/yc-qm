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
import {
  FAILURE_REASONS,
  GENERIC_FAILURE_TEXT,
  safeFailureReason,
  usageLimitFailureReason,
  workWechatFailureText,
} from "../plugins/chassis/src/failure-copy.ts";
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
  assert.match(userFacingFailureText(failed), /could not be reached/);
  assert.equal(userFacingFailureClause(failed), FAILURE_REASONS.connection);
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
  assert.match(userFacingFailureText({ status: "failed", reason: "provider 429 private" }), /rate limiting/);
  assert.equal(turnFailureMessage(new NonRetryableTurnError("swarm service unavailable")), FAILURE_REASONS.unavailable);
  const wallClock = turnFailureMessage(new NonRetryableTurnError("Codex turn exceeded 300s wall clock"));
  assert.equal(wallClock, FAILURE_REASONS.timeout);
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

test("WeCom explains failures, refusals, and empty replies without exposing raw diagnostics", () => {
  for (const [reason, expected] of [
    [FAILURE_REASONS.rateLimit, /限流/],
    [FAILURE_REASONS.timeout, /超时/],
    [FAILURE_REASONS.connection, /无法连接/],
    [FAILURE_REASONS.unavailable, /暂时不可用/],
    [FAILURE_REASONS.authentication, /认证失败/],
    [FAILURE_REASONS.context, /上下文.*限制/],
    [FAILURE_REASONS.billing, /余额或额度不足/],
    [FAILURE_REASONS.permission, /权限/],
    [FAILURE_REASONS.model, /模型不可用/],
    [FAILURE_REASONS.busy, /正在执行/],
    ["Codex turn exceeded 300s wall clock", /超时/],
    ["token=private /secret/path", /原因暂时无法确定/],
  ] as const) {
    const text = workWechatFailureText({ status: "failed", reason }, "r-1");
    assert.match(text, expected);
    assert.match(text, /任务编号：r-1/);
    assert.doesNotMatch(text, /private|secret|300s/);
  }
  assert.match(workWechatFailureText({ status: "refused", refusalKind: "session_busy" }), /正在执行.*未执行/);
  assert.match(
    workWechatFailureText({ status: "refused", refusalKind: "security_quarantine", reason: "secret" }),
    /安全检查/,
  );
  assert.doesNotMatch(workWechatFailureText({ status: "refused", reason: "secret" }), /secret/);
  assert.match(workWechatFailureText({ status: "ok" }), /没有生成文字回复/);
  assert.doesNotMatch(workWechatFailureText({ status: "failed" }, "r-1\nsecret"), /secret|任务编号：/);
});

test("known provider and service errors share safe guidance even when non-retryable or wrapped", () => {
  for (const [raw, expected] of [
    ['API error (429): {"type":"rate_limit_error","message":"private"}', FAILURE_REASONS.rateLimit],
    ['API error (503): {"error":{"type":"overloaded_error","message":"private"}}', FAILURE_REASONS.unavailable],
    ['API error (401): {"type":"authentication_error","message":"private"}', FAILURE_REASONS.authentication],
    ['API error (403): {"message":"private"}', FAILURE_REASONS.permission],
    ['API error (402): {"code":"insufficient_quota","message":"private"}', FAILURE_REASONS.billing],
    ['API error (400): {"code":"context_length_exceeded","message":"private"}', FAILURE_REASONS.context],
    ['API error (404): {"code":"model_not_found","message":"private"}', FAILURE_REASONS.model],
    ["workspace_owner_credits_depleted private", FAILURE_REASONS.billing],
    ["Claude turn exceeded 300s wall clock", FAILURE_REASONS.timeout],
    ["prompt is too long: estimated 200000 tokens private", FAILURE_REASONS.context],
    ["model private is not allowed for this scope", FAILURE_REASONS.permission],
    ["No available default model is configured private", FAILURE_REASONS.model],
    ["Codex OAuth auth is unavailable (private)", FAILURE_REASONS.authentication],
    ["connect ECONNREFUSED private:403", FAILURE_REASONS.connection],
  ] as const) {
    assert.equal(safeFailureReason(raw), expected, raw);
    for (const error of [
      new Error(raw),
      new NonRetryableTurnError(raw),
      new Error("failed", { cause: new Error(raw) }),
    ]) {
      const reason = turnFailureMessage(error);
      assert.equal(reason, expected);
      const visible = userFacingFailureText({ status: "failed", reason }, "r-1");
      assert.match(visible, /run r-1/);
      assert.doesNotMatch(visible, /private|API error|\{"/);
    }
  }
  assert.equal(safeFailureReason("TypeError: cannot read property private"), undefined);
  assert.equal(safeFailureReason(undefined), undefined);
  assert.match(userFacingFailureText({ status: "failed", reason: "unknown private exception" }), /cause is unclear/);
});

test("usage exhaustion is explained before generic 429 and non-retryable errors", () => {
  const raw =
    'openai-qf2 API error (429): {"code":"model_cooldown","last_upstream_error":"usage_limit_reached: The usage limit has been reached","reset_seconds":11143,"message":"private credentials"}';
  for (const error of [
    new Error(raw),
    new NonRetryableTurnError(raw),
    new Error("provider failed", { cause: new Error(raw) }),
  ]) {
    const reason = turnFailureMessage(error);
    assert.match(reason, /usage limit has been reached/);
    assert.match(reason, /186 minutes/);
    assert.match(reason, /Wait for the limit to reset/);
    assert.equal(usageLimitFailureReason(reason), reason);
    assert.equal(userFacingFailureClause({ status: "failed", reason }), reason);
    const visible = userFacingFailureText({ status: "failed", reason }, "r-1");
    assert.match(visible, /another available model/);
    assert.match(visible, /run r-1/);
    assert.doesNotMatch(visible, /private|429|model_cooldown|reset_seconds/);
    assert.match(workWechatFailureText({ status: "failed", reason }), /额度已用完/);
  }
  assert.match(userFacingFailureText({ status: "failed", reason: raw }), /usage limit/);
  assert.equal(turnFailureMessage(new Error("429 too many requests")), FAILURE_REASONS.rateLimit);
  assert.equal(usageLimitFailureReason('429 {"code":"model_cooldown","reset_seconds":60}'), undefined);
  assert.equal(usageLimitFailureReason("context limit reached"), undefined);
});

test("missing or invalid reset estimates never invent a recovery time or expose provider data", () => {
  for (const reset of [
    "",
    '"reset_seconds":-1',
    '"reset_seconds":0',
    '"reset_seconds":"private"',
    '"reset_seconds":1e309',
    '"reset_seconds":999999999999999999999',
  ]) {
    assert.equal(usageLimitFailureReason(`usage_limit_reached {${reset}}`), FAILURE_REASONS.usageLimit);
  }
  assert.match(usageLimitFailureReason('usage_limit_reached {"reset_seconds":0.5}')!, /1 minutes/);
  assert.equal(usageLimitFailureReason(undefined), undefined);
});
