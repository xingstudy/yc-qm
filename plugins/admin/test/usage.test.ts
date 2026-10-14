import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  mountUsageDashboard,
  usageAutoRefresh,
  usageDate,
  usageRange,
  usageMetric,
  usagePeriods,
} from "../public/usage.js";

let manager = false;
let received = "";
const core = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/v1/admin/whoami") return void res.end(JSON.stringify({ isAdmin: !manager, isManager: manager }));
  if (req.url?.startsWith("/v1/admin/usage")) {
    received = req.url;
    assert.ok(
      req.headers["x-core-signature"] ||
        req.headers["x-signature"] ||
        Object.keys(req.headers).some((key) => key.includes("signature")),
    );
    return void res.end(JSON.stringify({ ok: true }));
  }
  res.end(JSON.stringify({}));
});
await new Promise<void>((resolve) => core.listen(0, resolve));
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_ORG_ID = "acme";
process.env.CORE_SIGNING_SECRET = "usage-proxy-test-signing-secret";
const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, resolve));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
after(async () => {
  await Promise.all([
    new Promise<void>((resolve) => server.close(() => resolve())),
    new Promise<void>((resolve) => core.close(() => resolve())),
  ]);
});

test("usage presets and refresh guard use Beijing dates, visibility and current ranges", () => {
  const now = Date.parse("2026-03-01T00:00:00+08:00");
  assert.deepEqual(usageRange("7", now), { start: "2026-02-23", end: "2026-03-01" });
  assert.deepEqual(usageRange("lastMonth", now), { start: "2026-02-01", end: "2026-02-28" });
  assert.equal(usageDate(Date.parse("2026-02-28T16:00:00Z")), "2026-03-01");
  const state = { visible: true, active: true, enabled: true, end: "2026-03-01" };
  assert.equal(usageAutoRefresh(state, now), true);
  for (const key of ["visible", "active", "enabled"])
    assert.equal(usageAutoRefresh({ ...state, [key]: false }, now), false);
  assert.equal(usageAutoRefresh({ ...state, end: "2026-02-28" }, now), false);
});

