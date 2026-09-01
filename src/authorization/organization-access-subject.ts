import type { ScopeId } from "../types.ts";

type OrganizationAccessSubjectKind = "user" | "org_unit" | "access_group";

export interface OrganizationAccessSubject {
  kind: OrganizationAccessSubjectKind;
  id: string;
  name?: string;
}

export function organizationAccessSubjectScope(subject: OrganizationAccessSubject): ScopeId {
  let prefix = "access-group";
  if (subject.kind === "user") prefix = "personal";
  else if (subject.kind === "org_unit") prefix = "org-unit";
  return `${prefix}:${subject.id}`;
}

export function organizationAccessSubjectFromScope(value: ScopeId): OrganizationAccessSubject | null {
  const split = value.indexOf(":");
  if (split <= 0 || split === value.length - 1) return null;
  const prefix = value.slice(0, split);
  const id = value.slice(split + 1);
  if (prefix === "personal") return { kind: "user", id };
  if (prefix === "org-unit") return { kind: "org_unit", id };
  if (prefix === "access-group") return { kind: "access_group", id };
  return null;
}
