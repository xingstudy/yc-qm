import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const shell = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const components = readFileSync(new URL("../public/admin-components.css", import.meta.url), "utf8");

test("admin idempotency keys work when randomUUID is unavailable on an HTTP LAN origin", () => {
  assert.match(shell, /function browserRandomUUID\(\)/);
  assert.match(shell, /typeof crypto\.randomUUID === "function"/);
  assert.match(shell, /crypto\.getRandomValues\(new Uint8Array\(16\)\)/);
  assert.doesNotMatch(shell, /"idempotency-key": crypto\.randomUUID\(\)/);
});

test("admin prevents mobile browsers from zooming the page when an input is focused", () => {
  assert.match(shell, /maximum-scale=1/);
  assert.match(
    components,
    /@media \(max-width: 860px\)[\s\S]*input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)[\s\S]*\[contenteditable\]:not\(\[contenteditable="false"\]\)[\s\S]*font-size: 16px !important/,
  );
});
