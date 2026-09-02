import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AuditEvent, AuditLog } from "../audit/audit-log.ts";
import {
  decryptSecret,
  deriveConnectorKey,
  encryptSecret,
  type SecretKey,
} from "../connectors/connector-client-store.ts";
import type { ScopeId } from "../types.ts";
import { errMessage, swallow } from "../util/errors.ts";
import { isProductionPlaceholder } from "../../plugins/chassis/src/production-placeholders.ts";
import type {
  DirectoryProviderAdapter,
  DirectoryConnectionResult,
  DirectoryProviderConfiguration,
  DirectoryProviderRegistry,
} from "./provider.ts";
import type { DirectorySourceStore } from "./directory-source-store.ts";
import type {
  DirectoryLoginOption,
  DirectoryMatchPolicy,
  DirectorySource,
  DirectorySourceMode,
  ExternalIdentityAssertion,
  StoredDirectorySource,
} from "./types.ts";
import { isDirectoryMatchPolicy, publicDirectorySource } from "./types.ts";

export interface EnvironmentDirectorySource {
  provider: string;
  name: string;
  publicConfig: Record<string, string>;
  secretConfig: Record<string, string>;
  loginEnabled?: boolean;
  syncEnabled?: boolean;
  mode?: DirectorySourceMode;
  jitProvisioningEnabled?: boolean;
  scheduleMinutes?: number;
  matchPolicy?: DirectoryMatchPolicy;
}

interface DirectorySourceInput {
  provider: string;
  name: string;
  publicConfig: Record<string, string>;
  secretConfig: Record<string, string>;
  loginEnabled?: boolean;
  syncEnabled?: boolean;
  mode?: DirectorySourceMode;
  jitProvisioningEnabled?: boolean;
  scheduleMinutes?: number;
  matchPolicy?: DirectoryMatchPolicy;
}

interface DirectorySourcePatch {
  expectedRevision: number;
  name?: string;
  publicConfig?: Record<string, string>;
  secretConfig?: Record<string, string>;
  loginEnabled?: boolean;
  syncEnabled?: boolean;
  mode?: DirectorySourceMode;
  jitProvisioningEnabled?: boolean;
  scheduleMinutes?: number;
  matchPolicy?: DirectoryMatchPolicy;
  status?: "active" | "paused";
}

export interface DirectorySourceService {
  readonly durable: boolean;
  readonly ready: Promise<void>;
  catalog(): ReturnType<DirectoryProviderRegistry["catalog"]>;
  list(includeDeleted?: boolean): Promise<DirectorySource[]>;
  get(sourceId: string, includeDeleted?: boolean): Promise<DirectorySource | null>;
  create(input: DirectorySourceInput, actor: string): Promise<DirectorySource>;
  update(sourceId: string, patch: DirectorySourcePatch, actor: string): Promise<DirectorySource | "conflict">;
  pause(sourceId: string, expectedRevision: number, actor: string): Promise<DirectorySource | "conflict" | null>;
  delete(sourceId: string, expectedRevision: number, actor: string): Promise<DirectorySource | "conflict" | null>;
  restore(
    sourceId: string,
    expectedRevision: number,
    secretConfig: Record<string, string>,
    actor: string,
  ): Promise<DirectorySource | "conflict" | null>;
  confirmPreview(sourceId: string, sourceRevision: number): Promise<DirectorySource | "conflict" | null>;
  setReconciliation(
    sourceId: string,
    sourceRevision: number,
    status: "running" | "ready" | "blocked" | "stale",
    expiresAt?: number,
  ): Promise<DirectorySource | "conflict" | null>;
  test(sourceId: string): Promise<DirectorySource | null>;
  configuration(sourceId: string): Promise<{ source: DirectorySource; config: DirectoryProviderConfiguration } | null>;
  loginOptions(state: string): Promise<DirectoryLoginOption[]>;
  resolveLoginCode(sourceId: string, code: string): Promise<ExternalIdentityAssertion>;
  profileAuthorizationSupported(sourceId: string): Promise<boolean>;
  profileAuthorizationUrl(
    sourceId: string,
    state: string,
    notify?: { externalSubjectId: string; brandName: string },
  ): Promise<{ authorizeUrl: string; promptDelivered: boolean }>;
  resolveProfileAuthorizationCode(
    sourceId: string,
    code: string,
    expected: { provider: string; externalTenantId: string; externalSubjectId: string },
  ): Promise<ExternalIdentityAssertion>;
  verifyLoginAssertion(assertion: ExternalIdentityAssertion): { jti: string; expiresAtMs: number } | null;
}

const MIN_SCHEDULE_MINUTES = 15;
const MAX_SCHEDULE_MINUTES = 24 * 60;

function cleanPublicConfig(value: Record<string, string>, allowed: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!allowed.includes(key) || typeof raw !== "string") throw new Error("directory_source_invalid_public_config");
    const cleaned = raw.trim();
    if (!cleaned || cleaned.length > 2_000) throw new Error("directory_source_invalid_public_config");
    result[key] = cleaned;
  }
  if (allowed.some((key) => !result[key])) throw new Error("directory_source_incomplete_public_config");
  return result;
}

function scheduleMinutes(value: number | undefined): number {
  const result = value ?? 360;
  if (!Number.isInteger(result) || result < MIN_SCHEDULE_MINUTES || result > MAX_SCHEDULE_MINUTES) {
    throw new Error("directory_source_invalid_schedule");
  }
  return result;
}

function sourceMode(value: DirectorySourceMode | undefined): DirectorySourceMode {
  if (value === undefined || value === "identity_only") return "identity_only";
  if (value === "managed_directory") return value;
  throw new Error("directory_source_invalid_mode");
}

function supportsManagedDirectory(capabilities: DirectoryConnectionResult["capabilities"]): boolean {
  return (
    capabilities.fullSync && capabilities.organizationUnits === true && capabilities.memberOrganizationUnits === true
  );
}

function supportsAutomaticEmailLinking(
  capabilities: DirectoryConnectionResult["capabilities"],
  matchPolicy: DirectoryMatchPolicy,
): boolean {
  return (
    matchPolicy === "verified_corporate_email" &&
    capabilities.corporateEmailSubjectLookup === true &&
    capabilities.trustedCorporateEmail === true
  );
}

function nextPreviewConfirmation(source: StoredDirectorySource, revision: number, invalidated: boolean): number | null {
  if (invalidated) return null;
  return source.previewConfirmedRevision === source.revision ? revision : source.previewConfirmedRevision;
}

