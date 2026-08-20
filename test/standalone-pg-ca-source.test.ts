import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

test("standalone PostgreSQL maintenance scripts load DATABASE_CA_CERT trust", () => {
  assert.match(source("../scripts/backfill-session-tape.ts"), /configurePgCaTrustFromEnv\(process\.env\)/);
  assert.match(source("../scripts/mine-slack-scenarios.ts"), /pgConnectionOptionsFromEnv\(url, process\.env\)/);
  assert.match(
    source("../scripts/migrate-principals-to-email.mjs"),
    /pgConnectionOptionsFromEnv\(process\.env\.DATABASE_URL, process\.env\)/,
  );
});
