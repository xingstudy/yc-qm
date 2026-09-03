import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const server = new URL("../server/index.ts", import.meta.url).href;

for (const { label, value } of [
  { label: "missing", value: "" },
  { label: "short", value: "x".repeat(31) },
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
    assert.match(result.stderr, /WEB_UI_IM_CREDENTIALS_KEY must be at least 32 characters/);
  });
}

for (const { label, value } of [
  { label: "32-byte hexadecimal", value: "0a".repeat(32) },
  { label: "32-character secret", value: "N7m!2Qp#9Vr@4Tx$8Kz&5Bw*3Hy=6Dc!" },
  { label: "long secret", value: "C4v!8Zn#2Lp@7Qx$5Hw&9Tr*6By=3Ds-K1m" },
]) {
  test(`production accepts a ${label} WEB_UI_IM_CREDENTIALS_KEY`, () => {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", `await import(${JSON.stringify(server)}); process.exit(0)`],
      {
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "production", WEB_UI_IM_CREDENTIALS_KEY: value },
      },
    );
    assert.equal(result.status, 0, result.stderr);
  });
}
