import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function picker(scope: string, rows: unknown[]) {
  const element = () => ({
    textContent: "",
    value: "",
    title: "",
    label: "",
    children: [] as any[],
    appendChild(child: unknown) {
      this.children.push(child);
    },
    onchange: (_event: unknown) => undefined,
  });
  const select = element();
  const navigation: string[] = [];
  const context = vm.createContext({
    scope,
    scopeDir: rows,
    orgId: "acme",
    scopeDirNote: "Loading scopes…",
    governanceOverviewData: null,
    $: () => select,
    document: { createElement: element },
    scopeKind: (id: string) => id.split(":")[0],
    shortName: (id: string) =>
      (rows as { scopeId: string; label: string }[]).find((row) => row.scopeId === id)?.label || id,
    adminTr: (text: string) => text,
    selectScope: (id: string) => navigation.push(id),
  });
  const start = html.indexOf("      function governanceScopeName(");
  const end = html.indexOf("      function commitGo(", start);
  vm.runInContext(html.slice(start, end) + "\nrenderGovernanceScopePicker();", context);
  return { select, navigation };
}

test("governance picker separates access groups and preserves the complete organization hierarchy", () => {
  const { select } = picker("org-unit:leaf", [
    { scopeId: "org-unit:leaf", label: "Platform", parentScopeId: "org-unit:dept" },
    { scopeId: "org-unit:dept", label: "Engineering", parentScopeId: "org-unit:root" },
    { scopeId: "org-unit:root", label: "Head office", parentScopeId: "org:acme" },
    { scopeId: "access-group:release", label: "Release" },
  ]);
  assert.equal(select.value, "org-unit:leaf");
  const tree = select.children.find((child) => child.label === "Org tree");
  assert.deepEqual(
    tree.children.map((child: any) => child.textContent),
    ["Head office", "Head office / Engineering", "Head office / Engineering / Platform"],
  );
  assert.equal(
    select.children.find((child) => child.label === "Access groups").children[0].value,
    "access-group:release",
  );
});

test("changing the picker uses guarded navigation and keeps the committed scope while confirmation is pending", () => {
  const { select, navigation } = picker("org:acme", []);
  select.value = "access-group:release";
  select.onchange({ target: select });
  assert.deepEqual(navigation, ["access-group:release"]);
  assert.equal(select.value, "org:acme");
});

test("scope deep links remain selectable before the directory arrives", () => {
  const { select } = picker("access-group:release", []);
  assert.equal(select.value, "access-group:release");
  assert.ok(
    select.children.some((group) => group.children.some((option: any) => option.value === "access-group:release")),
  );
});

