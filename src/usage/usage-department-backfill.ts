import { createHash, randomUUID } from "node:crypto";
import { withPgTransaction, type Pool, type PoolClient } from "../persistence/pg-pool.ts";
import { dateAt, type UsageFact } from "./usage-store.ts";
import {
  departmentSnapshot,
  resolveUsageDepartment,
  type DepartmentSnapshot,
  type DepartmentUnit,
} from "./usage-departments.ts";

export class UsageDepartmentPreviewError extends Error {
  code: "invalid" | "too_large" | "not_found" | "expired" | "stale";
  constructor(code: UsageDepartmentPreviewError["code"]) {
    super(code);
    this.code = code;
  }
}

export interface UsageDepartmentCorrectionInput {
  start: string;
  end: string;
  principalIds?: string[];
  recordIds?: string[];
  unitId?: string;
  replace?: boolean;
  reason: string;
}

interface Change {
  id: string;
  principalId: string;
  before: DepartmentSnapshot;
  after: DepartmentSnapshot;
  basis: string;
}

export interface UsageDepartmentPreview {
  id: string;
  orgId: string;
  actorId: string;
  input: UsageDepartmentCorrectionInput;
  createdAt: number;
  expiresAt: number;
  confirmedAt: number | null;
  scanned: number;
  eligible: number;
  overwritten: number;
  pending: number;
  missingIdentity: number;
  unresolved: number;
  unchanged: number;
  changes: Change[];
}

interface StoredPreview extends Omit<UsageDepartmentPreview, "changes"> {
  directoryRevision: string;
  candidates: Array<Change & { revision: string }>;
}

function publicPreview({
  candidates,
  directoryRevision: _revision,
  ...preview
}: StoredPreview): UsageDepartmentPreview {
  return { ...preview, changes: candidates.slice(0, 100).map(({ revision: _version, ...change }) => change) };
}

async function directory(client: PoolClient, orgId: string) {
  const units = (
    await client.query(
      'SELECT id,name,parent_id AS "parentId",kind,status FROM org_units WHERE org_id=$1 ORDER BY id',
      [orgId],
    )
  ).rows as DepartmentUnit[];
  const members = (
    await client.query(
      'SELECT principal_id AS "principalId",unit_id AS "unitId",is_primary AS "isPrimary" FROM org_unit_members WHERE org_id=$1 ORDER BY principal_id,unit_id',
      [orgId],
    )
  ).rows as Array<{ principalId: string; unitId: string; isPrimary: boolean }>;
  return {
    units,
    members,
    revision: createHash("sha256")
      .update(JSON.stringify([units, members]))
      .digest("hex"),
  };
}

function validate(input: UsageDepartmentCorrectionInput, actor: string, now: number) {
  const ids = (value: unknown) =>
    value === undefined ||
    (Array.isArray(value) &&
      value.length > 0 &&
      value.length <= 10000 &&
      value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 512));
  try {
    if (
      !actor ||
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      typeof input.start !== "string" ||
      typeof input.end !== "string" ||
      dateAt(input.start) > dateAt(input.end) ||
      dateAt(input.end) > now ||
      !ids(input.principalIds) ||
      !ids(input.recordIds) ||
      (input.unitId !== undefined &&
        (typeof input.unitId !== "string" || !input.unitId || input.unitId.length > 512)) ||
      (input.replace !== undefined && typeof input.replace !== "boolean") ||
      (input.replace && !input.recordIds?.length) ||
      typeof input.reason !== "string" ||
      !input.reason.trim() ||
      input.reason.length > 2000
    )
      throw new Error("invalid");
  } catch {
    throw new UsageDepartmentPreviewError("invalid");
  }
}

