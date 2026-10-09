import { headSlice } from "../util/text.ts";
import { FAILURE_REASONS } from "../../plugins/chassis/src/failure-copy.ts";
import { errMessage } from "../util/errors.ts";

export class NonRetryableTurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableTurnError";
  }
}

export class TitleRejected extends Error {
  readonly rule: string;
  constructor(rule: string, sample: string) {
    super(`${rule}: ${JSON.stringify(headSlice(sample, 80))}`);
    this.name = "TitleRejected";
    this.rule = rule;
  }
}

export type TurnFailurePayload = { kind: "turn_failure"; message: string; runId?: string };

const GENERIC_TURN_FAILURE = "That turn failed and couldn't be completed. The details are in the operator error log.";

export function turnFailureMessage(err: unknown): string {
  if (err instanceof NonRetryableTurnError && err.message.trim()) return err.message;
  const message = errMessage(err);
  if (/\b(?:rate.?limit|too many requests|429)\b/i.test(message)) return FAILURE_REASONS.rateLimit;
  if (/\b(?:timed? out|timeout|ETIMEDOUT)\b/i.test(message)) return FAILURE_REASONS.timeout;
  if (/\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed)\b/i.test(message))
    return FAILURE_REASONS.connection;
  if (/\b(?:service unavailable|overloaded|503)\b/i.test(message)) return FAILURE_REASONS.unavailable;
  if (/\b(?:invalid api key|authentication failed|unauthorized|invalid credentials|expired token)\b/i.test(message))
    return FAILURE_REASONS.authentication;
  if (/\b(?:context.{0,20}(?:limit|length|window)|maximum context)\b/i.test(message)) return FAILURE_REASONS.context;
  return GENERIC_TURN_FAILURE;
}
