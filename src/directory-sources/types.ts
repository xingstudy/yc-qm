export const DIRECTORY_SOURCE_PROVIDERS = ["wecom"] as const;

export type DirectorySourceProviderId = (typeof DIRECTORY_SOURCE_PROVIDERS)[number] | (string & {});
export type DirectorySourceStatus = "active" | "paused" | "deleted";
export type DirectorySourceOrigin = "admin" | "environment";
export type DirectorySourceMode = "identity_only" | "managed_directory";
export type DirectoryMatchPolicy = "verified_corporate_email" | "manual_only";
export type DirectoryMemberStatus = "active" | "suspended" | "inactive";
export type DirectoryMatchState = "bound" | "suggested" | "unmatched" | "conflict" | "ignored" | "inactive";
export type DirectorySyncKind = "preview" | "scheduled" | "manual" | "targeted";
export type DirectorySyncStatus = "queued" | "running" | "succeeded" | "failed" | "expired";
export type DirectoryEmailKind = "corporate" | "personal";
export type DirectoryReconciliationStatus = "not_started" | "running" | "ready" | "blocked" | "stale";
export type DirectoryEmailResolutionStatus =
  "resolved" | "not_found" | "conflict" | "unauthorized" | "rate_limited" | "temporary_error";
export type DirectoryUnitStatus = "active" | "inactive";

export interface DirectoryProviderCapabilities {
  login: boolean;
  fullSync: boolean;
  targetedLookup: boolean;
  employeeNumber: boolean;
  mobile: boolean;
  departments: boolean;
  corporateEmailSubjectLookup?: boolean;
  trustedCorporateEmail?: boolean;
  organizationUnits?: boolean;
  memberOrganizationUnits?: boolean;
  incrementalSync?: boolean;
  deprovisioning?: boolean;
}

export interface DirectorySource {
  id: string;
  orgId: string;
  provider: DirectorySourceProviderId;
  name: string;
  externalTenantId: string;
  status: DirectorySourceStatus;
  origin: DirectorySourceOrigin;
  mode: DirectorySourceMode;
  loginEnabled: boolean;
  syncEnabled: boolean;
  jitProvisioningEnabled: boolean;
  scheduleMinutes: number;
  matchPolicy: DirectoryMatchPolicy;
  capabilities: DirectoryProviderCapabilities;
  publicConfig: Record<string, string>;
  hasSecret: boolean;
  secretPresence: Record<string, boolean>;
  revision: number;
  previewConfirmedRevision: number | null;
  memberSnapshotRevision: string | null;
  reconciliationStatus: DirectoryReconciliationStatus;
  reconciledSourceRevision: number | null;
  reconciledMemberSnapshotRevision: string | null;
  reconciledAt: number | null;
  reconciliationExpiresAt: number | null;
  lastTestAt: number | null;
  lastTestStatus: "succeeded" | "failed" | null;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  updatedBy: string;
}

export interface StoredDirectorySource extends Omit<DirectorySource, "secretPresence"> {
  secretEnc: string | null;
  environmentConfigFingerprint: string | null;
}

export interface DirectorySourceSecret {
  source: DirectorySource;
  secretConfig: Record<string, string>;
}

export interface DirectoryEmail {
  value: string;
  kind: DirectoryEmailKind;
  verified: boolean;
}

export interface DirectoryEmailResolution {
  orgId: string;
  sourceId: string;
  emailHash: string;
  status: DirectoryEmailResolutionStatus;
  externalSubjectId: string | null;
  sourceRevision: number;
  memberSnapshotRevision: string | null;
  checkedAt: number;
  retryAt: number;
  failureCount: number;
  errorCode: string | null;
}

export interface DirectoryEmailLookupGuard {
  orgId: string;
  sourceId: string;
  windowStartedAt: number;
  attempts: number;
  notFound: number;
  circuitOpenUntil: number | null;
  updatedAt: number;
}

export interface NormalizedDirectoryUnit {
  orgId: string;
  sourceId: string;
  provider: DirectorySourceProviderId;
  externalTenantId: string;
  externalUnitId: string;
  parentExternalUnitId: string | null;
  displayName: string | null;
  sortOrder: number;
  status: DirectoryUnitStatus;
  revision: string;
  observedAt: number;
  profileHash: string;
  missingFromFullSyncCount?: number;
}

export interface DirectoryUnitMapping {
  orgId: string;
  provider: DirectorySourceProviderId;
  externalTenantId: string;
  externalUnitId: string;
  sourceId: string;
  unitId: string;
  ownership: "source" | "manual";
  createdAt: number;
  updatedAt: number;
}

