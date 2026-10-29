import { headSlice } from "../util/text.ts";
import { safeFailureReason } from "../../plugins/chassis/src/failure-copy.ts";
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
  const message = errMessage(err);
  const reason = safeFailureReason(message);
  if (reason) return reason;
  if (err instanceof NonRetryableTurnError && err.message.trim()) return err.message;
  return GENERIC_TURN_FAILURE;
}