export async function previewUsageDepartment(
  pool: Pool,
  orgId: string,
  actorId: string,
  input: UsageDepartmentCorrectionInput,
  now = Date.now(),
): Promise<UsageDepartmentPreview> {
  validate(input, actorId, now);
  return withPgTransaction(pool, async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const current = await directory(client, orgId);
    let target: DepartmentSnapshot | undefined;
    try {
      if (input.unitId) target = departmentSnapshot(current.units, input.unitId);
    } catch {
      throw new UsageDepartmentPreviewError("invalid");
    }
    const values: unknown[] = [orgId, input.start, input.end];
    const clauses = ["org_id=$1", "day >= $2", "day <= $3"];
    for (const [ids, field] of [
      [input.principalIds, "fact->>'principalId'"],
      [input.recordIds, "id"],
    ] as const) {
      if (!ids) continue;
      values.push(ids);
      clauses.push(`${field}=ANY($${values.length}::text[])`);
    }
    if (!input.replace) clauses.push("COALESCE(fact->>'unitId','')=''");
    const result = await client.query(
      `SELECT id,fact,md5(fact::text) AS revision FROM usage_facts WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT 10001`,
      values,
    );
    if (result.rows.length > 10000) throw new UsageDepartmentPreviewError("too_large");
    const preview: StoredPreview = {
      id: randomUUID(),
      orgId,
      actorId,
      input: structuredClone(input),
      createdAt: now,
      expiresAt: now + 15 * 60_000,
      confirmedAt: null,
      scanned: result.rows.length,
      eligible: 0,
      overwritten: 0,
      pending: 0,
      missingIdentity: 0,
      unresolved: 0,
      unchanged: 0,
      directoryRevision: current.revision,
      candidates: [],
    };
    const memberships = new Map<string, typeof current.members>();
    for (const member of current.members) {
      const list = memberships.get(member.principalId) ?? [];
      list.push(member);
      memberships.set(member.principalId, list);
    }
    for (const row of result.rows) {
      const fact = row.fact as UsageFact;
      if (fact.state === "pending") {
        preview.pending++;
        continue;
      }
      if (!fact.principalId || fact.principalId === "__historical_unknown__") {
        preview.missingIdentity++;
        continue;
      }
      const selected = target ?? resolveUsageDepartment(current.units, memberships.get(fact.principalId) ?? []);
      if (!selected.unitId || selected.unitAttribution === "ambiguous") {
        preview.unresolved++;
        continue;
      }
      const before: DepartmentSnapshot = {
        unitId: fact.unitId,
        unitName: fact.unitName,
        unitPath: fact.unitPath,
        unitAncestors: fact.unitAncestors,
        unitAttribution: fact.unitAttribution,
      };
      const after = { ...selected, unitAttribution: "correction" as const };
      if (
        fact.unitId === after.unitId &&
        fact.unitName === after.unitName &&
        JSON.stringify(fact.unitPath) === JSON.stringify(after.unitPath) &&
        JSON.stringify(fact.unitAncestors) === JSON.stringify(after.unitAncestors)
      ) {
        preview.unchanged++;
        continue;
      }
      preview.candidates.push({
        id: row.id,
        revision: row.revision,
        principalId: fact.principalId,
        before,
        after,
        basis: target ? "administrator" : selected.unitAttribution!,
      });
      preview.eligible++;
      if (fact.unitId) preview.overwritten++;
    }
    await client.query("INSERT INTO usage_department_previews(org_id,id,preview) VALUES($1,$2,$3)", [
      orgId,
      preview.id,
      JSON.stringify(preview),
    ]);
    return publicPreview(preview);
  });
}

export async function confirmUsageDepartment(
  pool: Pool,
  orgId: string,
  actorId: string,
  id: string,
  now = Date.now(),
): Promise<UsageDepartmentPreview> {
  return withPgTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('organization-authz'),hashtext($1))", [orgId]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`usage:${orgId}`]);
    const result = await client.query(
      "SELECT preview FROM usage_department_previews WHERE org_id=$1 AND id=$2 FOR UPDATE",
      [orgId, id],
    );
    const preview = result.rows[0]?.preview as StoredPreview | undefined;
    if (!preview || preview.actorId !== actorId) throw new UsageDepartmentPreviewError("not_found");
    if (preview.confirmedAt !== null) return publicPreview(preview);
    if (preview.expiresAt <= now) throw new UsageDepartmentPreviewError("expired");
    if ((await directory(client, orgId)).revision !== preview.directoryRevision)
      throw new UsageDepartmentPreviewError("stale");
    const rows = await client.query(
      "SELECT id,md5(fact::text) AS revision FROM usage_facts WHERE org_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE",
      [orgId, preview.candidates.map((candidate) => candidate.id)],
    );
    const revisions = new Map(rows.rows.map((row) => [row.id, row.revision]));
    if (preview.candidates.some((candidate) => revisions.get(candidate.id) !== candidate.revision))
      throw new UsageDepartmentPreviewError("stale");
    await client.query(
      `UPDATE usage_facts f SET fact=f.fact || c.after,dirty=TRUE,updated_at=$3
      FROM jsonb_to_recordset($2::jsonb) AS c(id text,after jsonb) WHERE f.org_id=$1 AND f.id=c.id`,
      [orgId, JSON.stringify(preview.candidates), now],
    );
    await client.query(
      `INSERT INTO usage_department_changes(org_id,preview_id,actor_id,at,reason,changes) VALUES($1,$2,$3,$4,$5,$6)`,
      [orgId, id, actorId, now, preview.input.reason, JSON.stringify(preview.candidates)],
    );
    preview.confirmedAt = now;
    await client.query("UPDATE usage_department_previews SET preview=$3 WHERE org_id=$1 AND id=$2", [
      orgId,
      id,
      JSON.stringify(preview),
    ]);
    return publicPreview(preview);
  });
}
