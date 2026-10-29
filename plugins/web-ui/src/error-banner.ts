import type { AssistantMessage } from "@earendil-works/pi-ai";
import { errMessage } from "../../chassis/src/errors.ts";
import { FAILURE_REASONS, safeFailureReason, usageLimitFailureReason } from "../../chassis/src/failure-copy.ts";
import { SECURITY_QUARANTINE_REFUSAL_TEXT } from "../../chassis/src/security-quarantine.ts";
import { html, t } from "./i18n.ts";

const FAILURE_COPY: Record<string, readonly [string, string]> = {
  "Source changed": [
    "The import source changed",
    "The source changed since it was reviewed. Preview the skills again before importing.",
  ],
  "Connect Google": ["Connect your Google account", "Connect your Google account under Keychain, then try again."],
  "HTTP 400": [
    "Check the request details",
    "Some request details are missing or invalid. Check your entries, then try again.",
  ],
  "HTTP 404": [
    "This item is no longer available",
    "This item may have been removed or moved. Refresh the page and check that you still have access.",
  ],
  "HTTP 409": [
    "The latest state has changed",
    "The item or conversation changed before this action finished. Refresh its status before trying again.",
  ],
  "HTTP 413": ["The file or request is too large", "Choose a smaller file or shorten the request, then try again."],
  "HTTP 415": ["This file type is not supported", "Choose a supported file format, then try again."],
  "HTTP 422": [
    "Check the request details",
    "Some request details are missing or invalid. Check your entries, then try again.",
  ],
  "HTTP 500": [
    "The service could not complete this request",
    "The service could not complete this request, and the cause is unclear. Check its latest status before retrying. If this keeps happening, contact an administrator.",
  ],
  [FAILURE_REASONS.rateLimit]: [
    "Too many requests right now",
    "The AI service or a tool has temporarily limited requests because it is busy. Wait a few minutes, then try again.",
  ],
  [FAILURE_REASONS.timeout]: [
    "The task took too long",
    "The AI service or a tool did not respond in time, so this task did not finish. Check any results already shown before retrying, or ask for a smaller task.",
  ],
  [FAILURE_REASONS.connection]: [
    "Could not connect to a required service",
    "A service needed for this request could not be reached. Check your connection and try again later. If this keeps happening, contact an administrator.",
  ],
  [FAILURE_REASONS.unavailable]: [
    "A required service is temporarily unavailable",
    "The AI service or a tool is temporarily unavailable, so this task did not finish. Try again later. If this keeps happening, contact an administrator.",
  ],
  [FAILURE_REASONS.authentication]: [
    "An account needs to be reconnected",
    "An account needed for this request could not sign in. Reconnect the account, or ask an administrator to check its connection.",
  ],
  [FAILURE_REASONS.context]: [
    "This conversation or request is too long",
    "The selected model cannot process this much conversation or content at once. Shorten the request or start a new conversation, then try again.",
  ],
  [FAILURE_REASONS.billing]: [
    "The AI account has no available credit or quota",
    "The AI provider reports that this account has no available credit or quota. Check its billing or ask an administrator to restore access. Retrying immediately will not help.",
  ],
  [FAILURE_REASONS.permission]: [
    "Access is needed to continue",
    "The current account or model does not have access to perform this request. Ask an administrator to check permissions, or choose another available model.",
  ],
  [FAILURE_REASONS.model]: [
    "The selected AI model is unavailable",
    "This AI model is unavailable or is not configured for this conversation. Choose another available model, or contact an administrator.",
  ],
  [FAILURE_REASONS.busy]: [
    "Another task is still running",
    "This conversation is still working on another task. Wait for it to finish, then send your request again.",
  ],
  [SECURITY_QUARANTINE_REFUSAL_TEXT]: [
    "This request needs a safety review",
    "A safety check stopped this request because of its message or conversation context. Adjust the request or ask an administrator to review it.",
  ],
  "Approve or deny the pending command to continue.": [
    "Your approval is needed",
    "This conversation is waiting for a decision. Review the pending command and approve or deny it to continue.",
  ],
  "This approval is no longer available — it may have expired or already been handled.": [
    "This approval is no longer available",
    "The approval may have expired or already been handled. Check the latest conversation status before trying again.",
  ],
  "This approval couldn't be applied right now — the conversation is waiting on a different approval.": [
    "A different approval is waiting",
    "Review the current pending command in this conversation and approve or deny it to continue.",
  ],
  "Timed out waiting for the agent to respond.": [
    "We could not confirm the task's status",
    "The response could not be confirmed in time. The task may still be running. Check this conversation again before resending the request to avoid running it twice.",
  ],
  "Nothing to send.": ["The message was not sent", "Enter a message or add an attachment, then try sending it again."],
};

function failureCopy(message: string): readonly [string, string] | undefined {
  const usageLimit = usageLimitFailureReason(message);
  if (usageLimit) return ["AI usage limit reached", usageLimit.replace(/^the /, "The ")];
  if (Object.hasOwn(FAILURE_COPY, message)) return FAILURE_COPY[message];
  return FAILURE_COPY[safeFailureReason(message) ?? ""];
}

export function userErrorMessage(error: unknown, fallback?: string): string {
  const message = errMessage(error);
  const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
  const copy = failureCopy(message) ?? (typeof status === "number" ? failureCopy(`HTTP ${status}`) : undefined);
  const description = copy
    ? t(copy[1])
    : `${fallback ? `${t(fallback)} ` : ""}${t("The cause is unclear. Check the latest state before trying again. If this keeps happening, contact an administrator.")}`;
  const reference = message.match(/\(run [a-zA-Z0-9-]{1,80}\)/)?.[0];
  return reference ? `${description} ${reference}` : description;
}

export function turnErrorNotice(message: string) {
  const [title, description] = failureCopy(message) ?? [
    "This request could not be completed",
    "The request ended before we could confirm completion, and the cause is unclear. Check any results already shown before retrying. If this keeps happening, contact an administrator and include the technical details below.",
  ];
  return html`<div class="composer-note turn-error-notice" role="status">
    <strong>${t(title)}</strong>
    <p>${t(description)}</p>
    <details>
      <summary>${t("Technical details")}</summary>
      <div>${message}</div>
    </details>
  </div>`;
}

export function composerErrorNotice(message: string) {
  return failureCopy(message) ? turnErrorNotice(message) : html`<div class="composer-error">${t(message)}</div>`;
}

type MaybeAssistant = { role?: string; stopReason?: AssistantMessage["stopReason"]; errorMessage?: string };

export function showStateError(messages: readonly unknown[], stateError: string | undefined): boolean {
  if (!stateError || stateError === "aborted") return false;
  const last = messages[messages.length - 1] as MaybeAssistant | undefined;
  return !(last?.role === "assistant" && last.stopReason === "error" && last.errorMessage === stateError);
}