function nextReconciledSourceRevision(
  source: StoredDirectorySource,
  revision: number,
  invalidated: boolean,
): number | null {
  if (invalidated) return null;
  return source.reconciledSourceRevision === source.revision ? revision : source.reconciledSourceRevision;
}

function cleanName(value: string): string {
  const result = value.trim();
  if (!result || result.length > 120) throw new Error("directory_source_invalid_name");
  return result;
}

function cleanSecretConfig(
  value: Record<string, string>,
  allowed: readonly string[],
  required: readonly string[],
  partial = false,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!allowed.includes(key) || typeof raw !== "string") throw new Error("directory_source_invalid_secret");
    const cleaned = raw.trim();
    if (!cleaned || cleaned.length > 4_096) throw new Error("directory_source_invalid_secret");
    result[key] = cleaned;
  }
  if (!partial && required.some((key) => !result[key])) throw new Error("directory_source_incomplete_secret");
  return result;
}

function encodeSecretConfig(value: Record<string, string>): string {
  return JSON.stringify(value);
}

function decodeSecretConfig(value: string, legacyField?: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    if (legacyField) return { [legacyField]: value };
    throw new Error("directory_source_secret_unavailable");
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, string>;
  }
  if (legacyField) return { [legacyField]: value };
  throw new Error("directory_source_secret_unavailable");
}

function environmentId(provider: string, tenantId: string): string {
  return `env-${provider}-${createHash("sha256").update(tenantId).digest("hex").slice(0, 16)}`;
}

