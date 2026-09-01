import { createHash } from "node:crypto";
import type { DirectoryProviderAdapter, DirectoryProviderConfiguration } from "../provider.ts";
import type {
  DirectoryEmail,
  DirectoryMemberStatus,
  ExternalIdentityAssertion,
  NormalizedDirectoryMember,
  NormalizedDirectoryUnit,
} from "../types.ts";
import { normalizeDirectoryEmail } from "../types.ts";

const API_ORIGIN = "https://qyapi.weixin.qq.com";
const AUTHORIZE_URL = "https://open.work.weixin.qq.com/wwopen/sso/qrConnect";
const TIMEOUT_MS = 8_000;
const READ_CONCURRENCY = 8;

interface TokenEntry {
  token: string;
  expiresAt: number;
}

interface WeComProviderOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numericString(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return stringValue(value);
}

function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/.test(value);
}

function configValues(config: DirectoryProviderConfiguration): {
  corpId: string;
  agentId: string;
  redirectUri: string;
  applicationSecret: string;
  directorySyncSecret: string;
} {
  const corpId = stringValue(config.publicConfig.corpId);
  const agentId = stringValue(config.publicConfig.agentId);
  const redirectUri = stringValue(config.publicConfig.redirectUri);
  const applicationSecret =
    stringValue(config.secretConfig.applicationSecret) || stringValue(config.secretConfig.secret);
  const directorySyncSecret = stringValue(config.secretConfig.directorySyncSecret);
  if (!corpId || !agentId || !redirectUri || !applicationSecret) throw new Error("wecom_config_incomplete");
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== "https:" && redirect.hostname !== "localhost" && redirect.hostname !== "127.0.0.1") {
    throw new Error("wecom_redirect_uri_invalid");
  }
  return { corpId, agentId, redirectUri: redirect.toString(), applicationSecret, directorySyncSecret };
}

function sanitizedError(label: string, code: number): Error {
  return new Error(`wecom_${label}_failed:${code}`);
}

async function readJson(
  fetchImpl: typeof fetch,
  url: URL,
  init: RequestInit,
  label: string,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`wecom_${label}_non_json`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`wecom_${label}_invalid_json`);
  const data = parsed as Record<string, unknown>;
  const errcode = typeof data.errcode === "number" ? data.errcode : 0;
  if (!response.ok || errcode !== 0) throw sanitizedError(label, errcode || response.status);
  return data;
}

function memberStatus(value: unknown): DirectoryMemberStatus {
  if (value === 1 || value === "1") return "active";
  if (value === 2 || value === "2") return "suspended";
  if (value === 4 || value === "4" || value === 5 || value === "5") return "inactive";
  throw new Error("wecom_user_status_invalid");
}

function employeeNumber(data: Record<string, unknown>): string | null {
  const direct = stringValue(data.employee_number) || stringValue(data.employeeNumber);
  if (direct) return direct.slice(0, 200);
  const extattr = data.extattr;
  if (!extattr || typeof extattr !== "object" || Array.isArray(extattr)) return null;
  const attrs = (extattr as { attrs?: unknown }).attrs;
  if (!Array.isArray(attrs)) return null;
  for (const attr of attrs) {
    if (!attr || typeof attr !== "object" || Array.isArray(attr)) continue;
    const record = attr as Record<string, unknown>;
    const name = stringValue(record.name).toLowerCase();
    if (!["employee_number", "employee number", "工号"].includes(name)) continue;
    const value = stringValue(record.value) || stringValue((record.text as Record<string, unknown> | undefined)?.value);
    if (value) return value.slice(0, 200);
  }
  return null;
}

function emailsFrom(data: Record<string, unknown>): DirectoryEmail[] {
  const result: DirectoryEmail[] = [];
  const corporate = normalizeDirectoryEmail(stringValue(data.biz_mail));
  const personal = normalizeDirectoryEmail(stringValue(data.email));
  if (validEmail(corporate)) result.push({ value: corporate, kind: "corporate", verified: true });
  if (validEmail(personal) && personal !== corporate)
    result.push({ value: personal, kind: "personal", verified: false });
  return result;
}

