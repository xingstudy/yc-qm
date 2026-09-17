import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { scopeId } from "../src/types.ts";
import { isolatedPgTestDatabase } from "./support/isolated-pg-test-database.ts";

const firstUrl = await isolatedPgTestDatabase(process.env.DATABASE_URL);
const secondUrl = await isolatedPgTestDatabase(process.env.DATABASE_URL);

test(
  "destructive PG fixtures preserve another fixture's migrations and participants",
  { skip: !firstUrl },
  async () => {
    const first = new pg.Pool({ connectionString: firstUrl });
    const second = new pg.Pool({ connectionString: secondUrl });
    const firstStore = createPostgresSessionStore(firstUrl!);
    const secondStore = createPostgresSessionStore(secondUrl!);
    try {
      const scope = scopeId("personal", "fixture-isolation");
      const session = await secondStore.getOrCreateByThread("retained", "dm", scope);
      await firstStore.getOrCreateByThread("discarded", "dm", scope);
      const ledger = (await second.query("SELECT * FROM qm_schema_migrations ORDER BY id")).rows;
      assert.ok(ledger.length > 0);
      await secondStore.addParticipant(session.id, "retained-user");
      await first.query("DROP TABLE qm_schema_migrations, participants CASCADE");
      assert.deepEqual((await second.query("SELECT * FROM qm_schema_migrations ORDER BY id")).rows, ledger);
      const reopened = createPostgresSessionStore(secondUrl!);
      assert.equal((await reopened.get(session.id))?.id, session.id);
      assert.equal((await reopened.getForParticipant(session.id, "retained-user"))?.id, session.id);
      await reopened.addParticipant(session.id, "new-user");
      assert.equal((await reopened.getForParticipant(session.id, "new-user"))?.id, session.id);
      assert.equal((await first.query("SELECT to_regclass('qm_schema_migrations') AS name")).rows[0]?.name, null);
    } finally {
      await Promise.all([first.end(), second.end()]);
    }
  },
);
