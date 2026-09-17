import type { Pool } from "pg";

export async function resetPgMigrations(pool: Pool, prefix: string): Promise<void> {
  const present = await pool.query("SELECT to_regclass('qm_schema_migrations') AS table_name");
  if (present.rows[0]?.table_name) {
    await pool.query("DELETE FROM qm_schema_migrations WHERE id = $1 OR starts_with(id, $2)", [prefix, `${prefix}/`]);
  }
}
