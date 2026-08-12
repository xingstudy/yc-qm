const GENERIC_PLACEHOLDER = /^(replace-me|placeholder|changeme|todo)$/i;
const EXAMPLE_MARKER = /qm-example/i;

export function isProductionPlaceholder(value: string | undefined): boolean {
  const candidate = value?.trim();
  return !candidate || GENERIC_PLACEHOLDER.test(candidate) || EXAMPLE_MARKER.test(candidate);
}

export function isExampleDomain(value: string | undefined): boolean {
  const candidate = value?.trim().toLowerCase();
  if (!candidate) return false;
  return candidate === "example.com" || candidate.endsWith(".example.com");
}

export function isExampleEmail(value: string | undefined): boolean {
  const candidate = value?.trim().toLowerCase();
  if (!candidate) return false;
  const separator = candidate.lastIndexOf("@");
  return separator !== -1 && isExampleDomain(candidate.slice(separator + 1));
}

export function isExampleJwk(value: Record<string, unknown> | null): boolean {
  return value?.kid === "qm-example-do-not-use";
}
