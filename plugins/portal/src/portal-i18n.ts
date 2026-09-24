import { createHash } from "node:crypto";

const ZH: Record<string, string> = {
  Portal: "门户",
  "Sign-in failed": "登录失败",
  "We couldn't sign you in": "无法登录",
  "Your sign-in didn't complete. This is usually temporary. Trying again resolves most cases.":
    "登录未完成。这通常是暂时的问题，请重试。",
  Details: "详情",
  "Try signing in again": "重新登录",
  "Use another sign-in method": "使用其他登录方式",
  "Back to start": "返回首页",
  "Still stuck? Check that your account has access, then contact your admin.":
    "仍无法登录？请确认账户权限并联系管理员。",
  "No admin access": "无管理权限",
  "You don't have admin access": "你没有管理权限",
  "The Admin area is limited to governance admins. Your account is signed in and verified. It just isn't granted admin rights.":
    "管理后台仅向治理管理员开放。你的账户已登录并通过验证，但尚未获得管理权限。",
  "Signed in as": "当前登录账户：",
  "Admin rights come from your organization's admin grants. If you need access, ask an existing admin to grant it.":
    "管理权限由组织管理员授予。如需访问，请联系现有管理员。",
  "Back to your surfaces": "返回工作区",
  "Try again": "重试",
  "Open the assistant instead": "打开助手",
  "You can keep using every surface available to your account.": "你仍可以使用账户有权访问的其他页面。",
  "Not set up yet": "尚未完成设置",
  "This deployment isn't set up yet": "此部署尚未完成设置",
  "An admin still needs to finish setup by adding a model API key. Until then the assistant can't answer.":
    "管理员需要添加模型 API 密钥以完成设置。设置完成前，助手无法回答。",
  "Ask your admin to complete onboarding in the Admin area.": "请管理员在管理后台完成初始化。",
  "Admin temporarily unavailable": "管理后台暂时不可用",
  "Admin is temporarily unavailable": "管理后台暂时不可用",
  "We couldn't check your admin access right now. This is usually temporary. Trying again resolves most cases.":
    "目前无法检查你的管理权限。这通常是暂时的问题，请重试。",
  "If this keeps happening, the admin service may be down. Contact your admin.":
    "如果问题持续，请联系管理员检查管理服务。",
  "Can't connect": "无法连接",
  "Manage your connections": "管理连接",
  "This link was for someone else": "此链接属于其他人",
  "We couldn't reach the connection service. Please try the link again in a moment.":
    "无法连接账户服务。请稍后重试此链接。",
  "The connection service returned an unexpected response.": "账户服务返回了意外响应。",
  "This connect link has expired. Ask the agent for a fresh one.": "此连接链接已过期。请向助手索取新链接。",
  "This connect link is invalid or was already used. Ask the agent for a fresh one.":
    "此连接链接无效或已被使用。请向助手索取新链接。",
  "We couldn't start the connection. This app may not be configured.": "无法开始连接。此应用可能尚未配置。",
  "We couldn't reach the connection service. Please try again in a moment.": "无法连接账户服务。请稍后重试。",
  "Service unavailable": "服务暂时不可用",
  "Try the link again in a moment.": "请稍后重试此链接。",
  "Playground is busy": "体验环境繁忙",
  "The playground is busy": "体验环境繁忙",
  "We couldn't start a fresh playground session for you right now. Waiting a little while and reloading resolves most cases.":
    "目前无法为你创建新的体验会话。请稍后刷新页面。",
  "Playground sessions are limited per visitor to keep the demo responsive for everyone.":
    "为保证体验环境的响应速度，每位访客的会话数量有限。",
  "Not available in the playground": "体验环境中不可用",
  "Connecting accounts and dropping secrets are disabled for anonymous playground sessions — clearing your cookie would orphan real credentials.":
    "匿名体验会话不能连接账户或删除密钥，因为清除 Cookie 后可能无法恢复真实凭据。",
  "Back to the playground": "返回体验环境",
  "Sign in with a real account at /auth/login to use this link.": "请通过 /auth/login 登录正式账户后使用此链接。",
  "Admin sign-in": "管理员登录",
  "Sign in as an administrator": "以管理员身份登录",
  "Only continue if you generated this link for your own admin account.":
    "仅当你为自己的管理员账户生成此链接时才继续。",
  "JavaScript is required to open this login link.": "打开此登录链接需要启用 JavaScript。",
  "Sign in": "登录",
  "This link expires after five minutes and can be used once. Generate another with qm admin-login.":
    "此链接五分钟后过期且只能使用一次。可通过 qm admin-login 重新生成。",
  "This link is missing or invalid. Generate a new link with qm admin-login.":
    "此链接缺失或无效。请通过 qm admin-login 重新生成。",
  "This admin link is invalid, expired, or already used. Generate a new link with qm admin-login.":
    "此管理员链接无效、已过期或已使用。请通过 qm admin-login 重新生成。",
  "This account cannot sign in.": "此账户无法登录。",
  "Admin access could not be checked. Please try again.": "无法检查管理权限。请重试。",
  "This account does not have admin access.": "此账户没有管理权限。",
  "Sign-in is temporarily unavailable. Please try again.": "登录暂时不可用。请重试。",
  "Trusted sign-in failed. Please start again from your provider.": "受信任登录失败。请从身份提供方重新开始。",
  "too many sign-in attempts — wait a minute and try again": "登录尝试过多——请等待一分钟后重试",
  "sign-in is busy — wait a minute and try again": "登录服务繁忙——请等待一分钟后重试",
  "sign-in state collision — please try again": "登录状态冲突——请重试",
  "sign-in service temporarily unavailable": "登录服务暂时不可用",
  "invalid login state": "无效的登录状态",
  "sign-in confirmation is missing or expired — please try again": "登录确认缺失或已过期——请重试",
  "account suspended": "账户已暂停",
  "account deactivated": "账户已停用",
  "account not invited": "账户尚未受邀",
  "enterprise identity source is disabled": "企业身份源未启用",
  "enterprise account is inactive": "企业账户未激活",
  "enterprise account is not linked yet; contact an administrator": "企业账户尚未关联，请联系管理员",
  "enterprise account has conflicting matches; contact an administrator": "企业账户存在匹配冲突，请联系管理员",
  "sign-in is not permitted for this account": "此账户不允许登录",
  "login session expired — please try again": "登录会话已过期——请重试",
  "login already used — please try again": "登录已使用——请重试",
  "invalid login transaction": "无效的登录事务",
  "workspace not permitted": "工作区不允许访问",
  "userinfo missing sub": "用户信息缺少主体标识",
  "subject mismatch": "主体标识不匹配",
  "sign-in failed": "登录失败",
  "this browser is already signed in to a different account — sign out before using this link":
    "此浏览器已登录其他账户——请退出登录后使用此链接",
};