function normalizedMember(
  data: Record<string, unknown>,
  context: { orgId: string; sourceId: string; corpId: string; now: number; fallbackUserId?: string },
): NormalizedDirectoryMember {
  const externalSubjectId = stringValue(data.userid) || stringValue(data.UserId) || context.fallbackUserId || "";
  if (!externalSubjectId) throw new Error("wecom_user_missing_userid");
  const status = memberStatus(data.status);
  const displayName = (stringValue(data.name) || stringValue(data.alias)).slice(0, 200);
  if (!displayName) throw new Error("wecom_user_missing_name");
  const emails = emailsFrom(data);
  let departments: string[];
  if (Array.isArray(data.department)) departments = data.department.map(numericString).filter(Boolean);
  else if (Array.isArray(data.department_ids)) departments = data.department_ids.map(numericString).filter(Boolean);
  else throw new Error("wecom_user_missing_departments");
  const mobile = stringValue(data.mobile) || null;
  const profile = {
    externalSubjectId,
    displayName,
    emails,
    employeeNumber: employeeNumber(data),
    mobile,
    departmentIds: departments,
    primaryDepartmentId:
      numericString(data.main_department) || numericString(data.mainDepartment) || departments[0] || null,
    status,
  };
  const profileHash = createHash("sha256").update(JSON.stringify(profile)).digest("base64url");
  return {
    orgId: context.orgId,
    sourceId: context.sourceId,
    provider: "wecom",
    externalTenantId: context.corpId,
    ...profile,
    revision: profileHash,
    observedAt: context.now,
    profileHash,
    matchState: status === "inactive" ? "inactive" : "unmatched",
    matchReason: status === "inactive" ? "external_inactive" : "not_evaluated",
    matchedPrincipalId: null,
    ignoredBy: null,
    ignoredReason: null,
    lastLoginAttemptAt: null,
  };
}

