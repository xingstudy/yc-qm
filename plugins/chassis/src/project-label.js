export function projectIdFromScope(scopeId) {
  const prefix = "group:web-project-";
  if (typeof scopeId !== "string" || !scopeId.startsWith(prefix)) return null;
  const id = scopeId.slice(prefix.length);
  return id && !id.includes(":") ? id : null;
}

export function projectDisplayName(id, name, unknownLabel = "Unknown Project") {
  const clean = typeof name === "string" ? name.trim() : "";
  if (clean && ![id, `web-project-${id}`, `group:web-project-${id}`].includes(clean)) return clean;
  return `${unknownLabel} · ${id.slice(0, 8)}`;
}

export function projectScopeName(scopeId, name, unknownLabel) {
  const id = projectIdFromScope(scopeId);
  return id === null ? null : projectDisplayName(id, name, unknownLabel);
}