export const PORTAL_I18N_SCRIPT = `(function () {
  var translations = ${JSON.stringify(ZH)};
  var key = "qm:locale";
  var saved;
  try { saved = localStorage.getItem(key); } catch (_) {}
  var languages = [saved].concat(navigator.languages || [], navigator.language);
  var locale = "en";
  for (var i = 0; i < languages.length; i++) {
    var value = String(languages[i] || "").toLowerCase();
    if (value === "zh" || value.indexOf("zh-") === 0) { locale = "zh-CN"; break; }
    if (value === "en" || value.indexOf("en-") === 0) { locale = "en"; break; }
  }
  document.documentElement.lang = locale;
  function translate(source) {
    var value = source.trim();
    var translated = translations[value];
    var match;
    if (!translated && (match = /^You've already connected (.+)$/.exec(value))) translated = "你已经连接了 " + match[1];
    if (!translated && (match = /^This link was meant for a different teammate, and your (.+) is already connected, so there's nothing to do here\\.$/.exec(value))) translated = "此链接属于其他成员，而你的 " + match[1] + " 已连接，无需其他操作。";
    if (!translated && (match = /^This connect link was created for a different teammate\\. Want to connect your own (.+) instead\\?$/.exec(value))) translated = "此连接链接属于其他成员。要改为连接你自己的 " + match[1] + " 吗？";
    if (!translated && (match = /^Connect my (.+)$/.exec(value))) translated = "连接我的 " + match[1];
    if (!translated && (match = /^identity provider returned: (.+)$/.exec(value))) translated = "身份提供方返回：" + match[1];
    return translated ? source.replace(value, translated) : source;
  }
  if (locale === "zh-CN") {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (node) {
      if (node.parentElement && !node.parentElement.closest("script,style,[data-i18n-skip]")) node.nodeValue = translate(node.nodeValue || "");
    });
    document.title = translate(document.title.replace(/ · Portal$/, "")) + " · " + translations.Portal;
  }
  var button = document.createElement("button");
  button.type = "button";
  button.className = "locale-toggle";
  button.textContent = locale === "en" ? "中文" : "EN";
  button.title = locale === "en" ? "切换到中文" : "Switch to English";
  button.setAttribute("aria-label", button.title);
  button.onclick = function () {
    try { localStorage.setItem(key, locale === "en" ? "zh-CN" : "en"); } catch (_) {}
    location.reload();
  };
  document.body.appendChild(button);
})();`;

export const PORTAL_I18N_SCRIPT_HASH = `sha256-${createHash("sha256").update(PORTAL_I18N_SCRIPT).digest("base64")}`;