export interface DirectoryUnitMemberOwnership {
  orgId: string;
  sourceId: string;
  unitId: string;
  principalId: string;
  primary: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DirectoryManagedUserOwnership {
  orgId: string;
  sourceId: string;
  externalSubjectId: string;
  principalId: string;
  suspendedBySource: boolean;
  suspendedSessionVersion: number | null;
  createdAt: number;
  updatedAt: number;
}

export type ManagedDirectoryPlanAction = "create" | "update" | "archive" | "provision" | "suspend" | "unchanged";

export interface ManagedDirectoryUnitPlan {
  externalUnitId: string;
  unitId: string;
  parentUnitId: string;
  name: string;
  sortOrder: number;
  ownership: "source" | "manual";
  collisionUnitId: string | null;
  action: Extract<ManagedDirectoryPlanAction, "create" | "update" | "archive" | "unchanged">;
}

export interface ManagedDirectoryMemberPlan {
  externalSubjectId: string;
  principalId: string | null;
  externalUnitIds: string[];
  primaryExternalUnitId: string | null;
  action: Extract<ManagedDirectoryPlanAction, "provision" | "update" | "suspend" | "unchanged">;
  snapshotMember: NormalizedDirectoryMember;
}

export interface ManagedDirectoryRelationPlan {
  externalSubjectId: string;
  principalId: string | null;
  externalUnitId: string | null;
  unitId: string;
  primary: boolean;
  action: "add" | "update" | "remove" | "unchanged" | "preserve";
}

export interface ManagedDirectoryPreservedItem {
  kind: "profile_field" | "manual_relation" | "manual_unit";
  resourceId: string;
  detail: string;
}

export interface ManagedDirectoryAuthorizationImpact {
  externalUnitId: string;
  unitId: string;
  activeChildUnits: number;
  activeMembers: number;
  directoryRoots: number;
  accessGrants: number;
}

export interface ManagedDirectoryPreview {
  id: string;
  orgId: string;
  sourceId: string;
  generation: number;
  sourceRevision: number;
  snapshotRevision: string;
  organizationRevision: number;
  identityFingerprint: string;
  mappingFingerprint: string;
  memberFingerprint: string;
  status: "ready" | "blocked" | "committing" | "committed";
  units: ManagedDirectoryUnitPlan[];
  members: ManagedDirectoryMemberPlan[];
  relations: ManagedDirectoryRelationPlan[];
  preserved: ManagedDirectoryPreservedItem[];
  authorizationImpacts: ManagedDirectoryAuthorizationImpact[];
  conflicts: string[];
  createdAt: number;
  expiresAt: number;
  committedAt: number | null;
  actor: string;
}

export interface NormalizedDirectoryMember {
  orgId: string;
  sourceId: string;
  provider: DirectorySourceProviderId;
  externalTenantId: string;
  externalSubjectId: string;
  displayName: string;
  emails: DirectoryEmail[];
  employeeNumber: string | null;
  mobile: string | null;
  departmentIds: string[];
  primaryDepartmentId?: string | null;
  status: DirectoryMemberStatus;
  revision: string;
  observedAt: number;
  profileHash: string;
  snapshotRevision?: string | null;
  missingFromFullSyncCount?: number;
  matchState: DirectoryMatchState;
  matchReason: string;
  matchedPrincipalId: string | null;
  ignoredBy: string | null;
  ignoredReason: string | null;
  lastLoginAttemptAt: number | null;
}

export interface DirectoryMemberCursor {
  externalSubjectId: string;
}

export interface DirectoryMemberQuery {
  states?: readonly DirectoryMatchState[];
  query?: string;
  after?: DirectoryMemberCursor | null;
  limit: number;
}

export interface DirectoryMemberPage {
  members: NormalizedDirectoryMember[];
  next: DirectoryMemberCursor | null;
}

export interface DirectorySyncCounts {
  observed: number;
  added: number;
  changed: number;
  inactive: number;
  unchanged: number;
}

export interface DirectorySyncRun {
  id: string;
  orgId: string;
  sourceId: string;
  sourceRevision: number;
  kind: DirectorySyncKind;
  status: DirectorySyncStatus;
  idempotencyKey: string;
  targetExternalSubjectId: string | null;
  counts: DirectorySyncCounts;
  errorCode: string | null;
  errorMessage: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
}

export interface ExternalIdentityAssertion {
  sourceId: string;
  provider: DirectorySourceProviderId;
  externalTenantId: string;
  externalSubjectId: string;
  displayName: string;
  corporateEmail: string | null;
  corporateEmailVerified?: boolean;
  personalEmail: string | null;
  employeeNumber: string | null;
  mobile: string | null;
  status: DirectoryMemberStatus;
  proof?: string;
}

export interface DirectoryLoginOption {
  sourceId: string;
  provider: DirectorySourceProviderId;
  displayName: string;
  authorizeUrl: string;
}

export interface DirectoryMatchCandidate {
  principalId: string;
  displayName: string;
  email: string | null;
  employeeNumber: string | null;
  mobile: string | null;
  status: "invited" | "active" | "suspended" | "deprovisioned";
  matchedFields: string[];
  identityCount: number;
}

export interface DirectoryMatchResult {
  state: DirectoryMatchState;
  reason: string;
  automatic: boolean;
  principalId: string | null;
  candidates: DirectoryMatchCandidate[];
}

export const EMPTY_SYNC_COUNTS: DirectorySyncCounts = {
  observed: 0,
  added: 0,
  changed: 0,
  inactive: 0,
  unchanged: 0,
};

export function publicDirectorySource(source: StoredDirectorySource): Omit<DirectorySource, "secretPresence"> {
  const { secretEnc: _secretEnc, environmentConfigFingerprint: _environmentConfigFingerprint, ...result } = source;
  return result;
}

export function isDirectoryMatchPolicy(value: unknown): value is DirectoryMatchPolicy {
  return value === "verified_corporate_email" || value === "manual_only";
}

export function isDirectorySourceMode(value: unknown): value is DirectorySourceMode {
  return value === "identity_only" || value === "managed_directory";
}

export function isDirectorySourceStatus(value: unknown): value is DirectorySourceStatus {
  return value === "active" || value === "paused" || value === "deleted";
}

export function normalizeDirectoryEmail(value: string): string {
  return value.trim().toLowerCase();
}
