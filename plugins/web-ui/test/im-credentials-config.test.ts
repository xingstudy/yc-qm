import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const server = new URL("../server/index.ts", import.meta.url).href;

for (const { label, value } of [
  { label: "missing", value: "" },
  { label: "non-hex", value: "x".repeat(64) },
  { label: "short", value: "0a".repeat(31) },
  { label: "long", value: `${"0a".repeat(32)}00` },
]) {
  test(`production rejects a ${label} WEB_UI_IM_CREDENTIALS_KEY`, () => {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", `await import(${JSON.stringify(server)})`],
      {
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "production", WEB_UI_IM_CREDENTIALS_KEY: value },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /WEB_UI_IM_CREDENTIALS_KEY must be exactly 32 bytes encoded as hexadecimal/);
  });
}
