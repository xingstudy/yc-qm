import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { html, installI18n, LOCALE_KEY, normalizeLocale, resolveLocale, translateText } from "../src/i18n.ts";

test("locale resolution prefers the saved choice and otherwise follows the browser", () => {
  assert.equal(normalizeLocale("zh-TW"), "zh-CN");
  assert.equal(normalizeLocale("en-GB"), "en");
  assert.equal(normalizeLocale("fr-FR"), null);
  assert.equal(resolveLocale("en", ["zh-CN"]), "en");
  assert.equal(resolveLocale(null, ["fr-FR", "zh-Hans"]), "zh-CN");
  assert.equal(resolveLocale(null, ["fr-FR"]), "en");
});

test("Chinese translations cover exact UI copy and dynamic counters", () => {
  assert.equal(translateText("New chat", "zh-CN"), "新建对话");
  assert.equal(translateText("New project", "zh-CN"), "新建项目");
  assert.equal(translateText("Search projects…", "zh-CN"), "搜索项目…");
  assert.equal(translateText("Active only", "zh-CN"), "仅显示使用中");
  assert.equal(translateText("Everything", "zh-CN"), "全部");
  assert.equal(translateText("launch cohort", "zh-CN"), "发布批次");
  assert.equal(translateText("Conversations", "zh-CN"), "对话");
  assert.equal(
    translateText("The model every conversation here starts on.", "zh-CN"),
    "此处的每个对话都会以该模型开始。",
  );
  assert.equal(translateText("Add people", "zh-CN"), "添加人员");
  assert.equal(translateText("You", "zh-CN"), "你");
  assert.equal(translateText("Owner", "zh-CN"), "所有者");
  assert.equal(translateText("Agent behavior", "zh-CN"), "智能体行为");
  assert.equal(translateText("Files created, uploaded, or shared with you", "zh-CN"), "由你创建、上传或与你共享的文件");
  assert.equal(translateText("Search file names and types…", "zh-CN"), "搜索文件名和类型…");
  assert.equal(translateText("Ask the agent to set it up", "zh-CN"), "让智能体帮我设置");
  assert.equal(
    translateText("Accounts and credentials your agent may use on your behalf.", "zh-CN"),
    "智能体可代表你使用的账户和凭据。",
  );
  assert.equal(
    translateText("Secrets stay encrypted and every use or shared grant is audited.", "zh-CN"),
    "密钥始终加密存储，每次使用或共享授权都会被审计。",
  );
  assert.equal(translateText("Facts the agent carries into your conversations.", "zh-CN"), "智能体会带入对话的事实。");
  assert.equal(
    translateText("Create a reusable procedure for yourself or a shared context.", "zh-CN"),
    "为自己或共享上下文创建可复用的流程。",
  );
  assert.equal(translateText("  3 tool calls  ", "zh-CN"), "  3 次工具调用  ");
  assert.equal(translateText("New chat in Research", "zh-CN"), "在 Research 中新建对话");
  assert.equal(translateText("Uploading 3 files…", "zh-CN"), "正在上传 3 个文件…");
  assert.equal(translateText("Uploaded 1 file.", "zh-CN"), "已上传 1 个文件。");
  assert.equal(translateText("Uploaded 2 of 3. Server message", "zh-CN"), "已上传 2 / 3。Server message");
  assert.equal(translateText("3 results", "zh-CN"), "3 条结果");
  assert.equal(translateText("2 saved", "zh-CN"), "已保存 2 条");
  assert.equal(translateText("Thinking…", "zh-CN"), "正在思考…");
  assert.equal(translateText("Copy link to Project Alpha", "zh-CN"), "复制 Project Alpha 的链接");
  assert.equal(translateText("More actions for Demo app", "zh-CN"), "Demo app 的更多操作");
  assert.equal(translateText("Handling for Build bot", "zh-CN"), "Build bot 的处理方式");
  assert.equal(translateText("Batch interval for Build bot in hours", "zh-CN"), "Build bot 的批处理间隔（小时）");
  assert.equal(translateText("Remove Build bot from the ledger", "zh-CN"), "从记录中移除 Build bot");
  assert.equal(translateText("read-only", "zh-CN"), "只读");
  assert.equal(translateText("pinned", "zh-CN"), "已置顶");
  assert.equal(translateText("Open here", "zh-CN"), "在此打开");
  assert.equal(translateText("New chat", "en"), "New chat");
  assert.equal(translateText("New project", "en"), "New project");
  assert.equal(translateText("User supplied content", "zh-CN"), "User supplied content");
});

