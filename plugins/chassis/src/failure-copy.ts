import { SECURITY_QUARANTINE_REFUSAL_TEXT } from "./security-quarantine.ts";

export const GENERIC_FAILURE_CLAUSE =
  "the request could not be completed for an unknown reason; check any results before retrying or contact an administrator";

export const GENERIC_FAILURE_TEXT =
  "This request could not be completed, and the cause is unclear. Check any results already shown before retrying, or ask an administrator to check the error log.";

export const FAILURE_REASONS = {
  usageLimit:
    "the AI service's usage limit has been reached; this request could not be completed. Wait for the limit to reset before retrying, choose another available model, or contact an administrator",
  rateLimit: "a service is rate limiting requests; try again in a few minutes",
  timeout: "the AI service or a tool timed out; try again",
  connection: "a required service could not be reached; try again",
  unavailable: "a required service is temporarily unavailable; try again shortly",
  authentication: "a required account could not authenticate; reconnect it or ask an administrator",
  context: "the model's context limit was reached; try a shorter request",
  billing:
    "the AI account has no available credit or quota; check its billing or ask an administrator to restore access",
  permission: "this request is not allowed with the current access; ask an administrator to check permissions",
  model:
    "the selected AI model is unavailable or not configured; choose another available model or contact an administrator",
  busy: "another task is still running in this conversation; wait for it to finish before sending the request again",
} as const;

export function usageLimitFailureReason(message: string | undefined): string | undefined {
  if (
    !message ||
    !/(?:\b|_)usage[_ -]limit[_ -](?:reached|exceeded)\b|\busage limit has been reached\b|(?:hit|reached|exceeded) your usage limit\b/i.test(
      message,
    )
  )
    return undefined;
  const reset = message.match(/"reset_seconds"\s*:\s*(\d+(?:\.\d+)?)(?=\s*[,}])/);
  const seconds = reset ? Number(reset[1]) : NaN;
  const minutes =
    Number.isFinite(seconds) && seconds > 0 && seconds <= 31_536_000
      ? Math.ceil(seconds / 60)
      : Number(message.match(/estimated wait when this request failed: (\d{1,6}) minutes/)?.[1]);
  return `${FAILURE_REASONS.usageLimit}${minutes > 0 && minutes <= 525_600 ? ` (estimated wait when this request failed: ${minutes} minutes)` : ""}`;
}

