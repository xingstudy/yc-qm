export function databaseUrlFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const databaseMode = env.QM_DATABASE_MODE?.trim();
  const explicit = env.DATABASE_URL?.trim();
  if (databaseMode !== "bundled") return explicit || undefined;
  const password = env.POSTGRES_PASSWORD ?? "";
  if (!password) return undefined;
  try {
    const url = new URL("postgresql://127.0.0.1");
    url.username = encodeURIComponent(env.POSTGRES_USER?.trim() || "qm");
    url.password = encodeURIComponent(password);
    url.port = env.QM_POSTGRES_PORT?.trim() || "5432";
    url.pathname = `/${encodeURIComponent(env.POSTGRES_DB?.trim() || "qm")}`;
    return url.href;
  } catch {
    return undefined;
  }
}
