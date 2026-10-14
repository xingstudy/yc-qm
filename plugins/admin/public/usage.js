import { projectDisplayName } from "../../chassis/src/project-label.js";

export function usageDate(at = Date.now()) {
  return new Date(at + 8 * 3600000).toISOString().slice(0, 10);
}

export function usageRange(preset, now = Date.now()) {
  const today = usageDate(now);
  const at = Date.parse(`${today}T00:00:00+08:00`);
  if (preset === "today") return { start: today, end: today };
  if (preset === "7" || preset === "30") return { start: usageDate(at - (Number(preset) - 1) * 86400000), end: today };
  const month = today.slice(0, 7) + "-01";
  if (preset === "month") return { start: month, end: today };
  const lastEnd = usageDate(Date.parse(`${month}T00:00:00+08:00`) - 1);
  return { start: lastEnd.slice(0, 7) + "-01", end: lastEnd };
}

export function usageAutoRefresh({ visible, active, enabled, end }, now = Date.now()) {
  return visible && active && enabled && end >= usageDate(now);
}

export function usageMetric(metrics, key) {
  if (!metrics) return null;
  if (["tokens", "input", "output", "cacheRead", "cacheWrite"].includes(key) && metrics.samples && !metrics.knownTokens)
    return null;
  if (key === "costUsd" && metrics.samples && !metrics.knownCost) return null;
  if (key === "calls" && metrics.unknownCalls && !metrics.calls) return null;
  return key === "tokens" ? metrics.input + metrics.output + metrics.cacheRead + metrics.cacheWrite : metrics[key];
}

export function usagePeriods(start, end, granularity, series) {
  const at = Date.parse(`${start}T00:00:00+08:00`);
  const date = new Date(at + 8 * 3600000);
  if (granularity === "week") date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  if (granularity === "month") date.setUTCDate(1);
  const rows = new Map(series.map((row) => [row.period, row.metrics]));
  const result = [];
  while (date.toISOString().slice(0, 10) <= end && result.length < 1201) {
    const period = date.toISOString().slice(0, 10);
    const next = new Date(date);
    if (granularity === "month") next.setUTCMonth(next.getUTCMonth() + 1);
    else next.setUTCDate(next.getUTCDate() + (granularity === "week" ? 7 : 1));
    result.push({
      period,
      metrics: rows.get(period) ?? null,
      partial: period < start || new Date(next.getTime() - 86400000).toISOString().slice(0, 10) > end,
    });
    date.setTime(next.getTime());
  }
  return result;
}