test("hidden environment notices and loading governance forms override their flex and grid layouts", () => {
  assert.match(html, /\.environment-notice\.hidden\s*\{\s*display: none;/);
  assert.match(html, /#governance-settings\.hidden\s*\{\s*display: none;/);
  assert.match(html, /\$\("governance-settings"\)\.classList\.add\("hidden"\)/);
  assert.match(html, /\$\("governance-settings"\)\.classList\.remove\("hidden"\)/);
});

function runtimeSettings() {
  const elements = new Map<string, any>();
  const element = () => ({
    value: "",
    textContent: "",
    children: [] as any[],
    hidden: false,
    classList: {
      toggle(name: string, hidden: boolean) {
        assert.equal(name, "hidden");
        this.hidden = hidden;
      },
      hidden: false,
    },
    appendChild(child: unknown) {
      this.children.push(child);
    },
  });
  const $ = (id: string) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const context = vm.createContext({ $, document: { createElement: element } });
  const start = html.indexOf("        const opts = r.data.baseModelOptions");
  const end = html.indexOf("        const showApprovedHarnesses", start);
  assert.ok(start > 0 && end > start);
  const render = vm.runInContext(`(scope, r) => { ${html.slice(start, end)} }`, context);
  return { $, render };
}

const runtimeData = {
  runtime: null,
  baseModelDefault: "provider/model-a",
  harnessDefault: "pi",
  approvedHarnesses: ["pi", "codex"],
  baseModelOptions: [
    { id: "provider/model-a", name: "Model A" },
    { id: "provider/model-b", name: "Model B" },
  ],
  modelsByHarness: {
    pi: [
      { id: "provider/model-a", name: "Model A" },
      { id: "provider/model-b", name: "Model B" },
    ],
    codex: [{ id: "provider/model-b", name: "Model B" }],
  },
};

for (const scope of ["org:acme", "personal:alice", "org-unit:engineering", "access-group:release"]) {
  test(`default runtime is available for ${scope} with inherited values and approved choices`, () => {
    const { $, render } = runtimeSettings();
    render(scope, { data: runtimeData });
    assert.equal($("card-base-model").classList.hidden, false);
    assert.equal($("model-scope-note").classList.hidden, scope === "org:acme");
    assert.equal($("base-harness").value, "pi");
    assert.equal($("base-model").value, "provider/model-a");
    assert.deepEqual(
      $("base-harness").children.map((option: any) => option.value),
      ["pi", "codex"],
    );
    $("base-harness").value = "codex";
    $("base-harness").oninput();
    assert.equal($("base-model").value, "provider/model-b");
  });
}

test("switching scopes replaces the previous model with the selected scope's override or inherited default", () => {
  const { $, render } = runtimeSettings();
  render("org:acme", { data: runtimeData });
  render("personal:alice", {
    data: { ...runtimeData, runtime: { harnessId: "pi", modelId: "provider/model-b" } },
  });
  assert.equal($("base-model").value, "provider/model-b");
  render("access-group:release", { data: runtimeData });
  assert.equal($("base-model").value, "provider/model-a");
});

test("runtime controls remain unavailable when the API has no runtime capability or serviceable models", () => {
  const { $, render } = runtimeSettings();
  render("personal:alice", { data: {} });
  assert.equal($("card-base-model").classList.hidden, true);
  render("access-group:release", { data: { ...runtimeData, baseModelOptions: [] } });
  assert.equal($("card-base-model").classList.hidden, true);
});

test("admin governance omits Local Docker deployment instructions", () => {
  assert.doesNotMatch(html, /egress-local-setup|Configure Local Docker outbound controls|配置 Local Docker 出站限制/);
  assert.doesNotMatch(html, /docker compose up -d --build egress-proxy core/);
  assert.match(html, /id="egress-capability"/);
});

for (const scope of ["org:acme", "personal:alice", "org-unit:engineering", "access-group:release"]) {
  test(`model and browsing controls are available for ${scope}`, () => {
    const data = {
      interactiveFastMode: false,
      approvedHarnesses: ["pi"],
      webuiModels: [],
      browseMaxSteps: 20,
      browseModel: null,
      turnWallClockSec: 120,
    };
    for (const variable of [
      "showInteractiveFastMode",
      "showApprovedHarnesses",
      "showWebuiModels",
      "showBrowseSteps",
      "showBrowseModel",
      "showTurnWallClock",
    ]) {
      const expression = html.match(new RegExp(`const ${variable} = ([^;]+);`))?.[1];
      assert.ok(expression, variable);
      assert.equal(
        vm.runInNewContext(expression, { scope, r: { data }, opts: [{}], browseOpts: [{}] }),
        true,
        variable,
      );
    }
  });
}

test("model and browsing overrides can be restored to inherited settings", () => {
  for (const key of [
    "interactive-fast-mode",
    "approved-harnesses",
    "webui-models",
    "browse-model",
    "browse-max-steps",
    "turn-wall-clock",
    "runtime",
  ]) {
    assert.match(html, new RegExp(`data-inherit="${key}"`));
  }
  assert.match(html, /\{\s*inherit: true,?\s*\}/);
});

test("adding and removing allowed model chips marks the section ready to save", () => {
  const calls: string[] = [];
  const context = vm.createContext({
    webuiModelIds: [] as string[],
    addInput: { value: "model-a", setCustomValidity: () => undefined },
    catalogModels: [{ id: "model-a", name: "Model A" }],
    renderChips: () => undefined,
    syncDefault: () => undefined,
    updateSectionDirty: (key: string) => calls.push(key),
    id: "model-a",
  });
  const addStart = html.indexOf("          const addModel = () => {");
  const addEnd = html.indexOf("          addInput.onchange", addStart);
  assert.ok(addStart > 0 && addEnd > addStart);
  vm.runInContext(html.slice(addStart, addEnd) + "\naddModel();", context);
  assert.equal(vm.runInContext('webuiModelIds.join(",")', context), "model-a");
  assert.deepEqual(calls, ["webui-models"]);
  const removeStart = html.indexOf(
    "              x.onclick = () => {",
    html.indexOf('const chips = $("webui-models-chips")'),
  );
  const removeEnd = html.indexOf("              };", removeStart);
  assert.ok(removeStart > 0 && removeEnd > removeStart);
  vm.runInContext(html.slice(removeStart, removeEnd).replace("x.onclick = () => {", "(() => {") + "})();", context);
  assert.equal(vm.runInContext("webuiModelIds.length", context), 0);
  assert.deepEqual(calls, ["webui-models", "webui-models"]);
});

test("allowed models direct administrators to the actual runtime default", () => {
  assert.doesNotMatch(html, /webui-models-default/);
  assert.match(html, /Set the default in Default harness and model above/);
  assert.match(html, /Codex requires an OpenAI Responses model/);
});

test("model entry rejects unavailable bare IDs and ambiguous provider names", () => {
  for (const raw of ["gpt-5.6-terra", "Shared name"]) {
    let error = "";
    const context = vm.createContext({
      webuiModelIds: [],
      addInput: {
        value: raw,
        setCustomValidity: (message: string) => {
          error = message;
        },
        reportValidity: () => false,
      },
      catalogModels: [
        { id: "first/gpt-5.6-terra", name: "Shared name" },
        { id: "second/gpt-5.6-terra", name: "Shared name" },
      ],
      adminTr: (value: string) => value,
      renderChips: () => assert.fail("unavailable model must not be added"),
      updateSectionDirty: () => assert.fail("unavailable model must not change the saved list"),
    });
    const start = html.indexOf("          const addModel = () => {");
    const end = html.indexOf("          addInput.oninput", start);
    vm.runInContext(html.slice(start, end) + "\naddModel();", context);
    assert.match(error, /full provider\/model ID/);
    assert.equal(vm.runInContext("webuiModelIds.length", context), 0);
  }
});

test("private network editor includes IP ranges in saves and clears stale entries on scope changes", () => {
  const elements = new Map<string, any>();
  const $ = (id: string) => {
    if (!elements.has(id)) elements.set(id, { value: "", textContent: "", appendChild() {}, addEventListener() {} });
    return elements.get(id);
  };
  const context = vm.createContext({
    $,
    adminTr: (text: string) => text,
    document: { createElement: () => ({ textContent: "" }) },
  });
  const start = html.indexOf("      function collectEgress()");
  const end = html.indexOf("      const SAVE =", start);
  assert.ok(start > 0 && end > start);
  vm.runInContext(html.slice(start, end), context);
  $("egress-private").value = " kibana.example.com \n10.1.37.0/24\n10.1.37.200-10.1.37.210\nfd00::/64\n";
  const policy = JSON.parse(JSON.stringify(vm.runInContext("collectEgress()", context)));
  assert.deepEqual(policy.privateNetworkAllowedHosts, [
    "kibana.example.com",
    "10.1.37.0/24",
    "10.1.37.200-10.1.37.210",
    "fd00::/64",
  ]);
  context.policy = policy;
  vm.runInContext("populateEgress(policy)", context);
  assert.equal($("egress-private").value, policy.privateNetworkAllowedHosts.join("\n"));
  vm.runInContext("populateEgress(null)", context);
  assert.equal($("egress-private").value, "");
  assert.match(html, /for="egress-private"/);
  assert.match(html, /"Allowed private network domains \/ IPs": "允许访问内网的域名\/IP"/);
});
