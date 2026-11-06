import type { UsageIdentity } from "./usage-store.ts";

export const AMBIGUOUS_DEPARTMENT = "__department_ambiguous__";

export interface DepartmentUnit {
  id: string;
  name: string;
  parentId: string | null;
  kind: string;
  status: string;
}

export interface DepartmentMembership {
  unitId: string;
  isPrimary?: boolean;
}

export type DepartmentSnapshot = Pick<
  UsageIdentity,
  "unitId" | "unitName" | "unitPath" | "unitAncestors" | "unitAttribution"
>;

export function resolveUsageDepartment(
  units: readonly DepartmentUnit[],
  members: readonly DepartmentMembership[],
): DepartmentSnapshot {
  const eligible = new Map(
    units
      .filter((unit) => unit.status === "active" && ["department", "team"].includes(unit.kind))
      .map((unit) => [unit.id, unit]),
  );
  const valid = [
    ...new Map(
      members.filter((member) => eligible.has(member.unitId)).map((member) => [member.unitId, member]),
    ).values(),
  ];
  const primary = valid.find((member) => member.isPrimary);
  const chosen = primary ?? (valid.length === 1 ? valid[0] : undefined);
  if (!chosen)
    return {
      unitId: valid.length > 1 ? AMBIGUOUS_DEPARTMENT : "",
      unitName: valid.length > 1 ? "归属待确认" : "未分配",
      unitPath: [],
      unitAncestors: [],
      unitAttribution: valid.length > 1 ? "ambiguous" : "unassigned",
    };
  return departmentSnapshot(units, chosen.unitId, primary ? "primary" : "single");
}

export function departmentSnapshot(
  units: readonly DepartmentUnit[],
  id: string,
  attribution: UsageIdentity["unitAttribution"] = "correction",
): DepartmentSnapshot {
  const all = new Map(units.map((unit) => [unit.id, unit]));
  const unit = all.get(id);
  if (!unit || unit.status !== "active" || !["department", "team"].includes(unit.kind))
    throw new Error("invalid_department");
  const ancestors: Array<{ id: string; name: string }> = [];
  let current: DepartmentUnit | undefined = unit;
  while (current) {
    if (
      ancestors.some((ancestor) => ancestor.id === current!.id) ||
      ancestors.length >= 1000 ||
      current.status !== "active"
    )
      throw new Error("invalid_department_hierarchy");
    ancestors.push({ id: current.id, name: current.name });
    if (current.parentId === null) break;
    current = all.get(current.parentId);
    if (!current) throw new Error("invalid_department_hierarchy");
  }
  return {
    unitId: unit.id,
    unitName: unit.name,
    unitPath: ancestors.map((ancestor) => ancestor.id),
    unitAncestors: ancestors,
    unitAttribution: attribution,
  };
}