test("manual and scheduled refresh update facets while retaining selected filters", async () => {
  class Element {
    children: Element[] = [];
    textContent = "";
    style = { cssText: "", padding: "", margin: "", cursor: "" };
    dataset = {};
    value = "";
    selected = false;
    multiple = false;
    checked = false;
    hidden = false;
    className = "";
    attributes = new Map<string, string>();
    classList = {
      add: (...names: string[]) => {
        this.className += ` ${names.join(" ")}`;
      },
    };
    onclick?: () => void;
    onchange?: () => void;
    ontoggle?: () => void;
    onfocus?: () => void;
    onpointermove?: (event: { clientX: number; clientY: number; stopPropagation?: () => void }) => void;
    onpointerleave?: () => void;
    onkeydown?: (event: { key: string }) => void;
    open = false;
    tag: string;
    constructor(tag: string) {
      this.tag = tag;
    }
    append(...children: Element[]) {
      this.children.push(...children);
    }
    prepend(...children: Element[]) {
      this.children.unshift(...children);
    }
    insertBefore(child: Element, before: Element) {
      const at = this.children.indexOf(before);
      this.children.splice(at < 0 ? this.children.length : at, 0, child);
    }
    replaceChildren(...children: Element[]) {
      this.children = children;
    }
    setAttribute(key: string, value: string) {
      this.attributes.set(key, value);
      if (key === "class") this.className = value;
    }
    get options() {
      return this.children.values();
    }
    get selectedOptions() {
      return this.children.filter((c) => c.selected || c.value === this.value);
    }
    querySelectorAll(selector: string): Element[] {
      return this.children
        .flatMap((c) => [c, ...c.querySelectorAll("*")])
        .filter(
          (c) =>
            selector === "*" ||
            (selector.startsWith(".") ? c.className.split(" ").includes(selector.slice(1)) : c.tag === selector),
        );
    }
    querySelector(selector: string) {
      return this.querySelectorAll(selector)[0];
    }
    contains(child: Element) {
      return child === this || this.querySelectorAll("*").includes(child);
    }
    focus() {}
    getBoundingClientRect() {
      const [, , width, height] = (this.attributes.get("viewBox") ?? "0 0 600 240").split(" ").map(Number);
      return { left: 100, top: 50, width: width!, height: height! };
    }
  }
  const metrics = {
    requests: 0,
    success: 0,
    failed: 0,
    cancelled: 0,
    pending: 0,
    calls: 0,
    unknownCalls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    samples: 0,
    knownTokens: 0,
    costUsd: 0,
    knownCost: 0,
    activeUsers: 0,
  };
  const report = {
    total: metrics,
    previous: metrics,
    status: { pending: 0, unresolved: 0 },
    series: [{ period: "2026-10-14", metrics }],
    breakdown: [{ id: "a", name: "User 0", metrics }],
  };
  let facetRequests = 0;
  const price = {
    id: "price-before",
    provider: "proxy",
    model: "custom",
    rates: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 },
    tiers: [],
    fastMultiplier: null,
    effectiveAt: 0,
    source: "administrator",
    checkedAt: "",
    sourceUrl: "",
  };
  let savedPriceBody: { provider: string; model: string; rates: { input: number } } | undefined;
  let savedLayout:
    | {
        panels: Array<{ id: string; dimension: string; metric: string; visual: string; width: string }>;
        expectedUpdatedAt: number;
      }
    | undefined;
  let layoutVersion = 0;
  let scheduled = () => {};
  let resizeCharts = (_entries: Array<{ target: Element; contentRect: { width: number } }>) => {};
  const observedCharts = new Set<Element>();
  let chartDisconnects = 0;
  const win = {
    location: { href: "http://localhost/admin/usage?user=a" },
    history: { replaceState() {} },
    AbortController,
    ResizeObserver: class {
      constructor(callback: typeof resizeCharts) {
        resizeCharts = callback;
      }
      observe(target: Element) {
        observedCharts.add(target);
      }
      disconnect() {
        observedCharts.clear();
        chartDisconnects++;
      }
    },
    fetch: async (url: string, options?: { method?: string; body?: string }) => ({
      ok: true,
      json: async () => {
        if (url.endsWith("/layout")) {
          if (options?.method === "POST") {
            savedLayout = JSON.parse(options.body!);
            layoutVersion++;
          }
          return { value: savedLayout ? { panels: savedLayout.panels } : null, updatedAt: layoutVersion };
        }
        if (url.includes("/panels?")) {
          const keys = new URL(url, "http://localhost").searchParams.getAll("panel");
          return {
            panels: Object.fromEntries(
              keys.map((key) => [
                key,
                [
                  { id: "a", name: "User 0", metrics, series: report.series },
                  {
                    id: "b",
                    name: "User <1>",
                    metrics,
                    series: [
                      {
                        period: "2026-10-14",
                        metrics: { ...metrics, samples: 1, knownTokens: 1, input: 200, knownCost: 0 },
                      },
                    ],
                  },
                  { id: "c", name: "User missing", metrics, series: [] },
                ],
              ]),
            ),
          };
        }
        if (url.endsWith("/pricing")) {
          if (options?.method !== "POST") return { versions: [price] };
          savedPriceBody = JSON.parse(options.body!);
          return { price: { ...price, id: "price-after" } };
        }
        if (url.endsWith("/facets"))
          return {
            project: [
              { id: "aaaaaaaa-1", name: "Same Project" },
              { id: "bbbbbbbb-2", name: "Same Project" },
              { id: "cccccccc-3", name: "cccccccc-3" },
            ],
            user: Array.from({ length: ++facetRequests }, (_, i) => ({
              id: String.fromCharCode(97 + i),
              name: `User ${i}`,
            })),
          };
        return report;
      },
    }),
    clearTimeout() {},
    setTimeout(callback: () => void) {
      scheduled = callback;
      return 1;
    },
  };
  const doc = {
    defaultView: win,
    hidden: false,
    body: { dataset: { subview: "usage" } },
    createElement: (tag: string) => new Element(tag),
    createElementNS: (_ns: string, tag: string) => new Element(tag),
    addEventListener() {},
    removeEventListener() {},
  };
  const root = Object.assign(new Element("div"), { ownerDocument: doc });
  const nodes = (element: Element): Element[] => [element, ...element.children.flatMap(nodes)];
  const users = () =>
    nodes(root).find(
      (element) => element.className.includes("usage-filter ") && element.children[0]?.textContent === "用户",
    )!;
  const checks = () =>
    users()
      .querySelectorAll("input")
      .filter((element) => "usageOption" in element.dataset);
  const dashboard = mountUsageDashboard(root);
  await new Promise(setImmediate);
  assert.equal(checks().length, 1);
  const projectFilter = nodes(root).find(
    (element) => element.className.includes("usage-filter ") && element.children[0]?.textContent === "Project",
  )!;
  const projectOptions = nodes(projectFilter).filter((element) => element.className === "usage-option");
  assert.deepEqual(
    projectOptions.map((element) => element.children[1]?.textContent),
    ["Same Project · aaaaaaaa", "Same Project · bbbbbbbb", "名称未知 Project · cccccccc"],
  );
  assert.equal((projectOptions[0] as Element & { title: string }).title, "aaaaaaaa-1");
  assert.equal(checks()[0]!.checked, true);
  assert.equal(users().children[2]!.hidden, true);
  assert.equal(users().children[1]!.attributes.get("aria-expanded"), "false");
  const filterFold = nodes(root).find((el) => el.tag === "details" && el.className === "usage-filter-fold")!;
  assert.equal(filterFold.open, false);
  assert.equal(filterFold.children[0]!.textContent, "筛选 · 已选 1 项");
  const userChart = nodes(root).find(
    (el) => el.attributes.get("aria-label") === "用户 · 已知 Token" && el.tag === "section",
  )!;
  const svg = userChart.querySelector("svg")!;
  const legend = userChart.querySelector(".usage-legend")!;
  const caption = userChart.querySelector(".usage-legend-head")!.children[0]!;
  assert.equal(userChart.querySelector(".usage-chart-tooltip"), undefined);
  assert.ok(caption.textContent.includes("悬停查看"));
  const points = svg.querySelectorAll(".usage-plot-point");
  const userPoint = points.find((point) => point.attributes.get("aria-label")?.includes("User <1>"))!;
  svg.onpointermove!({
    clientX: Number(userPoint.attributes.get("cx")) + 100,
    clientY: Number(userPoint.attributes.get("cy")) + 50,
  });
  assert.ok(caption.textContent.includes("2026-10-14"));
  assert.ok(caption.textContent.includes("User <1>: 200 · 覆盖率 100%"));
  assert.equal(caption.attributes.get("aria-label"), caption.textContent);
  assert.equal((caption as Element & { title: string }).title, caption.textContent);
  assert.ok(nodes(legend).some((el) => el.textContent === "User 0"));
  assert.ok(nodes(legend).some((el) => (el as Element & { title?: string }).title?.startsWith("User 0 · a ·")));
  assert.ok(nodes(legend).some((el) => el.textContent === "User <1>"));
  assert.ok(nodes(legend).some((el) => el.textContent === "200"));
  assert.ok(nodes(legend).some((el) => el.textContent === "无汇总记录"));
  const legendItems = legend.querySelectorAll(".usage-legend-item");
  assert.equal(legendItems[1]!.attributes.get("data-active"), "true");
  assert.equal(userPoint.attributes.get("r"), "6");
  svg.onpointerleave!();
  assert.ok(caption.textContent.includes("悬停查看"));
  assert.ok(legend.querySelectorAll(".usage-legend-value").every((el) => el.textContent === "—"));
  assert.equal(userPoint.attributes.get("r"), "3.5");
  userPoint.onfocus!();
  assert.ok(caption.textContent.includes("2026-10-14"));
  svg.onkeydown!({ key: "Escape" });
  assert.ok(caption.textContent.includes("悬停查看"));
  let stopped = false;
  svg.querySelectorAll(".usage-plot-hit-line")[1]!.onpointermove!({
    clientX: Number(userPoint.attributes.get("cx")) + 110,
    clientY: 100,
    stopPropagation: () => {
      stopped = true;
    },
  });
  assert.equal(stopped, true);
  assert.equal(legendItems[1]!.attributes.get("data-active"), "true");
  svg.onpointerleave!();
  const groups = svg.querySelectorAll(".usage-plot-series");
  const allSeries = legend.querySelector(".usage-legend-all")!;
  const chartHost = userChart.querySelector(".usage-chart-container")!;
  assert.equal(chartHost.children.indexOf(svg) < chartHost.children.indexOf(legend), true);
  legendItems[1]!.onclick!();
  assert.deepEqual(
    groups.map((el) => el.attributes.get("display")),
    ["none", "inline", "none"],
  );
  assert.deepEqual(
    legendItems.map((el) => el.attributes.get("aria-pressed")),
    ["false", "true", "false"],
  );
  assert.equal(allSeries.attributes.get("aria-pressed"), "false");
  assert.equal(points[0]!.attributes.get("tabindex"), "-1");
  assert.equal(userPoint.attributes.get("tabindex"), "0");
  userPoint.onfocus!();
  assert.deepEqual(
    legend.querySelectorAll(".usage-legend-value").map((el) => el.textContent),
    ["—", "200", "—"],
  );
  legendItems[0]!.onclick!();
  assert.deepEqual(
    groups.map((el) => el.attributes.get("display")),
    ["inline", "none", "none"],
  );
  legendItems[0]!.onclick!();
  assert.ok(groups.every((el) => el.attributes.get("display") === "inline"));
  assert.ok(points.every((el) => el.attributes.get("tabindex") === "0"));
  legendItems[1]!.onclick!();
  allSeries.onclick!();
  assert.ok(groups.every((el) => el.attributes.get("display") === "inline"));
  legendItems[1]!.onclick!();
  assert.equal(observedCharts.size, 6);
  resizeCharts([{ target: chartHost, contentRect: { width: 1600 } }]);
  const wideSvg = userChart.querySelector("svg")!;
  assert.equal(wideSvg.attributes.get("viewBox"), "0 0 1600 240");
  assert.ok(wideSvg.querySelectorAll("text").every((el) => el.attributes.get("font-size") === "12"));
  assert.ok(Number(wideSvg.querySelectorAll(".usage-plot-point").at(-1)!.attributes.get("cx")) > 1400);
  assert.deepEqual(
    wideSvg.querySelectorAll(".usage-plot-series").map((el) => el.attributes.get("display")),
    ["none", "inline", "none"],
  );
  const widePoint = wideSvg
    .querySelectorAll(".usage-plot-point")
    .find((el) => el.attributes.get("aria-label")?.includes("User <1>"))!;
  wideSvg.onpointermove!({
    clientX: Number(widePoint.attributes.get("cx")) + 100,
    clientY: Number(widePoint.attributes.get("cy")) + 50,
  });
  assert.ok(userChart.querySelector(".usage-legend-head")!.children[0]!.textContent.includes("User <1>: 200"));
  resizeCharts([{ target: chartHost, contentRect: { width: 400 } }]);
  const narrowSvg = userChart.querySelector("svg")!;
  assert.equal(narrowSvg.attributes.get("viewBox"), "0 0 400 240");
  assert.ok(narrowSvg.querySelectorAll("text").every((el) => el.attributes.get("font-size") === "12"));
  assert.ok(narrowSvg.querySelectorAll("text").length < wideSvg.querySelectorAll("text").length);
  assert.ok(narrowSvg.querySelectorAll(".usage-plot-point").every((el) => Number(el.attributes.get("cx")) <= 376));
  resizeCharts([{ target: chartHost, contentRect: { width: 0 } }]);
  assert.equal(userChart.querySelector("svg"), narrowSvg);
  const costChart = nodes(root).find(
    (el) => el.attributes.get("aria-label") === "总览 · 已知参考费用 USD" && el.tag === "section",
  )!;
  const costPoint = costChart.querySelector(".usage-plot-point")!;
  costPoint.onfocus!();
  assert.ok(nodes(costChart.querySelector(".usage-legend")!).some((el) => el.textContent === "$0.00"));
  const dateFields = nodes(root).filter(
    (el) => el.tag === "label" && ["开始日期", "结束日期"].includes(el.children[0]?.textContent ?? ""),
  );
  assert.ok(dateFields.every((el) => el.hidden));
  const rangeSelect = nodes(root).find((el) => el.tag === "label" && el.children[0]?.textContent === "日期范围")!
    .children[1]!;
  rangeSelect.value = "custom";
  rangeSelect.onchange!();
  assert.ok(dateFields.every((el) => !el.hidden));
  rangeSelect.value = "7";
  rangeSelect.onchange!();
  await new Promise(setImmediate);
  assert.ok(dateFields.every((el) => el.hidden));
  const reloadedUserChart = nodes(root).find(
    (el) => el.tag === "section" && el.attributes.get("aria-label") === "用户 · 已知 Token",
  )!;
  assert.deepEqual(
    reloadedUserChart.querySelectorAll(".usage-plot-series").map((el) => el.attributes.get("display")),
    ["none", "inline", "none"],
  );
  nodes(root).find((element) => element.tag === "button" && element.textContent === "刷新")!.onclick!();
  await new Promise(setImmediate);
  assert.equal(checks().length, 2);
  assert.equal(checks()[0]!.checked, true);
  scheduled();
  await new Promise(setImmediate);
  assert.equal(checks().length, 3);
  assert.equal(checks()[0]!.checked, true);
  users().children[1]!.onclick!();
  assert.equal(users().children[2]!.hidden, false);
  users().children[2]!.children[1]!.onclick!();
  await new Promise(setImmediate);
  assert.ok(checks().every((c) => !c.checked));
  assert.equal(users().children[1]!.children[0]!.textContent, "全部");
  metrics.samples = 10000;
  metrics.knownCost = 1;
  scheduled();
  await new Promise(setImmediate);
  assert.ok(nodes(root).some((el) => el.textContent === "覆盖率 <1% · 不完整"));
  metrics.knownCost = 9999;
  scheduled();
  await new Promise(setImmediate);
  assert.ok(nodes(root).some((el) => el.textContent === "覆盖率 >99% · 不完整"));
  metrics.unknownCalls = 1;
  scheduled();
  await new Promise(setImmediate);
  for (const title of ["时间趋势", "维度排行（最多 200 项）"]) {
    const section = nodes(root).find(
      (el) => el.tag === "section" && el.children.some((child) => child.tag === "h3" && child.textContent === title),
    )!;
    const cells = section.querySelector("tbody")!.children[0]!.children;
    assert.equal(cells[4]!.textContent, "未知");
  }
  const pricingPanel = nodes(root).find(
    (el) => el.tag === "details" && el.children[0]?.textContent === "参考价格配置",
  )!;
  pricingPanel.open = true;
  pricingPanel.ontoggle!();
  await new Promise(setImmediate);
  assert.ok(nodes(root).some((el) => el.textContent === "历史未知费用补估"));
  const labelInput = (title: string) =>
    nodes(root).find((el) => el.tag === "label" && el.children[0]?.textContent === title)!.children[1]!;
  const chooser = labelInput("选择价格配置");
  chooser.value = Array.from(chooser.options).find((o) => o.textContent === "proxy / custom")!.value;
  chooser.onchange!();
  nodes(root).find((el) => el.tag === "button" && el.textContent === "保存新价格版本")!.onclick!();
  await new Promise(setImmediate);
  assert.equal(savedPriceBody?.provider, "proxy");
  assert.equal(savedPriceBody?.model, "custom");
  assert.equal(savedPriceBody?.rates.input, 2);
  assert.ok(Array.from(labelInput("补估价格版本").options).some((o) => o.value === "price-after"));
  const panelSections = () =>
    nodes(root).filter((el) => el.tag === "section" && el.attributes.get("aria-label")?.includes(" · "));
  assert.equal(panelSections().length, 6);
  assert.ok(panelSections().some((el) => el.attributes.get("aria-label") === "用户 · 已知 Token"));
  const move = nodes(root).find((el) => el.attributes.get("aria-label") === "上移面板: 用户 · 已知 Token")!;
  move.onclick!();
  nodes(root).find((el) => el.tag === "button" && el.textContent === "保存个人布局")!.onclick!();
  await new Promise(setImmediate);
  assert.equal(savedLayout!.panels[0]!.dimension, "user");
  assert.equal(savedLayout!.expectedUpdatedAt, 0);
  nodes(root).find((el) => el.attributes.get("aria-label") === "移除面板: 用户 · 已知 Token")!.onclick!();
  assert.equal(panelSections().length, 5);
  nodes(root).find((el) => el.tag === "button" && el.textContent === "重新加载布局")!.onclick!();
  await new Promise(setImmediate);
  assert.equal(panelSections().length, 6);
  assert.equal(panelSections()[0]!.attributes.get("aria-label"), "用户 · 已知 Token");
  dashboard.destroy();
  assert.equal(observedCharts.size, 0);
  assert.ok(chartDisconnects > 1);
  resizeCharts([{ target: chartHost, contentRect: { width: 1000 } }]);
  assert.equal(chartHost.querySelector("svg"), narrowSvg);
});