export function safeFailureReason(reason: string | undefined): string | undefined {
  const usageLimit = usageLimitFailureReason(reason);
  if (usageLimit) return usageLimit;
  if (!reason) return undefined;
  const known = Object.values(FAILURE_REASONS).find((safe) => reason.includes(safe));
  if (known) return known;
  if (
    /\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|fetch failed|failed to fetch|network error|network unreachable|socket hang up)\b/i.test(
      reason,
    )
  )
    return FAILURE_REASONS.connection;
  if (
    /insufficient[_ -]quota|exceeded your current quota|out of credits|credits_depleted|credit (?:balance|limit)|\b402 Payment Required\b/i.test(
      reason,
    )
  )
    return FAILURE_REASONS.billing;
  if (
    /invalid[_ -](?:api[_ -])?key|incorrect api key|authentication[_ -](?:error|failed)|unauthoriz|unauthenticated|invalid credentials|(?:expired|invalid)[_ -]token|token_expired|not logged in|missing bearer|OAuth auth is unavailable|credentials are unavailable|(?:^|HTTP |status |error \()401\b/i.test(
      reason,
    )
  )
    return FAILURE_REASONS.authentication;
  if (
    /\bforbidden\b|\baccess denied\b|(?:^|HTTP |status |error \()403\b|(?:model|runtime|harness).{0,100}(?:not approved|not allowed)|no (?:model|harness) is (?:approved|allowed)|not a member|membership is not active|project membership changed/i.test(
      reason,
    )
  )
    return FAILURE_REASONS.permission;
  if (
    /model[_ -]not[_ -]found|unsupported[_ -]model|model.{0,100}(?:unavailable|does not exist)|no available default model|provider .{0,80}is not configured/i.test(
      reason,
    )
  )
    return FAILURE_REASONS.model;
  if (
    /\b(?:context.{0,20}(?:limit|length|window)|maximum context|prompt is too long)\b|context_length_exceeded/i.test(
      reason,
    )
  )
    return FAILURE_REASONS.context;
  if (
    /\b(?:timed? out|timeout|ETIMEDOUT)\b|timeout_error|(?:Codex|Claude) turn exceeded \d+s wall clock|wall-clock limit/i.test(
      reason,
    )
  )
    return FAILURE_REASONS.timeout;
  if (/rate[_ -]?limit|\b(?:too many requests|429)\b|model_cooldown/i.test(reason)) return FAILURE_REASONS.rateLimit;
  if (/\b(?:service unavailable|overloaded|502|503|504|bad gateway)\b|overloaded_error/i.test(reason))
    return FAILURE_REASONS.unavailable;
  if (/conversation was busy with another task|still finishing something else in this conversation/i.test(reason))
    return FAILURE_REASONS.busy;
  return undefined;
}

export interface FailureLike {
  status?: string;
  reason?: string;
  refusalKind?: string;
}

export function workWechatFailureText(result: FailureLike, runId?: string): string {
  const reference = runId && /^[a-zA-Z0-9-]{1,80}$/.test(runId) ? `\n任务编号：${runId}` : "";
  let detail: string;
  if (result.refusalKind === "security_quarantine")
    detail = "安全检查拦截了本次请求。请调整消息或上下文后重试，或联系管理员检查隔离记录。";
  else if (result.refusalKind === "session_busy")
    detail = "当前对话还有任务正在执行，本次请求未执行。请稍后重试；发送 /new 可新开网页对话，IM 聊天窗口不变。";
  else if (result.status === "failed") {
    const reason = safeFailureReason(result.reason);
    const details: Record<string, string> = {
      [FAILURE_REASONS.usageLimit]:
        "AI 服务的可用额度已用完，本次请求未完成。请等待额度恢复后再试，或选择其他可用模型；也可以联系管理员。立即重试不会恢复额度。",
      [FAILURE_REASONS.rateLimit]: "模型或工具服务触发限流，本次任务未完成。请过几分钟再试。",
      [FAILURE_REASONS.timeout]: "模型或工具执行超时，本次任务未完成。请重试或缩小任务范围。",
      [FAILURE_REASONS.connection]:
        "无法连接模型或工具服务，本次任务未完成。请稍后重试；持续失败请联系管理员检查网络。",
      [FAILURE_REASONS.unavailable]: "模型或工具服务暂时不可用，本次任务未完成。请稍后重试。",
      [FAILURE_REASONS.authentication]:
        "模型或工具账号认证失败，本次任务未完成。请重新连接对应账号，或联系管理员检查凭据。",
      [FAILURE_REASONS.context]: "模型上下文已超出限制，本次任务未完成。请缩短请求，或发送 /new 开始新对话。",
      [FAILURE_REASONS.billing]:
        "AI 账户的余额或额度不足，本次任务未完成。请检查账户账单或联系管理员恢复可用额度。立即重试不会恢复额度。",
      [FAILURE_REASONS.permission]: "当前账户或模型没有执行本次请求的权限。请联系管理员检查访问权限。",
      [FAILURE_REASONS.model]: "当前选择的 AI 模型不可用或尚未配置，本次任务未完成。请选择其他可用模型，或联系管理员。",
      [FAILURE_REASONS.busy]: "当前对话还有任务正在执行，本次请求未执行。请等待当前任务结束后再发送。",
    };
    detail =
      (reason && (details[reason] || (usageLimitFailureReason(reason) && details[FAILURE_REASONS.usageLimit]))) ||
      "本次任务未完成，原因暂时无法确定。重试前请检查已产生的结果；持续失败请将任务编号提供给管理员查询错误日志。";
  } else if (result.status === "refused")
    detail = "本次请求被拒绝，未执行。请检查当前账号的访问权限；持续失败请联系管理员查询记录。";
  else detail = "本次任务已结束，但没有生成文字回复。可以补充需要的结果格式后再次提问。";
  return `⚠️ ${detail}${reference}`;
}

export function userFacingFailureText(result: FailureLike, runId?: string): string {
  if (result.refusalKind === "security_quarantine") return SECURITY_QUARANTINE_REFUSAL_TEXT;
  if (result.status === "refused" && result.reason) return result.reason;
  const reference = runId && /^[a-zA-Z0-9-]{1,80}$/.test(runId) ? ` (run ${runId})` : "";
  if (result.status === "failed") {
    const reason = safeFailureReason(result.reason);
    return reason ? `I couldn't finish that turn: ${reason}.${reference}` : `${GENERIC_FAILURE_TEXT}${reference}`;
  }
  return GENERIC_FAILURE_TEXT;
}
