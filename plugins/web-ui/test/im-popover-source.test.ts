import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
const imLogoSource = shell.slice(shell.indexOf("function imLogo"), shell.indexOf("function imQrSrc"));
const refreshImBinding = shell.slice(
  shell.indexOf("async function refreshImBinding"),
  shell.indexOf("function startImPolling"),
);
const syncWeixinBridge = server.slice(
  server.indexOf("async function syncWeixinBridge"),
  server.indexOf("export async function drainImSdkDeliveries"),
);
const syncImSdkBridges = server.slice(
  server.indexOf("async function syncImSdkBridges"),
  server.indexOf("export async function drainImDeliveries"),
);

test("the footer user pill opens the IM channel popover", () => {
  assert.match(shell, /id: "wechat",\s+label: "WeChat"/);
  assert.match(shell, /id: "feishu",\s+label: "Feishu"/);
  assert.match(shell, /id: "work-wechat",\s+label: "WeCom"/);
  assert.match(shell, /image: wecomLogo/);
  assert.match(shell, /id: "qq",\s+label: "QQ"/);
  assert.match(shell, /id: "dingtalk",\s+label: "DingTalk"/);
  assert.match(
    shell,
    /const VISIBLE_IM_PROVIDER_OPTIONS = IM_PROVIDER_OPTIONS\.filter\(\(option\) => option\.id === "work-wechat"\)/,
  );
  assert.match(shell, /<svg viewBox=\$\{option\.viewBox\}/);
  assert.match(shell, /=> svg`<path d=\$\{path\}/);
  assert.doesNotMatch(imLogoSource, /icon\(MessageSquare/);
  assert.match(shell, /import \{ qrDataUrl \} from "\.\/qr";/);
  assert.match(shell, /"\/api\/im-bindings"/);
  assert.match(shell, /api<\{ binding: ImBindingRecord \}>\("\/api\/im-bindings\/start"/);
  assert.match(refreshImBinding, /\/api\/im-bindings\/status\?provider=/);
  assert.doesNotMatch(refreshImBinding, /\/api\/im-bindings\/start/);
  assert.equal(shell.match(/"\/api\/im-bindings\/start"/g)?.length, 2);
  assert.match(shell, /qrPayload/);
  assert.match(shell, /setupMode/);
  assert.match(shell, /quickSetupAvailable/);
  assert.match(shell, /if \(!binding\.quickSetupAvailable \|\| !binding\.qrPayload\)/);
  assert.match(shell, /function imProvisionSetup\(binding: ImBindingRecord\): TemplateResult/);
  assert.match(shell, /function imManualSetup\(binding: ImBindingRecord\): TemplateResult/);
  assert.match(shell, /api<\{ reusable\?: boolean \}>\(`\/api\/im-bindings\/\$\{encodeURIComponent\(provider\)\}`/);
  assert.match(shell, /function forgetAndStartImBinding\(provider: ImProviderId\): Promise<void>/);
  assert.match(shell, /\/api\/im-bindings\/\$\{encodeURIComponent\(provider\)\}\?forget=1/);
  assert.match(shell, /t\("Bind a new Bot"\)/);
  assert.match(i18n, /"Bind a new Bot": "换绑新的 Bot"/);
  assert.match(shell, /"\/api\/im-bindings\/wechat\/verify"/);
  assert.match(shell, /\/api\/im-bindings\/\$\{encodeURIComponent\(provider\)\}\/credentials/);
  assert.match(shell, /function imCredentialForm\(binding: ImBindingRecord\)/);
  assert.match(shell, /html`\$\{imProvisionSetup\(binding\)\}\$\{imCredentialForm\(binding\)\}`/);
  assert.match(shell, /reusableImProviders\.has\(option\.id\)/);
  assert.match(shell, /else if \(reusableImProviders\.has\(option\.id\)\) showImBinding\(option\.id\)/);
  assert.doesNotMatch(shell, /DEFAULT_IM_CHANNELS/);
  assert.match(shell, /function showImBinding\(provider: ImProviderId\): void/);
  assert.match(shell, /binding\.setupMode === "provision-qr"[\s\S]*void startImBinding\(provider\)/);
  assert.match(shell, /function imChannelIds\(status: ImBindingRecord\["status"\]\): ImProviderId\[\]/);
  assert.match(shell, /VISIBLE_IM_PROVIDER_OPTIONS\.map\(\(option\) => option\.id\)/);
  assert.match(shell, /filter\(\(id\) => imBindings\[id\]\?\.status === status\)/);
  assert.match(shell, /imChannelIds\("connected"\)/);
  assert.match(shell, /imChannelIds\("pending"\)/);
  assert.match(shell, /t\("Connected chat channels"\)/);
  assert.match(shell, /t\("Setup in progress"\)/);
  assert.match(shell, /t\("Available chat platforms"\)/);
  assert.match(shell, /VISIBLE_IM_PROVIDER_OPTIONS\.map\(\(option\) => \{/);
  assert.match(shell, /delete imBindings\[provider\]/);
  assert.match(shell, /const authWindow = window\.open\(/);
  assert.match(shell, /const startRequest = api<\{ binding: ImBindingRecord \}>\("\/api\/im-bindings\/start"/);
  assert.match(shell, /const started = await startRequest/);
  assert.match(shell, /else \{\s+const authorization = WecomAIBotSDK\.openBotInfoAuthWindow/);
  assert.ok(shell.indexOf("const authWindow = window.open") < shell.indexOf("const started = await startRequest"));
  assert.ok(shell.indexOf("const started = await startRequest") < shell.indexOf("WecomAIBotSDK.openBotInfoAuthWindow"));
  assert.match(shell, /class="im-resource-id"><span>Bot ID<\/span><code>\$\{binding\.resourceId\}<\/code>/);
  assert.match(shell, /class="user-pill"[\s\S]*aria-haspopup="dialog"[\s\S]*@click=\$\{toggleImPanel\}/);
  assert.match(shell, /<div id="im-panel-host"><\/div>/);
  assert.match(shell, /function renderImPanel\(\): void/);
});

test("each IM platform uses its official authorization and message client", () => {
  assert.match(server, /Lark\.registerApp\(/);
  assert.match(server, /createOnly: false/);
  assert.doesNotMatch(server, /createOnly: true/);
  assert.match(server, /new Lark\.WSClient\(/);
  assert.match(server, /startQrConnect\(/);
  assert.match(server, /claimImBridge\(user, provider, IM_QR_LEASE_RESOURCE_ID\)/);
  assert.match(server, /renewImBridge\(user, provider, IM_QR_LEASE_RESOURCE_ID\)/);
  assert.match(server, /state\.bindings\[provider\]\?\.qrGenerationId !== qrGenerationId/);
  assert.match(server, /const ownerReservation = await reserveImResourceOwner\(user, provider, resource\.resourceId\)/);
  assert.match(server, /await commitImResourceReservation\(ownerReservation\)/);
  assert.match(server, /await releaseImResourceReservation\(ownerReservation\)/);
  assert.match(server, /reserveImResourceOwner\(user, provider, resourceId, true\)/);
  assert.match(server, /await discardImResourceReservation\(ownerReservation\)/);
  assert.match(server, /owner\?\.user === user && active/);
  assert.match(server, /targetPrefix=\$\{encodeURIComponent\(targetPrefix\)\}/);
  assert.match(server, /"\/app\/registration\/init"/);
  assert.match(server, /"\/app\/registration\/begin"/);
  assert.match(server, /"\/app\/registration\/poll"/);
  assert.match(server, /new QQBot\(/);
  assert.match(server, /new WeComWSClient\(/);
  assert.match(server, /new DingTalkStreamClient\(/);
  assert.match(server, /path: "\/api\/im-bindings\/:provider\/credentials"/);
  assert.match(server, /path: "\/api\/im-bindings\/:provider\/locate"/);
  assert.match(server, /async function locateImBot\(user: string, provider: ImProviderId\)/);
  assert.match(server, /receive_id_type: "chat_id"/);
  assert.match(server, /if \(binding\.provider === "feishu"\) return Boolean\(resource\.externalChatId\)/);
  assert.match(server, /if \(binding\.provider === "qq"\) return Boolean\(resource\.externalChatId\)/);
  assert.doesNotMatch(server, /receive_id_type: "open_id"/);
  assert.doesNotMatch(server, /sendToUser/);
  assert.match(server, /client\.on\("event\.enter_chat", handleWeComEnter\)/);
  assert.match(server, /async function rememberImConversation/);
  assert.match(server, /await activateImSdkResource\(user, resource\)/);
  assert.match(
    server,
    /const resource = state\.resources\[provider\][\s\S]*if \(reusable\)[\s\S]*provider !== "wechat"[\s\S]*return connectImSdkResource\(user, provider\)/,
  );
  assert.match(server, /encryptedSecret: encryptImSecret/);
  assert.match(server, /process\.env\.CONNECTOR_SECRET_KEY/);
  assert.doesNotMatch(server, /WEB_UI_IM_|\/im\/gateway|\/im\/pair|pairCode/);
  assert.match(server, /const IM_DELIVERY_POLL_MS = WEIXIN_BRIDGE_SYNC_MS/);
  assert.match(server, /setInterval\(\(\) => \{\s+void drainImDeliveries\(\)/);
  assert.doesNotMatch(server, /for \(const delay of \[0, 100, 400, 1_000\]\)/);
  assert.doesNotMatch(server, /imDeliveryDrainInFlight/);
  assert.match(server, /const IM_PROGRESS_LEGACY_KEY = "im-progress"/);
  assert.match(server, /const IM_PROGRESS_KEY_PREFIX = `\$\{IM_PROGRESS_LEGACY_KEY\}-`/);
  assert.match(server, /imProgressStateKey\(provider\)/);
  assert.match(server, /syncImRunProgress\(\)/);
  assert.match(server, /imProgressMessageId\(user, provider, runId, content\)/);
  assert.match(server, /formatImRunProgress\(snapshot\)/);
  assert.match(
    server,
    /startImRunProgress\(\s*user,\s*provider,\s*resource\.resourceId,\s*input\.externalChatId,\s*runId,/,
  );
  assert.match(server, /const queueImProgressStateUpdate = createImKeyedQueue\(\)/);
  assert.match(server, /return queueImProgressStateUpdate\(imRuntimeKey\(user, provider\),/);
  assert.doesNotMatch(server, /progressAllowed: .*===/);
  assert.doesNotMatch(syncWeixinBridge, /drainWeixinDeliveries/);
  assert.doesNotMatch(syncImSdkBridges, /drainImSdkDeliveries/);
});

test("the IM channel picker has its own panel, provider menu, provider setup flow, and Chinese labels", () => {
  assert.match(css, /#im-panel-host \{/);
  assert.match(css, /#im-panel-host \{[\s\S]*?right: 0;/);
  assert.match(css, /\.im-panel \{/);
  assert.match(css, /\.im-panel \{[\s\S]*?width: 100%;/);
  assert.match(css, /\.im-channel-row,/);
  assert.match(css, /\.im-provider-menu \{/);
  assert.match(css, /\.im-qr-backdrop \{/);
  assert.match(css, /\.im-qr-modal \{/);
  assert.match(css, /\.im-setup-flow \{/);
  assert.match(css, /\.im-setup-warning \{/);
  assert.match(css, /\.im-credential-form \{/);
  assert.match(css, /\.im-verify \{/);
  assert.match(css, /\.im-unbind/);
  assert.match(css, /\.im-locate/);
  assert.match(css, /\.im-doc-link \{[\s\S]*?background: #fff;[\s\S]*?color: #202124;/);
  assert.match(css, /\.im-resource-id \{/);
  assert.match(css, /place-items: center/);
  assert.match(css, /\.im-channel-state \{/);
  assert.match(i18n, /"Chat channels": "聊天频道"/);
  assert.match(i18n, /"Connect chat channel": "接入聊天频道"/);
  assert.match(i18n, /"Connected chat channels": "已接入"/);
  assert.match(i18n, /"Setup in progress": "接入中"/);
  assert.match(i18n, /"Available chat platforms": "可接入"/);
  assert.match(i18n, /"Continue setup": "继续接入"/);
  assert.match(i18n, /WeCom: "企业微信"/);
  assert.match(i18n, /"Binding complete": "绑定完成"/);
  assert.match(i18n, /"Find Bot in IM": "在 IM 中找到 Bot"/);
  assert.match(i18n, /"Waiting for platform authorization": "等待平台授权"/);
  assert.match(i18n, /"Scan to create or bind a bot": "扫码创建或绑定机器人"/);
  assert.match(
    i18n,
    /"Quick scan setup is temporarily unavailable.": "快捷扫码当前不可用，请重试或手动绑定已有 Bot。"/,
  );
  assert.match(i18n, /"Waiting for bot authorization": "等待机器人绑定并完成授权"/);
  assert.match(i18n, /"Verify and bind": "验证并绑定"/);
  assert.match(i18n, /"Setup guide": "接入文档"/);
  assert.match(i18n, /Bound: "已绑定"/);
  assert.match(i18n, /Unbind: "解绑"/);
  assert.match(shell, /\/api\/im-bindings\/\$\{encodeURIComponent\(provider\)\}\/locate/);
  assert.match(shell, /t\("Find Bot in IM"\)/);
  assert.doesNotMatch(shell, /OpenClaw|openclaw/);
  assert.doesNotMatch(i18n, /OpenClaw|openclaw/);
});