export function createDirectorySourceService(options: {
  orgId: string;
  store: DirectorySourceStore;
  providers: DirectoryProviderRegistry;
  keyMaterial: Buffer | string;
  auditLog: AuditLog;
  environmentSources?: readonly EnvironmentDirectorySource[];
  now?: () => number;
}): DirectorySourceService {
  const { orgId, store, providers, auditLog } = options;
  const now = options.now ?? Date.now;
  const key: SecretKey = deriveConnectorKey(options.keyMaterial, "directory-source-secrets");
  const assertionKey: SecretKey = deriveConnectorKey(options.keyMaterial, "directory-login-assertions");
  const scopeLabel = `org:${orgId}` as ScopeId;
  const environmentConfigurations = new Map<
    string,
    {
      publicConfig: Record<string, string>;
      secretConfig: Record<string, string>;
      externalTenantId: string;
      environmentConfigFingerprint: string;
      syncRequested: boolean;
      jitRequested: boolean;
    }
  >();
  const requiredSecretFields = (adapter: DirectoryProviderAdapter): readonly string[] =>
    adapter.requiredSecretFields ?? adapter.secretFields;
  const sortedRecord = (value: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
  const fingerprintEnvironmentConfiguration = (
    configured: EnvironmentDirectorySource,
    publicConfig: Record<string, string>,
    secretConfig: Record<string, string>,
  ): string =>
    createHmac("sha256", key.current)
      .update(
        JSON.stringify({
          provider: configured.provider,
          publicConfig: sortedRecord(publicConfig),
          secretConfig: sortedRecord(secretConfig),
          matchPolicy: configured.matchPolicy,
        }),
      )
      .digest("base64url");
  const cleanProviderSecrets = (
    adapter: DirectoryProviderAdapter,
    value: Record<string, string>,
    partial = false,
  ): Record<string, string> =>
    cleanSecretConfig(
      adapter.normalizeSecretConfig?.(value) ?? value,
      adapter.secretFields,
      requiredSecretFields(adapter),
      partial,
    );
  const decodeProviderSecrets = (adapter: DirectoryProviderAdapter, value: string): Record<string, string> =>
    cleanProviderSecrets(
      adapter,
      decodeSecretConfig(
        value,
        adapter.legacySecretField ?? (adapter.secretFields.length === 1 ? adapter.secretFields[0] : undefined),
      ),
      true,
    );

  const audit = (
    actor: string,
    action: string,
    sourceId: string,
    detail: Record<string, unknown> = {},
  ): AuditEvent => ({
    at: now(),
    principalId: actor,
    action,
    resource: sourceId,
    scopeLabel,
    orgId,
    actorKind: actor.startsWith("system:") ? "system" : "user",
    source: "directory-source",
    result: "success",
    detail: JSON.stringify(detail),
  });

  const recordMemoryAudit = (event: AuditEvent): void => {
    if (!store.durable) auditLog.record(event);
  };

  const publicSource = (source: StoredDirectorySource): DirectorySource => {
    const adapter = providers.get(source.provider);
    let saved: Record<string, string> = {};
    if (source.origin === "environment") {
      saved = environmentConfigurations.get(source.id)?.secretConfig ?? {};
    } else if (source.secretEnc) {
      try {
        saved = adapter ? decodeProviderSecrets(adapter, decryptSecret(source.secretEnc, key)) : {};
      } catch {
        saved = {};
      }
    }
    const secretPresence = Object.fromEntries(
      (adapter?.secretFields ?? []).map((field) => [field, Boolean(saved[field])]),
    );
    return {
      ...publicDirectorySource(source),
      hasSecret: Object.values(secretPresence).some(Boolean),
      secretPresence,
    };
  };

  const assertionClaims = (assertion: ExternalIdentityAssertion): ExternalIdentityAssertion => {
    const optional = (value: string | null | undefined): string | null => value?.trim() || null;
    const corporateEmail = optional(assertion.corporateEmail);
    return {
      sourceId: assertion.sourceId.trim(),
      provider: assertion.provider.trim(),
      externalTenantId: assertion.externalTenantId.trim(),
      externalSubjectId: assertion.externalSubjectId.trim(),
      displayName: assertion.displayName.trim(),
      corporateEmail,
      corporateEmailVerified: corporateEmail !== null && assertion.corporateEmailVerified === true,
      personalEmail: optional(assertion.personalEmail),
      employeeNumber: optional(assertion.employeeNumber),
      mobile: optional(assertion.mobile),
      status: assertion.status,
    };
  };

  const assertionDigest = (assertion: ExternalIdentityAssertion): string => {
    const { proof: _proof, ...claims } = assertionClaims(assertion);
    return createHash("sha256").update(JSON.stringify(claims)).digest("base64url");
  };

  const legacyAssertionDigest = (assertion: ExternalIdentityAssertion): string => {
    const claims = assertionClaims(assertion);
    const legacyClaims = {
      sourceId: claims.sourceId,
      provider: claims.provider,
      externalTenantId: claims.externalTenantId,
      externalSubjectId: claims.externalSubjectId,
      displayName: claims.displayName,
      corporateEmail: claims.corporateEmail,
      personalEmail: claims.personalEmail,
      employeeNumber: claims.employeeNumber,
      mobile: claims.mobile,
      status: claims.status,
      corporateEmailVerified: claims.corporateEmailVerified,
    };
    return createHash("sha256").update(JSON.stringify(legacyClaims)).digest("base64url");
  };

  const signAssertion = (assertion: ExternalIdentityAssertion): ExternalIdentityAssertion => {
    const claims = assertionClaims(assertion);
    const issuedAt = Math.floor(now() / 1000);
    const payload = Buffer.from(
      JSON.stringify({
        aud: `qm-core:${orgId}`,
        digest: assertionDigest(claims),
        exp: issuedAt + 120,
        iat: issuedAt,
        jti: randomBytes(18).toString("base64url"),
        v: 2,
      }),
    ).toString("base64url");
    const signature = createHmac("sha256", assertionKey.current).update(payload).digest("base64url");
    return { ...claims, proof: `${payload}.${signature}` };
  };

  const verifyAssertion = (assertion: ExternalIdentityAssertion): { jti: string; expiresAtMs: number } | null => {
    const [payload, signature, extra] = assertion.proof?.split(".") ?? [];
    if (!payload || !signature || extra) return null;
    const expected = createHmac("sha256", assertionKey.current).update(payload).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, "base64url");
    } catch {
      return null;
    }
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    let claims: unknown;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    } catch {
      return null;
    }
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
    const record = claims as Record<string, unknown>;
    const current = Math.floor(now() / 1000);
    const digestMatches =
      record.digest === assertionDigest(assertion) ||
      (record.v === undefined && record.digest === legacyAssertionDigest(assertion));
    if (
      record.aud !== `qm-core:${orgId}` ||
      typeof record.jti !== "string" ||
      !record.jti ||
      typeof record.iat !== "number" ||
      typeof record.exp !== "number" ||
      record.iat > current + 5 ||
      record.exp <= current ||
      record.exp - record.iat > 120 ||
      (record.v !== undefined && record.v !== 2) ||
      !digestMatches
    ) {
      return null;
    }
    return { jti: record.jti, expiresAtMs: record.exp * 1000 };
  };

  const storedSecretFor = (
    source: StoredDirectorySource,
    adapter: DirectoryProviderAdapter,
  ): Record<string, string> => {
    const environment = source.origin === "environment" ? environmentConfigurations.get(source.id) : undefined;
    if (environment) return environment.secretConfig;
    return source.secretEnc ? decodeProviderSecrets(adapter, decryptSecret(source.secretEnc, key)) : {};
  };

  const configurationFor = async (
    source: StoredDirectorySource,
  ): Promise<{ source: DirectorySource; config: DirectoryProviderConfiguration }> => {
    const adapter = providers.get(source.provider);
    if (!adapter) throw new Error("directory_source_unknown_provider");
    const environment = source.origin === "environment" ? environmentConfigurations.get(source.id) : undefined;
    if (
      source.origin === "environment" &&
      (!environment ||
        environment.externalTenantId !== source.externalTenantId ||
        environment.environmentConfigFingerprint !== source.environmentConfigFingerprint ||
        JSON.stringify(environment.publicConfig) !== JSON.stringify(source.publicConfig))
    ) {
      throw new Error("directory_source_environment_configuration_changed");
    }
    const secretConfig = storedSecretFor(source, adapter);
    if (requiredSecretFields(adapter).some((field) => !secretConfig[field])) {
      throw new Error("directory_source_secret_unavailable");
    }
    return {
      source: publicSource(source),
      config: { publicConfig: environment?.publicConfig ?? source.publicConfig, secretConfig },
    };
  };

  const sameEnvironmentSource = (left: StoredDirectorySource, right: StoredDirectorySource): boolean =>
    left.provider === right.provider &&
    left.name === right.name &&
    left.externalTenantId === right.externalTenantId &&
    left.status === right.status &&
    left.mode === right.mode &&
    left.loginEnabled === right.loginEnabled &&
    left.syncEnabled === right.syncEnabled &&
    left.jitProvisioningEnabled === right.jitProvisioningEnabled &&
    left.scheduleMinutes === right.scheduleMinutes &&
    left.matchPolicy === right.matchPolicy &&
    left.lastTestStatus === right.lastTestStatus &&
    left.environmentConfigFingerprint === right.environmentConfigFingerprint &&
    JSON.stringify(left.capabilities) === JSON.stringify(right.capabilities) &&
    JSON.stringify(left.publicConfig) === JSON.stringify(right.publicConfig);

  const pauseEnvironmentSource = async (source: StoredDirectorySource): Promise<void> =>
    store.withSourceLock(orgId, source.id, async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const current = await store.getSource(orgId, source.id);
        if (!current || current.origin !== "environment" || current.status === "deleted") return;
        environmentConfigurations.delete(current.id);
        if (!current.loginEnabled && !current.syncEnabled && current.status === "paused" && !current.hasSecret) return;
        const at = now();
        const next: StoredDirectorySource = {
          ...current,
          status: "paused",
          loginEnabled: false,
          syncEnabled: false,
          hasSecret: false,
          secretEnc: null,
          revision: current.revision + 1,
          updatedAt: at,
          updatedBy: "system:environment",
        };
        if (await store.putSource(next, current.revision)) return;
      }
      throw new Error("directory_source_environment_revision_conflict");
    });

  const putEnvironmentSource = async (
    configured: EnvironmentDirectorySource,
    adapter: DirectoryProviderAdapter,
    publicConfig: Record<string, string>,
    secretConfig: Record<string, string>,
    externalTenantId: string,
    tested: DirectoryConnectionResult | null,
    configuredIds: Set<string>,
  ): Promise<void> => {
    const adminSource = async (): Promise<StoredDirectorySource | undefined> =>
      (await store.listSources(orgId, true)).find(
        (source) =>
          source.origin === "admin" &&
          source.provider === configured.provider &&
          source.externalTenantId === externalTenantId,
      );
    if (await adminSource()) return;
    const id = environmentId(configured.provider, externalTenantId);
    return store.withSourceLock(orgId, id, async () => {
      const environmentConfigFingerprint = fingerprintEnvironmentConfiguration(configured, publicConfig, secretConfig);
      configuredIds.add(id);
      environmentConfigurations.set(id, {
        publicConfig,
        secretConfig,
        externalTenantId,
        environmentConfigFingerprint,
        syncRequested: configured.syncEnabled === true,
        jitRequested: configured.jitProvisioningEnabled === true,
      });
      for (let attempt = 0; attempt < 5; attempt++) {
        if (await adminSource()) {
          environmentConfigurations.delete(id);
          return;
        }
        const existing = await store.getSource(orgId, id);
        if (existing?.origin === "admin" || existing?.status === "deleted") {
          environmentConfigurations.delete(id);
          return;
        }
        const at = now();
        const revision = (existing?.revision ?? 0) + 1;
        const capabilities = tested?.capabilities ?? {
          login: false,
          fullSync: false,
          targetedLookup: false,
          employeeNumber: false,
          mobile: false,
          departments: false,
          corporateEmailSubjectLookup: false,
          trustedCorporateEmail: false,
          organizationUnits: false,
          memberOrganizationUnits: false,
          incrementalSync: false,
          deprovisioning: false,
        };
        const loginEnabled = tested !== null && configured.loginEnabled === true && capabilities.login;
        const previewConfirmed =
          tested !== null &&
          existing?.environmentConfigFingerprint === environmentConfigFingerprint &&
          JSON.stringify(existing.capabilities) === JSON.stringify(capabilities) &&
          existing.previewConfirmedRevision === existing.revision;
        const record: StoredDirectorySource = {
          id,
          orgId,
          provider: configured.provider,
          name: configured.name,
          externalTenantId,
          status: tested ? "active" : "paused",
          origin: "environment",
          mode: sourceMode(configured.mode),
          loginEnabled,
          syncEnabled: previewConfirmed && configured.syncEnabled === true && capabilities.fullSync,
          jitProvisioningEnabled:
            configured.jitProvisioningEnabled === true &&
            Boolean(existing?.memberSnapshotRevision) &&
            supportsAutomaticEmailLinking(capabilities, configured.matchPolicy ?? "verified_corporate_email"),
          scheduleMinutes: configured.scheduleMinutes!,
          matchPolicy: configured.matchPolicy ?? "verified_corporate_email",
          capabilities,
          publicConfig,
          hasSecret: adapter.secretFields.some((field) => Boolean(secretConfig[field])),
          secretEnc: null,
          environmentConfigFingerprint,
          revision,
          previewConfirmedRevision: previewConfirmed ? revision : null,
          memberSnapshotRevision: existing?.memberSnapshotRevision ?? null,
          reconciliationStatus: "not_started",
          reconciledSourceRevision: null,
          reconciledMemberSnapshotRevision: null,
          reconciledAt: null,
          reconciliationExpiresAt: null,
          lastTestAt: at,
          lastTestStatus: tested ? "succeeded" : "failed",
          createdAt: existing?.createdAt ?? at,
          updatedAt: at,
          createdBy: existing?.createdBy ?? "system:environment",
          updatedBy: "system:environment",
        };
        if (existing && sameEnvironmentSource(existing, record)) return;
        try {
          if (await store.putSource(record, existing?.revision ?? null)) return;
        } catch (error) {
          if (await adminSource()) {
            environmentConfigurations.delete(id);
            return;
          }
          throw error;
        }
      }
      throw new Error("directory_source_environment_revision_conflict");
    });
  };

  const ready = (async () => {
    const configuredIds = new Set<string>();
    for (const input of options.environmentSources ?? []) {
      let configured: EnvironmentDirectorySource;
      try {
        const matchPolicy = input.matchPolicy ?? "verified_corporate_email";
        if (!isDirectoryMatchPolicy(matchPolicy)) throw new Error("directory_source_invalid_match_policy");
        configured = {
          ...input,
          name: cleanName(input.name),
          scheduleMinutes: scheduleMinutes(input.scheduleMinutes),
          matchPolicy,
        };
      } catch (error) {
        swallow(`directory source environment ${input.provider} ignored`, error);
        continue;
      }
      const adapter = providers.get(configured.provider);
      if (!adapter) {
        swallow("directory source environment ignored", new Error(`unknown provider: ${configured.provider}`));
        continue;
      }
      let publicConfig: Record<string, string>;
      try {
        publicConfig = cleanPublicConfig(configured.publicConfig, adapter.publicFields);
      } catch (error) {
        swallow(`directory source environment ${configured.provider} ignored`, error);
        continue;
      }
      const tenantHint = adapter.configuredTenantId?.(publicConfig);
      if (tenantHint) {
        const admin = (await store.listSources(orgId, true)).find(
          (source) =>
            source.origin === "admin" &&
            source.provider === configured.provider &&
            source.externalTenantId === tenantHint,
        );
        if (admin) {
          const environment = (await store.listSources(orgId, true)).find(
            (source) =>
              source.origin === "environment" &&
              source.status !== "deleted" &&
              source.provider === configured.provider &&
              source.externalTenantId === tenantHint,
          );
          if (environment) await pauseEnvironmentSource(environment);
          continue;
        }
      }
      let secretConfig: Record<string, string>;
      let tested: DirectoryConnectionResult;
      try {
        secretConfig = cleanProviderSecrets(adapter, configured.secretConfig);
        tested = await adapter.testConnection({ publicConfig, secretConfig });
      } catch (error) {
        swallow(`directory source environment ${configured.provider} connection failed`, error);
        if (!tenantHint) continue;
        try {
          secretConfig = cleanProviderSecrets(adapter, configured.secretConfig, true);
        } catch {
          secretConfig = {};
        }
        await putEnvironmentSource(configured, adapter, publicConfig, secretConfig, tenantHint, null, configuredIds);
        continue;
      }
      await putEnvironmentSource(
        configured,
        adapter,
        publicConfig,
        secretConfig,
        tested.externalTenantId,
        tested,
        configuredIds,
      );
    }
    for (const source of await store.listSources(orgId, true)) {
      if (source.origin === "environment" && source.status !== "deleted" && !configuredIds.has(source.id)) {
        environmentConfigurations.delete(source.id);
        await pauseEnvironmentSource(source);
      }
    }
  })();

  const service: DirectorySourceService = {
    durable: store.durable,
    ready,
    catalog: () => providers.catalog(),
    async list(includeDeleted = false) {
      await ready;
      return (await store.listSources(orgId, includeDeleted)).map(publicSource);
    },
    async get(sourceId, includeDeleted = false) {
      await ready;
      const source = await store.getSource(orgId, sourceId);
      return source && (includeDeleted || source.status !== "deleted") ? publicSource(source) : null;
    },
    async create(input, actor) {
      await ready;
      const adapter = providers.get(input.provider);
      if (!adapter) throw new Error("directory_source_unknown_provider");
      const publicConfig = cleanPublicConfig(input.publicConfig, adapter.publicFields);
      const secretConfig = cleanProviderSecrets(adapter, input.secretConfig);
      const tenantHint = adapter.configuredTenantId?.(publicConfig);
      if (tenantHint) {
        const existingAdmin = (await store.listSources(orgId, true)).find(
          (source) =>
            source.origin === "admin" && source.provider === input.provider && source.externalTenantId === tenantHint,
        );
        if (existingAdmin) {
          throw new Error(
            existingAdmin.status === "deleted"
              ? "directory_source_deleted_tenant_restore_required"
              : "directory_source_duplicate_tenant",
          );
        }
      }
      const tested = await adapter.testConnection({ publicConfig, secretConfig });
      const duplicate = (await store.listSources(orgId, true)).find(
        (source) => source.provider === input.provider && source.externalTenantId === tested.externalTenantId,
      );
      const at = now();
      const loginEnabled = input.loginEnabled === true;
      const syncEnabled = input.syncEnabled === true;
      const mode = sourceMode(input.mode);
      if (loginEnabled && !tested.capabilities.login) throw new Error("directory_source_login_unsupported");
      if (syncEnabled && !tested.capabilities.fullSync) throw new Error("directory_source_sync_unsupported");
      if (mode === "managed_directory" && !supportsManagedDirectory(tested.capabilities)) {
        throw new Error("directory_source_managed_directory_unsupported");
      }
      if (mode === "managed_directory") {
        const managed = (await store.listSources(orgId, false)).find(
          (candidate) =>
            candidate.mode === "managed_directory" && candidate.status === "active" && candidate.id !== duplicate?.id,
        );
        if (managed) throw new Error("directory_source_managed_directory_conflict");
      }
      if (syncEnabled) throw new Error("directory_source_preview_required");
      if (duplicate?.origin === "admin") {
        throw new Error(
          duplicate.status === "deleted"
            ? "directory_source_deleted_tenant_restore_required"
            : "directory_source_duplicate_tenant",
        );
      }
      const source: StoredDirectorySource = {
        id: duplicate?.origin === "environment" ? duplicate.id : randomUUID(),
        orgId,
        provider: input.provider,
        name: cleanName(input.name),
        externalTenantId: tested.externalTenantId,
        status: "active",
        origin: "admin",
        mode,
        loginEnabled,
        syncEnabled,
        jitProvisioningEnabled: false,
        scheduleMinutes: scheduleMinutes(input.scheduleMinutes),
        matchPolicy: input.matchPolicy ?? "verified_corporate_email",
        capabilities: tested.capabilities,
        publicConfig,
        hasSecret: adapter.secretFields.length > 0,
        secretEnc: adapter.secretFields.length ? encryptSecret(encodeSecretConfig(secretConfig), key) : null,
        environmentConfigFingerprint: null,
        revision: (duplicate?.revision ?? 0) + 1,
        previewConfirmedRevision: null,
        memberSnapshotRevision: duplicate?.memberSnapshotRevision ?? null,
        reconciliationStatus: "not_started",
        reconciledSourceRevision: null,
        reconciledMemberSnapshotRevision: null,
        reconciledAt: null,
        reconciliationExpiresAt: null,
        lastTestAt: at,
        lastTestStatus: "succeeded",
        createdAt: duplicate?.createdAt ?? at,
        updatedAt: at,
        createdBy: duplicate?.createdBy ?? actor,
        updatedBy: actor,
      };
      const event = audit(actor, "directory_source.create", source.id, {
        provider: source.provider,
        tenant: source.externalTenantId,
      });
      if (!(await store.putSource(source, duplicate?.revision ?? null, event))) {
        throw new Error("directory_source_create_conflict");
      }
      environmentConfigurations.delete(source.id);
      recordMemoryAudit(event);
      return publicSource(source);
    },
    async update(sourceId, patch, actor) {
      await ready;
      return store.withSourceLock(orgId, sourceId, async () => {
        const source = await store.getSource(orgId, sourceId);
        if (!source || source.status === "deleted") throw new Error("directory_source_not_found");
        if (source.origin === "environment") throw new Error("directory_source_environment_read_only");
        if (!Number.isInteger(patch.expectedRevision) || patch.expectedRevision !== source.revision) return "conflict";
        const adapter = providers.get(source.provider);
        if (!adapter) throw new Error("directory_source_unknown_provider");
        const publicConfig = patch.publicConfig
          ? cleanPublicConfig(patch.publicConfig, adapter.publicFields)
          : source.publicConfig;
        const currentSecret = storedSecretFor(source, adapter);
        const secretPatch = patch.secretConfig ? cleanProviderSecrets(adapter, patch.secretConfig, true) : {};
        const secretConfig =
          patch.publicConfig || patch.secretConfig
            ? cleanProviderSecrets(adapter, { ...currentSecret, ...secretPatch })
            : currentSecret;
        let externalTenantId = source.externalTenantId;
        let lastTestAt = source.lastTestAt;
        let lastTestStatus = source.lastTestStatus;
        let capabilities = source.capabilities;
        if (patch.publicConfig || patch.secretConfig) {
          const tested = await adapter.testConnection({ publicConfig, secretConfig });
          if (tested.externalTenantId !== source.externalTenantId) throw new Error("directory_source_tenant_immutable");
          externalTenantId = tested.externalTenantId;
          lastTestAt = now();
          lastTestStatus = "succeeded";
          capabilities = tested.capabilities;
        }
        const matchPolicy = patch.matchPolicy ?? source.matchPolicy;
        const mode = sourceMode(patch.mode ?? source.mode);
        if (!isDirectoryMatchPolicy(matchPolicy)) throw new Error("directory_source_invalid_match_policy");
        const requestedLoginEnabled = patch.loginEnabled ?? source.loginEnabled;
        const requestedSyncEnabled = patch.syncEnabled ?? source.syncEnabled;
        if (patch.loginEnabled === true && !capabilities.login) throw new Error("directory_source_login_unsupported");
        if (patch.syncEnabled === true && !capabilities.fullSync) throw new Error("directory_source_sync_unsupported");
        if (mode === "managed_directory" && !supportsManagedDirectory(capabilities)) {
          throw new Error("directory_source_managed_directory_unsupported");
        }
        if (mode === "managed_directory") {
          const managed = (await store.listSources(orgId, false)).find(
            (candidate) =>
              candidate.id !== source.id && candidate.mode === "managed_directory" && candidate.status === "active",
          );
          if (managed) throw new Error("directory_source_managed_directory_conflict");
        }
        const configurationChanged =
          JSON.stringify(publicConfig) !== JSON.stringify(source.publicConfig) ||
          adapter.secretFields.some((field) => secretConfig[field] !== currentSecret[field]) ||
          matchPolicy !== source.matchPolicy ||
          mode !== source.mode;
        const capabilitiesChanged = JSON.stringify(capabilities) !== JSON.stringify(source.capabilities);
        const previewInvalidated = configurationChanged || capabilitiesChanged;
        const status = patch.status ?? source.status;
        const reconciliationInvalidated = previewInvalidated || status !== source.status;
        const jitSupported = supportsAutomaticEmailLinking(capabilities, matchPolicy);
        if (patch.syncEnabled === true && (previewInvalidated || source.previewConfirmedRevision !== source.revision)) {
          throw new Error("directory_source_preview_required");
        }
        if (patch.jitProvisioningEnabled === true && !jitSupported) {
          throw new Error("directory_source_jit_unsupported");
        }
        if (patch.jitProvisioningEnabled === true && (reconciliationInvalidated || !source.memberSnapshotRevision)) {
          throw new Error("directory_source_jit_snapshot_required");
        }
        const loginEnabled = requestedLoginEnabled && capabilities.login;
        const syncEnabled =
          requestedSyncEnabled &&
          capabilities.fullSync &&
          !previewInvalidated &&
          source.previewConfirmedRevision === source.revision;
        const at = now();
        const revision = source.revision + 1;
        const next: StoredDirectorySource = {
          ...source,
          name: patch.name === undefined ? source.name : cleanName(patch.name),
          externalTenantId,
          publicConfig,
          capabilities,
          mode,
          secretEnc: Object.keys(secretPatch).length
            ? encryptSecret(encodeSecretConfig(secretConfig), key)
            : source.secretEnc,
          loginEnabled,
          syncEnabled,
          jitProvisioningEnabled:
            patch.jitProvisioningEnabled === undefined
              ? source.jitProvisioningEnabled && !reconciliationInvalidated && jitSupported
              : patch.jitProvisioningEnabled && !reconciliationInvalidated && jitSupported,
          scheduleMinutes:
            patch.scheduleMinutes === undefined ? source.scheduleMinutes : scheduleMinutes(patch.scheduleMinutes),
          matchPolicy,
          status,
          revision,
          previewConfirmedRevision: nextPreviewConfirmation(
            source,
            revision,
            configurationChanged || capabilitiesChanged,
          ),
          reconciliationStatus: reconciliationInvalidated ? "stale" : source.reconciliationStatus,
          reconciledSourceRevision: nextReconciledSourceRevision(source, revision, reconciliationInvalidated),
          reconciledMemberSnapshotRevision: reconciliationInvalidated ? null : source.reconciledMemberSnapshotRevision,
          reconciledAt: reconciliationInvalidated ? null : source.reconciledAt,
          reconciliationExpiresAt: reconciliationInvalidated ? null : source.reconciliationExpiresAt,
          lastTestAt,
          lastTestStatus,
          updatedAt: at,
          updatedBy: actor,
        };
        const event = audit(actor, "directory_source.update", source.id, {
          provider: source.provider,
          loginEnabled: next.loginEnabled,
          syncEnabled: next.syncEnabled,
          status: next.status,
        });
        if (!(await store.putSource(next, source.revision, event))) return "conflict";
        recordMemoryAudit(event);
        return publicSource(next);
      });
    },
    async pause(sourceId, expectedRevision, actor) {
      await ready;
      return store.withSourceLock(orgId, sourceId, async () => {
        const source = await store.getSource(orgId, sourceId);
        if (!source || source.status === "deleted") return null;
        if (source.revision !== expectedRevision) return "conflict";
        const at = now();
        const revision = source.revision + 1;
        const next: StoredDirectorySource = {
          ...source,
          status: "paused",
          loginEnabled: false,
          syncEnabled: false,
          jitProvisioningEnabled: false,
          revision,
          previewConfirmedRevision:
            source.previewConfirmedRevision === source.revision ? revision : source.previewConfirmedRevision,
          reconciliationStatus: "stale",
          reconciledSourceRevision: null,
          reconciledMemberSnapshotRevision: null,
          reconciledAt: null,
          reconciliationExpiresAt: null,
          updatedAt: at,
          updatedBy: actor,
        };
        const event = audit(actor, "directory_source.pause", source.id, { provider: source.provider });
        if (!(await store.putSource(next, source.revision, event))) return "conflict";
        recordMemoryAudit(event);
        return publicSource(next);
      });
    },
    async delete(sourceId, expectedRevision, actor) {
      await ready;
      return store.withSourceLock(orgId, sourceId, async () => {
        const source = await store.getSource(orgId, sourceId);
        if (!source) return null;
        if (source.origin === "environment") throw new Error("directory_source_environment_delete_forbidden");
        if (source.revision !== expectedRevision) return "conflict";
        const at = now();
        const next: StoredDirectorySource = {
          ...source,
          status: "deleted",
          loginEnabled: false,
          syncEnabled: false,
          jitProvisioningEnabled: false,
          secretEnc: null,
          hasSecret: false,
          revision: source.revision + 1,
          previewConfirmedRevision: null,
          reconciliationStatus: "stale",
          reconciledSourceRevision: null,
          reconciledMemberSnapshotRevision: null,
          reconciledAt: null,
          reconciliationExpiresAt: null,
          updatedAt: at,
          updatedBy: actor,
        };
        const event = audit(actor, "directory_source.delete", source.id, { provider: source.provider });
        if (!(await store.putSource(next, source.revision, event))) return "conflict";
        environmentConfigurations.delete(source.id);
        recordMemoryAudit(event);
        return publicSource(next);
      });
    },
    async restore(sourceId, expectedRevision, secretInput, actor) {
      await ready;
      const source = await store.getSource(orgId, sourceId);
      if (!source || source.status !== "deleted" || source.origin !== "admin") return null;
      if (source.revision !== expectedRevision) return "conflict";
      const adapter = providers.get(source.provider);
      if (!adapter) throw new Error("directory_source_unknown_provider");
      const secretConfig = cleanProviderSecrets(adapter, secretInput);
      const tested = await adapter.testConnection({ publicConfig: source.publicConfig, secretConfig });
      if (tested.externalTenantId !== source.externalTenantId) throw new Error("directory_source_tenant_mismatch");
      const at = now();
      const next: StoredDirectorySource = {
        ...source,
        status: "paused",
        loginEnabled: false,
        syncEnabled: false,
        jitProvisioningEnabled: false,
        capabilities: tested.capabilities,
        hasSecret: adapter.secretFields.length > 0,
        secretEnc: adapter.secretFields.length ? encryptSecret(encodeSecretConfig(secretConfig), key) : null,
        revision: source.revision + 1,
        previewConfirmedRevision: null,
        reconciliationStatus: "stale",
        reconciledSourceRevision: null,
        reconciledMemberSnapshotRevision: null,
        reconciledAt: null,
        reconciliationExpiresAt: null,
        lastTestAt: at,
        lastTestStatus: "succeeded",
        updatedAt: at,
        updatedBy: actor,
      };
      const event = audit(actor, "directory_source.restore", source.id, { provider: source.provider });
      if (!(await store.putSource(next, source.revision, event))) return "conflict";
      recordMemoryAudit(event);
      return publicSource(next);
    },
    async confirmPreview(sourceId, sourceRevision) {
      await ready;
      const source = await store.getSource(orgId, sourceId);
      if (!source || source.status !== "active") return null;
      if (source.revision !== sourceRevision) return "conflict";
      const at = now();
      const environment = source.origin === "environment" ? environmentConfigurations.get(source.id) : undefined;
      if (
        source.origin === "environment" &&
        (!environment || environment.environmentConfigFingerprint !== source.environmentConfigFingerprint)
      ) {
        return "conflict";
      }
      const next: StoredDirectorySource = {
        ...source,
        syncEnabled:
          source.syncEnabled ||
          Boolean(environment?.syncRequested && source.capabilities.fullSync && source.lastTestStatus === "succeeded"),
        revision: source.revision + 1,
        previewConfirmedRevision: source.revision + 1,
        reconciledSourceRevision: nextReconciledSourceRevision(source, source.revision + 1, false),
        updatedAt: at,
        updatedBy: "system:sync-preview",
      };
      const event = audit("system:sync-preview", "directory_source.preview_confirm", source.id, {
        provider: source.provider,
      });
      if (!(await store.putSource(next, source.revision, event))) return "conflict";
      recordMemoryAudit(event);
      return publicSource(next);
    },
    async setReconciliation(sourceId, sourceRevision, status, expiresAt) {
      await ready;
      const source = await store.getSource(orgId, sourceId);
      if (!source || source.status !== "active") return null;
      if (source.revision !== sourceRevision) return "conflict";
      const at = now();
      const reconciled = status === "ready";
      const environment = source.origin === "environment" ? environmentConfigurations.get(source.id) : undefined;
      const next: StoredDirectorySource = {
        ...source,
        jitProvisioningEnabled:
          status !== "stale" &&
          source.memberSnapshotRevision !== null &&
          supportsAutomaticEmailLinking(source.capabilities, source.matchPolicy) &&
          (source.origin === "environment" ? environment?.jitRequested === true : source.jitProvisioningEnabled),
        reconciliationStatus: status,
        reconciledSourceRevision: reconciled ? source.revision : null,
        reconciledMemberSnapshotRevision: reconciled ? source.memberSnapshotRevision : null,
        reconciledAt: reconciled ? at : null,
        reconciliationExpiresAt: reconciled ? (expiresAt ?? at + 24 * 60 * 60_000) : null,
        updatedAt: at,
        updatedBy: "system:directory-reconciliation",
      };
      const event = audit("system:directory-reconciliation", "directory_source.reconciliation", source.id, {
        provider: source.provider,
        status,
      });
      if (!(await store.putSource(next, source.revision, event))) return "conflict";
      recordMemoryAudit(event);
      return publicSource(next);
    },
    async test(sourceId) {
      await ready;
      const source = await store.getSource(orgId, sourceId);
      if (!source || source.status === "deleted") return null;
      const adapter = providers.get(source.provider);
      if (!adapter) throw new Error("directory_source_unknown_provider");
      const configured = await configurationFor(source);
      try {
        const tested = await adapter.testConnection(configured.config);
        if (tested.externalTenantId !== source.externalTenantId) throw new Error("directory_source_tenant_mismatch");
        const at = now();
        const capabilitiesChanged = JSON.stringify(tested.capabilities) !== JSON.stringify(source.capabilities);
        const mode =
          source.mode === "managed_directory" && !supportsManagedDirectory(tested.capabilities)
            ? "identity_only"
            : source.mode;
        const invalidated = capabilitiesChanged || mode !== source.mode;
        const revision = source.revision + 1;
        const next: StoredDirectorySource = {
          ...source,
          capabilities: tested.capabilities,
          mode,
          loginEnabled: source.loginEnabled && tested.capabilities.login,
          syncEnabled:
            source.syncEnabled &&
            tested.capabilities.fullSync &&
            !invalidated &&
            source.previewConfirmedRevision === source.revision,
          jitProvisioningEnabled:
            source.jitProvisioningEnabled &&
            !invalidated &&
            supportsAutomaticEmailLinking(tested.capabilities, source.matchPolicy),
          lastTestAt: at,
          lastTestStatus: "succeeded",
          revision,
          previewConfirmedRevision: nextPreviewConfirmation(source, revision, invalidated),
          reconciliationStatus: invalidated ? "stale" : source.reconciliationStatus,
          reconciledSourceRevision: nextReconciledSourceRevision(source, revision, invalidated),
          reconciledMemberSnapshotRevision: invalidated ? null : source.reconciledMemberSnapshotRevision,
          reconciledAt: invalidated ? null : source.reconciledAt,
          reconciliationExpiresAt: invalidated ? null : source.reconciliationExpiresAt,
          updatedAt: at,
          updatedBy: "system:connection-test",
        };
        if (!(await store.putSource(next, source.revision))) throw new Error("directory_source_revision_conflict");
        return publicSource(next);
      } catch (error) {
        const at = now();
        const failed = { ...source, lastTestAt: at, lastTestStatus: "failed" as const, updatedAt: at };
        await store.putSource(failed, source.revision).catch(() => false);
        throw new Error(errMessage(error) || "directory_source_connection_failed", { cause: error });
      }
    },
    async configuration(sourceId) {
      await ready;
      const source = await store.getSource(orgId, sourceId);
      return source && source.status !== "deleted" ? configurationFor(source) : null;
    },
    async loginOptions(state) {
      await ready;
      if (!state || state.length > 8_192) throw new Error("directory_source_invalid_login_state");
      const result: DirectoryLoginOption[] = [];
      for (const source of await store.listSources(orgId, false)) {
        if (source.status !== "active" || !source.loginEnabled || !source.capabilities.login) continue;
        const adapter = providers.get(source.provider);
        if (!adapter) continue;
        result.push({
          sourceId: source.id,
          provider: source.provider,
          displayName: source.name,
          authorizeUrl: adapter.authorizeUrl(source.publicConfig, { sourceId: source.id, state }),
        });
      }
      return result;
    },
    async resolveLoginCode(sourceId, code) {
      await ready;
      if (!code || code.length > 2_048) throw new Error("directory_source_invalid_login_code");
      const source = await store.getSource(orgId, sourceId);
      if (!source || source.status !== "active" || !source.loginEnabled)
        throw new Error("directory_source_login_disabled");
      const configured = await configurationFor(source);
      const adapter = providers.get(source.provider);
      if (!adapter) throw new Error("directory_source_unknown_provider");
      const assertion = await adapter.resolveLoginCode(configured.config, { sourceId, code });
      if (assertion.externalTenantId !== source.externalTenantId || assertion.sourceId !== source.id) {
        throw new Error("directory_source_tenant_mismatch");
      }
      return signAssertion({
        ...assertion,
        corporateEmailVerified: assertion.corporateEmail !== null && source.capabilities.trustedCorporateEmail === true,
      });
    },
    async profileAuthorizationSupported(sourceId) {
      await ready;
      const source = await store.getSource(orgId, sourceId);
      if (!source || source.status !== "active" || !source.loginEnabled) return false;
      const adapter = providers.get(source.provider);
      return Boolean(adapter?.profileAuthorizeUrl && adapter.resolveProfileAuthorizationCode);
    },
    async profileAuthorizationUrl(sourceId, state, notify) {
      await ready;
      if (!state || state.length > 8_192) throw new Error("directory_source_invalid_login_state");
      const source = await store.getSource(orgId, sourceId);
      if (!source || source.status !== "active" || !source.loginEnabled)
        throw new Error("directory_source_login_disabled");
      const adapter = providers.get(source.provider);
      if (!adapter?.profileAuthorizeUrl || !adapter.resolveProfileAuthorizationCode) {
        throw new Error("directory_source_profile_authorization_unsupported");
      }
      const authorizeUrl = adapter.profileAuthorizeUrl(source.publicConfig, { sourceId, state });
      if (!notify?.externalSubjectId || !adapter.sendProfileAuthorizationPrompt) {
        return { authorizeUrl, promptDelivered: false };
      }
      const configured = await configurationFor(source);
      const promptDelivered = await adapter
        .sendProfileAuthorizationPrompt(configured.config, { ...notify, authorizeUrl })
        .catch(() => false);
      return { authorizeUrl, promptDelivered };
    },
    async resolveProfileAuthorizationCode(sourceId, code, expected) {
      await ready;
      if (!code || code.length > 2_048) throw new Error("directory_source_invalid_login_code");
      const source = await store.getSource(orgId, sourceId);
      if (!source || source.status !== "active" || !source.loginEnabled)
        throw new Error("directory_source_login_disabled");
      if (
        expected.provider !== source.provider ||
        expected.externalTenantId !== source.externalTenantId ||
        !expected.externalSubjectId
      ) {
        throw new Error("directory_source_profile_identity_mismatch");
      }
      const configured = await configurationFor(source);
      const adapter = providers.get(source.provider);
      if (!adapter?.profileAuthorizeUrl || !adapter.resolveProfileAuthorizationCode) {
        throw new Error("directory_source_profile_authorization_unsupported");
      }
      const assertion = await adapter.resolveProfileAuthorizationCode(configured.config, {
        sourceId,
        code,
        expectedExternalSubjectId: expected.externalSubjectId,
      });
      if (
        assertion.sourceId !== source.id ||
        assertion.provider !== source.provider ||
        assertion.externalTenantId !== source.externalTenantId ||
        assertion.externalSubjectId !== expected.externalSubjectId
      ) {
        throw new Error("directory_source_profile_identity_mismatch");
      }
      if (!assertion.corporateEmail || source.capabilities.trustedCorporateEmail !== true) {
        throw new Error("directory_source_profile_corporate_email_missing");
      }
      return signAssertion({
        ...assertion,
        corporateEmailVerified: true,
      });
    },
    verifyLoginAssertion: verifyAssertion,
  };
  return service;
}

