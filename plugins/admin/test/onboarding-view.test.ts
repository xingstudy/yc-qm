import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function slice(from: string, to: string): string {
  const start = html.indexOf(from);
  const end = html.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `could not extract ${from}`);
  return html.slice(start, end);
}

function resolveView(pathname: string, search: string): string {
  const src = [
    slice("const SECTIONS = [", "const DISABLED_VIEWS"),
    slice("const DEFAULT_VIEW = ", ";") + ";",
    slice("function urlToState() {", "let transcriptObserver"),
    "urlToState().view;",
  ].join("\n");
  const context = vm.createContext({
    URLSearchParams,
    API_BASE: "/admin",
    scope: "org",
    location: { pathname, search },
  });
  return vm.runInContext(src, context);
}

test("onboarding is a navigable view", () => {
  assert.match(html, /label: "Admin",\s*views: \[\s*"onboarding",/);
});

test("/admin/onboarding resolves to the onboarding view", () => {
  assert.equal(resolveView("/admin/onboarding", ""), "onboarding");
});

test("?view=onboarding resolves to the onboarding view", () => {
  assert.equal(resolveView("/admin/", "?view=onboarding"), "onboarding");
});

test("unknown views still fall back to the default view", () => {
  assert.equal(resolveView("/admin/no-such-view", ""), "history");
});

test("custom providers participate in onboarding without re-entering their managed key", () => {
  const onboarding = slice("let onboardingModels = {};", "function openOnboardingTarget(target) {");
  assert.match(onboarding, /status\.name \|\| MODEL_PROVIDER_LABELS\[status\.provider\]/);
  assert.match(onboarding, /const custom = status\?\.kind === "custom";/);
  assert.match(onboarding, /baseModel \+ " is no longer available\. Choose another base model\."/);
  assert.match(onboarding, /onboarding-model-key"\)\.disabled = custom/);
  assert.match(onboarding, /\? "Use as base model"/);
  assert.match(onboarding, /: "Add a key below first"/);
  assert.match(onboarding, /if \(!custom && !apiKey\)/);
  assert.match(onboarding, /if \(custom && !status\.configured\)/);
  assert.match(onboarding, /loadOnboarding\(id, models\[0\]\?\.id \|\| ""\)/);
  assert.match(onboarding, /const \[models, slack, catalog, config, customProvidersReady\] = await Promise\.all/);
  assert.match(onboarding, /if \(!apiKey && !existing\?\.hasKey\)/);
  assert.match(onboarding, /return \{ setupReady: true, customProvidersReady \}/);
});

test("onboarding requests turn network failures into retryable results", async () => {
  const requestSource = slice("async function onboardingRequest", "function onboardingBadge");
  const context = vm.createContext({
    api: async () => {
      throw new Error("offline");
    },
  });
  const result = await vm.runInContext(`${requestSource}\nonboardingRequest("GET", "/api/test");`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: false, status: 0, data: null });
});
