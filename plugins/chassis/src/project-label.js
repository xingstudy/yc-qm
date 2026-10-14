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

export function projectOptionName(project, projects, unknownLabel) {
  const name = projectDisplayName(project.id, project.name, unknownLabel);
  const peers = projects.filter((item) => projectDisplayName(item.id, item.name, unknownLabel) === name);
  if (peers.length < 2) return name;
  let creator = project.creatorName?.trim() || project.creatorId;
  if (!creator) return `${name} · ${project.id.slice(0, 8)}`;
  if (
    peers.some(
      (item) => (item.creatorName?.trim() || item.creatorId) === creator && item.creatorId !== project.creatorId,
    )
  )
    creator = project.creatorId || creator;
  const repeatedCreator = peers.filter((item) => item.creatorId === project.creatorId).length > 1;
  return `${name} · ${creator}${repeatedCreator ? ` · ${project.id.slice(0, 8)}` : ""}`;
}
