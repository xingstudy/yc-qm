import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const portal = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("mobile portal controls do not trigger browser focus zoom", () => {
  assert.match(portal, /maximum-scale=1/);
  assert.match(portal, /@media \(max-width:860px\)[\s\S]*font-size:16px!important/);
});
