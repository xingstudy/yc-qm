export type OrganizationMemberJobKind = "import" | "batch";
export type OrganizationMemberJobStatus = "previewed" | "running" | "completed" | "failed" | "expired";
export type OrganizationMemberJobItemStatus = "ready" | "unchanged" | "error" | "completed";

export interface OrganizationMemberJob {
  id: string;
  orgId: string;
  kind: OrganizationMemberJobKind;
  status: OrganizationMemberJobStatus;
  actorId: string;
  idempotencyKey: string;
  inputHash: string;
  expectedAuthzRevision: number;
  summary: Record<string, unknown>;
  createdAt: number;
  startedAt: number | null;
  claimToken: string | null;
  leaseExpiresAt: number | null;
  completedAt: number | null;
  expiresAt: number;
  error: string | null;
}

export interface OrganizationMemberJobItem {
  orgId: string;
  jobId: string;
  itemIndex: number;
  principalId: string | null;
  expectedProfileRevision: number | null;
  normalizedInput: Record<string, unknown>;
  changes: Record<string, unknown>;
  status: OrganizationMemberJobItemStatus;
  errors: string[];
  warnings: string[];
}

export interface OrganizationMemberJobDetail {
  job: OrganizationMemberJob;
  items: OrganizationMemberJobItem[];
}

export interface OrganizationMemberJobPage {
  detail: OrganizationMemberJobDetail;
  itemTotal: number;
}

export interface OrganizationMemberJobStore {
  create(
    job: OrganizationMemberJob,
    items: readonly OrganizationMemberJobItem[],
  ): Promise<{ detail: OrganizationMemberJobDetail; created: boolean }>;
  get(orgId: string, jobId: string, actorId: string): Promise<OrganizationMemberJobDetail | null>;
  page(
    orgId: string,
    jobId: string,
    actorId: string,
    offset: number,
    limit: number,
  ): Promise<OrganizationMemberJobPage | null>;
  claim(
    orgId: string,
    jobId: string,
    actorId: string,
    claimToken: string,
    now: number,
    leaseExpiresAt: number,
  ): Promise<{ detail: OrganizationMemberJobDetail; acquired: boolean } | null>;
  complete(
    orgId: string,
    jobId: string,
    actorId: string,
    claimToken: string,
    summary: Record<string, unknown>,
    now: number,
  ): Promise<OrganizationMemberJobDetail | null>;
  fail(orgId: string, jobId: string, actorId: string, claimToken: string, error: string, now: number): Promise<void>;
  expire(now: number): Promise<number>;
  close?(): Promise<void> | void;
}

function cloneDetail(detail: OrganizationMemberJobDetail): OrganizationMemberJobDetail {
  return {
    job: { ...detail.job, summary: structuredClone(detail.job.summary) },
    items: detail.items.map((item) => ({
      ...item,
      normalizedInput: structuredClone(item.normalizedInput),
      changes: structuredClone(item.changes),
      errors: [...item.errors],
      warnings: [...item.warnings],
    })),
  };
}

export function createMemoryOrganizationMemberJobStore(): OrganizationMemberJobStore {
  const jobs = new Map<string, OrganizationMemberJobDetail>();
  const idempotency = new Map<string, string>();
  const key = (orgId: string, jobId: string): string => `${orgId}\n${jobId}`;
  const idempotencyKey = (job: OrganizationMemberJob): string => `${job.orgId}\n${job.actorId}\n${job.idempotencyKey}`;
  return {
    async create(job, items) {
      const existingId = idempotency.get(idempotencyKey(job));
      if (existingId) {
        const existing = jobs.get(key(job.orgId, existingId))!;
        if (existing.job.kind !== job.kind || existing.job.inputHash !== job.inputHash) {
          throw new OrganizationMemberJobConflictError();
        }
        return { detail: cloneDetail(existing), created: false };
      }
      const detail = cloneDetail({ job, items: [...items] });
      jobs.set(key(job.orgId, job.id), detail);
      idempotency.set(idempotencyKey(job), job.id);
      return { detail: cloneDetail(detail), created: true };
    },
    async get(orgId, jobId, actorId) {
      const detail = jobs.get(key(orgId, jobId));
      return detail?.job.actorId === actorId ? cloneDetail(detail) : null;
    },
    async page(orgId, jobId, actorId, offset, limit) {
      const detail = jobs.get(key(orgId, jobId));
      if (!detail || detail.job.actorId !== actorId) return null;
      return {
        detail: cloneDetail({ job: detail.job, items: detail.items.slice(offset, offset + limit) }),
        itemTotal: detail.items.length,
      };
    },
    async claim(orgId, jobId, actorId, claimToken, now, leaseExpiresAt) {
      const detail = jobs.get(key(orgId, jobId));
      if (!detail || detail.job.actorId !== actorId) return null;
      if (detail.job.status === "completed") return { detail: cloneDetail(detail), acquired: false };
      const claimable =
        detail.job.status === "previewed" ||
        (detail.job.status === "running" && (detail.job.leaseExpiresAt ?? 0) <= now);
      if (!claimable || detail.job.expiresAt <= now) return { detail: cloneDetail(detail), acquired: false };
      detail.job = { ...detail.job, status: "running", startedAt: now, claimToken, leaseExpiresAt };
      return { detail: cloneDetail(detail), acquired: true };
    },
    async complete(orgId, jobId, actorId, claimToken, summary, now) {
      const detail = jobs.get(key(orgId, jobId));
      if (
        !detail ||
        detail.job.actorId !== actorId ||
        detail.job.status !== "running" ||
        detail.job.claimToken !== claimToken
      )
        return null;
      detail.job = {
        ...detail.job,
        status: "completed",
        claimToken: null,
        leaseExpiresAt: null,
        completedAt: now,
        summary: structuredClone(summary),
      };
      detail.items = detail.items.map((item) =>
        item.status === "error" ? item : { ...item, status: item.status === "unchanged" ? "unchanged" : "completed" },
      );
      return cloneDetail(detail);
    },
    async fail(orgId, jobId, actorId, claimToken, error, now) {
      const detail = jobs.get(key(orgId, jobId));
      if (
        !detail ||
        detail.job.actorId !== actorId ||
        detail.job.status !== "running" ||
        detail.job.claimToken !== claimToken
      )
        return;
      detail.job = {
        ...detail.job,
        status: "failed",
        claimToken: null,
        leaseExpiresAt: null,
        completedAt: now,
        error,
      };
    },
    async expire(now) {
      let expired = 0;
      for (const detail of jobs.values()) {
        if (!["previewed", "running"].includes(detail.job.status) || detail.job.expiresAt > now) continue;
        detail.job = { ...detail.job, status: "expired", claimToken: null, leaseExpiresAt: null };
        detail.items = [];
        expired += 1;
      }
      return expired;
    },
  };
}

export class OrganizationMemberJobConflictError extends Error {
  constructor() {
    super("idempotency key was already used for a different member task");
    this.name = "OrganizationMemberJobConflictError";
  }
}
