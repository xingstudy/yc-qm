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
