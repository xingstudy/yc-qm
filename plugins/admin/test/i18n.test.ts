import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function adminDictionary(): Record<string, string> {
  const body = html.match(/const ADMIN_ZH = \{([\s\S]*?)\n {6}\};\n {6}const normalizeAdminLocale/)?.[1];
  assert.ok(body);
  return new Function(`return ({${body}});`)() as Record<string, string>;
}

test("admin and web surfaces share one persisted locale", () => {
  assert.match(html, /const ADMIN_LOCALE_KEY = "qm:locale";/);
  assert.match(html, /localStorage\.getItem\(ADMIN_LOCALE_KEY\)/);
  assert.match(html, /localStorage\.setItem\(ADMIN_LOCALE_KEY, adminLocale === "en" \? "zh-CN" : "en"\)/);
  assert.match(html, /document\.documentElement\.lang = adminLocale;/);
  assert.match(html, /\[\.\.\.\(navigator\.languages \|\| \[\]\), navigator\.language\]/);
});

test("admin exposes a bilingual control and translates only explicit UI sinks", () => {
  assert.match(html, /id="locale-toggle" type="button" data-i18n-skip>中文<\/button/);
  assert.match(html, /const ADMIN_ZH = \{/);
  assert.match(html, /Governance: "治理"/);
  assert.match(html, /Sessions: "会话"/);
  assert.doesNotMatch(html, /new MutationObserver/);
  assert.match(html, /translateAdminNode\(document\.body\);/);
  assert.match(html, /b\.textContent = adminTr\(cell\.action\.label\)/);
  assert.match(html, /heading\.textContent = adminTr\("Version history"\)/);
  assert.match(html, /edit\.textContent = adminTr\("Edit destination"\)/);
  assert.match(html, /loading\.textContent = adminTr\("Loading Slack mirror\.\.\."\)/);
  assert.match(html, /msgTitle\.textContent = adminTr\("Message"\)/);
  assert.match(html, /el\.textContent = adminTr\(text\)/);
  assert.match(html, /scopes\.textContent = adminTr\(/);
  assert.match(html, /item\.textContent = adminTr\(text\)/);
  assert.match(html, /\? adminTr\("Today"\)/);
  assert.match(html, /s\.textContent = text/);
  assert.match(html, /function localizedBadge\(text, kind\)/);
  assert.match(html, /b\.textContent = adminTr\(it\.label\)/);
  assert.match(html, /btn\.setAttribute\("aria-label", adminTr\("Actions"\)\)/);
  assert.match(html, /b\.textContent = adminTr\(label\)/);
  assert.match(html, /adminTr\(activeRows\.length \+ \(activeRows\.length === 1/);
  assert.match(html, /document\.title = `\$\{brandSelfLabel\(\)\} \$\{adminTr\("Admin"\)\}`/);
  assert.match(html, /adminTr\(Number\(background\)\.toLocaleString\(adminLocaleCode\(\)\) \+ " background"\)/);
  assert.match(html, /card\.title = adminTr\(expanded \? "Click to collapse tool text"/);
  assert.match(html, /link\.title = adminTr\(/);
  assert.match(html, /label\.textContent = adminTr\(deliveryLabel\)/);
  assert.match(html, /`\$\{adminTr\(deliveryState\)\} · \$\{fmtTime\(event\.createdAt\)\}`/);
  assert.match(html, /\$\("sc-cap-state"\)\.textContent = adminTr\(/);
  assert.match(html, /adminTr\("Any path on this host"\)/);
  assert.match(html, /\$\("sc-cap-secret"\)\.textContent = adminTr\(secretStatus\)/);
  assert.match(html, /response\.data\?\.message \|\| adminTr\("Simulation failed\."\)/);
  assert.match(html, /adminTr\("No scope-policy rule matches"\)/);
  assert.match(html, /adminTr\("last sync:"\)/);
  assert.match(html, /adminTr\("available \(eligible\) in this pack"\)/);
  assert.match(html, /adminTr\("logged in this scope"\)/);
  assert.match(html, /btn\(adminTr\("← Prev"\)/);
  assert.match(html, /function setApiStatus\(id, serverMessage, fallback, kind, sticky = false\)/);
  assert.match(html, /setStatus\(id, serverMessage \|\| fallback, kind, sticky, !serverMessage\)/);
  assert.match(html, /adminTr\("contains invalid host"\)/);
  assert.match(html, /adminTr\("appears in both lists\. Remove it from one list before saving\."\)/);
  assert.match(html, /b\.textContent = adminTr\(text\)/);
  assert.match(html, /status\.textContent = r2\.data\?\.message \|\| adminTr\("Import failed"\)/);
  assert.match(html, /plural\(added, "skill"\)/);
  assert.match(html, /label: adminTr\("System prompt"\)/);
  assert.match(html, /label: adminTr\("Tool schemas"\)/);
  assert.match(html, /metaChip\(adminTr\("cache"\)/);
  assert.match(html, /lbl\.textContent = adminTr\(label\) \+ " "/);
  assert.match(html, /a\.textContent = adminTr\(label\)/);
  assert.match(html, /badge\(pillCount\(key\) \+ " " \+ adminTr\(meta\.label\)/);
  assert.match(html, /adminTr\("Click to show only these\."\)/);
  assert.match(html, /adminTr\(bundlePaths\.length === 1 \? "shared pack file" : "shared pack files"\)/);
  assert.match(html, /adminTr\(open \? "Collapse entry" : "Expand entry"\)/);
  assert.match(html, /adminTr\(open \? "Collapse model context" : "Expand model context"\)/);
  assert.match(html, /text\.appendChild\(slackParseText\(m\.text \|\| "", m\.mentions\)\)/);
  assert.match(html, /txt\.textContent = p\.message \|\| "—"/);
  assert.match(html, /textContent: adminTr\("Config store not available\."\)/);
  assert.match(html, /b\.textContent = adminTr\(label\)/);
  assert.match(html, /j\.reason \|\| \(j\.decision === "fastlane" \? adminTr\("@mention — routed past the judge"\)/);
  assert.match(html, /mpre\.textContent = p\.message \|\| adminTr\("\(not recorded\)"\)/);
  assert.match(html, /r\.data\?\.message \|\| `\$\{adminTr\("Failed to load transcript"\)\} \(\$\{r\.status\}\)\.`/);
  assert.match(html, /r\.data\?\.message \|\| `\$\{adminTr\("Search failed"\)\} \(\$\{r\.status\}\)\.`/);
  assert.match(html, /r\.data\?\.message \|\| `\$\{adminTr\("Failed to load mirror"\)\} \(\$\{r\.status\}\)\.`/);
  assert.match(html, /if \(j\.decision === "ignore"\) reason = adminTr\("Stayed silent\."\)/);
  assert.doesNotMatch(html, /emptyPara\(adminTr\(r\.data\?\.message/);
  assert.match(html, /document\.createTextNode\(adminTr\("Slack mirror"\)\)/);
  assert.match(html, /a\.setAttribute\("aria-label", adminTr\("Open in Slack"\)\)/);
  assert.match(html, /pre\.textContent =\s+j\.prompt \|\|\s+adminTr\(/);
  assert.match(html, /badge\(`\$\{adminTr\("asked by"\)\} \$\{j\.askedBy\}`/);
  assert.match(html, /\$\("egress-enforcement"\)\.textContent = adminTr\(enforcementLabel\)/);
  assert.match(html, /adminTr\(provider\.hasKey \? "set \(write-only\)" : "No key"\)/);
  assert.match(html, /label\.append\(\s*adminTr\("Upload to "\)/);
  assert.match(html, /return scopeKind\(id\) === "org" \? adminTr\("All scopes"\)/);
  assert.match(html, /b\.textContent = adminTr\(k\)/);
  assert.match(html, /\.filter\(Boolean\)\s*\.map\(\(part\) => adminTr\(part\)\)/);
  assert.match(html, /p\.textContent = adminTr\(emptyMsg\)/);
  assert.match(html, /else th\.textContent = adminTr\(h\)/);
  assert.match(html, /mutedText\(\s*e\.action \|\| adminTr\("event"\)/);
  assert.match(html, /root\.querySelector\("\.detail"\)\.textContent = adminTr\(detail\)/);
  assert.match(html, /\$\("soul"\)\.placeholder = adminTr\("No scope-specific instructions"\)/);
  assert.match(html, /function navLink\(label, target\)[^]*?a\.textContent = label;/);
  assert.match(html, /navLink\(adminTr\("Governance →"\)/);
  assert.match(html, /enforcement\.active \? adminTr\(titleCase\(enforcement\.fidelity\)\) \+ " enforced"/);
  assert.match(html, /capability\.querySelector\("span"\)\.textContent = adminTr\(enforcementSummary\)/);
  assert.match(html, /o\.textContent = adminTr\(EFFECT_LABELS\[e\] \|\| e\)/);
  assert.match(html, /return meta \? adminTr\(meta\[0\]\) : titleCase\(key\)/);
  assert.match(html, /return meta \? adminTr\(meta\[1\]\) : ""/);
  assert.match(html, /adminTr\("Turns that never touched a machine"\)/);
  assert.match(html, /adminTr\("Turns that used a machine"\)/);
  assert.match(html, /adminTr\("Organization"\) \+ " · "/);
  assert.match(html, /input\.setAttribute\("aria-label", adminTr\("Show"\) \+ " " \+ adminTr\(label\)\)/);
  assert.match(html, /o\.textContent = adminTr\(BOT_MODE_LABELS\[m\] \|\| m\)/);
  assert.match(html, /l\.textContent = adminTr\(labelText\)/);
  assert.match(html, /adminTr\(before \? "External audiences enabled" : "Internal only"\)/);
  assert.match(html, /options\.titleI18n === false \? title : adminTr\(title\)/);
  assert.match(html, /options\.descI18n === false \? desc : adminTr\(desc\)/);
  assert.match(html, /dataCard\(k\.name \|\| k\.id, "", box, \{ titleI18n: false \}\)/);
  assert.match(html, /adminTr\("Browse"\) \+ " — " \+ s\.url/);
  assert.match(html, /adminTr\("first fired"\)/);
  assert.match(html, /adminTr\(c\.members\.length \+ " people"\)/);
  assert.match(html, /alert\(adminTr\("Couldn't start impersonation:"\) \+ " " \+ msg\)/);
  assert.match(html, /adminTr\("This credential currently grants broker access to"\)/);
  assert.match(html, /s\.firstMessage \|\| s\.lastMessage \|\| adminTr\("\(no messages yet\)"\)/);
  assert.match(html, /principalId \|\| adminTr\("User"\)/);
  assert.match(html, /c\.title \|\| c\.action \|\| c\.message \|\| adminTr\("\(empty\)"\)/);
  assert.match(html, /revision\.updatedBy \|\| adminTr\("Author unavailable"\)/);
  assert.match(html, /adminTr\("Restore SOUL version"\) \+ " " \+ immutable\.version/);
  assert.match(html, /adminTr\("Version"\) \+ " " \+ immutable\.version/);
  assert.match(html, /adminTr\("restored as a new revision"\)/);
  assert.match(html, /adminTr\(plural\(d\.totals\?\.users/);
  assert.match(html, /\$\("environment-notice-title"\)\.textContent = adminTr\("Uses named environment " \+ name\)/);
  assert.match(html, /\$\("environment-notice-open"\)\.textContent = adminTr\("Open environment " \+ name\)/);
  assert.match(html, /if \(!attached\.length\) return adminTr\("no scopes attached"\)/);
  assert.match(html, /dataCard\(\s*adminTr\("Named environments"\)/);
  assert.match(html, /env\.title = adminTr\("This scope is attached to a named environment\."\)/);
  assert.match(html, /none\.textContent = adminTr\("No scopes attached\."\)/);
  assert.doesNotMatch(html, /adminTr\(d\.attribution/);
});

test("admin locale also controls date and number formatting", () => {
  assert.match(html, /const adminLocaleCode = \(\) =>/);
  assert.match(html, /new Date\(ts\)\.toLocaleString\(adminLocaleCode\(\)\)/);
  assert.match(html, /Number\(background\)\.toLocaleString\(adminLocaleCode\(\)\)/);
  assert.match(html, /\^\(\[\\d,\.\]\+\[kKmM\]\?\) turns\?/);
  assert.match(html, /return adminTr\(fmtTokensSource\(n\)\);/);
  const body = html.match(/const adminTranslatePattern = \(value\) => \{([\s\S]*?)\n {6}\};\n {6}const adminTr/)?.[1];
  assert.ok(body);
  const translatePattern = new Function("value", body) as (value: string) => string | null;
  const dictionary = adminDictionary();
  const adminTr = (value: string) => {
    const leading = value.match(/^\s*/)?.[0] || "";
    const trailing = value.match(/\s*$/)?.[0] || "";
    const normalized = value.trim().replace(/\s+/g, " ");
    const translated = dictionary[normalized] ?? translatePattern(normalized);
    return translated == null ? value : `${leading}${translated}${trailing}`;
  };
  assert.equal(translatePattern("1,234 turns"), "1,234 个轮次");
  assert.equal(translatePattern("12 users"), "12 位用户");
  assert.equal(translatePattern("9 sessions"), "9 个会话");
  assert.equal(translatePattern("3 people"), "3 人");
  assert.equal(translatePattern("1.2k tokens"), "1.2k 个令牌");
  assert.equal(translatePattern("4 errors"), "4 个错误");
  assert.equal(translatePattern("98 events"), "98 个事件");
  assert.equal(translatePattern("41 runs"), "41 次运行");
  assert.equal(translatePattern("39 done"), "已完成 39 次");
  assert.equal(translatePattern("2 failed"), "失败 2 次");
  assert.equal(translatePattern("4.9% failure rate"), "4.9% 失败率");
  assert.equal(translatePattern("Loading Research…"), "正在加载Research…");
  assert.equal(translatePattern("Loading Research..."), "正在加载Research…");
  assert.equal(translatePattern("2 allowed hosts"), "2 个允许的主机");
  assert.equal(translatePattern("1 explicitly denied host"), "1 个明确拒绝的主机");
  assert.equal(translatePattern("3 denied hosts"), "3 个拒绝的主机");
  assert.equal(translatePattern("3 known scopes without conversations"), "3 个尚无对话的已知范围");
  assert.equal(translatePattern("Open origin session abc123 · fire-key"), "打开来源会话 abc123 · fire-key");
  assert.equal(translatePattern("Scopes: repo, read:org"), "权限范围：repo, read:org");
  assert.equal(adminTr(`3 ${adminTr("eligible")}`), "3 符合条件");
  assert.equal(adminTr(`2 ${adminTr("imported")}`), "2 已导入");
  assert.equal(adminTr(`4 ${adminTr("binary files")}`), "4 二进制文件");
  assert.equal(adminTr("Failed to load"), "加载失败");
  assert.equal(adminTr("Only an org admin can read ambient judgments."), "只有组织管理员可以读取环境判定。");
  assert.equal(adminTr("Slack mirror"), "Slack 镜像");
  assert.equal(adminTr("asked by"), "提问者");
  assert.equal(adminTr("Open outbound access"), "开放出站访问");
  assert.equal(adminTr("set (write-only)"), "已设置（只写）");
  assert.equal(adminTr("All scopes"), "所有范围");
  assert.equal(adminTr("Upload to "), "上传至 ");
  assert.equal(adminTr("Open environment"), "打开环境");
  assert.equal(adminTr("Channel pinned header"), "频道置顶消息");
  assert.equal(adminTr("Named environments"), "命名环境");
  assert.equal(adminTr("No scopes attached."), "没有已关联的范围。");
  assert.equal(adminTr("env: "), "环境： ");
  assert.equal(translatePattern("Uses named environment Research"), "正在使用命名环境 Research");
  assert.equal(translatePattern("Open environment Research"), "打开环境 Research");
  assert.equal(translatePattern("one +2 more scopes"), "one + 另外 2 个范围");
  assert.equal(
    translatePattern("2 scopes share this environment's computer and working memory."),
    "2 个范围共享此环境的计算机和工作记忆。",
  );
  assert.equal(adminTr("Grant org admin"), "授予组织管理员");
  assert.equal(adminTr("Effective security posture"), "当前生效的安全策略");
  assert.equal(adminTr("Open egress"), "开放出站访问");
  assert.equal(adminTr("External enabled"), "允许外部参与者");
  assert.equal(adminTr("Volume"), "数量");
  assert.equal(adminTr("Last activity"), "最近活动");
  assert.equal(adminTr("(no messages yet)"), "（暂无消息）");
  assert.equal(adminTr("No config."), "暂无配置。");
  assert.equal(adminTr("Author unavailable"), "操作者不可用");
  assert.equal(adminTr("Time unavailable"), "时间不可用");
  assert.equal(adminTr("Restore SOUL version"), "恢复 SOUL 版本");
  assert.equal(adminTr("Restore version"), "恢复版本");
  assert.equal(adminTr("restored as a new revision"), "已恢复为新修订版");
  assert.equal(adminTr("Restoring…"), "正在恢复…");
  assert.equal(
    adminTr("SOUL changed; latest revision loaded and your draft was preserved."),
    "SOUL 已更改；已加载最新修订版，并保留了你的草稿。",
  );
  assert.equal(adminTr("Restore failed."), "恢复失败。");
  assert.equal(adminTr("Deployment default"), "部署默认值");
  assert.equal(adminTr("Require approval"), "需要审批");
  assert.equal(adminTr("Total turn"), "总轮次");
  assert.equal(adminTr("End-to-end wall time, request to reply"), "端到端总耗时（从请求到回复）");
  assert.equal(adminTr("Memory capture"), "记忆捕获");
  assert.equal(adminTr("Post-turn fact extraction, off the critical path"), "轮次结束后的事实提取，不在关键路径上");
  assert.equal(adminTr("Organization"), "组织");
  assert.equal(adminTr("No packs yet — register one above."), "尚无技能包——请在上方注册一个。");
  assert.equal(translatePattern("67.9% prompt-cache hit ratio"), "67.9% 提示词缓存命中率");
  assert.equal(translatePattern("4.6m tokens read"), "已读取 4.6m 个令牌");
  assert.equal(translatePattern("0 tokens written"), "已写入 0 个令牌");
  assert.equal(translatePattern("Upload failed (503)."), "上传失败（503）。");
  assert.equal(translatePattern("2 effective rules"), "2 条生效规则");
  assert.equal(
    translatePattern("3 on a warm machine (420ms median resume) · 2 booted cold (1.4s median boot)"),
    "3 次使用热机（恢复耗时中位数 420ms） · 2 次冷启动（启动耗时中位数 1.4s）",
  );
  assert.equal(translatePattern("Domain enforced"), "Domain已强制执行");
  assert.equal(
    translatePattern('Duplicate bot "Build Bot" — the ledger matches names case-insensitively.'),
    "机器人“Build Bot”重复——台账中的名称不区分大小写。",
  );
  assert.equal(translatePattern("Rule 3 is shadowed by catch-all rule 1."), "规则 3 被全匹配规则 1 遮蔽。");
  assert.equal(
    translatePattern("Disable the OpenAI model key? Models from this provider will stop working."),
    "禁用 OpenAI 模型密钥？此提供商的模型将停止工作。",
  );
  assert.equal(
    translatePattern(
      "Firecracker supports domain fidelity, which cannot enforce outbound host policy. Agents still have open outbound access.",
    ),
    "Firecracker 支持domain级执行精度，但无法执行出站主机策略。智能体仍可自由访问外部网络。",
  );
});

test("admin localization preserves identity, secrets, and authored content", () => {
  assert.match(html, /data-i18n-skip/);
  assert.match(
    html,
    /script,style,code,pre,\[data-i18n-skip\],\.mono,\.viewer,\.file-name,\.credential-secret,\.dense-name,\.dense-preview/,
  );
  assert.match(html, /id="who-name" data-i18n-skip/);
  assert.match(html, /id="na-sub" data-i18n-skip/);
  assert.match(html, /<textarea\s+id="soul"\s+data-i18n-skip\s+maxlength="100000"/);
  assert.match(
    html,
    /System instruction text remains in its authored language\. Changing the interface language does not translate or rewrite it\. Saving affects future turns, including existing conversations\./,
  );
  const dictionary = adminDictionary();
  assert.equal(
    dictionary[
      "You are a helpful internal assistant for this organization. Be concise, accurate, and respect data boundaries: never reveal information to people who are not party to the current conversation."
    ],
    undefined,
  );
  assert.doesNotMatch(html, /soul"\)\.value\s*=\s*adminTr/);
  assert.match(html, /loading\.textContent = adminTr\("Loading"\) \+ " " \+ \(rep\.name \|\| rep\.id\) \+ "…"/);
  assert.match(
    html,
    /ml\.title = adminTr\("Jump to this message in the mirrored Slack channel"\) \+ " " \+ mirror\.container/,
  );
  assert.match(html, /\$\("sc-form-title"\)\.textContent = adminTr\("Editing"\) \+ " " \+ c\.slug/);
  assert.match(
    html,
    /\$\("conn-form-title"\)\.textContent = adminTr\("Editing"\) \+ " " \+ connectorName\(c\.provider\)/,
  );
  const start = html.indexOf("function badge(text, kind)");
  const end = html.indexOf("function badgeList(items)", start);
  assert.ok(start >= 0 && end > start);
  const document = { createElement: () => ({ className: "", textContent: "" }) };
  const factory = new Function("document", "adminTr", `${html.slice(start, end)}; return { badge, localizedBadge };`);
  const { badge, localizedBadge } = factory(document, (value: string) => (value === "Admin" ? "管理" : value)) as {
    badge: (text: string, kind?: string) => { textContent: string };
    localizedBadge: (text: string, kind?: string) => { textContent: string };
  };
  assert.equal(badge("Admin", "muted").textContent, "Admin");
  assert.equal(localizedBadge("Admin", "muted").textContent, "管理");
});
