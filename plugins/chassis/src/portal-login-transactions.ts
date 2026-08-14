import { signedHeaders, withSourceAuthNonce } from "./core-client.ts";
import { errMessage } from "./errors.ts";

const CREATE_PATH = "/v1/auth/portal-login/create";
const CLAIM_PATH = "/v1/auth/portal-login/claim";
const COMPLETE_PATH = "/v1/auth/portal-login/complete";
const REQUEST_TIMEOUT_MS = 4_000;

export type PortalLoginClaim =
  { status: "claimed"; payload: string; claimId: string } | { status: "missing" | "used" | "expired" | "unavailable" };

export interface PortalLoginTransactions {
  create(
    state: string,
    payload: string,
    expiresAtMs: number,
    clientBucket: string,
  ): Promise<"created" | "conflict" | "client_limited" | "global_limited" | "unavailable">;
  claim(state: string): Promise<PortalLoginClaim>;
  complete(
    state: string,
    claimId: string,
    outcome: "succeeded" | "failed",
  ): Promise<"completed" | "missing" | "mismatch" | "unavailable">;
}

export function corePortalLoginTransactions(
  coreApiUrl: string,
  signingSecret: string | undefined,
  label = "portal",
): PortalLoginTransactions {
  const call = async (path: string, value: unknown): Promise<Record<string, unknown> | null> => {
    const signedPath = withSourceAuthNonce(path, signingSecret);
    const body = JSON.stringify(value);
    try {
      const response = await fetch(`${coreApiUrl}${signedPath}`, {
        method: "POST",
        headers: signedHeaders(signingSecret, "POST", signedPath, body),
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        console.error(`[${label}] core refused a portal login transaction: HTTP ${response.status}`);
        return null;
      }
      const parsed = (await response.json()) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch (error) {
      console.error(`[${label}] core portal login transaction failed: ${errMessage(error)}`);
      return null;
    }
  };

  return {
    async create(state, payload, expiresAtMs, clientBucket) {
      const result = await call(CREATE_PATH, { state, payload, expiresAtMs, clientBucket });
      return result?.status === "created" ||
        result?.status === "conflict" ||
        result?.status === "client_limited" ||
        result?.status === "global_limited"
        ? result.status
        : "unavailable";
    },
    async claim(state) {
      const result = await call(CLAIM_PATH, { state });
      if (result?.status === "claimed" && typeof result.payload === "string" && typeof result.claimId === "string") {
        return { status: "claimed", payload: result.payload, claimId: result.claimId };
      }
      if (result?.status === "missing" || result?.status === "used" || result?.status === "expired") {
        return { status: result.status };
      }
      return { status: "unavailable" };
    },
    async complete(state, claimId, outcome) {
      const result = await call(COMPLETE_PATH, { state, claimId, outcome });
      return result?.status === "completed" || result?.status === "missing" || result?.status === "mismatch"
        ? result.status
        : "unavailable";
    },
  };
}