export function directoryEnvironmentSourcesFromEnv(
  env: NodeJS.ProcessEnv,
  redirectUri: string,
): EnvironmentDirectorySource[] {
  const corpId = env.AUTH_WECOM_CORP_ID?.trim() ?? "";
  const agentId = env.AUTH_WECOM_AGENT_ID?.trim() ?? "";
  const applicationSecret = env.AUTH_WECOM_SECRET?.trim() ?? "";
  const directorySyncSecret = env.AUTH_WECOM_DIRECTORY_SYNC_SECRET?.trim() ?? "";
  const set = [corpId, agentId, applicationSecret].filter(Boolean).length;
  if (set === 0) {
    if (directorySyncSecret) {
      swallow(
        "directory source environment ignored",
        new Error("AUTH_WECOM_DIRECTORY_SYNC_SECRET requires the complete WeCom application configuration"),
      );
    }
    return [];
  }
  if (set !== 3) {
    swallow(
      "directory source environment ignored",
      new Error("AUTH_WECOM_CORP_ID, AUTH_WECOM_AGENT_ID, and AUTH_WECOM_SECRET must be set together"),
    );
    return [];
  }
  if (env.NODE_ENV === "production" && isProductionPlaceholder(applicationSecret)) {
    swallow("directory source environment ignored", new Error("AUTH_WECOM_SECRET must be replaced"));
    return [];
  }
  return [
    {
      provider: "wecom",
      name: env.AUTH_WECOM_NAME?.trim() || "WeCom",
      publicConfig: {
        corpId,
        agentId,
        redirectUri: env.AUTH_WECOM_REDIRECT_URI?.trim() || redirectUri,
      },
      secretConfig: {
        applicationSecret,
        ...(directorySyncSecret ? { directorySyncSecret } : {}),
      },
      loginEnabled: env.AUTH_WECOM_LOGIN_ENABLED !== "0",
      syncEnabled: Boolean(directorySyncSecret) && env.AUTH_WECOM_SYNC_ENABLED === "1",
      jitProvisioningEnabled: env.AUTH_WECOM_JIT_PROVISIONING_ENABLED === "1",
      scheduleMinutes: Number(env.AUTH_WECOM_SYNC_MINUTES ?? 360),
      matchPolicy: env.AUTH_WECOM_MATCH_POLICY === "manual_only" ? "manual_only" : "verified_corporate_email",
    },
  ];
}
