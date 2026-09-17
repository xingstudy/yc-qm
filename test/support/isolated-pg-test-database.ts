import { randomUUID } from "node:crypto";
import { after } from "node:test";
import pg from "pg";

export async function isolatedPgTestDatabase(databaseUrl: string | undefined): Promise<string | undefined> {
  if (!databaseUrl) return undefined;
  const database = `fixture_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await pool.query(`CREATE DATABASE ${database}`);
  } finally {
    await pool.end();
  }
  after(async () => {
    const cleanup = new pg.Pool({ connectionString: databaseUrl });
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  });
  return url.toString();
}
