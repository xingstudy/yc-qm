import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pages = readFileSync(new URL("../src/pages.ts", import.meta.url), "utf8");

test("mobile auth controls do not trigger browser focus zoom", () => {
  assert.match(pages, /maximum-scale=1/);
  assert.match(pages, /@media \(max-width:860px\)[\s\S]*font-size:16px!important/);
});
