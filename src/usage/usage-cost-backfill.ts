import { randomUUID } from "node:crypto";
import { withPgTransaction, type Pool } from "../persistence/pg-pool.ts";
import { dateAt, type UsageFact } from "./usage-store.ts";
import { estimateUsage, type UsagePrice } from "./usage-pricing.ts";

export class UsageCostPreviewError extends Error {
  code: "invalid" | "too_large" | "not_found" | "expired" | "stale";
  constructor(code: UsageCostPreviewError["code"]) {
    super(code);
    this.code = code;
  }
}

export interface UsageCostPreview {
  id: string;
  orgId: string;
  actorId: string;
  model: string;
  start: string;
  end: string;
  price: UsagePrice;
  createdAt: number;
  expiresAt: number;
  confirmedAt: number | null;
  unknown: number;
  eligible: number;
  known: number;
  pending: number;
  missingIdentity: number;
  missingConditions: number;
  missingTokensOrRates: number;
  costUsd: number;
}

interface StoredPreview extends UsageCostPreview {
  candidates: Array<{ id: string; revision: string; cost: number }>;
}

function publicPreview({ candidates: _candidates, ...preview }: StoredPreview): UsageCostPreview {
  return preview;
}

export async function previewUsageCost(
  pool: Pool,
  orgId: string,
  actorId: string,
  price: UsagePrice,
  input: { model: string; start: string; end: string },
  now = Date.now(),
): Promise<UsageCostPreview> {
  if (
    price.orgId !== orgId ||
    !actorId ||
    typeof input.model !== "string" ||
    !input.model.trim() ||
    input.model.length > 512 ||
    typeof input.start !== "string" ||
    typeof input.end !== "string"
  )
    throw new UsageCostPreviewError("invalid");
  try {
    if (dateAt(input.start) > dateAt(input.end) || dateAt(input.end) > now) throw new Error("Invalid range");
  } catch {
    throw new UsageCostPreviewError("invalid");
  }
  return withPgTransaction(pool, async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const values = [orgId, input.start, input.end, input.model];
    const filter = "org_id=$1 AND day >= $2 AND day <= $3 AND fact->>'model'=$4 AND fact->>'kind'='model'";
    const known = await client.query(
      `SELECT COUNT(*) AS count FROM usage_facts WHERE ${filter} AND fact->>'costUsd' IS NOT NULL`,
      values,
    );
    const rows = await client.query(
      `SELECT id,fact,md5(fact::text) AS revision FROM usage_facts WHERE ${filter} AND fact->>'costUsd' IS NULL ORDER BY id LIMIT 10001`,
      values,
    );
    if (rows.rows.length > 10000) throw new UsageCostPreviewError("too_large");
    const preview: StoredPreview = {
      id: randomUUID(),
      orgId,
      actorId,
      model: input.model,
      start: input.start,
      end: input.end,
      price: structuredClone(price),
      createdAt: now,
      expiresAt: now + 15 * 60_000,
      confirmedAt: null,
      unknown: rows.rows.length,
      eligible: 0,
      known: Number(known.rows[0].count),
      pending: 0,
      missingIdentity: 0,
      missingConditions: 0,
      missingTokensOrRates: 0,
      costUsd: 0,
      candidates: [],
    };
    for (const row of rows.rows) {
      const fact = row.fact as UsageFact;
      if (fact.state === "pending") {
        preview.pending++;
        continue;
      }
      if (fact.provider !== price.provider || fact.pricingModel !== price.model) {
        preview.missingIdentity++;
        continue;
      }
      if (!fact.pricingMode) {
        preview.missingConditions++;
        continue;
      }
      const cost = estimateUsage(fact, price);
      if (cost === null) {
        preview.missingTokensOrRates++;
        continue;
      }
      preview.candidates.push({ id: row.id, revision: row.revision, cost });
      preview.eligible++;
      preview.costUsd += cost;
    }
    await client.query("INSERT INTO usage_cost_previews(org_id,id,preview) VALUES($1,$2,$3)", [
      orgId,
      preview.id,
      JSON.stringify(preview),
    ]);
    return publicPreview(preview);
  });
}

export async function confirmUsageCost(
  pool: Pool,
  orgId: string,
  actorId: string,
  id: string,
  now = Date.now(),
): Promise<UsageCostPreview> {
  return withPgTransaction(pool, async (client) => {
    const result = await client.query("SELECT preview FROM usage_cost_previews WHERE org_id=$1 AND id=$2 FOR UPDATE", [
      orgId,
      id,
    ]);
    const preview = result.rows[0]?.preview as StoredPreview | undefined;
    if (!preview || preview.actorId !== actorId) throw new UsageCostPreviewError("not_found");
    if (preview.confirmedAt !== null) return publicPreview(preview);
    if (preview.expiresAt <= now) throw new UsageCostPreviewError("expired");
    const rows = await client.query(
      "SELECT id,md5(fact::text) AS revision FROM usage_facts WHERE org_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE",
      [orgId, preview.candidates.map((c) => c.id)],
    );
    const revisions = new Map(rows.rows.map((r) => [r.id, r.revision]));
    if (preview.candidates.some((c) => revisions.get(c.id) !== c.revision)) throw new UsageCostPreviewError("stale");
    await client.query(
      `UPDATE usage_facts f SET fact=f.fact || jsonb_build_object(
      'costUsd',c.cost,'costSource','estimate','price',$3::jsonb,
      'costBackfill',jsonb_build_object('previewId',$4::text,'at',$5::bigint,'by',$6::text,
        'previousCostUsd',f.fact->'costUsd','previousCostSource',f.fact->'costSource','previousPrice',f.fact->'price')),
      dirty=TRUE,updated_at=$5
      FROM jsonb_to_recordset($2::jsonb) AS c(id text,cost numeric)
      WHERE f.org_id=$1 AND f.id=c.id`,
      [orgId, JSON.stringify(preview.candidates), JSON.stringify(preview.price), preview.id, now, actorId],
    );
    preview.confirmedAt = now;
    await client.query("UPDATE usage_cost_previews SET preview=$3 WHERE org_id=$1 AND id=$2", [
      orgId,
      id,
      JSON.stringify(preview),
    ]);
    return publicPreview(preview);
  });
}