test("Chinese translations cover the project management, resource, and skill page copy", () => {
  const copy: Array<[string, string]> = [
    ["Choose what this project should notice and act on.", "选择此项目中智能体应关注并采取行动的内容。"],
    ["Ambient behavior", "环境行为"],
    [
      "When off, the agent never acts on overheard messages here — it only responds to direct @mentions. Default: on only when standing orders (or an action-mode bot) are set below — otherwise mention-only.",
      "关闭后，智能体不会对这里偶然听到的消息采取行动，只响应直接 @提及。默认仅在下方设置长期指令（或行动模式机器人）时启用；否则仅响应提及。",
    ],
    ["Standing orders", "长期指令"],
    [
      "Plain-language guidance for proactive work. Leave empty to respond only when addressed.",
      "用自然语言说明主动工作的指引。留空时仅在被直接提及时响应。",
    ],
    ["Automated posters", "自动发布者"],
    ["Control how messages from bots and integrations wake the agent.", "控制机器人和集成消息如何唤醒智能体。"],
    ["No bots added. All bot posts are treated as activity.", "尚未添加机器人。所有机器人发布的消息都会视为活动。"],
    [
      "Describe what you want scheduled — what to do, how often, and where the result should go. The agent sets it up and confirms in chat; it will ask if anything is unclear. It should give the cron a short, distinctive title naming what it is for, like Gmail unread digest or GitLab CI watch.",
      "描述你希望安排的任务：做什么、多久执行一次，以及将结果发送到哪里。智能体会进行设置并在对话中确认；如有不清楚之处会询问你。它会为定时任务设置简短且易识别的标题来说明用途，例如 Gmail 未读摘要或 GitLab CI 监控。",
    ],
    ["No accounts available", "暂无可用账户"],
    ["Your workspace has not configured any account providers yet.", "你的工作区尚未配置任何账户提供商。"],
    [
      "Edit the notebook directly. Switch to Facts view to search or remove individual facts. Saves are protected if the agent remembers something new while this page is open.",
      "直接编辑笔记本。切换到事实视图可搜索或删除单条事实。如果该页面打开期间智能体记住了新内容，保存操作会受到保护。",
    ],
    ["Everyone in a shared context can invoke and edit this skill.", "共享上下文中的所有人都可以调用和编辑此技能。"],
    ["Instructions", "指令"],
    ["Details", "详情"],
    ["Capabilities", "能力"],
    ["Edit /", "编辑 /"],
    ["Editing", "编辑中"],
    ["Review again", "重新审查"],
    ["Narrower scope takes precedence where both apply", "当多个范围同时适用时，较窄的范围优先"],
    ["Expired", "已过期"],
    ["Pending requests", "待处理请求"],
    ["requested", "请求了"],
    ["access", "访问权限"],
    ["scope", "范围"],
    ["source", "来源"],
  ];
  for (const [source, translated] of copy) assert.equal(translateText(source, "zh-CN"), translated);
});

test("template localization translates authored UI copy and preserves every dynamic value", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:8129/" });
  dom.window.localStorage.setItem(LOCALE_KEY, "zh-CN");
  const names = ["document", "localStorage", "navigator"] as const;
  const descriptors = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  }
  try {
    installI18n(dom.window.document.documentElement);
    const conversationTitle = "Files";
    const slackMessage = "New chat";
    const template = html`<button title="Sign out">New chat</button>
      <h1 class="chat-title">${conversationTitle}</h1>
      <div class="sm-text">${slackMessage}</div>` as unknown as {
      strings: readonly string[];
      values: readonly unknown[];
    };
    assert.equal(dom.window.document.documentElement.lang, "zh-CN");
    assert.match(template.strings.join(""), /title="退出登录">新建对话/);
    assert.deepEqual(template.values, ["Files", "New chat"]);

    const boundaries = html`<span>Pinned</span><span>Allow once</span><span>Allow custom</span>` as unknown as {
      strings: readonly string[];
    };
    assert.match(boundaries.strings.join(""), /<span>已置顶<\/span><span>允许一次<\/span><span>Allow custom<\/span>/);
  } finally {
    for (const name of names) {
      const descriptor = descriptors.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
    dom.window.close();
  }
});

