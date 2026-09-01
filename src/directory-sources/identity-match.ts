import type { AuthIdentity, OrganizationUser } from "../organization/organization-store.ts";
import type {
  DirectoryMatchCandidate,
  DirectoryMatchPolicy,
  DirectoryMatchResult,
  NormalizedDirectoryMember,
} from "./types.ts";

function candidate(
  user: OrganizationUser,
  matchedFields: string[],
  identities: readonly AuthIdentity[],
): DirectoryMatchCandidate {
  return {
    principalId: user.principalId,
    displayName: user.displayName,
    email: user.email,
    employeeNumber: user.employeeNumber,
    mobile: user.mobile,
    status: user.status,
    matchedFields,
    identityCount: identities.filter((identity) => identity.principalId === user.principalId).length,
  };
}

function uniqueUsers(users: readonly OrganizationUser[]): OrganizationUser[] {
  return [...new Map(users.map((user) => [user.principalId, user])).values()];
}

export function matchDirectoryMember(input: {
  member: NormalizedDirectoryMember;
  policy: DirectoryMatchPolicy;
  users: readonly OrganizationUser[];
  identities: readonly AuthIdentity[];
}): DirectoryMatchResult {
  const { member, users, identities } = input;
  if (member.status !== "active") {
    return { state: "inactive", reason: "external_inactive", automatic: false, principalId: null, candidates: [] };
  }
  const existing = identities.find(
    (identity) => identity.sourceId === member.sourceId && identity.externalSubjectId === member.externalSubjectId,
  );
  if (existing) {
    const user = users.find((candidate) => candidate.principalId === existing.principalId);
    if (!user)
      return {
        state: "conflict",
        reason: "binding_target_missing",
        automatic: false,
        principalId: null,
        candidates: [],
      };
    return {
      state: "bound",
      reason: "stable_binding",
      automatic: false,
      principalId: user.principalId,
      candidates: [candidate(user, ["stable_binding"], identities)],
    };
  }
  if (member.matchState === "ignored") {
    return { state: "ignored", reason: "administrator_ignored", automatic: false, principalId: null, candidates: [] };
  }
  const corporateEmails = new Set(
    member.emails
      .filter((email) => email.kind === "corporate" && email.verified)
      .map((email) => email.value.toLowerCase()),
  );
  const emailMatches = uniqueUsers(
    users.filter((user) => user.email !== null && corporateEmails.has(user.email.toLowerCase())),
  );
  const employeeMatches = member.employeeNumber
    ? uniqueUsers(users.filter((user) => user.employeeNumber?.toLowerCase() === member.employeeNumber?.toLowerCase()))
    : [];
  const mobileMatches = member.mobile
    ? uniqueUsers(users.filter((user) => user.mobile !== null && user.mobile === member.mobile))
    : [];
  const strongIds = new Set([...emailMatches, ...employeeMatches].map((user) => user.principalId));
  if (emailMatches.length > 1) {
    return {
      state: "conflict",
      reason: "duplicate_corporate_email",
      automatic: false,
      principalId: null,
      candidates: emailMatches.map((user) => candidate(user, ["corporate_email"], identities)),
    };
  }
  if (emailMatches.length === 1 && employeeMatches.length === 1 && strongIds.size > 1) {
    return {
      state: "conflict",
      reason: "email_employee_disagree",
      automatic: false,
      principalId: null,
      candidates: uniqueUsers([...emailMatches, ...employeeMatches]).map((user) =>
        candidate(user, [emailMatches.includes(user) ? "corporate_email" : "employee_number"], identities),
      ),
    };
  }
  if (emailMatches.length === 1) {
    const user = emailMatches[0]!;
    if (user.status === "deprovisioned") {
      return {
        state: "conflict",
        reason: "target_deprovisioned",
        automatic: false,
        principalId: null,
        candidates: [candidate(user, ["corporate_email"], identities)],
      };
    }
    const sourceConflict = identities.find(
      (identity) => identity.sourceId === member.sourceId && identity.principalId === user.principalId,
    );
    if (sourceConflict) {
      return {
        state: "conflict",
        reason: "target_already_bound_in_source",
        automatic: false,
        principalId: null,
        candidates: [candidate(user, ["corporate_email"], identities)],
      };
    }
    return {
      state: "suggested",
      reason: "unique_corporate_email",
      automatic: input.policy === "verified_corporate_email" && user.status !== "suspended",
      principalId: user.principalId,
      candidates: [candidate(user, ["corporate_email"], identities)],
    };
  }
  const suggestions = uniqueUsers([...employeeMatches, ...mobileMatches]);
  if (suggestions.length) {
    if (suggestions.length === 1 && suggestions[0]!.status === "deprovisioned") {
      return {
        state: "conflict",
        reason: "target_deprovisioned",
        automatic: false,
        principalId: null,
        candidates: [candidate(suggestions[0]!, employeeMatches.length ? ["employee_number"] : ["mobile"], identities)],
      };
    }
    let reason = "unique_mobile";
    if (suggestions.length > 1) reason = "multiple_weak_candidates";
    else if (employeeMatches.length) reason = "unique_employee_number";
    return {
      state: suggestions.length === 1 ? "suggested" : "conflict",
      reason,
      automatic: false,
      principalId: suggestions.length === 1 ? suggestions[0]!.principalId : null,
      candidates: suggestions.map((user) =>
        candidate(
          user,
          [
            ...(employeeMatches.some((match) => match.principalId === user.principalId) ? ["employee_number"] : []),
            ...(mobileMatches.some((match) => match.principalId === user.principalId) ? ["mobile"] : []),
          ],
          identities,
        ),
      ),
    };
  }
  return { state: "unmatched", reason: "no_candidate", automatic: false, principalId: null, candidates: [] };
}