export function mountUsageDashboard(root, { base = "", locale = "zh-CN" } = {}) {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  const zh = locale === "zh-CN";
  const tr = (cn, en) => (zh ? cn : en);
  const node = (tag, text, className) => {
    const el = doc.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  const number = (value) =>
    value == null ? tr("未知", "Unknown") : Number(value).toLocaleString(locale, { maximumFractionDigits: 2 });
  const label = (key) =>
    ({
      human: tr("人工请求", "Human"),
      automation: tr("自动任务", "Automation"),
      system: tr("系统辅助", "System"),
      history: tr("历史回填", "Historical"),
      organization: tr("组织凭据", "Organization"),
      personal: tr("个人凭据", "Personal"),
      subscription: tr("订阅授权", "Subscription"),
      unknown: tr("未知", "Unknown"),
      success: tr("成功", "Success"),
      failed: tr("失败", "Failed"),
      cancelled: tr("取消", "Cancelled"),
      pending: tr("待完成", "Pending"),
      sdk: tr("SDK 返回", "SDK"),
      estimate: tr("估算", "Estimate"),
      call: tr("单次调用", "Call"),
      turn: tr("任务汇总", "Turn aggregate"),
      suspended: tr("已停用", "Suspended"),
      deprovisioned: tr("已离职", "Deprovisioned"),
      archived: tr("已归档", "Archived"),
      deleted: tr("已删除", "Deleted"),
    })[key] ?? key;
  const objectName = (name, status) =>
    `${name}${status && status !== "active" && status !== "unknown" ? ` (${label(status)})` : ""}`;
  const facetName = (key, item) => {
    let name =
      key === "project" && item.id
        ? projectDisplayName(item.id, item.name, tr("名称未知 Project", "Unknown Project"))
        : label(item.name || item.id) || tr("未分配", "Unassigned");
    if (key === "project" && (facets?.project ?? []).filter((row) => row.name === item.name).length > 1)
      name += ` · ${item.id.slice(0, 8)}`;
    return objectName(name, item.status);
  };
  let destroyed = false;
  let controller;
  let sequence = 0;
  let timer;
  let failures = 0;
  let lastLoad = 0;
  let offset = 0;
  let showDetails = false;
  let facets = null;
  let lastReport;
  let lastDetails;
  let openFilter;
  let filterCleanup = [];
  const defaultPanels = () =>
    ["total", "user", "project", "department", "model", "total"].map((dimension, index) => ({
      id: `default-${index}`,
      dimension,
      metric: index === 5 ? "costUsd" : "tokens",
      visual: index === 0 || index === 5 ? "area" : "line",
      width: "half",
    }));
  let panels = defaultPanels();
  let panelData = {};
  const seriesSelections = new Map();
  const chartRenderers = new Map();
  const chartObserver = win.ResizeObserver
    ? new win.ResizeObserver((entries) => {
        for (const entry of entries) chartRenderers.get(entry.target)?.(entry.contentRect.width);
      })
    : null;
  let panelErrors = false;
  let panelRevision = 0;
  let layoutVersion = 0;
  let layoutReady = false;
  let layoutBusy = false;
  let layoutDirty = false;
  let layoutController;
  let layoutMessage = "";
  let editorOpen;
  const defaults = usageRange("7");
  const params = new URL(win.location.href).searchParams;
  const state = {
    start: params.get("start") ?? defaults.start,
    end: params.get("end") ?? defaults.end,
    granularity: params.get("granularity") ?? "day",
    dimension: params.get("dimension") ?? "user",
    rankBy: params.get("rankBy") ?? "tokens",
    enabled: true,
  };
  const filters = {};
  for (const key of ["user", "project", "department", "model", "source", "auth"]) filters[key] = params.getAll(key);
  root.replaceChildren();
  root.classList.add("usage-dashboard");
  const style = node("style");
  style.textContent = `
    body[data-subview=usage] #app-view #main .admin-inner{max-width:none}
    .usage-dashboard{display:grid;grid-template-columns:minmax(0,1fr);min-width:0;gap:14px;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;font-size:13px;line-height:1.5;--usage-blue:#497cf6;--usage-green:#18a889;--usage-purple:#9365e8}
    .usage-dashboard .card{padding:22px;margin:0;min-width:0;overflow-wrap:anywhere}.usage-dashboard h2,.usage-dashboard h3{margin:0;font-size:16px}
    .usage-dashboard [hidden]{display:none!important}
    .usage-toolbar,.usage-chart-head,.usage-actions,.usage-tabs{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
    .usage-toolbar{justify-content:space-between}.usage-fields{display:flex;flex-wrap:wrap;gap:10px;align-items:end;margin:10px 0}
    .usage-field{display:flex;flex-direction:column;gap:6px;min-width:140px;font-size:12px;color:var(--muted,#64748b)}
    .usage-field select,.usage-field input{min-height:38px;width:100%;max-width:100%;min-width:0}.usage-filter{position:relative;min-width:150px;flex:1}
    .usage-filter-trigger{display:flex;justify-content:space-between;width:100%;min-height:38px;gap:12px;text-align:left}
    .usage-filter-menu{position:absolute;z-index:30;top:100%;margin-top:6px;width:300px;max-width:85vw;padding:12px;background:var(--panel,#fff);border:1px solid var(--border,#dbe2ea);border-radius:12px;box-shadow:0 12px 32px #0002}
    .usage-filter-menu[hidden]{display:none}.usage-filter-menu input[type=search]{width:100%;margin-bottom:10px}
    .usage-filter-options{max-height:240px;overflow:auto;display:grid;gap:2px}.usage-option{display:flex;align-items:center;gap:9px;padding:8px;border-radius:6px;cursor:pointer;color:var(--text,#1e293b);font-size:13px}
    .usage-option:hover{background:var(--hover,#f1f5f9)}.usage-option input{width:16px;min-height:16px}
    .usage-chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}.usage-chips button{font-size:12px;max-width:100%;overflow-wrap:anywhere}
    .usage-kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}.usage-kpi{padding:16px;border:1px solid var(--border,#dbe2ea);border-radius:10px;background:var(--panel,#fff)}
    .usage-kpi-label,.usage-muted{color:var(--muted,#64748b);font-size:12px}.usage-kpi-number{font-size:28px;font-weight:650;margin:10px 0;overflow-wrap:anywhere}.usage-kpi-change{font-size:12px}
    .usage-status{font-size:12px;color:var(--muted,#64748b);line-height:1.7;margin:0}.usage-status-list{display:flex;flex-wrap:wrap;gap:8px 20px}
    .usage-charts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.usage-chart-head{justify-content:space-between;margin-bottom:8px}.usage-chart-container{min-width:0}.usage-chart{width:100%;height:240px;display:block;overflow:visible}.usage-dashboard .usage-charts>.card{padding:14px}.usage-charts h3{font-size:14px;line-height:20px}.usage-panel-settings{font-size:12px}
    .usage-panel-full{grid-column:1/-1}.usage-panel-settings{margin-bottom:4px}.usage-panel-settings .usage-field{flex:1;min-width:100px}.usage-panel-settings .usage-fields{margin:8px 0}.usage-dashboard .usage-panel-settings>summary{color:var(--muted,#64748b);margin:4px 0;font-size:11px}.usage-chart-head>.usage-panel-settings:not([open]){margin:0;margin-left:auto;order:1}.usage-chart-head>.usage-panel-tools{order:2}.usage-chart-head>.usage-panel-settings[open]{flex-basis:100%;order:3}
    .usage-panel-tools{display:flex;flex-wrap:wrap;align-items:center;gap:6px}.usage-panel-tools button{padding:4px 8px;font-size:12px}.usage-layout-controls{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}.usage-layout-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
    .usage-layout-add{border:1px solid var(--border,#dbe2ea);border-radius:10px;padding:0 12px}.usage-layout-add .usage-fields{padding:4px 0}.usage-layout-add[open]{width:100%}
    .usage-filter-fold{margin:0}.usage-filter-fold>summary{font-weight:550}.usage-dashboard .usage-filter-fold>summary{margin:8px 0}.usage-filter-grid{display:flex;flex-wrap:wrap;gap:10px;align-items:end;padding:8px 0}.usage-dashboard .usage-field input,.usage-dashboard .usage-field select{min-height:34px}.usage-dashboard .usage-chips:empty{display:none}.usage-chips{margin-top:6px}.usage-context{padding:0 4px}.usage-context p{margin:6px 0}.usage-dashboard .usage-context>summary{margin:0;font-size:12px}
    .usage-legend{display:flex;flex-wrap:wrap;align-items:center;gap:2px 12px;font-size:13px;margin:4px 0}.usage-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
    .usage-legend-head{display:flex;align-items:center;min-height:22px;font-size:12px;line-height:18px;color:var(--muted,#64748b)}.usage-legend-head>span{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#app-view #main .usage-dashboard :is(.usage-legend-item,.usage-legend-all){display:inline-flex;align-items:center;gap:6px;min-height:26px;max-width:100%;width:auto;text-align:left;padding:3px 0;border:0;box-shadow:none;background:transparent;color:var(--text,#1e293b);font-size:13px;font-weight:400;line-height:20px;border-radius:3px}.usage-legend-item[aria-pressed=false]{opacity:.4}#app-view #main .usage-dashboard .usage-legend-item:hover,#app-view #main .usage-dashboard .usage-legend-item:focus-visible{background:var(--hover,#f1f5f9)}#app-view #main .usage-dashboard .usage-legend-item[data-active=true]{font-weight:600}.usage-legend-item .usage-dot{flex-shrink:0;width:12px;height:3px;border-radius:1px;margin:0}.usage-legend-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.usage-legend-value,.usage-legend-coverage{display:none}#app-view #main .usage-dashboard .usage-legend-all{color:var(--muted,#64748b);margin-left:auto}
    .usage-plot-point:focus{outline:none;stroke:var(--text,#1e293b);stroke-width:3}.usage-chart-note{font-size:12px;min-height:22px;line-height:1.7;color:var(--muted,#64748b)}
    .usage-tabs{margin-bottom:18px}.usage-tabs button[aria-pressed=true]{background:var(--usage-blue);color:#fff;border-color:var(--usage-blue)}
    .usage-rank{display:grid;gap:12px;margin:20px 0}.usage-rank-row{display:grid;grid-template-columns:minmax(100px,220px) 1fr minmax(50px,100px);gap:14px;align-items:center;border:0;background:transparent;text-align:left;width:100%;padding:4px}
    .usage-rank-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.usage-rank-track{height:10px;background:var(--hover,#f0f3f9);border-radius:6px;overflow:hidden}.usage-rank-bar{display:block;height:100%;background:var(--usage-blue);border-radius:6px}.usage-rank-value{text-align:right;font-variant-numeric:tabular-nums}
    .usage-dashboard details>summary{cursor:pointer;font-size:13px;margin:12px 0}.usage-price-grid{display:flex;flex-wrap:wrap;gap:12px;margin-top:16px}.usage-price-grid .usage-field{flex:1 1 150px;min-width:150px;max-width:100%}.usage-price-grid input{min-height:38px}
    @media(max-width:1100px){.usage-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}}
    @media(max-width:1200px){.usage-charts{grid-template-columns:minmax(0,1fr)}}
    @media(max-width:760px){.usage-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.usage-dashboard .card{padding:16px}.usage-rank-row{grid-template-columns:120px 1fr 70px}}
  `;
  root.append(style);
  const controls = node("section", undefined, "card");
  controls.style.padding = "18px";
  const heading = node("h2", tr("使用量报表", "Usage report"));
  const form = node("div");
  form.className = "usage-fields";
  const field = (title, input) => {
    const wrap = node("label", undefined, "usage-field");
    wrap.append(node("span", title), input);
    form.append(wrap);
    return wrap;
  };
  const select = (items, value) => {
    const el = node("select");
    el.dataset.usageNative = "true";
    for (const [id, name] of items) {
      const option = node("option", name);
      option.value = id;
      el.append(option);
    }
    el.value = value;
    return el;
  };
  const requestedPreset = params.get("range");
  const savedRange = ["7", "today", "30", "month", "lastMonth"].includes(requestedPreset)
    ? usageRange(requestedPreset)
    : null;
  let presetValue = params.has("start") ? "custom" : "7";
  if (savedRange && savedRange.start === state.start && savedRange.end === state.end) presetValue = requestedPreset;
  const preset = select(
    [
      ["7", tr("最近 7 天", "Last 7 days")],
      ["today", tr("今天", "Today")],
      ["30", tr("最近 30 天", "Last 30 days")],
      ["month", tr("本月", "This month")],
      ["lastMonth", tr("上月", "Last month")],
      ["custom", tr("自定义", "Custom")],
    ],
    presetValue,
  );
  field(tr("日期范围", "Date range"), preset);
  const start = node("input");
  start.type = "date";
  start.value = state.start;
  const end = node("input");
  end.type = "date";
  end.value = state.end;
  const startField = field(tr("开始日期", "From"), start);
  const endField = field(tr("结束日期", "To"), end);
  const dateVisibility = () => {
    startField.hidden = endField.hidden = preset.value !== "custom";
  };
  dateVisibility();
  const granularity = select(
    [
      ["day", tr("按天", "Day")],
      ["week", tr("按周", "Week")],
      ["month", tr("按月", "Month")],
    ],
    state.granularity,
  );
  field(tr("汇总粒度", "Granularity"), granularity);
  const dimension = select(
    [
      ["user", tr("用户", "User")],
      ["project", "Project"],
      ["department", tr("部门", "Department")],
      ["model", tr("模型", "Model")],
      ["source", tr("任务来源", "Source")],
      ["auth", tr("授权分类", "Authorization")],
    ],
    state.dimension,
  );
  const auto = node("input");
  auto.type = "checkbox";
  auto.checked = true;
  const autoLabel = node("label", undefined, "usage-status");
  autoLabel.append(auto, node("span", tr(" 每 5 分钟自动刷新", " Auto-refresh every 5 min")));
  const refresh = node("button", tr("刷新", "Refresh"));
  refresh.type = "button";
  form.append(refresh);
  const filterWrap = node("div");
  filterWrap.className = "usage-filter-grid";
  const filterFold = node("details", undefined, "usage-filter-fold");
  const filterSummary = node("summary", tr("筛选 · 全部", "Filters · All"));
  filterFold.append(filterSummary, filterWrap);
  filterFold.ontoggle = () => {
    if (!filterFold.open) openFilter?.close();
  };
  const message = node("p", tr("正在加载…", "Loading…"));
  const chips = node("div", undefined, "usage-chips");
  message.className = "usage-status";
  message.setAttribute("role", "status");
  const results = node("div");
  results.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr);gap:20px;min-width:0";
  const exportSummary = node("button", tr("导出汇总 CSV", "Export summary CSV"));
  const exportDetails = node("button", tr("导出明细 CSV", "Export details CSV"));
  const actions = node("div");
  actions.className = "usage-actions";
  actions.append(exportSummary, exportDetails);
  const toolbar = node("div", undefined, "usage-toolbar");
  const exports = node("details");
  exports.append(node("summary", tr("导出", "Export")), actions);
  toolbar.append(heading, autoLabel, exports);
  controls.append(toolbar, form, filterFold, chips, message);
  const pricingPanel = node("details", undefined, "card");
  pricingPanel.append(node("summary", tr("参考价格配置", "Reference pricing")));
  const pricingContent = node("div");
  pricingPanel.append(pricingContent);
  let priceVersions = null;
  let priceLoading = false;
  let priceController;
  pricingPanel.ontoggle = () => {
    if (pricingPanel.open && !priceVersions && !priceLoading) loadPrices();
  };
  root.append(controls, results, pricingPanel);

  function query() {
    const q = new URLSearchParams({
      start: state.start,
      end: state.end,
      granularity: state.granularity,
      dimension: state.dimension,
      rankBy: state.rankBy,
    });
    for (const [key, values] of Object.entries(filters)) for (const value of values) q.append(key, value);
    return q;
  }
  function save() {
    const url = new URL(win.location.href);
    for (const key of ["start", "end", "granularity", "dimension", "rankBy", ...Object.keys(filters)])
      url.searchParams.delete(key);
    for (const [key, value] of query()) url.searchParams.append(key, value);
    url.searchParams.set("range", preset.value);
    win.history.replaceState(win.history.state, "", url);
  }
  async function request(path, signal) {
    const response = await win.fetch(`${base}/api/usage${path}`, { credentials: "same-origin", signal });
    if (!response.ok) {
      const body = await response.json();
      throw new Error(body.message ?? `${response.status}`);
    }
    return response.json();
  }
  async function loadPrices() {
    if (destroyed || priceLoading) return;
    priceLoading = true;
    priceController = new win.AbortController();
    pricingContent.replaceChildren(node("p", tr("正在加载价格…", "Loading prices…")));
    try {
      const data = await request("/pricing", priceController.signal);
      if (destroyed) return;
      priceVersions = data.versions;
      drawPrices();
    } catch (error) {
      if (!destroyed) {
        const retry = node("button", tr("重试", "Retry"));
        retry.onclick = loadPrices;
        pricingContent.replaceChildren(
          node("p", `${tr("价格加载失败", "Price loading failed")}: ${error.message}`),
          retry,
        );
      }
    } finally {
      priceLoading = false;
    }
  }
  function drawPrices() {
    pricingContent.replaceChildren();
    pricingContent.append(
      node(
        "p",
        tr(
          "单价单位：USD / 百万 Token。空白表示未知，0 表示明确为零。保存仅影响生效后的新使用量，历史金额保持原口径。",
          "Rates in USD per million tokens. Blank means unknown; 0 means explicitly zero. Changes apply to new usage from the effective time; historical amounts stay unchanged.",
        ),
        "usage-status",
      ),
    );
    const editor = node("div", undefined, "usage-price-grid");
    const priceField = (title, input) => {
      const wrap = node("label", undefined, "usage-field");
      wrap.append(node("span", title), input);
      editor.append(wrap);
    };
    const choices = new Map();
    for (const price of priceVersions) {
      const key = JSON.stringify([price.provider, price.model]);
      const old = choices.get(key);
      if (!old || (old.effectiveAt > Date.now() && price.effectiveAt <= Date.now())) choices.set(key, price);
    }
    const chooser = select(
      [
        ["", tr("新增 / 自定义价格", "New / custom price")],
        ...[...choices].map(([key, p]) => [key, `${p.provider} / ${p.model}`]),
      ],
      "",
    );
    priceField(tr("选择价格配置", "Choose a price"), chooser);
    const provider = node("input");
    const model = node("input");
    provider.placeholder = "openai";
    model.placeholder = "gpt-5.6-terra";
    priceField(tr("供应商 ID", "Provider ID"), provider);
    priceField(tr("模型 ID", "Model ID"), model);
    const inputs = {};
    for (const [key, title] of [
      ["input", tr("输入单价", "Input rate")],
      ["output", tr("输出单价", "Output rate")],
      ["cacheRead", tr("缓存读取单价", "Cache read rate")],
      ["cacheWrite", tr("缓存写入单价", "Cache write rate")],
      ["cacheWrite1h", tr("一小时缓存写入单价", "1h cache write rate")],
      ["fastMultiplier", tr("快速模式倍率", "Fast multiplier")],
    ]) {
      const input = node("input");
      input.type = "number";
      input.min = "0";
      input.step = "any";
      inputs[key] = input;
      priceField(title, input);
    }
    const effective = node("input");
    effective.type = "datetime-local";
    priceField(tr("生效时间（北京时间，留空为现在）", "Effective time (Beijing; blank means now)"), effective);
    const tiers = node("div");
    const tierRows = [];
    const tierSection = node("details");
    tierSection.append(node("summary", tr("长上下文价格档位（可选）", "Long-context price tiers (optional)")), tiers);
    const addTier = (value = {}) => {
      const row = node("div", undefined, "usage-price-grid");
      const fields = {};
      for (const [key, title] of [
        ["inputTokensAbove", tr("上下文超过 Token 数", "Context tokens above")],
        ["input", tr("输入单价", "Input rate")],
        ["output", tr("输出单价", "Output rate")],
        ["cacheRead", tr("缓存读取单价", "Cache read rate")],
        ["cacheWrite", tr("缓存写入单价", "Cache write rate")],
        ["cacheWrite1h", tr("一小时缓存写入单价", "1h cache write rate")],
      ]) {
        const field = node("label", undefined, "usage-field");
        const input = node("input");
        input.type = "number";
        input.min = "0";
        input.step = key === "inputTokensAbove" ? "1" : "any";
        input.value = String(value[key] ?? "");
        fields[key] = input;
        field.append(node("span", title), input);
        row.append(field);
      }
      const item = { row, fields };
      const remove = node("button", tr("删除档位", "Remove tier"));
      remove.onclick = () => {
        tierRows.splice(tierRows.indexOf(item), 1);
        row.remove();
      };
      row.append(remove);
      tiers.append(row);
      tierRows.push(item);
    };
    const addTierButton = node("button", tr("添加档位", "Add tier"));
    addTierButton.onclick = () => {
      if (tierRows.length < 20) addTier();
    };
    tierSection.append(addTierButton);
    const source = node("p", undefined, "usage-status");
    chooser.onchange = () => {
      const price = choices.get(chooser.value);
      if (!price) return;
      provider.value = price.provider;
      model.value = price.model;
      for (const [key, input] of Object.entries(inputs))
        input.value = String((key === "fastMultiplier" ? price.fastMultiplier : price.rates[key]) ?? "");
      tiers.replaceChildren();
      tierRows.length = 0;
      price.tiers.forEach(addTier);
      effective.value = "";
      source.replaceChildren(
        node(
          "span",
          `${price.source === "official" ? tr("官方默认", "Official default") : tr("管理员自定义", "Administrator override")} · ${tr("核对日期", "Checked")} ${price.checkedAt || "—"} · ${tr("版本", "Version")} ${price.id} `,
        ),
      );
      if (price.sourceUrl) {
        const link = node("a", tr("查看定价来源", "View price source"));
        link.href = price.sourceUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        source.append(link);
      }
    };
    const feedback = node("p", undefined, "usage-status");
    const backfillHost = node("div");
    feedback.setAttribute("role", "status");
    const savePrice = node("button", tr("保存新价格版本", "Save new price version"));
    const restore = node("button", tr("恢复官方默认价", "Restore official default"));
    const refreshPrices = node("button", tr("刷新价格列表", "Refresh price list"));
    refreshPrices.onclick = loadPrices;
    const submit = async (reset) => {
      const buttons = [savePrice, restore, refreshPrices];
      buttons.forEach((b) => {
        b.disabled = true;
      });
      try {
        const rates = Object.fromEntries(
          Object.entries(inputs)
            .filter(([key]) => key !== "fastMultiplier")
            .map(([key, input]) => [key, input.value === "" ? null : Number(input.value)]),
        );
        const body = {
          provider: provider.value.trim(),
          model: model.value.trim(),
          restore: reset,
          rates,
          fastMultiplier: inputs.fastMultiplier.value === "" ? null : Number(inputs.fastMultiplier.value),
          tiers: reset
            ? []
            : tierRows.map(({ fields }) =>
                Object.fromEntries(
                  Object.entries(fields).map(([key, input]) => [key, input.value === "" ? null : Number(input.value)]),
                ),
              ),
          ...(effective.value ? { effectiveAt: Date.parse(`${effective.value}:00+08:00`) } : {}),
        };
        const response = await win.fetch(`${base}/api/usage/pricing`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: priceController.signal,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message ?? data.error ?? String(response.status));
        if (destroyed) return;
        priceVersions.unshift(data.price);
        backfillHost.replaceChildren();
        drawCostBackfill(backfillHost);
        choices.set(JSON.stringify([data.price.provider, data.price.model]), data.price);
        const priceKey = JSON.stringify([data.price.provider, data.price.model]);
        if (![...chooser.options].some((option) => option.value === priceKey)) {
          const option = node("option", `${data.price.provider} / ${data.price.model}`);
          option.value = priceKey;
          chooser.append(option);
        }
        feedback.textContent = tr(
          "已保存新版本。可在下方预览并补估历史未知费用；已有金额保持不变。",
          "New version saved. Preview and estimate unknown historical costs below; existing amounts are unchanged.",
        );
        const item = node(
          "li",
          `${data.price.provider} / ${data.price.model} · ${tr("新版本", "New version")} ${data.price.id}`,
        );
        history.prepend(item);
      } catch (error) {
        if (!destroyed) feedback.textContent = `${tr("保存失败", "Save failed")}: ${error.message}`;
      } finally {
        if (!destroyed)
          buttons.forEach((b) => {
            b.disabled = false;
          });
      }
    };
    savePrice.onclick = () => submit(false);
    restore.onclick = () => submit(true);
    const buttons = node("div", undefined, "usage-actions");
    buttons.append(savePrice, restore, refreshPrices);
    const history = node("ul", undefined, "usage-status");
    for (const p of priceVersions.slice(0, 30))
      history.append(
        node(
          "li",
          `${p.provider} / ${p.model} · ${p.source === "official" ? tr("官方默认", "Official") : tr("自定义", "Custom")} · ${tr("生效", "Effective")} ${new Date(p.effectiveAt).toLocaleString(locale, { timeZone: "Asia/Shanghai" })} · ${p.id}`,
        ),
      );
    const historyPanel = node("details");
    historyPanel.append(node("summary", tr("最近价格版本（最多 30 条）", "Latest price versions (up to 30)")), history);
    pricingContent.append(editor, tierSection, source, buttons, feedback, historyPanel);
    pricingContent.append(backfillHost);
    drawCostBackfill(backfillHost);
  }
  function drawCostBackfill(parent) {
    const section = node("section");
    section.append(node("h3", tr("历史未知费用补估", "Estimate unknown historical costs")));
    section.append(
      node(
        "p",
        tr(
          "选择适用于该历史范围的价格版本。仅补费用未知且模型身份、Token 和服务条件明确的记录；已有金额保持不变。预览有效期 15 分钟，单次最多 10000 条未知记录。",
          "Choose a price version applicable to this historical range. Only unknown costs with known model identity, tokens and service conditions can be estimated; existing amounts stay unchanged. Previews expire in 15 minutes and cover up to 10,000 unknown records.",
        ),
        "usage-status",
      ),
    );
    const form = node("div", undefined, "usage-price-grid");
    const add = (title, input) => {
      const field = node("label", undefined, "usage-field");
      field.append(node("span", title), input);
      form.append(field);
    };
    const model = select(
      (facets?.model ?? []).filter((m) => m.id).map((m) => [m.id, m.name]),
      "",
    );
    add(tr("历史记录中的模型", "Model in historical records"), model);
    const price = select(
      priceVersions.map((p) => [
        p.id,
        `${p.provider} / ${p.model} · ${new Date(p.effectiveAt).toLocaleString(locale, { timeZone: "Asia/Shanghai" })} · ${p.id}`,
      ]),
      "",
    );
    add(tr("补估价格版本", "Price version for estimation"), price);
    const from = node("input");
    from.type = "date";
    from.value = state.start;
    const to = node("input");
    to.type = "date";
    to.value = state.end;
    add(tr("补估开始日期", "Estimation from"), from);
    add(tr("补估结束日期", "Estimation to"), to);
    const previewButton = node("button", tr("预览历史补估", "Preview historical estimate"));
    const confirmButton = node("button", tr("确认补估未知费用", "Confirm unknown cost estimation"));
    confirmButton.disabled = true;
    const output = node("div");
    output.setAttribute("role", "status");
    let currentPreview;
    const invalidate = () => {
      currentPreview = undefined;
      confirmButton.disabled = true;
      output.replaceChildren();
    };
    const fields = [model, price, from, to];
    fields.forEach((f) => {
      f.onchange = invalidate;
      f.oninput = invalidate;
    });
    const submit = async (confirm) => {
      const snapshot = currentPreview;
      if (confirm && !snapshot) return;
      [previewButton, confirmButton, ...fields].forEach((f) => {
        f.disabled = true;
      });
      try {
        const response = await win.fetch(`${base}/api/usage/${confirm ? "cost-confirm" : "cost-preview"}`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            confirm
              ? { previewId: snapshot.id }
              : { model: model.value, priceId: price.value, start: from.value, end: to.value },
          ),
          signal: priceController.signal,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message ?? data.error ?? String(response.status));
        if (destroyed) return;
        const p = data.preview;
        currentPreview = confirm ? undefined : p;
        output.replaceChildren(
          node("p", `${p.model} · ${p.start} — ${p.end} · ${tr("价格版本", "Price version")} ${p.price.id}`),
          node(
            "p",
            `${tr("可补估", "Eligible")}: ${number(p.eligible)} · ${tr("新增参考成本 USD", "Additional reference cost USD")}: ${money(p.costUsd)} · ${tr("已有费用保留", "Known costs retained")}: ${number(p.known)}`,
          ),
          node(
            "p",
            `${tr("仍不可补估", "Still unavailable")}: ${number(p.unknown - p.eligible)} (${tr("未完成", "Pending")} ${number(p.pending)} · ${tr("模型身份不明确或不匹配", "Unknown or mismatched model identity")} ${number(p.missingIdentity)} · ${tr("服务条件未知", "Unknown service conditions")} ${number(p.missingConditions)} · ${tr("Token 或适用单价不足", "Insufficient tokens or rates")} ${number(p.missingTokensOrRates)})`,
          ),
          node(
            "p",
            confirm
              ? tr(
                  "历史补估已保存，汇总完成后趋势和覆盖率将更新。",
                  "Historical estimate saved; trends and coverage will update after aggregation.",
                )
              : tr(
                  "请核对适用价格及范围后确认。未确认不会修改历史。",
                  "Verify the price and date range before confirming. Previewing does not modify history.",
                ),
          ),
        );
        if (confirm) load();
      } catch (error) {
        if (!destroyed) {
          currentPreview = undefined;
          output.replaceChildren(node("p", error.message));
        }
      } finally {
        if (!destroyed) {
          [previewButton, ...fields].forEach((f) => {
            f.disabled = false;
          });
          confirmButton.disabled = !currentPreview?.eligible;
        }
      }
    };
    previewButton.onclick = () => submit(false);
    confirmButton.onclick = () => submit(true);
    const buttons = node("div", undefined, "usage-actions");
    buttons.append(previewButton, confirmButton);
    section.append(form, buttons, output);
    parent.append(section);
  }
  function table(title, headers, rows) {
    const section = node("section", undefined, "card");
    section.style.padding = "18px";
    section.append(node("h3", title));
    const wrap = node("div", undefined, "tablewrap");
    const table = node("table");
    const head = node("tr");
    for (const name of headers) head.append(node("th", name));
    const thead = node("thead");
    thead.append(head);
    table.append(thead);
    const body = node("tbody");
    for (const cells of rows) {
      const row = node("tr");
      for (const cell of cells) row.append(node("td", String(cell ?? tr("未知", "Unknown"))));
      body.append(row);
    }
    table.append(body);
    wrap.append(table);
    section.append(wrap);
    if (!rows.length)
      section.append(
        node(
          "p",
          tr(
            "该范围内没有已汇总的使用记录；请检查数据覆盖状态。",
            "No aggregated records in this range. Check coverage status.",
          ),
        ),
      );
    results.append(section);
    return section;
  }
  const tokens = (m) => number(m.samples && !m.knownTokens ? null : m.input + m.output + m.cacheRead + m.cacheWrite);
  const calls = (m) => number(usageMetric(m, "calls"));
  const money = (value) =>
    value == null
      ? number(null)
      : Number(value).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  const cost = (m) => money(m.samples && !m.knownCost ? null : m.costUsd);
  const compact = (value) =>
    value == null
      ? tr("未知", "Unknown")
      : Number(value).toLocaleString(locale, { notation: "compact", maximumFractionDigits: 1 });
  const metricLabel = (key) =>
    ({
      requests: tr("用户请求", "Requests"),
      calls: tr("已知模型调用", "Known model calls"),
      activeUsers: tr("活跃用户", "Active users"),
      tokens: tr("已知 Token", "Known tokens"),
      input: tr("输入 Token", "Input tokens"),
      output: tr("输出 Token", "Output tokens"),
      cacheRead: tr("缓存读取", "Cache read"),
      cacheWrite: tr("缓存写入", "Cache write"),
      costUsd: tr("已知参考费用 USD", "Known reference USD"),
    })[key];
  const coverage = (metrics, key) => {
    if (!metrics) return tr("无汇总记录", "No aggregate record");
    if (key === "calls" && metrics.unknownCalls) return tr("调用计量不完整", "Incomplete call measurement");
    const known = key === "costUsd" ? metrics.knownCost : metrics.knownTokens;
    if (["tokens", "input", "output", "cacheRead", "cacheWrite", "costUsd"].includes(key) && metrics.samples) {
      const ratio = known / metrics.samples;
      let percent = `${Math.round(ratio * 100)}%`;
      if (ratio > 0 && ratio < 0.01) percent = "<1%";
      if (ratio > 0.99 && ratio < 1) percent = ">99%";
      return `${tr("覆盖率", "Coverage")} ${percent}${known < metrics.samples ? ` · ${tr("不完整", "Incomplete")}` : ""}`;
    }
    return "";
  };
  function chart(rows, keys, title, options = {}) {
    const host = node("div", undefined, "usage-chart-container");
    let currentWidth = 600;
    const render = (width) => host.replaceChildren(...chartContent(rows, keys, title, { ...options, width }));
    render(currentWidth);
    if (chartObserver) {
      chartRenderers.set(host, (width) => {
        const nextWidth = Math.max(240, Math.round(width));
        if (nextWidth === currentWidth || width <= 0 || destroyed) return;
        currentWidth = nextWidth;
        render(currentWidth);
      });
      chartObserver.observe(host);
    }
    return [host];
  }
  function chartContent(rows, keys, title, options) {
    const rowMetrics = (row, key) => (options.grouped ? (row.groups.get(key) ?? null) : row.metrics);
    const valueAt = (row, key) => usageMetric(rowMetrics(row, key), options.metric ?? key);
    const seriesLabel = (key) => options.names?.get(key) ?? metricLabel(key);
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    const width = options.width;
    const height = 240;
    const left = 64;
    const right = width - 24;
    const top = 24;
    const bottom = height - 36;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("class", "usage-chart");
    svg.setAttribute("role", "group");
    svg.setAttribute("aria-label", title);
    const make = (tag, attrs, text, parent = svg) => {
      const el = doc.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
      if (text !== undefined) el.textContent = text;
      parent.append(el);
      return el;
    };
    const note = node(
      "p",
      tr(
        "点击下方名称只显示该曲线，再次点击恢复全部。悬停或聚焦数据点，在下方查看周期数值；空白表示无汇总记录或计量未知。",
        "Click a name below to isolate its series; click again to show all. Hover or focus a point for period values below. Gaps indicate missing or unknown measurements.",
      ),
      "usage-chart-note",
    );
    if (rows.length > 1200)
      return [
        node(
          "p",
          tr("周期过多，请缩小日期范围查看趋势图。", "Too many periods; narrow the date range to view the chart."),
        ),
        note,
      ];
    const observedMax = Math.max(0, ...rows.flatMap((r) => keys.map((key) => valueAt(r, key) ?? 0)));
    const max = observedMax || 1;
    const first = Date.parse(rows[0]?.period ?? state.start);
    const last = Date.parse(rows.at(-1)?.period ?? state.end);
    const x = (r) =>
      last === first ? (left + right) / 2 : left + ((Date.parse(r.period) - first) / (last - first)) * (right - left);
    const y = (value) => bottom - (value / max) * (bottom - top);
    for (let i = 0; i <= 4; i++) {
      const value = (max * i) / 4;
      make("line", { x1: left, x2: right, y1: y(value), y2: y(value), stroke: "currentColor", opacity: 0.1 });
      make(
        "text",
        { x: left - 10, y: y(value) + 4, "text-anchor": "end", fill: "currentColor", opacity: 0.7, "font-size": 12 },
        (options.metric ?? keys[0]) === "costUsd"
          ? `$${value.toLocaleString(locale, { maximumSignificantDigits: 3 })}`
          : compact(value),
      );
    }
    const tickCount = Math.min(8, Math.max(2, Math.floor((right - left) / 110) + 1));
    const ticks = new Set(
      Array.from({ length: tickCount }, (_, index) => Math.round(((rows.length - 1) * index) / (tickCount - 1))),
    );
    for (const i of ticks)
      if (rows[i])
        make(
          "text",
          {
            x: x(rows[i]),
            y: height - 12,
            "text-anchor": "middle",
            fill: "currentColor",
            opacity: 0.7,
            "font-size": 12,
          },
          rows[i].period.slice(5),
        );
    const colors = ["#497cf6", "#18a889", "#9365e8", "#e5a43c", "#e86880"];
    const legend = node("div", undefined, "usage-legend");
    legend.setAttribute("role", "group");
    legend.setAttribute("aria-label", `${tr("图例与周期数据", "Legend and period values")}: ${title}`);
    const legendHead = node("div", undefined, "usage-legend-head");
    const caption = node("span");
    const all = node("button", tr("显示全部", "Show all"));
    all.className = "usage-legend-all";
    all.setAttribute("aria-label", `${tr("显示全部曲线", "Show all series")}: ${title}`);
    legendHead.append(caption);
    const selectionId = options.selectionId;
    let isolatedKey = seriesSelections.get(selectionId) ?? null;
    if (!keys.includes(isolatedKey)) {
      isolatedKey = null;
      seriesSelections.delete(selectionId);
    }
    const visible = (key) => isolatedKey === null || isolatedKey === key;
    const legendItems = [];
    const seriesGroups = [];
    const pointElements = [];
    const lineElements = [];
    let crosshair;
    let selection = "";
    const hide = () => {
      caption.textContent =
        isolatedKey === null
          ? tr("悬停查看数值 · 点击图例单独查看", "Hover for values · click a legend to isolate")
          : `${tr("仅显示", "Only showing")} ${seriesLabel(isolatedKey)} · ${tr("悬停查看周期数值", "Hover for period values")}`;
      caption.title = caption.textContent;
      caption.setAttribute("aria-label", caption.textContent);
      for (const { item, value, detail } of legendItems) {
        value.textContent = "—";
        detail.textContent = "";
        item.setAttribute("data-active", "false");
      }
      if (crosshair) crosshair.setAttribute("visibility", "hidden");
      for (const { element } of pointElements) element.setAttribute("r", "3.5");
      for (const element of lineElements) element.setAttribute("opacity", "1");
      selection = "";
    };
    const nearestRow = (px) => {
      let rowIndex = 0;
      for (let i = 1; i < rows.length; i++)
        if (Math.abs(x(rows[i]) - px) < Math.abs(x(rows[rowIndex]) - px)) rowIndex = i;
      return rowIndex;
    };
    const show = (rowIndex, activeKey = null) => {
      const row = rows[rowIndex];
      if (!row || !keys.length || (activeKey !== null && !visible(activeKey))) return;
      const next = JSON.stringify([rowIndex, activeKey]);
      if (next === selection) return;
      selection = next;
      caption.textContent = `${row.period}${row.partial ? ` · ${tr("不完整周期", "Partial period")}` : ""}`;
      legendItems.forEach(({ key, item, value: valueNode, detail }) => {
        item.setAttribute("data-active", String(key === activeKey));
        if (!visible(key)) {
          valueNode.textContent = "—";
          detail.textContent = "";
          return;
        }
        const value = valueAt(row, key);
        valueNode.textContent =
          (options.metric ?? key) === "costUsd" && value !== null ? `$${money(value)}` : number(value);
        detail.textContent = coverage(rowMetrics(row, key), options.metric ?? key);
      });
      const summaryKeys = activeKey !== null ? [activeKey] : keys.filter(visible);
      const summary = summaryKeys.map((key) => {
        const value = valueAt(row, key);
        const formatted = (options.metric ?? key) === "costUsd" && value !== null ? `$${money(value)}` : number(value);
        return `${seriesLabel(key)}: ${formatted}${coverage(rowMetrics(row, key), options.metric ?? key) ? ` · ${coverage(rowMetrics(row, key), options.metric ?? key)}` : ""}`;
      });
      caption.textContent += ` · ${summary.join("；")}`;
      caption.title = caption.textContent;
      caption.setAttribute("aria-label", caption.textContent);
      crosshair.setAttribute("x1", String(x(row)));
      crosshair.setAttribute("x2", String(x(row)));
      crosshair.setAttribute("visibility", "visible");
      for (const { element, rowIndex: index, key } of pointElements) {
        let radius = "3.5";
        if (index === rowIndex) radius = key === activeKey ? "6" : "4.5";
        element.setAttribute("r", radius);
      }
      lineElements.forEach((element, index) =>
        element.setAttribute("opacity", activeKey === null || keys[index] === activeKey ? "1" : "0.35"),
      );
    };
    const isolate = (key) => {
      isolatedKey = key === isolatedKey ? null : key;
      if (selectionId) {
        if (isolatedKey === null) seriesSelections.delete(selectionId);
        else seriesSelections.set(selectionId, isolatedKey);
      }
      seriesGroups.forEach(({ key, group }) => {
        group.setAttribute("display", visible(key) ? "inline" : "none");
        group.setAttribute("aria-hidden", String(!visible(key)));
      });
      for (const { element, key } of pointElements) element.setAttribute("tabindex", visible(key) ? "0" : "-1");
      for (const { item, key } of legendItems) item.setAttribute("aria-pressed", String(visible(key)));
      all.setAttribute("aria-pressed", String(isolatedKey === null));
      hide();
    };
    all.onclick = () => isolate(null);
    keys.forEach((key, index) => {
      const color = colors[index % colors.length];
      const item = node("button", undefined, "usage-legend-item");
      item.setAttribute("aria-label", `${tr("单独查看曲线", "Isolate series")}: ${seriesLabel(key)}`);
      item.title = `${seriesLabel(key)}${options.grouped && key ? ` · ${key}` : ""} · ${tr("点击只显示该曲线，再次点击恢复全部", "Click to isolate this series; click again to show all")}`;
      const dot = node("span", undefined, "usage-dot");
      dot.style.background = color;
      const value = node("span", "—", "usage-legend-value");
      const detail = node("span", "", "usage-legend-coverage");
      item.append(dot, node("span", seriesLabel(key), "usage-legend-name"), value, detail);
      item.onclick = () => isolate(key);
      legend.append(item);
      legendItems.push({ key, item, value, detail });
      const group = make("g", { class: "usage-plot-series", "data-series": key });
      seriesGroups.push({ key, group });
      const makeSeries = (tag, attrs) => make(tag, attrs, undefined, group);
      let d = "";
      let segment = false;
      const segments = [];
      let points = [];
      for (const row of rows) {
        const value = valueAt(row, key);
        if (value === null) {
          segment = false;
          if (points.length) segments.push(points);
          points = [];
          continue;
        }
        d += `${segment ? "L" : "M"}${x(row).toFixed(2)},${y(value).toFixed(2)} `;
        points.push([x(row), y(value)]);
        segment = true;
      }
      if (points.length) segments.push(points);
      if (options.visual === "area")
        for (const part of segments)
          makeSeries("path", {
            d: `M${part[0][0]},${bottom} ${part.map(([px, py]) => `L${px},${py}`).join(" ")} L${part.at(-1)[0]},${bottom} Z`,
            fill: color,
            opacity: 0.1,
          });
      lineElements.push(
        makeSeries("path", { d, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round" }),
      );
      const hitLine = makeSeries("path", {
        d,
        fill: "none",
        stroke: "transparent",
        "stroke-width": 14,
        "pointer-events": "stroke",
        class: "usage-plot-hit-line",
      });
      hitLine.onpointermove = (event) => {
        const bounds = svg.getBoundingClientRect();
        if (!bounds.width) return;
        event.stopPropagation();
        show(nearestRow(((event.clientX - bounds.left) / bounds.width) * width), key);
      };
      for (const [rowIndex, row] of rows.entries()) {
        const value = valueAt(row, key);
        if (value === null) continue;
        const text = `${row.period}${row.partial ? ` · ${tr("不完整周期", "Partial period")}` : ""} · ${seriesLabel(key)}: ${(options.metric ?? key) === "costUsd" ? money(value) : number(value)} ${coverage(rowMetrics(row, key), options.metric ?? key)}`;
        const point = makeSeries("circle", {
          cx: x(row),
          cy: y(value),
          r: 3.5,
          fill: color,
          tabindex: 0,
          class: "usage-plot-point",
          "aria-label": text,
        });
        pointElements.push({ element: point, rowIndex, key });
        point.onfocus = () => show(rowIndex, key);
        point.onpointermove = (event) => {
          event.stopPropagation();
          show(rowIndex, key);
        };
      }
    });
    if (keys.length > 1) legend.append(all);
    crosshair = make("line", {
      x1: left,
      x2: left,
      y1: top,
      y2: bottom,
      stroke: "currentColor",
      opacity: 0.4,
      "stroke-dasharray": "4 4",
      visibility: "hidden",
      "pointer-events": "none",
    });
    const initialKey = isolatedKey;
    isolatedKey = null;
    isolate(initialKey);
    svg.onpointermove = (event) => {
      const bounds = svg.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const px = ((event.clientX - bounds.left) / bounds.width) * width;
      const py = ((event.clientY - bounds.top) / bounds.height) * height;
      if (px < left || px > right || py < top - 6 || py > bottom + 6) return hide();
      const rowIndex = nearestRow(px);
      let activeKey = null;
      let distance = 12;
      for (const key of keys) {
        if (!visible(key)) continue;
        const value = rows[rowIndex] && valueAt(rows[rowIndex], key);
        if (value == null) continue;
        const candidate = Math.abs(y(value) - py);
        if (candidate < distance) {
          distance = candidate;
          activeKey = key;
        }
      }
      show(rowIndex, activeKey);
    };
    svg.onpointerleave = () => {
      if (!svg.contains(doc.activeElement)) hide();
    };
    svg.onfocusout = (event) => {
      if (!svg.contains(event.relatedTarget)) hide();
    };
    svg.onkeydown = (event) => {
      if (event.key === "Escape") hide();
    };
    if (!rows.some((r) => keys.some((key) => valueAt(r, key) !== null)))
      make(
        "text",
        {
          x: (left + right) / 2,
          y: (top + bottom) / 2,
          "text-anchor": "middle",
          fill: "currentColor",
          opacity: 0.7,
          "font-size": 14,
        },
        tr("没有可绘制的已知数据", "No known data to plot"),
      );
    return [svg, legend, legendHead];
  }
  const dimensionLabel = (key) =>
    key === "total" ? tr("总览", "Overview") : Array.from(dimension.options).find((o) => o.value === key)?.textContent;
  const panelTitle = (panel) => `${dimensionLabel(panel.dimension)} · ${metricLabel(panel.metric)}`;
  function markLayout() {
    layoutDirty = true;
    layoutMessage = tr(
      "布局已修改，点击保存个人布局后永久保留。",
      "Layout changed. Save your personal layout to keep it.",
    );
    panelRevision++;
  }
  async function loadLayout() {
    if (layoutBusy) return;
    layoutBusy = true;
    layoutController = new win.AbortController();
    try {
      const record = await request("/layout", layoutController.signal);
      if (destroyed) return;
      if (Array.isArray(record.value?.panels)) panels = record.value.panels;
      layoutVersion = record.updatedAt ?? 0;
      layoutDirty = false;
      layoutReady = true;
      layoutMessage = tr("个人布局已加载", "Personal layout loaded");
      panelRevision++;
    } catch (error) {
      if (!destroyed)
        layoutMessage = `${tr("个人布局加载失败，正在显示默认视图", "Personal layout unavailable; showing the default view")}: ${error.message}`;
    } finally {
      layoutBusy = false;
      if (!destroyed) load();
    }
  }
  async function saveLayout() {
    if (layoutBusy || !layoutReady) return;
    layoutBusy = true;
    layoutController = new win.AbortController();
    const revision = panelRevision;
    try {
      const response = await win.fetch(`${base}/api/usage/layout`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ panels, expectedUpdatedAt: layoutVersion }),
        signal: layoutController.signal,
      });
      const record = await response.json();
      if (!response.ok) throw new Error(record.message ?? record.error ?? String(response.status));
      if (destroyed) return;
      layoutVersion = record.updatedAt;
      layoutDirty = revision !== panelRevision;
      layoutMessage = tr("个人布局已保存，重载页面后仍保留。", "Personal layout saved and retained after reloading.");
    } catch (error) {
      if (!destroyed) layoutMessage = `${tr("布局未保存", "Layout not saved")}: ${error.message}`;
    } finally {
      layoutBusy = false;
      if (!destroyed && lastReport) draw(lastReport, lastDetails);
    }
  }
  function panelFields(parent, value, update) {
    const fields = node("div", undefined, "usage-fields");
    for (const [key, title, choices] of [
      [
        "dimension",
        tr("面板维度", "Panel dimension"),
        ["total", "user", "project", "department", "model", "source", "auth"].map((key) => [key, dimensionLabel(key)]),
      ],
      [
        "metric",
        tr("面板指标", "Panel metric"),
        ["tokens", "costUsd", "calls", "requests", "activeUsers"].map((key) => [key, metricLabel(key)]),
      ],
      [
        "visual",
        tr("展示方式", "Visualization"),
        [
          ["line", tr("折线趋势", "Line trend")],
          ["area", tr("面积趋势", "Area trend")],
          ...(value.dimension === "total" ? [] : [["bars", tr("横向排行", "Bar ranking")]]),
        ],
      ],
      [
        "width",
        tr("面板宽度", "Panel width"),
        [
          ["half", tr("半行", "Half row")],
          ["full", tr("整行", "Full row")],
        ],
      ],
    ]) {
      const field = node("label", undefined, "usage-field");
      const input = select(choices, value[key]);
      input.onchange = () => update({ [key]: input.value });
      field.append(node("span", title), input);
      fields.append(field);
    }
    parent.append(fields);
  }
  function drawPanels() {
    const toolbar = node("div", undefined, "usage-layout-controls");
    const actions = node("div", undefined, "usage-layout-actions");
    const saveButton = node("button", tr("保存个人布局", "Save personal layout"));
    saveButton.disabled = layoutBusy || !layoutReady || !layoutDirty;
    saveButton.onclick = saveLayout;
    const reload = node("button", tr("重新加载布局", "Reload layout"));
    reload.disabled = layoutBusy;
    reload.onclick = loadLayout;
    const reset = node("button", tr("恢复默认面板", "Reset panels"));
    reset.onclick = () => {
      panels = defaultPanels();
      markLayout();
      load();
    };
    actions.append(saveButton, reload, reset);
    toolbar.append(node("h3", tr("我的看板", "My dashboard")), actions);
    const add = node("details", undefined, "usage-layout-add");
    add.append(node("summary", tr("添加面板", "Add panel")));
    const draft = { dimension: "model", metric: "tokens", visual: "line", width: "half" };
    const form = node("div");
    const editDraft = (patch) => {
      Object.assign(draft, patch);
      if (draft.dimension === "total" && draft.visual === "bars") draft.visual = "line";
      form.replaceChildren();
      panelFields(form, draft, editDraft);
    };
    panelFields(form, draft, editDraft);
    const addButton = node("button", tr("添加到看板", "Add to dashboard"));
    addButton.disabled = panels.length >= 8;
    addButton.onclick = () => {
      if (panels.length >= 8) return;
      panels.push({ id: `panel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...draft });
      markLayout();
      load();
    };
    add.append(
      form,
      addButton,
      node(
        "p",
        tr("最多 8 个面板，全部继承顶部日期与筛选。", "Up to 8 panels, sharing the date range and filters above."),
        "usage-status",
      ),
    );
    toolbar.append(add);
    results.append(toolbar, node("p", layoutMessage, "usage-status"));
    const grid = node("div", undefined, "usage-charts");
    for (const [index, panel] of panels.entries()) {
      const section = node("section", undefined, `card${panel.width === "full" ? " usage-panel-full" : ""}`);
      section.setAttribute("aria-label", panelTitle(panel));
      const head = node("div", undefined, "usage-chart-head");
      const tools = node("div", undefined, "usage-panel-tools");
      for (const [text, title, delta] of [
        ["↑", tr("上移面板", "Move panel up"), -1],
        ["↓", tr("下移面板", "Move panel down"), 1],
      ]) {
        const button = node("button", text);
        button.setAttribute("aria-label", `${title}: ${panelTitle(panel)}`);
        button.disabled = index + delta < 0 || index + delta >= panels.length;
        button.onclick = () => {
          [panels[index], panels[index + delta]] = [panels[index + delta], panels[index]];
          markLayout();
          draw(lastReport, lastDetails);
        };
        tools.append(button);
      }
      const remove = node("button", "×");
      remove.setAttribute("aria-label", `${tr("移除面板", "Remove panel")}: ${panelTitle(panel)}`);
      remove.onclick = () => {
        panels = panels.filter((p) => p.id !== panel.id);
        markLayout();
        draw(lastReport, lastDetails);
      };
      tools.append(remove);
      head.append(node("h3", panelTitle(panel)), tools);
      section.append(head);
      const settings = node("details", undefined, "usage-panel-settings");
      settings.open = editorOpen === panel.id;
      settings.ontoggle = () => {
        if (settings.open) editorOpen = panel.id;
        else if (editorOpen === panel.id) editorOpen = undefined;
      };
      settings.append(node("summary", tr("设置面板", "Configure panel")));
      panelFields(settings, panel, (patch) => {
        Object.assign(panel, patch);
        if (panel.dimension === "total" && panel.visual === "bars") panel.visual = "line";
        editorOpen = panel.id;
        markLayout();
        if ("dimension" in patch || "metric" in patch) load();
        else draw(lastReport, lastDetails);
      });
      settings.append(
        node(
          "p",
          tr(
            "点击图例名称只显示该曲线，再次点击恢复全部。悬停或聚焦数据点查看周期数值；空白表示无汇总记录或计量未知。",
            "Click a legend name to isolate its series; click again to show all. Hover or focus a point for period values; gaps indicate missing or unknown measurements.",
          ),
          "usage-chart-note",
        ),
      );
      head.append(settings);
      const groups = panelData[`${panel.dimension}:${panel.metric}`];
      if (panel.dimension !== "total" && (panelErrors || !groups)) {
        section.append(
          node(
            "p",
            tr("维度趋势暂未加载，点击刷新重试。", "Dimension data unavailable. Refresh to retry."),
            "usage-status",
          ),
        );
      } else if (panel.visual === "bars") {
        const bars = node("div", undefined, "usage-rank");
        const max = Math.max(1, ...groups.map((g) => usageMetric(g.metrics, panel.metric) ?? 0));
        for (const group of groups) {
          const value = usageMetric(group.metrics, panel.metric);
          const button = node("button", undefined, "usage-rank-row");
          const track = node("span", undefined, "usage-rank-track");
          const fill = node("span", undefined, "usage-rank-bar");
          fill.style.width = `${((value ?? 0) / max) * 100}%`;
          track.append(fill);
          const name = objectName(label(group.name || group.id) || tr("未分配", "Unassigned"), group.status);
          button.append(node("span", name, "usage-rank-name"), track, node("span", compact(value), "usage-rank-value"));
          button.title = `${name} · ${number(value)} ${coverage(group.metrics, panel.metric)}`;
          button.onclick = () => {
            filters[panel.dimension] = [group.id];
            offset = 0;
            save();
            drawFilters();
            load();
          };
          bars.append(button);
        }
        section.append(bars);
      } else {
        const rows = usagePeriods(state.start, state.end, state.granularity, lastReport.series);
        if (panel.dimension === "total") {
          section.append(
            ...chart(rows, [panel.metric], panelTitle(panel), {
              visual: panel.visual,
              selectionId: `${panel.id}:${panel.dimension}:${panel.metric}`,
            }),
          );
        } else {
          const series = groups.map((g) => new Map(g.series.map((p) => [p.period, p.metrics])));
          for (const row of rows) row.groups = new Map(groups.map((g, i) => [g.id, series[i].get(row.period)]));
          section.append(
            ...chart(
              rows,
              groups.map((g) => g.id),
              panelTitle(panel),
              {
                grouped: true,
                selectionId: `${panel.id}:${panel.dimension}:${panel.metric}`,
                metric: panel.metric,
                visual: panel.visual,
                names: new Map(
                  groups.map((g) => [g.id, objectName(label(g.name || g.id) || tr("未分配", "Unassigned"), g.status)]),
                ),
              },
            ),
          );
        }
      }
      if (panel.dimension !== "total")
        settings.append(
          node(
            "p",
            tr(
              "按当前范围和指标取前 5 项；各曲线对应同一对象，未计量的周期保留缺口。",
              "Top 5 for this range and metric. Each series is one object; missing measurements remain gaps.",
            ),
            "usage-chart-note",
          ),
        );
      grid.append(section);
    }
    results.append(grid);
  }
  function fold(section, title) {
    const details = node("details");
    details.append(node("summary", title), section);
    results.append(details);
    return details;
  }
  function draw(report, details) {
    lastReport = report;
    lastDetails = details;
    chartObserver?.disconnect();
    chartRenderers.clear();
    results.replaceChildren();
    const total = report.total;
    const status = report.status;
    const time = status.updatedAt
      ? new Date(status.updatedAt).toLocaleString(locale, { timeZone: "Asia/Shanghai" })
      : tr("尚未汇总", "Not aggregated yet");
    message.textContent = `${tr("统计更新于", "Updated")} ${time} · ${tr("待汇总", "Pending")} ${status.pending} · ${tr("未完整计量", "Incomplete measurements")} ${status.unresolved} · ${tr("北京时间；费用为参考金额", "Asia/Shanghai; costs are reference amounts")}`;
    const cards = node("div", undefined, "usage-kpis");
    cards.style.margin = "0";
    for (const key of ["activeUsers", "requests", "calls", "tokens", "costUsd"]) {
      const value = usageMetric(total, key),
        previous = usageMetric(report.previous, key);
      const card = node("div", undefined, "usage-kpi");
      const complete =
        (key !== "tokens" ||
          (total.knownTokens === total.samples && report.previous.knownTokens === report.previous.samples)) &&
        (key !== "costUsd" ||
          (total.knownCost === total.samples && report.previous.knownCost === report.previous.samples)) &&
        (key !== "calls" || (!total.unknownCalls && !report.previous.unknownCalls));
      let change = tr("上期对比数据不完整", "Incomplete comparison");
      if (complete && value !== null && previous !== null) {
        change = tr("上期无有效基数", "No previous baseline");
        if (previous !== 0)
          change = `${value >= previous ? "+" : ""}${(((value - previous) / previous) * 100).toFixed(1)}% ${tr("较上期", "vs previous period")}`;
      }
      const display = node(
        "div",
        key === "costUsd" && value !== null ? `$${money(value)}` : compact(value),
        "usage-kpi-number",
      );
      display.title = number(value);
      card.append(
        node("div", metricLabel(key), "usage-kpi-label"),
        display,
        node("div", change, "usage-kpi-change"),
        node("div", coverage(total, key), "usage-muted"),
      );
      cards.append(card);
    }
    results.append(cards);
    const context = node("details", undefined, "usage-context");
    context.append(
      node("summary", tr("数据说明 · 参考费用与计量覆盖", "Data notes · reference costs and measurement coverage")),
    );
    context.append(
      node(
        "p",
        `${tr("人工请求", "Human requests")}: ${tr("成功", "Success")} ${total.success} · ${tr("失败", "Failed")} ${total.failed} · ${tr("取消", "Cancelled")} ${total.cancelled} · ${tr("未完成请求及计量", "Pending requests and measurements")} ${total.pending}`,
      ),
    );
    context.append(
      node(
        "p",
        tr(
          "费用为 SDK 金额或参考单价估算；订阅估算不代表额外付款。未知不等于零。",
          "Costs are SDK amounts or reference estimates; subscription estimates are not extra payments. Unknown does not mean zero.",
        ),
      ),
    );
    const first = status.firstAt ? usageDate(status.firstAt) : tr("尚无记录", "No records yet");
    context.append(
      node(
        "p",
        `${tr("最早可用记录", "First available record")}: ${first} · ${tr("未知调用次数记录", "Records with unknown call counts")}: ${total.unknownCalls} · ${tr("历史回填只覆盖仍可恢复的记录，缺失不等于零。", "Backfill covers recoverable history only; missing does not mean zero.")}`,
      ),
    );
    results.append(context);
    const p = report.previous;
    const compare = (value, prev) =>
      prev === 0 ? tr("无有效基数", "No baseline") : `${(((value - prev) / prev) * 100).toFixed(1)}%`;
    drawPanels();
    const comparison = table(
      tr("上期对比", "Previous period"),
      [tr("指标", "Metric"), tr("当前", "Current"), tr("上期", "Previous"), tr("变化", "Change")],
      [
        [tr("用户请求", "Requests"), number(total.requests), number(p.requests), compare(total.requests, p.requests)],
        [
          tr("活跃用户", "Active users"),
          number(total.activeUsers),
          number(p.activeUsers),
          compare(total.activeUsers, p.activeUsers),
        ],
        [
          tr("已知 Token", "Known tokens"),
          tokens(total),
          tokens(p),
          total.knownTokens < total.samples || p.knownTokens < p.samples
            ? tr("数据不完整", "Incomplete")
            : compare(
                total.input + total.output + total.cacheRead + total.cacheWrite,
                p.input + p.output + p.cacheRead + p.cacheWrite,
              ),
        ],
        [
          tr("参考费用 USD", "Reference USD"),
          cost(total),
          cost(p),
          total.knownCost < total.samples || p.knownCost < p.samples
            ? tr("数据不完整", "Incomplete")
            : compare(total.costUsd, p.costUsd),
        ],
      ],
    );
    fold(comparison, tr("查看上期对比报表", "View previous-period report"));
    const trendTable = table(
      tr("时间趋势", "Trend"),
      [
        tr("周期起日", "Period start"),
        tr("范围", "Range"),
        tr("请求", "Requests"),
        tr("活跃用户", "Active users"),
        tr("已知模型调用", "Known model calls"),
        "Token",
        "USD",
      ],
      report.series.map((item) => {
        const day = item.period;
        let periodEnd = Date.parse(`${day}T00:00:00+08:00`);
        if (state.granularity === "week") periodEnd += 6 * 86400000;
        if (state.granularity === "month") {
          const [year, month] = day.split("-").map(Number);
          periodEnd = Date.UTC(year, month, 1) - 8 * 3600000 - 86400000;
        }
        const partial = day < state.start || usageDate(periodEnd) > state.end;
        return [
          day,
          partial ? tr("不完整周期", "Partial period") : tr("完整周期", "Full period"),
          number(item.metrics.requests),
          number(item.metrics.activeUsers),
          calls(item.metrics),
          tokens(item.metrics),
          cost(item.metrics),
        ];
      }),
    );
    fold(trendTable, tr("查看周期数据报表", "View period data report"));
    const rankHeader = node("div", undefined, "usage-toolbar");
    const tabs = node("div", undefined, "usage-tabs");
    tabs.setAttribute("aria-label", tr("排行维度", "Breakdown dimension"));
    for (const option of dimension.options) {
      const button = node("button", option.textContent);
      button.setAttribute("aria-pressed", String(state.dimension === option.value));
      button.onclick = () => {
        state.dimension = option.value;
        dimension.value = option.value;
        save();
        load();
      };
      tabs.append(button);
    }
    const rankBy = select(
      ["tokens", "calls", "requests", "costUsd"].map((key) => [key, metricLabel(key)]),
      state.rankBy,
    );
    rankBy.setAttribute("aria-label", tr("排行指标", "Ranking metric"));
    rankBy.onchange = () => {
      state.rankBy = rankBy.value;
      save();
      load();
    };
    rankHeader.append(tabs, rankBy);
    const rank = table(
      tr("维度排行（最多 200 项）", "Breakdown (up to 200)"),
      [
        tr("名称", "Name"),
        tr("请求", "Requests"),
        tr("活跃用户", "Active users"),
        tr("已知模型调用", "Known model calls"),
        "Token",
        "USD",
      ],
      report.breakdown.map((item) => [
        objectName(label(item.name || item.id) || tr("系统 / 未分配", "System / unassigned"), item.status),
        number(item.metrics.requests),
        number(item.metrics.activeUsers),
        calls(item.metrics),
        tokens(item.metrics),
        cost(item.metrics),
      ]),
    );
    rank.prepend(rankHeader);
    const bars = node("div", undefined, "usage-rank");
    const top = report.breakdown.slice(0, 10);
    const maxRank = Math.max(1, ...top.map((item) => usageMetric(item.metrics, state.rankBy) ?? 0));
    for (const item of top) {
      const value = usageMetric(item.metrics, state.rankBy);
      const bar = node("button", undefined, "usage-rank-row");
      const name = objectName(label(item.name || item.id) || tr("系统 / 未分配", "System / unassigned"), item.status);
      bar.title = `${name} · ${metricLabel(state.rankBy)}: ${number(value)} ${coverage(item.metrics, state.rankBy)}`;
      const track = node("span", undefined, "usage-rank-track");
      const fill = node("span", undefined, "usage-rank-bar");
      fill.style.width = `${((value ?? 0) / maxRank) * 100}%`;
      track.append(fill);
      bar.append(node("span", name, "usage-rank-name"), track, node("span", compact(value), "usage-rank-value"));
      bar.onclick = () => {
        filters[state.dimension] = [item.id];
        offset = 0;
        save();
        drawFilters();
        load();
      };
      bars.append(bar);
    }
    const note = node(
      "p",
      tr(
        "展示当前筛选下的前 10 项，表格最多 200 项；点击对象下钻。",
        "Top 10 for the current filters; table includes up to 200. Select an object to drill down.",
      ),
      "usage-muted",
    );
    rank.insertBefore(bars, rank.querySelector(".tablewrap"));
    rank.insertBefore(note, bars);
    [...rank.querySelectorAll("tbody tr")].forEach((row, index) => {
      const item = report.breakdown[index];
      row.tabIndex = 0;
      row.style.cursor = "pointer";
      const drill = () => {
        filters[state.dimension] = [item.id];
        offset = 0;
        save();
        drawFilters();
        load();
      };
      row.onclick = drill;
      row.onkeydown = (event) => {
        if (event.key === "Enter") drill();
      };
    });
    const detailButton = node("button", showDetails ? tr("隐藏明细", "Hide details") : tr("查看明细", "View details"));
    detailButton.onclick = () => {
      showDetails = !showDetails;
      offset = 0;
      load();
    };
    results.append(detailButton);
    if (details) {
      table(
        tr("使用量明细", "Usage details"),
        [
          tr("发生时间", "Time"),
          tr("用户", "User"),
          "Project",
          tr("发生时部门", "Historical department"),
          tr("来源", "Source"),
          tr("模型", "Model"),
          tr("状态", "State"),
          tr("输入", "Input"),
          tr("输出", "Output"),
          tr("缓存读 / 写", "Cache read / write"),
          "USD",
          tr("费用来源", "Cost source"),
          tr("价格版本", "Price version"),
          tr("粒度", "Grain"),
        ],
        details.records.map((r) => [
          new Date(r.at).toLocaleString(locale, { timeZone: "Asia/Shanghai" }),
          objectName(r.principalName || tr("系统", "System"), r.principalStatus),
          objectName(r.projectDisplayName ?? r.projectName, r.projectStatus),
          objectName(r.unitName, r.unitStatus),
          label(r.source),
          r.model,
          label(r.state),
          number(r.input),
          number(r.output),
          `${number(r.cacheRead)} / ${number(r.cacheWrite)}`,
          money(r.costUsd),
          r.costBackfill ? `${label(r.costSource)} · ${tr("历史补估", "Historical estimate")}` : label(r.costSource),
          r.price?.id ?? "—",
          label(r.grain),
        ]),
      );
      const paging = node("div");
      const prev = node("button", tr("上一页", "Previous"));
      const next = node("button", tr("下一页", "Next"));
      prev.disabled = offset === 0;
      next.disabled = offset + 50 >= details.total;
      prev.onclick = () => {
        offset = Math.max(0, offset - 50);
        load();
      };
      next.onclick = () => {
        offset += 50;
        load();
      };
      paging.append(
        prev,
        node("span", ` ${details.total ? offset + 1 : 0}–${Math.min(offset + 50, details.total)} / ${details.total} `),
        next,
      );
      results.append(paging);
    }
  }
  function drawFilters() {
    if (!facets) return;
    openFilter?.close();
    for (const dispose of filterCleanup) dispose();
    filterCleanup = [];
    filterWrap.replaceChildren();
    for (const key of Object.keys(filters)) {
      const titles = {
        user: tr("用户", "User"),
        project: "Project",
        department: tr("部门（含子部门）", "Department (with descendants)"),
        model: tr("模型", "Model"),
        source: tr("来源", "Source"),
        auth: tr("授权", "Authorization"),
      };
      const wrap = node("div", undefined, "usage-filter usage-field");
      const trigger = node("button", undefined, "usage-filter-trigger");
      trigger.type = "button";
      trigger.setAttribute("aria-label", titles[key]);
      trigger.setAttribute("aria-haspopup", "dialog");
      trigger.setAttribute("aria-expanded", "false");
      const popup = node("div", undefined, "usage-filter-menu");
      popup.hidden = true;
      popup.id = `usage-filter-${key}`;
      popup.setAttribute("role", "dialog");
      popup.setAttribute("aria-label", titles[key]);
      trigger.setAttribute("aria-controls", popup.id);
      const search = node("input");
      search.type = "search";
      search.placeholder = tr("搜索名称或 ID…", "Search name or ID…");
      search.setAttribute("aria-label", `${tr("搜索", "Search")} ${titles[key]}`);
      const all = node("button", tr("全部（不限制）", "All (unrestricted)"));
      const options = node("div", undefined, "usage-filter-options");
      const updateLabel = () => {
        const values = filters[key];
        const item = (facets[key] ?? []).find((item) => item.id === values[0]);
        let text = tr("全部", "All");
        if (values.length > 1) text = tr(`已选 ${values.length} 项`, `${values.length} selected`);
        if (values.length === 1) text = facetName(key, item ?? { id: values[0] });
        trigger.replaceChildren(node("span", text), node("span", "⌄"));
        all.setAttribute("aria-pressed", String(values.length === 0));
      };
      const update = () => {
        offset = 0;
        updateLabel();
        drawChips();
        save();
        load();
      };
      const renderOptions = () => {
        options.replaceChildren();
        const items = [...(facets[key] ?? [])];
        for (const id of filters[key]) if (!items.some((item) => item.id === id)) items.push({ id, name: id });
        const term = search.value.trim().toLocaleLowerCase(locale);
        for (const item of items) {
          const text = facetName(key, item);
          if (term && !`${text} ${item.id}`.toLocaleLowerCase(locale).includes(term)) continue;
          const row = node("label", undefined, "usage-option");
          row.title = item.id;
          const checkbox = node("input");
          checkbox.type = "checkbox";
          checkbox.checked = filters[key].includes(item.id);
          checkbox.dataset.usageOption = item.id;
          checkbox.onchange = () => {
            if (checkbox.checked && filters[key].length >= 100) {
              checkbox.checked = false;
              return;
            }
            filters[key] = checkbox.checked
              ? [...new Set([...filters[key], item.id])]
              : filters[key].filter((v) => v !== item.id);
            update();
          };
          row.append(checkbox, node("span", text));
          options.append(row);
        }
        if (!options.children.length)
          options.append(node("p", tr("没有匹配对象", "No matching objects"), "usage-muted"));
      };
      const close = () => {
        popup.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
        if (openFilter?.popup === popup) openFilter = null;
      };
      trigger.onclick = () => {
        if (!popup.hidden) return close();
        openFilter?.close();
        popup.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
        openFilter = { popup, close };
        search.focus();
      };
      search.oninput = renderOptions;
      popup.onkeydown = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
          trigger.focus();
        }
        if (["ArrowDown", "ArrowUp"].includes(event.key)) {
          const inputs = [...options.querySelectorAll("input")];
          if (inputs.length) {
            const at = inputs.indexOf(doc.activeElement);
            inputs[(at + (event.key === "ArrowDown" ? 1 : -1) + inputs.length) % inputs.length].focus();
            event.preventDefault();
          }
        }
      };
      const outside = (event) => {
        if (!wrap.contains(event.target)) close();
      };
      doc.addEventListener("click", outside);
      filterCleanup.push(() => doc.removeEventListener("click", outside));
      all.onclick = () => {
        filters[key] = [];
        renderOptions();
        update();
      };
      const done = node("button", tr("完成", "Done"));
      done.onclick = () => {
        close();
        trigger.focus();
      };
      popup.append(
        search,
        all,
        options,
        node("p", tr("同一维度可多选（最多 100 项）", "Select up to 100 in each dimension"), "usage-muted"),
        done,
      );
      renderOptions();
      updateLabel();
      wrap.append(node("span", titles[key]), trigger, popup);
      filterWrap.append(wrap);
    }
    const clear = node("button", tr("清除筛选", "Clear filters"));
    clear.onclick = () => {
      for (const key of Object.keys(filters)) filters[key] = [];
      offset = 0;
      save();
      drawFilters();
      load();
    };
    filterWrap.append(clear);
    drawChips();
  }
  function drawChips() {
    chips.replaceChildren();
    const count = Object.values(filters).reduce((sum, values) => sum + values.length, 0);
    filterSummary.textContent = count
      ? tr(`筛选 · 已选 ${count} 项`, `Filters · ${count} selected`)
      : tr("筛选 · 全部", "Filters · All");
    for (const [key, values] of Object.entries(filters))
      for (const id of values) {
        const item = (facets?.[key] ?? []).find((item) => item.id === id);
        const name = facetName(key, item ?? { id });
        const chip = node("button", `${name} ×`);
        chip.title = id;
        chip.setAttribute("aria-label", `${tr("移除筛选", "Remove filter")}: ${name}`);
        chip.onclick = () => {
          filters[key] = filters[key].filter((v) => v !== id);
          offset = 0;
          save();
          drawFilters();
          load();
        };
        chips.append(chip);
      }
  }
  function schedule() {
    win.clearTimeout(timer);
    if (
      destroyed ||
      !usageAutoRefresh({
        visible: !doc.hidden,
        active: doc.body.dataset.subview === "usage",
        enabled: state.enabled,
        end: state.end,
      })
    )
      return;
    timer = win.setTimeout(() => load(true), Math.min(300000 * 2 ** failures, 1800000));
  }
  async function load(refreshFacets = false) {
    if (destroyed) return;
    controller?.abort();
    controller = new win.AbortController();
    const id = ++sequence;
    refresh.disabled = true;
    const q = query();
    const panelQuery = new URLSearchParams(q);
    for (const key of new Set(panels.filter((p) => p.dimension !== "total").map((p) => `${p.dimension}:${p.metric}`)))
      panelQuery.append("panel", key);
    try {
      const [report, details, options, trends] = await Promise.all([
        request(`?${q}`, controller.signal),
        showDetails ? request(`/details?${q}&limit=50&offset=${offset}`, controller.signal) : null,
        !facets || refreshFacets ? request("/facets", controller.signal) : null,
        panelQuery.has("panel")
          ? request(`/panels?${panelQuery}`, controller.signal).catch(() => null)
          : { panels: {} },
      ]);
      if (destroyed || id !== sequence) return;
      if (options) {
        facets = options;
        drawFilters();
      }
      panelData = trends?.panels ?? {};
      panelErrors = !trends;
      draw(report, details);
      lastLoad = Date.now();
      failures = 0;
    } catch (error) {
      if (error.name === "AbortError" || destroyed || id !== sequence) return;
      failures = Math.min(failures + 1, 3);
      message.textContent = `${tr("刷新失败，已保留上次数据", "Refresh failed; previous data retained")}: ${error.message}`;
    } finally {
      if (id === sequence && !destroyed) {
        refresh.disabled = false;
        schedule();
      }
    }
  }
  async function download(type) {
    const buttons = [exportSummary, exportDetails];
    buttons.forEach((button) => (button.disabled = true));
    try {
      const response = await win.fetch(`${base}/api/usage/export?${query()}&type=${type}`, {
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error((await response.json()).message ?? String(response.status));
      const url = win.URL.createObjectURL(await response.blob());
      const link = node("a");
      link.href = url;
      link.download = `usage-${type}-${state.start}-${state.end}.csv`;
      link.click();
      win.URL.revokeObjectURL(url);
    } catch (error) {
      message.textContent = `${tr("导出失败", "Export failed")}: ${error.message}`;
    } finally {
      if (!destroyed) buttons.forEach((button) => (button.disabled = false));
    }
  }
  preset.onchange = () => {
    dateVisibility();
    if (preset.value === "custom") return;
    Object.assign(state, usageRange(preset.value));
    start.value = state.start;
    end.value = state.end;
    offset = 0;
    save();
    load();
  };
  start.onchange = end.onchange = () => {
    state.start = start.value;
    state.end = end.value;
    preset.value = "custom";
    dateVisibility();
    offset = 0;
    save();
    load();
  };
  granularity.onchange = () => {
    state.granularity = granularity.value;
    save();
    load();
  };
  dimension.onchange = () => {
    state.dimension = dimension.value;
    save();
    load();
  };
  auto.onchange = () => {
    state.enabled = auto.checked;
    schedule();
  };
  refresh.onclick = () => load(true);
  exportSummary.onclick = () => download("summary");
  exportDetails.onclick = () => download("details");
  const visibility = () => {
    if (doc.hidden) {
      win.clearTimeout(timer);
      controller?.abort();
    } else if (state.enabled && state.end >= usageDate() && Date.now() - lastLoad >= 300000) load(true);
    else schedule();
  };
  doc.addEventListener("visibilitychange", visibility);
  loadLayout();
  return {
    destroy() {
      destroyed = true;
      chartObserver?.disconnect();
      chartRenderers.clear();
      sequence++;
      controller?.abort();
      win.clearTimeout(timer);
      doc.removeEventListener("visibilitychange", visibility);
      for (const dispose of filterCleanup) dispose();
      openFilter?.close();
      priceController?.abort();
      layoutController?.abort();
    },
  };
}