test("conditional interface labels pass through the translator", () => {
  const source = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
  assert.match(source("crons.ts"), /t\(showDisabledCrons \? "Hide disabled" : "Show disabled"\)/);
  assert.match(source("contexts.ts"), /t\(contextsState\.createSaving \? "Close" : "Cancel"\)/);
  assert.match(source("sessions.ts"), /title=\$\{t\(s\.archived \? "Unarchive" : "Archive"\)\}/);
  assert.match(source("shell.ts"), /t\(gate\.pending \? "Signing in…" : "Continue"\)/);
  assert.match(source("deploys.ts"), /t\(manage \? "Can manage" : "Can view"\)/);
  assert.match(source("skills.ts"), /t\(deleting === skill\.id \? "Archiving…" : "Archive skill"\)/);
  assert.match(source("memory.ts"), /t\(rawEditing \? "Facts view" : "Edit notebook"\)/);
  assert.match(source("connectors.ts"), /t\(keychainOperations\.dropInFlight \? "Preparing…" : "Continue"\)/);
  assert.match(source("ambient-policy.ts"), /t\(ambientPolicyState\.saving \? "Saving…" : "Save"\)/);
  assert.match(source("context-model.ts"), /message === fallback \? t\(fallback\) : message/);
  assert.doesNotMatch(source("context-model.ts"), /t\(contextModelState\.notice\)/);
  assert.match(source("files.ts"), /<span>\$\{t\(dropLabel\)\}<\/span>/);
  assert.match(source("files.ts"), /return message === fallback \? t\(fallback\) : message/);
  assert.doesNotMatch(source("files.ts"), /t\(status\)/);
  assert.match(source("connectors.ts"), /t\(status === "connected" \? "connected\." : "connection failed\."\)/);
  assert.match(source("contexts.ts"), /aria-label=\$\{`\$\{t\("Remove"\)\} \$\{label\}`\}/);
  assert.match(source("contexts.ts"), /if \(principalId === appState\.me\?\.user\) return t\("You"\)/);
  assert.match(source("contexts.ts"), /fallbackName\?\.trim\(\) \|\| t\("Personal"\)/);
  assert.doesNotMatch(source("contexts.ts"), /fallbackName[^\n]*=== "Personal"/);
  assert.match(source("session-list.ts"), /name: t\("Personal"\)/);
  assert.match(source("sessions.ts"), /\?\? t\("Personal"\)/);
  assert.match(source("context-model.ts"), /\$\{t\("Org default"\)\}/);
  assert.match(source("connectors.ts"), /\$\{t\(meta\.hosts\)\}/);
  assert.match(source("connectors.ts"), /\$\{t\(meta\.desc\)\}/);
  assert.match(source("connectors.ts"), /\$\{t\(ask\.requestedMode \?\? "one-time"\)\}/);
  assert.match(source("skills.ts"), /name: t\("Personal — only you"\)/);
  assert.match(source("chat.ts"), /return t\(work\.status === "working" \? `Working for \$\{secs\}s`/);
  assert.match(source("chat.ts"), /return t\("Needs your approval"\)/);
  assert.match(source("chat.ts"), /t\(`\$\{result\.count\} result/);
  assert.match(source("memory.ts"), /memoryNotice = t\("Saved ✓"\)/);
  assert.match(source("memory.ts"), /memoryNotice \|\| t\("Loading…"\)/);
  assert.match(source("contexts.ts"), /contextsNotice \|\| \(contextsLoading[^]*t\("Loading projects…"\)/);
  assert.match(source("skills.ts"), /skillsNotice = t\("Loading skill instructions…"\)/);
  assert.match(source("crons.ts"), /cronActionNotice = t\("Run started\./);
  assert.match(source("connectors.ts"), /`\$\{t\("a Slack channel"\)\} \(\$\{ref\}\)`/);
  assert.match(source("connectors.ts"), /return message === fallback \? t\(fallback\) : message/);
  assert.doesNotMatch(source("connectors.ts"), /t\(connectorNotice\)/);
  assert.match(source("connectors.ts"), /title: `\$\{t\("Delete"\)\} \$\{credential\.service\}\?`/);
  assert.match(source("connectors.ts"), /action: t\("Disconnect account"\)/);
  assert.match(source("chat.ts"), /bgPanel\.error = message === fallback \? t\(fallback\) : message/);
  assert.doesNotMatch(source("chat.ts"), /t\(bgPanel\.error\)/);
  assert.match(source("files.ts"), /<span>\$\{t\(label\)\}<\/span>/);
  assert.match(source("files.ts"), /<span class="badge">\$\{t\(f\.kind\)\}<\/span>/);
  assert.match(source("sessions.ts"), /aria-label=\$\{t\(`Copy link to \$\{sessionTitle\(s\)\}`\)\}/);
  assert.match(source("deploys.ts"), /aria-label=\$\{t\(`More actions for \$\{deploymentTitle\(d\)\}`\)\}/);
  assert.match(source("ambient-policy.ts"), /ariaLabel: t\(`Handling for \$\{b\.name\}`\)/);
  assert.match(source("composer.ts"), /const steerTitle = t\(/);
  assert.match(source("crons.ts"), /error\.textContent = t\(taskControl \? "Title and task are required\."/);
  assert.match(source("session-list.ts"), /parts\.push\(t\(`\$\{jobs\} background job/);
  assert.match(source("sessions.ts"), /working \? t\("agent is working"\) : null/);
  assert.match(source("sessions.ts"), /aria-label=\$\{t\(ariaLabel\)\}/);
  assert.match(source("split.ts"), /<span>\$\{t\(label\)\}<\/span>/);
  assert.match(source("split.ts"), /if \(panelParams\(panel\)\.sessionId\) return t\("Conversation"\)/);
  assert.match(source("split.ts"), /title=\$\{t\(b\.label\)\}/);
  assert.match(source("chat.ts"), /title = t\(liveWorkExpanded \? "Show less" : "Show more"\)/);
  assert.match(source("chat.ts"), /<strong>\$\{label\}<\/strong> \$\{t\("context"\)\}/);
});
