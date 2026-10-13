import { SECURITY_QUARANTINE_REFUSAL_TEXT } from "./security-quarantine.ts";

export const GENERIC_FAILURE_CLAUSE =
  "an unexpected internal error interrupted the turn; try again or contact an administrator";

export const GENERIC_FAILURE_TEXT =
  "An unexpected internal error interrupted the turn. Try again, or ask an administrator to check the error log.";

export const FAILURE_REASONS = {
  rateLimit: "a service is rate limiting requests; try again in a few minutes",
  timeout: "the AI service or a tool timed out; try again",
  connection: "a required service could not be reached; try again",
  unavailable: "a required service is temporarily unavailable; try again shortly",
  authentication: "a required account could not authenticate; reconnect it or ask an administrator",
  context: "the model's context limit was reached; try a shorter request",
} as const;

export function safeFailureReason(reason: string | undefined): string | undefined {
  if (/^Codex turn exceeded \d{1,4}s wall clock$/.test(reason ?? "")) return FAILURE_REASONS.timeout;
  return Object.values(FAILURE_REASONS).find((safe) => safe === reason);
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
      [FAILURE_REASONS.rateLimit]: "模型或工具服务触发限流，本次任务未完成。请过几分钟再试。",
      [FAILURE_REASONS.timeout]: "模型或工具执行超时，本次任务未完成。请重试或缩小任务范围。",
      [FAILURE_REASONS.connection]:
        "无法连接模型或工具服务，本次任务未完成。请稍后重试；持续失败请联系管理员检查网络。",
      [FAILURE_REASONS.unavailable]: "模型或工具服务暂时不可用，本次任务未完成。请稍后重试。",
      [FAILURE_REASONS.authentication]:
        "模型或工具账号认证失败，本次任务未完成。请重新连接对应账号，或联系管理员检查凭据。",
      [FAILURE_REASONS.context]: "模型上下文已超出限制，本次任务未完成。请缩短请求，或发送 /new 开始新对话。",
    };
    detail =
      (reason && details[reason]) ||
      "内部异常导致本次任务未完成。请重试；持续失败请将任务编号提供给管理员查询错误日志。";
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