export function createWeComDirectoryProvider(options: WeComProviderOptions = {}): DirectoryProviderAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const tokens = new Map<string, TokenEntry>();
  const capabilities = {
    login: true,
    fullSync: true,
    targetedLookup: true,
    employeeNumber: true,
    mobile: true,
    departments: true,
    corporateEmailSubjectLookup: true,
    trustedCorporateEmail: true,
    organizationUnits: true,
    memberOrganizationUnits: true,
    incrementalSync: false,
    deprovisioning: true,
  } as const;

  const tokenFor = async (corpId: string, secret: string, label: string): Promise<string> => {
    const key = createHash("sha256").update(`${corpId}\n${secret}`).digest("base64url");
    const cached = tokens.get(key);
    if (cached && cached.expiresAt > now() + 60_000) return cached.token;
    const url = new URL("/cgi-bin/gettoken", API_ORIGIN);
    url.searchParams.set("corpid", corpId);
    url.searchParams.set("corpsecret", secret);
    const data = await readJson(fetchImpl, url, { headers: { accept: "application/json" } }, label);
    const token = stringValue(data.access_token);
    const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 7_200;
    if (!token) throw new Error(`wecom_${label}_missing`);
    tokens.set(key, { token, expiresAt: now() + Math.max(60, expiresIn) * 1000 });
    return token;
  };

  const applicationTokenFor = async (
    config: DirectoryProviderConfiguration,
  ): Promise<{ token: string; corpId: string }> => {
    const values = configValues(config);
    return {
      token: await tokenFor(values.corpId, values.applicationSecret, "application_token"),
      corpId: values.corpId,
    };
  };

  const directoryTokenFor = async (config: DirectoryProviderConfiguration): Promise<string> => {
    const values = configValues(config);
    if (!values.directorySyncSecret) throw new Error("wecom_directory_sync_secret_missing");
    return tokenFor(values.corpId, values.directorySyncSecret, "directory_token");
  };

  const getUser = async (
    config: DirectoryProviderConfiguration,
    context: { orgId: string; sourceId: string; externalSubjectId: string },
  ): Promise<NormalizedDirectoryMember | null> => {
    const { token, corpId } = await applicationTokenFor(config);
    const url = new URL("/cgi-bin/user/get", API_ORIGIN);
    url.searchParams.set("access_token", token);
    url.searchParams.set("userid", context.externalSubjectId);
    try {
      const data = await readJson(fetchImpl, url, { headers: { accept: "application/json" } }, "user_get");
      return normalizedMember(data, { ...context, corpId, now: now(), fallbackUserId: context.externalSubjectId });
    } catch (error) {
      if (error instanceof Error && error.message === "wecom_user_get_failed:60111") return null;
      throw error;
    }
  };

  return {
    id: "wecom",
    displayName: "WeCom",
    capabilities,
    publicFields: ["corpId", "agentId", "redirectUri"],
    secretFields: ["applicationSecret", "directorySyncSecret"],
    requiredSecretFields: ["applicationSecret"],
    legacySecretField: "secret",
    normalizeSecretConfig(secretConfig) {
      const { secret, ...normalized } = secretConfig;
      if (!normalized.applicationSecret && secret) normalized.applicationSecret = secret;
      return normalized;
    },
    configuredTenantId(publicConfig) {
      return stringValue(publicConfig.corpId) || null;
    },
    async testConnection(config) {
      const values = configValues(config);
      const { token } = await applicationTokenFor(config);
      const agentUrl = new URL("/cgi-bin/agent/get", API_ORIGIN);
      agentUrl.searchParams.set("access_token", token);
      agentUrl.searchParams.set("agentid", values.agentId);
      const agent = await readJson(fetchImpl, agentUrl, { headers: { accept: "application/json" } }, "agent_get");
      if (numericString(agent.agentid) !== values.agentId) throw new Error("wecom_agent_tenant_mismatch");
      if (values.directorySyncSecret) {
        const visibilityUrl = new URL("/cgi-bin/user/list_id", API_ORIGIN);
        visibilityUrl.searchParams.set("access_token", await directoryTokenFor(config));
        await readJson(
          fetchImpl,
          visibilityUrl,
          { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: 1 }) },
          "user_list_id",
        );
      }
      return {
        externalTenantId: values.corpId,
        capabilities: {
          ...capabilities,
          fullSync: Boolean(values.directorySyncSecret),
          organizationUnits: Boolean(values.directorySyncSecret),
          memberOrganizationUnits: Boolean(values.directorySyncSecret),
        },
      };
    },
    async *fullSync(config, context) {
      const values = configValues(config);
      const token = await directoryTokenFor(config);
      let cursor = "";
      const seenCursors = new Set<string>();
      const userIds = new Set<string>();
      for (;;) {
        const url = new URL("/cgi-bin/user/list_id", API_ORIGIN);
        url.searchParams.set("access_token", token);
        const data = await readJson(
          fetchImpl,
          url,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...(cursor ? { cursor } : {}), limit: 10_000 }),
          },
          "user_list_id",
        );
        const raw = data.dept_user ?? data.userlist ?? data.user_list;
        if (!Array.isArray(raw)) throw new Error("wecom_user_list_id_missing_users");
        for (const entry of raw) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new Error("wecom_user_list_id_invalid_user");
          }
          const userId = stringValue((entry as Record<string, unknown>).userid);
          if (!userId) throw new Error("wecom_user_list_id_invalid_user");
          userIds.add(userId);
        }
        const rawCursor = data.next_cursor;
        if (rawCursor === undefined || rawCursor === null || rawCursor === "") break;
        if (typeof rawCursor !== "string" || !rawCursor.trim()) {
          throw new Error("wecom_user_list_id_invalid_cursor");
        }
        const next = rawCursor;
        if (seenCursors.has(next)) throw new Error("wecom_user_list_id_repeated_cursor");
        seenCursors.add(next);
        cursor = next;
      }
      const ids = [...userIds];
      for (let offset = 0; offset < ids.length; offset += READ_CONCURRENCY) {
        const batch = ids.slice(offset, offset + READ_CONCURRENCY);
        const members = await Promise.all(
          batch.map((externalSubjectId) => getUser(config, { ...context, externalSubjectId })),
        );
        if (members.some((member) => member === null)) throw new Error("wecom_user_disappeared_during_sync");
        for (const member of members) yield { ...member!, externalTenantId: values.corpId };
      }
    },
    targetedLookup: getUser,
    async lookupByCorporateEmail(config, input) {
      const email = normalizeDirectoryEmail(input.email);
      if (!validEmail(email)) return { status: "not_found" };
      const { token } = await applicationTokenFor(config);
      const url = new URL("/cgi-bin/user/get_userid_by_email", API_ORIGIN);
      url.searchParams.set("access_token", token);
      try {
        const data = await readJson(
          fetchImpl,
          url,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email, email_type: 1 }),
          },
          "email_lookup",
        );
        const externalSubjectId = stringValue(data.userid);
        if (!externalSubjectId) return { status: "not_found" };
        return { status: "resolved", externalSubjectId };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const code = Number(message.split(":").at(-1));
        if (code === 60111) return { status: "not_found", errorCode: "not_found" };
        if ([48002, 48004, 60011].includes(code)) return { status: "unauthorized", errorCode: "unauthorized" };
        if ([45009, 45011, 45033].includes(code)) return { status: "rate_limited", errorCode: "rate_limited" };
        return { status: "temporary_error", errorCode: "provider_error" };
      }
    },
    async *organizationUnits(config, context) {
      const values = configValues(config);
      const token = await directoryTokenFor(config);
      const listUrl = new URL("/cgi-bin/department/simplelist", API_ORIGIN);
      listUrl.searchParams.set("access_token", token);
      const listed = await readJson(fetchImpl, listUrl, { headers: { accept: "application/json" } }, "department_list");
      if (!Array.isArray(listed.department_id)) throw new Error("wecom_department_list_missing");
      const records = listed.department_id.map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("wecom_department_list_invalid");
        }
        const record = value as Record<string, unknown>;
        const externalUnitId = numericString(record.id);
        if (!externalUnitId) throw new Error("wecom_department_list_invalid");
        const parent = numericString(record.parentid);
        const order = Number(record.order);
        return {
          externalUnitId,
          parentExternalUnitId: externalUnitId === "1" || !parent || parent === "0" ? null : parent,
          sortOrder: Number.isFinite(order) ? Math.trunc(order) : 0,
        };
      });
      for (let offset = 0; offset < records.length; offset += READ_CONCURRENCY) {
        const batch = records.slice(offset, offset + READ_CONCURRENCY);
        const units = await Promise.all(
          batch.map(async (record): Promise<NormalizedDirectoryUnit> => {
            const detailUrl = new URL("/cgi-bin/department/get", API_ORIGIN);
            detailUrl.searchParams.set("access_token", token);
            detailUrl.searchParams.set("id", record.externalUnitId);
            const detail = await readJson(
              fetchImpl,
              detailUrl,
              { headers: { accept: "application/json" } },
              "department_get",
            );
            const department =
              detail.department && typeof detail.department === "object" && !Array.isArray(detail.department)
                ? (detail.department as Record<string, unknown>)
                : {};
            const displayName = stringValue(department.name) || null;
            const parent = numericString(department.parentid);
            const order = Number(department.order);
            const profile = {
              externalUnitId: record.externalUnitId,
              parentExternalUnitId:
                record.externalUnitId === "1" || (!parent && record.parentExternalUnitId === null)
                  ? null
                  : parent || record.parentExternalUnitId,
              displayName,
              sortOrder: Number.isFinite(order) ? Math.trunc(order) : record.sortOrder,
              status: "active" as const,
            };
            const profileHash = createHash("sha256").update(JSON.stringify(profile)).digest("base64url");
            return {
              orgId: context.orgId,
              sourceId: context.sourceId,
              provider: "wecom",
              externalTenantId: values.corpId,
              ...profile,
              revision: profileHash,
              observedAt: now(),
              profileHash,
            };
          }),
        );
        for (const unit of units) yield unit;
      }
    },
    async resolveLoginCode(config, input): Promise<ExternalIdentityAssertion> {
      const { token, corpId } = await applicationTokenFor(config);
      const identityUrl = new URL("/cgi-bin/auth/getuserinfo", API_ORIGIN);
      identityUrl.searchParams.set("access_token", token);
      identityUrl.searchParams.set("code", input.code);
      const identity = await readJson(fetchImpl, identityUrl, { headers: { accept: "application/json" } }, "login");
      const externalSubjectId = stringValue(identity.UserId) || stringValue(identity.userid);
      if (!externalSubjectId) throw new Error("wecom_login_missing_userid");
      const member = await getUser(config, { orgId: "", sourceId: input.sourceId, externalSubjectId });
      if (!member) throw new Error("wecom_login_user_not_visible");
      const corporateEmail = member.emails.find((email) => email.kind === "corporate")?.value ?? null;
      const personalEmail = member.emails.find((email) => email.kind === "personal")?.value ?? null;
      return {
        sourceId: input.sourceId,
        provider: "wecom",
        externalTenantId: corpId,
        externalSubjectId,
        displayName: member.displayName,
        corporateEmail,
        personalEmail,
        employeeNumber: member.employeeNumber,
        mobile: member.mobile,
        status: member.status,
      };
    },
    authorizeUrl(config, input) {
      const corpId = stringValue(config.corpId);
      const agentId = stringValue(config.agentId);
      const redirectUri = stringValue(config.redirectUri);
      if (!corpId || !agentId || !redirectUri) throw new Error("wecom_config_incomplete");
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set("appid", corpId);
      url.searchParams.set("agentid", agentId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", input.state);
      return url.toString();
    },
  };
}
