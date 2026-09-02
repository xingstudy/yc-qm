import { signedHeaders, withSourceAuthNonce } from "./core-client.ts";
import { errMessage } from "./errors.ts";

interface DirectoryLoginOption {
  sourceId: string;
  provider: string;
  displayName: string;
  authorizeUrl: string;
}

export interface ExternalIdentityAssertion {
  sourceId: string;
  provider: string;
  externalTenantId: string;
  externalSubjectId: string;
  displayName: string;
  corporateEmail: string | null;
  corporateEmailVerified: boolean;
  personalEmail: string | null;
  employeeNumber: string | null;
  mobile: string | null;
  status: "active" | "suspended" | "inactive";
  proof: string;
}

interface DirectoryCodeResolution {
  identity: ExternalIdentityAssertion;
  authorizationRequired: boolean;
}

interface DirectoryProfileIdentity {
  provider: string;
  externalTenantId: string;
  externalSubjectId: string;
}

export interface DirectorySourceClient {
  loginOptions(state: string): Promise<DirectoryLoginOption[]>;
  resolveCode(sourceId: string, code: string): Promise<DirectoryCodeResolution>;
  profileAuthorizationUrl?(
    sourceId: string,
    state: string,
    notify?: { externalSubjectId: string; brandName: string },
  ): Promise<{ authorizeUrl: string; promptDelivered: boolean }>;
  resolveProfileAuthorizationCode?(
    sourceId: string,
    code: string,
    expected: DirectoryProfileIdentity,
  ): Promise<ExternalIdentityAssertion>;
}

function assertion(value: unknown): ExternalIdentityAssertion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !["sourceId", "provider", "externalTenantId", "externalSubjectId", "displayName"].every(
      (key) => typeof record[key] === "string" && Boolean(record[key]),
    ) ||
    !["active", "suspended", "inactive"].includes(String(record.status)) ||
    typeof record.proof !== "string" ||
    !record.proof
  ) {
    return null;
  }
  const optional = (key: string): string | null =>
    typeof record[key] === "string" && record[key] ? String(record[key]) : null;
  return {
    sourceId: String(record.sourceId),
    provider: String(record.provider),
    externalTenantId: String(record.externalTenantId),
    externalSubjectId: String(record.externalSubjectId),
    displayName: String(record.displayName),
    corporateEmail: optional("corporateEmail"),
    corporateEmailVerified: record.corporateEmailVerified === true,
    personalEmail: optional("personalEmail"),
    employeeNumber: optional("employeeNumber"),
    mobile: optional("mobile"),
    status: record.status as ExternalIdentityAssertion["status"],
    proof: record.proof,
  };
}

export function createDirectorySourceClient(options: {
  coreApiUrl: string;
  signingSecret: string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  resolveTimeoutMs?: number;
  label?: string;
}): DirectorySourceClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 4_000;
  const resolveTimeoutMs = options.resolveTimeoutMs ?? 35_000;
  const label = options.label ?? "directory-source-client";
  return {
    async loginOptions(state) {
      const base = `/v1/auth/directory-sources/login-options?state=${encodeURIComponent(state)}`;
      const path = withSourceAuthNonce(base, options.signingSecret);
      try {
        const response = await fetchImpl(`${options.coreApiUrl}${path}`, {
          headers: signedHeaders(options.signingSecret, "GET", path),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as { options?: unknown };
        if (!Array.isArray(data.options)) throw new Error("invalid options response");
        return data.options.flatMap((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return [];
          const option = value as Record<string, unknown>;
          if (
            typeof option.sourceId !== "string" ||
            typeof option.provider !== "string" ||
            typeof option.displayName !== "string" ||
            typeof option.authorizeUrl !== "string"
          ) {
            return [];
          }
          return [
            {
              sourceId: option.sourceId,
              provider: option.provider,
              displayName: option.displayName,
              authorizeUrl: option.authorizeUrl,
            },
          ];
        });
      } catch (error) {
        throw new Error(`${label}: ${errMessage(error)}`, { cause: error });
      }
    },
    async resolveCode(sourceId, code) {
      const base = `/v1/auth/directory-sources/${encodeURIComponent(sourceId)}/resolve-code`;
      const path = withSourceAuthNonce(base, options.signingSecret);
      const body = JSON.stringify({ code });
      try {
        const response = await fetchImpl(`${options.coreApiUrl}${path}`, {
          method: "POST",
          headers: signedHeaders(options.signingSecret, "POST", path, body),
          body,
          signal: AbortSignal.timeout(resolveTimeoutMs),
        });
        if (response.status !== 200 && response.status !== 428) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as {
          protocolVersion?: unknown;
          identity?: unknown;
          authorizationRequired?: unknown;
        };
        const parsed = assertion(data.identity);
        const authorizationRequired = response.status === 428;
        if (
          data.protocolVersion !== 2 ||
          !parsed ||
          parsed.sourceId !== sourceId ||
          data.authorizationRequired !== authorizationRequired
        ) {
          throw new Error("invalid identity response");
        }
        return { identity: parsed, authorizationRequired };
      } catch (error) {
        throw new Error(`${label}: ${errMessage(error)}`, { cause: error });
      }
    },
    async profileAuthorizationUrl(sourceId, state, notify) {
      const base = `/v1/auth/directory-sources/${encodeURIComponent(sourceId)}/profile-authorization-url`;
      const path = withSourceAuthNonce(base, options.signingSecret);
      const body = JSON.stringify({ state, ...notify });
      try {
        const response = await fetchImpl(`${options.coreApiUrl}${path}`, {
          method: "POST",
          headers: signedHeaders(options.signingSecret, "POST", path, body),
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as { authorizeUrl?: unknown; promptDelivered?: unknown };
        if (typeof data.authorizeUrl !== "string" || !data.authorizeUrl) {
          throw new Error("invalid profile authorization response");
        }
        return { authorizeUrl: data.authorizeUrl, promptDelivered: data.promptDelivered === true };
      } catch (error) {
        throw new Error(`${label}: ${errMessage(error)}`, { cause: error });
      }
    },
    async resolveProfileAuthorizationCode(sourceId, code, expected) {
      const base = `/v1/auth/directory-sources/${encodeURIComponent(sourceId)}/resolve-profile-authorization-code`;
      const path = withSourceAuthNonce(base, options.signingSecret);
      const body = JSON.stringify({ code, ...expected });
      try {
        const response = await fetchImpl(`${options.coreApiUrl}${path}`, {
          method: "POST",
          headers: signedHeaders(options.signingSecret, "POST", path, body),
          body,
          signal: AbortSignal.timeout(resolveTimeoutMs),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as { identity?: unknown };
        const parsed = assertion(data.identity);
        if (
          !parsed ||
          parsed.sourceId !== sourceId ||
          parsed.provider !== expected.provider ||
          parsed.externalTenantId !== expected.externalTenantId ||
          parsed.externalSubjectId !== expected.externalSubjectId
        ) {
          throw new Error("invalid profile identity response");
        }
        return parsed;
      } catch (error) {
        throw new Error(`${label}: ${errMessage(error)}`, { cause: error });
      }
    },
  };
}