test("usage charts preserve missing periods, unknown cost and partial natural weeks", () => {
  const m = {
    samples: 2,
    knownTokens: 0,
    knownCost: 0,
    calls: 0,
    unknownCalls: 1,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
  };
  assert.equal(usageMetric(m, "tokens"), null);
  assert.equal(usageMetric(m, "costUsd"), null);
  assert.equal(usageMetric(m, "calls"), null);
  assert.equal(usageMetric({ ...m, knownCost: 2 }, "costUsd"), 0);
  const rows = usagePeriods("2026-10-05", "2026-10-07", "day", [
    { period: "2026-10-05", metrics: m },
    { period: "2026-10-07", metrics: m },
  ]);
  assert.equal(rows[1]!.metrics, null);
  assert.equal(rows[2]!.period, "2026-10-07");
  assert.deepEqual(
    usagePeriods("2026-10-06", "2026-10-13", "week", []).map((r) => [r.period, r.partial]),
    [
      ["2026-10-05", true],
      ["2026-10-12", true],
    ],
  );
});

test("usage proxies signed requests and denies manager-only principals", async () => {
  assert.equal((await fetch(`${base}/api/usage`)).status, 401);
  const path = "/api/usage/details?start=2026-10-01&end=2026-10-07&department=parent&user=a&user=b";
  assert.equal((await fetch(base + path, { headers: { cookie: "admin=admin" } })).status, 200);
  assert.equal(received, path.replace("/api/", "/v1/admin/"));
  for (const mode of ["pricing", "cost-preview", "cost-confirm", "layout"]) {
    assert.equal(
      (
        await fetch(`${base}/api/usage/${mode}`, {
          method: "POST",
          headers: { cookie: "admin=admin", "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      200,
    );
    assert.equal(received, `/v1/admin/usage/${mode}`);
  }
  manager = true;
  assert.equal((await fetch(`${base}/api/usage/export`, { headers: { cookie: "admin=manager" } })).status, 403);
  assert.equal(
    (
      await fetch(`${base}/api/usage/cost-confirm`, {
        method: "POST",
        headers: { cookie: "admin=manager", "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    403,
  );
  manager = false;
});

test("usage bundle is embedded in the existing hashed script and navigation", async () => {
  const response = await fetch(base + "/?view=usage");
  const html = await response.text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/i)![1]!;
  assert.ok(!script.includes('"USAGE_DASHBOARD_BUNDLE"'));
  assert.match(script, /function mountUsageDashboard/);
  assert.ok(script.includes(mountUsageDashboard.toString()));
  assert.match(script, /views: \["usage", "history"/);
  const hash = createHash("sha256").update(script).digest("base64");
  assert.ok(response.headers.get("content-security-policy")!.includes(`'sha256-${hash}'`));
  new Function(script);
});

test("admin shared labels render current Project names, duplicate identifiers and unknown fallbacks", async () => {
  const html = await (await fetch(base + "/?view=usage")).text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/i)![1]!;
  const helpers = script.slice(script.indexOf("function projectIdFromScope"), script.indexOf("function usageDate"));
  const labels = script.slice(script.indexOf("function dirLabel"), script.indexOf("function scopeCell"));
  const label = new Function("scopeDir", "scopeKind", "adminTr", `${helpers}\n${labels}\nreturn shortName;`)(
    [
      { scopeId: "group:web-project-aaaaaaaa-1", label: "Launch" },
      { scopeId: "group:web-project-bbbbbbbb-2", label: "Launch" },
      { scopeId: "group:web-project-current", label: "Renamed Project" },
    ],
    (id: string) => id.split(":")[0],
    (text: string) => text,
  );
  assert.equal(label("group:web-project-current"), "Renamed Project");
  assert.equal(label("group:web-project-aaaaaaaa-1"), "Launch · aaaaaaaa");
  assert.equal(label("group:web-project-missing"), "Unknown Project · missing");
});

test("admin routing retains usage dates, granularity and repeated filters on reload", async () => {
  const html = await (await fetch(base + "/?view=usage")).text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/i)![1]!;
  const routing = script.slice(script.indexOf("function stateToUrl"), script.indexOf("let transcriptObserver"));
  const canonicalize = new Function(
    "API_BASE",
    "DEFAULT_VIEW",
    "VIEWS",
    "SCOPED",
    "location",
    "scope",
    "orgId",
    `${routing}\nreturn stateToUrl(urlToState());`,
  );
  const input = new URL(
    "http://localhost/admin/usage?start=2026-09-01&end=2026-09-30&range=custom&granularity=month&dimension=department&user=a&user=b&department=parent",
  );
  const output = new URL(
    canonicalize("/admin", "history", ["usage", "history"], new Set(), input, "org:acme", "acme"),
    input,
  );
  assert.equal(output.pathname, "/admin/usage");
  assert.deepEqual([...output.searchParams], [...input.searchParams]);
});
